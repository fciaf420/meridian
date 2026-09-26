/**
 * On-chain PnL confirmation of PnL-triggered exits (pnl-confirm.js,
 * tools/onchain-pnl.js, pnl-watcher.js, the management close gate) and the
 * 2026-09-26 history correction script.
 *
 * state.js reads/writes ./state.json relative to the cwd, so this test chdirs
 * into a temp dir BEFORE importing anything — it never touches live files.
 * Every chain / API read is mocked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-onchain-pnl-"));
process.chdir(tmp);
process.env.DRY_RUN = "true";

const { trackPosition, getTrackedPosition, updatePnlAndCheckExits } = await import(new URL("../state.js", import.meta.url));
const { config } = await import(new URL("../config.js", import.meta.url));
const { computeOnchainPnl, getOnchainPnl, _setOnchainPnlDepsForTest, SOL_MINT } = await import(new URL("../tools/onchain-pnl.js", import.meta.url));
const { decidePnlExit, managementPnlCloseGate } = await import(new URL("../pnl-confirm.js", import.meta.url));
const { runPnlWatcher, _setPnlWatcherDepsForTest } = await import(new URL("../pnl-watcher.js", import.meta.url));
const fixScript = await import(new URL("../scripts/fix-false-tp-2026-09-26.js", import.meta.url));

Object.assign(config.management, {
  takeProfitFeePct: 7,
  stopLossPct: -15,
  emergencyPriceDropPct: -50,
  trailingTakeProfit: true,
  trailingTriggerPct: 5,
  trailingDropPct: 4,
  outOfRangeWaitMinutes: 30,
  pnlWarmupMinutes: 15,
  pnlWarmupMaxAbsPct: 25,
  pnlUnit: "sol",
});

const POOL = "Pool111111111111111111111111111111111111111";
let n = 0;
function open({ ageMin = 5, amountSol = 6.16, extra = {} } = {}) {
  const position = `Pos${++n}${"x".repeat(30)}`;
  trackPosition({
    position,
    pool: POOL,
    pool_name: "EACC-SOL",
    strategy: "bid_ask",
    amount_sol: amountSol,
    initial_value_usd: amountSol * 122.56,
    deployed_at: new Date(Date.now() - ageMin * 60_000).toISOString(),
    ...extra,
  });
  return position;
}

// ─── Watcher harness ───
function harness({ positions, onchain }) {
  const closes = [];
  const emitted = [];
  _setPnlWatcherDepsForTest({
    isBusy: () => false,
    isManagementBusy: () => false,
    isScreeningBusy: () => false,
    getMyPositions: async () => ({ positions }),
    getOnchainPnl: async (p) => (typeof onchain === "function" ? onchain(p) : onchain),
    closePosition: async (args) => { closes.push(args); return { success: true, txs: ["sig"] }; },
    getPositionBins: async () => null,
    emit: (ev, data) => emitted.push({ ev, data }),
  });
  return { closes, emitted };
}
const apiPos = (position, pnl_pct, extra = {}) => ({ position, pool: POOL, pair: "EACC-SOL", pnl_pct, pnl_usd: pnl_pct * 7.55, total_value_usd: 755, ...extra });
const oc = (pnlPct) => ({ pnlPct, pnlSol: pnlPct * 0.0616, valueSol: 6.16, depositSol: 6.16, feesSol: 0.0004 });

// ─── computeOnchainPnl ───
test("computeOnchainPnl: the e/acc case — 6.16 SOL in, all SOL + dust fees out ≈ 0%", () => {
  const pool = {
    tokenX: { publicKey: { toString: () => "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU" }, mint: { decimals: 6 } },
    tokenY: { publicKey: { toString: () => SOL_MINT }, mint: { decimals: 9 } },
    lbPair: { binStep: 125 },
  };
  const positionData = {
    positionBinData: [
      { positionXAmount: "0", positionYAmount: "4812721340" },
      { positionXAmount: "0", positionYAmount: "1347276988" },
    ],
    feeX: "49805765", // 49.805765 tokens
    feeY: "400470",
  };
  const r = computeOnchainPnl({ pool, positionData, activePrice: 8.485e-6, tracked: { amount_sol: 6.16, amount_x: 0 } });
  assert.ok(r);
  assert.ok(Math.abs(r.pnlPct) < 0.05, `≈0%, got ${r.pnlPct}`);
  assert.ok(Math.abs(r.valueSol - 6.159998328) < 1e-6);
  assert.ok(r.feesSol > 0.0008 && r.feesSol < 0.0009);
});

test("computeOnchainPnl: token side is valued at the active price; no SOL side → null", () => {
  const pool = {
    tokenX: { publicKey: { toString: () => "Tok" }, mint: { decimals: 6 } },
    tokenY: { publicKey: { toString: () => SOL_MINT }, mint: { decimals: 9 } },
  };
  const r = computeOnchainPnl({
    pool,
    positionData: { positionBinData: [{ positionXAmount: "1000000000", positionYAmount: "500000000" }], feeX: "0", feeY: "0" },
    activePrice: 0.001, // 1000 tokens × 0.001 = 1 SOL, + 0.5 SOL
    tracked: { amount_sol: 1, amount_x: 0 },
  });
  assert.equal(r.valueSol, 1.5);
  assert.equal(r.pnlPct, 50);
  const noSol = { ...pool, tokenY: { publicKey: { toString: () => "USDC" }, mint: { decimals: 6 } } };
  assert.equal(computeOnchainPnl({ pool: noSol, positionData: { positionBinData: [] }, activePrice: 1, tracked: { amount_sol: 1 } }), null);
});

test("getOnchainPnl caches ~20s and returns null (never throws) on a failed read", async () => {
  let reads = 0;
  let now = 1_000_000;
  const address = open();
  _setOnchainPnlDepsForTest({
    now: () => now,
    PublicKey: class { constructor(k) { this.k = k; } },
    getTrackedPosition: getTrackedPosition,
    getPool: async () => ({
      tokenX: { publicKey: { toString: () => "Tok" }, mint: { decimals: 6 } },
      tokenY: { publicKey: { toString: () => SOL_MINT }, mint: { decimals: 9 } },
      lbPair: { binStep: 100 },
      getPosition: async () => { reads++; return { positionData: { positionBinData: [{ positionXAmount: "0", positionYAmount: "6160000000" }], feeX: "0", feeY: "0" } }; },
      getActiveBin: async () => ({ binId: 10, pricePerToken: "0.001" }),
    }),
  });
  const a = await getOnchainPnl({ position: address, pool: POOL });
  assert.equal(a.pnlPct, 0);
  await getOnchainPnl({ position: address, pool: POOL });
  assert.equal(reads, 1, "second call within 20s is cached");
  now += 21_000;
  await getOnchainPnl({ position: address, pool: POOL });
  assert.equal(reads, 2);
  _setOnchainPnlDepsForTest({
    getTrackedPosition,
    PublicKey: class {},
    getPool: async () => ({ getPosition: async () => { throw new Error("rpc down"); }, getActiveBin: async () => ({}) }),
  });
  assert.equal(await getOnchainPnl({ position: address, pool: POOL }), null);
  _setOnchainPnlDepsForTest(null);
});

// ─── decidePnlExit ───
test("decidePnlExit thresholds and fallbacks", () => {
  // TP: on-chain ≥ threshold − 1, sources within 2 points
  assert.equal(decidePnlExit({ kind: "take_profit", apiPct: 7.4, onchainPct: 6.2, threshold: 7 }).close, true);
  assert.equal(decidePnlExit({ kind: "take_profit", apiPct: 7.4, onchainPct: 5.9, threshold: 7 }).close, false);
  // mismatch > 2 points holds a TP even when on-chain crosses
  assert.equal(decidePnlExit({ kind: "take_profit", apiPct: 12, onchainPct: 8, threshold: 7 }).close, false);
  // SL: on-chain ≤ threshold + 1; an on-chain-confirmed loss exits even if the API is off
  assert.equal(decidePnlExit({ kind: "stop_loss", apiPct: -15.5, onchainPct: -14.2, threshold: -15 }).close, true);
  assert.equal(decidePnlExit({ kind: "stop_loss", apiPct: -15.5, onchainPct: -13.5, threshold: -15 }).close, false);
  assert.equal(decidePnlExit({ kind: "stop_loss", apiPct: -16, onchainPct: -25, threshold: -15 }).close, true);
  // read failed: SL exits on API, TP / trailing hold
  assert.equal(decidePnlExit({ kind: "stop_loss", apiPct: -16, onchainPct: null, threshold: -15 }).close, true);
  assert.equal(decidePnlExit({ kind: "take_profit", apiPct: 8, onchainPct: null, threshold: 7 }).close, false);
  assert.equal(decidePnlExit({ kind: "trailing", apiPct: 2, onchainPct: null, peakPct: 8, dropPct: 4 }).close, false);
  // trailing: on-chain ≤ (peak − drop) + 1
  assert.equal(decidePnlExit({ kind: "trailing", apiPct: 3.5, onchainPct: 4.5, peakPct: 8, dropPct: 4 }).close, true);
  assert.equal(decidePnlExit({ kind: "trailing", apiPct: 3.5, onchainPct: 5.2, peakPct: 8, dropPct: 4 }).close, false);
});

// ─── Watcher: the incident and the rest of the matrix ───
test("watcher: false TP held — API +7.4%, on-chain 0% (the e/acc case)", async () => {
  const pos = open({ ageMin: 4 });
  const { closes } = harness({ positions: [apiPos(pos, 7.39)], onchain: oc(0.01) });
  await runPnlWatcher();
  assert.equal(closes.length, 0, "must not close");
  const t = getTrackedPosition(pos);
  assert.ok(t.notes.some((x) => x.startsWith("HELD (on-chain PnL did not confirm): FIXED_TP")), t.notes.join(" | "));
  assert.ok((t.peak_pnl_pct ?? 0) < 1, `peak must come from on-chain, got ${t.peak_pnl_pct}`);
  assert.equal(t.trailing_active, false, "a bogus 7.4% must not arm trailing (trigger 5%)");
});

test("watcher: a real TP closes and records the on-chain PnL", async () => {
  const pos = open({ ageMin: 30 });
  const { closes, emitted } = harness({ positions: [apiPos(pos, 7.5, { oor_direction: "upside" })], onchain: oc(7.2) });
  await runPnlWatcher();
  assert.equal(closes.length, 1);
  assert.equal(closes[0]._pnlOverride.pnl_pct, 7.2);
  assert.equal(closes[0]._pnlOverride.pnl_source, "onchain");
  assert.match(closes[0]._close_reason, /^FIXED_TP: .*\(OOR upside\)$/);
  assert.equal(emitted[0].data.pnlPct, 7.2);
});

test("watcher: stop loss with a failed on-chain read still exits (on the API value)", async () => {
  const pos = open({ ageMin: 30 });
  const { closes } = harness({ positions: [apiPos(pos, -16)], onchain: null });
  await runPnlWatcher();
  assert.equal(closes.length, 1);
  assert.equal(closes[0]._pnlOverride.pnl_pct, -16);
  assert.match(closes[0]._close_reason, /^STOP_LOSS/);
});

test("watcher: TP with a failed on-chain read holds, and closes on a later tick once confirmed", async () => {
  const pos = open({ ageMin: 30 });
  let read = null;
  const { closes } = harness({ positions: [apiPos(pos, 8)], onchain: () => read });
  await runPnlWatcher();
  assert.equal(closes.length, 0);
  read = oc(7.8);
  await runPnlWatcher();
  assert.equal(closes.length, 1);
});

test("watcher: trailing uses the on-chain value", async () => {
  // 1) a bogus API spike (7.4%, under the 25% warm-up bar) with on-chain 0.3%
  //    must not become the trailing peak; the next normal reading is no "drop".
  const a = open({ ageMin: 20 });
  const h1 = harness({ positions: [apiPos(a, 7.4)], onchain: oc(0.3) });
  await runPnlWatcher(); // FIXED_TP held; peak from on-chain
  assert.equal(h1.closes.length, 0);
  let h = harness({ positions: [apiPos(a, 0.5)], onchain: oc(0.4) });
  await runPnlWatcher();
  assert.equal(h.closes.length, 0, "no trailing exit off a peak the chain never saw");
  assert.equal(getTrackedPosition(a).trailing_active, false);

  // 2) a real run-up armed on-chain, then a real drop: trailing closes on-chain.
  const b = open({ ageMin: 60 });
  harness({ positions: [apiPos(b, 6.5)], onchain: oc(6.4) });
  await runPnlWatcher();
  assert.equal(getTrackedPosition(b).trailing_active, true);
  h = harness({ positions: [apiPos(b, 2.4)], onchain: oc(2.3) });
  await runPnlWatcher();
  assert.equal(h.closes.length, 1);
  assert.match(h.closes[0]._close_reason, /^TRAILING_TP/);
  assert.equal(h.closes[0]._pnlOverride.pnl_pct, 2.3);

  // 3) API says it dropped, the chain says it didn't: hold.
  const c = open({ ageMin: 60 });
  harness({ positions: [apiPos(c, 6.5)], onchain: oc(6.4) });
  await runPnlWatcher();
  h = harness({ positions: [apiPos(c, 2.0)], onchain: oc(6.1) });
  await runPnlWatcher();
  assert.equal(h.closes.length, 0);
});

test("watcher: FIXED_TP respects the warm-up guard (+33% at age 3m is not closed)", async () => {
  const pos = open({ ageMin: 3 });
  const { closes } = harness({ positions: [apiPos(pos, 33)], onchain: oc(33) });
  await runPnlWatcher();
  assert.equal(closes.length, 0, "warm-up spike is held one tick even for fixed TP");
});

test("updatePnlAndCheckExits without an on-chain value behaves as before", () => {
  const pos = open({ ageMin: 60 });
  assert.equal(updatePnlAndCheckExits(pos, 6, config), null);
  assert.equal(getTrackedPosition(pos).peak_pnl_pct, 6);
  assert.match(updatePnlAndCheckExits(pos, 1.5, config) ?? "", /^TRAILING_TP/);
});

// ─── Management gate (rule 3 / rule 6 via executeTool) ───
test("management gate: rule 3 on a false API TP is held; rule 4 and non-PnL closes pass", async () => {
  const mgmt = config.management;
  const pos = open({ ageMin: 4 });
  const gate = (p, onchain) => managementPnlCloseGate({
    position_address: pos,
    mgmt,
    getPositions: async () => ({ positions: [p] }),
    getTracked: getTrackedPosition,
    getOnchain: async () => onchain,
  });
  const held = await gate(apiPos(pos, 7.39, { minutes_out_of_range: 2 }), oc(0.01));
  assert.equal(held.pass, false);
  assert.match(held.reason, /rule 3/);
  assert.equal((await gate(apiPos(pos, 7.39, { minutes_out_of_range: 31 }), oc(0.01))).pass, true, "rule 4 is not gated");
  assert.equal((await gate(apiPos(pos, 2), oc(0.01))).pass, true, "judgment close, not a PnL rule");
  assert.equal((await gate(apiPos(pos, 7.5), oc(7.1))).pass, true, "real TP");
  assert.equal((await gate(apiPos(pos, -55), null)).pass, true, "rule 6 with a failed read exits");
  assert.equal((await gate(apiPos(pos, 7.5), null)).pass, false, "rule 3 with a failed read holds");
});

// ─── History correction script ───
test("fix-false-tp-2026-09-26: rewrites the e/acc record and is idempotent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-fix-tp-"));
  const P = fixScript.POSITION;
  fs.writeFileSync(path.join(root, "lessons.json"), JSON.stringify({
    lessons: [
      { id: 1, rule: "WORKED: e/acc-SOL, strategy=bid_ask → PnL +7.39%, range efficiency 50%.", outcome: "good", created_at: "2026-09-26T00:07:10.332Z" },
      { id: 2, rule: "PREFER: something else", outcome: "good", created_at: "2026-09-26T00:23:09.243Z" },
    ],
    performance: [
      { position: "Other", pnl_pct: 1, pnl_usd: 1 },
      { position: P, pool: fixScript.POOL, pnl_pct: 7.39, pnl_usd: 55.55, actual_pnl_pct: 7.39, actual_pnl_usd: 55.55, final_value_usd: 806.93, fees_earned_usd: 0.07, initial_value_usd: 754.97 },
    ],
  }));
  fs.writeFileSync(path.join(root, "pool-memory.json"), JSON.stringify({
    [fixScript.POOL]: {
      deploys: [
        { deployed_at: fixScript.DEPLOYED_AT, pnl_pct: 7.39, pnl_usd: 55.55 },
        { deployed_at: "2026-09-26T00:21:04.569Z", pnl_pct: -3, pnl_usd: -20 },
      ],
      avg_pnl_pct: 2.2, win_rate: 0.5, last_outcome: "loss",
    },
  }));
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({
    positions: { [P]: { position: P, notes: ["Closed at …: agent decision (OOR upside)"] } },
    recentAutoCloses: [{ position: P, reason: "FIXED_TP: PnL 7.4% >= take profit (7%)", pnl_pct: 7.39 }],
  }));
  fs.mkdirSync(path.join(root, "knowledge/pools"), { recursive: true });
  fs.writeFileSync(path.join(root, "knowledge/pools/e-acc-sol.md"),
    "## Deploy History\n\n- **WIN** 2026-09-26T00:23: PnL 33.0%, held 2min\n\n- **WIN** 2026-09-26T00:07: PnL 7.4%, held 4min, strategy: bid_ask\n");
  fs.writeFileSync(path.join(root, "knowledge/LOG.md"), "- 2026-09-26T00:07:10 CLOSE WIN: e/acc-SOL PnL 7.4%, strategy=bid_ask\n");

  const quiet = () => {};
  const preview = fixScript.applyCorrections(root, { apply: false, log: quiet });
  assert.ok(preview.changes.length >= 6);
  assert.equal(preview.written.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "lessons.json"))).performance[1].pnl_pct, 7.39, "preview writes nothing");

  const first = fixScript.applyCorrections(root, { apply: true, log: quiet });
  assert.equal(first.written.length, 5);
  const lessons = JSON.parse(fs.readFileSync(path.join(root, "lessons.json")));
  const rec = lessons.performance[1];
  assert.equal(rec.pnl_pct, 0.01);
  assert.equal(rec.pnl_usd, 0.11);
  assert.equal(rec.corrected, fixScript.CORRECTED);
  assert.equal(rec.original.pnl_pct, 7.39);
  assert.deepEqual(lessons.lessons.map((l) => l.id), [2], "WORKED lesson removed");
  const pm = JSON.parse(fs.readFileSync(path.join(root, "pool-memory.json")))[fixScript.POOL];
  assert.equal(pm.deploys[0].pnl_pct, 0.01);
  assert.equal(pm.avg_pnl_pct, -1.49); // (0.01 − 3) / 2, rounded like pool-memory.js
  assert.equal(pm.win_rate, 0.5);
  const st = JSON.parse(fs.readFileSync(path.join(root, "state.json")));
  assert.equal(st.recentAutoCloses[0].pnl_pct, 0.01);
  assert.ok(st.positions[P].notes.at(-1).startsWith("Corrected:"));
  const kb = fs.readFileSync(path.join(root, "knowledge/pools/e-acc-sol.md"), "utf8");
  assert.match(kb, /2026-09-26T00:07: PnL 0\.0%.*\[corrected: false TP 7\.4%/);
  assert.match(kb, /00:23: PnL 33\.0%, held 2min\n/, "other closes untouched");
  const snapshot = ["lessons.json", "pool-memory.json", "state.json", "knowledge/pools/e-acc-sol.md", "knowledge/LOG.md"]
    .map((f) => fs.readFileSync(path.join(root, f), "utf8"));

  const second = fixScript.applyCorrections(root, { apply: true, log: quiet });
  assert.equal(second.changes.length, 0, "second run changes nothing");
  assert.equal(second.written.length, 0);
  assert.deepEqual(["lessons.json", "pool-memory.json", "state.json", "knowledge/pools/e-acc-sol.md", "knowledge/LOG.md"]
    .map((f) => fs.readFileSync(path.join(root, f), "utf8")), snapshot);
});
