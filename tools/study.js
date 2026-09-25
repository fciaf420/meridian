/**
 * Study top LPers for a pool and extract behavioural patterns.
 * Used by the /learn command - not called on every cycle.
 */

import { getKey, fetchWithRetry } from "../lpagent-keys.js";
import { log } from "../logger.js";

const LPAGENT_API = "https://api.lpagent.io/open-api/v1";
const MERIDIAN_API = "https://api.agentmeridian.xyz/api";
const MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";

/**
 * Fetch interpreted LP study data from Meridian and normalize it for the agent.
 */
export async function studyTopLPers({ pool_address, limit = 4 }) {
  const res = await fetch(
    `${MERIDIAN_API}/study-top-lp/${pool_address}`,
    { headers: { "x-api-key": MERIDIAN_PUBLIC_KEY } }
  );

  if (!res.ok) {
    throw new Error(`study-top-lp API error: ${res.status}`);
  }

  const data = await res.json();
  const winnersByPct = Array.isArray(data.topWinnersByPct) ? data.topWinnersByPct : [];
  const winnersByUsd = Array.isArray(data.topWinnersByUsd) ? data.topWinnersByUsd : [];
  const losersByPct = Array.isArray(data.topLosersByPct) ? data.topLosersByPct : [];
  const historicalOwners = Array.isArray(data.topHistoricalOwners) ? data.topHistoricalOwners : [];
  const ownerCount = Number(data.ownerCount || historicalOwners.length || winnersByPct.length || 0);

  const uniqueRows = new Map();
  for (const row of [...winnersByPct, ...winnersByUsd, ...losersByPct]) {
    if (row?.owner && !uniqueRows.has(row.owner)) {
      uniqueRows.set(row.owner, row);
    }
  }

  const lpers = historicalOwners.slice(0, limit).map((owner) => ({
    owner: owner.owner ? `${owner.owner.slice(0, 8)}...` : "unknown",
    summary: {
      preferred_strategy: owner.preferredStrategy || data.suggestedStyle?.strategy || "unknown",
      preferred_range_style: owner.preferredRangeStyle || data.suggestedStyle?.rangeStyle || "unknown",
      avg_hold_hours: isNum(owner.avgHoldHours) ? Number(owner.avgHoldHours.toFixed(2)) : null,
      avg_pnl_pct: isNum(owner.avgPnlPct) ? `${owner.avgPnlPct.toFixed(1)}%` : null,
      fee_pct_of_capital: isNum(owner.avgFeePercent) ? `${owner.avgFeePercent.toFixed(1)}%` : null,
      avg_width_bins: isNum(owner.avgWidthBins) ? owner.avgWidthBins : null,
    },
    positions: Array.isArray(owner.topPositions)
      ? owner.topPositions.map((position) => ({
          pool: position.pool || pool_address,
          pair: position.pairName || null,
          hold_hours: isNum(position.ageHours) ? Number(position.ageHours.toFixed(2)) : null,
          pnl_usd: isNum(position.pnlUsd) ? Math.round(position.pnlUsd) : null,
          pnl_pct: isNum(position.pnlPct) ? `${position.pnlPct.toFixed(1)}%` : null,
          fee_usd: isNum(position.feeUsd) ? Math.round(position.feeUsd) : null,
          in_range_pct: position.inRange == null ? null : (position.inRange ? "100%" : "0%"),
          range_pct: null,
          range_bins: isNum(position.widthBins) ? position.widthBins : null,
          strategy: position.strategy || owner.preferredStrategy || data.suggestedStyle?.strategy || null,
          closed_reason: position.closedAt ? "closed" : "open",
        }))
      : [],
  }));

  if (lpers.length === 0 && uniqueRows.size === 0) {
    return {
      pool: pool_address,
      message: "No interpreted LP study data returned from Meridian.",
      patterns: [],
      lpers: [],
    };
  }

  const numericRows = [...uniqueRows.values()];
  const pctTopWinners = winnersByPct.length > 0 && ownerCount > 0
    ? Math.round((winnersByPct.length / ownerCount) * 100)
    : null;
  const patterns = {
    top_lper_count: ownerCount,
    active_position_count: Number(data.activePositionCount || 0),
    avg_hold_hours: avg(numericRows.map((row) => row.avgAgeHours).filter(isNum)),
    // Share of owners that appear in Meridian's top-winners-by-% list (0-100).
    // This is NOT a win rate: it measures list size relative to owner count.
    pct_top_winners: pctTopWinners,
    // Deprecated alias kept for backward compatibility (signal-tracker weights
    // were learned on this value). Same number as pct_top_winners.
    avg_win_rate: pctTopWinners,
    avg_roi_pct: avg(numericRows.map((row) => row.pnlPct).filter(isNum)),
    avg_fee_pct_of_capital: avg(numericRows.map((row) => row.feePercent).filter(isNum)),
    best_roi: winnersByPct.length > 0 && isNum(winnersByPct[0]?.pnlPct)
      ? `${winnersByPct[0].pnlPct.toFixed(2)}%`
      : null,
    scalper_count: numericRows.filter((row) => isNum(row.avgAgeHours) && row.avgAgeHours < 1).length,
    holder_count: numericRows.filter((row) => isNum(row.avgAgeHours) && row.avgAgeHours >= 4).length,
    suggested_strategy: data.suggestedStyle?.strategy || null,
    suggested_range_style: data.suggestedStyle?.rangeStyle || null,
  };

  return {
    pool: pool_address,
    patterns,
    lpers,
    raw_study: {
      poolAddress: data.poolAddress,
      ownerCount,
      activePositionCount: Number(data.activePositionCount || 0),
      suggestedStyle: data.suggestedStyle || null,
    },
  };
}

// ─── LPAgent top-lpers (Premium) for the two-sided spot deploy gate ───────
// Docs: https://docs.lpagent.io/api-reference/pools/get-top-lpers-for-a-pool.md
// Premium/Enterprise only; Basic (free) keys get 401.

const _topLpersLogged = new Set();
function logTopLpersOnce(reason) {
  if (_topLpersLogged.has(reason)) return;
  _topLpersLogged.add(reason);
  log("study", `top-lpers unavailable (${reason}) — two-sided spot gate fails closed`);
}

function finiteOrNull(value) {
  const n = Number(value);
  return value != null && value !== "" && Number.isFinite(n) ? n : null;
}

/**
 * Map raw LPAgent top-lpers rows to the fields the deploy gate needs.
 * win_rate is recomputed as win_lp / total_lp (0..1) because the docs do not
 * state the unit of the API's own `win_rate` field. total_inflow is USD.
 */
export function mapTopLpersRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const total = finiteOrNull(r?.total_lp);
    const wins = finiteOrNull(r?.win_lp);
    return {
      owner: r?.owner ?? null,
      total_lp: total,
      win_lp: wins,
      win_rate: total != null && total > 0 && wins != null ? wins / total : null, // 0..1
      total_inflow: finiteOrNull(r?.total_inflow), // USD
      total_pnl: finiteOrNull(r?.total_pnl), // USD
      total_pnl_native: finiteOrNull(r?.total_pnl_native), // SOL
      avg_age_hour: finiteOrNull(r?.avg_age_hour),
      api_win_rate: finiteOrNull(r?.win_rate), // unit undocumented, informational only
    };
  });
}

/**
 * Condition 2 of the two-sided spot gate. Credible = at least 3 LPs, a win
 * rate of at least 60% and at least $1,000 deposited. Passes only with at
 * least 2 credible LPers whose average win rate is at least 80%.
 */
export function evaluateTopLpersGate(lpers) {
  const credible = (Array.isArray(lpers) ? lpers : []).filter((lp) =>
    lp && lp.total_lp != null && lp.total_lp >= 3
    && lp.win_rate != null && lp.win_rate >= 0.6
    && lp.total_inflow != null && lp.total_inflow >= 1000
  );
  const avgWR = credible.length > 0
    ? credible.reduce((s, lp) => s + lp.win_rate, 0) / credible.length
    : 0;
  return { passes: credible.length >= 2 && avgWR >= 0.80, credible, avgWR };
}

/**
 * Fetch top LPers for a pool from LPAgent (GET /pools/{id}/top-lpers).
 * Returns [] with no key, on any error, or on 401 (Basic tier), so callers
 * fail closed. The reason is logged once per process.
 */
export async function fetchTopLpersStats({ pool_address, limit = 20 }) {
  const apiKey = await getKey();
  if (!apiKey) {
    logTopLpersOnce("LPAGENT_API_KEY not set");
    return [];
  }
  const size = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
  const url = `${LPAGENT_API}/pools/${pool_address}/top-lpers`
    + `?chain=SOL&platform=meteora&order_by=total_pnl_native&sort_order=desc&page=1&limit=${size}`;
  try {
    const res = await fetchWithRetry(url, { headers: { "x-api-key": apiKey } });
    if (res.status === 401) {
      logTopLpersOnce("HTTP 401: Premium or Enterprise key required");
      return [];
    }
    if (!res.ok) {
      logTopLpersOnce(`HTTP ${res.status}`);
      return [];
    }
    const json = await res.json();
    if (json?.status !== "success" || !Array.isArray(json.data)) {
      logTopLpersOnce("unexpected response shape");
      return [];
    }
    return mapTopLpersRows(json.data);
  } catch (e) {
    logTopLpersOnce(`error: ${e.message}`);
    return [];
  }
}

/**
 * Get detailed pool info from LP Agent API.
 * Auto-stores key facts in nuggets memory.
 */
export async function getPoolInfo({ pool_address }) {
  const apiKey = await getKey();
  if (!apiKey) {
    return { error: "LPAGENT_API_KEY not set - get_pool_info is disabled." };
  }

  const res = await fetchWithRetry(
    `${LPAGENT_API}/pools/${pool_address}/info`,
    { headers: { "x-api-key": apiKey } }
  );

  if (!res.ok) {
    throw new Error(`Pool info API error: ${res.status}`);
  }

  const raw = await res.json();
  const d = raw.data;
  if (!d) return { error: "No data returned for this pool." };

  const tokens = d.tokenInfo?.[0]?.data || [];
  const tokenX = tokens[0] || {};
  const tokenY = tokens[1] || {};
  const feeInfo = d.feeInfo || {};

  const result = {
    pool: pool_address,
    type: d.type,
    token_x: {
      symbol: tokenX.symbol,
      name: tokenX.name,
      mcap: tokenX.mcap,
      fdv: tokenX.fdv,
      price_usd: tokenX.usdPrice,
      organic_score: tokenX.organicScore,
      holders: tokenX.holderCount,
      mint_disabled: tokenX.audit?.mintAuthorityDisabled,
      freeze_disabled: tokenX.audit?.freezeAuthorityDisabled,
      top_holders_pct: tokenX.audit?.topHoldersPercentage,
      bot_holders_pct: tokenX.audit?.botHoldersPercentage,
      dev_balance_pct: tokenX.audit?.devBalancePercentage,
      dev_migrations: tokenX.audit?.devMigrations,
      cto: tokenX.cto,
      tags: tokenX.tags,
    },
    token_y: {
      symbol: tokenY.symbol,
      name: tokenY.name,
    },
    amount_x: d.amountX,
    amount_y: d.amountY,
    fees: {
      base_fee_pct: feeInfo.baseFeeRatePercentage,
      max_fee_pct: feeInfo.maxFeeRatePercentage,
      dynamic_fee: feeInfo.dynamicFee,
    },
    stats_5m: tokenX.stats5m ? {
      price_change: tokenX.stats5m.priceChange,
      buy_volume: tokenX.stats5m.buyVolume,
      sell_volume: tokenX.stats5m.sellVolume,
      num_buys: tokenX.stats5m.numBuys,
      num_sells: tokenX.stats5m.numSells,
      num_traders: tokenX.stats5m.numTraders,
      organic_buy_ratio: tokenX.stats5m.numOrganicBuyers / (tokenX.stats5m.numTraders || 1),
    } : null,
    stats_1h: tokenX.stats1h ? {
      price_change: tokenX.stats1h.priceChange,
      buy_volume: tokenX.stats1h.buyVolume,
      sell_volume: tokenX.stats1h.sellVolume,
      num_traders: tokenX.stats1h.numTraders,
    } : null,
    fee_trend_7d: (d.feeStats || []).slice(-24).map((h) => ({
      hour: h.hour,
      fee_usd: h.feeUsd,
    })),
  };

  try {
    const { rememberFact } = await import("../memory.js");
    const pair = `${tokenX.symbol || "?"}-${tokenY.symbol || "SOL"}`;
    const key = pair.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
    const audit = tokenX.audit || {};
    const safety = [
      audit.mintAuthorityDisabled ? "mint-off" : "MINT-ON",
      audit.freezeAuthorityDisabled ? "freeze-off" : "FREEZE-ON",
      `${(audit.botHoldersPercentage || 0).toFixed(0)}% bots`,
      `${(audit.topHoldersPercentage || 0).toFixed(0)}% top holders`,
      `organic ${(tokenX.organicScore || 0).toFixed(0)}`,
      `${tokenX.holderCount || 0} holders`,
    ].join(", ");
    rememberFact("pools", `${key}_audit`, safety);
  } catch { /* best-effort */ }

  return result;
}

function avg(arr) {
  if (!arr.length) return null;
  return Math.round((arr.reduce((sum, value) => sum + value, 0) / arr.length) * 100) / 100;
}

function isNum(value) {
  return typeof value === "number" && Number.isFinite(value);
}
