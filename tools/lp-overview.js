/**
 * LP Agent overview metrics — cached, shared across the system.
 * Provides real PnL, win rate, fees, and position stats from LP Agent API.
 */

import { log } from "../logger.js";
import { getKey as getApiKey } from "../lpagent-keys.js";

const LPAGENT_API = "https://api.lpagent.io/open-api/v1";
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

let _cache = null;
let _cacheAt = 0;

async function getWalletAddress() {
  const bs58 = (await import("bs58")).default;
  const { Keypair } = await import("@solana/web3.js");
  if (!process.env.WALLET_PRIVATE_KEY) return null;
  return Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY)).publicKey.toString();
}

/**
 * Fetch LP overview metrics from LP Agent API.
 * Returns cached result if fresh (< 5 min old).
 *
 * @returns {Object|null} Overview metrics or null on failure
 */
export async function getLpOverview({ force = false } = {}) {
  if (!force && _cache && Date.now() - _cacheAt < CACHE_TTL) {
    return _cache;
  }

  const apiKey = await getApiKey();
  if (!apiKey) return _cache || null;

  try {
    const owner = await getWalletAddress();
    if (!owner) return _cache || null;

    const res = await fetch(
      `${LPAGENT_API}/lp-positions/overview?owner=${owner}&platform=meteora`,
      { headers: { "x-api-key": apiKey } }
    );

    if (!res.ok) {
      log("lp_overview", `API error: ${res.status}`);
      return _cache || null;
    }

    const json = await res.json();
    // Docs define `data` as an object; accept a one-element array defensively.
    const d = Array.isArray(json.data) ? json.data[0] : json.data;
    if (!d) return _cache || null;

    const pnlUnit = (await import("../config.js")).config.management.pnlUnit || "sol";
    const useSol = pnlUnit === "sol";

    _cache = {
      // PnL
      total_pnl: useSol ? round4(d.total_pnl_native?.ALL) : round2(d.total_pnl?.ALL),
      total_pnl_usd: round2(d.total_pnl?.ALL),
      total_pnl_sol: round4(d.total_pnl_native?.ALL),
      pnl_unit: pnlUnit,

      // Fees
      total_fees: useSol ? round4(d.total_fee_native?.ALL) : round2(d.total_fee?.ALL),
      total_fees_usd: round2(d.total_fee?.ALL),
      total_fees_sol: round4(d.total_fee_native?.ALL),

      // Win rate
      win_rate_pct: Math.round((useSol ? d.win_rate_native?.ALL : d.win_rate?.ALL) * 100),
      win_rate_usd_pct: Math.round((d.win_rate?.ALL || 0) * 100),
      win_rate_sol_pct: Math.round((d.win_rate_native?.ALL || 0) * 100),

      // Volume
      total_inflow_usd: round2(d.total_inflow),
      total_inflow_sol: round4(d.total_inflow_native),

      // Positions
      total_positions: d.total_lp || 0,
      closed_positions: d.closed_lp?.ALL || 0,
      open_positions: d.opening_lp || 0,
      total_pools: d.total_pool || 0,
      avg_hold_hours: round2(d.avg_age_hour),

      // ROI
      roi_pct: round2((d.roi || 0) * 100),
      fee_pct_of_capital: round2((d.fee_percent || 0) * 100),

      // Meta
      first_activity: d.first_activity,
      last_activity: d.last_activity,
      updated_at: d.updated_at,
    };

    _cacheAt = Date.now();
    return _cache;
  } catch (e) {
    log("lp_overview", `Fetch failed: ${e.message}`);
    return _cache || null;
  }
}

/**
 * Get a compact one-line summary for prompt injection.
 */
export async function getLpOverviewSummary() {
  const o = await getLpOverview();
  if (!o) return null;
  const pnlLabel = o.pnl_unit === "sol" ? `${o.total_pnl_sol} SOL` : `$${o.total_pnl_usd}`;
  const feesLabel = o.pnl_unit === "sol" ? `${o.total_fees_sol} SOL` : `$${o.total_fees_usd}`;
  return `LP Performance (${o.closed_positions} closed, ${o.open_positions} open): PnL ${pnlLabel} | Fees ${feesLabel} | Win rate ${o.win_rate_pct}% | Avg hold ${o.avg_hold_hours}h | ROI ${o.roi_pct}%`;
}

function round2(n) { return n != null ? Math.round(n * 100) / 100 : 0; }
function round4(n) { return n != null ? Math.round(n * 10000) / 10000 : 0; }

/**
 * Format a raw LP Agent historical position into a normalized object.
 * Shared by both fetchClosedPositionData and fetchHistoricalPositionMap.
 */
function formatHistoricalPosition(match, useSol) {
  return {
    position: match.position || match.tokenId,
    pool: match.pool,
    pair: match.pairName ? `${match.pairName}-${match.tokenName1 || "SOL"}` : null,
    strategy: match.strategyType?.toLowerCase().includes("spot") ? "spot" : "bid_ask",
    pnl_usd: round2(match.pnl?.value ?? 0),
    pnl_sol: round4(match.pnl?.valueNative ?? 0),
    pnl_pct: round2(useSol ? (match.pnl?.percentNative ?? 0) : (match.pnl?.percent ?? 0)),
    initial_value_usd: round2(match.inputValue ?? 0),
    initial_value_sol: round4(match.inputNative ?? 0),
    final_value_usd: round2(match.outputValue ?? 0),
    fees_usd: round2(match.collectedFee ?? 0),
    fees_sol: round4(match.collectedFeeNative ?? 0),
    il_usd: round2(match.impermanentLoss ?? 0),
    age_hours: round2(parseFloat(match.ageHour || 0)),
    lower_bin: match.tickLower,
    upper_bin: match.tickUpper,
    bin_step: match.poolInfo?.tickSpacing || null,
    base_mint: match.token0,
    closed_at: match.closeAt || match.close_At,
    created_at: match.createdAt,
  };
}

/** Fetch the raw historical positions list from LP Agent (max 50). Returns [] on failure. */
async function fetchHistoricalRaw() {
  const apiKey = await getApiKey();
  if (!apiKey) return [];
  try {
    const owner = await getWalletAddress();
    if (!owner) return [];
    const res = await fetch(
      `${LPAGENT_API}/lp-positions/historical?owner=${owner}&page=1&limit=50`,
      { headers: { "x-api-key": apiKey } }
    );
    if (!res.ok) return [];
    const json = await res.json();
    return json.data?.data || [];
  } catch (e) {
    log("lp_overview", `Failed to fetch historical positions: ${e.message}`);
    return [];
  }
}

/**
 * Fetch historical data for a specific closed position from LP Agent.
 * Used to record accurate PnL when positions are closed externally.
 *
 * @param {string} positionAddress - The position public key
 * @returns {Object|null} Position data or null if not found
 */
export async function fetchClosedPositionData(positionAddress) {
  try {
    const positions = await fetchHistoricalRaw();
    const match = positions.find(p => p.position === positionAddress || p.tokenId === positionAddress);
    if (!match) return null;

    const { config } = await import("../config.js");
    const useSol = config.management.pnlUnit === "sol";

    return formatHistoricalPosition(match, useSol);
  } catch (e) {
    log("lp_overview", `Failed to fetch closed position data: ${e.message}`);
    return null;
  }
}

/**
 * Batch-fetch all recent historical positions from LP Agent as a Map.
 * Fetches the list ONCE and indexes by position address.
 * Use this instead of calling fetchClosedPositionData N times in a loop.
 *
 * @returns {Map<string, Object>} positionAddress -> formatted position data
 */
export async function fetchHistoricalPositionMap() {
  try {
    const rawPositions = await fetchHistoricalRaw();
    if (rawPositions.length === 0) return new Map();

    const { config } = await import("../config.js");
    const useSol = config.management.pnlUnit === "sol";

    const map = new Map();
    for (const raw of rawPositions) {
      const addr = raw.position || raw.tokenId;
      if (addr) map.set(addr, formatHistoricalPosition(raw, useSol));
    }
    return map;
  } catch (e) {
    log("lp_overview", `Failed to build historical position map: ${e.message}`);
    return new Map();
  }
}
