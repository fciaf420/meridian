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
  exitRuleFiresForFlip, buildAtomicFlipIxs, runBidAskFlips, flipCloseTags, token2022Blocker, MAX_BIN_OPS_PER_TX, MIN_ASK_BINS,
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
  assert.deepEqual(normalizeFlipConfig({}), { mode: "shadow", fillPct: 30, reflipStepPct: 20, minTrancheSol: 0.05 });
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

function fakePool({ active = -460, rent = 0, binArrayCount = 0, initIxs = 0, netDepositX = 0, simActive = active, b = band({ active }), simErr = null } = {}) {
  const calls = { rebalance: 0, simulate: 0 };
  return {
    calls,
    lbPair: { activeId: active, binStep: BIN_STEP },
    tokenX: { publicKey: Keypair.generate().publicKey, owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), mint: { decimals: DEC_X } },
    tokenY: { publicKey: new PublicKey(WSOL), mint: { decimals: DEC_Y } },
    async refetchStates() {},
    async getPosition() {
      return { positionData: { owner: OWNER, lowerBinId: b.L, upperBinId: b.U, positionBinData: b.bins.map((x) => ({ binId: x.binId, positionXAmount: x.xRaw.toString(), positionYAmount: x.yRaw.toString(), pricePerToken: String(x.price) })) } };
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
      return { initBinArrayInstructions: Array.from({ length: initIxs }, fakeIx), rebalancePositionInstruction: [cuIx(), fakeIx()] };
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
const trackedBidAsk = (extra = {}) => ({ position: POS, strategy: "bid_ask", bin_range: { min: -500, max: -400, bins_above: 0 }, amount_sol: band({ active: -460 }).depositedSol, ...extra });
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
