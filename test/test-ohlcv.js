// Candle-based range depth (tools/ohlcv.js) + its deploy / Telegram wiring.
// Every source is mocked: no gmgn-cli spawn, no HTTP, no RPC.
process.env.DRY_RUN = "true";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const o = await import("../tools/ohlcv.js");
const { config } = await import("../config.js");
const dlmm = await import("../tools/dlmm.js");
const ui = await import("../telegram-ui.js");
const { calculateBinsForPriceRange, MIN_RANGE_PCT } = await import("../runtime-helpers.js");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-ohlcv-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const NOW_MS = Date.UTC(2026, 8, 25, 12, 0, 0);
const NOW = NOW_MS / 1000;
const MINT = "Mint1111111111111111111111111111111111111111";
const POOL = "Pool1111111111111111111111111111111111111111";

/** n flat candles of `tf` minutes ending now: h=101 l=99 c=100. */
const flat = (n, tf) => Array.from({ length: n }, (_, i) => ({ t: NOW - (n - i) * tf * 60, o: 100, h: 101, l: 99, c: 100, v: 1 }));

/* ─────────────── normalisation ─────────────── */

test("normalizeGmgn: ms times + string prices → ascending {t,o,h,l,c,v}", () => {
  const out = o.normalizeGmgn({ list: [
    { time: 1790345700000, open: "2", close: "3", high: "4", low: "1", volume: "10" },
    { time: 1790344800000, open: "1", close: "2", high: "2.5", low: "0.5", volume: "5" },
    { time: 1790344800000, open: "1", close: "2", high: "2.5", low: "0.5", volume: "5" }, // dup
    { time: 1790346600000, open: "0", close: "0", high: "0", low: "0", volume: "0" },     // junk
  ] });
  assert.deepEqual(out, [
    { t: 1790344800, o: 1, h: 2.5, l: 0.5, c: 2, v: 5 },
    { t: 1790345700, o: 2, h: 4, l: 1, c: 3, v: 10 },
  ]);
});

test("normalizeSolanaTracker: oclhv, seconds", () => {
  const out = o.normalizeSolanaTracker({ oclhv: [{ open: 1, close: 2, low: 0.9, high: 2.1, volume: 3, time: 1790278020 }] });
  assert.deepEqual(out, [{ t: 1790278020, o: 1, h: 2.1, l: 0.9, c: 2, v: 3 }]);
  assert.deepEqual(o.normalizeSolanaTracker({}), []);
});

test("normalizeGeckoTerminal: newest-first arrays → ascending", () => {
  const out = o.normalizeGeckoTerminal({ data: { attributes: { ohlcv_list: [
    [1790364300, 0.8, 0.9, 0.7, 0.75, 190],
    [1790364240, 0.7, 0.85, 0.65, 0.8, 100],
  ] } } });
  assert.deepEqual(out.map((c) => c.t), [1790364240, 1790364300]);
  assert.deepEqual(out[1], { t: 1790364300, o: 0.8, h: 0.9, l: 0.7, c: 0.75, v: 190 });
});

test("normalizeMeteora: data[].timestamp", () => {
  const out = o.normalizeMeteora({ start_time: 1, data: [{ timestamp: 1790361300, timestamp_str: "x", open: 9.8e-6, high: 9.9e-6, low: 8.7e-6, close: 8.9e-6, volume: 1676 }] });
  assert.deepEqual(out, [{ t: 1790361300, o: 9.8e-6, h: 9.9e-6, l: 8.7e-6, c: 8.9e-6, v: 1676 }]);
});

/* ─────────────── depth maths ─────────────── */

// 15m candles: peak high 121 then a low of 84.7 → 30% drawdown; last close 108.
const DD_FIXTURE = [
  [101, 99, 100], [111, 100, 110], [121, 109, 120], [120, 95, 100], [101, 84.7, 90], [96, 89, 95],
  [101, 94, 100], [106, 99, 105], [111, 104, 110], [110, 106, 108], [109, 105, 106], [109, 105, 108],
].map(([h, l, c], i) => ({ t: NOW - (12 - i) * 900, o: c, h, l, c, v: 1 }));

function expectedAtrPct(cs) {
  let s = 0;
  cs.forEach((c, i) => {
    const p = i ? cs[i - 1].c : null;
    s += (p == null ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - p), Math.abs(c.l - p))) / c.c;
  });
  return (s / cs.length) * 100;
}

test("depthFromCandles: max drawdown on highs/lows, toLow and ATR", () => {
  const d = o.depthFromCandles(DD_FIXTURE, { timeframeMinutes: 15, source: "gmgn", window: "15m·last 3h" });
  assert.equal(d.basis.maxDrawdownPct, 30);
  assert.equal(d.basis.toLowPct, Math.round(((108 - 84.7) / 108) * 1000) / 10); // 21.6
  const atr = expectedAtrPct(DD_FIXTURE);
  assert.ok(Math.abs(d.basis.atrPct - atr) < 0.01, `${d.basis.atrPct} vs ${atr}`);
  const slack = Math.min(atr * 2, 10); // sqrt(60/15) = 2
  assert.equal(d.depthPct, Math.round(30 * 1.3 + slack));
  assert.equal(d.basis.source, "gmgn");
  assert.equal(d.basis.candles, 12);
  assert.match(d.short, /^15m·last 3h drawdown 30% ×1\.3, gmgn$/);
  assert.match(d.reason, /drawdown 30% × 1\.3 \+ ATR slack/);
});

test("depthFromCandles: toLow counts at half weight (a rally isn't a drawdown)", () => {
  // Steady 2x rally, no pullback: drawdown ≈ 2%, toLow ≈ 50% → 25% weighted.
  const cs = Array.from({ length: 20 }, (_, i) => {
    const c = 100 + i * 5.3;
    return { t: NOW - (20 - i) * 900, o: c - 5.3, h: c + 0.5, l: c - 5.3, c, v: 1 };
  });
  const d = o.depthFromCandles(cs, { timeframeMinutes: 15 });
  assert.ok(d.basis.toLowPct > 49);
  assert.match(d.reason, /to-low×0\.5/);
  assert.ok(d.basis.rawPct < d.basis.toLowPct * 1.3, "not the full toLow");
});

test("depthFromCandles: clamps to MIN_RANGE_PCT and maxPct", () => {
  const calm = o.depthFromCandles(flat(12, 15), { timeframeMinutes: 15 });
  assert.equal(calm.depthPct, MIN_RANGE_PCT);
  assert.match(calm.reason, /floored at 35%/);
  const crash = [...flat(10, 15)];
  crash.push({ t: NOW, o: 100, h: 100, l: 10, c: 12, v: 1 });
  assert.equal(o.depthFromCandles(crash, { timeframeMinutes: 15 }).depthPct, 80);
  assert.equal(o.depthFromCandles(crash, { timeframeMinutes: 15, maxPct: 70 }).depthPct, 70);
  assert.match(o.depthFromCandles(crash, { timeframeMinutes: 15 }).reason, /capped at 80%/);
});

test("depthFromCandles: null below ~60 minutes of history or 10 candles", () => {
  assert.equal(o.depthFromCandles(flat(59, 1), { timeframeMinutes: 1 }), null, "59 min");
  assert.ok(o.depthFromCandles(flat(60, 1), { timeframeMinutes: 1 }), "60 min is enough");
  assert.equal(o.depthFromCandles(flat(9, 15), { timeframeMinutes: 15 }), null, "9 candles");
  assert.equal(o.depthFromCandles([], {}), null);
  assert.equal(o.depthFromCandles(null, {}), null);
});

test("1m candles: ATR slack scales by sqrt(60/tf) and is capped at 10", () => {
  // Same candle shape at 1m and 15m: 2% ATR per bar.
  const m1 = o.depthFromCandles(flat(90, 1), { timeframeMinutes: 1 });
  const m15 = o.depthFromCandles(flat(12, 15), { timeframeMinutes: 15 });
  assert.equal(m1.basis.atrPct, 2);
  assert.equal(m15.basis.slackPct, 4);          // 2 × sqrt(4)
  assert.equal(m1.basis.slackPct, 10);          // 2 × sqrt(60) = 15.5 → capped
  assert.equal(m1.basis.timeframe, "1m");
  // Small 1m ATR: 0.2% × sqrt(60) = 1.5 slack.
  const quiet = flat(90, 1).map((c) => ({ ...c, h: 100.1, l: 99.9 }));
  assert.equal(o.depthFromCandles(quiet, { timeframeMinutes: 1 }).basis.slackPct, 1.5);
});

/* ─────────────── tiers ─────────────── */

test("pickTier: every age boundary", () => {
  const tf = (age) => { const t = o.pickTier(age); return `${t.timeframe}/${t.lookbackHours}${t.fullLife ? "/life" : ""}`; };
  assert.equal(tf(0), "1m/6/life");
  assert.equal(tf(5.99), "1m/6/life");
  assert.equal(tf(6), "1m/12");
  assert.equal(tf(23.99), "1m/12");
  assert.equal(tf(24), "5m/72/life");
  assert.equal(tf(71.99), "5m/72/life");
  assert.equal(tf(72), "15m/72");
  assert.equal(tf(10_000), "15m/72");
  assert.equal(tf(null), "15m/72", "unknown age → oldest tier");
});

test("pickTier: config override (ohlcvTiers) replaces the table; junk falls back", () => {
  const tiers = [{ maxAgeHours: 48, timeframe: "5m", lookbackHours: 24 }, { maxAgeHours: null, timeframe: "1h", lookbackHours: 168 }];
  assert.equal(o.pickTier(10, tiers).timeframe, "5m");
  assert.equal(o.pickTier(50, tiers).timeframe, "1h");
  assert.equal(o.pickTier(10, [{ timeframe: "7m" }]).timeframe, "1m");
});

test("planWindow: per tier and source (paging budget, 7d when one request)", () => {
  const S = o.SOURCE_SPECS;
  const plan = (src, age) => o.planWindow(S[src], o.pickTier(age), age, NOW);
  // < 6h: 1m full life
  assert.equal(plan("gmgn", 5.5).label, "1m·full life 5.5h");
  assert.equal(plan("gmgn", 5.5).fromSec, Math.floor(NOW - 5.75 * 3600));
  assert.equal(plan("meteora", 5.5).label, "5m·full life 5.5h", "meteora has no 1m");
  // 6–24h: 1m last 12h (720 candles: 8 GMGN pages, 1 GT/ST request)
  assert.equal(plan("gmgn", 6).label, "1m·last 12h");
  assert.equal(plan("geckoterminal", 23.99).label, "1m·last 12h");
  // 1–3d: 5m full life
  assert.equal(plan("gmgn", 24).label, "5m·full life 24h");
  assert.equal(plan("solanatracker", 40).label, "5m·full life 40h");
  assert.equal(plan("gmgn", 71.99).label, "5m·last 3d");
  // > 3d: 15m 72h, 7d when the source returns it in one request
  assert.equal(plan("gmgn", 72).label, "15m·last 3d", "GMGN would need 7 pages for 7d");
  assert.equal(plan("geckoterminal", 72).label, "15m·last 7d");
  assert.equal(plan("solanatracker", 500).label, "15m·last 7d");
  assert.equal(plan("meteora", 500).label, "30m·last 3d");
  // A window over the paging budget coarsens the bar instead of paging forever.
  const tight = { ...S.gmgn, maxPages: 2 };
  assert.equal(o.planWindow(tight, o.pickTier(10), 10, NOW).resMin, 5);
});

/* ─────────────── sources: order, fallbacks, budgets ─────────────── */

function gmgnPage(n, tfSec, endSec) {
  return { list: Array.from({ length: n }, (_, i) => ({ time: (endSec - (n - 1 - i) * tfSec) * 1000, open: "1", close: "1", high: "1.01", low: "0.99", volume: "1" })) };
}
const res = (json, status = 200) => ({ ok: status === 200, status, json: async () => json });

function harness({ gmgn = () => null, http = () => res(null, 404), key = "", usage = null, age = 30 } = {}) {
  const calls = { gmgn: [], http: [], logs: [] };
  const usagePath = path.join(TMP, `usage-${Math.random().toString(36).slice(2)}.json`);
  if (usage) fs.writeFileSync(usagePath, JSON.stringify(usage));
  const inst = o.createOhlcv({
    now: () => NOW_MS,
    env: key ? { SOLANATRACKER_API_KEY: key } : {},
    getConfig: () => ({ strategy: { maxRangePct: 80, ohlcvBufferMult: 1.3, solanaTrackerDailyCap: 3 } }),
    spawnGmgn: async (args) => { calls.gmgn.push(args); return gmgn(args); },
    fetch: async (url, opts) => { calls.http.push({ url, headers: opts?.headers }); return http(url); },
    getTokenAgeHours: async () => age,
    usagePath,
    log: (c, m) => calls.logs.push(m),
  });
  return { inst, calls, usagePath };
}
const hostOf = (u) => new URL(u).host;

test("GMGN first: token candles, paged backwards; nothing else called", async () => {
  // age 30h → 5m full life 30.25h = 363 bars → 4 GMGN pages of 100.
  const h = harness({ gmgn: (a) => gmgnPage(100, 300, Number(a[a.indexOf("--to") + 1])) });
  const d = await h.inst.getOhlcvDepth({ pool: POOL, mint: MINT });
  assert.equal(d.basis.source, "gmgn");
  assert.equal(d.basis.tier, "5m·full life 30h");
  assert.equal(h.calls.gmgn.length, 4);
  assert.ok(h.calls.gmgn.every((a) => a.includes("--resolution") && a[a.indexOf("--resolution") + 1] === "5m"));
  assert.equal(h.calls.http.length, 0, "no fallback when GMGN is enough");
  // cached for the next caller
  await h.inst.getOhlcvDepth({ pool: POOL, mint: MINT });
  assert.equal(h.calls.gmgn.length, 4);
});

test("fallback order: gmgn → (no key: SolanaTracker skipped quietly) → geckoterminal → meteora", async () => {
  const hosts = [];
  const h = harness({
    http: (url) => {
      hosts.push(hostOf(url));
      if (url.includes("geckoterminal")) return res(null, 429);
      if (url.includes("meteora")) {
        const u = new URL(url);
        const from = Number(u.searchParams.get("start_time")), to = Number(u.searchParams.get("end_time"));
        const data = [];
        for (let t = from - (from % 300) + 300; t <= to; t += 300) data.push({ timestamp: t, open: 1, high: 1.02, low: 0.98, close: 1, volume: 1 });
        return res({ data });
      }
      return res(null, 404);
    },
  });
  const d = await h.inst.getOhlcvDepth({ pool: POOL, mint: MINT });
  assert.equal(d.basis.source, "meteora");
  assert.equal(d.basis.level, "pool");
  assert.ok(h.calls.gmgn.length >= 1, "GMGN tried first");
  assert.ok(!hosts.includes("data.solanatracker.io"), "no key → never called");
  assert.equal(hosts[0], "api.geckoterminal.com");
  assert.ok(h.calls.logs.some((m) => /GeckoTerminal rate limited/.test(m)));
});

test("SolanaTracker: used only after GMGN fails, x-api-key header, one call, cached per mint", async () => {
  const h = harness({
    key: "free-key",
    gmgn: () => ({ list: [] }),
    http: (url) => {
      if (!url.includes("solanatracker")) return res(null, 404);
      const u = new URL(url);
      const from = Number(u.searchParams.get("time_from")), to = Number(u.searchParams.get("time_to"));
      const oclhv = [];
      for (let t = from; t <= to; t += 300) oclhv.push({ open: 1, close: 1, low: 0.97, high: 1.03, volume: 1, time: t });
      return res({ oclhv });
    },
  });
  const d = await h.inst.getOhlcvDepth({ pool: POOL, mint: MINT });
  assert.equal(d.basis.source, "solanatracker");
  const st = h.calls.http.filter((c) => c.url.includes("solanatracker"));
  assert.equal(st.length, 1);
  assert.equal(st[0].headers["x-api-key"], "free-key");
  assert.match(st[0].url, /\/chart\/Mint1+\?type=5m&time_from=\d+&time_to=\d+/);
  assert.ok(h.calls.logs.some((m) => /SolanaTracker call 1\/3 today/.test(m)), "each call is logged");
  // Another pool of the same token: ST answer comes from the 30-min mint cache.
  await h.inst.getOhlcvDepth({ pool: "Other111111111111111111111111111111111111111", mint: MINT });
  assert.equal(h.calls.http.filter((c) => c.url.includes("solanatracker")).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(h.usagePath, "utf8")).count, 1, "usage persisted");
});

test("SolanaTracker: daily cap reached → skipped, falls through", async () => {
  const today = new Date(NOW_MS).toISOString().slice(0, 10);
  const h = harness({ key: "k", usage: { date: today, count: 3 } });
  const d = await h.inst.getOhlcvDepth({ pool: POOL, mint: MINT });
  assert.equal(d, null);
  assert.ok(!h.calls.http.some((c) => c.url.includes("solanatracker")));
  assert.ok(h.calls.logs.some((m) => /daily cap reached \(3\/3\)/.test(m)));
  // A new UTC day resets the count.
  const h2 = harness({ key: "k", usage: { date: "2000-01-01", count: 99 } });
  await h2.inst.getOhlcvDepth({ pool: POOL, mint: MINT });
  assert.ok(h2.calls.http.some((c) => c.url.includes("solanatracker")));
});

test("GeckoTerminal: thin candidate pool → token's top pool, Accept header versioned", async () => {
  const TOP = "TopPool11111111111111111111111111111111111111";
  const series = (n) => ({ data: { attributes: { ohlcv_list: Array.from({ length: n }, (_, i) => [NOW - i * 60, 1, 1.05, 0.95, 1, 1]) } } });
  const h = harness({
    age: 10,
    http: (url) => {
      if (url.includes(`/pools/${POOL}/ohlcv/minute`)) return res(series(30));  // 30 min: thin
      if (url.includes(`/tokens/${MINT}/pools`)) return res({ data: [{ attributes: { address: POOL } }, { attributes: { address: TOP } }] });
      if (url.includes(`/pools/${TOP}/ohlcv/minute`)) return res(series(700));
      return res(null, 404);
    },
  });
  const d = await h.inst.getOhlcvDepth({ pool: POOL, mint: MINT });
  assert.equal(d.basis.source, "geckoterminal");
  assert.equal(d.basis.pool, TOP);
  assert.equal(d.basis.tier, "1m·last 12h");
  const gt = h.calls.http.filter((c) => c.url.includes("geckoterminal"));
  assert.ok(gt.every((c) => c.headers.Accept === "application/json;version=20230302"));
  assert.match(gt[0].url, /aggregate=1&limit=720&before_timestamp=\d+&currency=usd/);
});

test("never throws: every source failing → null", async () => {
  const h = harness({ gmgn: () => { throw new Error("boom"); }, http: () => { throw new Error("net down"); } });
  assert.equal(await h.inst.getOhlcvDepth({ pool: POOL, mint: MINT }), null);
  assert.equal(await h.inst.getOhlcvDepth({}), null);
});

test("launch prints (first 15 min after creation) are ignored", async () => {
  // Token 2h old; launch minute wicks from 1 → 10, then trades flat at 5.
  const created = NOW - 2 * 3600;
  const list = [{ time: created * 1000, open: "1", close: "8", high: "10", low: "1", volume: "1" }];
  for (let t = created + 20 * 60; t <= NOW; t += 60) list.push({ time: t * 1000, open: "5", close: "5", high: "5.05", low: "4.95", volume: "1" });
  const h = harness({ age: 2, gmgn: () => ({ list }) });
  const d = await h.inst.getOhlcvDepth({ mint: MINT });
  assert.ok(d.basis.maxDrawdownPct < 5, `launch wick excluded (${d.basis.maxDrawdownPct})`);
});

/* ─────────────── deploy_position widening ─────────────── */

config.strategy.activeStrategy = "classic";
const DPOOL = "OhlcvDeployPool1111111111111111111111111111";
const deploy = (args) => dlmm.deployPosition({ pool_address: DPOOL, amount_y: 1, strategy: "bid_ask", bin_step: 100, ...args });
const primed = (depthPct) => o.primeOhlcvDepth({ pool: DPOOL, mint: null }, { depthPct, reason: `test ${depthPct}%`, short: "test", basis: {} });

test("deploy: a range shallower than the candle depth is widened to it", async () => {
  config.strategy.rangeDepthMode = "ohlcv";
  config.strategy.maxRangePct = 80;
  primed(62);
  const r = await deploy({ price_range_pct: 45 });
  assert.equal(r.would_deploy.bins_below, calculateBinsForPriceRange(100, 62));
});

test("deploy: a deeper requested range is kept; depth never exceeds maxRangePct", async () => {
  config.strategy.rangeDepthMode = "ohlcv";
  config.strategy.maxRangePct = 80;
  primed(62);
  assert.equal((await deploy({ price_range_pct: 70 })).would_deploy.bins_below, calculateBinsForPriceRange(100, 70));
  config.strategy.maxRangePct = 70;
  primed(78);
  assert.equal((await deploy({ price_range_pct: 50 })).would_deploy.bins_below, calculateBinsForPriceRange(100, 70));
  config.strategy.maxRangePct = 80;
});

test("deploy: volatility mode or no depth → range untouched (MIN_RANGE_PCT still applies)", async () => {
  primed(62);
  config.strategy.rangeDepthMode = "volatility";
  assert.equal((await deploy({ price_range_pct: 45 })).would_deploy.bins_below, calculateBinsForPriceRange(100, 45));
  config.strategy.rangeDepthMode = "ohlcv";
  o.primeOhlcvDepth({ pool: DPOOL, mint: null }, null);
  assert.equal((await deploy({ price_range_pct: 45 })).would_deploy.bins_below, calculateBinsForPriceRange(100, 45));
  assert.equal((await deploy({ price_range_pct: 20 })).would_deploy.bins_below, calculateBinsForPriceRange(100, MIN_RANGE_PCT));
});

/* ─────────────── Telegram Auto ─────────────── */

const cand = (extra = {}) => ({ pool: POOL, name: "YAP-SOL", bin_step: 100, volatility: 3.2, ...extra });
const DEPTH = { depthPct: 62, basis: "24h drawdown 48% ×1.3, meteora" };

test("Telegram Auto: uses the candle depth and shows its basis", () => {
  const c = cand({ ohlcv_depth: DEPTH });
  assert.equal(ui.autoRange(c, "bid_ask").text, "Auto 62% (24h drawdown 48% ×1.3, meteora)");
  const opts = ui.rangeOptions(c, "bid_ask");
  assert.deepEqual(opts.map((x) => x.label), ["Auto (62%)", "25% → 62% depth", "50% → 62% depth", "80%"]);
  const step = ui.renderRangeStep(c, "s1", "bid_ask");
  assert.match(step.text, /Auto 62% \(24h drawdown 48% ×1\.3, meteora\)/);
  assert.match(step.text, /shallower than the 62% candle depth/);
});

test("Telegram Auto: without a depth it stays on the volatility table", () => {
  const c = cand({ ohlcv_depth: null });
  const pct = ui.rangeForVolatility(3.2, "bid_ask");
  assert.equal(ui.autoRange(c, "bid_ask").text, `Auto ${pct}% (volatility 3.2)`);
  assert.equal(ui.rangeOptions(c, "bid_ask")[0].label, `Auto (${pct}%)`);
});

test("Telegram deploy plan + card: default range = depth; card shows the depth line", () => {
  const cfg = { strategy: { activeStrategy: "classic", strategy: "bid_ask" }, usdc: {} };
  const c = cand({ ohlcv_depth: DEPTH });
  const plan = ui.buildDeployPlan(c, { wallet: { sol: 5 }, config: cfg, computeDeployAmount: () => 1 });
  assert.equal(plan.args.price_range_pct, 62);
  const card = ui.renderDeployConfirm(c, plan, "n1", {});
  assert.match(card.text, /Candle depth: 62% \(24h drawdown 48% ×1\.3, meteora\)/);
  // A manual 50% pick is shown widened to the depth, as deploy_position will do.
  const manual = ui.buildDeployPlan(c, { wallet: { sol: 5 }, config: cfg, computeDeployAmount: () => 1, priceRangePct: 50 });
  assert.match(ui.renderDeployConfirm(c, manual, "n2", {}).text, /50% requested → deploy widens it to the 62% candle depth/);
});
