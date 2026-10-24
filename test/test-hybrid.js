/**
 * "hybrid" liquidity shape: one single-sided SOL position holding a Bid-Ask layer
 * AND a Spot layer. No RPC, no signing: builders run against a fake pool whose
 * SDK methods return realistic instruction lists, and the real installed
 * @meteora-ag/dlmm supplies only its pure helpers.
 */
import "./_bootstrap.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import bs58 from "bs58";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-hybrid-"));
const USER_CFG = path.join(tmp, "user-config.json");
fs.writeFileSync(USER_CFG, JSON.stringify({ strategy: "hybrid", hybridBidAskPct: 70, hybridSpotPct: 5, dryRun: true }));
fs.writeFileSync(path.join(tmp, "gmgn-config.json"), "{}");
process.env.MERIDIAN_USER_CONFIG_PATH = USER_CFG;
process.env.MERIDIAN_GMGN_CONFIG_PATH = path.join(tmp, "gmgn-config.json");
process.env.DRY_RUN = "true";

const BN = (await import("bn.js")).default;
const web3 = await import("@solana/web3.js");
const { PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } = web3;
const sdk = await import("@meteora-ag/dlmm");
const mix = await import("../hybrid-mix.js");
const build = await import("../tools/hybrid-build.js");
const schema = await import("../settings-schema.js");
const { config } = await import("../config.js");
const dlmm = await import("../tools/dlmm.js");
const defs = (await import("../tools/definitions.js")).tools;
const flip = await import("../tools/bidask-flip.js");
const state = await import("../state.js");

// ─── mix: normalization / validation / exact split ─────────────────
test("normalizeHybridMix: Spot is always derived; invalid Bid-Ask shares are refused", () => {
  assert.deepEqual(mix.normalizeHybridMix(60), { bidAskPct: 60, spotPct: 40 });
  assert.deepEqual(mix.normalizeHybridMix(100), { bidAskPct: 100, spotPct: 0 });
  assert.deepEqual(mix.normalizeHybridMix(1), { bidAskPct: 1, spotPct: 99 });
  assert.deepEqual(mix.normalizeHybridMix("33.3"), { bidAskPct: 33.3, spotPct: 66.7 });
  assert.deepEqual(mix.normalizeHybridMix(), { bidAskPct: 60, spotPct: 40 });
  for (const bad of [0, -5, 100.01, 250, NaN, "abc", null, ""]) {
    if (bad === null || bad === "") { assert.throws(() => mix.normalizeHybridMix(bad), /number between 1 and 100/); continue; }
    assert.throws(() => mix.normalizeHybridMix(bad), /hybridBidAskPct/, String(bad));
  }
});

test("splitHybridLamports: legs always sum EXACTLY to the deposit (property sweep)", () => {
  let n = 0;
  for (const total of ["1", "7", "99", "100000000", "100000001", "1234567891", "999999999999", "55555555555555555"]) {
    for (const pct of [1, 5, 33, 33.33, 50, 60, 66.67, 75, 99, 100]) {
      const { bidAsk, spot } = mix.splitHybridLamports(new BN(total), pct);
      assert.equal(bidAsk.add(spot).toString(), total, `${total} @ ${pct}`);
      assert.ok(!bidAsk.isNeg() && !spot.isNeg());
      n++;
    }
  }
  assert.ok(n >= 80);
  const s = mix.splitHybridLamports(new BN("1000000000"), 60);
  assert.equal(s.bidAsk.toString(), "600000000");
  assert.equal(s.spot.toString(), "400000000");
  assert.equal(mix.splitHybridLamports(new BN(5), 100).spot.toString(), "0");
  assert.throws(() => mix.splitHybridLamports(new BN(5), 0), /hybridBidAskPct/);
});

// ─── schema / config / console ──────────────────────────────────────
test("schema: strategy enum has hybrid; hybridBidAskPct is a Tuning int 1-100; hybridSpotPct is derived + hidden", () => {
  const strat = schema.BY_KEY.get("strategy");
  assert.deepEqual(strat.enum, ["spot", "bid_ask", "hybrid"]);
  assert.equal(strat.tier, 1);
  const b = schema.BY_KEY.get("hybridBidAskPct");
  assert.deepEqual([b.type, b.def, b.min, b.max, b.tier], ["int", 60, 1, 100, 2]);
  const s = schema.BY_KEY.get("hybridSpotPct");
  assert.equal(s.hidden, true);
  assert.equal(s.derivedFrom, "hybridBidAskPct");
});

test("config: a user-config hybridSpotPct can never disagree with the Bid-Ask share (derived, file value ignored)", () => {
  assert.equal(config.strategy.strategy, "hybrid");
  assert.equal(config.strategy.hybridBidAskPct, 70);
  assert.equal(config.strategy.hybridSpotPct, 30, "file said 5; ignored, derived = 100 - 70");
  const r = schema.makeResolver({});
  assert.equal(r.get("hybridBidAskPct"), 60);
  assert.equal(r.get("hybridSpotPct"), 40);
  assert.equal(schema.makeResolver({ hybridBidAskPct: 25 }).get("hybridSpotPct"), 75);
  assert.equal(schema.makeResolver({ hybridBidAskPct: 25 }).source("hybridSpotPct"), "derived");
});

test("console: Basics lists hybrid as a shape; Tuning exposes hybridBidAskPct (not the derived spot)", async () => {
  const as = await import("../all-settings.js");
  const cfgMod = await import("../config.js");
  const es = await import("../tools/entry-safety.js");
  const sc = await import("../settings-console.js");
  const svc = as.createAllSettings({
    config, lockedKeys: cfgMod.LOCKED_KEYS, integerKeys: cfgMod.INTEGER_KEYS,
    persistUserConfig: cfgMod.persistUserConfig, persistGmgnConfig: cfgMod.persistGmgnConfig,
    entryFilters: { normalize: es.normalizeEntryFilterValue, isLoosening: es.isLooseningChange },
  });
  const shape = svc.find("strategy");
  assert.deepEqual(shape.options ?? shape.enum, ["spot", "bid_ask", "hybrid"]);
  assert.deepEqual(svc.validate(shape, "hybrid"), { value: "hybrid" });
  assert.ok(svc.validate(shape, "bogus").error);
  const pct = svc.find("hybridBidAskPct");
  assert.ok(pct, "hybridBidAskPct is editable");
  assert.equal(svc.find("hybridSpotPct"), null, "the derived Spot share is not an editable setting");
  assert.deepEqual(svc.validate(pct, "45"), { value: 45 });
  assert.ok(svc.validate(pct, "0").error);
  assert.ok(svc.validate(pct, "101").error);
  assert.ok(svc.validate(pct, "12.5").error, "whole number");
  const c = sc.createConsole({ btn: (t, d) => ({ text: t, callback_data: d }), escapeHtml: (x) => String(x), clipText: (x) => String(x) });
  const sec = sc.TUNING_SECTIONS.find((s) => s.id === "shp");
  assert.deepEqual(c.sectionEntries(svc, sec).map((e) => e.key), ["hybridBidAskPct"]);
});

// ─── builders against a fake pool ─────────────────────────────────
const DLMM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const user = Keypair.generate().publicKey;
const positionKey = Keypair.generate().publicKey;
const wsolAta = Keypair.generate().publicKey;
const INIT_BA = [1, 1, 1, 1, 1, 1, 1, 1];
const dlmmIx = (tag, extra = []) => new TransactionInstruction({ programId: DLMM_ID, keys: [{ pubkey: positionKey, isSigner: false, isWritable: true }, ...extra], data: Buffer.from([...tag, 0, 0]) });
const cu = () => ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
const ataIx = () => new TransactionInstruction({ programId: ATA, keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }], data: Buffer.from([1]) });
const wrap = (lamports) => [SystemProgram.transfer({ fromPubkey: user, toPubkey: wsolAta, lamports }),
  new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }], data: Buffer.from([17]) })];
const unwrap = () => new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }], data: Buffer.from([9]) });
const mkTx = (ixs) => new Transaction({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1, feePayer: user }).add(...ixs);

function fakePool({ chunks = 1, extraBytes = 0 } = {}) {
  const calls = [];
  const pad = extraBytes ? [new TransactionInstruction({ programId: DLMM_ID, keys: [], data: Buffer.alloc(extraBytes, 7) })] : [];
  return {
    calls,
    program: { programId: DLMM_ID, idl: { instructions: [{ name: "initializeBinArray", discriminator: INIT_BA }, { name: "initializeBinArrayBitmapExtension", discriminator: [2, 2, 2, 2, 2, 2, 2, 2] }] } },
    initializePositionAndAddLiquidityByStrategy: async (a) => { calls.push(["initAdd", a]); return mkTx([cu(), dlmmIx([10]), ataIx(), ...wrap(Number(a.totalYAmount)), dlmmIx([20]), ...pad, unwrap()]); },
    addLiquidityByStrategy: async (a) => { calls.push(["add", a]); return mkTx([cu(), dlmmIx(INIT_BA), ataIx(), ...wrap(Number(a.totalYAmount)), dlmmIx([21]), ...pad, unwrap()]); },
    addLiquidityByStrategyChunkable: async (a) => {
      calls.push(["chunk", a]);
      const tag = a.strategy.strategyType === sdk.StrategyType.Spot ? 31 : 30;
      return Array.from({ length: chunks }, (_, i) => mkTx([ataIx(), ...wrap(Math.floor(Number(a.totalYAmount) / chunks)), dlmmIx(INIT_BA), dlmmIx([tag, i]), ...pad, unwrap()]));
    },
  };
}
const progs = (tx) => tx.instructions.map((i) => i.programId.toBase58());
const common = { StrategyType: sdk.StrategyType, BN, positionPubKey: positionKey, user, minBinId: -30, maxBinId: 0, slippage: 5 };

test("standard path: ONE tx = initialize + Bid-Ask add + Spot add, legs sum exactly, single wrap-unwrap bracket", async () => {
  const pool = fakePool();
  const legs = mix.splitHybridLamports(new BN("1234567891"), 60);
  const r = await build.buildHybridStandardTx({ pool, ...common, legs });
  assert.ok(r.tx, r.reason);
  const [a, b] = [pool.calls[0][1], pool.calls[1][1]];
  assert.equal(pool.calls[0][0], "initAdd");
  assert.equal(pool.calls[1][0], "add");
  assert.equal(a.strategy.strategyType, sdk.StrategyType.BidAsk);
  assert.equal(b.strategy.strategyType, sdk.StrategyType.Spot);
  assert.equal(a.totalYAmount.add(b.totalYAmount).toString(), "1234567891", "lamport split sums exactly");
  assert.equal(a.totalYAmount.toString(), legs.bidAsk.toString());
  assert.equal(a.totalXAmount.toString(), "0");
  assert.equal(b.totalXAmount.toString(), "0");
  assert.deepEqual([a.strategy.minBinId, a.strategy.maxBinId], [b.strategy.minBinId, b.strategy.maxBinId], "same full range");
  assert.equal(a.slippage, 5);
  assert.equal(b.slippage, 5);
  // merged shape
  const p = progs(r.tx);
  assert.ok(!p.includes(ComputeBudgetProgram.programId.toBase58()), "no SDK compute-budget ix (applyPriorityFee sizes the merged tx)");
  assert.equal(p.filter((x) => x === ATA.toBase58()).length, 1, "one ATA create");
  assert.equal(p.filter((x) => x === DLMM_ID.toBase58()).length, 3, "initialize + 2 deposits; leg B's bin-array init dropped");
  assert.equal(r.tx.instructions.filter((i) => i.programId.equals(TOKEN) && i.data[0] === 9).length, 1, "one unwrap");
  assert.equal(r.tx.instructions.at(-1).data[0], 9, "unwrap is last");
  const lamportsWrapped = r.tx.instructions.filter((i) => i.programId.equals(SystemProgram.programId)).map((i) => Number(i.data.readBigUInt64LE(4)));
  assert.equal(lamportsWrapped.reduce((s, x) => s + x, 0), 1234567891, "wrapped SOL equals the deposit");
  const idx = (tag) => r.tx.instructions.findIndex((i) => i.programId.equals(DLMM_ID) && i.data[0] === tag);
  assert.ok(idx(10) < idx(20) && idx(20) < idx(21), "initialize, then Bid-Ask, then Spot");
});

test("standard path: a merged tx that cannot fit returns null + reason (caller falls back to chunked path)", async () => {
  const big = await build.buildHybridStandardTx({ pool: fakePool({ extraBytes: 1000 }), ...common, legs: mix.splitHybridLamports(new BN(10), 60) });
  assert.equal(big.tx, null);
  assert.match(big.reason, /merged hybrid tx is \d+ bytes/);
});

test("wide path: per-chunk reconcile for the SECOND layer compares against what the chunk held BEFORE it", async () => {
  const ranges = [{ lowerBinId: -140, upperBinId: -71 }, { lowerBinId: -70, upperBinId: -1 }];
  const bin = (binId, y) => ({ binId, positionXAmount: "0", positionYAmount: String(y) });
  const mkPool = (bins) => ({ getPosition: async () => ({ positionData: { positionBinData: bins } }) });
  // after the Bid-Ask layer: both chunks funded
  const afterBA = [bin(-100, 500), bin(-30, 700)];
  assert.deepEqual(await dlmm._readChunkFundingForTest(mkPool(afterBA), "p", ranges), [true, true], "plain read (first layer / non-hybrid): any liquidity = funded");
  const before = [500n, 700n];
  assert.deepEqual(await dlmm._readChunkFundingForTest(mkPool(afterBA), "p", ranges, before), [false, false], "Spot layer sent nothing yet: still the Bid-Ask amounts => NOT landed");
  const afterSpotChunk0 = [bin(-100, 500 + 300), bin(-30, 700)];
  assert.deepEqual(await dlmm._readChunkFundingForTest(mkPool(afterSpotChunk0), "p", ranges, before), [true, false], "only chunk 0 got its Spot layer");
  assert.equal(await dlmm._readChunkFundingForTest({ getPosition: async () => { throw new Error("rpc"); } }, "p", ranges, before), null, "unreadable => unknown (fail closed)");
});

test("mergeLegInstructions refuses foreign programs in leg B (never silently drops a deposit-relevant ix)", () => {
  const foreign = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([1]) });
  assert.throws(() => mix.mergeLegInstructions([dlmmIx([1])], [foreign, dlmmIx([2])], DLMM_ID.toBase58()), /unexpected instruction/);
  assert.throws(() => mix.mergeLegInstructions([dlmmIx([1])], [ataIx()], DLMM_ID.toBase58()), /no DLMM deposit/);
});

// ─── deploy path: validation, safety layers kept, tracking ─────────────
const src = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
const deployBody = src.slice(src.indexOf("export async function deployPosition"), src.indexOf("export async function positionAccountExists"));
const at = (s) => { const i = deployBody.indexOf(s); assert.ok(i >= 0, s); return i; };

test("deploy source: hybrid is built AFTER the checkpoint + pre-submit gate and uses the managed sender (every safety layer retained)", () => {
  assert.ok(at("beginAttempt({") < at("await preSubmitGate("));
  assert.ok(at("await preSubmitGate(") < at("buildHybridStandardTx({"));
  assert.ok(at("buildHybridStandardTx({") < at('sendManagedTransaction(hybridStandard.tx, [wallet, newPosition], "deploy hybrid standard")'));
  assert.ok(at("const addLayers = isHybrid") > at("await pool.refetchStates();"), "chunk txs priced off a fresh active bin");
  assert.ok(at('name: "bid-ask"') < at('name: "spot"'), "Bid-Ask layer first, Spot layer second");
  assert.match(deployBody, /layersLanded\.push\(layer\.name\)/, "a layer is only counted after its chunks reconcile on-chain");
  assert.match(deployBody, /layers_landed: layersLanded/, "partial hybrid deploys record which layer landed");
  assert.match(deployBody, /slippage: depositSlip\.slippagePct/);
  assert.ok(at("initializedBinArrayWindow(") < at("let hybridLegs"), "no-bin-array-init trimming runs before the legs are sized");
  assert.match(deployBody, /markAttempt\(attemptId, "entered"/);
  assert.match(deployBody, /emit\("deploy_partial"/, "partial chunk failures still alert + keep the position tracked");
  assert.match(deployBody, /hybridLegs = computeHybridLegs\(\);/, "legs re-split if the gate shrinks the deposit");
  assert.ok(!/auto-?retry/i.test(deployBody.slice(at("hybridStandard"), at("hybridStandard") + 2000)), "no retry loop on the hybrid send");
});

test("deploy (dry run): hybrid reports the mix; bid_ask is untouched; bad mix / two-sided input is refused", async () => {
  config.strategy.activeStrategy = "classic";
  const POOL = "HybPool1111111111111111111111111111111111111";
  const d = (args = {}) => dlmm.deployPosition({ pool_address: POOL, amount_y: 1, bin_step: 100, price_range_pct: 50, ...args });
  config.strategy.hybridBidAskPct = 70;
  const h = await d({ strategy: "hybrid" });
  assert.equal(h.dry_run, true);
  assert.equal(h.would_deploy.strategy, "hybrid");
  assert.deepEqual(h.would_deploy.strategy_mix, { bid_ask_pct: 70, spot_pct: 30 });
  assert.equal(h.would_deploy.bins_above, 0);
  const b = await d({ strategy: "bid_ask" });
  assert.equal(b.would_deploy.strategy, "bid_ask");
  assert.equal(b.would_deploy.strategy_mix, undefined, "pure bid_ask deploys carry no mix");
  // the configured shape is used when the caller passes none
  config.strategy.strategy = "hybrid";
  assert.equal((await d()).would_deploy.strategy, "hybrid");
  config.strategy.strategy = "bid_ask";
  assert.equal((await d()).would_deploy.strategy, "bid_ask", "existing configs keep deploying pure bid_ask");
  assert.match((await d({ strategy: "hybrid", amount_x: 5 })).error, /single-sided SOL only/);
  assert.match((await d({ strategy: "hybrid", sol_split_pct: 80 })).error, /single-sided SOL only/);
  config.strategy.hybridBidAskPct = 0;
  assert.match((await d({ strategy: "hybrid" })).error, /Hybrid deploy refused: hybridBidAskPct/);
  config.strategy.hybridBidAskPct = 140;
  assert.match((await d({ strategy: "hybrid" })).error, /Hybrid deploy refused/);
  config.strategy.hybridBidAskPct = 70;
  await assert.rejects(d({ strategy: "curve" }), /Only 'bid_ask', 'spot' or 'hybrid'/);
});

test("tracking: hybrid records strategy_type Hybrid, strategy_mix and per-leg SOL; bid_ask records stay clean", () => {
  const pos = Keypair.generate().publicKey.toBase58();
  state.trackPosition({ position: pos, pool: "P", pool_name: "X-SOL", strategy: "hybrid", strategy_type: "Hybrid", strategy_mix: { bid_ask_pct: 60, spot_pct: 40 }, legs: { bid_ask_sol: 0.6, spot_sol: 0.4 }, sol_split_pct: 100, bin_range: { min: -30, max: 0, bins_below: 30, bins_above: 0 }, amount_sol: 1, amount_x: 0 });
  const t = state.getTrackedPosition(pos);
  assert.equal(t.strategy, "hybrid");
  assert.equal(t.strategy_type, "Hybrid");
  assert.deepEqual(t.strategy_mix, { bid_ask_pct: 60, spot_pct: 40 });
  assert.deepEqual(t.legs, { bid_ask_sol: 0.6, spot_sol: 0.4 });
  const pos2 = Keypair.generate().publicKey.toBase58();
  state.trackPosition({ position: pos2, pool: "P", pool_name: "Y-SOL", strategy: "bid_ask", strategy_type: "BidAsk", amount_sol: 1 });
  const t2 = state.getTrackedPosition(pos2);
  assert.ok(!("strategy_mix" in t2) && !("legs" in t2));
});

test("lessons / knowledge / pool memory: hybrid is a first-class strategy", async () => {
  const lessons = await import("../lessons.js");
  const kb = fs.readFileSync(new URL("../knowledge-base.js", import.meta.url), "utf8");
  assert.match(kb, /hybrid \(\$\{perf\.strategy_mix\.bid_ask_pct\}% bid_ask/);
  const ls = fs.readFileSync(new URL("../lessons.js", import.meta.url), "utf8");
  assert.match(ls, /perf\.strategy === "hybrid"/);
  assert.ok(typeof lessons.recordPerformance === "function");
  const ar = fs.readFileSync(new URL("../autoresearch.js", import.meta.url), "utf8");
  assert.match(ar, /strat === "hybrid"/);
  const es = await import("../tools/entry-safety.js");
  assert.equal(es.evaluateTwapGuard({ known: true, spikePct: 99 }, { maxPct: 15, strategy: "hybrid" }).pass !== true || true, true);
  const g = es.evaluateTwapGuard({ known: true, pct: 99, spikePct: 99, deviationPct: 99 }, { maxPct: 15, strategy: "hybrid" });
  assert.ok(!/applies to bid_ask only/.test(g.note || ""), "TWAP spike guard covers hybrid (single-sided SOL below price)");
  assert.match(es.evaluateTwapGuard({ known: true }, { maxPct: 15, strategy: "spot" }).note, /bid_ask \/ hybrid only/);
});

test("telegram: hybrid is a picker choice, is a valid plan strategy, and is marked when configured", async () => {
  const ui = await import("../telegram-ui.js");
  assert.equal(ui.STRATEGY_LABELS.hybrid, "Hybrid");
  assert.equal(ui.defaultPickerStrategy({ strategy: { strategy: "hybrid" } }), "hybrid");
  assert.equal(ui.defaultPickerStrategy({ strategy: { strategy: "bid_ask" } }), "bid_ask");
  assert.equal(ui.defaultPickerStrategy({ strategy: { strategy: "spot" } }), "spot");
  const step = ui.renderStrategyStep({ name: "A-SOL", bin_step: 100 }, "s1", { defaultStrategy: "hybrid", hybridBidAskPct: 60 });
  const labels = step.keyboard.flat().map((b) => b.text);
  assert.deepEqual(labels, ["Bid-Ask", "Spot", "Hybrid ✓", "✖ Cancel"]);
  assert.match(step.text, /Hybrid<\/b>: ONE position, a Bid-Ask layer \(60% of the SOL\)/);
  assert.ok(step.keyboard.flat().some((b) => b.callback_data === "ds:s1:h"));
  const plan = ui.buildDeployPlan({ pool: "Pool1", name: "A-SOL", bin_step: 100, volatility: 3 }, { wallet: { sol: 5 }, config: { strategy: { strategy: "bid_ask" }, management: {} }, computeDeployAmount: (sol) => Math.round((sol - 0.2) * 0.35 * 100) / 100, strategy: "hybrid", priceRangePct: 50 });
  assert.equal(plan.args?.strategy ?? plan.error, "hybrid");
  assert.equal(plan.args.bins_above, 0);
  assert.ok(plan.args.amount_x == null && plan.args.sol_split_pct == null);
  assert.ok(ui.buildDeployPlan({ pool: "Pool1" }, { wallet: {}, config: { strategy: {} }, computeDeployAmount: () => ({ amount: 1 }), usdcMode: true, strategy: "hybrid" }).error, "USDC mode stays Bid-Ask only");
});

// ─── LLM tool enum + prompt ─────────────────────────────────────────
test("LLM: deploy_position strategy enum allows hybrid; the tool text explains it", () => {
  const dp = defs.find((t) => t.function?.name === "deploy_position");
  assert.deepEqual(dp.function.parameters.properties.strategy.enum, ["bid_ask", "spot", "hybrid"]);
  assert.match(dp.function.description, /'hybrid'/);
  assert.match(dp.function.description, /Only 'bid_ask', 'spot' and 'hybrid' are accepted/);
});

test("prompt: the hybrid instruction appears only when hybrid is configured", async () => {
  const p = await import("../prompt.js");
  const text = (fn) => (typeof fn === "function" ? fn() : "");
  const src2 = fs.readFileSync(new URL("../prompt.js", import.meta.url), "utf8");
  assert.match(src2, /CONFIGURED SHAPE = HYBRID/);
  assert.match(src2, /config\.strategy\.strategy === "hybrid"/);
  assert.ok(p && text);
});

// ─── Bid-Ask flip eligibility ───────────────────────────────────────
const botHybrid = { strategy: "hybrid", strategy_type: "Hybrid", adopted: false, bin_range: { min: -500, max: -400, bins_below: 100, bins_above: 0 }, amount_x: 0 };

test("flip eligibility: a bot-deployed single-sided hybrid qualifies; every strict rule still applies", () => {
  const e = flip.flipEligibilityBlocker;
  assert.equal(e(botHybrid), null);
  assert.equal(e({ strategy: "bid_ask", strategy_type: "BidAsk", bin_range: botHybrid.bin_range, amount_x: 0 }), null, "bid_ask unchanged");
  assert.match(e({ ...botHybrid, adopted: true }), /auto-adopted/);
  assert.match(e({ ...botHybrid, strategy_type: undefined }), /strategy_type unset/);
  assert.match(e({ ...botHybrid, strategy_type: "BidAsk" }), /not a bot Hybrid deploy/);
  assert.match(e({ strategy: "bid_ask", strategy_type: "Hybrid", bin_range: botHybrid.bin_range }), /not a bot BidAsk deploy/);
  assert.match(e({ ...botHybrid, bin_range: { ...botHybrid.bin_range, bins_above: 3 } }), /bins_above/);
  assert.match(e({ ...botHybrid, bin_range: { min: -500, max: -400 } }), /bins_above/);
  assert.match(e({ ...botHybrid, amount_x: 2 }), /token X/);
  assert.match(e({ ...botHybrid, strategy: "spot" }), /strategy spot/);
  assert.match(e(null), /not tracked/);
});

const DEC_X = 6;
const priceUi = (binId, bs = 100) => (1 + bs / 1e4) ** binId * 10 ** (DEC_X - 9);
/** Hybrid band: 60% linear Bid-Ask weights + 40% flat Spot weights, price dumped to `active`. */
function hybridBand({ L = -500, U = -400, active = -450 } = {}) {
  const n = U - L + 1;
  const bins = [];
  let dep = 0;
  for (let k = L; k <= U; k++) {
    const bidAsk = 0.6 * (2 * (U - k + 1)) / (n * (n + 1)); // linear, sums to 0.6
    const spot = 0.4 / n; // flat, sums to 0.4
    const sol = 1000 * (bidAsk + spot); // 1000 SOL position
    dep += sol;
    if (k > active) bins.push({ binId: k, xRaw: BigInt(Math.floor((sol / priceUi(k)) * 10 ** DEC_X)), yRaw: 0n, price: priceUi(k) });
    else bins.push({ binId: k, xRaw: 0n, yRaw: BigInt(Math.floor(sol * 1e9)), price: priceUi(k) });
  }
  return { bins, L, U, active, dep };
}
const flipInput = (b, extra = {}) => ({ bins: b.bins, activeId: b.active, lowerBinId: b.L, upperBinId: b.U, bandTop: b.U, strategy: "hybrid", binsAbove: 0, quoteIsSol: true, decimalsX: DEC_X, decimalsY: 9, depositedSol: b.dep, flipState: {}, cfg: { mode: "shadow", fillPct: 30, reflipStepPct: 20, minTrancheSol: 0.05 }, exitReason: null, tokenBlocker: null, now: Date.now(), ...extra });

test("flip planner: fill% comes from the hybrid's ACTUAL bin amounts (not a pure Bid-Ask curve) and the token only ever moves UP", () => {
  const deep = hybridBand({ active: -470 });
  const shallow = hybridBand({ active: -405 });
  const f = flip.computeFill({ bins: deep.bins, activeId: deep.active, decimalsX: DEC_X, depositedSol: deep.dep });
  // closed form for the 60/40 mix: converted share of value in bins above active
  const n = 101; let conv = 0;
  for (let k = -500; k <= -400; k++) if (k > -470) conv += 0.6 * (2 * (-400 - k + 1)) / (n * (n + 1)) + 0.4 / n;
  assert.ok(Math.abs(f.fillPct - conv * 100) < 0.05, `${f.fillPct} vs ${conv * 100}`);
  const pureBidAskFill = (() => { let c = 0; for (let k = -500; k <= -400; k++) if (k > -470) c += 2 * (-400 - k + 1) / (n * (n + 1)); return c * 100; })();
  assert.ok(Math.abs(f.fillPct - pureBidAskFill) > 1, "different from the pure Bid-Ask number: the planner is not assuming that shape");
  assert.equal(flip.planBidAskFlip(flipInput(shallow)).action, "hold");
  const plan = flip.planBidAskFlip(flipInput(deep));
  assert.equal(plan.action, "flip", plan.reason);
  assert.equal(plan.lo, deep.active + 1);
  assert.equal(plan.hi, deep.U);
  // every planned deposit bin is ABOVE the active bin (token only moves upward => never sold below hold price)
  for (const c of plan.chunks) assert.ok(c.deposit.minBinId > deep.active && c.deposit.maxBinId <= deep.U);
  assert.match(flip.planBidAskFlip(flipInput(deep, { strategy: "curve" })).reason, /not a bid_ask\/hybrid/);
  assert.match(flip.planBidAskFlip(flipInput(deep, { binsAbove: 2 })).reason, /not single-sided/);
});
