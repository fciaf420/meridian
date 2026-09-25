/**
 * GMGN market signals (tools/gmgn-signals.js): parsing, classification, the
 * mint map, candidate attach + prompt text, the Darwin snapshot/weights and the
 * fetch-failure fallback. gmgn-cli is never spawned: every fetch uses an
 * injected spawn mock. Weights and config live in a temp dir.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-gmgn-signals-"));
fs.writeFileSync(path.join(TMP, "user-config.json"), "{}");
fs.writeFileSync(path.join(TMP, "gmgn-config.json"), "{}");
process.env.MERIDIAN_USER_CONFIG_PATH = path.join(TMP, "user-config.json");
process.env.MERIDIAN_GMGN_CONFIG_PATH = path.join(TMP, "gmgn-config.json");
process.env.DRY_RUN = "true";
const REPO = process.cwd();
process.chdir(TMP); // signal-weights.json / lessons.json / logs are cwd-relative
test.after(() => { process.chdir(REPO); fs.rmSync(TMP, { recursive: true, force: true }); });

const sig = await import("../tools/gmgn-signals.js");
const { config } = await import("../config.js");
const screening = await import("../tools/screening.js");
const weights = await import("../signal-weights.js");
const tracker = await import("../signal-tracker.js");
const { parseConfigKeys } = await import("../all-settings.js");

const NOW_MS = 1_790_000_000_000;
const NOW_S = NOW_MS / 1000;

function item(mint, type, minAgo, extra = {}) {
  return {
    id: `${mint}-${type}-${minAgo}`,
    token_address: mint,
    signal_type: type,
    trigger_at: NOW_S - minAgo * 60,
    trigger_mc: 300_000,
    market_cap: 350_000,
    ath: 900_000,
    signal_times: 1,
    data: { pool_address: `${mint}-pool` },
    ...extra,
  };
}

const FEED = [
  // AAA: 2 smart-money buys + 1 KOL buy per GMGN totals, newest buy 38m ago, plus 1 spike.
  item("AAA", 12, 38, { signal_times_by_type: { 12: 2, 20: 1, 6: 1 }, trigger_mc: 250_000, market_cap: 400_000 }),
  item("AAA", 6, 90, { signal_times_by_type: { 12: 2, 20: 1, 6: 1 } }),
  // BBB: spikes only (ATH x2, K-line spike x1) plus a bundler sell (OTHER).
  item("BBB", 7, 5, { signal_times_by_type: { 7: 2, 1: 1, 10: 1 } }),
  // CCC: no by-type breakdown — counts fall back to feed events.
  item("CCC", 20, 12),
  item("CCC", 20, 20),
  // Junk rows are ignored.
  { signal_type: 12, trigger_at: NOW_S },
  null,
];

// ─── Parsing and classification ─────────────────────────────────
test("classifies GMGN signal types into BUY_PRESSURE / SPIKE / OTHER", () => {
  for (const t of [12, 14, 15, 16, 20]) assert.equal(sig.classifySignalType(t), "buy_pressure", String(t));
  for (const t of [1, 6, 7]) assert.equal(sig.classifySignalType(t), "spike", String(t));
  for (const t of [2, 3, 4, 5, 8, 9, 10, 11, 13, 17, 18, 19, 21, 99]) assert.equal(sig.classifySignalType(t), "other", String(t));
  assert.equal(sig.classifySignalType("12"), "buy_pressure", "string keys from signal_times_by_type");
  // Every documented type has a name.
  for (let t = 1; t <= 21; t++) assert.ok(sig.SIGNAL_TYPE_NAMES[t], `name for ${t}`);
});

test("parseSignalResponse accepts the raw array or { list } and drops rows without a mint", () => {
  assert.equal(sig.parseSignalResponse(FEED).length, 5);
  assert.equal(sig.parseSignalResponse({ list: FEED }).length, 5);
  assert.deepEqual(sig.parseSignalResponse(null), []);
  assert.deepEqual(sig.parseSignalResponse({ error: "x" }), []);
});

// ─── Mint map ───────────────────────────────────────────────────
test("buildSignalMap folds items per mint with counts, recency and market caps", () => {
  const map = sig.buildSignalMap(sig.parseSignalResponse(FEED), NOW_MS);
  assert.equal(map.size, 3);

  const a = map.get("AAA");
  assert.equal(a.buy_pressure_count, 3);
  assert.equal(a.spike_count, 1);
  assert.equal(a.other_count, 0);
  assert.equal(a.last_signal_min_ago, 38);
  assert.equal(a.last_buy_pressure_min_ago, 38);
  assert.equal(a.last_spike_min_ago, 90);
  assert.equal(a.trigger_mc, 250_000, "trigger_mc of the newest event");
  assert.equal(a.mc_now, 400_000);
  assert.deepEqual(a.types, { 6: 1, 12: 2, 20: 1 });

  const b = map.get("BBB");
  assert.equal(b.buy_pressure_count, 0);
  assert.equal(b.spike_count, 3);
  assert.equal(b.other_count, 1);
  assert.equal(b.last_buy_pressure_min_ago, null);

  const c = map.get("CCC");
  assert.equal(c.buy_pressure_count, 2, "no breakdown: counted from feed events");
  assert.equal(c.last_signal_min_ago, 12);
});

test("query groups use the screening mcap range of the active source", () => {
  const base = { screening: { source: "meteora", minMcap: 150_000, maxMcap: 10_000_000 }, gmgn: { minMcap: 100_000, maxMcap: 20_000_000 } };
  assert.deepEqual(sig.resolveMcapRange(base), { min: 150_000, max: 10_000_000 });
  assert.deepEqual(sig.resolveMcapRange({ ...base, screening: { ...base.screening, source: "gmgn" } }), { min: 100_000, max: 20_000_000 });
  assert.deepEqual(sig.resolveMcapRange({ ...base, screening: { ...base.screening, source: "both" } }), { min: 100_000, max: 20_000_000 });
  const groups = sig.buildSignalGroups({ min: 150_000, max: 10_000_000 });
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], { signal_type: [12, 20], mc_min: 150_000, mc_max: 10_000_000 });
  assert.deepEqual(groups[1], { signal_type: [1, 6, 7], mc_min: 150_000, mc_max: 10_000_000 });
  // The API rejects 14–16 as query filters.
  for (const g of groups) for (const t of g.signal_type) assert.ok(![14, 15, 16].includes(t));
});

// ─── Fetch, cache, failure fallback ─────────────────────────────
const CFG = { screening: { source: "meteora", minMcap: 150_000, maxMcap: 10_000_000 }, gmgn: {} };

test("fetchGmgnSignalMap spawns one read-only `market signal --groups` call and caches it ~5 min", async () => {
  sig._resetGmgnSignalCache();
  const calls = [];
  let now = NOW_MS;
  const spawn = async (args) => { calls.push(args); return FEED; };
  const m1 = await sig.fetchGmgnSignalMap({ cfg: CFG, spawn, now: () => now });
  assert.equal(m1.ok, true);
  assert.equal(m1.size, 3);
  assert.deepEqual(calls[0].slice(0, 5), ["market", "signal", "--chain", "sol", "--groups"]);
  assert.deepEqual(JSON.parse(calls[0][5]), sig.buildSignalGroups({ min: 150_000, max: 10_000_000 }));
  assert.ok(!calls[0].includes("--raw"), "spawnGmgn appends --raw itself");

  now += 4 * 60_000;
  assert.equal(await sig.fetchGmgnSignalMap({ cfg: CFG, spawn, now: () => now }), m1);
  assert.equal(calls.length, 1, "served from cache");
  now += 2 * 60_000;
  await sig.fetchGmgnSignalMap({ cfg: CFG, spawn, now: () => now });
  assert.equal(calls.length, 2, "refetched after TTL");

  // Concurrent callers share one spawn.
  sig._resetGmgnSignalCache();
  const [x, y] = await Promise.all([
    sig.fetchGmgnSignalMap({ cfg: CFG, spawn, now: () => now }),
    sig.fetchGmgnSignalMap({ cfg: CFG, spawn, now: () => now }),
  ]);
  assert.equal(x, y);
  assert.equal(calls.length, 3);
});

test("fetch failure (null, throw, bad config) returns an empty map with ok=false and never throws", async () => {
  sig._resetGmgnSignalCache();
  const nullMap = await sig.fetchGmgnSignalMap({ cfg: CFG, spawn: async () => null, now: () => NOW_MS });
  assert.equal(nullMap.size, 0);
  assert.equal(nullMap.ok, false);

  sig._resetGmgnSignalCache();
  const thrown = await sig.fetchGmgnSignalMap({ cfg: CFG, spawn: async () => { throw new Error("boom"); }, now: () => NOW_MS });
  assert.equal(thrown.size, 0);
  assert.equal(thrown.ok, false);

  // A failure is retried after a short back-off, not the full 5 minutes.
  let n = 0;
  const flaky = async () => (++n === 1 ? null : FEED);
  sig._resetGmgnSignalCache();
  let now = NOW_MS;
  assert.equal((await sig.fetchGmgnSignalMap({ cfg: CFG, spawn: flaky, now: () => now })).ok, false);
  now += 30_000;
  assert.equal((await sig.fetchGmgnSignalMap({ cfg: CFG, spawn: flaky, now: () => now })).ok, false);
  now += 31_000;
  assert.equal((await sig.fetchGmgnSignalMap({ cfg: CFG, spawn: flaky, now: () => now })).ok, true);

  sig._resetGmgnSignalCache();
  const bad = await sig.fetchGmgnSignalMap({ cfg: null, spawn: async () => { throw new Error("x"); } });
  assert.equal(bad.ok, false);
  sig._resetGmgnSignalCache();
});

// ─── Candidate attach + summary text ────────────────────────────
function cand(mint, extra = {}) {
  return {
    pool: `${mint}-pool`, name: `${mint}-SOL`, base: { symbol: mint, mint },
    fee_active_tvl_ratio: 0.1, volume: 10_000, organic_score: 70, holders: 1000, mcap: 500_000, volatility: 3, ...extra,
  };
}

test("attachGmgnSignals: hits get the summary, misses get zeros, a failed fetch leaves null", () => {
  const map = sig.buildSignalMap(sig.parseSignalResponse(FEED), NOW_MS);
  map.ok = true;
  const cands = [cand("AAA"), cand("ZZZ"), { pool: "p", base_mint: "BBB" }];
  assert.equal(sig.attachGmgnSignals(cands, map), 2);
  assert.equal(cands[0].gmgn_signals.buy_pressure_count, 3);
  assert.equal(cands[1].gmgn_signals.buy_pressure_count, 0);
  assert.equal(cands[1].gmgn_signals.last_signal_min_ago, null);
  assert.equal(cands[2].gmgn_signals.spike_count, 3, "base_mint fallback");
  cands[0].gmgn_signals.types[12] = 99;
  assert.equal(map.get("AAA").types[12], 2, "candidate gets a copy");

  const failed = new Map(); failed.ok = false;
  const c2 = [cand("AAA")];
  sig.attachGmgnSignals(c2, failed);
  assert.equal(c2[0].gmgn_signals, null);
});

test("formatGmgnSignalsLine gives the compact screener line", () => {
  const map = sig.buildSignalMap(sig.parseSignalResponse(FEED), NOW_MS);
  assert.equal(sig.formatGmgnSignalsLine(map.get("AAA")), "GMGN signals: 3 buy-pressure (38m ago), 1 spike (90m ago)");
  assert.equal(sig.formatGmgnSignalsLine(map.get("BBB")), "GMGN signals: 3 spikes (5m ago), 1 other");
  assert.equal(sig.formatGmgnSignalsLine(sig.NO_GMGN_SIGNALS), "GMGN signals: none in recent feed");
  assert.equal(sig.formatGmgnSignalsLine(null), null);
  assert.match(sig.GMGN_MARKET_SIGNALS_GUIDE, /informational, not a hard filter/);
  assert.match(sig.GMGN_MARKET_SIGNALS_GUIDE, /out-of-range risk for bid_ask/);
  assert.match(sig.GMGN_MARKET_SIGNALS_GUIDE, /sustained volume/);
});

test("attachScreeningGmgnSignals honours gmgnSignalsEnabled and swallows errors", async () => {
  let fetched = 0;
  const fetchMap = async () => { fetched++; const m = sig.buildSignalMap(FEED.filter(Boolean).filter((x) => x.token_address), NOW_MS); m.ok = true; return m; };
  const on = [cand("AAA")];
  await screening.attachScreeningGmgnSignals(on, { cfg: { screening: { gmgnSignalsEnabled: true } }, fetchMap });
  assert.equal(on[0].gmgn_signals.buy_pressure_count, 3);

  const off = [cand("AAA")];
  await screening.attachScreeningGmgnSignals(off, { cfg: { screening: { gmgnSignalsEnabled: false } }, fetchMap });
  assert.equal(off[0].gmgn_signals, undefined);
  assert.equal(fetched, 1, "disabled: no fetch");

  await screening.attachScreeningGmgnSignals([], { cfg: { screening: {} }, fetchMap });
  assert.equal(fetched, 1, "no candidates: no fetch");

  const boom = [cand("AAA")];
  await screening.attachScreeningGmgnSignals(boom, { cfg: { screening: {} }, fetchMap: async () => { throw new Error("x"); } });
  assert.equal(boom[0].gmgn_signals, undefined);
});

// ─── Darwin ─────────────────────────────────────────────────────
test("Darwin snapshot carries gmgn_buy_pressure / gmgn_spike (null when not fetched)", () => {
  assert.ok(weights.SIGNAL_NAMES.includes("gmgn_buy_pressure"));
  assert.ok(weights.SIGNAL_NAMES.includes("gmgn_spike"));

  const map = sig.buildSignalMap(sig.parseSignalResponse(FEED), NOW_MS);
  const a = { ...cand("AAA"), gmgn_signals: map.get("AAA") };
  const snap = screening.getCandidateSignalSnapshot(a);
  assert.equal(snap.gmgn_buy_pressure, true);
  assert.equal(snap.gmgn_spike, true);
  const none = screening.getCandidateSignalSnapshot({ ...cand("ZZZ"), gmgn_signals: { ...sig.NO_GMGN_SIGNALS } });
  assert.equal(none.gmgn_buy_pressure, false);
  assert.equal(none.gmgn_spike, false);
  const unknown = screening.getCandidateSignalSnapshot(cand("ZZZ"));
  assert.equal(unknown.gmgn_buy_pressure, null);
  assert.equal(unknown.gmgn_spike, null);

  // Deploy-time snapshot: staged fields survive to the deploy's signal_snapshot.
  const fields = sig.gmgnSignalSnapshotFields(map.get("AAA"));
  assert.deepEqual(fields, {
    gmgn_buy_pressure: true, gmgn_spike: true,
    gmgn_buy_pressure_count: 3, gmgn_spike_count: 1, gmgn_other_signal_count: 0, gmgn_last_market_signal_min_ago: 38,
  });
  tracker.stageSignals("POOL_A", { organic_score: 70, ...fields }, "AAA");
  const staged = tracker.getAndClearStagedSignals("POOL_A");
  assert.equal(staged.gmgn_buy_pressure, true);
  assert.equal(staged.gmgn_spike, true);
  assert.deepEqual(sig.gmgnSignalSnapshotFields(null), {
    gmgn_buy_pressure: null, gmgn_spike: null,
    gmgn_buy_pressure_count: null, gmgn_spike_count: null, gmgn_other_signal_count: null, gmgn_last_market_signal_min_ago: null,
  });

  // index.js stages these fields in the screening cycle.
  const indexSrc = fs.readFileSync(path.join(REPO, "index.js"), "utf8");
  assert.match(indexSrc, /\.\.\.gmgnSignalSnapshotFields\(c\.gmgn_signals\)/);
  assert.match(indexSrc, /formatGmgnSignalsLine\(c\.gmgn_signals\)/);
});

test("rankCandidatesByDarwin scores the new signals like the existing booleans", () => {
  const map = sig.buildSignalMap(sig.parseSignalResponse(FEED), NOW_MS);
  const plain = { ...cand("ZZZ"), pool: "P-plain", gmgn_signals: { ...sig.NO_GMGN_SIGNALS } };
  const buy = { ...cand("CCC"), pool: "P-buy", gmgn_signals: map.get("CCC") };
  const ranked = screening.rankCandidatesByDarwin([plain, buy]);
  assert.equal(ranked[0].pool, "P-buy", "buy pressure present ranks higher with default present=better");
  const score = weights.scoreSignalSnapshot(screening.getCandidateSignalSnapshot(buy), { calibration: {} });
  const c = score.contributions.find((x) => x.signal === "gmgn_buy_pressure");
  assert.equal(c.weight, 1);
  assert.equal(c.direction, "present=better");
  assert.equal(c.score, 1);
  const s = score.contributions.find((x) => x.signal === "gmgn_spike");
  assert.equal(s.direction, "absent=better", "spikes start as a penalty for bid_ask");
  assert.equal(s.score, 1, "no spike scores full marks under absent=better");
});

test("weights migration: a persisted file without the new keys gets them at the neutral weight", () => {
  const file = path.join(TMP, "signal-weights.json");
  const old = {
    weights: { organic_score: 1.4, fee_tvl_ratio: 0.7, volume: 1.1, mcap: 1, holder_count: 1, smart_wallets_present: 1.2, narrative_quality: 1, study_win_rate: 1, volatility: 0.9, ath_proximity: 1 },
    directions: { organic_score: "higher", smart_wallets_present: "absent=better" },
    last_recalc: "2026-09-01T00:00:00.000Z", recalc_count: 4, history: [],
  };
  fs.writeFileSync(file, JSON.stringify(old));
  const data = weights.loadWeights();
  assert.equal(data.weights.gmgn_buy_pressure, 1);
  assert.equal(data.weights.gmgn_spike, 1);
  assert.equal(data.weights.gmgn_signal_present, 1, "older additions backfilled too");
  assert.equal(data.weights.organic_score, 1.4, "learned weights kept");
  assert.equal(data.weights.fee_tvl_ratio, 0.7);
  assert.equal(data.directions.smart_wallets_present, "absent=better", "learned directions kept");
  assert.equal(data.directions.gmgn_buy_pressure, "present=better");
  assert.equal(data.directions.gmgn_spike, "absent=better", "spike prior: absent=better");
  assert.match(weights.getWeightsSummary(), /gmgn_buy_pressure/);
  // Loading does not rewrite the file; the next recalc persists.
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).weights.gmgn_spike, undefined);
  fs.rmSync(file);
});

test("recalculateWeights learns gmgn_buy_pressure / gmgn_spike from closed positions", () => {
  const file = path.join(TMP, "signal-weights.json");
  if (fs.existsSync(file)) fs.rmSync(file);
  const recorded_at = new Date().toISOString();
  const perf = [];
  // Buy pressure present → wins; spike present → losses (and vice versa).
  for (let i = 0; i < 12; i++) perf.push({ recorded_at, pnl_usd: 5, signal_snapshot: { gmgn_buy_pressure: true, gmgn_spike: false } });
  for (let i = 0; i < 12; i++) perf.push({ recorded_at, pnl_usd: -5, signal_snapshot: { gmgn_buy_pressure: false, gmgn_spike: true } });
  const { weights: w } = weights.recalculateWeights(perf, { darwin: { minSamples: 10, perSignalMinSamples: 12 } });
  const data = weights.loadWeights();
  assert.equal(data.directions.gmgn_buy_pressure, "present=better");
  assert.equal(data.directions.gmgn_spike, "absent=better");
  assert.ok(w.gmgn_buy_pressure > 0 && w.gmgn_spike > 0);
  assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).weights.gmgn_buy_pressure != null, "persisted by the recalc");
  fs.rmSync(file);
});

// ─── Config toggle ──────────────────────────────────────────────
test("gmgnSignalsEnabled defaults on and is listed for Telegram All settings", () => {
  assert.equal(config.screening.gmgnSignalsEnabled, true);
  const src = fs.readFileSync(path.join(REPO, "config.js"), "utf8");
  const entry = parseConfigKeys(src).find((e) => e.key === "gmgnSignalsEnabled");
  assert.deepEqual(entry, { key: "gmgnSignalsEnabled", file: "user", path: ["screening", "gmgnSignalsEnabled"] });
});

test("gmgn_spike starts as absent=better (spikes precede upside OOR for bid_ask)", async () => {
  const sw = await import("../signal-weights.js");
  const weightData = { weights: {}, directions: { gmgn_spike: "absent=better", gmgn_buy_pressure: "present=better" } };
  const withSpike = sw.scoreSignalSnapshot({ gmgn_spike: true }, { weightData, calibration: {} });
  const noSpike = sw.scoreSignalSnapshot({ gmgn_spike: false }, { weightData, calibration: {} });
  assert.ok(noSpike.score > withSpike.score, `no spike ${noSpike.score} should beat spike ${withSpike.score}`);
});
