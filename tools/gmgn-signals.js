/**
 * GMGN market signals for screening (`gmgn-cli market signal`, POST /v1/market/token_signal).
 *
 * One read-only fetch per screening cycle (cached ~5 min) returns the recent
 * signal feed for Solana tokens inside the screening market-cap range. It is
 * folded into a map keyed by token mint and attached to each candidate as
 * `gmgn_signals`, so the screener sees e.g. "GMGN signals: 2 buy-pressure
 * (38m ago), 1 spike" and Darwin can learn `gmgn_buy_pressure` / `gmgn_spike`.
 *
 * Signal-type names come from the gmgn-cli 1.6.6 package docs
 * (skills/gmgn-market/SKILL.md, "Signal Types") and its source
 * (dist/commands/market.js: types 14–16 are rejected by the API as query
 * filters, but can still appear in a token's `signal_times_by_type`).
 *
 * Never throws: any failure yields an empty map with `ok = false`, logged.
 */

import { log } from "../logger.js";
import { spawnGmgn } from "./gmgn.js";

const CHAIN = "sol";
export const SIGNAL_CACHE_TTL_MS = 5 * 60_000;
// A failed fetch is retried sooner than a good one, but not on every call.
const FAILURE_CACHE_TTL_MS = 60_000;

/** GMGN signal_type → name (gmgn-cli 1.6.6, skills/gmgn-market/SKILL.md). */
export const SIGNAL_TYPE_NAMES = {
  1: "K-line price spike",
  2: "Dex ad placement",
  3: "Dex social link updated",
  4: "Dex trending bar",
  5: "Dex boost",
  6: "Price spike",
  7: "All-time high price",
  8: "Market cap key level",
  9: "Live stream",
  10: "Bundler sell",
  11: "Community takeover (CTO)",
  12: "Smart money buy",
  13: "Platform call",
  14: "Large amount buy",
  15: "Multiple buys",
  16: "Multiple large buys",
  17: "Bags claim",
  18: "Pump claim",
  19: "Platform call (V2)",
  20: "KOL buy",
  21: "Banker claim",
};

/** Buy pressure: smart-money, KOL and large/multiple buys. */
export const BUY_PRESSURE_TYPES = new Set([12, 14, 15, 16, 20]);
/** Spike: price spikes and new all-time highs. */
export const SPIKE_TYPES = new Set([1, 6, 7]);
// Types the API accepts as query filters (14–16 return HTTP 400).
const BUY_PRESSURE_QUERY_TYPES = [12, 20];
const SPIKE_QUERY_TYPES = [1, 6, 7];

export function classifySignalType(type) {
  const n = Number(type);
  if (BUY_PRESSURE_TYPES.has(n)) return "buy_pressure";
  if (SPIKE_TYPES.has(n)) return "spike";
  return "other";
}

function toNum(v) {
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Normalize the CLI's `--raw` output (array, or `{ list }` defensively) into signal items. */
export function parseSignalResponse(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.list) ? json.list : [];
  return list.filter((it) => it && typeof it.token_address === "string" && it.token_address);
}

/**
 * Fold signal items into Map<mint, summary>.
 *
 * Counts come from `signal_times_by_type` (GMGN's per-token trigger count by
 * type, identical on every item of a token), taking the max with the number of
 * feed events of that type so a missing breakdown still counts what we saw.
 * Recency uses the newest `trigger_at` in the feed.
 */
export function buildSignalMap(items, nowMs = Date.now()) {
  const byMint = new Map();
  for (const it of items) {
    let acc = byMint.get(it.token_address);
    if (!acc) {
      acc = { types: {}, seen: {}, latest: null, latestBuy: null, latestSpike: null };
      byMint.set(it.token_address, acc);
    }
    const byType = it.signal_times_by_type && typeof it.signal_times_by_type === "object" ? it.signal_times_by_type : {};
    for (const [t, n] of Object.entries(byType)) {
      const count = toNum(n);
      if (count != null && count > 0) acc.types[t] = Math.max(acc.types[t] || 0, Math.trunc(count));
    }
    const type = Math.trunc(toNum(it.signal_type) ?? 0);
    if (type > 0) acc.seen[type] = (acc.seen[type] || 0) + 1;
    const at = toNum(it.trigger_at);
    if (at != null && at > 0) {
      if (!acc.latest || at > acc.latest.at) acc.latest = { at, item: it };
      const cls = classifySignalType(type);
      if (cls === "buy_pressure" && (!acc.latestBuy || at > acc.latestBuy)) acc.latestBuy = at;
      if (cls === "spike" && (!acc.latestSpike || at > acc.latestSpike)) acc.latestSpike = at;
    }
  }

  const minAgo = (sec) => (sec ? Math.max(0, Math.round((nowMs - sec * 1000) / 60_000)) : null);
  const out = new Map();
  for (const [mint, acc] of byMint) {
    const types = { ...acc.types };
    for (const [t, n] of Object.entries(acc.seen)) types[t] = Math.max(types[t] || 0, n);
    let buy = 0, spike = 0, other = 0;
    for (const [t, n] of Object.entries(types)) {
      const cls = classifySignalType(t);
      if (cls === "buy_pressure") buy += n;
      else if (cls === "spike") spike += n;
      else other += n;
    }
    const latest = acc.latest?.item;
    out.set(mint, {
      buy_pressure_count: buy,
      spike_count: spike,
      other_count: other,
      last_signal_min_ago: minAgo(acc.latest?.at),
      last_buy_pressure_min_ago: minAgo(acc.latestBuy),
      last_spike_min_ago: minAgo(acc.latestSpike),
      trigger_mc: latest ? toNum(latest.trigger_mc) : null,
      mc_now: latest ? toNum(latest.market_cap) : null,
      types,
    });
  }
  return out;
}

/**
 * Market-cap range for the query: the screening range of the active source
 * (config.screening for meteora, config.gmgn for gmgn, the union for both).
 */
export function resolveMcapRange(cfg) {
  const s = cfg?.screening || {};
  const g = cfg?.gmgn || {};
  const pick = (a, b, fn) => {
    const vals = [a, b].map(toNum).filter((v) => v != null && v > 0);
    return vals.length ? fn(...vals) : null;
  };
  if (s.source === "gmgn") return { min: toNum(g.minMcap), max: toNum(g.maxMcap) };
  if (s.source === "both") return { min: pick(s.minMcap, g.minMcap, Math.min), max: pick(s.maxMcap, g.maxMcap, Math.max) };
  return { min: toNum(s.minMcap), max: toNum(s.maxMcap) };
}

/** Two groups in one call: buy pressure and spikes, each capped at 50 by the API. */
export function buildSignalGroups({ min, max } = {}) {
  const range = {};
  if (min != null && min > 0) range.mc_min = min;
  if (max != null && max > 0) range.mc_max = max;
  return [
    { signal_type: BUY_PRESSURE_QUERY_TYPES, ...range },
    { signal_type: SPIKE_QUERY_TYPES, ...range },
  ];
}

function emptyMap(ok) {
  const m = new Map();
  m.ok = ok;
  return m;
}

let _cache = null; // { key, map, expiresAt }
let _inflight = null;

export function _resetGmgnSignalCache() {
  _cache = null;
  _inflight = null;
}

/**
 * Fetch the GMGN signal map once per screening cycle.
 * Returns Map<mint, summary>; `map.ok` is false when the fetch failed (the map
 * is then empty and callers should treat signals as unknown, not absent).
 */
export async function fetchGmgnSignalMap({ cfg, spawn = spawnGmgn, now = Date.now } = {}) {
  try {
    const config = cfg || (await import("../config.js")).config;
    const groups = buildSignalGroups(resolveMcapRange(config));
    const key = JSON.stringify(groups);
    if (_cache && _cache.key === key && now() < _cache.expiresAt) return _cache.map;
    if (_inflight && _inflight.key === key) return _inflight.promise;

    const promise = (async () => {
      let map;
      try {
        const json = await spawn(["market", "signal", "--chain", CHAIN, "--groups", key]);
        if (json == null) {
          log("gmgn_signals", "Signal fetch returned nothing (spawn error, timeout or rate limit); continuing without GMGN signals");
          map = emptyMap(false);
        } else {
          map = buildSignalMap(parseSignalResponse(json), now());
          map.ok = true;
          log("gmgn_signals", `Fetched GMGN signals: ${map.size} token(s) in mcap range`);
        }
      } catch (e) {
        log("gmgn_signals", `Signal fetch failed: ${e?.message || e}; continuing without GMGN signals`);
        map = emptyMap(false);
      }
      _cache = { key, map, expiresAt: now() + (map.ok ? SIGNAL_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS) };
      return map;
    })();
    _inflight = { key, promise };
    try {
      return await promise;
    } finally {
      if (_inflight?.promise === promise) _inflight = null;
    }
  } catch (e) {
    log("gmgn_signals", `Signal fetch failed: ${e?.message || e}; continuing without GMGN signals`);
    return emptyMap(false);
  }
}

export const NO_GMGN_SIGNALS = Object.freeze({
  buy_pressure_count: 0,
  spike_count: 0,
  other_count: 0,
  last_signal_min_ago: null,
  last_buy_pressure_min_ago: null,
  last_spike_min_ago: null,
  trigger_mc: null,
  mc_now: null,
  types: Object.freeze({}),
});

/**
 * Attach `gmgn_signals` to each candidate (in place). A successful fetch gives
 * every candidate a summary (zeros when its mint is not in the feed); a failed
 * fetch sets null so Darwin records the signals as unknown, not absent.
 */
export function attachGmgnSignals(candidates = [], map) {
  const ok = map?.ok === true;
  let hits = 0;
  for (const c of candidates) {
    if (!c) continue;
    if (!ok) {
      c.gmgn_signals = null;
      continue;
    }
    const mint = c.base?.mint || c.base_mint || null;
    const sig = mint ? map.get(mint) : null;
    if (sig) hits++;
    c.gmgn_signals = sig ? { ...sig, types: { ...sig.types } } : { ...NO_GMGN_SIGNALS, types: {} };
  }
  return hits;
}

/** Compact prompt line, e.g. "GMGN signals: 2 buy-pressure (38m ago), 1 spike (5m ago)". */
export function formatGmgnSignalsLine(sig) {
  if (!sig) return null;
  const parts = [];
  const ago = (m) => (m != null ? ` (${m}m ago)` : "");
  if (sig.buy_pressure_count > 0) parts.push(`${sig.buy_pressure_count} buy-pressure${ago(sig.last_buy_pressure_min_ago)}`);
  if (sig.spike_count > 0) parts.push(`${sig.spike_count} spike${sig.spike_count === 1 ? "" : "s"}${ago(sig.last_spike_min_ago)}`);
  if (sig.other_count > 0) parts.push(`${sig.other_count} other`);
  if (parts.length === 0) return "GMGN signals: none in recent feed";
  return `GMGN signals: ${parts.join(", ")}`;
}

/** Darwin booleans: null (unknown) when signals weren't fetched. */
export function gmgnSignalBooleans(sig) {
  if (!sig) return { gmgn_buy_pressure: null, gmgn_spike: null };
  return {
    gmgn_buy_pressure: (sig.buy_pressure_count || 0) > 0,
    gmgn_spike: (sig.spike_count || 0) > 0,
  };
}

/** Fields stored in the deploy signal_snapshot (the two weighted booleans + raw counts for analysis). */
export function gmgnSignalSnapshotFields(sig) {
  return {
    ...gmgnSignalBooleans(sig),
    gmgn_buy_pressure_count: sig ? sig.buy_pressure_count ?? 0 : null,
    gmgn_spike_count: sig ? sig.spike_count ?? 0 : null,
    gmgn_other_signal_count: sig ? sig.other_count ?? 0 : null,
    gmgn_last_market_signal_min_ago: sig ? sig.last_signal_min_ago ?? null : null,
  };
}

/** Prompt note for the screener (shown only when some candidate carries gmgn_signals). */
export const GMGN_MARKET_SIGNALS_GUIDE = [
  "- \"GMGN signals:\" lines come from GMGN's market signal feed and are informational, not a hard filter",
  "- buy-pressure (smart-money buy, KOL buy, large buys) often means sustained volume, which feeds LP fees",
  "- spike (price spike, K-line spike, new ATH) often means upside out-of-range risk for bid_ask; widen or skip if momentum is fading",
  "- counts are GMGN's per-token trigger totals by type; \"(Nm ago)\" is the newest such signal in the feed; \"none in recent feed\" is neutral",
].join("\n");
