/**
 * Bid-Ask flip (tools/bidask-flip.js): bin selection, fill math, SDK deposit
 * parameter construction, trigger / re-arm state machine, guards, chunking,
 * tx-build refusals, FOSD property, and the management hook in off / shadow /
 * live modes. No RPC: every chain read is faked. The SDK is the real installed
 * @meteora-ag/dlmm (only its pure helpers are called).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-bidask-flip-"));
process.chdir(tmp);
process.env.DRY_RUN = "true";

const BN = (await import("bn.js")).default;
const web3 = await import("@solana/web3.js");
const { PublicKey, Keypair, TransactionInstruction } = web3;
const sdk = await import("@meteora-ag/dlmm");
const flip = await import(new URL("../tools/bidask-flip.js", import.meta.url));
const {
  planBidAskFlip, planFlipChunks, computeFill, normalizeBins, normalizeFlipConfig, buildFlipParams,
  exitRuleFiresForFlip, flipEligibilityBlocker, estimateFlipCostLamports, buildAtomicFlipIxs, runBidAskFlips, flipCloseTags, token2022Blocker, MAX_BIN_OPS_PER_TX, MIN_ASK_BINS,
} = flip;

const WSOL = "So11111111111111111111111111111111111111112";
const DEC_X = 6;
const DEC_Y = 9;
const BIN_STEP = 100;
const priceUi = (binId, bs = BIN_STEP) => (1 + bs / 1e4) ** binId * 10 ** (DEC_X - DEC_Y);

/**
 * Synthetic single-sided SOL Bid-Ask position deployed with active = U and
 * bins [L, U], SOL weight linear (heaviest at the bottom), then price dumped to
 * `active`: every bin above active is fully converted to token at its price.
 */
function band({ L = -500, U = -400, active = -450, solPerUnit = 1_000_000n, bs = BIN_STEP } = {}) {
  const bins = [];
  for (let k = L; k <= U; k++) {
    const y = solPerUnit * BigInt(U - k + 1); // lamports
    if (k > active) {
      const xUi = Number(y) / 1e9 / priceUi(k, bs);
      bins.push({ binId: k, xRaw: BigInt(Math.floor(xUi * 10 ** DEC_X)), yRaw: 0n, price: priceUi(k, bs) });
    } else {
      bins.push({ binId: k, xRaw: 0n, yRaw: y, price: priceUi(k, bs) });
    }
  }
  const depositedSol = bins.reduce((s, b, i) => s + Number(solPerUnit * BigInt(U - (L + i) + 1)) / 1e9, 0);
  return { bins, L, U, active, depositedSol };
}

const baseInput = (b, extra = {}) => ({
  bins: b.bins, activeId: b.active, lowerBinId: b.L, upperBinId: b.U, bandTop: b.U, strategy: "bid_ask", binsAbove: 0,
  quoteIsSol: true, decimalsX: DEC_X, decimalsY: DEC_Y, depositedSol: b.depositedSol, flipState: {},
  cfg: { mode: "shadow", fillPct: 30, reflipStepPct: 20, minTrancheSol: 0.05 }, exitReason: null, tokenBlocker: null, now: Date.now(),
  ...extra,
});

// Value-weighted fill of a linear bid-ask after price fell into it (closed form check).
function expectedFill(b) {
  let conv = 0;
  let tot = 0;
  for (let k = b.L; k <= b.U; k++) {
    const w = b.U - k + 1;
    tot += w;
    if (k > b.active) conv += w;
  }
  return (conv / tot) * 100;
}

test("config: defaults, invalid mode falls back to shadow, numbers coerced", () => {
  assert.deepEqual(normalizeFlipConfig({}), { mode: "shadow", fillPct: 30, reflipStepPct: 20, minTrancheSol: 0.05, timeoutSec: 30 });
  assert.equal(normalizeFlipConfig({ mode: "yolo" }).mode, "shadow");
  assert.equal(normalizeFlipConfig({ mode: "off" }).mode, "off");
  assert.equal(normalizeFlipConfig({ mode: "live", fillPct: "45" }).fillPct, 45);
});

test("fill math: converted SOL / deposited SOL from the position's own bins", () => {
  const b = band({ active: -450 });
  const f = computeFill({ bins: b.bins, activeId: b.active, decimalsX: DEC_X, depositedSol: b.depositedSol });
  assert.equal(f.depositedSource, "tracked");
  assert.ok(Math.abs(f.fillPct - expectedFill(b)) < 0.01, `${f.fillPct} vs ${expectedFill(b)}`);
  // Without a tracked deposit, the estimate is Σ y + Σ x·P ≈ the real deposit.
  const e = computeFill({ bins: b.bins, activeId: b.active, decimalsX: DEC_X });
  assert.equal(e.depositedSource, "estimated");
  assert.ok(Math.abs(e.depositedSol - b.depositedSol) / b.depositedSol < 1e-4);
  // Nothing converted when price is at the top.
  const top = band({ active: -400 });
  assert.equal(computeFill({ bins: top.bins, activeId: top.active, decimalsX: DEC_X }).fillPct, 0);
});

test("normalizeBins reads SDK positionBinData strings", () => {
  const n = normalizeBins([{ binId: -5, positionXAmount: "123.0", positionYAmount: "7", pricePerToken: "0.5" }]);
  assert.deepEqual(n, [{ binId: -5, xRaw: 123n, yRaw: 7n, price: 0.5 }]);
});

test("bin selection: withdraw (active, U], ask [active+1, U], active bin and SOL bins excluded", () => {
  const b = band({ active: -460 }); // ~36% fill
  const plan = planBidAskFlip(baseInput(b));
  assert.equal(plan.action, "flip", plan.reason);
  assert.equal(plan.layout, "global");
  assert.deepEqual(plan.withdraw, { minBinId: -459, maxBinId: -400 });
  assert.deepEqual(plan.deposit, { minDeltaId: 1, maxDeltaId: 60, minBinId: -459, maxBinId: -400 });
  const expectX = b.bins.filter((x) => x.binId > -460).reduce((s, x) => s + x.xRaw, 0n);
  assert.equal(plan.trancheX, expectX);
  assert.ok(plan.depositX < plan.trancheX && plan.depositX > (plan.trancheX * 999n) / 1000n);
});

test("trigger: holds below fillPct, flips at/above it", () => {
  const shallow = band({ active: -420 }); // ~16%
  assert.equal(planBidAskFlip(baseInput(shallow)).action, "hold");
  assert.match(planBidAskFlip(baseInput(shallow)).reason, /fill .* < 30%/);
  const deep = band({ active: -460 });
  assert.equal(planBidAskFlip(baseInput(deep)).action, "flip");
});

test("deposit params (real SDK): X-only, deltas ≥ 1, max = U-active, top-weighted, Σ ≤ withdrawn X", () => {
  const b = band({ active: -460 });
  const plan = planBidAskFlip(baseInput(b));
  const { deposits, withdraws } = buildFlipParams(plan.chunks[0], { binStep: BIN_STEP, sdk, activeId: plan.activeId });
  const d = deposits[0];
  assert.equal(d.minDeltaId.toNumber(), 1);
  assert.equal(d.maxDeltaId.toNumber(), b.U - b.active);
  assert.ok(d.y0.isZero() && d.deltaY.isZero(), "no SOL deposited");
  assert.ok(d.x0.isZero(), "x0 = (1-minDelta)·Δx = 0");
  assert.ok(d.deltaX.gtn(0));
  assert.equal(d.favorXInActiveBin, false);
  assert.equal(withdraws[0].minBinId.toNumber(), -459);
  assert.equal(withdraws[0].maxBinId.toNumber(), -400);
  assert.equal(withdraws[0].bps.toNumber(), 10_000);
  const amounts = sdk.toAmountIntoBins(new BN(plan.activeId), d.minDeltaId, d.maxDeltaId, d.deltaX, d.deltaY, d.x0, d.y0, new BN(BIN_STEP), false);
  const ids = amounts.map((a) => a.binId.toNumber());
  assert.equal(Math.min(...ids), b.active + 1);
  assert.equal(Math.max(...ids), b.U);
  const total = amounts.reduce((s, a) => s.add(a.amountX), new BN(0));
  assert.ok(total.lte(new BN(plan.depositX.toString())), "deposit never exceeds the withdrawn tranche");
  assert.ok(total.gt(new BN(plan.depositX.toString()).muln(99).divn(100)), "uses ~all of it");
  assert.ok(amounts.every((a) => a.amountY.isZero()));
  // Value per bin (x·P) increases with bin id: heaviest at the band top.
  const val = amounts.map((a) => Number(a.amountX.toString()) * priceUi(a.binId.toNumber()));
  for (let i = 1; i < val.length; i++) assert.ok(val[i] > val[i - 1], `value not increasing at ${ids[i]}`);
});

test("buildFlipParams refuses a deposit that touches the active bin", () => {
  assert.throws(() => buildFlipParams({ deposit: { minDeltaId: 0, maxDeltaId: 5 }, withdraw: { minBinId: 1, maxBinId: 5 }, depositX: 10n }, { binStep: 100, sdk, activeId: 0 }), /strictly above/);
});

test("FOSD: the ask beats or ties holding at every end price; an ask topped below U does not", () => {
  const b = band({ active: -460 });
  const plan = planBidAskFlip(baseInput(b));
  const toks = (amounts) => amounts.map((a) => ({ k: a.binId.toNumber(), t: Number(a.amountX.toString()) / 10 ** DEC_X }));
  const hold = b.bins.filter((x) => x.binId > b.active).map((x) => ({ k: x.binId, t: Number(x.xRaw) / 10 ** DEC_X }));
  const value = (dist, kEnd) => dist.reduce((s, { k, t }) => s + t * Math.min(priceUi(k), priceUi(kEnd)), 0);
  const p = buildFlipParams(plan.chunks[0], { binStep: BIN_STEP, sdk, activeId: plan.activeId }).deposits[0];
  const ask = toks(sdk.toAmountIntoBins(new BN(plan.activeId), p.minDeltaId, p.maxDeltaId, p.deltaX, p.deltaY, p.x0, p.y0, new BN(BIN_STEP), false));
  const slack = 1 - 1e-4; // haircut + rounding
  for (let kEnd = b.active - 20; kEnd <= b.U + 10; kEnd++) {
    assert.ok(value(ask, kEnd) >= value(hold, kEnd) * slack, `ask < hold at end bin ${kEnd}`);
  }
  assert.ok(value(ask, b.U) > value(hold, b.U) * 1.05, "full rebound sells materially higher");
  // Negative control: same token as an ask over only [active+1, active+10] (top far below U).
  const lowTop = sdk.buildLiquidityStrategyParameters(new BN(plan.depositX.toString()), new BN(0), new BN(1), new BN(10), new BN(BIN_STEP), false, new BN(b.active), sdk.getLiquidityStrategyParameterBuilder(sdk.StrategyType.BidAsk));
  const askLow = toks(sdk.toAmountIntoBins(new BN(b.active), new BN(1), new BN(10), lowTop.deltaX, new BN(0), lowTop.x0, new BN(0), new BN(BIN_STEP), false));
  let violated = false;
  for (let kEnd = b.active; kEnd <= b.U + 5; kEnd++) if (value(askLow, kEnd) < value(hold, kEnd) * 0.999) violated = true;
  assert.ok(violated, "an ask capped well below U must lose to hold somewhere");
});

test("re-flip state machine: only the fresh tranche below the previous flip point", () => {
  const first = band({ active: -460 });
  const p1 = planBidAskFlip(baseInput(first));
  assert.equal(p1.action, "flip");
  const st = { flips: 1, last_flip_active_bin: -460, last_flip_at: new Date(Date.now() - 3_600_000).toISOString() };
  // Price fell further to -480: fresh tranche = (-480, -460].
  const deeper = band({ active: -480 });
  const p2 = planBidAskFlip(baseInput(deeper, { flipState: st }));
  assert.equal(p2.action, "flip", p2.reason);
  assert.deepEqual(p2.withdraw, { minBinId: -479, maxBinId: -460 });
  assert.equal(p2.deposit.maxBinId, -400, "re-flip ask still reaches U");
  assert.match(p2.reason, /re-flip/);
  // Only a little further (-465): fresh tranche below the 20% step → hold.
  const little = band({ active: -465 });
  const p3 = planBidAskFlip(baseInput(little, { flipState: st }));
  assert.equal(p3.action, "hold");
  assert.match(p3.reason, /re-flip step/);
  // Price bounced back above the previous flip point: nothing fresh to move.
  const bounced = band({ active: -450 });
  assert.match(planBidAskFlip(baseInput(bounced, { flipState: st })).reason, /no fresh tranche/);
  // Cooldown right after a flip.
  const hot = { ...st, last_flip_at: new Date().toISOString() };
  assert.match(planBidAskFlip(baseInput(deeper, { flipState: hot })).reason, /cooldown/);
});

test("guards: exit rule, min tranche, token-2022, layout, band edges", () => {
  const b = band({ active: -460 });
  const r = (extra) => planBidAskFlip(baseInput(b, extra));
  assert.match(r({ exitReason: "stop loss" }).reason, /close path wins/);
  assert.match(r({ cfg: { mode: "shadow", fillPct: 30, minTrancheSol: 1e6 } }).reason, /< min/);
  assert.match(r({ tokenBlocker: "token-2022 transfer fee (100 bps)" }).reason, /token blocked/);
  assert.match(r({ strategy: "spot" }).reason, /not a bid_ask/);
  assert.match(r({ binsAbove: 5 }).reason, /not single-sided/);
  assert.match(r({ quoteIsSol: false }).reason, /quote token/);
  assert.match(r({ cfg: { mode: "off" } }).reason, /mode off/);
  const atTop = band({ active: -400 });
  assert.match(planBidAskFlip(baseInput(atTop)).reason, /nothing to flip/);
  const above = band({ active: -400 });
  assert.match(planBidAskFlip(baseInput(above, { activeId: -390 })).reason, /nothing to flip/);
  const below = band({ active: -510 });
  assert.match(planBidAskFlip(baseInput(below)).reason, /below band bottom/);
  // SOL above active ⇒ not a single-sided bid layout.
  const odd = band({ active: -460 });
  odd.bins.find((x) => x.binId === -420).yRaw = 5n;
  assert.match(planBidAskFlip(baseInput(odd)).reason, /SOL found above active/);
  // Ask would be < MIN_ASK_BINS wide.
  const narrow = band({ L: -420, U: -400, active: -398 + -4, solPerUnit: 100_000_000n });
  const pn = planBidAskFlip(baseInput(narrow, { cfg: { mode: "shadow", fillPct: 0, minTrancheSol: 0 } }));
  assert.equal(narrow.U - narrow.active < MIN_ASK_BINS, pn.action === "hold");
});

test("exit rules win over the flip", () => {
  const m = { takeProfitFeePct: 5, stopLossPct: -20, emergencyPriceDropPct: -50, outOfRangeWaitMinutes: 30 };
  assert.equal(exitRuleFiresForFlip({ pnl_pct: 1 }, {}, m), null);
  assert.match(exitRuleFiresForFlip({ pnl_pct: 6 }, {}, m), /take profit/);
  assert.match(exitRuleFiresForFlip({ pnl_pct: -21 }, {}, m), /stop loss/);
  assert.match(exitRuleFiresForFlip({ pnl_pct: -1, minutes_out_of_range: 31 }, {}, m), /OOR/);
  assert.match(exitRuleFiresForFlip({ pnl_pct: 0 }, { instruction: "close at 2x" }, m), /instruction/);
  assert.match(exitRuleFiresForFlip({ pnl_pct: 0 }, {}, m, { exitAlert: true }), /exit alert/);
});

test("chunking: wide flips split into contiguous, budget-sized, top-first local asks", () => {
  const b = band({ L: -700, U: -400, active: -620, solPerUnit: 10_000n });
  const chunks = planFlipChunks({ bins: b.bins, activeId: b.active, lo: b.active + 1, hi: b.U, U: b.U });
  assert.ok(chunks.length >= 2);
  const covered = [];
  for (const c of chunks) {
    const n = c.withdraw.maxBinId - c.withdraw.minBinId + 1;
    assert.ok(n * 2 <= MAX_BIN_OPS_PER_TX, "each tx within the CU budget");
    assert.deepEqual([c.deposit.minBinId, c.deposit.maxBinId], [c.withdraw.minBinId, c.withdraw.maxBinId], "local ask over its own bins");
    assert.ok(c.deposit.minDeltaId >= 1);
    assert.ok(c.depositX < c.trancheX);
    covered.push([c.withdraw.minBinId, c.withdraw.maxBinId]);
  }
  assert.equal(chunks[0].withdraw.maxBinId, b.U, "top chunk first");
  covered.sort((x, y) => x[0] - y[0]);
  assert.equal(covered[0][0], b.active + 1);
  assert.equal(covered.at(-1)[1], b.U);
  for (let i = 1; i < covered.length; i++) assert.equal(covered[i][0], covered[i - 1][1] + 1, "contiguous");
  // Narrow flips stay one global tx.
  const small = band({ active: -460 });
  assert.equal(planFlipChunks({ bins: small.bins, activeId: -440, lo: -439, hi: -400, U: -400 }).length, 1);
  // Chunked local asks are still top-weighted inside each chunk and Σ ≤ chunk X.
  for (const c of chunks) {
    const d = buildFlipParams(c, { binStep: BIN_STEP, sdk, activeId: b.active }).deposits[0];
    const am = sdk.toAmountIntoBins(new BN(b.active), d.minDeltaId, d.maxDeltaId, d.deltaX, d.deltaY, d.x0, d.y0, new BN(BIN_STEP), false);
    assert.ok(am.reduce((s, a) => s.add(a.amountX), new BN(0)).lte(new BN(c.depositX.toString())));
    assert.equal(am[0].binId.toNumber(), c.deposit.minBinId);
    const v = am.map((a) => Number(a.amountX.toString()) * priceUi(a.binId.toNumber()));
    assert.ok(v.at(-1) > v[0]);
  }
});

// ── tx build refusals with a fake pool ──
const OWNER = Keypair.generate().publicKey;
const PROG = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const CB = new PublicKey("ComputeBudget111111111111111111111111111111");
const fakeIx = () => new TransactionInstruction({ programId: PROG, keys: [{ pubkey: OWNER, isSigner: true, isWritable: true }], data: Buffer.from([1]) });
const cuIx = () => new TransactionInstruction({ programId: CB, keys: [], data: Buffer.from([2, 0, 0, 0, 0]) });

function fakePool({ active = -460, rent = 0, binArrayCount = 0, initIxs = 0, netDepositX = 0, simActive = active, b = band({ active }), simErr = null, extraPre = [], extraPost = [], extraDlmm = 0, getBand = null } = {}) {
  const calls = { rebalance: 0, simulate: 0, getPosition: 0 };
  return {
    calls,
    lbPair: { activeId: active, binStep: BIN_STEP },
    tokenX: { publicKey: Keypair.generate().publicKey, owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), mint: { decimals: DEC_X } },
    tokenY: { publicKey: new PublicKey(WSOL), mint: { decimals: DEC_Y } },
    async refetchStates() {},
    async getPosition() {
      calls.getPosition++;
      const b2 = getBand ? getBand(calls) : b;
      return { positionData: { owner: OWNER, lowerBinId: b2.L, upperBinId: b2.U, positionBinData: b2.bins.map((x) => ({ binId: x.binId, positionXAmount: x.xRaw.toString(), positionYAmount: x.yRaw.toString(), pricePerToken: String(x.price) })) } };
    },
    async simulateRebalancePosition() {
      return {
        rebalancePosition: { lbPair: { activeId: simActive } },
        binArrayCount,
        simulationResult: { rentalCostLamports: new BN(rent), actualAmountXDeposited: new BN(netDepositX), actualAmountYDeposited: new BN(0), actualAmountXWithdrawn: new BN(5), amountXDeposited: new BN(1) },
      };
    },
    async rebalancePosition() {
      calls.rebalance++;
      return { initBinArrayInstructions: Array.from({ length: initIxs }, fakeIx), rebalancePositionInstruction: [cuIx(), ...extraPre, fakeIx(), ...Array.from({ length: extraDlmm }, fakeIx), ...extraPost] };
    },
    program: { provider: { connection: {
      async getLatestBlockhash() { return { blockhash: Keypair.generate().publicKey.toBase58() }; },
      async simulateTransaction() { calls.simulate++; return { value: { err: simErr, unitsConsumed: 500_000 } }; },
    } } },
  };
}

test("tx build: refuses rent (either sign), bin-array init, moved active, net wallet deposit; strips CU ixs", async () => {
  const b = band({ active: -460 });
  const plan = planBidAskFlip(baseInput(b));
  const go = (o) => buildAtomicFlipIxs({ pool: fakePool(o), positionPk: OWNER, positionData: {}, plan, rentPayer: OWNER, sdk });
  await assert.rejects(go({ rent: 1000 }), /resize/);
  await assert.rejects(go({ rent: -2844800 }), /resize/);
  await assert.rejects(go({ binArrayCount: 1 }), /bin array/);
  await assert.rejects(go({ initIxs: 1 }), /bin-array init/);
  await assert.rejects(go({ simActive: -459 }), /active bin moved/);
  await assert.rejects(go({ netDepositX: 3 }), /pull tokens/);
  const ok = await go({});
  assert.equal(ok.ixs.length, 1);
  assert.ok(ok.ixs.every((ix) => !ix.programId.equals(CB)));
});

test("token-2022 guard: legacy SPL mints pass, unparsable 2022 mints are blocked (fail closed)", async () => {
  const spl = await import("@solana/spl-token");
  assert.equal(await token2022Blocker({ owner: spl.TOKEN_PROGRAM_ID, mint: {} }), null);
  assert.match(await token2022Blocker({ owner: spl.TOKEN_2022_PROGRAM_ID, mint: null }), /not parsed/);
  // A 2022 mint with a TransferFeeConfig extension (100 bps) is blocked.
  const fee = Buffer.alloc(spl.TRANSFER_FEE_CONFIG_SIZE);
  spl.TransferFeeConfigLayout.encode({
    transferFeeConfigAuthority: PublicKey.default, withdrawWithheldAuthority: PublicKey.default, withheldAmount: 0n,
    olderTransferFee: { epoch: 0n, maximumFee: 1n, transferFeeBasisPoints: 100 },
    newerTransferFee: { epoch: 0n, maximumFee: 1n, transferFeeBasisPoints: 100 },
  }, fee);
  const tlv = Buffer.concat([Buffer.from([spl.ExtensionType.TransferFeeConfig, 0]), Buffer.from([fee.length & 0xff, fee.length >> 8]), fee]);
  assert.match(await token2022Blocker({ owner: spl.TOKEN_2022_PROGRAM_ID, mint: { tlvData: tlv } }), /transfer fee \(100 bps\)/);
  // A 2022 mint with no extensions passes.
  assert.equal(await token2022Blocker({ owner: spl.TOKEN_2022_PROGRAM_ID, mint: { tlvData: Buffer.alloc(0) } }), null);
});

function hookDeps({ mode, tracked, pool, exitAlerts = new Set(), management = {} }) {
  const updates = [];
  const logs = [];
  const sends = [];
  return {
    updates, logs, sends,
    deps: {
      config: { bidAskFlip: { mode, fillPct: 30, reflipStepPct: 20, minTrancheSol: 0.05 }, management },
      log: (_t, m) => logs.push(m),
      getTrackedPosition: () => tracked,
      updateTrackedPosition: (pos, patch) => updates.push({ pos, patch }),
      getPool: async () => pool,
      isBusy: () => false,
      isCloseInflight: () => false,
      sdk,
      exitAlerts,
      getWallet: () => ({ publicKey: OWNER }),
      sendTx: async (tx) => { sends.push(tx); return `sig${sends.length}`; },
      dryRun: false,
    },
  };
}

const POS = Keypair.generate().publicKey.toBase58();
const trackedBidAsk = (extra = {}) => ({ position: POS, strategy: "bid_ask", strategy_type: "BidAsk", bin_range: { min: -500, max: -400, bins_above: 0 }, amount_sol: band({ active: -460 }).depositedSol, ...extra });
const posRow = (extra = {}) => ({ position: POS, pool: Keypair.generate().publicKey.toBase58(), pair: "TEST-SOL", pnl_pct: -3, ...extra });

test("hook: mode off does nothing", async () => {
  const pool = fakePool();
  const h = hookDeps({ mode: "off", tracked: trackedBidAsk(), pool });
  assert.deepEqual(await runBidAskFlips([posRow()], h.deps), []);
  assert.equal(pool.calls.rebalance, 0);
});

test("hook: shadow simulates + logs, records shadow state, never sends", async () => {
  const pool = fakePool();
  const h = hookDeps({ mode: "shadow", tracked: trackedBidAsk(), pool });
  const [r] = await runBidAskFlips([posRow()], h.deps);
  assert.equal(r.action, "flip");
  assert.equal(r.mode, "shadow");
  assert.equal(pool.calls.simulate, 1);
  assert.equal(h.sends.length, 0);
  assert.ok(h.logs.some((l) => /\[shadow\].*FLIP #1/.test(l)));
  assert.equal(h.updates[0].patch.bid_ask_flip_shadow.flips, 1);
  assert.equal(h.updates[0].patch.bid_ask_flip_shadow.last_flip_active_bin, -460);
  assert.ok(!("bid_ask_flip" in h.updates[0].patch), "shadow never touches live flip state");
});

test("hook: exit rule on the same tick ⇒ no flip and no RPC", async () => {
  const pool = fakePool();
  let poolReads = 0;
  const h = hookDeps({ mode: "live", tracked: trackedBidAsk(), pool, management: { stopLossPct: -20 } });
  h.deps.getPool = async () => { poolReads++; return pool; };
  const [r] = await runBidAskFlips([posRow({ pnl_pct: -25 })], h.deps);
  assert.equal(r.action, "hold");
  assert.match(r.reason, /stop loss/);
  assert.equal(poolReads, 0);
  assert.equal(h.sends.length, 0);
  // Exit alert from the trailing-TP pre-check also blocks.
  const h2 = hookDeps({ mode: "live", tracked: trackedBidAsk(), pool, exitAlerts: new Set([POS]) });
  const [r2] = await runBidAskFlips([posRow()], h2.deps);
  assert.match(r2.reason, /exit alert/);
});

test("hook: live sends the atomic flip, records flip state + note; sim failure ⇒ not sent", async () => {
  const pool = fakePool();
  const h = hookDeps({ mode: "live", tracked: trackedBidAsk(), pool });
  const [r] = await runBidAskFlips([posRow()], h.deps);
  assert.equal(r.sent, true);
  assert.deepEqual(r.sigs, ["sig1"]);
  assert.equal(h.sends.length, 1);
  const f = h.updates.at(-1).patch.bid_ask_flip;
  assert.equal(f.flips, 1);
  assert.equal(f.last_flip_active_bin, -460);
  assert.deepEqual(f.txs, ["sig1"]);
  assert.ok(f.first_flip_fill_pct > 30);

  const bad = fakePool({ simErr: { InstructionError: [1, { Custom: 6027 }] } });
  const h2 = hookDeps({ mode: "live", tracked: trackedBidAsk(), pool: bad });
  const [r2] = await runBidAskFlips([posRow()], h2.deps);
  assert.equal(r2.sent, false);
  assert.equal(h2.sends.length, 0);
  assert.equal(h2.updates.length, 0);
});

test("hook: skips non-bid_ask / bins_above > 0 / closed / busy positions silently", async () => {
  const pool = fakePool();
  for (const tracked of [trackedBidAsk({ strategy: "spot" }), trackedBidAsk({ bin_range: { min: -500, max: -390, bins_above: 10 } }), trackedBidAsk({ closed: true }), null]) {
    const h = hookDeps({ mode: "live", tracked, pool });
    assert.deepEqual(await runBidAskFlips([posRow()], h.deps), []);
  }
  const h = hookDeps({ mode: "live", tracked: trackedBidAsk(), pool });
  h.deps.isCloseInflight = () => true;
  assert.deepEqual(await runBidAskFlips([posRow()], h.deps), []);
  assert.equal(pool.calls.rebalance, 0);
});

test("hook: DRY_RUN degrades live to shadow (never signs)", async () => {
  const pool = fakePool();
  const h = hookDeps({ mode: "live", tracked: trackedBidAsk(), pool });
  h.deps.dryRun = true;
  const [r] = await runBidAskFlips([posRow()], h.deps);
  assert.equal(r.mode, "shadow");
  assert.equal(h.sends.length, 0);
});

test("close-record tags for flipped positions", () => {
  assert.deepEqual(flipCloseTags({}), {});
  assert.deepEqual(flipCloseTags({ bid_ask_flip: { flips: 2, first_flip_fill_pct: 31.2, last_flip_fill_pct: 55 } }), { flipped: true, flip_count: 2, flip_fill_pct: 31.2 });
  assert.deepEqual(flipCloseTags({ bid_ask_flip_shadow: { flips: 3 } }), {}, "shadow flips never tag a close as flipped");
});

// ───────────────────────── Fable 5.1 audit fixes ─────────────────────────

test("H1: strict eligibility — adopted / non-BidAsk / unknown bins_above / token-X deploys are never flip candidates", () => {
  assert.equal(flipEligibilityBlocker(trackedBidAsk()), null);
  assert.match(flipEligibilityBlocker(trackedBidAsk({ adopted: true })), /adopted/);
  assert.match(flipEligibilityBlocker(trackedBidAsk({ strategy_type: null })), /strategy_type/);
  assert.match(flipEligibilityBlocker(trackedBidAsk({ strategy_type: "SpotOneSide" })), /strategy_type/);
  assert.match(flipEligibilityBlocker(trackedBidAsk({ bin_range: { min: -500, max: -400, bins_above: null } })), /bins_above/);
  assert.match(flipEligibilityBlocker(trackedBidAsk({ bin_range: { min: -500, max: -400 } })), /bins_above/);
  assert.match(flipEligibilityBlocker(trackedBidAsk({ bin_range: { min: -500, bins_above: 0 } })), /band top/);
  assert.match(flipEligibilityBlocker(trackedBidAsk({ amount_x: 5 })), /token X/);
  assert.match(flipEligibilityBlocker(null), /not tracked/);
  // planner is strict too
  const b = band({ active: -460 });
  for (const binsAbove of [null, undefined, 3]) assert.equal(planBidAskFlip(baseInput(b, { binsAbove })).action, "hold");
  assert.equal(planBidAskFlip(baseInput(b, { binsAbove: 0 })).action, "flip");
});

test("H1: hook never touches RPC or sends for an auto-adopted bid_ask position (null bins_above)", async () => {
  const pool = fakePool();
  let poolReads = 0;
  for (const tracked of [
    trackedBidAsk({ adopted: true, strategy_type: null, bin_range: { min: -500, max: -400, bins_above: null } }),
    trackedBidAsk({ adopted: true }),
    trackedBidAsk({ bin_range: { min: -500, max: -400, bins_above: null } }),
  ]) {
    const h = hookDeps({ mode: "live", tracked, pool });
    h.deps.getPool = async () => { poolReads++; return pool; };
    assert.deepEqual(await runBidAskFlips([posRow()], h.deps), []);
    assert.equal(h.sends.length, 0);
  }
  assert.equal(poolReads, 0);
  assert.equal(pool.calls.rebalance, 0);
});

test("M1: unknown PnL holds the flip (no RPC, no send)", async () => {
  assert.match(exitRuleFiresForFlip({ pnl_pct: null }, {}, {}), /pnl unknown/);
  assert.match(exitRuleFiresForFlip({}, {}, {}), /pnl unknown/);
  assert.equal(exitRuleFiresForFlip({ pnl_pct: 0 }, {}, {}), null);
  const pool = fakePool();
  let poolReads = 0;
  const h = hookDeps({ mode: "live", tracked: trackedBidAsk(), pool });
  h.deps.getPool = async () => { poolReads++; return pool; };
  const [r] = await runBidAskFlips([posRow({ pnl_pct: null, pnl_unknown: true })], h.deps);
  assert.equal(r.action, "hold");
  assert.match(r.reason, /pnl unknown/);
  assert.equal(poolReads, 0);
  assert.equal(h.sends.length, 0);
});

test("M3: tranche floor scales with estimated tx cost × chunk count", () => {
  assert.equal(estimateFlipCostLamports({ chunks: 3, maxPriorityFeeLamports: 1_000_000 }), 3 * 1_010_000);
  assert.ok(estimateFlipCostLamports({ chunks: 1, maxPriorityFeeLamports: 0, ataCreates: 1 }) > 2_000_000);
  // Same tranche: passes the configured 0.05 floor, but fails 25× cost of a 1-chunk flip at default prio (0.0253 SOL ok)…
  const b = band({ active: -460, solPerUnit: 1_000_000n });
  const inp = baseInput(b, { cfg: { mode: "shadow", fillPct: 30, reflipStepPct: 20, minTrancheSol: 0.001 } });
  const ok = planBidAskFlip(inp);
  assert.equal(ok.action, "flip");
  assert.ok(ok.trancheSol > 0.0253);
  // …and is held once priority fee ×25 exceeds the tranche (cost floor dominates the tiny configured min).
  const held = planBidAskFlip({ ...inp, maxPriorityFeeLamports: 500_000_000 });
  assert.equal(held.action, "hold");
  assert.match(held.reason, /25× est\. cost/);
  assert.ok(held.minTrancheSol > 0.001);
  // chunk count is part of the floor: a chunked plan has a higher floor than a global one.
  const wide = band({ L: -700, U: -300, active: -560, solPerUnit: 2_000_000n });
  const pw = planBidAskFlip(baseInput(wide, { cfg: { mode: "shadow", fillPct: 30, reflipStepPct: 20, minTrancheSol: 0 } }));
  assert.equal(pw.layout, "chunked");
  assert.equal(pw.minTrancheSol, (25 * pw.chunks.length * 1_010_000) / 1e9);
  // costFloorMult 0 disables it (used by the simulation harness only).
  assert.equal(planBidAskFlip({ ...inp, maxPriorityFeeLamports: 500_000_000, costFloorMult: 0 }).action, "flip");
});

test("M3/M5: a flip that must create a token ATA counts the rent in its cost floor and logs it", async () => {
  const ataIx = () => new TransactionInstruction({ programId: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"), keys: [], data: Buffer.from([1]) });
  // tranche ≈ 0.14 SOL clears 25×(1 tx) but not 25×(1 tx + ATA rent ≈ 0.0021 SOL → 0.0525... use bigger prio to tip it)
  const pool = fakePool({ extraPre: [ataIx()] });
  const h = hookDeps({ mode: "shadow", tracked: trackedBidAsk(), pool, management: { maxPriorityFeeLamports: 0 } });
  const [r] = await runBidAskFlips([posRow()], h.deps);
  assert.equal(r.action, "flip");
  assert.ok(h.logs.some((l) => /creates 1 token ATA/.test(l)));
  const h2 = hookDeps({ mode: "shadow", tracked: trackedBidAsk(), pool: fakePool({ extraPre: [ataIx()] }), management: { maxPriorityFeeLamports: 4_000_000 } });
  const [r2] = await runBidAskFlips([posRow()], h2.deps);
  assert.ok(r2.action === "hold" ? /incl\. ATA rent/.test(r2.reason) : r2.trancheSol >= 25 * (10_000 + 4_000_000 + 2_100_000) / 1e9);
});

test("L3: more than one DLMM-program instruction in the build is refused", async () => {
  const b = band({ active: -460 });
  const plan = planBidAskFlip(baseInput(b));
  await assert.rejects(buildAtomicFlipIxs({ pool: fakePool({ extraDlmm: 1 }), positionPk: OWNER, positionData: {}, plan, rentPayer: OWNER, sdk }), /2 DLMM instructions/);
  // N4: zero DLMM instructions (empty build) is refused too
  const emptyPool = fakePool();
  const orig = emptyPool.rebalancePosition;
  emptyPool.rebalancePosition = async (...a) => ({ ...(await orig(...a)), rebalancePositionInstruction: [] });
  await assert.rejects(buildAtomicFlipIxs({ pool: emptyPool, positionPk: OWNER, positionData: {}, plan, rentPayer: OWNER, sdk }), /0 DLMM instructions/);
});

test("N3: quietSdkSimNoise drops only the SDK's simulation message; other console.error output passes through and the global is restored", async () => {
  const seen = [];
  const real = console.error;
  console.error = (...a) => seen.push(a.map(String).join(" "));
  const wrapped = console.error;
  try {
    const bf = await import(new URL("../tools/bidask-flip.js", import.meta.url));
    await bf.quietSdkSimNoise(async () => {
      console.error(new Error("Transaction simulation failed:\n  • logs"));
      console.error("Transaction simulation failed:\n  • x");
      console.error("some other task: Transaction simulation failed in my own code");
      console.error("unrelated error");
    });
    assert.equal(console.error, wrapped, "global restored");
  } finally { console.error = real; }
  assert.deepEqual(seen, ["some other task: Transaction simulation failed in my own code", "unrelated error"]);
});

test("N2: token-X ATA rent counted once (not per chunk, not ×25); WSOL ATA create excluded", async () => {
  const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const mk = (mint, ata) => new TransactionInstruction({ programId: ATA, data: Buffer.from([1]), keys: [OWNER, ata, OWNER, mint, OWNER, OWNER].map((k) => ({ pubkey: k, isSigner: false, isWritable: false })) });
  const X = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const W = new PublicKey(WSOL);
  const plan = planBidAskFlip(baseInput(band({ active: -460 })));
  const r = await buildAtomicFlipIxs({ pool: fakePool({ extraPre: [mk(X, OWNER), mk(W, X)] }), positionPk: OWNER, positionData: {}, plan, rentPayer: OWNER, sdk });
  assert.equal(r.ataCreates, 1);
  // hook: floor = 25 × fees + one ATA rent. Choose a tranche between 25×(fees+ATA) and 25×fees+ATA.
  // fees = 10_000 + 0 prio ⇒ 25×fees ≈ 0.00025 SOL; ATA once = 0.0021 ⇒ floor ≈ 0.00235 ≪ 0.14 SOL tranche ⇒ flips.
  const h = hookDeps({ mode: "shadow", tracked: trackedBidAsk(), pool: fakePool({ extraPre: [mk(X, OWNER), mk(W, X)] }), management: { maxPriorityFeeLamports: 0 } });
  const [r1] = await runBidAskFlips([posRow()], h.deps);
  assert.equal(r1.action, "flip");
  assert.ok(h.logs.some((l) => /creates 1 token ATA/.test(l) && /once/.test(l)));
  // WSOL-only create ⇒ no ATA accounting at all
  const h2 = hookDeps({ mode: "shadow", tracked: trackedBidAsk(), pool: fakePool({ extraPre: [mk(W, X)] }), management: { maxPriorityFeeLamports: 0 } });
  await runBidAskFlips([posRow()], h2.deps);
  assert.ok(!h2.logs.some((l) => /token ATA/.test(l)));
  // a huge priority fee makes 25×fees + ATA exceed the tranche ⇒ hold with the new message
  const h3 = hookDeps({ mode: "shadow", tracked: trackedBidAsk(), pool: fakePool({ extraPre: [mk(X, OWNER)] }), management: { maxPriorityFeeLamports: 4_000_000 } });
  const [r3] = await runBidAskFlips([posRow()], h3.deps);
  assert.ok(r3.action === "hold" ? /tx fees \+ ATA rent/.test(r3.reason) : r3.trancheSol >= (25 * 4_010_000 + 2_100_000) / 1e9);
});

test("N1: live-flipped position with pnl_source !== 'onchain' holds (no RPC), even with no pnl_api_pct", async () => {
  const pool = fakePool();
  let poolReads = 0;
  const h = hookDeps({ mode: "live", tracked: trackedBidAsk({ bid_ask_flip: { flips: 1, last_flip_active_bin: -300 } }), pool });
  h.deps.getPool = async () => { poolReads++; return pool; };
  for (const src of ["api_after_flip", undefined]) {
    const [r] = await runBidAskFlips([posRow({ pnl_pct: 3, pnl_source: src })], h.deps);
    assert.equal(r.action, "hold");
    assert.match(r.reason, /no on-chain PnL/);
  }
  assert.equal(poolReads, 0);
  assert.equal(h.sends.length, 0);
});

// ── M4: chunked live sequencing, partial failure, owner mismatch, pre/post ix retention ──
const wideBand = () => band({ L: -700, U: -300, active: -560, solPerUnit: 2_000_000n });
const trackedWide = (extra = {}) => ({ ...trackedBidAsk({ bin_range: { min: -700, max: -300, bins_above: 0 }, amount_sol: wideBand().depositedSol }), ...extra });

test("M4: chunked live flip — each later chunk is rebuilt from a fresh getPosition after the previous chunk lands", async () => {
  const wb = wideBand();
  const pool = fakePool({ active: -560, b: wb });
  const h = hookDeps({ mode: "live", tracked: trackedWide(), pool });
  const snap = [];
  h.deps.sendTx = async () => { snap.push({ rebalance: pool.calls.rebalance, getPosition: pool.calls.getPosition }); h.sends.push(1); return `sig${snap.length}`; };
  const [r] = await runBidAskFlips([posRow()], h.deps);
  assert.equal(r.layout, "chunked");
  const n = r.chunks.length;
  assert.ok(n >= 2);
  assert.equal(r.sent, true);
  assert.equal(snap.length, n);
  // initial pass builds all n chunks; every later chunk adds one fresh getPosition + one rebuild before its send.
  for (let i = 1; i < n; i++) {
    assert.equal(snap[i].rebalance - snap[i - 1].rebalance, 1, `chunk ${i + 1} rebuilt once`);
    assert.equal(snap[i].getPosition - snap[i - 1].getPosition, 1, `chunk ${i + 1} read fresh position`);
  }
  assert.ok(snap[0].rebalance === n, "all chunks pre-built before the first send");
  const f = h.updates.at(-1).patch.bid_ask_flip;
  assert.equal(f.flips, 1);
  assert.equal(f.partial, undefined);
  assert.equal(f.last_flip_active_bin, -560);
  assert.equal(f.txs.length, n);
});

test("M4/L1: chunk 2 fails ⇒ partial recorded with 1 sig, and last_flip_active_bin sits just below the lowest landed chunk", async () => {
  const wb = wideBand();
  const pool = fakePool({ active: -560, b: wb });
  const h = hookDeps({ mode: "live", tracked: trackedWide(), pool });
  let n = 0;
  h.deps.sendTx = async () => { n++; if (n === 2) throw new Error("blockhash expired"); return `sig${n}`; };
  const [r] = await runBidAskFlips([posRow()], h.deps);
  assert.equal(r.sent, true);
  assert.deepEqual(r.sigs, ["sig1"]);
  assert.match(r.sendError, /blockhash expired/);
  const f = h.updates.at(-1).patch.bid_ask_flip;
  assert.equal(f.partial, true);
  assert.deepEqual(f.txs, ["sig1"]);
  assert.equal(f.last_flip_active_bin, r.chunks[0].withdraw.minBinId - 1, "top chunk landed; un-landed lower tranche stays re-flippable");
  assert.ok(f.last_flip_active_bin > -560);
  // …and the next plan from that state targets exactly the stranded lower tranche.
  const again = planBidAskFlip(baseInput(wb, { activeId: -560, flipState: { flips: 1, last_flip_active_bin: f.last_flip_active_bin }, cfg: { mode: "shadow", fillPct: 30, reflipStepPct: 1, minTrancheSol: 0 }, now: Date.now() + 10 * 60_000, costFloorMult: 0 }));
  assert.equal(again.hi, f.last_flip_active_bin);
  assert.equal(again.lo, -559);

  // first chunk failing sends nothing recorded
  const h2 = hookDeps({ mode: "live", tracked: trackedWide(), pool: fakePool({ active: -560, b: wb }) });
  h2.deps.sendTx = async () => { throw new Error("boom"); };
  const [r2] = await runBidAskFlips([posRow()], h2.deps);
  assert.equal(r2.sent, false);
  assert.equal(h2.updates.length, 0);
});

test("M4: chunk 2 re-simulation failure or moved active bin stops after chunk 1 (partial)", async () => {
  const wb = wideBand();
  const pool = fakePool({ active: -560, b: wb });
  const h = hookDeps({ mode: "live", tracked: trackedWide(), pool });
  // After the first send the active bin moves.
  h.deps.sendTx = async () => { h.sends.push(1); pool.lbPair.activeId = -559; return "sigA"; };
  const [r] = await runBidAskFlips([posRow()], h.deps);
  assert.deepEqual(r.sigs, ["sigA"]);
  assert.match(r.sendError, /active bin moved between chunks/);
  assert.equal(h.updates.at(-1).patch.bid_ask_flip.partial, true);
});

test("M4: position owner that is not the bot wallet ⇒ error before any send", async () => {
  const pool = fakePool();
  const h = hookDeps({ mode: "live", tracked: trackedBidAsk(), pool });
  h.deps.getWallet = () => ({ publicKey: Keypair.generate().publicKey });
  assert.deepEqual(await runBidAskFlips([posRow()], h.deps), []);
  assert.equal(h.sends.length, 0);
  assert.equal(h.updates.length, 0);
  assert.ok(h.logs.some((l) => /position owner is not the bot wallet/.test(l)));
});

test("M4: SDK pre/post instructions (ATA create, WSOL close) are retained in the sent tx; CU ixs are stripped", async () => {
  const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const ataIx = new TransactionInstruction({ programId: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"), keys: [], data: Buffer.from([1]) });
  const closeIx = new TransactionInstruction({ programId: TOKEN, keys: [], data: Buffer.from([9]) });
  const pool = fakePool({ extraPre: [ataIx], extraPost: [closeIx] });
  const h = hookDeps({ mode: "live", tracked: trackedBidAsk(), pool, management: { maxPriorityFeeLamports: 0 } });
  const [r] = await runBidAskFlips([posRow()], h.deps);
  assert.equal(r.sent, true);
  const progs = h.sends[0].instructions.map((ix) => ix.programId.toBase58());
  assert.deepEqual(progs, [
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    TOKEN.toBase58(),
  ]);
});

test("L2: post-flip verify ignores the active bin's Y but alerts when the range or deeper SOL bins change", async () => {
  const mk = (mutate) => {
    const b0 = band({ active: -460 });
    let reads = 0;
    const pool = fakePool({ active: -460, b: b0, getBand: () => {
      reads++;
      if (reads <= 1) return b0; // the plan read; everything after is post-send verify
      return mutate(b0);
    } });
    return pool;
  };
  const clone = (b0) => ({ ...b0, bins: b0.bins.map((x) => ({ ...x })) });
  const run = async (mutate) => {
    const pool = mk(mutate);
    const h = hookDeps({ mode: "live", tracked: trackedBidAsk(), pool });
    const alerts = [];
    h.deps.notify = async (m) => { alerts.push(m); };
    const [r] = await runBidAskFlips([posRow()], h.deps);
    return { r, alerts };
  };
  // active bin Y changed by a swap: no alert
  let o = await run((b0) => { const c = clone(b0); c.bins.find((x) => x.binId === -460).yRaw += 12345n; return c; });
  assert.equal(o.r.verified.solBinsUntouched, true);
  assert.equal(o.alerts.length, 0);
  // deeper SOL bin changed: alert
  o = await run((b0) => { const c = clone(b0); c.bins.find((x) => x.binId === -470).yRaw += 1n; return c; });
  assert.equal(o.r.verified.solBinsUntouched, false);
  assert.equal(o.alerts.length, 1);
  // range shrank: alert
  o = await run((b0) => { const c = clone(b0); c.U = b0.U - 1; return c; });
  assert.equal(o.r.verified.rangeUnchanged, false);
  assert.equal(o.alerts.length, 1);
});

test("M2: flipped positions take pnl_pct from on-chain; unflipped keep the API value; divergence stops further flips", async () => {
  const dlmm = await import(new URL("../tools/dlmm.js", import.meta.url));
  const row = { position: "P1", pool: "POOL", pnl_pct: 7.5, pnl_usd: 1, pnl_sol: 0.01, sol_price: 100, pnl_unknown: undefined };
  const oc = async () => ({ pnlPct: -1.25, pnlSol: -0.02 });
  const flipped = await dlmm.applyFlipOnchainPnl({ ...row }, { bid_ask_flip: { flips: 1 } }, { getOnchain: oc });
  assert.equal(flipped.pnl_pct, -1.25);
  assert.equal(flipped.pnl_api_pct, 7.5);
  assert.equal(flipped.pnl_source, "onchain");
  assert.equal(flipped.pnl_sol, -0.02);
  // not flipped (or only shadow-flipped) ⇒ untouched
  assert.equal((await dlmm.applyFlipOnchainPnl({ ...row }, { bid_ask_flip_shadow: { flips: 3 } }, { getOnchain: oc })).pnl_pct, 7.5);
  assert.equal((await dlmm.applyFlipOnchainPnl({ ...row }, null, { getOnchain: oc })).pnl_pct, 7.5);
  // unknown API pnl is replaced by a known on-chain value and the unknown flag cleared
  const unk = await dlmm.applyFlipOnchainPnl({ ...row, pnl_pct: null, pnl_unknown: true, pnl_error: "x" }, { bid_ask_flip: { flips: 1 } }, { getOnchain: oc });
  assert.equal(unk.pnl_pct, -1.25);
  assert.ok(!("pnl_unknown" in unk) && !("pnl_error" in unk));
  // on-chain unavailable ⇒ API kept, tagged
  const miss = await dlmm.applyFlipOnchainPnl({ ...row }, { bid_ask_flip: { flips: 1 } }, { getOnchain: async () => null });
  assert.equal(miss.pnl_pct, 7.5);
  assert.equal(miss.pnl_source, "api_after_flip");
  const thrown = await dlmm.applyFlipOnchainPnl({ ...row }, { bid_ask_flip: { flips: 1 } }, { getOnchain: async () => { throw new Error("rpc"); } });
  assert.equal(thrown.pnl_source, "api_after_flip");

  // hook: API vs on-chain gap > 2pp on a live-flipped position ⇒ hold with no RPC
  const pool = fakePool();
  let poolReads = 0;
  const h = hookDeps({ mode: "live", tracked: trackedBidAsk({ bid_ask_flip: { flips: 1, last_flip_active_bin: -300 } }), pool });
  h.deps.getPool = async () => { poolReads++; return pool; };
  const [r] = await runBidAskFlips([posRow({ pnl_pct: -1, pnl_api_pct: 6 })], h.deps);
  assert.equal(r.action, "hold");
  assert.match(r.reason, /diverge/);
  assert.equal(poolReads, 0);
});

// ─── Final Opus review (PR #134): M1 flip-pass timeout ────────────────
test("M1: normalizeFlipConfig carries a 30s default timeout", () => {
  assert.equal(normalizeFlipConfig({}).timeoutSec, 30);
  assert.equal(normalizeFlipConfig({ timeoutSec: 12 }).timeoutSec, 12);
});

test("M1: a hung RPC read times out, logs, skips the cycle and never holds the wallet lock", async () => {
  const wl = await import("../wallet-lock.js");
  const h = hookDeps({ mode: "live", tracked: trackedBidAsk(), pool: fakePool() });
  h.deps.getPool = () => new Promise(() => {}); // never resolves
  h.deps.timeoutMs = 60;
  const t0 = Date.now();
  const r = await runBidAskFlips([posRow()], h.deps);
  assert.deepEqual(r, []);
  assert.ok(Date.now() - t0 < 2000, "returns promptly");
  assert.ok(h.logs.some((l) => /timed out/.test(l)));
  assert.equal(h.sends.length, 0);
  assert.equal(h.updates.length, 0, "nothing was in flight: no pending marker");
  // the lock was released at the timeout: a new op runs immediately
  assert.equal(await Promise.race([wl.withWalletLock(async () => "ok", 0, "after-timeout"), new Promise((res) => setTimeout(() => res("STUCK"), 1000))]), "ok");
});

test("M1: timeout mid-send marks the flip pending; next cycle re-reads on-chain before any re-flip", async () => {
  const pool = fakePool();
  const tracked = trackedBidAsk();
  const h = hookDeps({ mode: "live", tracked, pool });
  h.deps.timeoutMs = 80;
  h.deps.sendTx = () => new Promise(() => {}); // tx in flight, never confirms
  h.deps.updateTrackedPosition = (pos, patch) => { h.updates.push({ pos, patch }); Object.assign(tracked, patch); };
  await runBidAskFlips([posRow()], h.deps);
  const pend = tracked.bid_ask_flip?.pending;
  assert.ok(pend, "pending marker persisted");
  assert.ok(h.logs.some((l) => /may be in flight/.test(l)));
  // next cycle: chain unchanged (our fake pool never moved tokens) ⇒ cleared, NO new send
  h.deps.timeoutMs = 5000;
  let sent = 0;
  h.deps.sendTx = async () => { sent++; return "sigX"; };
  const [r] = await runBidAskFlips([posRow()], h.deps);
  assert.equal(r.action, "hold");
  assert.match(r.reason, /pending flip resolved \(not landed\)/);
  assert.equal(sent, 0, "no re-flip in the same cycle that resolves the marker");
  assert.ok(!tracked.bid_ask_flip?.pending);
});

test("M1: a pending flip whose on-chain token layout changed is recorded as landed", async () => {
  const pool = fakePool();
  const tracked = trackedBidAsk({ bid_ask_flip: { flips: 0, pending: { at: new Date().toISOString(), activeId: -460, xSig: "nonsense" } } });
  const h = hookDeps({ mode: "live", tracked, pool });
  h.deps.updateTrackedPosition = (pos, patch) => { h.updates.push({ pos, patch }); Object.assign(tracked, patch); };
  const [r] = await runBidAskFlips([posRow()], h.deps);
  assert.match(r.reason, /landed/);
  assert.equal(tracked.bid_ask_flip.flips, 1);
  assert.equal(tracked.bid_ask_flip.last_flip_active_bin, -460);
  assert.ok(!tracked.bid_ask_flip.pending);
  assert.equal(h.sends.length, 0);
});

test("M1: schema row is Advanced (tier 3), default 30, wired into config.bidAskFlip", async () => {
  const { BY_KEY } = await import("../settings-schema.js");
  const row = BY_KEY.get("bidAskFlipTimeoutSec");
  assert.ok(row);
  assert.equal(row.tier, 3);
  assert.equal(row.def, 30);
  const { config } = await import("../config.js");
  assert.equal(config.bidAskFlip.timeoutSec >= 5, true);
});
