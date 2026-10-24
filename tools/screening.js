import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { log } from "../logger.js";
import { instrumentConnection } from "./rpc-stats.js";
import { scoreSignalSnapshot } from "../signal-weights.js";
import { meteoraGateMode } from "./gmgn-policy.js";
import { fetchGmgnSignalMap, attachGmgnSignals, gmgnSignalBooleans } from "./gmgn-signals.js";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const WSOL_MINT = "So11111111111111111111111111111111111111112";



/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */
export async function discoverPools({
  page_size = 50,
} = {}) {
  const s = config.screening;
  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    "is_blacklisted=false",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    `tvl<=${s.maxTvl}`,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    "quote_token_organic_score>=60",
  ].join("&&");

  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${s.timeframe}` +
    `&category=${s.category}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  const condensed = (data.data || []).map(condensePool);

  // Filter blacklisted base tokens
  const pools = condensed.filter((candidate) => {
    const p = normalizeCandidateForUi(candidate);
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    // Deploys fund the Y side with SOL, so only SOL-quoted pools are usable.
    if (p.quote?.mint && p.quote.mint !== WSOL_MINT) {
      return false;
    }
    if (p.volatility != null && p.volatility > s.maxVolatility) {
      return false;
    }
    if (p.price_change_pct != null && Math.abs(p.price_change_pct) > s.maxPriceChangePct) {
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) {
    log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens`);
  }

  return {
    total: data.total,
    pools,
  };
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
// Concurrent callers (screening cycle, dashboard, deploy-request path, the LLM get_top_candidates
// tool) with the same limit share ONE in-flight run instead of each re-spending GMGN weight.
const _topInflight = new Map();
export function getTopCandidates({ limit = 10 } = {}) {
  const key = String(limit);
  let p = _topInflight.get(key);
  if (!p) {
    p = getTopCandidatesUncached({ limit }).finally(() => _topInflight.delete(key));
    _topInflight.set(key, p);
  }
  // Each caller gets its own candidate objects (callers attach _gmgnResult etc. in place).
  return p.then((r) => (r && Array.isArray(r.candidates) ? { ...r, candidates: r.candidates.map((c) => ({ ...c })) } : r));
}

/** Shadow-gate verdict keys: pure log data, never shown to the LLM (it would turn shadow into a soft gate). */
const SHADOW_GATE_KEYS = ["gmgn_gate_would_drop", "gmgn_gate_would_drop_reasons", "gmgn_gate_would_drop_kind"];

/** Copy of a candidate without the shadow-gate verdict (the log-only nested block is also removed). */
export function stripShadowGateFields(candidate) {
  if (!candidate || typeof candidate !== "object") return candidate;
  const c = { ...candidate };
  for (const k of SHADOW_GATE_KEYS) delete c[k];
  if (c.gmgn_risk_log_only && typeof c.gmgn_risk_log_only === "object") {
    c.gmgn_risk_log_only = { ...c.gmgn_risk_log_only };
    for (const k of SHADOW_GATE_KEYS) delete c.gmgn_risk_log_only[k];
  }
  return c;
}

/** get_top_candidates as exposed to the LLM tool layer: same data, shadow-gate fields removed. */
export async function getTopCandidatesForTool(args = {}) {
  const r = await getTopCandidates(args);
  if (!r || !Array.isArray(r.candidates)) return r;
  const { gmgn_gate_would_drop, ...rest } = r; // eslint-disable-line no-unused-vars
  return { ...rest, candidates: r.candidates.map(stripShadowGateFields) };
}

/**
 * Gate-module crash handler (exported for tests). Hard mode: do not wave non-GMGN candidates through.
 * Shadow mode never drops, so keep them. Either way the operator hears once.
 */
export async function handleGateCrash(error, open, { mode = meteoraGateMode(config), report } = {}) {
  log("gmgn_gate", `Safety gate failed (${error?.message || error}); ${mode === "hard" ? "dropping non-GMGN candidates this cycle" : "shadow mode: keeping candidates"}`);
  try {
    const fn = report || (await import("./gmgn-outage.js")).reportGmgnOutage;
    fn(`Meteora-source GMGN gate crashed: ${String(error?.message || error).slice(0, 160)}`);
  } catch { /* best effort */ }
  return mode === "hard" ? open.filter((p) => p.gmgn || p.gmgn_gated) : open;
}

async function getTopCandidatesUncached({ limit = 10 } = {}) {
  const { config } = await import("../config.js");

  // Route to the opt-in GMGN screening source. Defaults to Meteora when
  // screening.source is unset, so the existing path is untouched.
  let pools;
  if (config.screening.source === "both") {
    // Meteora + GMGN in parallel, deduped per pool and per token, with the
    // Meteora pool filters applied to GMGN-only picks (tools/screening-both.js).
    // Over-fetch so the occupied-pool filter below still leaves `limit` rows.
    const { discoverCombinedPools } = await import("./screening-both.js");
    ({ pools } = await discoverCombinedPools({ limit: Math.max(limit * 3, 30) }));
  } else if (config.screening.source === "gmgn") {
    // Dynamic import keeps gmgn-screen.js (and its gmgn-cli dependency) off the
    // hot path for the default Meteora flow.
    const { discoverGmgnPools } = await import("./gmgn-screen.js");
    ({ pools } = await discoverGmgnPools({ limit: Math.max(limit, 10) }));

    // Parity with the Meteora path (which filters blacklisted base tokens
    // inside discoverPools): drop blacklisted base mints here.
    pools = (pools || []).filter((p) => {
      if (isBlacklisted(p.base?.mint)) {
        log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
        return false;
      }
      return true;
    });
  } else {
    ({ pools } = await discoverPools({ page_size: 50 }));
  }

  // Entry-safety filters (config.entryFilters): token guards from the API
  // fields, with one batched mint read for Token-2022 / unknown mints.
  const screenedCount = (pools || []).length;
  const { screenEntryCandidates } = await import("./entry-safety.js");
  const entry = await screenEntryCandidates(pools || []);
  pools = entry.kept;

  // GMGN market signals (buy pressure / spikes): one cached fetch per cycle,
  // attached as `gmgn_signals` before Darwin ranking. Informational only.
  await attachScreeningGmgnSignals(pools);

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));

  let open = pools.filter((p) => !occupiedPools.has(p.pool) && !occupiedMints.has(p.base?.mint));

  // GMGN safety gates for candidates that did NOT come through the GMGN pipeline
  // (default Meteora source + Meteora-only rows in "both"). Fail closed on unknown
  // data; skipped when no GMGN key is configured. Runs after the occupied-pool
  // filter so no weighted GMGN calls are spent on pools we already hold.
  let gmgnGate = null;
  try {
    const { gateMeteoraSourceCandidates } = await import("./gmgn-screen.js");
    // Darwin-rank first so the weight-limited gate verifies the pools most likely to be picked.
    gmgnGate = await gateMeteoraSourceCandidates(open, { limit, deps: { rankFn: rankCandidatesByDarwin } });
    open = gmgnGate.kept;
  } catch (e) {
    open = await handleGateCrash(e, open);
  }

  const eligible = rankCandidatesByDarwin(open);

  // Remember what price each candidate was shown at (deploy-time drift guard).
  // ONLY Pool Discovery `pool_price` (SOL per token) is recorded: that is the unit
  // the deploy-time check compares against. GMGN rows carry a USD token price, so
  // they are skipped (logged), including GMGN-only rows in "both" mode.
  if (config.screening.source !== "gmgn") {
    const { noteScreenedPrice, noteUncomparableScreenPrice } = await import("../deploy-guards.js");
    for (const p of eligible) {
      const fromPoolDiscovery = !Array.isArray(p.sources) || p.sources.includes("meteora");
      if (!fromPoolDiscovery) {
        noteUncomparableScreenPrice(p.pool);
        log("screening", `Screen price not recorded for ${p.pool}: GMGN-only candidate (USD price, not comparable to pool_price)`);
        continue;
      }
      noteScreenedPrice(p.pool, p.price);
    }
  }

  return {
    candidates: eligible.slice(0, limit).map(normalizeCandidateForUi),
    total_eligible: eligible.length,
    total_screened: screenedCount,
    entry_filtered: entry.dropped.length,
    gmgn_gate_dropped: gmgnGate?.dropped?.length ?? 0,
    gmgn_gate_would_drop: gmgnGate?.would_drop?.length ?? 0,
    gmgn_gate_outage: gmgnGate?.outage ?? false,
    gmgn_gate_rate_limited: gmgnGate?.rate_limited ?? false,
  };
}

/**
 * Attach `gmgn_signals` to every candidate when config.screening.gmgnSignalsEnabled
 * is on. Never throws; a failed fetch leaves gmgn_signals null (unknown).
 */
export async function attachScreeningGmgnSignals(pools, { cfg = config, fetchMap = fetchGmgnSignalMap } = {}) {
  if (!Array.isArray(pools) || pools.length === 0) return;
  if (cfg.screening?.gmgnSignalsEnabled === false) return;
  try {
    const map = await fetchMap({ cfg });
    const hits = attachGmgnSignals(pools, map);
    if (map?.ok) log("gmgn_signals", `${hits}/${pools.length} candidate(s) have GMGN market signals`);
  } catch (e) {
    log("gmgn_signals", `Attach failed: ${e?.message || e}`);
  }
}

export function normalizeCandidateForUi(candidate) {
  return {
    ...candidate,
    volume: candidate.volume ?? candidate.volume_window ?? candidate.volume_24h ?? null,
    active_pct: candidate.active_pct ?? candidate.active_bin_pct ?? null,
  };
}

/**
 * Short provenance tag for prompts, e.g. "src: meteora+gmgn (confirmed by both)".
 * Empty when the candidate has no `sources` (single-source modes).
 */
export function formatCandidateSources(candidate) {
  const sources = Array.isArray(candidate?.sources) ? candidate.sources : [];
  if (sources.length === 0) return "";
  return `src: ${sources.join("+")}${candidate.confirmed_by_both ? " (confirmed by both)" : ""}`;
}

export function getCandidateSignalSnapshot(candidate) {
  const c = normalizeCandidateForUi(candidate);
  return {
    organic_score: c.organic_score ?? c.base?.organic ?? null,
    fee_tvl_ratio: c.fee_active_tvl_ratio ?? c.fee_tvl_ratio ?? null,
    volume: c.volume ?? null,
    mcap: c.mcap ?? null,
    holder_count: c.holders ?? null,
    smart_wallets_present: c._smartWalletCount != null ? c._smartWalletCount > 0 : c.smart_wallets_present ?? null,
    narrative_quality: c.narrative_quality ?? null,
    study_win_rate: c.study_win_rate ?? null,
    volatility: c.volatility ?? null,
    ath_proximity: c._gmgnResult?.ath_proximity_pct ?? c.ath_proximity ?? null,
    volume_trend: c._gmgnResult?.candles?.volume_trend ?? c.volume_trend ?? null,
    // Series continuity: this signal has always meant "tagged smart/KOL/whale holders present"
    // (signal_count_30m was a holder snapshot, not a 30m event count). tagged_holder_count is the
    // honest name for the same number; the legacy field is the fallback for older snapshots.
    gmgn_signal_present: c._gmgnSignal ? (((c._gmgnSignal.tagged_holder_count ?? c._gmgnSignal.signal_count_30m) || 0) > 0) : c.gmgn_signal_present ?? null,
    change_1h: c._gmgnResult?.change_1h ?? c.change_1h ?? null,
    candle_price_range: c._gmgnResult?.candles?.price_range_pct ?? c.candle_price_range ?? null,
    // GMGN market-signal feed (tools/gmgn-signals.js); null = not fetched.
    ...gmgnSignalBooleans(c.gmgn_signals),
    // LOG-ONLY GMGN risk fields (security + extra stat/pool metrics): recorded for later
    // per-origin analysis, NEVER read by scoreSignalSnapshot or any gate.
    gmgn_risk_log_only: gmgnRiskLogOnly(c),
  };
}

const GMGN_RISK_LOG_KEYS = [
  "gmgn_creator_hold_pct", "gmgn_top70_sniper_hold_pct", "gmgn_entrapment_trader_pct", "gmgn_private_vault_hold_pct",
  "gmgn_creator_created_count", "gmgn_creator_token_status", "gmgn_pool_liquidity_ratio",
  "gmgn_renounced_mint", "gmgn_renounced_freeze", "gmgn_lp_burned", "gmgn_lp_locked", "gmgn_buy_tax", "gmgn_sell_tax",
  "gmgn_security_status", "gmgn_risk_log_only_flags", "gmgn_sniper_supply_share_pct", "gmgn_sniper_row_rate_pct",
  // Meteora-source GMGN gate verdict (shadow mode records it without dropping).
  "gmgn_gate_would_drop", "gmgn_gate_would_drop_reasons", "gmgn_gate_would_drop_kind",
];

function gmgnRiskLogOnly(c) {
  if (c?.gmgn_security_status == null && c?.gmgn_gate_would_drop == null && c?.gmgn_gate_would_drop_kind == null) return null;
  const out = {};
  for (const k of GMGN_RISK_LOG_KEYS) if (c[k] !== undefined) out[k] = c[k];
  return out;
}

export function rankCandidatesByDarwin(candidates = []) {
  return candidates
    .map((candidate, index) => {
      const normalized = normalizeCandidateForUi(candidate);
      const darwin = scoreSignalSnapshot(getCandidateSignalSnapshot(normalized), { topN: 3 });
      return {
        ...normalized,
        darwin_score: darwin.score_pct,
        darwin_weight_coverage: darwin.coverage,
        darwin_top_signals: darwin.topSignals,
        _darwin_sort_index: index,
      };
    })
    .sort((a, b) =>
      // screeningSource "both": pools confirmed by both sources rank first.
      (b.confirmed_by_both ? 1 : 0) - (a.confirmed_by_both ? 1 : 0) ||
      (b.darwin_score ?? 0) - (a.darwin_score ?? 0) ||
      (b.fee_active_tvl_ratio ?? 0) - (a.fee_active_tvl_ratio ?? 0) ||
      (b.volume ?? 0) - (a.volume ?? 0) ||
      (b.organic_score ?? 0) - (a.organic_score ?? 0) ||
      (a._darwin_sort_index ?? 0) - (b._darwin_sort_index ?? 0)
    )
    .map(({ _darwin_sort_index, ...candidate }) => candidate);
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const fetchPool = async (tf) => {
    const url = `${POOL_DISCOVERY_BASE}/pools?` +
      `page_size=1` +
      `&filter_by=${encodeURIComponent(`pool_address=${pool_address}`)}` +
      `&timeframe=${tf}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
    const data = await res.json();
    return (data.data || [])[0] || null;
  };

  // Fetch requested timeframe, 1h context, AND OHLCV candles in parallel
  const [pool, pool1h, ohlcvData] = await Promise.all([
    fetchPool(timeframe),
    timeframe !== "1h" ? fetchPool("1h").catch(() => null) : null,
    fetchOhlcvSummary(pool_address).catch(() => null),
  ]);

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  const condensed = condensePool(pool);
  condensed.timeframe = timeframe;
  condensed._summary = `${timeframe}: fee/TVL ${condensed.fee_active_tvl_ratio || 0}%, ${condensed.swap_count || 0} swaps, volatility ${condensed.volatility}`;

  // Attach 1h context so LLM can see the bigger picture alongside the 5m snapshot
  if (pool1h) {
    condensed.context_1h = {
      volume: round(pool1h.volume),
      fee: round(pool1h.fee),
      fee_active_tvl_ratio: fix(pool1h.fee_active_tvl_ratio, 4),
      swap_count: pool1h.swap_count,
    };
    condensed._summary += ` | 1h context: volume $${round(pool1h.volume)}, fee $${round(pool1h.fee)}, fee/TVL ${fix(pool1h.fee_active_tvl_ratio, 4)}%, ${pool1h.swap_count} swaps`;
  }

  // Attach OHLCV summary — definitive "is this pool alive?" signal
  if (ohlcvData) {
    condensed.ohlcv_summary = ohlcvData;
    condensed._summary += ` | OHLCV (${ohlcvData.period}): last 3 vols $${ohlcvData.latest_3_volumes?.join(', $')}, ${ohlcvData.zero_volume_candles}/${ohlcvData.candles} empty, trend ${ohlcvData.volume_trend}, price ${ohlcvData.price_direction}`;
  }

  return condensed;
}

/**
 * Fetch OHLCV candles and summarize into actionable signals.
 * Returns a compact summary the LLM can act on without parsing raw candles.
 */
const OHLCV_BASE = "https://dlmm.datapi.meteora.ag/pools";

async function fetchOhlcvSummary(poolAddress, timeframe = "5m") {
  const res = await fetch(`${OHLCV_BASE}/${poolAddress}/ohlcv?timeframe=${timeframe}`);
  if (!res.ok) return null;

  const json = await res.json();
  const candles = json.data || [];
  if (candles.length === 0) return null;

  const volumes = candles.map(c => c.volume || 0);
  const closes = candles.map(c => c.close || 0);
  const zeroCount = volumes.filter(v => v === 0).length;
  const volAvg = volumes.length > 0 ? Math.round(volumes.reduce((s, v) => s + v, 0) / volumes.length) : 0;
  const volMin = Math.round(Math.min(...volumes));
  const volMax = Math.round(Math.max(...volumes));

  // Volume trend: compare first half avg vs second half avg
  const mid = Math.floor(volumes.length / 2);
  const firstHalf = volumes.slice(0, mid);
  const secondHalf = volumes.slice(mid);
  const firstAvg = firstHalf.reduce((s, v) => s + v, 0) / (firstHalf.length || 1);
  const secondAvg = secondHalf.reduce((s, v) => s + v, 0) / (secondHalf.length || 1);
  const volTrend = secondAvg > firstAvg * 1.2 ? "increasing" : secondAvg < firstAvg * 0.8 ? "decreasing" : "stable";

  // Price direction: compare first vs last close
  const firstClose = closes[0] || 0;
  const lastClose = closes[closes.length - 1] || 0;
  const priceChangePct = firstClose > 0 ? ((lastClose - firstClose) / firstClose) * 100 : 0;
  const priceDir = priceChangePct > 2 ? "up" : priceChangePct < -2 ? "down" : "ranging";

  // Latest candle age
  const latestCandle = candles[candles.length - 1];
  const latestTs = latestCandle.timestamp ? latestCandle.timestamp * 1000 : Date.parse(latestCandle.timestamp_str);
  const ageMs = Date.now() - latestTs;
  const ageMins = Math.floor(ageMs / 60000);
  const ageLabel = ageMins <= 0 ? "just now" : `${ageMins} min ago`;

  // Last 3 candle volumes — the LLM sees the actual recent trajectory
  const latest3 = volumes.slice(-3).map(v => Math.round(v));

  return {
    timeframe,
    candles: candles.length,
    period: `last ${candles.length * (timeframe === "5m" ? 5 : timeframe === "30m" ? 30 : 60)} min`,
    latest_3_volumes: latest3,
    zero_volume_candles: zeroCount,
    volume_trend: volTrend,
    price_direction: priceDir,
    price_change_pct: fix(priceChangePct, 2),
    latest_candle_volume: Math.round(latestCandle.volume || 0),
    latest_candle_age: ageLabel,
  };
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
export function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
      // Entry-safety inputs (tools/entry-safety.js): no RPC needed for legacy SPL mints.
      token_program: p.token_x?.token_program ?? null,
      has_freeze_authority: p.token_x?.has_freeze_authority ?? null,
      has_mint_authority: p.token_x?.has_mint_authority ?? null,
      // Token creation time (epoch ms) — the token-age window (tools/token-age.js), not pool age.
      created_at: p.token_x?.created_at ?? null,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    is_blacklisted: p.is_blacklisted ?? null,
    bin_step: p.dlmm_params?.bin_step || null,
    collect_fee_mode: p.dlmm_params?.collect_fee_mode ?? null, // "quote" = OnlyY (fees in SOL), "both" = InputOnly
    fee_pct: p.fee_pct,

    // Core metrics
    tvl: round(p.tvl),
    active_tvl: round(p.active_tvl),
    volume: round(p.volume),
    fee: round(p.fee),
    fee_active_tvl_ratio: p.fee_active_tvl_ratio > 0
      ? fix(p.fee_active_tvl_ratio, 4)
      : (p.active_tvl > 0 ? fix((p.fee / p.active_tvl) * 100, 4) : 0),
    swap_count: p.swap_count,
    volatility: fix(p.volatility, 2),

    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity
    unique_traders: p.unique_traders,
  };
}

/**
 * Fetch the current dynamic fee for a pool via the DLMM SDK (on-chain).
 * Returns { base_fee_pct, dynamic_fee_pct } or null on failure.
 * Reuses a single Connection to avoid RPC rate limit pressure.
 */
let _feeConn = null;
export async function fetchDynamicFee(poolAddress) {
  try {
    const { default: DLMM } = await import("@meteora-ag/dlmm");
    const { Connection, PublicKey } = await import("@solana/web3.js");
    if (!_feeConn) _feeConn = instrumentConnection(new Connection(process.env.RPC_URL, "confirmed"));
    const pool = await DLMM.create(_feeConn, new PublicKey(poolAddress));
    // getDynamicFee() returns the TOTAL current fee % (base + variable), not the
    // variable component alone. Take base from getFeeInfo() (which correctly
    // accounts for baseFeePowerFactor) and derive the true dynamic part.
    const feeInfo = pool.getFeeInfo();
    const baseFeePct = Number(feeInfo.baseFeeRatePercentage?.toString?.() ?? feeInfo.baseFeeRatePercentage);
    const totalFeePct = Number(pool.getDynamicFee().toString());
    return {
      base_fee_pct: baseFeePct,
      dynamic_fee_pct: Math.max(0, totalFeePct - baseFeePct),
      total_fee_pct: totalFeePct,
    };
  } catch { return null; }
}

function round(n) {
  const num = Number(n);
  return Number.isFinite(num) ? Math.round(num) : null;
}

function fix(n, decimals) {
  const num = Number(n);
  return Number.isFinite(num) ? Number(num.toFixed(decimals)) : null;
}
