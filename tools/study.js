/**
 * Study top LPers for a pool and extract behavioural patterns.
 * Used by the /learn command — not called on every cycle.
 */

const LPAGENT_API = "https://api.lpagent.io/open-api/v1";

// Support multiple API keys (comma-separated) for rate limit rotation
const LPAGENT_KEYS = (process.env.LPAGENT_API_KEY || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

let _keyIndex = 0;

/** Round-robin key selection — spreads requests across keys to avoid per-key rate limits. */
function nextKey() {
  if (LPAGENT_KEYS.length === 0) return null;
  const key = LPAGENT_KEYS[_keyIndex % LPAGENT_KEYS.length];
  _keyIndex++;
  return key;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch top LPers for a pool, filter to credible performers,
 * and return condensed behaviour patterns for LLM consumption.
 */
export async function studyTopLPers({ pool_address, limit = 4 }) {
  const apiKey = nextKey();
  if (!apiKey) {
    return { pool: pool_address, message: "LPAGENT_API_KEY not set in .env — study_top_lpers is disabled.", patterns: [], lpers: [] };
  }

  // ── 1. Top LPers for this pool ──────────────────────────────
  const topRes = await fetch(
    `${LPAGENT_API}/pools/${pool_address}/top-lpers?sort_order=desc&page=1&limit=20`,
    { headers: { "x-api-key": apiKey } }
  );

  if (!topRes.ok) {
    if (topRes.status === 429) {
      throw new Error(`Rate limit exceeded. Please wait 60 seconds before studying this pool again.`);
    }
    throw new Error(`top-lpers API error: ${topRes.status}`);
  }

  const topData = await topRes.json();
  const all = topData.data || [];

  // Filter to LPers with enough data to be meaningful
  const credible = all.filter(
    (l) => l.total_lp >= 3 && l.win_rate >= 0.6 && l.total_inflow > 1000
  );

  // Sort by ROI descending, take top N
  const top = credible
    .sort((a, b) => b.roi - a.roi)
    .slice(0, limit);

  if (top.length === 0) {
    return {
      pool: pool_address,
      message: "No credible LPers found (need ≥3 positions, ≥60% win rate, ≥$1k inflow).",
      patterns: [],
      historical_samples: [],
    };
  }

  // ── 2. Historical positions for each top LPer ───────────────
  // Fetch from LP Agent (hold times, PnL, strategy) + Meteora PnL API (bin ranges)
  const historicalSamples = [];

  for (const lper of top) {
    try {
      // Small buffer to avoid race conditions on the 5-req limit
      await sleep(1000);

      // LP Agent: historical positions (strategy, hold time, PnL, fees)
      const histRes = await fetch(
        `${LPAGENT_API}/lp-positions/historical?owner=${lper.owner}&page=1&limit=50`,
        { headers: { "x-api-key": nextKey() } }
      );
      const lpAgentPositions = histRes.ok ? (await histRes.json()).data || [] : [];

      // Meteora PnL API: bin range data for this LPer in this pool
      let meteoraBinMap = {};
      try {
        const meteoraRes = await fetch(
          `https://dlmm.datapi.meteora.ag/positions/${pool_address}/pnl?user=${lper.owner}&status=all&pageSize=50&page=1`
        );
        if (meteoraRes.ok) {
          const meteoraData = await meteoraRes.json();
          for (const mp of meteoraData.positions || []) {
            const addr = mp.positionAddress || mp.address;
            if (addr) meteoraBinMap[addr] = mp;
          }
        }
      } catch { /* best-effort */ }

      // Merge: LP Agent positions enriched with Meteora bin data
      // If LP Agent returned nothing, build positions from Meteora data directly
      const positions = lpAgentPositions.length > 0 ? lpAgentPositions : [];
      const meteoraOnly = Object.values(meteoraBinMap);

      const mappedPositions = positions.map((p) => {
        const lower = p.tickLower ?? p.lowerBinId;
        const upper = p.tickUpper ?? p.upperBinId;
        const bs = p.poolInfo?.tickSpacing ?? p.binStep;
        let range_pct = null;
        let range_bins = null;
        if (lower != null && upper != null) {
          range_bins = upper - lower;
          if (bs && range_bins > 0) {
            const stepPct = bs / 10000;
            range_pct = Math.round((1 - Math.pow(1 + stepPct, -range_bins)) * 1000) / 10;
          }
        }
        return {
          pool: p.pool,
          pair: p.pairName || `${p.tokenName0}-${p.tokenName1}`,
          hold_hours: p.ageHour != null ? Number(p.ageHour?.toFixed(2)) : null,
          pnl_usd: Math.round(p.pnl?.value || 0),
          pnl_pct: ((p.pnl?.percent || 0) * 100).toFixed(1) + "%",
          fee_usd: Math.round(p.collectedFee || 0),
          in_range_pct: p.inRangePct != null ? Math.round(p.inRangePct * 100) + "%" : null,
          range_pct,
          range_bins,
          strategy: p.strategy || null,
          closed_reason: p.closeReason || null,
        };
      });

      // If LP Agent had no positions, use Meteora data to build range-focused entries
      if (mappedPositions.length === 0 && meteoraOnly.length > 0) {
        for (const mp of meteoraOnly) {
          const range_bins = (mp.upperBinId || 0) - (mp.lowerBinId || 0);
          let range_pct = null;
          // Pool bin_step from the top-lpers response isn't directly available,
          // but we can infer from the Meteora response price data or use a default
          // For now, try to get it from pool metadata if available
          if (range_bins > 0) {
            // Approximate: use the price ratio to estimate bin_step
            // Or just report raw bins and let the model see the pattern
            range_pct = range_bins; // Will be replaced below if we can calculate
          }
          mappedPositions.push({
            pool: pool_address,
            pair: null,
            hold_hours: mp.closedAt && mp.createdAt ? Math.round((mp.closedAt - mp.createdAt) / 3600 * 100) / 100 : null,
            pnl_usd: mp.pnlUsd ? Math.round(parseFloat(mp.pnlUsd)) : null,
            pnl_pct: mp.pnlPctChange ? parseFloat(mp.pnlPctChange).toFixed(1) + "%" : null,
            fee_usd: mp.allTimeFees?.total?.usd ? Math.round(parseFloat(mp.allTimeFees.total.usd)) : null,
            in_range_pct: null,
            range_bins,
            range_pct: null, // need bin_step to calculate — set below
            strategy: null,
            closed_reason: mp.isClosed ? "closed" : "open",
          });
        }
      }

      historicalSamples.push({
        owner: lper.owner.slice(0, 8) + "...",
        summary: {
          total_positions: lper.total_lp,
          win_rate: Math.round(lper.win_rate * 100) + "%",
          avg_hold_hours: Number(lper.avg_age_hour?.toFixed(2)),
          roi: (lper.roi * 100).toFixed(2) + "%",
          fee_pct_of_capital: (lper.fee_percent * 100).toFixed(2) + "%",
          total_pnl_usd: Math.round(lper.total_pnl),
        },
        positions: mappedPositions,
      });
    } catch {
      // skip failed fetches
    }
  }

  // ── 2b. Calculate range_pct for Meteora-sourced positions using pool bin_step ──
  // We need the pool's bin_step — fetch once from the pool detail
  try {
    const { getPoolDetail } = await import("./screening.js");
    const poolDetail = await getPoolDetail({ pool_address, timeframe: "1h" }).catch(() => null);
    const poolBinStep = poolDetail?.bin_step;
    if (poolBinStep) {
      const stepPct = poolBinStep / 10000;
      for (const sample of historicalSamples) {
        for (const pos of sample.positions) {
          if (pos.range_bins > 0 && pos.range_pct == null) {
            pos.range_pct = Math.round((1 - Math.pow(1 + stepPct, -pos.range_bins)) * 1000) / 10;
          }
        }
      }
    }
  } catch { /* best-effort */ }

  // ── 3. Aggregate patterns ────────────────────────────────────
  const patterns = {
    top_lper_count: top.length,
    avg_hold_hours: avg(top.map((l) => l.avg_age_hour).filter(isNum)),
    avg_win_rate: avg(top.map((l) => l.win_rate).filter(isNum)),
    avg_roi_pct: avg(top.map((l) => l.roi * 100).filter(isNum)),
    avg_fee_pct_of_capital: avg(top.map((l) => l.fee_percent * 100).filter(isNum)),
    best_roi: (Math.max(...top.map((l) => l.roi)) * 100).toFixed(2) + "%",
    // Scalpers (hold < 1h) vs holders (> 4h)
    scalper_count: top.filter((l) => l.avg_age_hour < 1).length,
    holder_count: top.filter((l) => l.avg_age_hour >= 4).length,
  };

  // Aggregate range % from all historical positions
  const allRanges = historicalSamples
    .flatMap(s => s.positions)
    .map(p => p.range_pct)
    .filter(isNum);
  if (allRanges.length > 0) {
    patterns.avg_range_pct = Math.round(avg(allRanges) * 10) / 10;
    patterns.min_range_pct = Math.min(...allRanges);
    patterns.max_range_pct = Math.max(...allRanges);
    patterns.recommended_range_pct = `Use price_range_pct=${Math.round(patterns.avg_range_pct)} in deploy_position`;
  }

  return {
    pool: pool_address,
    patterns,
    lpers: historicalSamples,
  };
}

// ─── Rate limiter for LP Agent API (5 req/min) ─────────────
const _lpagentCalls = [];

function checkRateLimit() {
  const now = Date.now();
  // Remove calls older than 60 seconds
  while (_lpagentCalls.length > 0 && now - _lpagentCalls[0] > 60_000) {
    _lpagentCalls.shift();
  }
  if (_lpagentCalls.length >= 5) {
    const waitSec = Math.ceil((60_000 - (now - _lpagentCalls[0])) / 1000);
    return { allowed: false, waitSec };
  }
  _lpagentCalls.push(now);
  return { allowed: true };
}

// ─── Pool Info (deep intel) ─────────────────────────────────

/**
 * Get detailed pool info from LP Agent API.
 * Auto-stores key facts in nuggets memory.
 */
export async function getPoolInfo({ pool_address }) {
  const apiKey = nextKey();
  if (!apiKey) {
    return { error: "LPAGENT_API_KEY not set — get_pool_info is disabled." };
  }

  const rateCheck = checkRateLimit();
  if (!rateCheck.allowed) {
    return { error: `Rate limited (5/min). Try again in ${rateCheck.waitSec}s.` };
  }

  const res = await fetch(
    `${LPAGENT_API}/pools/${pool_address}/info`,
    { headers: { "x-api-key": apiKey } }
  );

  if (!res.ok) {
    if (res.status === 429) return { error: "Rate limited by LP Agent API. Wait 60s." };
    throw new Error(`Pool info API error: ${res.status}`);
  }

  const raw = await res.json();
  const d = raw.data;
  if (!d) return { error: "No data returned for this pool." };

  // Extract token info
  const tokens = d.tokenInfo?.[0]?.data || [];
  const tokenX = tokens[0] || {};
  const tokenY = tokens[1] || {};

  // Extract fee info
  const feeInfo = d.feeInfo || {};

  // Condensed response for LLM
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
    fee_trend_7d: (d.feeStats || []).slice(-24).map(h => ({
      hour: h.hour,
      fee_usd: h.feeUsd,
    })),
  };

  // Auto-store in nuggets memory
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
  return Math.round((arr.reduce((s, x) => s + x, 0) / arr.length) * 100) / 100;
}

function isNum(n) {
  return typeof n === "number" && isFinite(n);
}
