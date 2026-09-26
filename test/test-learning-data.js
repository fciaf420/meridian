/**
 * What the learning systems learn from (learning-data.js): the shared
 * win/loss classifier (> +1% win, < −1% loss, break-even ignored), the
 * known-bad / corrected record exclusions, and every consumer — threshold
 * evolution, lesson derivation, the prompt lessons, pool memory, Darwinian
 * signal weights, the KB close label — plus the one-off data-fix script.
 *
 * Every file the modules touch lives in a scratch dir (cwd, and
 * MERIDIAN_USER_CONFIG_PATH for user-config.json).
 */
process.env.DRY_RUN = "true";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-learning-data-"));
process.chdir(TMP);
process.env.MERIDIAN_USER_CONFIG_PATH = path.join(TMP, "user-config.json"); // never the checkout's
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ld = await import("../learning-data.js");
const { config } = await import("../config.js");
const lessons = await import("../lessons.js");
const poolMemory = await import("../pool-memory.js");
const weights = await import("../signal-weights.js");
const kb = await import("../knowledge-base.js");
const fixScript = await import("../scripts/fix-learning-data-2026-09-26.js");

const COLLECT = ld.KNOWN_BAD_RECORDS.find((b) => b.key === "COLLECT-false-stop-loss");
const recorded_at = new Date().toISOString();

// The COLLECT record as it sits in lessons.json.
const collectRecord = () => ({
  position: COLLECT.position, pool: COLLECT.pool, pool_name: "COLLECT-SOL", strategy: "bid_ask",
  pnl_pct: -66.44, pnl_usd: -85.89, initial_value_usd: 128.61, amount_sol: 1.1, volatility: 11.03,
  bin_step: 100, fee_tvl_ratio: 33.29, organic_score: 74, minutes_held: 6, range_efficiency: 10,
  close_reason: "agent decision", deployed_at: COLLECT.deployed_at, recorded_at: COLLECT.recorded_at,
});

// A close for the evolution fixtures.
let n = 0;
const close = (pnl_pct, extra = {}) => ({
  position: `pos${++n}`, pool: `pool${n}`, pool_name: `T${n}-SOL`, strategy: "bid_ask",
  pnl_pct, pnl_usd: pnl_pct, initial_value_usd: 100, volatility: 5, bin_step: 100, fee_tvl_ratio: 0.5,
  organic_score: 80, minutes_held: 30, range_efficiency: 50, close_reason: "agent decision", recorded_at,
  ...extra,
});
const mgmtCfg = (over = {}) => ({
  screening: { maxVolatility: 10, minFeeActiveTvlRatio: 0.05, minOrganic: 60, minBinStep: 80, maxBinStep: 125, athTopThresholdPct: 90 },
  management: { outOfRangeWaitMinutes: 12, stopLossPct: -40, takeProfitFeePct: 15, trailingTakeProfit: false, trailingTriggerPct: 5, trailingDropPct: 4, ...over },
  strategy: { rangeDepthMode: "fixed" },
});

// ─── classifyOutcome ───
test("classifyOutcome: > +1% win, < −1% loss, ±1% break-even, junk → null", () => {
  assert.equal(ld.classifyOutcome(1.01), "win");
  assert.equal(ld.classifyOutcome(1), "breakeven");
  assert.equal(ld.classifyOutcome(0.004), "breakeven", "a 0.00x% OOR close is not a win");
  assert.equal(ld.classifyOutcome(0), "breakeven");
  assert.equal(ld.classifyOutcome(-1), "breakeven");
  assert.equal(ld.classifyOutcome(-1.01), "loss");
  assert.equal(ld.classifyOutcome(-66.44), "loss");
  for (const junk of [null, undefined, NaN, "", "abc", Infinity]) assert.equal(ld.classifyOutcome(junk), null, String(junk));
  assert.equal(ld.classifyOutcome("2.5"), "win", "numeric strings are numbers");
});

test("classifyRecord: pnl_unknown placeholders are neither; falls back to actual_pnl_pct / usd÷initial", () => {
  assert.equal(ld.classifyRecord({ pnl_pct: 0, pnl_unknown: true }), null);
  assert.equal(ld.classifyRecord({ actual_pnl_pct: -3 }), "loss");
  assert.equal(ld.classifyRecord({ pnl_usd: 5, initial_value_usd: 100 }), "win");
  assert.equal(ld.classifyRecord({ pnl_usd: 5 }), null, "no pct, no initial value → unknown");
});

// ─── Exclusions ───
test("known-bad records: COLLECT −66%, the two May CUM tests, corrected and flagged records are excluded", () => {
  assert.match(ld.exclusionReason(collectRecord()), /false −66\.44% stop loss/);
  for (const key of ["CUM-test-1", "CUM-test-2"]) {
    const b = ld.KNOWN_BAD_RECORDS.find((r) => r.key === key);
    assert.ok(ld.isExcludedFromLearning({ position: b.position, pnl_pct: 0 }), key);
  }
  assert.match(ld.exclusionReason({ position: "x", corrected: "false TP 7.4%" }), /^corrected: false TP/);
  assert.equal(ld.exclusionReason({ position: "x", exclude_from_learning: true }), "excluded");
  assert.equal(ld.exclusionReason({ position: "x", corrupt: "bad api read" }), "bad api read");
  assert.equal(ld.isExcludedFromLearning({ position: "x", pool: COLLECT.pool, pnl_pct: -3 }), false, "same pool, other close");
  // pool-memory deploys carry no pool: matched by the pool key + deployed_at
  assert.ok(ld.isExcludedFromLearning({ deployed_at: COLLECT.deployed_at, pnl_pct: -66.44 }, COLLECT.pool));
  assert.equal(ld.isExcludedFromLearning({ deployed_at: COLLECT.deployed_at }, "otherPool"), false);
  assert.equal(ld.learnableRecords([collectRecord(), close(2)]).length, 1);
});

test("isExcludedLesson: the lesson derived from COLLECT (same pool, created_at = recorded_at) or a flagged one", () => {
  assert.ok(ld.isExcludedLesson({ pool: COLLECT.pool, created_at: COLLECT.recorded_at, rule: "FAILED: COLLECT-SOL …" }));
  assert.ok(ld.isExcludedLesson({ rule: "x", exclude_from_learning: "manual" }));
  assert.equal(ld.isExcludedLesson({ pool: COLLECT.pool, created_at: "2026-09-26T00:00:00.000Z" }), false);
  assert.equal(ld.isExcludedLesson({ rule: "manual lesson", outcome: "manual" }), false);
  assert.equal(ld.isExcludedLesson({ rule: "[CORRECTED — not a win] …", corrected: "false TP" }), false, "corrected lessons are warnings, kept");
});

// ─── Threshold evolution ───
const times = (k, fn) => Array.from({ length: k }, () => fn());

test("evolution: break-even OOR-upside closes no longer lengthen outOfRangeWaitMinutes (the 12 → 14 → 17 → 20 drift)", () => {
  const perf = [
    close(0.004, { close_reason: "agent decision (OOR upside)" }),
    close(0.01, { close_reason: "agent decision (OOR upside)" }),
    close(0.0, { close_reason: "agent decision (OOR upside)" }),
    close(0.2, { close_reason: "agent decision (OOR upside)" }),
    close(-0.4),
    close(0.5),
    collectRecord(), // the only "loser" the old tuner saw
  ];
  // Under the old rule (pnl > 0 = winner) the four OOR-upside closes above 0 were "winners".
  assert.equal(lessons.computeThresholdChanges(perf, mgmtCfg()), null, "no wins, no losses → no change");

  // The live case: two real upside-OOR wins are not enough any more…
  const upWin = () => close(3, { close_reason: "agent decision (OOR upside)" });
  assert.equal(lessons.computeThresholdChanges([...perf, ...times(2, upWin)], mgmtCfg())?.changes?.outOfRangeWaitMinutes, undefined);
  // …five are.
  assert.equal(lessons.computeThresholdChanges([...perf, ...times(5, upWin)], mgmtCfg()).changes.outOfRangeWaitMinutes, 14);
});

test("evolution: the known-bad COLLECT record is not a loser, and losers are < −1%", () => {
  const vol = (v, pnl) => close(pnl, { volatility: v });
  // Five losers at volatility ≤ 6 tighten maxVolatility; five COLLECT copies (excluded) must not.
  const onlyCollect = [...times(5, collectRecord), ...times(5, () => vol(4, 2))];
  assert.equal(lessons.computeThresholdChanges(onlyCollect, mgmtCfg())?.changes?.maxVolatility, undefined);
  // −0.5% closes are break-even, not losers; −3% closes are.
  const mild = [...times(5, () => vol(6, -0.5)), ...times(2, () => vol(3, 2))];
  assert.equal(lessons.computeThresholdChanges(mild, mgmtCfg())?.changes?.maxVolatility, undefined);
  const real = [...times(5, () => vol(6, -3)), ...times(2, () => vol(3, 2))];
  assert.ok(lessons.computeThresholdChanges(real, mgmtCfg()).changes.maxVolatility < 10);
});

test("evolution: every rule needs MIN_RULE_SAMPLES (5) of the wins/losses it relies on — 4 don't move it, 5 do", () => {
  assert.equal(lessons.MIN_RULE_SAMPLES, 5);
  const W = (extra = {}) => close(3, extra);   // a win
  const L = (extra = {}) => close(-3, extra);  // a loss
  // [setting, config overrides, build(nRelied) → perf]. Each rule is fed exactly the
  // side(s) it relies on; a two-sided rule gets 5 on one side and n on the other.
  const cases = [
    ["maxVolatility (losers → tighten)", "maxVolatility", {}, (n) => times(n, () => L({ volatility: 4 }))],
    ["maxVolatility (all winners → loosen)", "maxVolatility", {}, (n) => times(n, () => W({ volatility: 14 }))],
    ["minFeeActiveTvlRatio (winners' floor)", "minFeeActiveTvlRatio", {}, (n) => times(n, () => W({ fee_tvl_ratio: 1 }))],
    ["minFeeActiveTvlRatio (losers vs winners)", "minFeeActiveTvlRatio", { screening: { minFeeActiveTvlRatio: 0.5 } },
      (n) => [...times(5, () => L({ fee_tvl_ratio: 0.45 })), ...times(n, () => W({ fee_tvl_ratio: 0.55 }))]],
    ["minOrganic (losers vs winners)", "minOrganic", {}, (n) => [...times(n, () => L({ organic_score: 60 })), ...times(5, () => W({ organic_score: 90 }))]],
    ["minBinStep (losers vs winners)", "minBinStep", { screening: { minBinStep: 20 } }, (n) => [...times(5, () => L({ bin_step: 40 })), ...times(n, () => W({ bin_step: 100 }))]],
    ["maxBinStep (losers vs winners)", "maxBinStep", { screening: { maxBinStep: 250 } }, (n) => [...times(n, () => L({ bin_step: 200 })), ...times(5, () => W({ bin_step: 100 }))]],
    ["outOfRangeWaitMinutes (downside losers → shorten)", "outOfRangeWaitMinutes", {}, (n) => times(n, () => L({ close_reason: "agent decision (OOR downside)", minutes_held: 100 }))],
    ["outOfRangeWaitMinutes (upside winners → lengthen)", "outOfRangeWaitMinutes", {}, (n) => times(n, () => W({ close_reason: "agent decision (OOR upside)" }))],
    ["athTopThresholdPct (near-ATH losers → tighten)", "athTopThresholdPct", {}, (n) => times(n, () => L({ signal_snapshot: { ath_proximity: 95 } }))],
    ["athTopThresholdPct (near-ATH winners → loosen)", "athTopThresholdPct", {}, (n) => times(n, () => W({ signal_snapshot: { ath_proximity: 95 } }))],
  ];
  for (const [label, key, over, build] of cases) {
    const c = mgmtCfg();
    Object.assign(c.screening, over.screening || {});
    // Pad with break-evens so the 5-record evolution minimum is never what blocks the rule.
    const pad = times(5, () => close(0));
    assert.equal(lessons.computeThresholdChanges([...pad, ...build(4)], c)?.changes?.[key], undefined, `${label}: 4 samples must not move it`);
    assert.notEqual(lessons.computeThresholdChanges([...pad, ...build(5)], c)?.changes?.[key], undefined, `${label}: 5 samples move it`);
  }
});

test("evolveFromLessons: tag-count rules need MIN_RULE_SAMPLES (5) lessons — 4 don't move it, 5 do", () => {
  const lesson = (i, tags) => ({ id: i, rule: `FAILED ${i}`, tags, outcome: "bad" });
  const run = (k, tags) => {
    const c = mgmtCfg();
    c.screening.minVolume = 10000;
    // Pad to ≥5 lessons with unrelated tags so the function's own minimum isn't what blocks it.
    const ls = [...times(k, () => lesson(Math.random(), tags)), ...times(5, () => lesson(Math.random(), ["worked"]))];
    return lessons.evolveFromLessons(ls, c, { userConfig: {}, lessonsData: { lessons: [], performance: [] } }).changes;
  };
  assert.equal(run(4, ["volume_collapse"]).minVolume, undefined);
  assert.equal(run(5, ["volume_collapse"]).minVolume, 12000);
  assert.equal(run(4, ["failed", "volatility_4"]).maxVolatility, undefined);
  assert.equal(run(5, ["failed", "volatility_4"]).maxVolatility, 4.4);
});

test("evolution never touches takeProfitFeePct or stopLossPct (the operator's), even on data that used to move them", () => {
  // Old section 4: ≥3 losers well above the −40% stop → tighten. Old section 5: winners' p75 ≪ TP → lower TP.
  const perf = [...times(5, () => close(-3)), ...times(5, () => close(2.5))];
  const res = lessons.computeThresholdChanges(perf, mgmtCfg());
  assert.ok(res, "there is signal");
  assert.equal("stopLossPct" in res.changes, false);
  assert.equal("takeProfitFeePct" in res.changes, false);

  // evolveFromLessons: downside-OOR lessons used to tighten the stop loss.
  const oorLessons = Array.from({ length: 6 }, (_, i) => ({ id: i, rule: `AVOID ${i}`, tags: ["oor", "downside", "bid_ask"], outcome: "bad" }));
  const lr = lessons.evolveFromLessons(oorLessons, mgmtCfg());
  assert.deepEqual(lr.changes, {});
});

// ─── Lesson derivation + pool memory (recordPerformance) ───
test("recordPerformance: break-even never becomes WORKED/PREFER; a clear win does; COLLECT teaches nothing", async () => {
  const prevKb = config.knowledgeBase;
  config.knowledgeBase = { ...prevKb, enabled: false };
  try {
    fs.writeFileSync("lessons.json", JSON.stringify({ lessons: [], performance: [] }));
    fs.writeFileSync("pool-memory.json", "{}");
    const base = { pool_name: "BE-SOL", strategy: "bid_ask", bin_step: 100, volatility: 5, fee_tvl_ratio: 0.4, organic_score: 80, amount_sol: 1, initial_value_usd: 100, final_value_usd: 100, fees_earned_usd: 0, minutes_held: 60, minutes_in_range: 60, close_reason: "agent decision (OOR upside)" };
    await lessons.recordPerformance({ ...base, position: "be1", pool: "poolBE", actual_pnl_pct: 0.004, actual_pnl_usd: 0.004 });
    await lessons.recordPerformance({ ...base, position: "be2", pool: "poolBE", actual_pnl_pct: 0.9, actual_pnl_usd: 0.9 });
    let data = JSON.parse(fs.readFileSync("lessons.json", "utf8"));
    assert.equal(data.lessons.length, 0, "break-even closes derive no lesson");

    await lessons.recordPerformance({ ...base, position: "win1", pool: "poolW", pool_name: "WIN-SOL", actual_pnl_pct: 6.2, actual_pnl_usd: 6.2 });
    data = JSON.parse(fs.readFileSync("lessons.json", "utf8"));
    assert.equal(data.lessons.length, 1);
    assert.match(data.lessons[0].rule, /^PREFER: WIN-SOL/);
    assert.equal(data.lessons[0].outcome, "good");

    await lessons.recordPerformance({ ...collectRecord(), actual_pnl_pct: -66.44, actual_pnl_usd: -85.89, final_value_usd: 42.72, fees_earned_usd: 0, minutes_in_range: 0 });
    data = JSON.parse(fs.readFileSync("lessons.json", "utf8"));
    assert.equal(data.lessons.length, 1, "no FAILED lesson from the false −66%");

    const pm = JSON.parse(fs.readFileSync("pool-memory.json", "utf8"));
    assert.equal(pm.poolBE.win_rate, null, "two break-even closes: no decisive close, no 100% win rate");
    assert.equal(pm.poolBE.last_outcome, "breakeven");
    assert.equal(pm.poolW.win_rate, 1);
    assert.equal(pm.poolW.last_outcome, "profit");
    const collectDeploy = pm[COLLECT.pool].deploys[0];
    assert.match(collectDeploy.exclude_from_learning, /false −66\.44%/, "flag carried into pool memory");
    assert.equal(pm[COLLECT.pool].win_rate, null);
    assert.equal(pm[COLLECT.pool].avg_pnl_pct, 0, "the −66% is not in the pool average");
  } finally {
    config.knowledgeBase = prevKb;
  }
});

test("prompt lessons skip the lesson derived from COLLECT; dedup never refreshes it", () => {
  const collectLesson = { id: 1, rule: "FAILED: COLLECT-SOL, strategy=bid_ask → PnL -66.44%", tags: ["failed"], outcome: "bad", pool: COLLECT.pool, pnl_pct: -66.44, created_at: COLLECT.recorded_at };
  const other = { id: 2, rule: "PREFER: X-SOL-type pools", tags: ["efficient", "bid_ask"], outcome: "good", pool: "p", created_at: "2026-09-26T01:00:00.000Z" };
  fs.writeFileSync("lessons.json", JSON.stringify({ lessons: [collectLesson, other], performance: [] }));
  const { selected } = lessons.getLessonRecordsForPrompt({ agentType: "GENERAL" });
  assert.deepEqual(selected.map((l) => l.id), [2]);
});

test("pool memory: aggregates recomputed on read, so stored win_rate 1 from break-evens doesn't reach the prompt", () => {
  fs.writeFileSync("pool-memory.json", JSON.stringify({
    poolOld: {
      name: "OLD-SOL", deploys: [
        { deployed_at: "a", pnl_pct: 0.01 }, { deployed_at: "b", pnl_pct: 0.2 }, { deployed_at: "c", pnl_pct: 2.5 }, { deployed_at: "d", pnl_pct: -3 },
      ],
      total_deploys: 4, avg_pnl_pct: -0.07, win_rate: 1, last_outcome: "profit", notes: [],
    },
  }));
  const mem = poolMemory.getPoolMemory({ pool_address: "poolOld" });
  assert.equal(mem.win_rate, 0.5, "1 win / (1 win + 1 loss); the two break-evens are ignored");
  assert.equal(mem.last_outcome, "loss");
  assert.match(poolMemory.recallForPool("poolOld"), /win rate 50%/);
  fs.writeFileSync("pool-memory.json", JSON.stringify({ poolBE: { name: "BE-SOL", deploys: [{ pnl_pct: 0 }], total_deploys: 1, win_rate: 1, last_outcome: "profit", notes: [] } }));
  assert.match(poolMemory.recallForPool("poolBE"), /win rate n\/a .*last: breakeven/);
});

// ─── Darwinian signal weights ───
test("signal weights: break-even and known-bad closes are neither wins nor losses", () => {
  if (fs.existsSync("signal-weights.json")) fs.rmSync("signal-weights.json");
  const snap = (bp) => ({ signal_snapshot: { gmgn_buy_pressure: bp } });
  const wins = Array.from({ length: 12 }, () => close(5, snap(true)));
  // Old rule: pnl_usd ≤ 0 was a loss, so these break-evens and the false −66% were "losses".
  const breakeven = Array.from({ length: 12 }, () => close(-0.2, snap(false)));
  const bad = Array.from({ length: 3 }, () => ({ ...collectRecord(), recorded_at, ...snap(false) }));
  const cfg = { darwin: { minSamples: 10, perSignalMinSamples: 12 } };
  const res = weights.recalculateWeights([...wins, ...breakeven, ...bad], cfg);
  assert.deepEqual(res.changes, [], "no real losses → nothing to compare → no weight moves");

  // Buy pressure present in every win and absent in every loss: lift 1. Break-evens
  // WITH buy pressure would drag it to 0.5 if they counted as losses (old rule).
  const losses = Array.from({ length: 12 }, () => close(-5, snap(false)));
  const breakevenBp = Array.from({ length: 12 }, () => close(-0.2, snap(true)));
  const res2 = weights.recalculateWeights([...wins, ...losses, ...breakevenBp], cfg);
  const bp = res2.changes.find((c) => c.signal === "gmgn_buy_pressure");
  assert.ok(bp, "buy pressure weight moved");
  assert.equal(bp.lift, 1, "break-evens are not counted as losses");
  const data = weights.loadWeights();
  assert.deepEqual([data.history.at(-1).win_count, data.history.at(-1).loss_count], [12, 12]);
  fs.rmSync("signal-weights.json", { force: true });
});

// ─── Knowledge base close label ───
test("KB close label: WIN / LOSS / BREAKEVEN with the shared classifier", () => {
  const prevKb = config.knowledgeBase;
  const dir = path.join(TMP, "kb");
  config.knowledgeBase = { ...prevKb, enabled: true, dir };
  try {
    kb.filePositionClose({ pool_name: "KB-SOL", pool: "poolKB", pnl_pct: 0.004, strategy: "bid_ask", minutes_held: 10, minutes_in_range: 10 });
    kb.filePositionClose({ pool_name: "KB-SOL", pool: "poolKB", pnl_pct: 3, strategy: "bid_ask", minutes_held: 10, minutes_in_range: 10 });
    kb.filePositionClose({ pool_name: "KB-SOL", pool: "poolKB", pnl_pct: -3, strategy: "bid_ask", minutes_held: 10, minutes_in_range: 10 });
    const article = fs.readFileSync(path.join(dir, "pools/kb-sol.md"), "utf8");
    assert.match(article, /\*\*BREAKEVEN\*\* .*PnL 0\.0%/);
    assert.match(article, /\*\*WIN\*\* .*PnL 3\.0%/);
    assert.match(article, /\*\*LOSS\*\* .*PnL -3\.0%/);
  } finally {
    config.knowledgeBase = prevKb;
  }
});

// ─── The one-off data-fix script ───
test("fix-learning-data script: previews by default, flags the known-bad records, recomputes pool aggregates, idempotent", () => {
  const root = fs.mkdtempSync(path.join(TMP, "fix-"));
  const cum = ld.KNOWN_BAD_RECORDS.find((b) => b.key === "CUM-test-1");
  fs.writeFileSync(path.join(root, "lessons.json"), JSON.stringify({
    lessons: [
      { id: 1, rule: "FAILED: COLLECT-SOL …", tags: ["failed"], outcome: "bad", pool: COLLECT.pool, created_at: COLLECT.recorded_at },
      { id: 2, rule: "PREFER: other", tags: ["efficient"], outcome: "good", pool: "p2", created_at: "2026-09-26T01:00:00.000Z" },
    ],
    performance: [
      { position: COLLECT.position, pool: COLLECT.pool, pnl_pct: -66.44 },
      { position: cum.position, pool: cum.pool, pnl_pct: 0 },
      { position: "real", pool: "p2", pnl_pct: 6 },
    ],
  }));
  fs.writeFileSync(path.join(root, "pool-memory.json"), JSON.stringify({
    [COLLECT.pool]: { name: "COLLECT-SOL", deploys: [{ deployed_at: COLLECT.deployed_at, pnl_pct: -66.44 }], avg_pnl_pct: -66.44, win_rate: 0, last_outcome: "loss" },
    poolBE: { name: "BE-SOL", deploys: [{ deployed_at: "x", pnl_pct: 0.01 }], avg_pnl_pct: 0.01, win_rate: 1, last_outcome: "profit" },
    poolNone: { name: "NOTES-ONLY", deploys: [], avg_pnl_pct: 0, win_rate: 0, last_outcome: null, notes: [{ note: "n" }] },
  }));
  const before = fs.readFileSync(path.join(root, "lessons.json"), "utf8");
  const quiet = () => {};

  const preview = fixScript.applyLearningFix(root, { apply: false, log: quiet });
  assert.ok(preview.changes.length >= 6);
  assert.equal(preview.written.length, 0);
  assert.equal(fs.readFileSync(path.join(root, "lessons.json"), "utf8"), before, "preview writes nothing");

  const first = fixScript.applyLearningFix(root, { apply: true, log: quiet });
  assert.equal(first.written.length, 2);
  assert.ok(fs.existsSync(path.join(root, "lessons.json.bak-fix-learning-data")));
  const L = JSON.parse(fs.readFileSync(path.join(root, "lessons.json"), "utf8"));
  assert.match(L.performance[0].exclude_from_learning, /false −66\.44%/);
  assert.match(L.performance[1].exclude_from_learning, /May test/);
  assert.equal(L.performance[2].exclude_from_learning, undefined);
  assert.match(L.lessons[0].exclude_from_learning, /false −66\.44%/);
  assert.equal(L.lessons[1].exclude_from_learning, undefined);
  assert.equal(L.performance.length, 3, "nothing deleted");
  const PM = JSON.parse(fs.readFileSync(path.join(root, "pool-memory.json"), "utf8"));
  assert.ok(PM[COLLECT.pool].deploys[0].exclude_from_learning);
  assert.deepEqual([PM[COLLECT.pool].avg_pnl_pct, PM[COLLECT.pool].win_rate, PM[COLLECT.pool].last_outcome], [0, null, "unknown"]);
  assert.deepEqual([PM.poolBE.win_rate, PM.poolBE.last_outcome], [null, "breakeven"]);
  assert.deepEqual(PM.poolNone.notes, [{ note: "n" }], "pools without deploys untouched");

  const second = fixScript.applyLearningFix(root, { apply: true, log: quiet });
  assert.equal(second.changes.length, 0, "idempotent");
  assert.equal(second.written.length, 0);
});
