/**
 * Advanced GMGN screening pipeline adapted to the local `gmgn-cli` binary.
 *
 * This is the OPT-IN screening source (screeningSource="gmgn"). It mirrors the
 * upstream 4-stage "advanced GMGN screening" but every GMGN call goes through
 * the hardened `spawnGmgn` helper in ./gmgn.js (serialized queue + min-gap +
 * rate-limit cooldown + `--raw` + parsed-JSON-or-null), and the chart indicator
 * stage reuses our local candle summary from fetchGmgnPriceInfo() instead of any
 * remote chart-indicators API.
 *
 *   Stage 1  market trending  -> passBasicRankFilter (mcap/bundler/age/volume)
 *   Stage 2  token info       -> analyzeTokenInfo (holders/fees/concentration/ATH)
 *   Stage 3  token holders/traders (soft) + Meteora SOL DLMM pool gate (hard)
 *   Stage 4  local candle indicators (supertrend / RSI / Bollinger)
 *   Stage 5  pick best pool + condense to the candidate shape getTopCandidates emits
 *
 * gmgn-cli JSON wrapping is INCONSISTENT (verified live):
 *   market trending --raw -> { code, data: { rank: [...] }, ... }   (out.data.rank)
 *   token info --raw      -> unwrapped info object                  (no .data)
 *   token holders/traders -> { list: [...] }                        (single wrap)
 * `unwrap(out, key)` tolerates all three shapes.
 */

import { config } from "../config.js";
import { log } from "../logger.js";
import { isBlacklisted } from "../token-blacklist.js";
import { spawnGmgn, fetchGmgnPriceInfo } from "./gmgn.js";

const CHAIN = "sol";
const METEORA_DLMM_API = "https://dlmm.datapi.meteora.ag";
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const SOL_MINT = config.tokens?.SOL || "So11111111111111111111111111111111111111112";
const SUPPORTED_INTERVALS = new Set(["1m", "5m", "1h", "6h", "24h"]);

/* ============================== small helpers ============================== */

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function optionalNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boolish(value) {
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    String(value).toLowerCase() === "true" ||
    String(value).toLowerCase() === "yes"
  );
}

function ratioPct(value) {
  const n = optionalNum(value);
  if (n == null) return null;
  return Number((n * 100).toFixed(2));
}

function round(n) {
  return n != null && Number.isFinite(Number(n)) ? Math.round(Number(n)) : null;
}

function normalizeInterval(value, fallback = "5m") {
  const normalized = String(value || fallback).trim();
  return SUPPORTED_INTERVALS.has(normalized) ? normalized : fallback;
}

/**
 * Tolerant unwrap mirroring upstream unwrapList but for a single key. Handles:
 *   { [key]: [...] }      (token holders/traders -> "list")
 *   { data: { [key] } }   (market trending -> data.rank)
 *   [...]                 (already an array)
 *   itself                (unwrapped object as last resort)
 */
function unwrap(out, key) {
  if (out == null) return [];
  if (Array.isArray(out?.[key])) return out[key];
  if (Array.isArray(out?.data?.[key])) return out.data[key];
  if (Array.isArray(out?.data?.data?.[key])) return out.data.data[key];
  if (Array.isArray(out)) return out;
  if (Array.isArray(out?.data)) return out.data;
  return [];
}

function hasTag(entry, tag) {
  const tags = []
    .concat(entry?.tags || [])
    .concat(entry?.maker_token_tags || [])
    .map((value) => String(value || "").toLowerCase());
  return tags.includes(tag);
}

function entryName(entry) {
  return String(
    entry?.name ||
      entry?.twitter_name ||
      entry?.twitter_username ||
      entry?.username ||
      entry?.label ||
      entry?.address ||
      entry ||
      ""
  ).trim();
}

function entryAmountPct(entry) {
  const raw = entry?.amount_percentage ?? entry?.balance_percentage ?? entry?.amount_cur_percentage;
  const n = optionalNum(raw);
  if (n == null) return 0;
  return n > 1 ? n : n * 100;
}

function isPreferredKol(entry) {
  const preferred = (config.gmgn?.preferredKolNames || [])
    .map((name) => String(name || "").trim().toLowerCase())
    .filter(Boolean);
  if (!preferred.length) return false;
  const normalized = entryName(entry).toLowerCase();
  return preferred.some((preferredName) => normalized.includes(preferredName));
}

function isDumpKol(entry) {
  const dump = (config.gmgn?.dumpKolNames || [])
    .map((name) => String(name || "").trim().toLowerCase())
    .filter(Boolean);
  if (!dump.length) return false;
  const normalized = entryName(entry).toLowerCase();
  return dump.some((dumpName) => normalized.includes(dumpName));
}

/* ============================== Stage filters ============================== */

/**
 * Stage 1 basic filter — reads the trending rank[] row. Fields verified present:
 * market_cap, bundler_rate, creation_timestamp (epoch s), volume.
 */
function passBasicRankFilter(token) {
  const g = config.gmgn;
  const reasons = [];
  const tokenAgeHours =
    num(token.creation_timestamp) > 0
      ? (Date.now() / 1000 - num(token.creation_timestamp)) / 3600
      : null;
  if (num(token.market_cap) < g.minMcap) reasons.push(`mcap ${num(token.market_cap)} < ${g.minMcap}`);
  if (g.maxMcap != null && num(token.market_cap) > g.maxMcap) {
    reasons.push(`mcap ${num(token.market_cap)} > ${g.maxMcap}`);
  }
  if (num(token.bundler_rate) > g.maxBundlerRate) {
    reasons.push(`bundler ${(num(token.bundler_rate) * 100).toFixed(1)}% > ${(g.maxBundlerRate * 100).toFixed(1)}%`);
  }
  if (g.minTokenAgeHours != null && tokenAgeHours != null && tokenAgeHours < g.minTokenAgeHours) {
    reasons.push(`age ${tokenAgeHours.toFixed(2)}h < ${g.minTokenAgeHours}h`);
  }
  if (g.maxTokenAgeHours != null && tokenAgeHours != null && tokenAgeHours > g.maxTokenAgeHours) {
    reasons.push(`age ${tokenAgeHours.toFixed(2)}h > ${g.maxTokenAgeHours}h`);
  }
  if (num(token.volume) < g.minVolume) reasons.push(`volume ${num(token.volume)} < ${g.minVolume}`);
  // Optional security gates available on the trending row.
  if (g.maxRugRatio != null && num(token.rug_ratio) > g.maxRugRatio) {
    reasons.push(`rug ratio ${ratioPct(token.rug_ratio)}%`);
  }
  if (g.maxSniperCount != null && num(token.sniper_count) > g.maxSniperCount) {
    reasons.push(`snipers ${num(token.sniper_count)} > ${g.maxSniperCount}`);
  }
  if (boolish(token.is_honeypot)) reasons.push("honeypot");
  if (boolish(token.is_wash_trading) && (g.filters || []).includes("not_wash_trading")) {
    reasons.push("wash trading");
  }
  return { pass: reasons.length === 0, reasons };
}

/**
 * Stage 2 token-info filter — reads `token info` (unwrapped object). Fields:
 * holder_count, total_fee, stat.*, wallet_tags_stat.*, ath_price, price.price.
 */
function analyzeTokenInfo(info = {}) {
  const g = config.gmgn;
  const stat = info.stat || {};
  const tags = info.wallet_tags_stat || {};
  const reasons = [];

  const smartWallets = num(tags.smart_wallets);
  const kolWallets = num(tags.renowned_wallets);
  const tradeFeeSol = num(info.trade_fee);
  // `price` may be an object ({ price, price_5m, ... }) or a scalar.
  const price = num(info.price?.price ?? info.price);
  const athPrice = num(info.ath_price);
  const priceVsAthPct = athPrice > 0 && price > 0 ? (price / athPrice) * 100 : null;
  const athFilter = g.athFilterPct;
  if (athFilter != null && priceVsAthPct != null) {
    const threshold = 100 + Number(athFilter);
    if (priceVsAthPct > threshold) reasons.push(`price ${priceVsAthPct.toFixed(1)}% of ATH > ${threshold}%`);
  }

  const totalFeeSol = num(info.total_fee);
  if (num(info.holder_count) < g.minHolders) reasons.push(`holders ${num(info.holder_count)} < ${g.minHolders}`);
  if (totalFeeSol < g.minTotalFeeSol) reasons.push(`total fee ${totalFeeSol} SOL < ${g.minTotalFeeSol} SOL`);
  if (num(stat.top_10_holder_rate) > g.maxTop10HolderRate) reasons.push(`top10 ${ratioPct(stat.top_10_holder_rate)}%`);
  if (g.maxDevTeamHoldRate != null && num(stat.dev_team_hold_rate) > g.maxDevTeamHoldRate) {
    reasons.push(`dev team ${ratioPct(stat.dev_team_hold_rate)}%`);
  }
  if (num(stat.bot_degen_rate) > g.maxBotDegenRate) reasons.push(`bot degen ${ratioPct(stat.bot_degen_rate)}%`);
  if (g.maxFreshWalletRate != null && num(stat.fresh_wallet_rate) > g.maxFreshWalletRate) {
    reasons.push(`fresh wallets ${ratioPct(stat.fresh_wallet_rate)}%`);
  }
  if (num(stat.top_bundler_trader_percentage) > g.maxBundlerRate) {
    reasons.push(`bundler ${ratioPct(stat.top_bundler_trader_percentage)}%`);
  }
  if (num(stat.top_rat_trader_percentage) > g.maxRatTraderRate) {
    reasons.push(`insider ${ratioPct(stat.top_rat_trader_percentage)}%`);
  }

  return {
    passed: reasons.length === 0,
    reasons,
    smartWallets,
    kolWallets,
    priceVsAthPct,
    tradeFeeSol,
    totalFeeSol,
    top10HolderPct: ratioPct(stat.top_10_holder_rate),
    devTeamHoldPct: ratioPct(stat.dev_team_hold_rate),
    botDegenCount: num(stat.bot_degen_count),
    botDegenPct: ratioPct(stat.bot_degen_rate),
    freshWalletPct: ratioPct(stat.fresh_wallet_rate),
    bundlerPct: ratioPct(stat.top_bundler_trader_percentage),
    insiderPct: ratioPct(stat.top_rat_trader_percentage),
    sniperWallets: num(tags.sniper_wallets),
    bundlerWallets: num(tags.bundler_wallets),
    whaleWallets: num(tags.whale_wallets),
    freshWallets: num(tags.fresh_wallets),
  };
}

/**
 * Stage 3 holders/traders enrichment. Only `sniperHoldRate > maxSniperHoldRate`
 * is a HARD reject; everything else is a soft signal emitted for the candidate.
 */
function analyzeHoldersAndTraders(holders = [], traders = []) {
  const g = config.gmgn;
  const combined = [...holders, ...traders];
  const kolHolders = holders.filter((entry) => hasTag(entry, "kol") && !entry.end_holding_at);
  const kolHolding = kolHolders.length;
  const smartHolding = holders.filter((entry) => hasTag(entry, "smart_degen") && !entry.end_holding_at).length;
  const kolTraders = traders.filter((entry) => hasTag(entry, "kol"));
  const smartTraders = traders.filter((entry) => hasTag(entry, "smart_degen"));
  const smartAccumulating = smartTraders.filter((entry) => num(entry.buy_volume_cur) > num(entry.sell_volume_cur)).length;
  const smartExiting = smartTraders.filter((entry) => num(entry.sell_volume_cur) > num(entry.buy_volume_cur)).length;
  const mostlyExited = combined.filter(
    (entry) => (hasTag(entry, "kol") || hasTag(entry, "smart_degen")) && num(entry.sell_amount_percentage) >= 0.8
  ).length;
  const preferredKolHolders = kolHolders.filter(
    (entry) => isPreferredKol(entry) && entryAmountPct(entry) >= g.preferredKolMinHoldPct
  );
  const dumpKolThreshold = g.dumpKolMinHoldPct ?? 0.5;
  const dumpKolHoldersAll = [...kolHolders, ...kolTraders.filter((e) => !e.end_holding_at)].filter(isDumpKol);
  const dumpKolSignificant = dumpKolHoldersAll.filter((e) => entryAmountPct(e) >= dumpKolThreshold);
  const dumpKolMinor = dumpKolHoldersAll.filter((e) => entryAmountPct(e) < dumpKolThreshold);
  const bundlerTopHolders = holders.filter((entry) => hasTag(entry, "bundler"));
  const sniperTopHolders = holders.filter((entry) => hasTag(entry, "sniper"));
  const sniperHoldRate = holders.length > 0 ? sniperTopHolders.length / holders.length : 0;

  const reasons = [];
  if (sniperHoldRate > g.maxSniperHoldRate) reasons.push(`sniper top-holder rate ${(sniperHoldRate * 100).toFixed(1)}%`);

  return {
    passed: reasons.length === 0,
    reasons,
    kolHolding,
    kolHolderNames: kolHolders.map((entry) => entryName(entry)).filter(Boolean).slice(0, 12),
    kolProfitNames: kolTraders
      .sort((a, b) => num(b.profit) - num(a.profit))
      .map((entry) => entryName(entry))
      .filter(Boolean)
      .slice(0, 12),
    preferredKolHolding: preferredKolHolders.length,
    preferredKolHolders: preferredKolHolders.map((entry) => ({
      name: entryName(entry),
      amountPct: Number(entryAmountPct(entry).toFixed(2)),
    })),
    dumpKolSignificantCount: dumpKolSignificant.length,
    dumpKolMinorCount: dumpKolMinor.length,
    dumpKolHolders: dumpKolSignificant.map((entry) => ({
      name: entryName(entry),
      amountPct: Number(entryAmountPct(entry).toFixed(2)),
    })),
    smartHolding,
    smartAccumulating,
    smartExiting,
    mostlyExited,
    bundlerTopHolderCount: bundlerTopHolders.length,
    sniperTopHolderCount: sniperTopHolders.length,
    sniperHoldRate,
  };
}

/* ====================== Token -> Meteora pool resolver ====================== */

/**
 * Find SOL-quoted DLMM pools for a mint via the dlmm.datapi search endpoint.
 * (pool-discovery-api `filter_by` has no per-mint field — only this search works.)
 * DLMM is inferred from the presence of pool_config.bin_step.
 */
async function fetchTopMeteoraDlmmPoolsForMint(mint, minTvl = 0, limit = 2) {
  const filterBy = minTvl > 0 ? `&filter_by=${encodeURIComponent(`tvl>${minTvl}`)}` : "";
  const url = `${METEORA_DLMM_API}/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}${filterBy}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Meteora pool search ${res.status}`);
  const data = await res.json();
  const pools = Array.isArray(data?.data) ? data.data : [];
  return pools
    .filter((pool) => {
      const baseMatches = pool?.token_x?.address === mint || pool?.token_x_mint === mint;
      const quoteIsSol =
        pool?.token_y?.address === SOL_MINT ||
        pool?.token_y_mint === SOL_MINT ||
        pool?.token_y?.symbol === "SOL";
      return baseMatches && quoteIsSol;
    })
    .slice(0, limit);
}

/**
 * Enrich a single pool via the pool-discovery-api (active_tvl, fee_active_tvl_ratio,
 * volatility, active_positions_pct, base_token_holders, pool_price, ...). null on non-200.
 */
async function fetchPoolDetailDirect(poolAddress) {
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=5m`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

/** Score candidate pools by fee_active_tvl_ratio desc then active_tvl desc. */
async function pickBestPool(pools) {
  const details = await Promise.all(
    pools.map((pool) => fetchPoolDetailDirect(pool.address || pool.pool_address).catch(() => null))
  );
  if (pools.length <= 1) return { pool: pools[0] ?? null, detail: details[0] ?? null };
  const scored = pools.map((pool, i) => {
    const d = details[i];
    const activeTvl = num(d?.active_tvl ?? pool.active_tvl ?? pool.tvl ?? pool.liquidity);
    const feeActiveTvlRatio = Number.isFinite(Number(d?.fee_active_tvl_ratio)) ? Number(d.fee_active_tvl_ratio) : 0;
    return { pool, detail: d, feeActiveTvlRatio, activeTvl };
  });
  scored.sort((a, b) => b.feeActiveTvlRatio - a.feeActiveTvlRatio || b.activeTvl - a.activeTvl);
  return { pool: scored[0].pool, detail: scored[0].detail };
}

/* ====================== Stage 4: local candle indicators ====================== */

/**
 * Bounce-setup check using our LOCAL candle summary (fetchGmgnPriceInfo().candles)
 * instead of any remote chart-indicators API. Supertrend direction is mapped
 * green->bullish / red->bearish; supertrend.flipped_green is the "break up" signal.
 * Degrades open (passed:true) when no candles are available.
 */
async function checkBounceSetup(mint) {
  const price = await fetchGmgnPriceInfo(mint);
  const c = price?.candles;
  if (!c) return { passed: true, reasons: [], signal: null };

  const dir =
    c.supertrend_direction === "green" ? "bullish" : c.supertrend_direction === "red" ? "bearish" : "unknown";
  const isBullish = dir === "bullish" || !!c.supertrend?.flipped_green;
  const breakUp = !!c.supertrend?.flipped_green;
  const priceAboveSupertrend = !!c.supertrend_price_above;
  const rsi = optionalNum(c.rsi_2);
  const close = optionalNum(price?.price);
  const oversold = Number(config.indicators?.rsiOversold ?? 35);

  let bbPosition = "inside";
  if (c.close_above_bb_upper) bbPosition = "above";
  else if (c.bb_lower != null && close != null && close < c.bb_lower) bbPosition = "below";

  const alreadyAtBottom = rsi != null && rsi < oversold && bbPosition === "below";

  let rsiLabel = null;
  if (rsi != null) {
    if (rsi < 35) rsiLabel = "oversold";
    else if (rsi > 65) rsiLabel = "overbought";
    else rsiLabel = "neutral";
  }

  const rules = config.gmgn?.indicatorRules || {};
  const reasons = [];

  if (rules.requireBullishSupertrend !== false && !isBullish) {
    reasons.push(`no bounce support: ${dir} supertrend`);
  }
  if (rules.rejectAlreadyAtBottom !== false && alreadyAtBottom) {
    reasons.push(`already at bottom: RSI ${rsi.toFixed(1)}, price below lower BB — dump done`);
  }
  if (rules.requireAboveSupertrend && !priceAboveSupertrend) {
    reasons.push("price below supertrend");
  }
  if (rules.minRsi != null && rsi != null && rsi < rules.minRsi) {
    reasons.push(`RSI ${rsi.toFixed(1)} < min ${rules.minRsi}`);
  }
  if (rules.maxRsi != null && rsi != null && rsi > rules.maxRsi) {
    reasons.push(`RSI ${rsi.toFixed(1)} > max ${rules.maxRsi}`);
  }
  if (rules.requireBbPosition != null && bbPosition !== rules.requireBbPosition) {
    reasons.push(`BB position ${bbPosition} != required ${rules.requireBbPosition}`);
  }

  return {
    passed: reasons.length === 0,
    reasons,
    signal: {
      interval: "5m",
      rsi: rsi != null ? Number(rsi.toFixed(1)) : null,
      rsiLabel,
      bbPosition,
      supertrendDirection: dir,
      supertrendBreakUp: breakUp,
      aboveSupertrend: priceAboveSupertrend,
    },
  };
}

/* ============================== condense ============================== */

/**
 * Emit a candidate in the EXACT shape getTopCandidates consumes (after
 * normalizeCandidateForUi / rankCandidatesByDarwin / getCandidateSignalSnapshot).
 * `security` is {} — the trending `token` row supplies the security fallbacks.
 * Adds `organic_score` and `active_pct` which the Darwin scorer + UI normalizer read.
 */
function condenseGmgnCandidate({ token, pool, poolDetail, security, info, infoAnalysis, holdersAnalysis, indicatorSignal }) {
  const poolAddress = pool.address || pool.pool_address;
  const tvl = num(poolDetail?.tvl ?? pool.tvl ?? pool.liquidity);
  const activeTvl = num(poolDetail?.active_tvl ?? pool.active_tvl ?? tvl);
  const feeActiveTvlRatio = Number.isFinite(Number(poolDetail?.fee_active_tvl_ratio))
    ? Number(Number(poolDetail.fee_active_tvl_ratio).toFixed(4))
    : null;
  const kolCount = holdersAnalysis.kolHolding || num(token.renowned_count) || num(info?.wallet_tags_stat?.renowned_wallets);
  const smartCount =
    holdersAnalysis.smartHolding + holdersAnalysis.smartAccumulating ||
    num(token.smart_degen_count) ||
    num(info?.wallet_tags_stat?.smart_wallets);
  const infoPrice = num(info?.price?.price ?? info?.price);
  const gmgnScore =
    num(token.volume) / 100 +
    num(token.smart_degen_count) * 50 +
    kolCount * 35 +
    num(holdersAnalysis?.preferredKolHolding) * 75 -
    num(holdersAnalysis?.dumpKolSignificantCount) * 100 -
    num(holdersAnalysis?.dumpKolMinorCount) * 20 +
    num(feeActiveTvlRatio) * 1000 +
    Math.max(0, 100 - num(security?.rug_ratio ?? token.rug_ratio) * 100) * 5;

  const organicScore = optionalNum(poolDetail?.base_token_organic_score);

  return {
    pool: poolAddress,
    name: pool.name || `${token.symbol || info?.symbol || "?"}-SOL`,
    base: {
      symbol: token.symbol || info?.symbol || pool.token_x?.symbol,
      mint: token.address || info?.address || pool.token_x?.address,
      organic: organicScore != null ? Math.round(organicScore) : null,
      warnings: 0,
    },
    quote: {
      symbol: pool.token_y?.symbol || "SOL",
      mint: pool.token_y?.address || SOL_MINT,
    },
    pool_type: "dlmm",
    bin_step: pool.pool_config?.bin_step ?? poolDetail?.dlmm_params?.bin_step ?? null,
    fee_pct: pool.pool_config?.base_fee_pct ?? poolDetail?.fee_pct ?? null,
    tvl: round(tvl),
    active_tvl: round(activeTvl),
    fee_active_tvl_ratio: feeActiveTvlRatio,
    volatility: poolDetail?.volatility != null ? Number(Number(poolDetail.volatility).toFixed(2)) : null,
    holders: num(token.holder_count || info?.holder_count) || null,
    mcap: round(num(token.market_cap || infoPrice * num(info?.circulating_supply))),
    organic_score: organicScore,
    token_age_hours: token.open_timestamp
      ? Math.floor((Date.now() / 1000 - num(token.open_timestamp)) / 3600)
      : null,
    dev: info?.dev?.creator_address || null,
    price: num(infoPrice || token.price),
    price_change_pct: num(token.price_change_percent5m ?? token.price_change_percent),
    active_pct: poolDetail?.active_positions_pct != null
      ? Number(Number(poolDetail.active_positions_pct).toFixed(1))
      : null,
    volume: num(token.volume ?? 0),
    swap_count: token.swaps ?? null,
    gmgn: true,
    gmgn_score: Number(gmgnScore.toFixed(2)),
    gmgn_total_fee_sol: num(infoAnalysis?.totalFeeSol ?? info?.total_fee),
    gmgn_trade_fee_sol: num(infoAnalysis?.tradeFeeSol ?? info?.trade_fee),
    gmgn_smart_wallets: smartCount,
    gmgn_kol_wallets: kolCount,
    gmgn_kol_names: holdersAnalysis?.kolHolderNames || [],
    gmgn_kol_profit_names: holdersAnalysis?.kolProfitNames || [],
    gmgn_preferred_kol_matches: num(holdersAnalysis?.preferredKolHolding),
    gmgn_preferred_kol_holders: holdersAnalysis?.preferredKolHolders || [],
    gmgn_dump_kol_significant: num(holdersAnalysis?.dumpKolSignificantCount),
    gmgn_dump_kol_minor: num(holdersAnalysis?.dumpKolMinorCount),
    gmgn_dump_kol_holders: holdersAnalysis?.dumpKolHolders || [],
    gmgn_top10_holder_pct: ratioPct(security?.top_10_holder_rate ?? token.top_10_holder_rate),
    gmgn_bundler_pct: ratioPct(security?.bundler_trader_amount_rate ?? token.bundler_rate),
    gmgn_insider_pct: ratioPct(security?.rat_trader_amount_rate ?? token.rat_trader_amount_rate),
    gmgn_bot_degen_pct: ratioPct(info?.stat?.bot_degen_rate ?? token.bot_degen_rate),
    gmgn_token_info_top10_pct: infoAnalysis?.top10HolderPct ?? null,
    gmgn_dev_team_hold_pct: infoAnalysis?.devTeamHoldPct ?? null,
    gmgn_fresh_wallet_pct: infoAnalysis?.freshWalletPct ?? null,
    gmgn_bot_degen_count: infoAnalysis?.botDegenCount ?? null,
    gmgn_token_info_bundler_pct: infoAnalysis?.bundlerPct ?? null,
    gmgn_token_info_insider_pct: infoAnalysis?.insiderPct ?? null,
    gmgn_sniper_wallets: infoAnalysis?.sniperWallets ?? null,
    gmgn_bundler_wallets: infoAnalysis?.bundlerWallets ?? null,
    gmgn_whale_wallets: infoAnalysis?.whaleWallets ?? null,
    gmgn_fresh_wallets: infoAnalysis?.freshWallets ?? null,
    gmgn_sniper_count: num(security?.sniper_count ?? token.sniper_count),
    gmgn_kol_holding: holdersAnalysis.kolHolding,
    gmgn_smart_holding: holdersAnalysis.smartHolding,
    gmgn_smart_accumulating: holdersAnalysis.smartAccumulating,
    gmgn_smart_exiting: holdersAnalysis.smartExiting,
    gmgn_mostly_exited: holdersAnalysis.mostlyExited,
    price_vs_ath_pct: infoAnalysis?.priceVsAthPct != null ? Number(infoAnalysis.priceVsAthPct.toFixed(2)) : null,
    ath: info?.ath_price || null,
    launchpad: token.launchpad_platform || info?.launchpad_platform || info?.launchpad || null,
    indicators: indicatorSignal ?? null,
  };
}

/* ============================== pipeline ============================== */

/**
 * 4-stage GMGN discovery via gmgn-cli + Meteora resolver. Returns
 * { total, stage_counts, pools, filtered_examples }. `pools` are candidates in
 * the same shape discoverPools() returns (consumed by getTopCandidates).
 */
export async function discoverGmgnPools({ limit = 10 } = {}) {
  const g = config.gmgn;
  const filtered = [];
  const stageCounts = {};

  // ── Stage 1: trending rank filter ─────────────────────────────────────────
  const args = [
    "market", "trending", "--chain", CHAIN,
    "--interval", normalizeInterval(g.interval),
    "--order-by", g.orderBy || "volume",
    "--direction", g.direction || "desc",
    "--limit", String(Math.min(100, Math.max(1, Number(g.limit || 100)))),
  ];
  for (const f of g.filters || []) args.push("--filter", f);
  for (const p of g.platforms || []) args.push("--platform", p);

  const rankOut = await spawnGmgn(args);
  const ranked = unwrap(rankOut, "rank");
  const s1 = ranked
    .filter((token) => {
      const check = passBasicRankFilter(token);
      if (!check.pass) {
        filtered.push({ stage: 1, name: token.symbol || token.address, reason: check.reasons.join(", ") });
        return false;
      }
      return true;
    })
    .sort((a, b) => num(b.volume) - num(a.volume))
    .slice(0, Math.max(limit, Number(g.enrichLimit || 20)));
  stageCounts.s1 = s1.length;
  log("gmgn", `Stage1 rank: ${ranked.length} → ${s1.length} pass`);

  // ── Stage 2: token info filter ────────────────────────────────────────────
  const s2 = [];
  for (const token of s1) {
    const mint = token.address;
    const out = await spawnGmgn(["token", "info", "--chain", CHAIN, "--address", mint]);
    if (!out) {
      filtered.push({ stage: 2, name: token.symbol || mint, reason: "token info unavailable" });
      continue;
    }
    const info = out?.data?.data || out?.data || out;
    const infoCheck = analyzeTokenInfo(info);
    if (!infoCheck.passed) {
      filtered.push({ stage: 2, name: token.symbol || mint, reason: infoCheck.reasons.join(", ") });
      continue;
    }
    s2.push({ token, info, infoCheck });
  }
  stageCounts.s2 = s2.length;
  log("gmgn", `Stage2 info: ${s1.length} → ${s2.length} pass`);

  // ── Stage 3: holders/traders (soft) + Meteora SOL DLMM pool gate (hard) ────
  const s3 = [];
  const minTvl = num(g.minTvl ?? config.screening.minTvl ?? 0);
  for (const { token, info, infoCheck } of s2) {
    const mint = token.address;
    try {
      const [hOut, tOut] = await Promise.all([
        spawnGmgn([
          "token", "holders", "--chain", CHAIN, "--address", mint,
          "--limit", String(g.holdersLimit || 100), "--order-by", "amount_percentage", "--direction", "desc",
        ]),
        spawnGmgn([
          "token", "traders", "--chain", CHAIN, "--address", mint,
          "--limit", String(g.holdersLimit || 100), "--order-by", "profit", "--direction", "desc",
        ]),
      ]);
      const holders = unwrap(hOut, "list");
      const traders = unwrap(tOut, "list");
      const holdersCheck = analyzeHoldersAndTraders(holders, traders);

      const topPools = await fetchTopMeteoraDlmmPoolsForMint(mint, minTvl, 2);
      if (topPools.length === 0) {
        filtered.push({ stage: 3, name: token.symbol || mint, reason: `no SOL DLMM pool above tvl>${minTvl}` });
        continue;
      }
      s3.push({ token, info, infoCheck, holdersCheck, topPools });
    } catch (error) {
      log("gmgn", `Stage3 skip ${token.symbol || mint}: ${error.message}`);
      filtered.push({ stage: 3, name: token.symbol || mint, reason: error.message });
    }
  }
  stageCounts.s3 = s3.length;
  log("gmgn", `Stage3 pool: ${s2.length} → ${s3.length} pass`);

  // ── Stage 4: local candle indicators ──────────────────────────────────────
  const s4 = [];
  if (g.indicatorFilter !== false) {
    for (const entry of s3) {
      const mint = entry.token.address;
      let indicatorCheck;
      try {
        indicatorCheck = await checkBounceSetup(mint);
      } catch (error) {
        log("gmgn", `Stage4 indicator unavailable for ${entry.token.symbol || mint}: ${error.message} — skip filter`);
        indicatorCheck = { passed: true, reasons: [], signal: null };
      }
      if (!indicatorCheck.passed) {
        filtered.push({ stage: 4, name: entry.token.symbol || mint, reason: indicatorCheck.reasons.join(", ") });
        continue;
      }
      s4.push({ ...entry, indicatorSignal: indicatorCheck.signal });
    }
  } else {
    s4.push(...s3);
  }
  stageCounts.s4 = s4.length;
  log("gmgn", `Stage4 indicators: ${s3.length} → ${s4.length} pass`);

  // ── Stage 5: pick best pool + condense ─────────────────────────────────────
  const pools = [];
  for (const { token, info, infoCheck, holdersCheck, topPools, indicatorSignal } of s4) {
    if (pools.length >= limit) break;
    const mint = token.address;
    try {
      const { pool, detail: poolDetail } = await pickBestPool(topPools);
      if (!pool) {
        filtered.push({ stage: 5, name: token.symbol || mint, reason: "pool selection failed" });
        continue;
      }
      const security = {};
      const candidate = condenseGmgnCandidate({
        token,
        pool,
        poolDetail,
        security,
        info,
        infoAnalysis: infoCheck,
        holdersAnalysis: holdersCheck,
        indicatorSignal,
      });
      if (!candidate.pool || !candidate.base?.mint) {
        filtered.push({ stage: 5, name: token.symbol || mint, reason: "incomplete pool mapping" });
        continue;
      }
      if (isBlacklisted(candidate.base.mint)) {
        log("blacklist", `Filtered blacklisted token ${candidate.base.symbol} (${candidate.base.mint?.slice(0, 8)}) in pool ${candidate.name}`);
        filtered.push({ stage: 5, name: token.symbol || mint, reason: "blacklisted token" });
        continue;
      }
      pools.push(candidate);
    } catch (error) {
      log("gmgn", `Stage5 skip ${token.symbol || mint}: ${error.message}`);
      filtered.push({ stage: 5, name: token.symbol || mint, reason: error.message });
    }
  }
  stageCounts.s5 = pools.length;
  log("gmgn", `Stage5 final: ${s4.length} → ${pools.length} candidates`);

  return {
    total: ranked.length,
    stage_counts: stageCounts,
    pools,
    filtered_examples: filtered,
  };
}

/** Human-readable one-shot summary of a GMGN candidate (verbatim port). */
export function formatGmgnCandidateForPrompt(p) {
  const sym = p.name || p.base?.symbol || "?";
  const launchpad = p.launchpad || "unknown";
  const age = p.token_age_hours != null ? `age=${p.token_age_hours}h` : "";
  const mcap = p.mcap != null ? `mcap=$${(p.mcap / 1000).toFixed(0)}k` : "";
  const binStep = p.bin_step != null ? `bin_step=${p.bin_step}` : "";

  const tvl = p.tvl != null ? `tvl=$${(p.tvl / 1000).toFixed(1)}k` : p.active_tvl != null ? `tvl=$${(p.active_tvl / 1000).toFixed(1)}k` : "";
  const feeTvl = p.fee_active_tvl_ratio != null ? `fee/tvl=${p.fee_active_tvl_ratio}%` : "";
  const vol = p.volume != null ? `vol=$${(p.volume / 1000).toFixed(1)}k` : "";
  const ath = p.price_vs_ath_pct != null ? `price_vs_ath=${p.price_vs_ath_pct.toFixed(0)}%` : "";

  const top10 = p.gmgn_token_info_top10_pct != null ? `top10=${p.gmgn_token_info_top10_pct}%` : (p.gmgn_top10_holder_pct != null ? `top10=${p.gmgn_top10_holder_pct}%` : "");
  const dev = p.gmgn_dev_team_hold_pct != null ? `dev=${p.gmgn_dev_team_hold_pct}%` : "";
  const bot = p.gmgn_bot_degen_pct != null ? `bot=${p.gmgn_bot_degen_pct}%` : "";
  const fresh = p.gmgn_fresh_wallet_pct != null ? `fresh=${p.gmgn_fresh_wallet_pct}%` : "";
  const bundler = p.gmgn_token_info_bundler_pct != null ? `bundler=${p.gmgn_token_info_bundler_pct}%` : (p.gmgn_bundler_pct != null ? `bundler=${p.gmgn_bundler_pct}%` : "");

  const holders = p.holders != null ? `holders=${p.holders.toLocaleString()}` : "";
  const fees = p.gmgn_total_fee_sol != null ? `fees=${p.gmgn_total_fee_sol.toFixed(0)}SOL` : "";
  const smart = p.gmgn_smart_wallets != null ? `smart=${p.gmgn_smart_wallets}` : "";
  const kol = p.gmgn_kol_wallets != null ? `kol=${p.gmgn_kol_wallets}` : "";

  let kolLine = "";
  if (p.gmgn_preferred_kol_holders?.length) {
    const pref = p.gmgn_preferred_kol_holders.map((k) => `${k.name} holding ${k.amountPct}%`).join(" | ");
    const prof = p.gmgn_kol_profit_names?.length ? ` | profit leaders: ${p.gmgn_kol_profit_names.slice(0, 3).join(", ")}` : "";
    kolLine = `\n  KOL: ${pref}${prof}`;
  } else if (p.gmgn_kol_names?.length) {
    const names = p.gmgn_kol_names.slice(0, 3).join(", ");
    const prof = p.gmgn_kol_profit_names?.length ? ` | profit leaders: ${p.gmgn_kol_profit_names.slice(0, 3).join(", ")}` : "";
    kolLine = `\n  KOL: ${names}${prof}`;
  }

  let dumpKolLine = "";
  if (p.gmgn_dump_kol_holders?.length) {
    const sig = p.gmgn_dump_kol_holders.map((k) => `${k.name} ${k.amountPct}%`).join(" | ");
    dumpKolLine = `\n  ⚠ DUMP KOL (significant): ${sig}`;
  } else if (p.gmgn_dump_kol_minor > 0) {
    dumpKolLine = `\n  ⚠ DUMP KOL (minor, <${config.gmgn?.dumpKolMinHoldPct}%): ${p.gmgn_dump_kol_minor} wallet(s)`;
  }

  let indLine = "";
  if (p.indicators) {
    const ind = p.indicators;
    const interval = ind.interval ? `[${ind.interval}]` : "";
    const st = ind.supertrendDirection ? `supertrend=${ind.supertrendDirection}${ind.supertrendBreakUp ? " (breakup)" : ""}` : "";
    const rsi = ind.rsi != null ? `rsi=${ind.rsi} ${ind.rsiLabel || ""}`.trim() : "";
    const bb = ind.bbPosition ? `bb=${ind.bbPosition}` : "";
    const parts = [st, rsi, bb].filter(Boolean).join(" | ");
    if (parts) indLine = `\n  Indicators ${interval}: ${parts}`;
  }

  const header = [sym, launchpad, age, mcap, binStep].filter(Boolean).join(" | ");
  const pool = [tvl, feeTvl, vol, ath].filter(Boolean).join(" | ");
  const risk = [top10, dev, bot, fresh, bundler].filter(Boolean).join(" | ");
  const traction = [holders, fees, smart, kol].filter(Boolean).join(" | ");

  return [
    `[${header}]`,
    pool ? `  Pool: ${pool}` : null,
    risk ? `  Risk: ${risk}` : null,
    traction ? `  Traction: ${traction}` : null,
    kolLine || null,
    dumpKolLine || null,
    indLine || null,
  ].filter(Boolean).join("\n");
}
