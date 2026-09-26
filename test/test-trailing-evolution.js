/**
 * Evolution tunes the trailing take profit — trailingTriggerPct and
 * trailingDropPct — and nothing else on the exit side (takeProfitFeePct and
 * stopLossPct are the operator's). Also: the close record carries the peak,
 * the update_config bounds match the evolution ranges, and the Telegram alert
 * calls a trailing exit a trailing stop.
 *
 * Evidence behind the rules (2026-09-26):
 *   P(DOOM)-SOL peaked +5.11% (trigger 5 armed), trail level 1.11% with drop 4,
 *   exited −1.23% on-chain.  AMERICA-SOL peaked +2.67%, trigger 5 never armed,
 *   closed −3.76%.
 *
 * state.js / lessons.js use cwd-relative files: chdir to a temp dir first.
 */
process.env.DRY_RUN = "true";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-trailing-evo-"));
process.chdir(TMP);
// Evolution writes user-config.json: point config.js (and lessons.js) at a scratch copy.
const USER_CONFIG = path.join(TMP, "user-config.json");
process.env.MERIDIAN_USER_CONFIG_PATH = USER_CONFIG;
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const lessons = await import("../lessons.js");
const { config, reloadScreeningThresholds } = await import("../config.js");
const state = await import("../state.js");
const { RISK_CONFIG_BOUNDS, validateConfigUpdate } = await import("../tools/executor.js");
const { pnlExitTitle } = await import("../telegram-ui.js");

const cfg = (over = {}) => ({
  screening: {},
  management: { trailingTakeProfit: true, trailingTriggerPct: 5, trailingDropPct: 4, takeProfitFeePct: 15, stopLossPct: -40, ...over },
  strategy: {},
});

// A close record as dlmm.js writes it (trailingAtClose fields), under trigger 5 / drop 4.
let n = 0;
const rec = (pnl_pct, peak_pnl_pct, extra = {}) => ({
  position: `p${++n}`, pool: `pool${n}`, pnl_pct, peak_pnl_pct,
  trailing_trigger_pct: 5, trailing_drop_pct: 4, trailing_armed_pct: null, trailing_exit: false,
  in_range_at_close: true, fees_earned_usd: 1, close_reason: "agent decision", ...extra,
});
const trailExit = (pnl_pct, peak, armed = 5, extra = {}) =>
  rec(pnl_pct, peak, { trailing_exit: true, trailing_armed_pct: armed, close_reason: `TRAILING_TP: PnL dropped ${(peak - pnl_pct).toFixed(1)}% from peak`, ...extra });

// Five non-winners, two of them (40%) peaked in [2.5, 5): the AMERICA shape.
const americaSet = () => [
  rec(-3.76, 2.67),  // AMERICA: peaked +2.67%, never armed, closed −3.76%
  rec(-2.1, 3.4),    // same shape
  rec(-5, 0.4),      // never got close
  rec(0.3, 0.8),     // break-even, never close
  rec(-1.5, 0.2),
  rec(4, 6.5),       // a winner (not counted)
];
// P(DOOM)-like trailing exits: armed ≈ +5.1%, exited below 0 (median −0.5%).
const doomExits = () => [
  trailExit(-1.23, 5.11, 5.11), // P(DOOM): trail level 1.11 with drop 4, exited −1.23% on-chain
  trailExit(-0.8, 5.2, 5.2),
  trailExit(-0.5, 5.3, 5.1),
  trailExit(0.4, 5.4, 5.2),
  trailExit(1.1, 5.6, 5.3),
];
// Trailing exits cut early: above +2%, in range, earning fees.
const earlyExits = () => [trailExit(3.5, 7.5, 5.2), trailExit(3, 7, 5.5), trailExit(4, 8, 6.5), trailExit(3.2, 7.2, 5.3), trailExit(3.8, 7.8, 5.4)];
const twitchyExits = () => [
  trailExit(4.6, 5.3, 5.1, { in_range_at_close: false }),
  trailExit(4.4, 5.2, 5.0, { in_range_at_close: false }),
  trailExit(5.5, 6.0, 5.2, { in_range_at_close: false }),
  trailExit(4.9, 5.5, 5.1, { in_range_at_close: false }),
  trailExit(5.0, 5.8, 5.4, { in_range_at_close: false }),
];

test("every trailing rule needs MIN_RULE_SAMPLES (5)", () => {
  assert.equal(lessons.MIN_RULE_SAMPLES, 5);
});

// ─── Trigger ───
test("trigger: lowered when ≥40% of ≥5 non-winners peaked in [0.5×trigger, trigger) — the AMERICA case", () => {
  const r = lessons.evolveTrailing(americaSet(), cfg());
  assert.equal(r.changes.trailingTriggerPct, 4.5, "one 0.5 step");
  assert.match(r.rationale.trailingTriggerPct, /2\/5 non-winning closes peaked between 2\.5% and the 5% trigger/);
  assert.equal("trailingDropPct" in r.changes, false);
  // Four non-winners are not enough, however many winners there are.
  const four = [...americaSet().filter((p) => p.pnl_pct !== -1.5), rec(4, 6), rec(5, 7), rec(3, 5.5)];
  assert.equal(lessons.evolveTrailing(four, cfg()), null);
});

test("trigger: only closes under the CURRENT trigger (since it last changed) count", () => {
  const perf = americaSet();
  perf[4] = { ...perf[4], trailing_trigger_pct: 6 }; // ran under the previous trigger
  assert.equal(lessons.evolveTrailing(perf, cfg()), null);
});

test("trigger: only closes with a known peak count; excluded records don't", () => {
  const noPeak = (pnl) => { const r = rec(pnl, 0); delete r.peak_pnl_pct; return r; };
  assert.equal(lessons.evolveTrailing([rec(-3.76, 2.67), rec(-2.1, 3.4), rec(-5, 0.4), noPeak(-2), noPeak(-3), noPeak(-4)], cfg()), null);
  const excluded = [rec(-3.76, 2.67), rec(-2.1, 3.4), rec(-5, 0.4), rec(-2, 3, { corrected: "x" }), rec(-2, 3, { exclude_from_learning: "bad" }), rec(-3, 3, { corrupt: true })];
  assert.equal(lessons.evolveTrailing(excluded, cfg()), null);
});

test("trigger: raised when most of ≥5 trailing exits close within 1pt of where trailing armed", () => {
  const r = lessons.evolveTrailing(twitchyExits(), cfg({ trailingDropPct: 1 }));
  assert.equal(r.changes.trailingTriggerPct, 5.5);
  assert.match(r.rationale.trailingTriggerPct, /5\/5 trailing exits closed within 1pt/);
  // Four exits aren't enough.
  assert.equal(lessons.evolveTrailing([...twitchyExits().slice(1), rec(6, 7), rec(3, 4)], cfg({ trailingDropPct: 1 }))?.changes?.trailingTriggerPct, undefined);
  // Not raised onto the fixed take profit.
  assert.equal(lessons.evolveTrailing(twitchyExits(), cfg({ trailingDropPct: 1, takeProfitFeePct: 5.5 }))?.changes?.trailingTriggerPct, undefined);
});

test("trigger: bounded 1.5–15; conflicting lower + raise evidence cancels", () => {
  const unprotected = (t) => [rec(-3, 0.6 * t), rec(-2, 0.7 * t), rec(-4, 0.8 * t), rec(-1.5, 0.9 * t), rec(-2, 0.55 * t)].map((r) => ({ ...r, trailing_trigger_pct: t }));
  assert.equal(lessons.evolveTrailing(unprotected(1.5), cfg({ trailingTriggerPct: 1.5, trailingDropPct: 1 })), null, "floor 1.5");
  const atCeiling = twitchyExits().map((e) => ({ ...e, pnl_pct: e.pnl_pct + 10, peak_pnl_pct: e.peak_pnl_pct + 10, trailing_armed_pct: e.trailing_armed_pct + 10, trailing_trigger_pct: 15 }));
  assert.equal(lessons.evolveTrailing(atCeiling, cfg({ trailingTriggerPct: 15, trailingDropPct: 1, takeProfitFeePct: 50 }))?.changes?.trailingTriggerPct, undefined, "ceiling 15");
  assert.equal(lessons.evolveTrailing([...unprotected(5), ...twitchyExits()], cfg({ trailingDropPct: 1 }))?.changes?.trailingTriggerPct, undefined);
});

// ─── Drop ───
test("drop: tightened when ≥5 trailing exits give back more than the peak — the P(DOOM) case", () => {
  const r = lessons.evolveTrailing(doomExits(), cfg());
  assert.equal(r.changes.trailingDropPct, 3.5);
  assert.match(r.rationale.trailingDropPct, /5 trailing exit\(s\): median exit -0\.50%/);
  // P(DOOM) alone (or four such exits) no longer moves it.
  assert.equal(lessons.evolveTrailing([doomExits()[0], rec(3, 4), rec(-2, 1), rec(0.5, 1), rec(2, 3)], cfg())?.changes?.trailingDropPct, undefined);
  assert.equal(lessons.evolveTrailing([...doomExits().slice(0, 4), rec(3, 4)], cfg())?.changes?.trailingDropPct, undefined);
});

test("drop: tightened when the median give-back of ≥5 trailing exits ≥ drop + 2", () => {
  const perf = [trailExit(5, 12, 5), trailExit(4, 11, 5), trailExit(6, 11.5, 5), trailExit(5.5, 12.5, 5), trailExit(4.5, 11, 5)];
  const r = lessons.evolveTrailing(perf, cfg());
  assert.equal(r.changes.trailingDropPct, 3.5);
  assert.match(r.rationale.trailingDropPct, /median give-back 7\.00pt/);
});

test("drop: widened when ≥60% of ≥5 trailing exits closed above +2% in range and earning fees", () => {
  // Closes ran under drop 4 (relevant) but trigger 5, not the current 6: only the drop moves.
  const r = lessons.evolveTrailing(earlyExits(), cfg({ trailingTriggerPct: 6 }));
  assert.equal(r.changes.trailingDropPct, 4.5);
  assert.equal("trailingTriggerPct" in r.changes, false);
  // Out of range or no fees → not "cut early".
  assert.equal(lessons.evolveTrailing(earlyExits().map((e) => ({ ...e, in_range_at_close: false })), cfg({ trailingTriggerPct: 6 }))?.changes?.trailingDropPct, undefined);
  assert.equal(lessons.evolveTrailing(earlyExits().map((e) => ({ ...e, fees_earned_usd: 0 })), cfg({ trailingTriggerPct: 6 }))?.changes?.trailingDropPct, undefined);
  // Four exits aren't enough.
  assert.equal(lessons.evolveTrailing([...earlyExits().slice(1), rec(1.5, 2), rec(-2, 1)], cfg({ trailingTriggerPct: 6 }))?.changes?.trailingDropPct, undefined);
});

test("drop: bounded 1–8, and never widened past trigger − 0.5", () => {
  const atFloor = doomExits().map((r) => ({ ...r, trailing_drop_pct: 1 }));
  assert.equal(lessons.evolveTrailing(atFloor, cfg({ trailingDropPct: 1 }))?.changes?.trailingDropPct, undefined, "floor 1");
  const early45 = earlyExits().map((r) => ({ ...r, trailing_drop_pct: 4.5 }));
  // trigger 5, drop 4.5 → widening to 5 would leave trigger − drop = 0
  assert.equal(lessons.evolveTrailing(early45, cfg({ trailingDropPct: 4.5 }))?.changes?.trailingDropPct, undefined);
  const ceil = earlyExits().map((r) => ({ ...r, trailing_drop_pct: 8 }));
  assert.equal(lessons.evolveTrailing(ceil, cfg({ trailingTriggerPct: 12, trailingDropPct: 8 }))?.changes?.trailingDropPct, undefined, "ceiling 8");
});

test("trigger − drop ≥ 0.5: lowering the trigger stops at drop + 0.5 unless the drop tightens too", () => {
  const unprot = [rec(-3, 2.5), rec(-2, 3), rec(-4, 4), rec(-1.5, 4.2), rec(-2, 2.3)].map((r) => ({ ...r, trailing_trigger_pct: 4.5 }));
  assert.equal(lessons.evolveTrailing(unprot, cfg({ trailingTriggerPct: 4.5 }))?.changes?.trailingTriggerPct, undefined, "4.5 − 4 = 0.5 already");
  // Same, with five trailing exits that gave back more than their peak → drop tightens to 3.5, trigger can go to 4.
  const withDoom = [...unprot, ...doomExits().map((e) => ({ ...e, trailing_trigger_pct: 4.5 }))];
  const r = lessons.evolveTrailing(withDoom, cfg({ trailingTriggerPct: 4.5 }));
  assert.deepEqual(r.changes, { trailingTriggerPct: 4, trailingDropPct: 3.5 });
});

test("trailing evolution is off when trailing TP is off", () => {
  assert.equal(lessons.evolveTrailing(americaSet(), cfg({ trailingTakeProfit: false })), null);
});

test("computeThresholdChanges carries the trailing changes and never takeProfitFeePct / stopLossPct", () => {
  const r = lessons.computeThresholdChanges(americaSet(), cfg());
  assert.equal(r.changes.trailingTriggerPct, 4.5);
  assert.equal("takeProfitFeePct" in r.changes, false);
  assert.equal("stopLossPct" in r.changes, false);
});

test("evolveThresholds persists the trailing change, applies it live, and a reload keeps it", () => {
  const prev = { ...config.management };
  try {
    Object.assign(config.management, { trailingTakeProfit: true, trailingTriggerPct: 5, trailingDropPct: 4 });
    const r = lessons.evolveThresholds(americaSet(), config, { userConfig: {}, lessonsData: { lessons: [], performance: [] } });
    assert.equal(r.changes.trailingTriggerPct, 4.5);
    assert.equal(config.management.trailingTriggerPct, 4.5, "live config updated");
    assert.equal(JSON.parse(fs.readFileSync(USER_CONFIG, "utf8")).trailingTriggerPct, 4.5, "persisted to user-config.json");
    config.management.trailingTriggerPct = 5;
    reloadScreeningThresholds();
    assert.equal(config.management.trailingTriggerPct, 4.5, "reloadScreeningThresholds picks up the evolved value");
  } finally {
    Object.assign(config.management, prev);
    if (fs.existsSync(USER_CONFIG)) fs.rmSync(USER_CONFIG);
  }
});

// ─── Close record ───
test("state: the close record carries peak, arm level, trailing settings, exit flag and in-range", () => {
  const position = "TrailPos111111111111111111111111111111111111";
  state.trackPosition({ position, pool: "pool", pool_name: "PDOOM-SOL", amount_sol: 1, initial_value_usd: 120, deployed_at: new Date(Date.now() - 60 * 60_000).toISOString() });
  const c = { management: { stopLossPct: -40, trailingTakeProfit: true, trailingTriggerPct: 5, trailingDropPct: 4, pnlWarmupMinutes: 15, pnlWarmupMaxAbsPct: 25 } };
  assert.equal(state.updatePnlAndCheckExits(position, 2, c), null);
  assert.equal(state.updatePnlAndCheckExits(position, 5.11, c), null);
  const action = state.updatePnlAndCheckExits(position, 1.0, c);
  assert.match(action, /^TRAILING_TP/);
  const pos = state.getTrackedPosition(position);
  const out = state.trailingAtClose(pos, action, c.management);
  assert.deepEqual(out, {
    peak_pnl_pct: 5.11, trailing_armed_pct: 5.11, trailing_exit: true,
    trailing_trigger_pct: 5, trailing_drop_pct: 4, in_range_at_close: true,
  });
  // Never armed; out of range; falls back to the config for trigger/drop.
  const never = state.trailingAtClose({ peak_pnl_pct: 2.67, trailing_active: false, out_of_range_since: "t" }, "agent decision", c.management);
  assert.deepEqual(never, { peak_pnl_pct: 2.67, trailing_armed_pct: null, trailing_exit: false, trailing_trigger_pct: 5, trailing_drop_pct: 4, in_range_at_close: false });
  assert.equal("peak_pnl_pct" in state.trailingAtClose({ trailing_active: false }, ""), false, "unknown peak is omitted, not 0");
});

// ─── update_config bounds ───
test("update_config bounds for the trailing settings match evolution: trigger 1.5–15, drop 1–8", () => {
  assert.deepEqual([RISK_CONFIG_BOUNDS.trailingTriggerPct.min, RISK_CONFIG_BOUNDS.trailingTriggerPct.max], [lessons.TRAILING_TRIGGER_BOUNDS.min, lessons.TRAILING_TRIGGER_BOUNDS.max]);
  assert.deepEqual([RISK_CONFIG_BOUNDS.trailingDropPct.min, RISK_CONFIG_BOUNDS.trailingDropPct.max], [lessons.TRAILING_DROP_BOUNDS.min, lessons.TRAILING_DROP_BOUNDS.max]);
  const ok = (changes) => validateConfigUpdate({ changes }).pass;
  assert.equal(ok({ trailingTriggerPct: 1.5 }), true);
  assert.equal(ok({ trailingTriggerPct: 15 }), true);
  assert.equal(ok({ trailingTriggerPct: 1 }), false);
  assert.equal(ok({ trailingTriggerPct: 20 }), false);
  assert.equal(ok({ trailingDropPct: 1 }), true);
  assert.equal(ok({ trailingDropPct: 8 }), true);
  assert.equal(ok({ trailingDropPct: 0.5 }), false);
  assert.equal(ok({ trailingDropPct: 10 }), false);
  assert.match(validateConfigUpdate({ setting: "management.trailingDropPct", value: 12 }).reason, /\[1, 8\]/);
  // The AI's own TP / SL levers are unchanged.
  assert.equal(ok({ takeProfitFeePct: 30 }), true);
  assert.equal(ok({ stopLossPct: -25 }), true);
});

// ─── Alert title ───
test("alert: a TRAILING_TP exit is a 'Trailing stop' with ✅ / 🔻 by the PnL sign; other exits unchanged", () => {
  const reason = "TRAILING_TP: PnL dropped 6.3% from peak 5.1% (trail: 4%)";
  assert.equal(pnlExitTitle({ reason, pnlPct: -1.23 }), "🔻 <b>Trailing stop — auto-closed</b>");
  assert.equal(pnlExitTitle({ reason, pnlPct: 3.2 }), "✅ <b>Trailing stop — auto-closed</b>");
  assert.equal(pnlExitTitle({ reason, pnlPct: null }), "⚡ <b>Trailing stop — auto-closed</b>");
  assert.doesNotMatch(pnlExitTitle({ reason, pnlPct: -1.23 }), /Take-profit/);
  assert.equal(pnlExitTitle({ reason: "STOP_LOSS: PnL -15%", pnlPct: -15 }), "⚡ <b>Stop-loss hit — auto-closed</b>");
  assert.equal(pnlExitTitle({ reason: "FIXED_TP: PnL 7.4% >= take profit (7%)", pnlPct: 7.4 }), "⚡ <b>Take-profit hit — auto-closed</b>");
  assert.equal(pnlExitTitle({ reason: "something else" }), "⚡ <b>Exit hit — auto-closed</b>");
});
