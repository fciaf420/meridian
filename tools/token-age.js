/**
 * Token age (hours since the base token's creation) and the token-age window
 * (config.screening.minTokenAgeHours / maxTokenAgeHours; null = no bound).
 *
 * Age is the TOKEN's creation time, never the pool's (a new pool on an old
 * token is still an old token). Sources, in order:
 *   1. Meteora pool-discovery `token_x.created_at` (epoch ms). Every Meteora
 *      screening row carries it (condensePool → base.created_at), and deploy
 *      reads it from the deploy pool's own row. It equals GMGN's
 *      creation_timestamp for pump.fun mints.
 *   2. GMGN `token info` creation_timestamp, else open_timestamp (epoch s).
 *   3. A GMGN screening row's token_age_hours (from open_timestamp).
 * The creation time is cached per mint (it never changes), so the age stays
 * current without refetching.
 *
 * Unknown age: screening KEEPS the candidate, tagged token_age_unknown; deploy
 * ALLOWS it and logs a warning. Only a known age outside the window blocks.
 */

import { config } from "../config.js";
import { log } from "../logger.js";

const HOUR_MS = 3_600_000;
const HIT_TTL_MS = 6 * HOUR_MS; // creation time is immutable; the TTL only bounds memory
const MISS_TTL_MS = 5 * 60_000;
const LOOKUP_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_SCREEN_LOOKUPS = 8;

/* ============================== pure helpers ============================== */

function finite(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Epoch seconds or milliseconds → ms; null for missing / non-positive. */
export function toEpochMs(v) {
  const n = finite(v);
  if (n == null || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** Hours between a creation time (ms) and now, 2 decimals; null when unknown. */
export function ageHoursSince(createdMs, nowMs = Date.now()) {
  if (createdMs == null) return null;
  const h = Math.max(0, (nowMs - createdMs) / HOUR_MS);
  return Math.round(h * 100) / 100;
}

/** "96h", "1.5h" — the unit the entry-filter logs use. */
export function fmtAgeHours(h) {
  const n = finite(h);
  if (n == null) return "unknown";
  return n < 10 ? `${Math.round(n * 10) / 10}h` : `${Math.round(n)}h`;
}

/** The configured window, or null when neither bound is set. */
export function tokenAgeWindow(screening = config.screening) {
  const min = finite(screening?.minTokenAgeHours);
  const max = finite(screening?.maxTokenAgeHours);
  if (min == null && max == null) return null;
  return { min, max };
}

export function fmtWindow(w) {
  if (!w) return "no window";
  if (w.min != null && w.max != null) return `${fmtAgeHours(w.min)}–${fmtAgeHours(w.max)}`;
  return w.min != null ? `≥ ${fmtAgeHours(w.min)}` : `≤ ${fmtAgeHours(w.max)}`;
}

/**
 * { pass, unknown, reason, text }. pass: true (inside, or no window), false
 * (known age outside), null (window set, age unknown).
 */
export function evaluateTokenAgeWindow(hours, window = tokenAgeWindow()) {
  if (!window) return { pass: true, unknown: false, configured: false, reason: null, text: null };
  const h = finite(hours);
  if (h == null) {
    return { pass: null, unknown: true, configured: true, reason: "token age unknown", text: `token age unknown (window ${fmtWindow(window)})` };
  }
  if (window.min != null && h < window.min) {
    const reason = `token age ${fmtAgeHours(h)} < ${fmtAgeHours(window.min)} min`;
    return { pass: false, unknown: false, configured: true, reason, text: reason };
  }
  if (window.max != null && h > window.max) {
    const reason = `token age ${fmtAgeHours(h)} > ${fmtAgeHours(window.max)} max`;
    return { pass: false, unknown: false, configured: true, reason, text: reason };
  }
  return { pass: true, unknown: false, configured: true, reason: null, text: `token age ${fmtAgeHours(h)} (window ${fmtWindow(window)})` };
}

/**
 * Age already present on a candidate row: Meteora base.created_at first (token
 * creation, ms), then a GMGN row's token_age_hours. { hours, source, created_ms } or null.
 */
export function candidateTokenAge(c, nowMs = Date.now()) {
  const createdMs = toEpochMs(c?.base?.created_at ?? c?.token_created_at);
  if (createdMs != null) return { hours: ageHoursSince(createdMs, nowMs), source: "meteora", created_ms: createdMs };
  const h = finite(c?.token_age_hours);
  if (h != null && h >= 0) return { hours: h, source: c?.token_age_source || "gmgn", created_ms: null };
  return null;
}

/* ============================== lookups (cached) ============================== */

async function defaultFetchPoolRow(poolAddress) {
  const { fetchPoolApiRow } = await import("./entry-safety.js");
  return fetchPoolApiRow(poolAddress);
}

async function defaultFetchGmgnTokenInfo(mint) {
  const { fetchGmgnTokenInfo } = await import("./gmgn.js");
  return fetchGmgnTokenInfo(mint);
}

let deps = { fetchPoolRow: defaultFetchPoolRow, fetchGmgnTokenInfo: defaultFetchGmgnTokenInfo, now: () => Date.now() };
const cache = new Map(); // mint -> { createdMs, source, at } | { miss: true, at }

/** Test hook: override fetchPoolRow / fetchGmgnTokenInfo / now; null restores defaults. Clears the cache. */
export function _setTokenAgeDepsForTest(d) {
  deps = { fetchPoolRow: defaultFetchPoolRow, fetchGmgnTokenInfo: defaultFetchGmgnTokenInfo, now: () => Date.now(), ...(d || {}) };
  cache.clear();
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve().then(() => promise),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

/** Seed the cache with a known creation time (e.g. from a Meteora screening row). */
export function primeTokenAge(mint, createdMs, source = "meteora") {
  if (!mint || createdMs == null) return;
  cache.set(mint, { createdMs, source, at: deps.now() });
}

function fromCache(mint) {
  const hit = cache.get(mint);
  if (!hit) return undefined;
  const ttl = hit.miss ? MISS_TTL_MS : HIT_TTL_MS;
  if (deps.now() - hit.at > ttl) { cache.delete(mint); return undefined; }
  return hit;
}

function result(hit) {
  if (!hit || hit.miss) return { hours: null, source: null, created_ms: null };
  return { hours: ageHoursSince(hit.createdMs, deps.now()), source: hit.source, created_ms: hit.createdMs };
}

/**
 * Token age for a mint: { hours, source, created_ms } (hours null = unknown).
 * `poolRow` (an already-fetched pool-discovery row) or `pool` (address to fetch)
 * lets the Meteora token_x.created_at answer before GMGN is asked. Never throws.
 */
export async function getTokenAgeInfo(mint, { pool = null, poolRow = undefined } = {}) {
  if (!mint) return result(null);
  const cached = fromCache(mint);
  if (cached) return result(cached);

  let row = poolRow;
  if (row === undefined && pool) {
    row = await withTimeout(Promise.resolve().then(() => deps.fetchPoolRow(pool)).catch(() => null), LOOKUP_TIMEOUT_MS);
  }
  const rowMs = row?.token_x?.address === mint ? toEpochMs(row?.token_x?.created_at) : null;
  if (rowMs != null) {
    primeTokenAge(mint, rowMs, "meteora");
    return result(cache.get(mint));
  }

  const info = await withTimeout(Promise.resolve().then(() => deps.fetchGmgnTokenInfo(mint)).catch(() => null), LOOKUP_TIMEOUT_MS);
  const gmgnMs = toEpochMs(info?.creation_timestamp) ?? toEpochMs(info?.open_timestamp);
  if (gmgnMs != null) {
    primeTokenAge(mint, gmgnMs, "gmgn");
    return result(cache.get(mint));
  }
  cache.set(mint, { miss: true, at: deps.now() });
  return result(null);
}

/** Hours since the token's creation, or null when unknown. */
export async function getTokenAgeHours(mint, opts = {}) {
  return (await getTokenAgeInfo(mint, opts)).hours;
}

/* ============================== screening ============================== */

/**
 * Apply the token-age window to screening candidates from any source.
 * Every kept candidate is tagged token_age_hours / token_age_source (or
 * token_age_unknown: true). Candidates with no age on the row are looked up
 * (at most `maxLookups`, only when a window is set). Returns { kept, dropped }.
 */
export async function screenTokenAge(pools, {
  window = tokenAgeWindow(),
  lookup = getTokenAgeInfo,
  maxLookups = DEFAULT_MAX_SCREEN_LOOKUPS,
  nowMs = deps.now(),
} = {}) {
  const rows = (pools || []).map((p) => {
    const age = candidateTokenAge(p, nowMs);
    if (age?.source === "meteora" && p.base?.mint) primeTokenAge(p.base.mint, age.created_ms, "meteora");
    return { p, age };
  });

  if (window) {
    const need = rows.filter((r) => !r.age && r.p.base?.mint);
    const toLook = need.slice(0, Math.max(0, maxLookups));
    if (need.length > toLook.length) {
      log("screening_warn", `Token age: ${need.length - toLook.length} candidate(s) not looked up (cap ${maxLookups}); kept with age unknown`);
    }
    await Promise.all(toLook.map(async (r) => {
      const info = await Promise.resolve().then(() => lookup(r.p.base.mint, { pool: r.p.pool })).catch(() => null);
      if (info?.hours != null) r.age = { hours: info.hours, source: info.source, created_ms: info.created_ms ?? null };
    }));
  }

  const kept = [];
  const dropped = [];
  let unknown = 0;
  for (const { p, age } of rows) {
    const tagged = age
      ? { ...p, token_age_hours: age.hours, token_age_source: age.source, token_age_unknown: false }
      : { ...p, token_age_hours: null, token_age_source: null, token_age_unknown: true };
    const r = evaluateTokenAgeWindow(age?.hours ?? null, window);
    if (r.pass === false) {
      dropped.push({ pool: p.pool, name: p.name, reasons: [r.reason] });
      log("screening", `Entry filter dropped ${p.name ?? p.pool}: ${r.reason} [age source: ${age.source}]`);
      continue;
    }
    if (r.unknown) unknown++;
    kept.push(tagged);
  }
  if (unknown > 0) log("screening_warn", `Token age unknown for ${unknown} candidate(s); kept (age: unknown), deploy re-checks`);
  return { kept, dropped };
}

/* ============================== deploy ============================== */

/**
 * Deploy-time token-age check for every strategy. The deploy pool's own
 * pool-discovery row supplies both the base mint and token_x.created_at; GMGN
 * is the fallback. Returns { pass, unknown, hours, source, mint, reason }.
 * pass false = refuse. Unknown age passes (the caller logs a warning).
 */
export async function checkDeployTokenAge({ mint = null, pool_address = null, window = tokenAgeWindow(), resolveMint = null } = {}) {
  if (!window) return { pass: true, unknown: false, skipped: true, hours: null, source: null, mint, reason: null };
  let row = null;
  if (pool_address) {
    row = await withTimeout(Promise.resolve().then(() => deps.fetchPoolRow(pool_address)).catch(() => null), LOOKUP_TIMEOUT_MS);
  }
  // The pool's actual base token wins over a caller-supplied base_mint.
  let resolved = row?.token_x?.address || mint || null;
  if (!resolved && resolveMint) resolved = await Promise.resolve().then(resolveMint).catch(() => null);
  if (mint && row?.token_x?.address && mint !== row.token_x.address) {
    log("deploy_warn", `base_mint ${mint.slice(0, 8)} does not match the pool's token ${row.token_x.address.slice(0, 8)}; checking the pool's token age`);
  }
  const info = resolved ? await getTokenAgeInfo(resolved, { poolRow: row }) : { hours: null, source: null };
  const r = evaluateTokenAgeWindow(info.hours, window);
  return {
    pass: r.pass !== false,
    unknown: !!r.unknown,
    hours: info.hours,
    source: info.source,
    mint: resolved,
    window,
    reason: r.pass === false
      ? `Token age: ${r.reason} (window ${fmtWindow(window)}, minTokenAgeHours/maxTokenAgeHours; source ${info.source}); refusing to deploy.`
      : null,
  };
}
