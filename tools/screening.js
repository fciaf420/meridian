import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { log } from "../logger.js";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";



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
  const pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
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
export async function getTopCandidates({ limit = 10 } = {}) {
  const { config } = await import("../config.js");
  const { pools } = await discoverPools({ page_size: 50 });

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));

  const eligible = pools
    .filter((p) => !occupiedPools.has(p.pool) && !occupiedMints.has(p.base?.mint))
    .slice(0, limit);

  return {
    candidates: eligible,
    total_eligible: eligible.length,
    total_screened: pools.length,
  };
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
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics
    active_tvl: round(p.active_tvl),
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

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  return n != null ? Number(n.toFixed(decimals)) : null;
}
