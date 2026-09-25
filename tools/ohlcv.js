/**
 * Candle-based range depth (rangeDepthMode "ohlcv").
 *
 * Fetches OHLCV candles for a token/pool and turns them into a recommended
 * downside range depth for a single-sided SOL position (bid_ask / spot).
 *
 * SOURCES (tried in order; the first one with enough history wins):
 *   1. gmgn          token-level. `gmgn-cli market kline` (/v1/market/token_kline).
 *                    Resolutions 1m/5m/15m/1h/4h/1d, returns at most 100 candles per
 *                    call (the latest 100 in [from, to]), so windows are paged.
 *   2. solanatracker token-level. GET https://data.solanatracker.io/chart/{mint}
 *                    ?type=1m&time_from=&time_to=, header x-api-key. Free plan: a
 *                    monthly credit cap, so it is a FALLBACK ONLY (after GMGN fails),
 *                    cached 30 min per mint, capped per day (solanaTrackerDailyCap)
 *                    and skipped quietly when SOLANATRACKER_API_KEY is unset. One call
 *                    returns the whole window (1,416 x 1m candles for 24h verified).
 *   3. geckoterminal pool-level, free/no key. GET https://api.geckoterminal.com/api/v2
 *                    /networks/solana/pools/{pool}/ohlcv/{minute|hour}?aggregate=&limit=
 *                    (<= 1000 per call, newest first). If the candidate pool is thin
 *                    (short history) the token's top pool is used instead, via
 *                    /networks/solana/tokens/{mint}/pools. ~10-30 req/min public limit:
 *                    a sliding-window limiter skips (never queues) past the budget.
 *   4. meteora       pool-level. GET https://dlmm.datapi.meteora.ag/pools/{pool}/ohlcv
 *                    ?timeframe=5m|30m|1h&start_time=&end_time= ("time range too large"
 *                    past ~96 candles, so windows are paged). A new pool has little
 *                    history even when the token trades elsewhere, hence last.
 *
 * Every source is normalised to [{ t, o, h, l, c, v }] ascending (t = unix seconds).
 * Every HTTP request / CLI spawn has a ~5s timeout and nothing here ever throws:
 * failures return null so callers fall back to the volatility table.
 *
 * TIMEFRAME BY TOKEN AGE (DEFAULT_OHLCV_TIERS, overridable with config
 * strategy.ohlcvTiers):
 *   age < 6h   -> 1m,  full life
 *   6h - 24h   -> 1m,  last 12h
 *   1 - 3 days -> 5m,  full life (<= 72h)
 *   > 3 days   -> 15m, last 72h (7 days when the source returns it in one request)
 * Age comes from the caller (GMGN token_age_hours), else GMGN token info, else the
 * first candle of a provisional fetch.
 *
 * DEPTH FORMULA (depthFromCandles):
 *   maxDrawdown = largest (running peak HIGH -> later LOW) fall, in %   (wicks count)
 *   toLow       = (last close - window LOW) / last close, in %
 *   ATR%        = mean true range / close, in %, per candle
 *   slack       = min(ATR% x sqrt(60 / timeframeMinutes), 10)   (≈ one hour's typical move,
 *                 so a 1m and a 15m series give comparable slack)
 *   depth       = clamp(round(max(maxDrawdown, 0.5 x toLow) x bufferMult + slack),
 *                       MIN_RANGE_PCT, maxRangePct)
 * toLow is weighted 0.5 (a half-retrace of the window's whole rally): unweighted, any
 * token that doubled in the window reads ≥ 50% and every uptrend pins to the max.
 * The first 15 minutes after the token's creation are dropped (launch/sniper prints).
 * Needs >= 60 minutes of history (and >= 10 candles); otherwise null.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log as defaultLog } from "../logger.js";
import { MIN_RANGE_PCT } from "../runtime-helpers.js";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const TIMEFRAME_MINUTES = { "1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240 };

/**
 * Token age -> candle timeframe / lookback. First tier whose maxAgeHours is
 * greater than the age wins (null = no upper bound).
 *  - fullLife: lookback = the token's age (capped at lookbackHours).
 *  - maxLookbackHours: widen to this when the source returns it in ONE request.
 */
export const DEFAULT_OHLCV_TIERS = [
  { maxAgeHours: 6, timeframe: "1m", lookbackHours: 6, fullLife: true },
  { maxAgeHours: 24, timeframe: "1m", lookbackHours: 12 },
  { maxAgeHours: 72, timeframe: "5m", lookbackHours: 72, fullLife: true },
  { maxAgeHours: null, timeframe: "15m", lookbackHours: 72, maxLookbackHours: 168 },
];

export const OHLCV_DEFAULTS = {
  bufferMult: 1.3,
  toLowWeight: 0.5,
  launchSkipMinutes: 15,
  minHistoryMinutes: 60,
  minCandles: 10,
  slackCapPct: 10,
};

const REQUEST_TIMEOUT_MS = 5_000;
const DEPTH_CACHE_TTL_MS = 5 * 60_000;
const DEPLOY_STALE_OK_MS = 20 * 60_000; // deploy may use a screening-time depth this old
const DEPLOY_FETCH_BUDGET_MS = 8_000;
const ST_CACHE_TTL_MS = 30 * 60_000;
const GT_WINDOW_MS = 60_000;
const GT_MAX_PER_WINDOW = 20;
const GT_COOLDOWN_MS = 60_000;
const MAX_CONCURRENT_DEPTHS = 2;

const GT_BASE = "https://api.geckoterminal.com/api/v2";
const GT_HEADERS = { Accept: "application/json;version=20230302" };
const ST_BASE = "https://data.solanatracker.io";
const METEORA_BASE = "https://dlmm.datapi.meteora.ag/pools";
const WSOL = "So11111111111111111111111111111111111111112";

/* ─────────────────────────── normalisation ─────────────────────────── */

const num = (v) => {
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
};

/** Sort ascending, drop duplicates / non-positive prices. */
export function cleanCandles(list) {
  const byT = new Map();
  for (const c of list || []) {
    if (!c) continue;
    const t = num(c.t), o = num(c.o), h = num(c.h), l = num(c.l), cl = num(c.c);
    if (!(t > 0 && h > 0 && l > 0 && cl > 0)) continue;
    byT.set(t, { t, o: o > 0 ? o : cl, h: Math.max(h, l, cl), l: Math.min(l, h, cl), c: cl, v: num(c.v) || 0 });
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/** gmgn-cli kline: { list: [{ time(ms), open, close, high, low, volume }] } (strings). */
export function normalizeGmgn(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.list) ? json.list : [];
  return cleanCandles(list.map((c) => ({
    t: num(c?.time) > 1e12 ? Math.floor(num(c.time) / 1000) : num(c?.time),
    o: c?.open, h: c?.high, l: c?.low, c: c?.close, v: c?.volume,
  })));
}

/** SolanaTracker /chart: { oclhv: [{ open, close, low, high, volume, time(s) }] }. */
export function normalizeSolanaTracker(json) {
  const list = Array.isArray(json?.oclhv) ? json.oclhv : [];
  return cleanCandles(list.map((c) => ({ t: c?.time, o: c?.open, h: c?.high, l: c?.low, c: c?.close, v: c?.volume })));
}

/** GeckoTerminal: data.attributes.ohlcv_list = [[t, o, h, l, c, v], ...] newest first. */
export function normalizeGeckoTerminal(json) {
  const list = json?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  return cleanCandles(list.map((r) => (Array.isArray(r) ? { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] } : null)));
}

/** Meteora DLMM data API: { data: [{ timestamp, open, high, low, close, volume }] }. */
export function normalizeMeteora(json) {
  const list = Array.isArray(json?.data) ? json.data : [];
  return cleanCandles(list.map((c) => ({ t: c?.timestamp, o: c?.open, h: c?.high, l: c?.low, c: c?.close, v: c?.volume })));
}

/* ─────────────────────────── depth maths ─────────────────────────── */

const round1 = (x) => Math.round(x * 10) / 10;

function inferTimeframeMinutes(cs) {
  const gaps = [];
  for (let i = 1; i < cs.length; i++) gaps.push(cs[i].t - cs[i - 1].t);
  gaps.sort((a, b) => a - b);
  const g = gaps.length ? gaps[0] : 60; // smallest gap = the bar size (sparse feeds skip bars)
  return Math.max(1, Math.round(g / 60));
}

export function fmtHours(h) {
  if (!(h > 0)) return "0h";
  if (h >= 48 && Number.isInteger(h / 24)) return `${h / 24}d`;
  return h >= 10 ? `${Math.round(h)}h` : `${round1(h)}h`;
}

/**
 * Pure: candles -> recommended downside depth. Returns null with too little
 * history so the caller falls back to the volatility table.
 * cfg: { bufferMult, minPct, maxPct, minHistoryMinutes, minCandles, slackCapPct,
 *        timeframeMinutes, source, window }
 */
export function depthFromCandles(candles, cfg = {}) {
  const cs = cleanCandles(candles);
  const bufferMult = num(cfg.bufferMult) > 0 ? num(cfg.bufferMult) : OHLCV_DEFAULTS.bufferMult;
  const minPct = num(cfg.minPct) > 0 ? num(cfg.minPct) : MIN_RANGE_PCT;
  const maxPct = num(cfg.maxPct) > minPct ? num(cfg.maxPct) : 80;
  const minHistoryMinutes = num(cfg.minHistoryMinutes) >= 0 ? num(cfg.minHistoryMinutes) : OHLCV_DEFAULTS.minHistoryMinutes;
  const minCandles = num(cfg.minCandles) > 0 ? num(cfg.minCandles) : OHLCV_DEFAULTS.minCandles;
  const slackCapPct = num(cfg.slackCapPct) >= 0 ? num(cfg.slackCapPct) : OHLCV_DEFAULTS.slackCapPct;
  const toLowWeight = num(cfg.toLowWeight) >= 0 ? num(cfg.toLowWeight) : OHLCV_DEFAULTS.toLowWeight;
  if (cs.length < minCandles || cs.length < 2) return null;

  const tfMin = num(cfg.timeframeMinutes) > 0 ? num(cfg.timeframeMinutes) : inferTimeframeMinutes(cs);
  const spanMinutes = (cs.at(-1).t - cs[0].t) / 60 + tfMin;
  if (spanMinutes < minHistoryMinutes) return null;

  // Max drawdown on highs/lows: running peak HIGH (including the current bar,
  // so an intra-bar wick down counts) to the LOW that follows.
  let peak = 0;
  let maxDrawdownPct = 0;
  let windowLow = Infinity;
  for (const c of cs) {
    if (c.h > peak) peak = c.h;
    const dd = ((peak - c.l) / peak) * 100;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    if (c.l < windowLow) windowLow = c.l;
  }
  const last = cs.at(-1).c;
  const toLowPct = Math.max(0, ((last - windowLow) / last) * 100);

  // ATR% per bar (true range / close), first bar uses high-low.
  let trSum = 0;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    const prev = i > 0 ? cs[i - 1].c : null;
    const tr = prev == null ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev));
    trSum += tr / c.c;
  }
  const atrPct = (trSum / cs.length) * 100;
  const slackPct = Math.min(atrPct * Math.sqrt(60 / tfMin), slackCapPct);

  const weightedToLow = toLowPct * toLowWeight;
  const driverPct = Math.max(maxDrawdownPct, weightedToLow);
  const driver = weightedToLow > maxDrawdownPct ? `to-low×${toLowWeight}` : "drawdown";
  const rawPct = driverPct * bufferMult + slackPct;
  const depthPct = Math.min(maxPct, Math.max(minPct, Math.round(rawPct)));
  const clamp = rawPct > maxPct ? ` capped at ${maxPct}%` : rawPct < minPct ? ` floored at ${minPct}%` : "";

  const source = cfg.source ?? null;
  const window = cfg.window ?? fmtHours(spanMinutes / 60);
  const basis = {
    source,
    window,
    timeframe: `${tfMin}m`,
    candles: cs.length,
    spanHours: round1(spanMinutes / 60),
    maxDrawdownPct: round1(maxDrawdownPct),
    toLowPct: round1(toLowPct),
    atrPct: round1(atrPct * 100) / 100,
    slackPct: round1(slackPct),
    bufferMult,
    rawPct: round1(rawPct),
  };
  const short = `${window} ${driver} ${Math.round(driverPct)}% ×${bufferMult}${source ? `, ${source}` : ""}`;
  const reason = `${driver} ${round1(driverPct)}% × ${bufferMult} + ATR slack ${round1(slackPct)}% = ${round1(rawPct)}%${clamp} → ${depthPct}% (${source ?? "candles"} ${window}, ${cs.length} candles)`;
  return { depthPct, basis, reason, short };
}

/* ─────────────────────────── tiers ─────────────────────────── */

export function normalizeTiers(tiers) {
  if (!Array.isArray(tiers) || !tiers.length) return DEFAULT_OHLCV_TIERS;
  const ok = tiers.filter((t) => t && TIMEFRAME_MINUTES[t.timeframe] && num(t.lookbackHours) > 0);
  return ok.length ? ok : DEFAULT_OHLCV_TIERS;
}

/** Tier for an age in hours (null/unknown -> the last, oldest tier). */
export function pickTier(ageHours, tiers = DEFAULT_OHLCV_TIERS) {
  const list = normalizeTiers(tiers);
  if (!(num(ageHours) >= 0)) return list.at(-1);
  return list.find((t) => t.maxAgeHours == null || num(ageHours) < num(t.maxAgeHours)) ?? list.at(-1);
}

/* ─────────────────────────── sources ─────────────────────────── */

/**
 * Source specs. `res` = supported bar sizes (minutes, ascending); `perReq` =
 * candles one request returns; `maxPages` = paging budget per token.
 */
export const SOURCE_SPECS = {
  gmgn: { res: [1, 5, 15, 60, 240], perReq: 100, maxPages: 10, level: "token" },
  solanatracker: { res: [1, 5, 15, 30, 60, 240], perReq: Infinity, maxPages: 1, level: "token" },
  geckoterminal: { res: [1, 5, 15, 60, 240], perReq: 1000, maxPages: 2, level: "pool" },
  meteora: { res: [5, 30, 60, 120, 240], perReq: 96, maxPages: 10, level: "pool" },
};

const resLabel = (m) => (m >= 60 ? `${m / 60}h` : `${m}m`);

/**
 * Window + bar size for one source: the tier's timeframe (or the next coarser
 * one the source supports), coarsened further if the window would need more
 * pages than the source's budget; widened to maxLookbackHours when that still
 * fits in one request.
 */
export function planWindow(spec, tier, ageHours, nowSec) {
  const wantRes = TIMEFRAME_MINUTES[tier.timeframe] ?? 15;
  const known = num(ageHours) >= 0;
  let lookbackH = tier.fullLife && known ? Math.min(num(ageHours) + 0.25, tier.lookbackHours) : tier.lookbackHours;
  const pages = (res, h) => Math.ceil((h * 60) / res / spec.perReq);
  let resMin = spec.res.find((r) => r >= wantRes) ?? spec.res.at(-1);
  while (pages(resMin, lookbackH) > spec.maxPages) {
    const next = spec.res.find((r) => r > resMin);
    if (!next) break;
    resMin = next;
  }
  if (tier.maxLookbackHours > lookbackH && pages(resMin, tier.maxLookbackHours) <= 1) lookbackH = tier.maxLookbackHours;
  const fullLife = tier.fullLife && known && num(ageHours) + 0.25 <= tier.lookbackHours;
  const window = fullLife ? `full life ${fmtHours(num(ageHours))}` : `last ${fmtHours(lookbackH)}`;
  return {
    resMin,
    fromSec: Math.floor(nowSec - lookbackH * 3600),
    toSec: Math.floor(nowSec),
    lookbackHours: lookbackH,
    label: `${resLabel(resMin)}·${window}`,
  };
}

/** Page a window backwards: fetchPage({ from, to, resMin, limit }) -> candles | null. */
async function pagedFetch(fetchPage, plan, spec) {
  const out = [];
  let to = plan.toSec;
  const chunk = Number.isFinite(spec.perReq) ? spec.perReq * plan.resMin * 60 : Infinity;
  for (let i = 0; i < spec.maxPages; i++) {
    const from = Number.isFinite(chunk) ? Math.max(plan.fromSec, to - chunk + 1) : plan.fromSec;
    const limit = Math.max(1, Math.ceil((to - from) / (plan.resMin * 60)));
    const page = await fetchPage({ from, to, resMin: plan.resMin, limit });
    if (!page) {
      if (i === 0) return null;
      break;
    }
    out.push(...page);
    if (from <= plan.fromSec || page.length === 0) break;
    to = from - 1;
  }
  return cleanCandles(out).filter((c) => c.t >= plan.fromSec - plan.resMin * 60 && c.t <= plan.toSec);
}

/* ─────────────────────────── factory ─────────────────────────── */

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * deps (all optional, injected by tests):
 *   fetch, spawnGmgn(args) -> json|null, getTokenAgeHours(mint) -> number|null,
 *   now() -> ms, env, getConfig() -> config, usagePath, log,
 *   offline (true = never fetch; cache/prime only)
 */
export function createOhlcv(deps = {}) {
  const doFetch = deps.fetch ?? ((...a) => globalThis.fetch(...a));
  const now = deps.now ?? (() => Date.now());
  const env = deps.env ?? process.env;
  const log = deps.log ?? defaultLog;
  const getConfig = deps.getConfig ?? (() => ({}));
  const offline = !!deps.offline;
  const usagePath = deps.usagePath ?? process.env.MERIDIAN_ST_USAGE_PATH ?? path.join(__dirname, "..", "solanatracker-usage.json");
  const spawnGmgn = deps.spawnGmgn ?? (async (args) => (await import("./gmgn.js")).spawnGmgn(args));
  const getTokenAgeHours = deps.getTokenAgeHours ?? (async (mint) => {
    const { fetchGmgnPriceInfo } = await import("./gmgn.js");
    const info = await fetchGmgnPriceInfo(mint);
    return info?.token_age_hours ?? null;
  });

  const depthCache = new Map(); // key -> { at, value }
  const inflight = new Map();
  const stCache = new Map(); // mint -> { at, candles, plan }
  let gtCalls = [];
  let gtCooldownUntil = 0;
  let active = 0;
  const waiters = [];

  const strategyCfg = () => getConfig()?.strategy ?? {};

  async function fetchJson(url, headers = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await doFetch(url, { headers, signal: ctrl.signal });
      if (!res?.ok) return { status: res?.status ?? 0, json: null };
      return { status: res.status, json: await res.json() };
    } catch {
      return { status: 0, json: null };
    } finally {
      clearTimeout(timer);
    }
  }

  // ── GeckoTerminal limiter: skip (never queue) past the per-minute budget ──
  function gtAcquire() {
    const t = now();
    if (t < gtCooldownUntil) return false;
    gtCalls = gtCalls.filter((x) => t - x < GT_WINDOW_MS);
    if (gtCalls.length >= GT_MAX_PER_WINDOW) return false;
    gtCalls.push(t);
    return true;
  }

  async function gtGet(url) {
    if (!gtAcquire()) return null;
    const r = await fetchJson(url, GT_HEADERS);
    if (r.status === 429) {
      gtCooldownUntil = now() + GT_COOLDOWN_MS;
      log("ohlcv", "GeckoTerminal rate limited — pausing it for 60s");
    }
    return r.json;
  }

  // ── SolanaTracker daily cap (persisted so restarts don't reset it) ──
  function readUsage() {
    try {
      const u = JSON.parse(fs.readFileSync(usagePath, "utf8"));
      return u?.date === utcDay(now()) ? u : { date: utcDay(now()), count: 0 };
    } catch {
      return { date: utcDay(now()), count: 0 };
    }
  }
  function bumpUsage() {
    const u = readUsage();
    u.count += 1;
    try { fs.writeFileSync(usagePath, JSON.stringify(u)); } catch { /* best effort */ }
    return u.count;
  }

  const sources = {
    async gmgn({ mint }, plan) {
      const res = { 1: "1m", 5: "5m", 15: "15m", 60: "1h", 240: "4h" }[plan.resMin];
      return pagedFetch(async ({ from, to }) => {
        const json = await withTimeout(spawnGmgn(["market", "kline", "--chain", "sol", "--address", mint, "--resolution", res, "--from", String(from), "--to", String(to)]), REQUEST_TIMEOUT_MS);
        return json ? normalizeGmgn(json) : null;
      }, plan, SOURCE_SPECS.gmgn);
    },

    async solanatracker({ mint }, plan) {
      const key = env.SOLANATRACKER_API_KEY;
      if (!key) return null; // quiet skip: no key configured
      const hit = stCache.get(mint);
      if (hit && now() - hit.at < ST_CACHE_TTL_MS) return hit.candles;
      const cap = Number(strategyCfg().solanaTrackerDailyCap ?? 60);
      const used = readUsage().count;
      if (!(cap > 0) || used >= cap) {
        log("ohlcv", `SolanaTracker skipped for ${mint.slice(0, 8)}: daily cap reached (${used}/${cap})`);
        return null;
      }
      const type = { 1: "1m", 5: "5m", 15: "15m", 30: "30m", 60: "1h", 240: "4h" }[plan.resMin];
      const count = bumpUsage();
      log("ohlcv", `SolanaTracker call ${count}/${cap} today: ${mint.slice(0, 8)} ${type} ${plan.label}`);
      const r = await fetchJson(`${ST_BASE}/chart/${mint}?type=${type}&time_from=${plan.fromSec}&time_to=${plan.toSec}`, { "x-api-key": key });
      const candles = r.json ? normalizeSolanaTracker(r.json) : null;
      stCache.set(mint, { at: now(), candles }); // cache misses too: credits are scarce
      return candles;
    },

    async geckoterminal({ pool, mint }, plan) {
      const tf = plan.resMin >= 60 ? "hour" : "minute";
      const agg = plan.resMin >= 60 ? plan.resMin / 60 : plan.resMin;
      const forPool = (addr) => pagedFetch(async ({ to, limit }) => {
        const json = await gtGet(`${GT_BASE}/networks/solana/pools/${addr}/ohlcv/${tf}?aggregate=${agg}&limit=${Math.min(limit, 1000)}&before_timestamp=${to + 1}&currency=usd`);
        return json ? normalizeGeckoTerminal(json) : null;
      }, plan, SOURCE_SPECS.geckoterminal);
      const span = (cs) => (cs?.length ? cs.at(-1).t - cs[0].t : 0);
      let best = pool ? await forPool(pool) : null;
      let usedPool = pool;
      const thin = span(best) < (plan.toSec - plan.fromSec) * 0.5;
      if (thin && mint) {
        const list = await gtGet(`${GT_BASE}/networks/solana/tokens/${mint}/pools?sort=h24_volume_usd_liquidity_desc`);
        const top = (list?.data || []).map((p) => p?.attributes?.address).find((a) => a && a !== pool);
        if (top) {
          const alt = await forPool(top);
          if (span(alt) > span(best)) { best = alt; usedPool = top; }
        }
      }
      if (best) best.pool = usedPool;
      return best;
    },

    async meteora({ pool }, plan) {
      const tf = { 5: "5m", 30: "30m", 60: "1h", 120: "2h", 240: "4h" }[plan.resMin];
      return pagedFetch(async ({ from, to }) => {
        const r = await fetchJson(`${METEORA_BASE}/${pool}/ohlcv?timeframe=${tf}&start_time=${from}&end_time=${to}`);
        return r.json ? normalizeMeteora(r.json) : null;
      }, plan, SOURCE_SPECS.meteora);
    },
  };

  const ORDER = ["gmgn", "solanatracker", "geckoterminal", "meteora"];
  const canUse = (name, { pool, mint }) => (SOURCE_SPECS[name].level === "token" ? !!mint && mint !== WSOL : !!pool);

  function depthCfg() {
    const s = strategyCfg();
    return {
      bufferMult: num(s.ohlcvBufferMult) > 0 ? num(s.ohlcvBufferMult) : OHLCV_DEFAULTS.bufferMult,
      maxPct: num(s.maxRangePct) > 0 ? num(s.maxRangePct) : 80,
      minPct: MIN_RANGE_PCT,
    };
  }

  async function compute({ pool, mint, ageHours }) {
    if (offline) return null;
    const tiers = normalizeTiers(strategyCfg().ohlcvTiers);
    let age = num(ageHours) >= 0 ? num(ageHours) : null;
    if (age == null && mint) age = await withTimeout(getTokenAgeHours(mint), REQUEST_TIMEOUT_MS).then((a) => (num(a) >= 0 ? num(a) : null));
    const tried = [];
    for (const name of ORDER) {
      if (!canUse(name, { pool, mint })) continue;
      let tier = pickTier(age, tiers);
      let plan = planWindow(SOURCE_SPECS[name], tier, age, now() / 1000);
      let candles = await sources[name]({ pool, mint }, plan).catch(() => null);
      // Unknown age: infer it from the first candle of the provisional fetch and
      // refetch once with the right tier (never for SolanaTracker: credits).
      if (age == null && candles?.length && candles[0].t > plan.fromSec + plan.resMin * 120) {
        age = (now() / 1000 - candles[0].t) / 3600;
        const t2 = pickTier(age, tiers);
        if (name !== "solanatracker" && t2 !== tier) {
          tier = t2;
          plan = planWindow(SOURCE_SPECS[name], tier, age, now() / 1000);
          candles = (await sources[name]({ pool, mint }, plan).catch(() => null)) ?? candles;
        } else {
          plan = planWindow(SOURCE_SPECS[name], t2, age, now() / 1000);
        }
      }
      // Drop launch prints: the first minutes after creation are sniper/bonding-curve noise.
      const launchCutoff = age != null ? now() / 1000 - age * 3600 + OHLCV_DEFAULTS.launchSkipMinutes * 60 : 0;
      if (candles && launchCutoff > 0) {
        const kept = candles.filter((c) => c.t >= launchCutoff);
        if (candles.pool) kept.pool = candles.pool;
        candles = kept;
      }
      const d = candles ? depthFromCandles(candles, { ...depthCfg(), timeframeMinutes: plan.resMin, source: name, window: plan.label }) : null;
      tried.push(`${name}:${candles ? candles.length : "none"}`);
      if (d) {
        d.basis.tier = plan.label;
        d.basis.level = SOURCE_SPECS[name].level;
        if (candles.pool) d.basis.pool = candles.pool;
        d.basis.ageHours = age != null ? round1(age) : null;
        return d;
      }
    }
    log("ohlcv", `No usable candles for ${mint?.slice(0, 8) ?? "?"}/${pool?.slice(0, 8) ?? "?"} (${tried.join(", ") || "no source"}) — volatility table applies`);
    return null;
  }

  async function withSlot(fn) {
    if (active >= MAX_CONCURRENT_DEPTHS) await new Promise((r) => waiters.push(r));
    active++;
    try { return await fn(); } finally { active--; waiters.shift()?.(); }
  }

  const keyOf = ({ pool, mint }) => `${mint || ""}|${pool || ""}`;

  /** Depth for a pool/token: cached ~5 min, never throws, null when unavailable. */
  async function getOhlcvDepth({ pool = null, mint = null, ageHours = null } = {}) {
    if (!pool && !mint) return null;
    const key = keyOf({ pool, mint });
    const hit = depthCache.get(key);
    if (hit && now() - hit.at < DEPTH_CACHE_TTL_MS) return hit.value;
    if (inflight.has(key)) return inflight.get(key);
    const p = withSlot(() => compute({ pool, mint, ageHours }))
      .catch((e) => { log("ohlcv", `Depth failed: ${e?.message ?? e}`); return null; })
      .then((value) => { depthCache.set(key, { at: now(), value }); return value; })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  /**
   * Deploy-time lookup: a screening-time value up to 20 min old, else a fresh
   * fetch bounded to ~8s. Never throws; null = no candle depth.
   */
  async function getDepthForDeploy({ pool = null, mint = null, ageHours = null } = {}) {
    const hit = depthCache.get(keyOf({ pool, mint }));
    if (hit && hit.value && now() - hit.at < DEPLOY_STALE_OK_MS) return hit.value;
    return withTimeout(getOhlcvDepth({ pool, mint, ageHours }), DEPLOY_FETCH_BUDGET_MS);
  }

  /** Seed the cache (tests, or a caller that already computed it). */
  function primeDepth({ pool = null, mint = null }, value, at = now()) {
    depthCache.set(keyOf({ pool, mint }), { at, value });
  }

  function clearCaches() {
    depthCache.clear(); stCache.clear(); inflight.clear(); gtCalls = []; gtCooldownUntil = 0;
  }

  return { getOhlcvDepth, getDepthForDeploy, primeDepth, clearCaches, sources, fetchCandlesFrom: (name, args, plan) => sources[name](args, plan) };
}

/* ─────────────────────────── default instance ─────────────────────────── */

// Unit tests never hit the candle APIs: under the node:test runner (NODE_TEST_CONTEXT)
// or with MERIDIAN_OHLCV_OFFLINE=1 the default instance only serves primed/cached depths.
const _default = createOhlcv({
  getConfig: () => config,
  offline: !!process.env.NODE_TEST_CONTEXT || process.env.MERIDIAN_OHLCV_OFFLINE === "1",
});

export const getOhlcvDepth = (args) => _default.getOhlcvDepth(args);
export const getDepthForDeploy = (args) => _default.getDepthForDeploy(args);
export const primeOhlcvDepth = (key, value, at) => _default.primeDepth(key, value, at);
export const clearOhlcvCaches = () => _default.clearCaches();

/** One-line summary for prompts / logs. */
export function formatDepth(d) {
  if (!d) return null;
  return `${d.depthPct}% (${d.short})`;
}
