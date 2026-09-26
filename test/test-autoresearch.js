// Autoresearch unit tests. No LLM, network, or chain calls: the generator is
// mocked, and every file the modules touch lives in a scratch directory
// (autoresearch.json via MERIDIAN_AUTORESEARCH_FILE; lessons/logs/KB via cwd).
process.env.DRY_RUN = "true";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-autoresearch-test-"));
const AR_FILE = path.join(TMP, "autoresearch.json");
process.env.MERIDIAN_AUTORESEARCH_FILE = AR_FILE;
process.chdir(TMP);

// recordPerformance also writes the tracked nuggets files and could create the
// repo's user-config.json; snapshot and restore both so the tree stays clean.
const NUGGET_DIR = path.join(REPO, "data", "nuggets");
const nuggetSnapshot = fs.existsSync(NUGGET_DIR)
  ? Object.fromEntries(fs.readdirSync(NUGGET_DIR).map((f) => [f, fs.readFileSync(path.join(NUGGET_DIR, f))]))
  : {};
const USER_CONFIG = path.join(REPO, "user-config.json");
const hadUserConfig = fs.existsSync(USER_CONFIG);
function restoreRepoFiles() {
  for (const [f, buf] of Object.entries(nuggetSnapshot)) fs.writeFileSync(path.join(NUGGET_DIR, f), buf);
  if (fs.existsSync(NUGGET_DIR)) {
    for (const f of fs.readdirSync(NUGGET_DIR)) if (!(f in nuggetSnapshot)) fs.rmSync(path.join(NUGGET_DIR, f));
  }
  if (!hadUserConfig && fs.existsSync(USER_CONFIG)) fs.rmSync(USER_CONFIG);
}
after(() => {
  restoreRepoFiles();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const ar = await import("../autoresearch.js");
const { config } = await import("../config.js");

function losingClose(i, extra = {}) {
  return {
    position: `pos${i}`,
    pool_name: `P${i}-SOL`,
    strategy: "spot",
    close_reason: "agent decision",
    amount_sol: 1,
    pnl_usd: -1,
    pnl_pct: -2,
    minutes_held: 60,
    minutes_in_range: 60,
    recorded_at: new Date(Date.now() - (100 - i) * 60_000).toISOString(),
    ...extra,
  };
}

test("close path: recordPerformance resolves while the generator never does", async () => {
  // Seed enough losing closes that the next close reaches the generator.
  const seeded = Array.from({ length: 20 }, (_, i) => losingClose(i));
  fs.writeFileSync(path.join(TMP, "lessons.json"), JSON.stringify({ lessons: [], performance: seeded }));
  fs.writeFileSync(AR_FILE, JSON.stringify({ experiments: [], active: null, cooldownRemaining: 0, kept_overrides: {} }));

  let generatorCalled = false;
  ar.__setAutoresearchGeneratorForTests(() => {
    generatorCalled = true;
    return new Promise(() => {}); // never resolves
  });
  const prevEnabled = config.autoresearch.enabled;
  config.autoresearch.enabled = true;
  try {
    const { recordPerformance } = await import("../lessons.js");
    const closed = recordPerformance({
      position: "posNew",
      pool_name: "NEW-SOL",
      strategy: "spot",
      amount_sol: 1,
      initial_value_usd: 100,
      final_value_usd: 98,
      fees_earned_usd: 0,
      actual_pnl_usd: -2,
      actual_pnl_pct: -2,
      minutes_held: 30,
      minutes_in_range: 30,
      close_reason: "agent decision",
    });
    let timer;
    const outcome = await Promise.race([
      closed.then(() => "resolved"),
      new Promise((r) => { timer = setTimeout(() => r("timeout"), 5000); }),
    ]);
    clearTimeout(timer);
    assert.equal(outcome, "resolved", "recordPerformance must not wait on the autoresearch LLM");

    // The fire-and-forget run did reach the (hung) generator and holds the lock.
    for (let i = 0; i < 50 && !generatorCalled; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(generatorCalled, "generator should have been invoked in the background");
    assert.equal(ar.isAutoresearchRunning(), true);

    // A second close while the first run is stuck is skipped, not queued behind it.
    const second = await ar.maybeRunAutoresearch([], [], config);
    assert.deepEqual(second, { skipped: "busy" });
  } finally {
    config.autoresearch.enabled = prevEnabled;
    ar.__setAutoresearchGeneratorForTests(null);
    ar.__resetAutoresearchLockForTests();
  }
});

test("maybeRunAutoresearch is a no-op when disabled", async () => {
  const res = await ar.maybeRunAutoresearch([], [], { autoresearch: { enabled: false } });
  assert.deepEqual(res, { skipped: "disabled" });
});

test("D2: evolution counters alone never invalidate; a real threshold change does", () => {
  const cfg = structuredClone({ screening: config.screening, management: config.management, strategy: config.strategy });
  const snap = ar.getEnvironmentSnapshot(cfg);
  assert.equal(typeof snap.thresholds_fingerprint, "string");
  assert.equal("thresholds_last_evolved" in snap, false, "counters are not part of the snapshot");

  // evolveThresholds with no changes only bumps _lastEvolved/_positionsAtEvolution
  // in user-config.json; the live threshold values are untouched.
  assert.equal(ar.environmentChangedSince(snap, cfg), false);

  cfg.screening.maxVolatility = (cfg.screening.maxVolatility ?? 8) - 1;
  assert.equal(ar.environmentChangedSince(snap, cfg), true, "a changed screening value invalidates");

  const cfg2 = structuredClone({ screening: config.screening, management: config.management, strategy: config.strategy });
  const snap2 = ar.getEnvironmentSnapshot(cfg2);
  cfg2.management.stopLossPct = (cfg2.management.stopLossPct ?? -10) - 5;
  assert.equal(ar.environmentChangedSince(snap2, cfg2), true, "a changed stop loss invalidates");

  // Legacy experiments only recorded the counters: never invalidate on them.
  assert.equal(ar.environmentChangedSince({ thresholds_last_evolved: "x", thresholds_positions_at_evolution: 3 }, cfg), false);
});

// "experiments": [...] exactly as serializeAutoresearch lays it out inside the top-level object.
function experimentsBlock(experiments) {
  return `"experiments": ${ar.serializeAutoresearch(experiments).replace(/\n/g, "\n  ")}`;
}

test("quarantine migration is idempotent and leaves experiments byte-identical", () => {
  const legacy = {
    enabled: false,
    experiments: [
      { id: "exp_1", section: "screener_criteria", hypothesis: "Tighten “1h” filter — ok", status: "kept" },
      { id: "exp_2", section: "range_selection", hypothesis: "Widen 🚀", status: "reverted" },
      { id: "exp_3", section: "range_selection", hypothesis: "Keep", status: "kept" },
    ],
    active: null,
    cooldownRemaining: 0,
    kept_overrides: { screener_criteria: "SCREEN TEXT", range_selection: "RANGE TEXT ${deployAmount}" },
  };
  const raw = ar.serializeAutoresearch(legacy);
  const state = JSON.parse(raw);
  const now = new Date("2026-09-24T00:00:00Z");

  assert.equal(ar.migrateAutoresearchState(state, now), true);
  assert.deepEqual(state.kept_overrides, {});
  assert.equal(state.quarantined_overrides.screener_criteria.text, "SCREEN TEXT");
  assert.equal(state.quarantined_overrides.range_selection.text, "RANGE TEXT ${deployAmount}");
  assert.equal(state.quarantined_overrides.range_selection.quarantined_at, now.toISOString());
  assert.match(state.quarantined_overrides.range_selection.reason, /7-close/);
  assert.deepEqual(state.quarantined_overrides.range_selection.experiment_ids, ["exp_3"]);

  const once = ar.serializeAutoresearch(state);
  assert.equal(ar.migrateAutoresearchState(state, new Date("2027-01-01T00:00:00Z")), false, "second run is a no-op");
  assert.equal(ar.serializeAutoresearch(state), once, "second run changes nothing");

  // Experiments: same bytes in the file before and after (non-ASCII stays \u-escaped).
  assert.ok(raw.includes(experimentsBlock(legacy.experiments)));
  assert.ok(once.includes(experimentsBlock(legacy.experiments)));
  assert.deepEqual(state.experiments, legacy.experiments);
});

test("the repo autoresearch.json keeps its experiment bytes through the migration", () => {
  const raw = fs.readFileSync(path.join(REPO, "autoresearch.json"), "utf8");
  const state = JSON.parse(raw);
  const block = experimentsBlock(state.experiments);
  assert.ok(raw.includes(block), "serializer reproduces the tracked file's experiment bytes");
  ar.migrateAutoresearchState(state);
  assert.ok(ar.serializeAutoresearch(state).includes(block));
  assert.deepEqual(state.kept_overrides, {});
});

test("startup restore does nothing when autoresearch is disabled", async () => {
  const { getPromptSectionText, getDefaultPromptSectionText } = await import("../prompt.js");
  const state = {
    kept_overrides: { screener_criteria: "KEPT OVERRIDE TEXT" },
    active: { id: "exp_x", section: "manager_logic", modified_text: "ACTIVE TEXT" },
  };
  const applied = ar.applyStartupOverrides(state, { autoresearch: { enabled: false }, strategy: config.strategy });
  assert.deepEqual(applied, []);
  assert.equal(getPromptSectionText("screener_criteria"), getDefaultPromptSectionText("screener_criteria"));
  assert.equal(getPromptSectionText("manager_logic"), getDefaultPromptSectionText("manager_logic"));
});

test("operator commands: revert and restore round-trip, quarantine restores with stale warning", async () => {
  const { getPromptSectionText, getDefaultPromptSectionText } = await import("../prompt.js");
  fs.writeFileSync(AR_FILE, ar.serializeAutoresearch({
    experiments: [], active: null, cooldownRemaining: 0,
    kept_overrides: {}, kept_meta: {},
    quarantined_overrides: { screener_criteria: { text: "OLD SCREEN", reason: "test", quarantined_at: "t", strategy: "bid_ask", default_hash: null, experiment_ids: ["exp_9"] } },
    reverted_overrides: [],
    migrations: { quarantine_legacy_kept_overrides_v1: "t" },
  }));
  const cfgOff = { autoresearch: { enabled: false }, strategy: { activeStrategy: "evil_panda" } };

  const list = ar.handleAutoresearchCommand("list", cfgOff);
  assert.match(list, /Quarantined/);
  assert.match(list, /generated under bid_ask, current strategy is evil_panda/);

  const restored = ar.handleAutoresearchCommand("restore screener_criteria", cfgOff);
  assert.match(restored, /Inactive until autoresearch is enabled/);
  assert.match(restored, /stale/);
  assert.equal(getPromptSectionText("screener_criteria"), getDefaultPromptSectionText("screener_criteria"), "disabled: not applied");
  let st = ar.loadAutoresearch();
  assert.equal(st.kept_overrides.screener_criteria, "OLD SCREEN");
  assert.equal(st.quarantined_overrides.screener_criteria, undefined);

  assert.match(ar.handleAutoresearchCommand("revert screener_criteria", cfgOff), /Reverted/);
  st = ar.loadAutoresearch();
  assert.equal(st.kept_overrides.screener_criteria, undefined);
  assert.equal(st.reverted_overrides.at(-1).text, "OLD SCREEN");

  assert.match(ar.handleAutoresearchCommand("restore screener_criteria", cfgOff), /from reverted history/);
  assert.equal(ar.loadAutoresearch().kept_overrides.screener_criteria, "OLD SCREEN");
  assert.match(ar.handleAutoresearchCommand("show bogus", cfgOff), /Unknown or missing section/);

  const chunks = ar.autoresearchTelegramChunks("a < b & c > d");
  assert.deepEqual(chunks, ["a &lt; b &amp; c &gt; d"]);
});

const SECTION = [
  "1. SCREEN: use get_top_candidates.",
  "2. STUDY: call study_top_lpers.",
  "3. MEMORY: call get_pool_memory.",
  "   - HARD SKIP if global_fees_sol < 30 SOL. No exceptions.",
  "   - Smart wallets present → strong signal.",
  "   - Bundlers 5-15% are normal.",
  "   - GOOD narrative: specific origin.",
  "   - BAD narrative: generic hype.",
  "5. DEPLOY: deploy_position.",
  "   - HARD RULE: Minimum 0.1 SOL absolute floor.",
  "   - You MUST use the amount from the cycle goal: ${deployAmount}.",
  "   - Focus on one deployment per cycle.",
].join("\n");

test("protected lines: dropping or editing a HARD line is rejected, a small edit passes", () => {
  const cfg = { autoresearch: { maxDiffPct: 30 } };
  const dropHard = SECTION.split("\n").filter((l) => !l.includes("HARD SKIP")).join("\n");
  assert.match(ar.validateCandidate(SECTION, dropHard, cfg), /protected line/);

  const editHard = SECTION.replace("0.1 SOL absolute floor", "0.05 SOL absolute floor");
  assert.match(ar.validateCandidate(SECTION, editHard, cfg), /protected line/);

  const addHard = `${SECTION}\n   - HARD SKIP if the token is up more than 1% in the last hour.`;
  assert.match(ar.validateCandidate(SECTION, addHard, cfg), /new binding rule/);

  const dropPlaceholder = SECTION.replace("${deployAmount}", "0.5"); // also edits a MUST line
  assert.ok(ar.validateCandidate(SECTION, dropPlaceholder, cfg));

  // Deleting a heuristic (simplification) and rewording one are both fine.
  const deleteOne = SECTION.split("\n").filter((l) => !l.includes("Bundlers")).join("\n");
  assert.equal(ar.validateCandidate(SECTION, deleteOne, cfg), null);
  const reword = SECTION.replace("strong signal", "moderate signal");
  assert.equal(ar.validateCandidate(SECTION, reword, cfg), null);
  assert.match(ar.validateCandidate(SECTION, `---\n${SECTION}\n---`, cfg), /delimiter/);
});

test("diff cap: more than 30% of lines changed is rejected", () => {
  const cfg = { autoresearch: { maxDiffPct: 30 } };
  const lines = SECTION.split("\n");
  const editable = lines.map((l, i) => ({ l, i })).filter(({ l }) => !/HARD|MUST|NEVER/.test(l));
  const rewrite = (n) => {
    const out = lines.slice();
    for (const { i } of editable.slice(0, n)) out[i] = `${out[i]} (rewritten)`;
    return out.join("\n");
  };
  assert.equal(ar.validateCandidate(SECTION, rewrite(3), cfg), null, "3/12 lines = 25% passes");
  assert.match(ar.validateCandidate(SECTION, rewrite(4), cfg), /diff too large/, "4/12 lines = 33% fails");
  assert.match(ar.validateCandidate(SECTION, rewrite(4), { autoresearch: { maxDiffPct: 30 } }), /33%/);
  assert.equal(ar.validateCandidate(SECTION, rewrite(4), { autoresearch: { maxDiffPct: 40 } }), null, "the cap is configurable");
});

test("inactive sections are skipped under evil_panda; OOR upside is attributed before range efficiency", () => {
  assert.deepEqual(ar.eligibleSections({ strategy: { activeStrategy: "evil_panda" } }).includes("range_selection"), false);
  assert.ok(ar.eligibleSections({ strategy: { activeStrategy: "bid_ask" } }).includes("range_selection"));

  const oorUpside = { pnl_usd: -1, pnl_pct: -2, close_reason: "agent decision (OOR upside)", strategy: "spot", sol_split_pct: 100, range_efficiency: 5 };
  const lowEff = { pnl_usd: -1, pnl_pct: -2, close_reason: "agent decision", strategy: "spot", range_efficiency: 10 };
  const unknown = { pnl_usd: -1, pnl_unknown: true, close_reason: "agent decision" };
  const breakeven = { pnl_usd: -0.1, pnl_pct: -0.4, close_reason: "agent decision", strategy: "spot", range_efficiency: 10 };
  const knownBad = { position: "AT5nG76yVJNftdTnd2HHmN5rvRgsRFtSZ6weVq2GEwji", pnl_usd: -85.89, pnl_pct: -66.44, close_reason: "agent decision", range_efficiency: 10 };
  const losses = ar.attributeLosses([oorUpside, oorUpside, lowEff, unknown, breakeven, knownBad]);
  assert.equal(losses.screener_criteria.length, 2, "single-sided OOR upside goes to the screener even with low range efficiency");
  assert.equal(losses.range_selection.length, 1);
  assert.equal(losses.manager_logic.length, 0);
});

test("generation under evil_panda never targets range_selection", async () => {
  // Plenty of range_selection-attributed losses, but only range_selection.
  const perf = Array.from({ length: 20 }, (_, i) => losingClose(i, { close_reason: "agent decision", range_efficiency: 5 }));
  fs.writeFileSync(AR_FILE, ar.serializeAutoresearch({ experiments: [], active: null, cooldownRemaining: 0, kept_overrides: {}, migrations: { quarantine_legacy_kept_overrides_v1: "t" } }));
  let called = null;
  ar.__setAutoresearchGeneratorForTests(async (model, section) => { called = section; return { hypothesis: "x", modifiedText: "y" }; });
  try {
    const cfg = { autoresearch: { enabled: true }, strategy: { activeStrategy: "evil_panda" }, screening: config.screening, management: config.management };
    await ar.maybeRunAutoresearch(perf, [], cfg);
    assert.equal(called, null, "generator must not be asked to edit range_selection under evil_panda");
    assert.equal(ar.loadAutoresearch().active, null);
  } finally {
    ar.__setAutoresearchGeneratorForTests(null);
  }
});

// Seeded normal samples as { pnl, w } for verdict tests.
function arm(n, mean, sd, seed, w = 1) {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: n }, () => {
    const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    return { pnl: mean + sd * z, w };
  });
}

test("verdict: a clear effect passes, noise fails, too few closes is insufficient, the cap is inconclusive", () => {
  const opts = { minPerArm: 100, minEffectPct: 1.5, maxDays: 14, ageDays: 3, seed: 42 };

  const clear = ar.computeVerdict(arm(150, 0, 7, 1), arm(150, 5, 7, 2), opts);
  assert.equal(clear.verdict, "pass");
  assert.ok(clear.ci95[0] > 0 && clear.delta_pct >= 1.5);

  const noise = ar.computeVerdict(arm(150, 0, 7, 3), arm(150, 0, 7, 4), opts);
  assert.equal(noise.verdict, "fail");

  // A real but tiny effect (CI may exclude 0) still fails the 1.5 pp floor.
  const tiny = ar.computeVerdict(arm(2000, 0, 2, 5), arm(2000, 0.5, 2, 6), opts);
  assert.equal(tiny.verdict, "fail");
  assert.ok(tiny.delta_pct < 1.5);

  assert.equal(ar.computeVerdict(arm(99, 0, 7, 7), arm(300, 9, 7, 8), opts).verdict, "insufficient");
  assert.equal(ar.computeVerdict(arm(40, 0, 7, 9), arm(40, 9, 7, 10), { ...opts, ageDays: 14 }).verdict, "inconclusive");

  // Deterministic for the same seed.
  assert.deepEqual(ar.computeVerdict(arm(150, 0, 7, 1), arm(150, 5, 7, 2), opts), clear);

  // Placebo false-positive rate stays small (the old rule kept ~45% of placebos).
  let passes = 0;
  for (let i = 0; i < 100; i++) {
    const v = ar.computeVerdict(arm(100, 0, 7, 1000 + i), arm(100, 0, 7, 5000 + i), { ...opts, iterations: 400, seed: i + 1 });
    if (v.verdict === "pass") passes++;
  }
  assert.ok(passes <= 5, `placebo passes ${passes}/100`);
});

test("verdict is size-weighted and excludes pnl_unknown and dust closes", () => {
  const recs = [
    { experiment_id: "e1", experiment_arm: "control", pnl_pct: 10, amount_sol: 1 },
    { experiment_id: "e1", experiment_arm: "control", pnl_pct: 0, amount_sol: 0, pnl_unknown: true },
    { experiment_id: "e1", experiment_arm: "candidate", pnl_pct: 50, amount_sol: 0.001 }, // dust
    { experiment_id: "e1", experiment_arm: "candidate", pnl_pct: -4, amount_sol: 2 },
    { experiment_id: "other", experiment_arm: "candidate", pnl_pct: 99, amount_sol: 1 },
    { pnl_pct: 5, amount_sol: 1 }, // untagged
  ];
  const s = ar.splitArms(recs, "e1");
  assert.deepEqual(s.control, [{ pnl: 10, w: 1 }]);
  assert.deepEqual(s.candidate, [{ pnl: -4, w: 2 }]);
  assert.equal(s.excluded, 2);
  // weights matter: 1 SOL at +10% and 3 SOL at -2% → (10 - 6) / 4 = +1%
  const v = ar.computeVerdict([{ pnl: 0, w: 1 }], [{ pnl: 10, w: 1 }, { pnl: -2, w: 3 }], { minPerArm: 1, seed: 1, iterations: 50 });
  assert.equal(v.candidate_mean_pct, 1);
});

test("arm assignment alternates per screener run and tags deploys inside the arm", async () => {
  const prompt = await import("../prompt.js");
  const { trackPosition, getTrackedPosition } = await import("../state.js");
  const candidateText = "CANDIDATE SCREENER TEXT — prefer durable narratives.";
  prompt.setExperimentCandidate({ id: "exp_ab", section: "screener_criteria", text: candidateText });
  try {
    const arms = [];
    for (let i = 0; i < 4; i++) {
      await prompt.runWithExperimentArm(async () => {
        await new Promise((r) => setTimeout(r, 1)); // the arm survives awaits
        const tag = prompt.getExperimentTag();
        arms.push(tag.experiment_arm);
        assert.equal(tag.experiment_id, "exp_ab");
        const sys = prompt.buildSystemPrompt("SCREENER", {}, {}, null, null, null, null);
        assert.equal(sys.includes(candidateText), tag.experiment_arm === "candidate");
        trackPosition({ position: `abpos${i}`, pool: "pool", pool_name: "AB-SOL", strategy: "spot", amount_sol: 1, ...prompt.getExperimentTag() });
      });
    }
    for (let i = 1; i < arms.length; i++) assert.notEqual(arms[i], arms[i - 1], `arms alternate: ${arms.join(",")}`);
    assert.deepEqual(new Set(arms), new Set(["control", "candidate"]));
    assert.equal(getTrackedPosition("abpos0").experiment_arm, arms[0]);
    assert.equal(getTrackedPosition("abpos1").experiment_id, "exp_ab");

    // Outside a screener run (management, chat) nothing is tagged and the control text is used.
    assert.equal(prompt.getExperimentTag(), null);
    assert.equal(prompt.buildSystemPrompt("SCREENER", {}, {}, null, null, null, null).includes(candidateText), false);
  } finally {
    prompt.clearExperimentCandidate();
  }
  assert.equal(await prompt.runWithExperimentArm(async () => prompt.getExperimentTag()), null, "no experiment, no arm");
});

function taggedCloses(id, n, controlMean, candidateMean) {
  const c = arm(n, controlMean, 7, 11).map((x, i) => ({ experiment_id: id, experiment_arm: "control", pnl_pct: x.pnl, pnl_usd: x.pnl, amount_sol: 1, position: `c${i}` }));
  const k = arm(n, candidateMean, 7, 12).map((x, i) => ({ experiment_id: id, experiment_arm: "candidate", pnl_pct: x.pnl, pnl_usd: x.pnl, amount_sol: 1, position: `k${i}` }));
  return c.flatMap((x, i) => [x, k[i]]);
}

function activeState(id, started_at = new Date().toISOString()) {
  return {
    experiments: [],
    active: {
      id, design: "ab", section: "screener_criteria", hypothesis: "h",
      original_text: "CONTROL", modified_text: "CANDIDATE", started_at,
      trial: { control: 0, candidate: 0, excluded: 0 }, status: "active",
      environment_snapshot: ar.getEnvironmentSnapshot(config),
    },
    cooldownRemaining: 0, kept_overrides: {}, kept_meta: {}, pending_proposal: null,
    migrations: { quarantine_legacy_kept_overrides_v1: "t" },
  };
}

test("a passing experiment becomes a pending proposal (no auto-keep, no lessons); approve keeps it", async () => {
  const lessonsBefore = fs.readFileSync(path.join(TMP, "lessons.json"), "utf8");
  fs.writeFileSync(AR_FILE, ar.serializeAutoresearch(activeState("exp_pass")));
  const cfg = { ...config, autoresearch: { ...config.autoresearch, enabled: true, minClosesPerArm: 100, minEffectPct: 1.5, autoKeep: false } };

  await ar.maybeRunAutoresearch(taggedCloses("exp_pass", 120, 0, 5), [], cfg);
  let st = ar.loadAutoresearch();
  assert.equal(st.active, null);
  assert.equal(st.experiments.at(-1).status, "proposed");
  assert.equal(st.pending_proposal.experiment_id, "exp_pass");
  assert.ok(st.pending_proposal.result.ci95[0] > 0);
  assert.deepEqual(st.kept_overrides, {}, "not auto-kept");
  assert.equal(fs.readFileSync(path.join(TMP, "lessons.json"), "utf8"), lessonsBefore, "results are not written to lessons.json");

  // While a proposal is pending no new experiment starts.
  let asked = false;
  ar.__setAutoresearchGeneratorForTests(async () => { asked = true; return { hypothesis: "x", modifiedText: "y" }; });
  await ar.maybeRunAutoresearch(Array.from({ length: 20 }, (_, i) => losingClose(i)), [], cfg);
  ar.__setAutoresearchGeneratorForTests(null);
  assert.equal(asked, false);

  const cfgOff = { ...cfg, autoresearch: { ...cfg.autoresearch, enabled: false } };
  assert.match(ar.handleAutoresearchCommand("status", cfgOff), /Pending proposal: exp_pass/);
  assert.match(ar.handleAutoresearchCommand("approve", cfgOff), /Approved exp_pass/);
  st = ar.loadAutoresearch();
  assert.equal(st.kept_overrides.screener_criteria, "CANDIDATE");
  assert.equal(st.kept_meta.screener_criteria.experiment_id, "exp_pass");
  assert.equal(st.pending_proposal, null);
  assert.equal(st.experiments.at(-1).decision.action, "approved");
});

test("autoKeep keeps a pass; noise is discarded; the time cap is inconclusive", async () => {
  const base = { ...config.autoresearch, enabled: true, minClosesPerArm: 100, minEffectPct: 1.5 };

  fs.writeFileSync(AR_FILE, ar.serializeAutoresearch(activeState("exp_auto")));
  await ar.maybeRunAutoresearch(taggedCloses("exp_auto", 120, 0, 5), [], { ...config, autoresearch: { ...base, autoKeep: true } });
  let st = ar.loadAutoresearch();
  assert.equal(st.experiments.at(-1).status, "kept");
  assert.equal(st.kept_overrides.screener_criteria, "CANDIDATE");
  assert.equal(st.pending_proposal, null);

  fs.writeFileSync(AR_FILE, ar.serializeAutoresearch(activeState("exp_noise")));
  await ar.maybeRunAutoresearch(taggedCloses("exp_noise", 120, 0, 0), [], { ...config, autoresearch: base });
  st = ar.loadAutoresearch();
  assert.equal(st.experiments.at(-1).status, "discarded");
  assert.equal(st.pending_proposal, null);

  const old = new Date(Date.now() - 15 * 86_400_000).toISOString();
  fs.writeFileSync(AR_FILE, ar.serializeAutoresearch(activeState("exp_cap", old)));
  await ar.maybeRunAutoresearch(taggedCloses("exp_cap", 30, 0, 9), [], { ...config, autoresearch: base });
  st = ar.loadAutoresearch();
  assert.equal(st.experiments.at(-1).status, "inconclusive_time_cap");
});

test("M4: atomic save, degraded mode clears once the file is valid again", () => {
  ar.saveAutoresearch({ experiments: [], active: null, marker: "a" });
  assert.deepEqual(fs.readdirSync(TMP).filter((f) => f.startsWith("autoresearch.json.tmp")), [], "no temp file left behind");

  fs.writeFileSync(AR_FILE, "{ not json");
  assert.throws(() => ar.loadAutoresearch(), /corrupt/);
  assert.equal(ar.isAutoresearchDegraded(), true);
  ar.saveAutoresearch({ experiments: [], marker: "blocked" });
  assert.equal(fs.readFileSync(AR_FILE, "utf8"), "{ not json", "a corrupt file is never overwritten");

  // Operator repairs the main file: the next save goes through without a restart.
  fs.writeFileSync(AR_FILE, JSON.stringify({ experiments: [] }));
  ar.saveAutoresearch({ experiments: [], marker: "after-repair" });
  assert.equal(ar.isAutoresearchDegraded(), false);
  assert.equal(ar.loadAutoresearch().marker, "after-repair");
  for (const f of fs.readdirSync(TMP)) if (f.includes(".corrupt-")) fs.rmSync(path.join(TMP, f));
});

test("M4: an experiment whose performance history was cleared is closed as abandoned", async () => {
  const cfg = { ...config, autoresearch: { ...config.autoresearch, enabled: true, minClosesPerArm: 100 } };
  fs.writeFileSync(AR_FILE, ar.serializeAutoresearch(activeState("exp_clr")));
  await ar.maybeRunAutoresearch(taggedCloses("exp_clr", 10, 0, 0), [], cfg);
  assert.equal(ar.loadAutoresearch().active.tagged_seen, 20);
  await ar.maybeRunAutoresearch([], [], cfg); // clearPerformance()
  const st = ar.loadAutoresearch();
  assert.equal(st.active, null);
  assert.equal(st.experiments.at(-1).status, "abandoned_history_cleared");
});

test("research program is read from autoresearch-program.md without the editor note", () => {
  const program = ar.loadResearchProgram();
  assert.match(program, /Evil Panda/);
  assert.doesNotMatch(program, /<!--/);
});
