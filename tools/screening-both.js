/**
 * Combined screening source (screeningSource = "both").
 *
 * Runs the Meteora pool discovery and the GMGN pipeline in parallel, then merges
 * them into ONE candidate list in the same shape discoverPools() returns:
 *
 *   1. Promise.allSettled + per-source timeout: one source failing never fails
 *      the cycle; the other source's candidates are used alone.
 *   2. Dedup by pool address. A pool found by both sources is merged: Meteora
 *      pool metrics + GMGN token signals, sources ["meteora","gmgn"],
 *      confirmed_by_both: true.
 *   3. Hard filters on pools that only GMGN found (Meteora applies them
 *      server-side): minBinStep/maxBinStep, minTvl/maxTvl, maxVolatility.
 *      Missing bin_step/tvl/volatility is looked up via the Meteora pool
 *      discovery API (capped); a pool whose bin_step or TVL is still unknown
 *      is dropped with a logged reason, never accepted.
 *   4. One pool per token (base mint): higher fee/active-TVL (or fee/TVL), then
 *      higher TVL. If both sources found the token (even in different pools,
 *      or GMGN's pool failed the filters), the survivor carries GMGN token
 *      signals and confirmed_by_both: true.
 *   5. Sort confirmed_by_both first, then fee/active-TVL, then TVL; truncate.
 *
 * Every dependency is injectable (`deps`) so tests run with no network.
 */

import { config } from "../config.js";
import { log } from "../logger.js";
import { isBlacklisted } from "../token-blacklist.js";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const METEORA_DLMM_API = "https://dlmm.datapi.meteora.ag";

export const DEFAULT_METEORA_TIMEOUT_MS = 45_000;
// GMGN is serialized + rate-limited (tools/gmgn.js), so its pipeline is slow.
export const DEFAULT_GMGN_TIMEOUT_MS = 240_000;
export const DEFAULT_MAX_LOOKUPS = 8;
const LOOKUP_CONCURRENCY = 4;

// Token-level fields a GMGN candidate carries that describe the TOKEN, not the
// pool, so they can be grafted onto a Meteora pool of the same token.
const GMGN_TOKEN_FIELDS = new Set([
  "indicators", "launchpad", "price_vs_ath_pct", "ath", "token_age_hours", "dev",
]);

/* ============================== helpers ============================== */

function finite(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Normalized pool key: both sources expose `pool` (discovery may use pool_address). */
export function poolKey(c) {
  const v = c?.pool ?? c?.pool_address ?? null;
  return v ? String(v).trim() : null;
}

/** Normalized token key: both sources expose `base.mint` (flat `base_mint` tolerated). */
export function tokenKey(c) {
  const v = c?.base?.mint ?? c?.base_mint ?? null;
  return v ? String(v).trim() : null;
}

function feeRatio(c) {
  return finite(c?.fee_active_tvl_ratio) ?? finite(c?.fee_tvl_ratio);
}

function tvlOf(c) {
  return finite(c?.tvl) ?? finite(c?.active_tvl);
}

function desc(a, b) {
  return (b ?? -Infinity) - (a ?? -Infinity);
}

/** Tie-break for one-pool-per-token: fee/active-TVL (or fee/TVL), then TVL. */
export function compareForTokenWinner(a, b) {
  return desc(feeRatio(a), feeRatio(b)) || desc(tvlOf(a), tvlOf(b));
}

function mergeSources(...lists) {
  const set = new Set(lists.flat().filter(Boolean));
  return ["meteora", "gmgn"].filter((s) => set.has(s));
}

function gmgnTokenSignals(g) {
  const out = {};
  for (const [k, v] of Object.entries(g || {})) {
    if (k.startsWith("gmgn") || GMGN_TOKEN_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Merge a Meteora candidate with a GMGN candidate for the same pool or token:
 * Meteora pool metrics win; GMGN token signals are added; holders/mcap fall
 * back to GMGN when Meteora has none.
 */
export function mergeCandidates(meteoraC, gmgnC) {
  const merged = {
    ...meteoraC,
    ...gmgnTokenSignals(gmgnC),
    holders: meteoraC.holders ?? gmgnC.holders ?? null,
    mcap: meteoraC.mcap ?? gmgnC.mcap ?? null,
    sources: mergeSources(meteoraC.sources, gmgnC.sources, ["meteora", "gmgn"]),
    confirmed_by_both: true,
  };
  if (poolKey(gmgnC) && poolKey(gmgnC) !== poolKey(meteoraC)) merged.gmgn_pool = poolKey(gmgnC);
  return merged;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ============================== default deps ============================== */

async function defaultDiscoverMeteora() {
  const { discoverPools } = await import("./screening.js");
  return discoverPools({ page_size: 50 });
}

async function defaultDiscoverGmgn({ limit }) {
  const { discoverGmgnPools } = await import("./gmgn-screen.js");
  return discoverGmgnPools({ limit });
}

/**
 * One cheap read-only lookup of a pool's bin_step / TVL / volatility.
 * Pool discovery API first (has volatility), DLMM data API as fallback.
 */
export async function lookupPoolMetrics(poolAddress, { timeframe = config.screening.timeframe || "5m" } = {}) {
  try {
    const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=${timeframe}`;
    const res = await fetch(url);
    if (res.ok) {
      const p = ((await res.json())?.data || [])[0];
      if (p) {
        return {
          bin_step: finite(p.dlmm_params?.bin_step),
          tvl: finite(p.tvl),
          active_tvl: finite(p.active_tvl),
          volatility: finite(p.volatility),
          fee_active_tvl_ratio: finite(p.fee_active_tvl_ratio),
        };
      }
    }
  } catch { /* fall through to the DLMM API */ }
  const res = await fetch(`${METEORA_DLMM_API}/pools/${poolAddress}`);
  if (!res.ok) return null;
  const p = await res.json();
  return { bin_step: finite(p?.pool_config?.bin_step), tvl: finite(p?.tvl), volatility: null };
}

/* ============================== hard filters ============================== */

function hardFilterReason(c, s) {
  const binStep = finite(c.bin_step);
  if (binStep == null) return "bin_step unknown";
  if (binStep < s.minBinStep) return `bin_step ${binStep} < min ${s.minBinStep}`;
  if (binStep > s.maxBinStep) return `bin_step ${binStep} > max ${s.maxBinStep}`;
  const tvl = tvlOf(c);
  if (tvl == null) return "tvl unknown";
  if (tvl < s.minTvl) return `tvl ${Math.round(tvl)} < min ${s.minTvl}`;
  if (tvl > s.maxTvl) return `tvl ${Math.round(tvl)} > max ${s.maxTvl}`;
  // Parity with discoverPools(): unknown volatility is not a drop reason there either.
  const vol = finite(c.volatility);
  if (vol != null && vol > s.maxVolatility) return `volatility ${vol} > max ${s.maxVolatility}`;
  return null;
}

/**
 * Apply the Meteora-path pool filters to GMGN-only candidates, looking up any
 * missing bin_step / tvl / volatility first (at most `maxLookups` lookups).
 */
export async function filterGmgnOnly(candidates, { screening, lookupPool, maxLookups, dropped, stats }) {
  const needsLookup = (c) => finite(c.bin_step) == null || tvlOf(c) == null || finite(c.volatility) == null;
  const toLookup = candidates.filter(needsLookup);
  const allowed = toLookup.slice(0, Math.max(0, maxLookups));
  const skipped = new Set(toLookup.slice(allowed.length));

  for (let i = 0; i < allowed.length; i += LOOKUP_CONCURRENCY) {
    const batch = allowed.slice(i, i + LOOKUP_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((c) => lookupPool(poolKey(c))));
    results.forEach((r, j) => {
      stats.lookups++;
      const c = batch[j];
      if (r.status !== "fulfilled" || !r.value) {
        stats.lookup_failures++;
        return;
      }
      const m = r.value;
      if (finite(c.bin_step) == null && m.bin_step != null) c.bin_step = m.bin_step;
      if (finite(c.tvl) == null && m.tvl != null) c.tvl = Math.round(m.tvl);
      if (finite(c.active_tvl) == null && m.active_tvl != null) c.active_tvl = Math.round(m.active_tvl);
      if (finite(c.volatility) == null && m.volatility != null) c.volatility = Number(m.volatility.toFixed(2));
      if (feeRatio(c) == null && m.fee_active_tvl_ratio != null) c.fee_active_tvl_ratio = Number(m.fee_active_tvl_ratio.toFixed(4));
    });
  }

  const kept = [];
  for (const c of candidates) {
    let reason = hardFilterReason(c, screening);
    if (reason && skipped.has(c) && /unknown/.test(reason)) reason += ` (lookup cap ${maxLookups} reached)`;
    else if (reason && /unknown/.test(reason)) reason += " (lookup failed)";
    if (reason) {
      dropped.push({ pool: poolKey(c), symbol: c.base?.symbol || c.name, source: "gmgn", reason });
      log("screening", `both: dropped GMGN pick ${c.base?.symbol || c.name} (${poolKey(c)?.slice(0, 8)}): ${reason}`);
      continue;
    }
    kept.push(c);
  }
  return kept;
}

/* ============================== combiner ============================== */

/**
 * Merge Meteora + GMGN candidate lists (pure apart from `lookupPool`).
 * Exported separately so it can be tested on fixed inputs.
 */
export async function combineCandidates({ meteora = [], gmgn = [], limit = 10, screening = config.screening, lookupPool = lookupPoolMetrics, maxLookups = DEFAULT_MAX_LOOKUPS } = {}) {
  const dropped = [];
  const stats = { lookups: 0, lookup_failures: 0, pool_overlaps: 0, token_overlaps: 0 };

  // ── 1. pool-address dedup (+ provenance merge) ──
  const byPool = new Map();
  const noKey = (c, source) => dropped.push({ pool: null, symbol: c?.base?.symbol || c?.name, source, reason: "missing pool address or base mint" });
  for (const c of meteora) {
    const k = poolKey(c);
    if (!k || !tokenKey(c)) { noKey(c, "meteora"); continue; }
    if (byPool.has(k)) continue; // duplicate row from the same source
    byPool.set(k, { ...c, sources: ["meteora"], confirmed_by_both: false });
  }
  const gmgnOnly = [];
  for (const c of gmgn) {
    const k = poolKey(c);
    if (!k || !tokenKey(c)) { noKey(c, "gmgn"); continue; }
    const existing = byPool.get(k);
    if (existing) {
      if (existing.sources.includes("meteora") && !existing.sources.includes("gmgn")) {
        byPool.set(k, mergeCandidates(existing, c));
        stats.pool_overlaps++;
      }
      continue;
    }
    const tagged = { ...c, sources: ["gmgn"], confirmed_by_both: false };
    byPool.set(k, tagged);
    gmgnOnly.push(tagged);
  }

  // ── 2. hard filters on pools only GMGN found ──
  const keptGmgn = new Set(await filterGmgnOnly(gmgnOnly, { screening, lookupPool, maxLookups, dropped, stats }));
  const pooled = [...byPool.values()].filter((c) => !(c.sources.length === 1 && c.sources[0] === "gmgn") || keptGmgn.has(c));
  // A GMGN pool rejected by the pool filters still vouches for its TOKEN: if
  // Meteora found another pool of that token, that pool gets the GMGN signals.
  const rejectedGmgnByToken = new Map();
  for (const c of gmgnOnly) if (!keptGmgn.has(c) && !rejectedGmgnByToken.has(tokenKey(c))) rejectedGmgnByToken.set(tokenKey(c), c);

  // ── 3. one pool per token ──
  const byToken = new Map();
  for (const c of pooled) {
    const k = tokenKey(c);
    if (!byToken.has(k)) byToken.set(k, []);
    byToken.get(k).push(c);
  }
  const merged = [];
  for (const [token, group] of byToken.entries()) {
    const sorted = [...group].sort(compareForTokenWinner);
    let winner = sorted[0];
    const rejectedGmgn = rejectedGmgnByToken.get(token);
    const groupSources = mergeSources(...group.map((c) => c.sources), rejectedGmgn ? ["gmgn"] : []);
    if (groupSources.length === 2 && !winner.confirmed_by_both) {
      stats.token_overlaps++;
      const gmgnMember = group.find((c) => c.sources.includes("gmgn")) || rejectedGmgn;
      winner = winner.sources.includes("meteora")
        ? mergeCandidates(winner, gmgnMember)
        : { ...winner, sources: ["meteora", "gmgn"], confirmed_by_both: true };
    }
    for (const loser of sorted.slice(1)) {
      dropped.push({ pool: poolKey(loser), symbol: loser.base?.symbol || loser.name, source: loser.sources.join("+"), reason: `same token as ${poolKey(winner)?.slice(0, 8)} (lower fee/TVL or TVL)` });
    }
    merged.push(winner);
  }

  // ── 4. blacklist (parity with both single-source paths) ──
  const clean = merged.filter((c) => {
    if (!isBlacklisted(tokenKey(c))) return true;
    dropped.push({ pool: poolKey(c), symbol: c.base?.symbol || c.name, source: c.sources.join("+"), reason: "blacklisted token" });
    return false;
  });

  // ── 5. order + limit ──
  clean.sort((a, b) =>
    (b.confirmed_by_both ? 1 : 0) - (a.confirmed_by_both ? 1 : 0) ||
    desc(feeRatio(a), feeRatio(b)) ||
    desc(tvlOf(a), tvlOf(b))
  );

  return { pools: clean.slice(0, Math.max(0, limit)), total_merged: clean.length, dropped, stats };
}

/**
 * Discover candidates from BOTH sources in parallel and combine them.
 * Returns { total, pools, source_counts, errors, dropped, stats }.
 */
export async function discoverCombinedPools({ limit = 10, deps = {} } = {}) {
  const {
    discoverMeteora = defaultDiscoverMeteora,
    discoverGmgn = defaultDiscoverGmgn,
    lookupPool = lookupPoolMetrics,
    screening = config.screening,
    gmgnLimit = Math.max(limit, 10),
    meteoraTimeoutMs = DEFAULT_METEORA_TIMEOUT_MS,
    gmgnTimeoutMs = DEFAULT_GMGN_TIMEOUT_MS,
    maxLookups = DEFAULT_MAX_LOOKUPS,
  } = deps;

  const [mRes, gRes] = await Promise.allSettled([
    withTimeout(Promise.resolve().then(() => discoverMeteora({ limit })), meteoraTimeoutMs, "Meteora discovery"),
    withTimeout(Promise.resolve().then(() => discoverGmgn({ limit: gmgnLimit })), gmgnTimeoutMs, "GMGN discovery"),
  ]);

  const errors = {};
  const pick = (res, name) => {
    if (res.status === "fulfilled") return Array.isArray(res.value?.pools) ? res.value.pools : [];
    errors[name] = res.reason?.message || String(res.reason);
    log("screening_warn", `both: ${name} source failed (${errors[name]}), continuing with the other source`);
    return [];
  };
  const meteora = pick(mRes, "meteora");
  const gmgn = pick(gRes, "gmgn");

  const combined = await combineCandidates({ meteora, gmgn, limit, screening, lookupPool, maxLookups });
  const confirmed = combined.pools.filter((c) => c.confirmed_by_both).length;
  log("screening", `both: meteora=${meteora.length}${errors.meteora ? " (failed)" : ""} gmgn=${gmgn.length}${errors.gmgn ? " (failed)" : ""} → merged ${combined.total_merged} (pool overlaps ${combined.stats.pool_overlaps}, token overlaps ${combined.stats.token_overlaps}, dropped ${combined.dropped.length}) → returning ${combined.pools.length} (${confirmed} confirmed by both)`);

  return {
    total: combined.total_merged,
    pools: combined.pools,
    source_counts: { meteora: meteora.length, gmgn: gmgn.length },
    errors,
    dropped: combined.dropped,
    stats: combined.stats,
  };
}
