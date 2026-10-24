/**
 * Exit-path safety (fix/exits-in-code): N-tick exit confirmation, peak
 * confirmation, suspicious ticks, bounded stop-loss wait, trailing source
 * agreement, priority wallet lock, re-entry cooldowns, code-executed
 * management rules and close-reason labels.
 *
 * state.js reads/writes ./state.json relative to the cwd, so this test chdirs
 * into a temp dir BEFORE importing anything. Every chain / API read is mocked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-exit-safety-"));
process.chdir(tmp);
process.env.DRY_RUN = "true";

const state = await import(new URL("../state.js", import.meta.url));
const { config } = await import(new URL("../config.js", import.meta.url));
const { decidePnlExit, managementPnlCloseGate } = await import(new URL("../pnl-confirm.js", import.meta.url));
const engine = await import(new URL("../exit-engine.js", import.meta.url));
const { withWalletLock, WALLET_PRIORITY } = await import(new URL("../wallet-lock.js", import.meta.url));
const { runManagementCodeRules, ruleLabelForPnlExit, formatCodeRuleResults } = await import(new URL("../management-rules.js", import.meta.url));

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
Object.assign(config.screening, { minFeeActiveTvlRatio: 0.05, minVolume: 500, timeframe: "5m" });

test("config.exits defaults: 2 ticks, 20s spacing, 120s bounded SL wait, cooldowns on", () => {
  // Defaults as shipped (the user-config.json in a dev checkout may be absent).
  assert.equal(typeof config.exits, "object");
  for (const k of ["confirmTicks", "peakConfirmTicks", "confirmMinSpacingSec", "stopLossUnverifiedMaxWaitSec", "stopLossCooldownMinutes", "oorCooldownTriggerCount", "oorCooldownMinutes"]) {
    assert.ok(Number.isFinite(config.exits[k]), k);
  }
});

// Back-to-back ticks in tests: no spacing unless a test asks for it.
Object.assign(config.exits, { confirmTicks: 2, peakConfirmTicks: 2, confirmMinSpacingSec: 0, stopLossUnverifiedMaxWaitSec: 120, stopLossCooldownMinutes: 240, oorCooldownTriggerCount: 3, oorCooldownMinutes: 360 });

const POOL = "Pool111111111111111111111111111111111111111";
let n = 0;
function open({ ageMin = 60, pool = POOL, base_mint = null, instruction = null } = {}) {
  const position = `Ex${++n}${"x".repeat(30)}`;
  state.trackPosition({
    position, pool, pool_name: "TEST-SOL", strategy: "bid_ask", amount_sol: 5, initial_value_usd: 600,
    ...(base_mint && { base_mint }),
    deployed_at: new Date(Date.now() - ageMin * 60_000).toISOString(),
  });
  if (instruction) state.setPositionInstruction(position, instruction);
  return position;
}
const apiPos = (position, pnl_pct, extra = {}) => ({ position, pool: POOL, pair: "TEST-SOL", pnl_pct, pnl_usd: pnl_pct * 6, total_value_usd: 600 * (1 + pnl_pct / 100), in_range: true, minutes_out_of_range: 0, ...extra });
const oc = (pnlPct) => ({ pnlPct, pnlSol: pnlPct * 0.05, valueSol: 5, depositSol: 5, feesSol: 0.01 });
const quiet = () => {};

function engineDeps(onchain, now = Date.now()) {
  return {
    config,
    getTracked: state.getTrackedPosition,
    update: state.updatePnlAndCheckExits,
    register: state.registerExitTick,
    recordHold: state.recordPnlHold,
    readOnchain: async (p) => (typeof onchain === "function" ? onchain(p) : onchain),
    log: quiet,
    now,
  };
}

// ─── registerExitTick ───
test("registerExitTick: fires after N confirming ticks of the same kind; keyed by kind, not reason text", () => {
  const p = open();
  const t1 = state.registerExitTick(p, { kind: "stop_loss", outcome: "confirm", reason: "STOP_LOSS: PnL -16.0%", config });
  assert.equal(t1.fire, false);
  const t2 = state.registerExitTick(p, { kind: "stop_loss", outcome: "confirm", reason: "STOP_LOSS: PnL -17.4%", config });
  assert.equal(t2.fire, true, "different PnL in the reason text must not reset the streak");
  assert.equal(state.getExitStreak(p).confirms, 2, "H2: streak kept after firing so a failed close retries on the next tick");
  assert.equal(state.registerExitTick(p, { kind: "stop_loss", outcome: "confirm", reason: "STOP_LOSS: PnL -17.9%", config }).fire, true, "keeps firing");
  state.recordClose(p, "STOP_LOSS: closed");
  assert.equal(state.getExitStreak(p), null, "recordClose clears the streak");
});

test("registerExitTick: refute / clear reset; unverified and suspicious freeze", () => {
  const p = open();
  state.registerExitTick(p, { kind: "take_profit", outcome: "confirm", config });
  state.registerExitTick(p, { kind: "take_profit", outcome: "unverified", config });
  state.registerExitTick(p, { kind: "take_profit", outcome: "unverified", suspicious: true, config });
  assert.equal(state.getExitStreak(p).confirms, 1, "frozen, not reset");
  assert.equal(state.registerExitTick(p, { kind: "take_profit", outcome: "confirm", config }).fire, true);
  state.registerExitTick(p, { kind: "take_profit", outcome: "confirm", config });
  state.registerExitTick(p, { kind: "take_profit", outcome: "refute", config });
  assert.equal(state.getExitStreak(p), null);
  state.registerExitTick(p, { kind: "trailing", outcome: "confirm", config });
  assert.equal(state.registerExitTick(p, { kind: "take_profit", outcome: "confirm", config }).fire, false, "a different kind starts a new streak");
});

test("registerExitTick: ticks closer than confirmMinSpacingSec count once", () => {
  const p = open();
  const cfg = { ...config, exits: { ...config.exits, confirmMinSpacingSec: 20 } };
  const t0 = Date.now();
  state.registerExitTick(p, { kind: "stop_loss", outcome: "confirm", config: cfg, now: t0 });
  assert.equal(state.registerExitTick(p, { kind: "stop_loss", outcome: "confirm", config: cfg, now: t0 + 3_000 }).fire, false);
  assert.equal(state.registerExitTick(p, { kind: "stop_loss", outcome: "confirm", config: cfg, now: t0 + 25_000 }).fire, true);
});

test("registerExitTick: unverified stop loss exits on the API value only after the bounded wait, never on suspicious ticks", () => {
  const p = open();
  const t0 = Date.now();
  assert.equal(state.registerExitTick(p, { kind: "stop_loss", outcome: "unverified", config, now: t0 }).fireOnApi, false);
  assert.equal(state.registerExitTick(p, { kind: "stop_loss", outcome: "unverified", config, now: t0 + 30_000 }).fireOnApi, false, "inside the wait");
  // suspicious ticks past the wait never fire on the API value
  assert.equal(state.registerExitTick(p, { kind: "stop_loss", outcome: "unverified", suspicious: true, config, now: t0 + 200_000 }).fireOnApi, false);
  assert.equal(state.registerExitTick(p, { kind: "stop_loss", outcome: "unverified", config, now: t0 + 201_000 }).fireOnApi, true);
  // take profit never fires unverified
  const q = open();
  state.registerExitTick(q, { kind: "take_profit", outcome: "unverified", config, now: t0 });
  const r = state.registerExitTick(q, { kind: "take_profit", outcome: "unverified", config, now: t0 + 900_000 });
  assert.equal(r.fire || r.fireOnApi, false);
});

// ─── Peak confirmation / trailing ───
test("peak: a lone spike after a normal reading confirms only the normal reading", () => {
  const p = open();
  state.updatePnlAndCheckExits(p, 2, config);
  state.updatePnlAndCheckExits(p, 9, config);
  assert.equal(state.getTrackedPosition(p).peak_pnl_pct, 2, "min of the 2-tick window");
  assert.equal(state.getTrackedPosition(p).trailing_active ?? false, false);
  state.updatePnlAndCheckExits(p, 1, config); // spike gone
  assert.equal(state.getTrackedPosition(p).trailing_active ?? false, false);
});

test("peak: P(DOOM) — the API at +5.1% with on-chain disagreeing never arms trailing", () => {
  const p = open();
  for (let i = 0; i < 3; i++) state.updatePnlAndCheckExits(p, 5.1, config, { onchainPct: -0.5, strict: true });
  const t = state.getTrackedPosition(p);
  assert.equal(t.trailing_active ?? false, false);
  assert.ok((t.peak_pnl_pct ?? 0) < 5, `peak ${t.peak_pnl_pct}`);
});

test("peak: strict mode with no on-chain reading leaves the peak alone", () => {
  const p = open();
  for (let i = 0; i < 3; i++) state.updatePnlAndCheckExits(p, 8, config, { onchainPct: null, strict: true });
  assert.equal(state.getTrackedPosition(p).peak_pnl_pct ?? 0, 0);
});

test("decidePnlExit trailing: both sources must be at the trail level", () => {
  // on-chain crossed but the API has not dropped → hold
  assert.equal(decidePnlExit({ kind: "trailing", apiPct: 6, onchainPct: 4.5, peakPct: 8, dropPct: 4 }).close, false);
  assert.equal(decidePnlExit({ kind: "trailing", apiPct: 4.2, onchainPct: 4.5, peakPct: 8, dropPct: 4 }).close, true);
});

// ─── Exit engine ───
test("engine: suspicious tick (value 0 → -100%) never closes on the API, however long it lasts", async () => {
  const p = open();
  const t0 = Date.now();
  for (let i = 0; i < 6; i++) {
    const r = await engine.evaluatePnlExit(apiPos(p, -100, { total_value_usd: 0 }), engineDeps(null, t0 + i * 60_000));
    assert.notEqual(r.action, "close");
    assert.equal(r.suspicious, true);
  }
  assert.equal(engine.isUnpriceableTick({ pnl_pct: -40, total_value_usd: 360 }).suspicious, false, "a big move on valid inputs is not suspicious");
  assert.equal(engine.isUnpriceableTick({ pnl_pct: null, pnl_unknown: true }).suspicious, true);
});

test("engine: suspicious API tick but on-chain shows the crash → stop loss after 2 on-chain ticks", async () => {
  const p = open();
  const a = await engine.evaluatePnlExit(apiPos(p, -100, { total_value_usd: 0 }), engineDeps(oc(-22)));
  assert.equal(a.action, "hold");
  const b = await engine.evaluatePnlExit(apiPos(p, -100, { total_value_usd: 0 }), engineDeps(oc(-23)));
  assert.equal(b.action, "close");
  assert.equal(b.kind, "stop_loss");
  assert.equal(b.onchainPct, -23);
});

test("engine: stop loss confirmed on-chain closes on the 2nd tick; a recovery in between resets", async () => {
  const p = open();
  assert.equal((await engine.evaluatePnlExit(apiPos(p, -16), engineDeps(oc(-15.5)))).action, "hold");
  assert.equal((await engine.evaluatePnlExit(apiPos(p, -5), engineDeps(oc(-5)))).action, "none");
  assert.equal((await engine.evaluatePnlExit(apiPos(p, -16), engineDeps(oc(-15.5)))).action, "hold", "streak restarted");
  const r = await engine.evaluatePnlExit(apiPos(p, -17), engineDeps(oc(-16.8)));
  assert.equal(r.action, "close");
  assert.match(r.reason, /^STOP_LOSS/);
});

test("engine: stale API above the stop, on-chain below it → stop loss signal from on-chain", async () => {
  const p = open();
  // a streak in progress always re-reads on-chain; start one, then the API lags
  await engine.evaluatePnlExit(apiPos(p, -16), engineDeps(oc(-16)));
  const r = await engine.evaluatePnlExit(apiPos(p, -10), engineDeps(oc(-18)));
  assert.equal(r.action, "close");
});

test("engine: warm-up spike guard still holds a take profit on a young position", async () => {
  const p = open({ ageMin: 3 });
  const r = await engine.evaluatePnlExit(apiPos(p, 33), engineDeps(oc(33)));
  assert.notEqual(r.action, "close");
});

test("engine: emergency stop (rule 6) with stop loss disabled", async () => {
  const prev = config.management.stopLossPct;
  config.management.stopLossPct = null;
  try {
    const p = open();
    await engine.evaluatePnlExit(apiPos(p, -55), engineDeps(oc(-55)));
    const r = await engine.evaluatePnlExit(apiPos(p, -56), engineDeps(oc(-56)));
    assert.equal(r.action, "close");
    assert.match(r.reason, /^EMERGENCY/);
    assert.match(ruleLabelForPnlExit(r), /^rule 6: emergency stop — EMERGENCY/);
  } finally {
    config.management.stopLossPct = prev;
  }
});

// ─── Wallet lock ───
test("wallet lock: a queued close runs before a queued deploy; in-flight work is not interrupted", async () => {
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = withWalletLock(async () => { order.push("deploy-1 start"); await gate; order.push("deploy-1 end"); }, WALLET_PRIORITY.deploy_position);
  const d2 = withWalletLock(async () => { order.push("deploy-2"); }, WALLET_PRIORITY.deploy_position);
  const claim = withWalletLock(async () => { order.push("claim"); }, WALLET_PRIORITY.claim_fees);
  const close = withWalletLock(async () => { order.push("close"); }, WALLET_PRIORITY.close_position);
  release();
  await Promise.all([first, d2, claim, close]);
  assert.deepEqual(order, ["deploy-1 start", "deploy-1 end", "close", "claim", "deploy-2"]);
});

test("wallet lock: a throwing operation rejects its caller and does not wedge the queue", async () => {
  await assert.rejects(withWalletLock(async () => { throw new Error("boom"); }, 10));
  assert.equal(await withWalletLock(async () => 42, 0), 42);
});

test("executeTool routes fund-moving tools through the priority wallet lock", () => {
  const src = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(src, /withWalletLock\(\s*\(\) => \{[\s\S]*?return executeToolInner\(name, args, \{ manual, codeExit \}\);\s*\},\s*priorityForTool\(name\)/);
  assert.match(src, /name === "deploy_position" && isDraining\(\)/, "L4: drain re-checked inside the lock");
  assert.match(src, /if \(manual \|\| codeExit \|\| !isManagementBusy\(\)\) return \{ pass: true \};/);
});

// ─── Cooldowns ───
test("cooldown kinds: stop loss / emergency / rule 6 vs OOR timeout; '(OOR upside)' tags are not OOR closes", () => {
  assert.equal(state.cooldownKindForReason("STOP_LOSS: PnL -16.0% hit stop loss (-15%)"), "stop_loss");
  assert.equal(state.cooldownKindForReason("rule 6: emergency stop — EMERGENCY: PnL -55%"), "stop_loss");
  assert.equal(state.cooldownKindForReason("rule 4: OOR timeout (31m ≥ 30m) (OOR upside)"), "oor");
  assert.equal(state.cooldownKindForReason("OOR fallback (LLM unavailable) (OOR upside)"), "oor");
  assert.equal(state.cooldownKindForReason("FIXED_TP: PnL 7.5% >= take profit (7%) (OOR upside)"), null);
  assert.equal(state.cooldownKindForReason("agent decision (OOR upside)"), null);
  assert.equal(state.cooldownKindForReason("TRAILING_TP: PnL dropped 4.1%"), null);
});

test("cooldown: a stop-loss close blocks the pool and the base mint; other pools stay open", () => {
  const pool = "SLPool1111111111111111111111111111111111111";
  const mint = "SLMint1111111111111111111111111111111111111";
  const p = open({ pool, base_mint: mint });
  state.recordClose(p, "STOP_LOSS: PnL -16.0% hit stop loss (-15%)");
  assert.equal(state.getTrackedPosition(p).close_reason, "STOP_LOSS: PnL -16.0% hit stop loss (-15%)");
  const cd = state.getDeployCooldown({ pool });
  assert.equal(cd?.scope, "pool");
  assert.ok(Date.parse(cd.until) - Date.now() > 230 * 60_000);
  assert.equal(state.getDeployCooldown({ pool: "Other", base_mint: mint })?.scope, "mint");
  assert.equal(state.getDeployCooldown({ pool: "Other", base_mint: "OtherMint" }), null);
  assert.equal(state.getDeployCooldown({ pool }, Date.now() + 241 * 60_000), null, "expires");
});

test("cooldown: 3 consecutive OOR-timeout closes in one pool trigger it; an interleaved TP does not count", () => {
  const pool = "OorPool111111111111111111111111111111111111";
  const close = (reason, minsAgo) => {
    const p = open({ pool });
    state.recordClose(p, reason);
    // order the closes deterministically
    const raw = JSON.parse(fs.readFileSync("./state.json", "utf8"));
    raw.positions[p].closed_at = new Date(Date.now() - minsAgo * 60_000).toISOString();
    fs.writeFileSync("./state.json", JSON.stringify(raw));
  };
  close("rule 4: OOR timeout (OOR upside)", 30);
  close("FIXED_TP: PnL 7.2% (OOR upside)", 20);
  close("rule 4: OOR timeout (OOR upside)", 10);
  assert.equal(state.getDeployCooldown({ pool }), null);
  const p = open({ pool });
  state.recordClose(p, "rule 4: OOR timeout (OOR upside)");
  assert.equal(state.getDeployCooldown({ pool }), null, "TP breaks the run of 3");
  const q = open({ pool });
  state.recordClose(q, "OOR fallback (LLM unavailable) (OOR upside)");
  assert.match(state.getDeployCooldown({ pool })?.reason ?? "", /3 consecutive OOR-timeout closes/);
});

test("deploy eligibility checks the cooldown and lets owner deploys override it (logged)", () => {
  const src = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(src, /getDeployCooldown\(\{ pool: args\.pool_address, base_mint: null \}\)/);
  assert.match(src, /getDeployCooldown\(\{ pool: null, base_mint: mint \}\)/);
  assert.match(src, /if \(args\._manual\) \{\s*log\("cooldown"/);
  assert.match(src, /log\("cooldown", `deploy_position blocked/);
});

// ─── Management code rules ───
function mgmtHarness({ onchain = null, poolDetail = { fee_active_tvl_ratio: 1, volume: 10_000 } } = {}) {
  const toolCalls = [];
  const directCloses = [];
  const deps = {
    config,
    getTracked: state.getTrackedPosition,
    getPoolDetail: async () => poolDetail,
    executeTool: async (name, args, opts) => { toolCalls.push({ name, args, opts }); state.recordClose(args.position_address, args._close_reason); return { success: true }; },
    log: quiet,
    engineDeps: { update: state.updatePnlAndCheckExits, register: state.registerExitTick, recordHold: state.recordPnlHold, readOnchain: async () => onchain, log: quiet },
    closeDeps: {
      closePosition: async (args) => { directCloses.push(args); state.recordClose(args.position_address, args._close_reason); return { success: true }; },
      getTracked: state.getTrackedPosition,
      isCloseInflight: () => false,
      recordAutoClose: state.recordAutoClose,
      emit: () => {},
      log: quiet,
    },
  };
  return { deps, toolCalls, directCloses };
}

test("management: rule 4 closes in code with a rule label and codeExit; no LLM needed", async () => {
  const p = open();
  const h = mgmtHarness();
  const out = await runManagementCodeRules([apiPos(p, 0.1, { in_range: false, minutes_out_of_range: 31, oor_direction: "upside" })], h.deps);
  assert.equal(out.llmNeeded.length, 0);
  assert.equal(h.toolCalls.length, 1);
  assert.equal(h.toolCalls[0].opts.codeExit, true);
  assert.match(h.toolCalls[0].args._close_reason, /^rule 4: OOR timeout .*\(OOR upside\)$/);
  assert.doesNotMatch(state.getTrackedPosition(p).close_reason, /agent decision/);
});

test("management: rule 5 yield dead closes in code; unverifiable pool data holds", async () => {
  const p = open();
  let h = mgmtHarness({ poolDetail: { fee_active_tvl_ratio: 0.01, volume: 100 } });
  await runManagementCodeRules([apiPos(p, 0.5)], h.deps);
  assert.equal(h.toolCalls.length, 1);
  assert.match(h.toolCalls[0].args._close_reason, /^rule 5: yield dead/);
  const q = open();
  h = mgmtHarness({ poolDetail: null });
  const out = await runManagementCodeRules([apiPos(q, 0.5)], h.deps);
  assert.equal(h.toolCalls.length, 0);
  assert.match(out.lines.join("\n"), /rule 5 unverified/);
});

test("management: rule 3 take profit closes in code after 2 confirming cycles — the LLM is never asked", async () => {
  const p = open();
  const h = mgmtHarness({ onchain: oc(7.4) });
  let out = await runManagementCodeRules([apiPos(p, 7.6)], h.deps);
  assert.equal(out.closed.length, 0);
  assert.equal(out.held.length, 1);
  out = await runManagementCodeRules([apiPos(p, 7.8)], h.deps);
  assert.equal(out.closed.length, 1);
  assert.equal(h.directCloses.length, 1);
  assert.match(h.directCloses[0]._close_reason, /^rule 3: take profit — FIXED_TP/);
  assert.equal(h.directCloses[0]._pnlOverride.pnl_source, "onchain");
  assert.match(formatCodeRuleResults(out), /do NOT close positions for rules 3-6 yourself/);
});

test("management: an instruction hands the position to the LLM and code rules leave it alone", async () => {
  const p = open({ instruction: "hold until 10%" });
  const h = mgmtHarness({ poolDetail: { fee_active_tvl_ratio: 0.01, volume: 1 } });
  const out = await runManagementCodeRules([apiPos(p, 0, { in_range: false, minutes_out_of_range: 99 })], h.deps);
  assert.deepEqual(out.llmNeeded, ["TEST-SOL: instruction"]);
  assert.equal(h.toolCalls.length + h.directCloses.length, 0);
});

test("closeForExit skips a position the other loop already closed", async () => {
  const p = open();
  state.recordClose(p, "STOP_LOSS: closed by the watcher");
  const calls = [];
  const r = await engine.closeForExit(apiPos(p, -16), { reason: "STOP_LOSS: x", onchainPct: -16, onchain: oc(-16) }, {
    closePosition: async (a) => { calls.push(a); return { success: true }; },
    getTracked: state.getTrackedPosition,
    log: quiet,
  });
  assert.equal(r.skipped, "already_closed");
  assert.equal(calls.length, 0);
});

test("management gate: a model close on a PnL rule the runner is still confirming is held", async () => {
  const p = open();
  state.registerExitTick(p, { kind: "take_profit", outcome: "confirm", config });
  const r = await managementPnlCloseGate({
    position_address: p,
    mgmt: config.management,
    getPositions: async () => ({ positions: [apiPos(p, 7.5)] }),
    getTracked: state.getTrackedPosition,
    getOnchain: async () => oc(7.4),
    requiredTicks: 2,
  });
  assert.equal(r.pass, false);
  assert.match(r.reason, /being confirmed by the runner \(1\/2/);
});

test("index.js management cycle executes rules in code and no longer feeds stop-loss/trailing to the LLM as exit alerts", () => {
  const src = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(src, /await runManagementCodeRules\(precheckedPositions,/);
  assert.doesNotMatch(src, /const exitAction = updatePnlAndCheckExits\(p\.position, p\.pnl_pct, config\);/);
});


// ═══════════════ Fable 5.1 audit fixes (PR #132) ═══════════════
const pnlWatcher = await import(new URL("../pnl-watcher.js", import.meta.url));
const executor = await import(new URL("../tools/executor.js", import.meta.url));
const lockMod = await import(new URL("../wallet-lock.js", import.meta.url));

test("H1: stale API (-10) hides an on-chain -40 with NO prior streak → forced on-chain read still exits in 2 ticks", async () => {
  engine._resetBiasForTest();
  const p = open();
  const cfg = { ...config, exits: { ...config.exits, onchainReadIntervalSec: 60 } };
  let reads = 0;
  const deps = (now) => ({ ...engineDeps(() => { reads++; return oc(-40); }, now), config: cfg, markOnchain: state.markOnchainRead });
  const t0 = Date.now();
  const r1 = await engine.evaluatePnlExit(apiPos(p, -10), deps(t0));
  assert.equal(r1.action, "hold", "tick 1: on-chain read forced (never read before) → streak starts");
  assert.equal(reads, 1);
  const r2 = await engine.evaluatePnlExit(apiPos(p, -10), deps(t0 + 60_000));
  assert.equal(r2.action, "close", "tick 2 confirms");
  assert.match(r2.reason, /^STOP_LOSS/);
});

test("H1: the forced read is periodic, not every tick (API harmless + fresh read → no on-chain call)", async () => {
  const p = open();
  const cfg = { ...config, exits: { ...config.exits, onchainReadIntervalSec: 60 } };
  let reads = 0;
  const deps = (now) => ({ ...engineDeps(() => { reads++; return oc(-1); }, now), config: cfg, markOnchain: state.markOnchainRead });
  const t0 = Date.now();
  await engine.evaluatePnlExit(apiPos(p, -1), deps(t0));
  assert.equal(reads, 1);
  await engine.evaluatePnlExit(apiPos(p, -1), deps(t0 + 20_000));
  assert.equal(reads, 1, "within the interval");
  await engine.evaluatePnlExit(apiPos(p, -1), deps(t0 + 60_000));
  assert.equal(reads, 2, "interval elapsed");
  assert.equal(engine.needsOnchain(-1, { last_onchain_at: new Date(t0).toISOString() }, config.management, { now: t0 + 1_000, intervalMs: 0 }), false, "0 disables the forced read");
});

test("H2: a failed close retries on the very next tick without re-confirming; success clears the streak", async () => {
  const p = open();
  const t0 = Date.now();
  assert.equal((await engine.evaluatePnlExit(apiPos(p, -20), engineDeps(oc(-20), t0))).action, "hold");
  const res = await engine.evaluatePnlExit(apiPos(p, -20), engineDeps(oc(-20), t0 + 1_000));
  assert.equal(res.action, "close");
  let attempts = 0;
  const closeDeps = {
    closePosition: async (args) => { attempts++; if (attempts === 1) return { success: false, error: "blockhash expired" }; state.recordClose(args.position_address, args._close_reason); return { success: true }; },
    getTracked: state.getTrackedPosition, isCloseInflight: () => false, recordAutoClose: state.recordAutoClose, emit: () => {}, log: quiet,
  };
  const c1 = await engine.closeForExit(apiPos(p, -20), res, closeDeps);
  assert.equal(c1.closed, false);
  const res2 = await engine.evaluatePnlExit(apiPos(p, -20), engineDeps(oc(-20), t0 + 2_000));
  assert.equal(res2.action, "close", "H2: fires again immediately — no extra confirming ticks");
  const c2 = await engine.closeForExit(apiPos(p, -20), res2, closeDeps);
  assert.equal(c2.closed, true);
  assert.equal(state.getExitStreak(p), null);
});

test("H3: deploy omitting base_mint is still blocked by a mint cooldown (mint resolved from the pool)", async () => {
  const mint = "MintCoolDown1111111111111111111111111111111";
  const sibling = "SiblingPool11111111111111111111111111111111";
  const p = open({ pool: POOL, base_mint: mint });
  state.recordClose(p, "STOP_LOSS: PnL -16% hit stop loss (-15%)");
  const binStep = config.screening.minBinStep;
  const deps = (detail) => ({ getPoolDetailFn: async () => detail, getPositionsFn: async () => ({ total_positions: 0, positions: [] }) });
  const blocked = await executor.checkDeployEligibility({ pool_address: sibling, pool_name: "SIB" }, deps({ bin_step: binStep, base: { mint } }));
  assert.equal(blocked.pass, false, "base_mint omitted by the model, pool says it is the cooled-down token");
  assert.match(blocked.reason, /Re-entry cooldown: token MintCoolDown/);
  const wrong = await executor.checkDeployEligibility({ pool_address: sibling, base_mint: "SomethingElse" }, deps({ bin_step: binStep, base: { mint } }));
  assert.equal(wrong.pass, false, "a wrong model-supplied base_mint does not bypass it");
  const unresolved = await executor.checkDeployEligibility({ pool_address: sibling, bin_step: binStep }, { getPoolDetailFn: async () => { throw new Error("api down"); }, getPositionsFn: async () => ({ total_positions: 0, positions: [] }) });
  assert.equal(unresolved.pass, false, "mint unresolvable while a mint cooldown is active → fail closed");
  const owner = await executor.checkDeployEligibility({ pool_address: sibling, _manual: true }, deps({ bin_step: binStep, base: { mint } }));
  assert.equal(owner.pass, true, "owner override still works");
  // integrate: #129 added a deploy-time screening re-check that needs live pool data; disable it here (it has its own tests).
  const prevSafety = config.safety;
  config.safety = { ...(prevSafety || {}), recheckScreeningAtDeploy: false, requireKnownVolatility: false, maxScreenToDeployDropPct: 0 };
  try {
    const other = await executor.checkDeployEligibility({ pool_address: sibling }, deps({ bin_step: binStep, base: { mint: "OtherToken1111111111111111111111111111111111" } }));
    assert.equal(other.pass, true);
  } finally { config.safety = prevSafety; }
});

test("M1: re-entering the wallet lock throws instead of deadlocking", async () => {
  await assert.rejects(
    () => withWalletLock(async () => withWalletLock(async () => 1, 10, "inner"), 10, "outer"),
    /re-entered/,
  );
  assert.equal(await withWalletLock(async () => "still works", 0), "still works");
});

test("M1: a stale holder alerts; a hung holder is released after the hard timeout and the queue moves on", async () => {
  const alerts = [];
  lockMod.setWalletLockOptions({ warnMs: 20, hardMs: 80, onAlert: (a) => alerts.push(a) });
  try {
    let settle;
    const hung = withWalletLock(() => new Promise((r) => { settle = r; }), 10, "hung close");
    const next = withWalletLock(async () => "ran", 10, "next close"); // N1: only closes are admitted
    await assert.rejects(hung, /wallet lock timeout/);
    assert.equal(await next, "ran");
    assert.deepEqual([...new Set(alerts.map((a) => a.kind))].sort(), ["abandoned", "stale", "tainted"]);
    settle(); // let the abandoned op settle so the lock is no longer tainted
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    lockMod.setWalletLockOptions({ warnMs: 300_000, hardMs: 900_000, onAlert: null });
  }
});

test("M2: a close queued behind a held wallet lock does not starve other positions of their ticks", async () => {
  const a = open();
  const b = open();
  state.registerExitTick(a, { kind: "stop_loss", outcome: "confirm", reason: "STOP_LOSS: seed", config }); // A is one tick from firing
  let release;
  const gate = new Promise((r) => { release = r; });
  const held = withWalletLock(() => gate, 0, "long deploy");
  const closes = [];
  pnlWatcher._setPnlWatcherDepsForTest({
    getMyPositions: async () => ({ positions: [apiPos(a, -30), apiPos(b, -30)] }),
    getOnchainPnl: async () => oc(-30),
    closePosition: async (args) => { closes.push(args.position_address); state.recordClose(args.position_address, args._close_reason); return { success: true, txs: [] }; },
    getPositionBins: async () => null, emit: () => {}, isCloseInflight: () => false, postClose: async () => {},
  });
  const tick = pnlWatcher.runPnlWatcher();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(state.getExitStreak(b)?.confirms, 1, "B was evaluated while A's close is still waiting for the lock");
  assert.equal(closes.length, 0);
  release();
  await held;
  await tick;
  assert.deepEqual(closes, [a]);
  pnlWatcher._setPnlWatcherDepsForTest(null);
});

test("M3: closeForExit runs the postClose parity hook (actions log / USDC settle / signal capture) after a successful close, and its failure does not fail the close", async () => {
  const p = open();
  const res = { reason: "STOP_LOSS: x", onchainPct: null, onchain: null };
  const calls = [];
  const base = { closePosition: async (args) => { state.recordClose(args.position_address, args._close_reason); return { success: true }; }, getTracked: state.getTrackedPosition, isCloseInflight: () => false, recordAutoClose: state.recordAutoClose, emit: () => {}, log: quiet };
  const r = await engine.closeForExit(apiPos(p, -20), res, { ...base, postClose: async (args) => { calls.push(args.position_address); } });
  assert.equal(r.closed, true);
  assert.deepEqual(calls, [p]);
  const q = open();
  const r2 = await engine.closeForExit(apiPos(q, -20), res, { ...base, postClose: async () => { throw new Error("settle blew up"); } });
  assert.equal(r2.closed, true);
  const w = fs.readFileSync(new URL("../pnl-watcher.js", import.meta.url), "utf8");
  const ix = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(w, /postClose: dep\("postClose", finalizeCodeClose\)/);
  assert.match(ix, /postClose: finalizeCodeClose/);
  assert.equal(typeof executor.finalizeCodeClose, "function");
});

test("M3: management rule 3 close passes through the same postClose hook", async () => {
  const p = open();
  const h = mgmtHarness({ onchain: oc(8) });
  const seen = [];
  h.deps.closeDeps.postClose = async (args) => { seen.push(args._close_reason); };
  await runManagementCodeRules([apiPos(p, 8)], h.deps);
  const out = await runManagementCodeRules([apiPos(p, 8)], h.deps);
  assert.equal(out.closed.length, 1);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /rule 3/);
});

test("L5: a throwing close does not abort the management cycle for later positions", async () => {
  const a = open();
  const b = open({ ageMin: 60 });
  const h = mgmtHarness({ onchain: oc(8) });
  h.deps.closeDeps.closePosition = async (args) => { if (args.position_address === a) throw new Error("rpc exploded"); state.recordClose(args.position_address, args._close_reason); return { success: true }; };
  await runManagementCodeRules([apiPos(a, 8), apiPos(b, 8)], h.deps);
  const out = await runManagementCodeRules([apiPos(a, 8), apiPos(b, 8)], h.deps);
  assert.equal(out.failed.length, 1);
  assert.equal(out.closed.length, 1, "B still closed");
});

test("M4: mismatch tolerance is configurable; API-vs-on-chain bias is measured; a trailing exit held only by mismatch alerts", async () => {
  engine._resetBiasForTest();
  const base = { kind: "trailing", apiPct: 7, onchainPct: 4.5, peakPct: 10, dropPct: 4 };
  assert.equal(decidePnlExit(base).close, false, "default 2pt: 2.5pt disagreement holds");
  assert.equal(decidePnlExit({ ...base, mismatchPts: 3 }).close, true, "3pt tolerance closes");
  for (let i = 0; i < 20; i++) engine.recordPnlBias(5, 5 + (i % 4), quiet);
  const s = engine.getPnlBiasStats();
  assert.equal(s.n, 20);
  assert.ok(s.max >= 3 && s.median >= 1);

  const p = open();
  state.updatePnlAndCheckExits(p, 10, config, { onchainPct: 10, strict: true });
  state.updatePnlAndCheckExits(p, 10, config, { onchainPct: 10, strict: true });
  assert.equal(state.getTrackedPosition(p).trailing_active, true);
  const events = [];
  const deps = { ...engineDeps(oc(3.0)), config: { ...config, exits: { ...config.exits, trailingMismatchAlertTicks: 3 } }, emit: (ev, d) => events.push([ev, d]) };
  for (let i = 0; i < 3; i++) {
    const r = await engine.evaluatePnlExit(apiPos(p, 6.0), deps);
    assert.equal(r.action === "close", false);
  }
  assert.equal(events.filter(([e]) => e === "ops_alert").length, 1, "alert after 3 consecutive mismatch-held ticks, not silent");
  assert.match(events[0][1].text, /trailing take profit is being HELD/);
});

test("M5: the API-only stop-loss fallback needs >= 3 priced observations as well as the wait", () => {
  const p = open();
  const t0 = Date.now();
  state.registerExitTick(p, { kind: "stop_loss", outcome: "unverified", config, now: t0 });
  assert.equal(state.registerExitTick(p, { kind: "stop_loss", outcome: "unverified", config, now: t0 + 500_000 }).fireOnApi, false, "only 2 observations");
  assert.equal(state.registerExitTick(p, { kind: "stop_loss", outcome: "unverified", config, now: t0 + 510_000 }).fireOnApi, true);
  const cfg = fs.readFileSync(new URL("../config.js", import.meta.url), "utf8");
  assert.match(cfg, /stopLossUnverifiedMaxWaitSec: u\.stopLossUnverifiedMaxWaitSec \?\? 300/);
});

test("L1: cooldown kinds come from structured close-reason prefixes only, not free text", () => {
  assert.equal(state.cooldownKindForReason("rule 1: instruction met — close when stop loss hits"), null);
  assert.equal(state.cooldownKindForReason("agent decision: avoiding a stop loss, emergency stop soon"), null);
  assert.equal(state.cooldownKindForReason("something about OOR timeout"), null);
  assert.equal(state.cooldownKindForReason("STOP_LOSS: PnL -16%"), "stop_loss");
  assert.equal(state.cooldownKindForReason("rule 4: OOR timeout (31m ≥ 30m)"), "oor");
});

test("L2: the watcher takes a fresh timestamp per position", () => {
  const w = fs.readFileSync(new URL("../pnl-watcher.js", import.meta.url), "utf8");
  assert.match(w, /const now = nowFn\(\); \/\/ L2/);
});

// ═══ Opus 5.5 review fixes ═══
const walletLockMod = await import(new URL("../wallet-lock.js", import.meta.url));
const nodeCron = (await import("node-cron")).default;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

test("C1: a setInterval created inside a locked op can take the lock after the op returns", async () => {
  let handle;
  const fired = new Promise((resolve) => {
    withWalletLock(async () => {
      handle = setInterval(() => {
        withWalletLock(async () => "ok", 10, "timer close").then(resolve, resolve);
      }, 15);
    }, 0, "deploy_position");
  });
  const r = await fired;
  clearInterval(handle);
  assert.equal(r, "ok", String(r?.message || r));
});

test("C1: a node-cron job created inside a locked op can take the lock after the op returns", async () => {
  let task;
  const fired = new Promise((resolve) => {
    withWalletLock(async () => {
      task = nodeCron.schedule("* * * * * *", () => {
        withWalletLock(async () => "ok", 10, "cron close").then(resolve, resolve);
      });
    }, 0, "deploy_position");
  });
  const r = await Promise.race([fired, sleepMs(3000).then(() => "timeout")]);
  task.stop();
  assert.equal(r, "ok", String(r?.message || r));
});

test("C1: re-entry from a genuinely running holder still throws", async () => {
  await assert.rejects(withWalletLock(async () => withWalletLock(async () => 1, 10, "inner"), 0, "outer"), /re-entered/);
});

test("C1: outsideWalletLock runs timers in a clean context", async () => {
  let handle;
  const fired = new Promise((resolve) => {
    withWalletLock(async () => {
      walletLockMod.outsideWalletLock(() => {
        handle = setInterval(() => withWalletLock(async () => "ok", 10, "t").then(resolve, resolve), 10);
      });
      // while the holder is still running, a timer from outside the context queues instead of throwing
      await sleepMs(40);
    }, 0, "deploy_position");
  });
  const r = await fired;
  clearInterval(handle);
  assert.equal(r, "ok");
});

test("C1: a deploy whose update_config restarts cron does not block later closes", async () => {
  // Same shape as executor.js: update_config → outsideWalletLock(restarter) inside the locked deploy.
  let handle;
  const restarter = () => { handle = setInterval(() => {}, 1000); handle.unref?.(); };
  let closeResult;
  const closeFromTimer = new Promise((resolve) => {
    withWalletLock(async () => {
      walletLockMod.outsideWalletLock(() => {
        clearInterval(handle);
        handle = setInterval(() => withWalletLock(async () => "closed", 10, "close").then(resolve, resolve), 10);
        handle.unref?.();
      });
      void restarter;
    }, 0, "deploy_position");
  });
  closeResult = await closeFromTimer;
  clearInterval(handle);
  assert.equal(closeResult, "closed");
});

test("N1: after the hard release only closes are admitted until the abandoned op settles", async () => {
  walletLockMod.setWalletLockOptions({ warnMs: 0, hardMs: 40, onAlert: (a) => alerts.push(a) });
  const alerts = [];
  let release;
  const hung = new Promise((r) => { release = r; });
  const deploy = withWalletLock(() => hung, 0, "deploy_position");
  await assert.rejects(deploy, /wallet lock timeout/);
  assert.equal(walletLockMod.isWalletLockTainted(), true);
  assert.ok(alerts.some((a) => a.kind === "tainted"), "tainted alert raised");
  await assert.rejects(withWalletLock(async () => 1, 0, "deploy_position"), /tainted/);
  await assert.rejects(withWalletLock(async () => 1, 5, "claim_fees"), /tainted/);
  assert.equal(await withWalletLock(async () => "closed", 10, "close"), "closed");
  release();
  await sleepMs(10);
  assert.equal(walletLockMod.isWalletLockTainted(), false);
  assert.equal(await withWalletLock(async () => "deployed", 0, "deploy_position"), "deployed");
  walletLockMod.setWalletLockOptions({ warnMs: 5 * 60_000, hardMs: 15 * 60_000, onAlert: null });
});

test("N2: pool detail fetch is bounded and fails closed", async () => {
  const exec = await import(new URL("../tools/executor.js", import.meta.url));
  const t0 = Date.now();
  const hang = await exec.checkDeployEligibility({ pool_address: POOL, bin_step: 100 }, { getPoolDetailFn: () => new Promise(() => {}), getPositionsFn: async () => ({ total_positions: 0, positions: [] }) });
  assert.equal(hang.pass, false);
  assert.match(hang.reason, /fail closed/);
  assert.ok(Date.now() - t0 < exec.POOL_DETAIL_TIMEOUT_MS + 2000);
  const thrown = await exec.checkDeployEligibility({ pool_address: POOL, bin_step: 100 }, { getPoolDetailFn: async () => { throw new Error("boom"); }, getPositionsFn: async () => ({ total_positions: 0, positions: [] }) });
  assert.equal(thrown.pass, false);
}, { timeout: 20000 });

test("N3: forced on-chain read is stamped per source; a management read does not delay the watcher's", async () => {
  const now = Date.now();
  const tracked = { last_onchain_by: { management: new Date(now - 30_000).toISOString() }, last_onchain_at: new Date(now - 30_000).toISOString() };
  const mg = { stopLossPct: -15, emergencyPriceDropPct: -50, takeProfitFeePct: 7 };
  assert.equal(engine.needsOnchain(-5, tracked, mg, { now, intervalMs: 60_000, source: "management" }), false);
  assert.equal(engine.needsOnchain(-5, tracked, mg, { now, intervalMs: 60_000, source: "watcher" }), true, "watcher has its own stamp");
  const p = open();
  state.markOnchainRead(p, now, "watcher");
  const t = state.getTrackedPosition(p);
  assert.ok(t.last_onchain_by.watcher);
  assert.equal(t.last_onchain_by.management, undefined);
});

test("N4: API-only SL fallback waits 120s when every tick is at/below the emergency level, 300s otherwise", () => {
  const cfg = { ...config, exits: { ...config.exits, stopLossUnverifiedMaxWaitSec: 300, stopLossEmergencyMaxWaitSec: 120, confirmMinSpacingSec: 0, confirmTicks: 2 } };
  const run = (emergency) => {
    const p = open();
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) state.registerExitTick(p, { kind: "stop_loss", outcome: "unverified", reason: "x", config: cfg, now: t0 + i * 1000, emergency });
    return state.registerExitTick(p, { kind: "stop_loss", outcome: "unverified", reason: "x", config: cfg, now: t0 + 130_000, emergency });
  };
  assert.equal(run(true).fireOnApi, true, "emergency: fires after >120s");
  assert.equal(run(false).fireOnApi, false, "normal: still waiting at 130s");
  // a mixed streak (one non-emergency tick) uses the normal wait
  const p = open();
  const t0 = Date.now();
  const cfg2 = cfg;
  state.registerExitTick(p, { kind: "stop_loss", outcome: "unverified", config: cfg2, now: t0, emergency: false });
  state.registerExitTick(p, { kind: "stop_loss", outcome: "unverified", config: cfg2, now: t0 + 1000, emergency: true });
  state.registerExitTick(p, { kind: "stop_loss", outcome: "unverified", config: cfg2, now: t0 + 2000, emergency: true });
  assert.equal(state.registerExitTick(p, { kind: "stop_loss", outcome: "unverified", config: cfg2, now: t0 + 130_000, emergency: true }).fireOnApi, false);
});

test("L3: pnlExitsWarning flags positions without state or without a recorded deposit", () => {
  assert.match(engine.pnlExitsWarning({}, null), /OFF/);
  assert.match(engine.pnlExitsWarning({}, { amount_sol: 0 }), /degraded/);
  assert.equal(engine.pnlExitsWarning({}, { amount_sol: 5 }), null);
});
