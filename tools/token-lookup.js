/**
 * Read-only token lookup for the Telegram "paste a mint" card.
 *
 * Given a token mint it finds the token's Meteora DLMM pools quoted in SOL
 * (the same dlmm.datapi search + pool-discovery detail the GMGN screener uses),
 * condenses them into the candidate shape the Candidates view renders, adds the
 * token signals a candidate carries (GMGN price info + signal), and scores the
 * token/pools against the user's current screening filters.
 *
 * Nothing here signs, sends or writes. Every data source is injectable so the
 * tests run with no network. GMGN is best-effort: a failure or timeout leaves
 * `gmgn: null` and the pools still render.
 */

import { config } from "../config.js";
import { log } from "../logger.js";
import { candidateTokenAge } from "./token-age.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const LOOKUP_TIMEOUT_MS = 15_000;
export const MAX_LOOKUP_POOLS = 5;
const SEARCH_LIMIT = 10;

function finite(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), Math.max(0, ms));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Base58 + 32..44 chars. Callers also parse it with `new PublicKey()`. */
export const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A single Solana address (validated by PublicKey), else null. */
export async function parseMint(text) {
  const s = String(text ?? "").trim();
  if (!MINT_RE.test(s)) return null;
  try {
    const { PublicKey } = await import("@solana/web3.js");
    return new PublicKey(s).toBase58() === s ? s : null;
  } catch {
    return null;
  }
}

/* ============================== filter checks ============================== */

const fmtUsd = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "?";
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
  return `$${Math.round(n)}`;
};

function rangeCheck(key, label, value, min, max, fmt = (v) => String(v)) {
  if (min == null && max == null) return null; // filter not configured
  if (value == null) return { key, pass: null, text: `${label} unknown` };
  const pass = (min == null || value >= min) && (max == null || value <= max);
  const bounds = min != null && max != null ? `${fmt(min)}–${fmt(max)}` : min != null ? `≥ ${fmt(min)}` : `≤ ${fmt(max)}`;
  return { key, pass, text: `${label} ${fmt(value)} (${bounds})` };
}

/**
 * Score a candidate against the configured screening filters (config.screening
 * values, never local thresholds). Token-level: mcap, holders, organic, age.
 * Pool-level: bin step, TVL, volatility, fee/aTVL. `pass: null` = unknown.
 */
export function screeningFilterChecks(c, screening = config.screening) {
  const s = screening || {};
  const pool = [
    rangeCheck("bin_step", "bin step", finite(c.bin_step), s.minBinStep, s.maxBinStep),
    rangeCheck("tvl", "TVL", finite(c.tvl) ?? finite(c.active_tvl), s.minTvl, s.maxTvl, fmtUsd),
    rangeCheck("volatility", "volatility", finite(c.volatility), null, s.maxVolatility),
    rangeCheck("fee_tvl", "fee/aTVL", finite(c.fee_active_tvl_ratio) ?? finite(c.fee_tvl_ratio), s.minFeeActiveTvlRatio, null, (v) => `${v}%`),
  ].filter(Boolean);
  const token = [
    rangeCheck("mcap", "mcap", finite(c.mcap), s.minMcap, s.maxMcap, fmtUsd),
    rangeCheck("holders", "holders", finite(c.holders), s.minHolders, null),
    rangeCheck("organic", "organic", finite(c.organic_score), s.minOrganic, null),
    rangeCheck("age", "age", finite(c.token_age_hours), s.minTokenAgeHours ?? null, s.maxTokenAgeHours ?? null, (v) => `${Math.round(v * 10) / 10}h`),
  ].filter(Boolean);
  return { pool, token };
}

/* ============================== data sources ============================== */

async function defaultSearchPools(mint) {
  const { fetchTopMeteoraDlmmPoolsForMint } = await import("./gmgn-screen.js");
  return fetchTopMeteoraDlmmPoolsForMint(mint, 0, SEARCH_LIMIT);
}

async function defaultPoolDetail(poolAddress) {
  const { fetchPoolDetailDirect } = await import("./gmgn-screen.js");
  return fetchPoolDetailDirect(poolAddress);
}

async function defaultCondense(raw) {
  const { condensePool, normalizeCandidateForUi } = await import("./screening.js");
  return normalizeCandidateForUi(condensePool(raw));
}

async function defaultGmgnPriceInfo(mint) {
  const { fetchGmgnPriceInfo } = await import("./gmgn.js");
  return fetchGmgnPriceInfo(mint);
}

async function defaultGmgnSignal(mint) {
  const { fetchGmgnSignal } = await import("./gmgn.js");
  return fetchGmgnSignal(mint);
}

let _lookupConn = null;
/** One jsonParsed mint read for the lookup card's token-safety lines. */
async function defaultReadMint(mint) {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const { mintFactsFromParsed } = await import("./entry-safety.js");
  if (!_lookupConn) _lookupConn = new Connection(process.env.RPC_URL, "confirmed");
  const info = await _lookupConn.getParsedAccountInfo(new PublicKey(mint));
  return info?.value ? mintFactsFromParsed(info.value, mint) : null;
}

/** On-chain entry state (pool status, …) of one pool; see entry-safety.js. */
async function defaultPoolEntryState(poolAddress, opts) {
  const { readPoolEntryState } = await import("./entry-safety.js");
  return readPoolEntryState(poolAddress, opts);
}

async function defaultIsBlacklisted(mint) {
  const { isBlacklisted } = await import("../token-blacklist.js");
  return isBlacklisted(mint);
}

async function defaultCompare() {
  const { compareForTokenWinner } = await import("./screening-both.js");
  return compareForTokenWinner;
}

/** Darwin score per pool, exactly as the Candidates view gets it (order ignored). */
async function defaultScore(pools) {
  const { rankCandidatesByDarwin } = await import("./screening.js");
  return rankCandidatesByDarwin(pools);
}

const quoteMintOf = (raw) => raw?.token_y?.address ?? raw?.token_y_mint ?? null;
const baseMintOf = (raw) => raw?.token_x?.address ?? raw?.token_x_mint ?? null;

/** Candidate from a search row alone (pool-discovery had no detail for it). */
function candidateFromSearchRow(row) {
  return {
    pool: row.address || row.pool_address,
    name: row.name || null,
    base: { symbol: row.token_x?.symbol ?? null, mint: baseMintOf(row) },
    quote: { symbol: row.token_y?.symbol ?? "SOL", mint: quoteMintOf(row) },
    pool_type: "dlmm",
    bin_step: finite(row.pool_config?.bin_step),
    fee_pct: finite(row.pool_config?.base_fee_pct),
    tvl: finite(row.tvl ?? row.liquidity) != null ? Math.round(finite(row.tvl ?? row.liquidity)) : null,
    volume: finite(row.volume?.["24h"] ?? row.trade_volume_24h),
    fee_active_tvl_ratio: null,
    volatility: null,
    organic_score: null,
  };
}

/**
 * Look up a token. Returns
 *   { mint, symbol, blacklisted, pools, total_pools, gmgn, gmgn_error, checks, token_safety, error }
 * `token_safety` = evaluateTokenGuards() ({ pass, reasons, checks, unknown }).
 * `pools` (≤ 5) are SOL-quoted DLMM candidates sorted by fee/active-TVL then
 * TVL, each with `checks` ({ pool, token }). `error` is set when the Meteora
 * lookup itself failed (GMGN failures only set `gmgn_error`).
 */
export async function lookupToken(mint, { deps = {}, timeoutMs = LOOKUP_TIMEOUT_MS, screening = config.screening, entryFilters = null, now = () => Date.now() } = {}) {
  const {
    searchPools = defaultSearchPools,
    poolDetail = defaultPoolDetail,
    condense = defaultCondense,
    gmgnPriceInfo = defaultGmgnPriceInfo,
    gmgnSignal = defaultGmgnSignal,
    isBlacklisted = defaultIsBlacklisted,
    compare = null,
    score = defaultScore,
    readMint = defaultReadMint,
    poolEntryState = defaultPoolEntryState,
  } = deps;
  const started = now();
  const remaining = () => Math.max(0, timeoutMs - (now() - started));
  const out = { mint, symbol: null, blacklisted: false, pools: [], total_pools: 0, gmgn: null, gmgn_error: null, error: null };

  out.blacklisted = !!(await Promise.resolve().then(() => isBlacklisted(mint)).catch(() => false));

  // GMGN runs in parallel with the Meteora lookup and never blocks the card.
  const gmgnTask = withTimeout(
    Promise.allSettled([gmgnPriceInfo(mint), gmgnSignal(mint)]),
    remaining(),
    "GMGN",
  ).then(([p, s]) => {
    const price = p.status === "fulfilled" ? p.value : null;
    const signal = s.status === "fulfilled" ? s.value : null;
    if (!price && !signal) {
      out.gmgn_error = (p.reason?.message || s.reason?.message) ?? "no data";
      return null;
    }
    return { price, signal };
  }).catch((e) => {
    out.gmgn_error = e.message;
    return null;
  });

  const meteoraTask = withTimeout((async () => {
    const rows = (await searchPools(mint)) || [];
    // Strict: token X is this mint and token Y is wrapped SOL (by mint, never by symbol).
    const solRows = rows.filter((r) => baseMintOf(r) === mint && quoteMintOf(r) === WSOL_MINT);
    const details = await Promise.all(solRows.map((r) => Promise.resolve()
      .then(() => poolDetail(r.address || r.pool_address))
      .catch(() => null)));
    const pools = [];
    for (let i = 0; i < solRows.length; i++) {
      const d = details[i];
      const c = d ? await condense(d) : candidateFromSearchRow(solRows[i]);
      if (!c?.pool || (c.quote?.mint && c.quote.mint !== WSOL_MINT)) continue;
      pools.push({ ...c, name: c.name || solRows[i].name || null, sources: ["meteora"] });
    }
    return pools;
  })(), remaining(), "Meteora lookup").catch((e) => {
    out.error = e.message;
    return [];
  });

  // Token-2022 extensions / authorities for the entry-safety lines (one mint read).
  const mintTask = withTimeout(Promise.resolve().then(() => readMint(mint)), remaining(), "Mint read")
    .catch((e) => {
      out.token_safety_error = e.message;
      return null;
    });

  const [pools, gmgn, mintFacts] = await Promise.all([meteoraTask, gmgnTask, mintTask]);
  out.gmgn = gmgn;

  const cmp = compare || (await defaultCompare());
  const sorted = [...pools].sort(cmp);
  out.total_pools = sorted.length;

  const price = gmgn?.price || null;
  const signal = gmgn?.signal || null;
  // Token fields: Meteora first, GMGN as the fallback (same rule as mergeCandidates).
  const enriched = sorted.slice(0, MAX_LOOKUP_POOLS).map((c) => ({
    ...c,
    holders: c.holders ?? price?.holders ?? null,
    mcap: c.mcap ?? price?.market_cap ?? null,
    // Token creation time: Meteora token_x.created_at first, GMGN as the fallback.
    token_age_hours: candidateTokenAge(c)?.hours ?? price?.token_age_hours ?? null,
    token_age_source: candidateTokenAge(c)?.source ?? (price?.token_age_hours != null ? "gmgn" : null),
    change_1h: price?.change_1h ?? null,
    change_24h: price?.change_24h ?? null,
    gmgn_smart_wallets: signal?.smart_money_count_30m ?? null,
    gmgn_kol_wallets: signal?.kol_count_30m ?? null,
    indicators: price?.candles ? {
      supertrendDirection: price.candles.supertrend_direction ?? null,
      rsi: price.candles.rsi_2 ?? null,
    } : null,
  }));
  // Pool status (disabled / not yet active / blacklisted) per shown pool, read
  // on-chain in parallel; a failed read leaves the API blacklist flag alone.
  const states = await Promise.all(enriched.map((c) => withTimeout(
    Promise.resolve().then(() => poolEntryState(c.pool, { apiBlacklisted: c.is_blacklisted ?? null })),
    remaining(),
    "Pool state",
  ).catch((e) => ({ error: e.message }))));
  enriched.forEach((c, i) => { c.entry_state = states[i] || null; });

  let darwin = new Map();
  try {
    darwin = new Map((await score(enriched)).map((c) => [c.pool, c.darwin_score ?? null]));
  } catch { /* the darwin score is informational here */ }
  out.pools = enriched.map((c) => ({
    ...c,
    darwin_score: darwin.get(c.pool) ?? null,
    checks: screeningFilterChecks(c, screening),
  }));
  out.symbol = out.pools[0]?.base?.symbol ?? sorted[0]?.base?.symbol ?? null;

  // Entry-safety token guards (config.entryFilters): the mint read, else the
  // pool-discovery API's token_program / authority flags. deployPosition
  // re-checks from the pool's own mint, so this is display + early warning.
  {
    const { evaluateTokenGuards, mintFactsFromApi, currentEntryFilters } = await import("./entry-safety.js");
    const facts = mintFacts || mintFactsFromApi(sorted[0]?.base, mint);
    out.token_safety = evaluateTokenGuards(facts, entryFilters || currentEntryFilters());
    for (const p of out.pools) p.checks = { ...p.checks, safety: out.token_safety.checks };
  }

  // Token-level checks even with no pool (mcap/holders/age from GMGN).
  out.checks = out.pools[0]?.checks ?? screeningFilterChecks({
    holders: price?.holders ?? null,
    mcap: price?.market_cap ?? null,
    token_age_hours: out.pools[0]?.token_age_hours ?? price?.token_age_hours ?? null,
  }, screening);
  if (out.error) log("telegram_warn", `Token lookup ${mint.slice(0, 8)}: ${out.error}`);
  return out;
}
