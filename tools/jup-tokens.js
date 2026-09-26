/**
 * Jupiter Tokens API V2 (official): token search + metadata.
 *
 *   GET https://api.jup.ag/tokens/v2/search?query=<symbol|name|mint[,mint…]>
 *   header x-api-key: JUPITER_API_KEY (same key as Swap v2 / Price v3 in wallet.js)
 *
 * The query takes a symbol, a name or a mint; comma-separated mints (max 100)
 * return exactly those mints. The response is an array of MintInformation
 * (see normalizeJupToken). `audit.isSus` is only PRESENT when Jupiter has
 * flagged the token, so we check presence, not value.
 *
 * Fallback: when the official call fails (network, timeout, non-2xx, bad
 * body) we fall back to the internal datapi search (datapi.jup.ag/v1/assets/
 * search), which returns the same shape plus a few extra fields.
 *
 * Nothing here throws: failures return null. Per-mint results are cached for
 * CACHE_TTL_MS so screening, the deploy check and the lookup card share one read.
 */

import { log } from "../logger.js";

export const JUP_TOKENS_BASE = "https://api.jup.ag/tokens/v2";
export const DATAPI_BASE = "https://datapi.jup.ag/v1";
export const CACHE_TTL_MS = 60_000;
export const TIMEOUT_MS = 5_000;
const MAX_MINTS_PER_QUERY = 100;

const _cache = new Map(); // mint -> { at, info }

/** Test hook: clear the per-mint cache. */
export function _resetJupTokensCacheForTest() { _cache.clear(); }

const num = (v) => (v == null || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const bool = (v) => (v == null ? null : !!v);

function headers() {
  const key = process.env.JUPITER_API_KEY || "";
  return key ? { "x-api-key": key } : {};
}

function normStats(s) {
  if (!s || typeof s !== "object") return null;
  return {
    price_change: num(s.priceChange),
    holder_change: num(s.holderChange),
    liquidity_change: num(s.liquidityChange),
    volume_change: num(s.volumeChange),
    buy_volume: num(s.buyVolume),
    sell_volume: num(s.sellVolume),
    buy_organic_volume: num(s.buyOrganicVolume),
    sell_organic_volume: num(s.sellOrganicVolume),
    num_buys: num(s.numBuys),
    num_sells: num(s.numSells),
    num_traders: num(s.numTraders),
    num_organic_buyers: num(s.numOrganicBuyers),
    num_net_buyers: num(s.numNetBuyers),
  };
}

/**
 * Banned status. The Tokens V2 schema documents "banned" as a verification
 * level but exposes no field for it, so accept the plausible shapes
 * defensively (explicit flag or a "banned" tag). isVerified === false alone is
 * NOT banned (it's just unverified).
 */
function isBanned(t) {
  if (t?.isBanned === true || t?.banned === true) return true;
  if (typeof t?.verification === "string" && t.verification.toLowerCase() === "banned") return true;
  return Array.isArray(t?.tags) && t.tags.some((g) => String(g).toLowerCase() === "banned");
}

/** Normalize one MintInformation object (official or datapi) to snake_case. */
export function normalizeJupToken(t, source = "tokens_v2") {
  if (!t || typeof t !== "object" || !t.id) return null;
  const a = t.audit && typeof t.audit === "object" ? t.audit : null;
  return {
    mint: t.id,
    name: t.name ?? null,
    symbol: t.symbol ?? null,
    decimals: num(t.decimals),
    icon: t.icon ?? null,
    token_program: t.tokenProgram ?? null,
    is_verified: bool(t.isVerified),
    // Raw 0–100 score; the label (high/medium/low) is kept for reference only.
    organic_score: num(t.organicScore),
    organic_score_label: t.organicScoreLabel ?? null,
    is_sus: !!a && Object.prototype.hasOwnProperty.call(a, "isSus"),
    banned: isBanned(t),
    tags: Array.isArray(t.tags) ? t.tags.map(String) : [],
    holder_count: num(t.holderCount),
    mcap: num(t.mcap),
    fdv: num(t.fdv),
    liquidity: num(t.liquidity),
    usd_price: num(t.usdPrice),
    circ_supply: num(t.circSupply),
    total_supply: num(t.totalSupply),
    launchpad: t.launchpad ?? null,
    graduated_pool: t.graduatedPool ?? null,
    created_at: t.createdAt ?? null,
    first_pool: t.firstPool ?? null,
    audit: a ? {
      mint_authority_disabled: bool(a.mintAuthorityDisabled),
      freeze_authority_disabled: bool(a.freezeAuthorityDisabled),
      top_holders_pct: num(a.topHoldersPercentage),
      dev_balance_pct: num(a.devBalancePercentage),
      dev_mints: num(a.devMints),
      dev_migrations: num(a.devMigrations),
      bot_holders_pct: num(a.botHoldersPercentage), // datapi only
    } : null,
    stats_5m: normStats(t.stats5m),
    stats_1h: normStats(t.stats1h),
    stats_6h: normStats(t.stats6h),
    stats_24h: normStats(t.stats24h),
    // Global fees paid by traders (priority + jito tips) in SOL: datapi only,
    // not part of the official Tokens API (null from tokens_v2).
    global_fees_sol: num(t.fees),
    source,
  };
}

async function fetchArray(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && data.id) return [data];
  throw new Error("unexpected response body");
}

/** Raw datapi search (legacy, internal). Returns the raw array or null. */
export async function datapiSearchRaw(query) {
  try {
    return await fetchArray(`${DATAPI_BASE}/assets/search?query=${encodeURIComponent(query)}`);
  } catch (e) {
    log("jup_tokens_warn", `datapi search failed (${String(query).slice(0, 40)}): ${e.message}`);
    return null;
  }
}

/**
 * Search by symbol, name or mint(s). Returns an array of normalized tokens
 * ([] = none found), or null when both the official API and datapi failed.
 */
export async function searchTokens(query) {
  const q = String(query ?? "").trim();
  if (!q) return null;
  let list;
  try {
    list = (await fetchArray(`${JUP_TOKENS_BASE}/search?query=${encodeURIComponent(q)}`, { headers: headers() }))
      .map((t) => normalizeJupToken(t, "tokens_v2")).filter(Boolean);
  } catch (e) {
    log("jup_tokens_warn", `Tokens API search failed (${q.slice(0, 40)}): ${e.message}; falling back to datapi`);
    const raw = await datapiSearchRaw(q);
    if (!raw) return null;
    list = raw.map((t) => normalizeJupToken(t, "datapi")).filter(Boolean);
  }
  const at = Date.now();
  for (const t of list) _cache.set(t.mint, { at, info: t });
  return list;
}

function cached(mint) {
  const hit = _cache.get(mint);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.info;
  return undefined;
}

/**
 * Info for many mints (batched, ≤100 per request). Returns Map<mint, info>
 * (mints Jupiter doesn't know are absent), or null when every lookup failed.
 */
export async function getTokensInfo(mints) {
  const out = new Map();
  const need = [];
  for (const m of new Set((mints || []).filter(Boolean))) {
    const c = cached(m);
    if (c !== undefined) out.set(m, c);
    else need.push(m);
  }
  let anyOk = need.length === 0;
  for (let i = 0; i < need.length; i += MAX_MINTS_PER_QUERY) {
    const chunk = need.slice(i, i + MAX_MINTS_PER_QUERY);
    const list = await searchTokens(chunk.join(","));
    if (!list) continue;
    anyOk = true;
    const wanted = new Set(chunk);
    for (const t of list) if (wanted.has(t.mint)) out.set(t.mint, t);
  }
  return anyOk ? out : null;
}

/**
 * Info for one mint: the normalized token, null when unknown or on failure.
 * Use getTokensInfo to tell "unknown" (absent) from "lookup failed" (null map).
 */
export async function getTokenInfo(mint) {
  if (!mint) return null;
  const c = cached(mint);
  if (c !== undefined) return c;
  const list = await searchTokens(mint);
  return list?.find((t) => t.mint === mint) ?? null;
}

/** Why Jupiter flags this token ([] = not flagged). */
export function jupiterFlagReasons(info) {
  const r = [];
  if (info?.is_sus) r.push("Jupiter flags the token as suspicious (audit.isSus)");
  if (info?.banned) r.push("Jupiter lists the token as banned");
  return r;
}
