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
