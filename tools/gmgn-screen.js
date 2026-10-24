/**
 * Advanced GMGN screening pipeline adapted to the local `gmgn-cli` binary.
 *
 * This is the OPT-IN screening source (screeningSource="gmgn", or "both" via
 * tools/screening-both.js). It mirrors the
 * upstream 4-stage "advanced GMGN screening" but every GMGN call goes through
 * the hardened `spawnGmgn` helper in ./gmgn.js (serialized queue + min-gap +
 * rate-limit cooldown + `--raw` + parsed-JSON-or-null), and the chart indicator
 * stage reuses our local candle summary from fetchGmgnPriceInfo() instead of any
 * remote chart-indicators API.
 *
 *   Stage 1  market trending  -> passBasicRankFilter (mcap/bundler/age/volume/rug/snipers)
 *   Stage 2  Meteora SOL DLMM pool-existence gate (FREE; before any weighted GMGN call)
 *   Stage 3  token info       -> analyzeTokenInfo (holders/fees/concentration/ATH)
 *   Stage 4  local candle indicators (supertrend / RSI / Bollinger)
 *   Stage 5  FINALISTS ONLY (top finalistLimit): token security (LOG-ONLY) + token
 *            holders/traders (weight 5 each; sniper supply share is the hard gate)
 *   Stage 6  pick best pool + condense to the candidate shape getTopCandidates emits
 *
 * FAIL CLOSED: a missing / unpopulated value for a gated field is "unknown" and
 * rejects the candidate for this cycle (it never passes as 0). A rate-limited
 * call is a distinct outcome (`deferred`): the remaining GMGN-bound candidates
 * are skipped this cycle, not passed and not permanently rejected.
 * filtered_examples[].kind is "reject" | "unknown" | "deferred".
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
import {
  spawnGmgnResult, fetchGmgnTokenInfoResult, fetchGmgnSecurityResult, fetchGmgnPriceInfoResult,
  fetchGmgnHoldersResult, getGmgnTransportState, GMGN_STATUS,
} from "./gmgn.js";
import {
  numOrNull, isStatUnpopulated, summarizeInfoRisk, summarizeSecurity, riskSnapshotFields, gmgnSetting,
  meteoraGateMode, meteoraGateThresholds,
} from "./gmgn-policy.js";
import { reportGmgnOutage, clearGmgnOutage } from "./gmgn-outage.js";

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

// null / "" / non-numeric => null (unknown). Plain Number(null) is 0, which is exactly the bug.
const optionalNum = numOrNull;

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

/** GMGN tags KOLs as either `kol` or `renowned`. */
function isKolEntry(entry) {
  return hasTag(entry, "kol") || hasTag(entry, "renowned");
}

/** Burn / DEX-pool rows (addr_type 1 / 2) are not real holders. */
function isRealHolderRow(entry) {
  const t = optionalNum(entry?.addr_type);
  return t !== 1 && t !== 2;
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

/** GMGN amount_percentage is a 0-1 fraction of TOTAL supply; always convert to percent. */
function entryAmountPct(entry) {
  const raw = entry?.amount_percentage ?? entry?.balance_percentage ?? entry?.amount_cur_percentage;
  const n = optionalNum(raw);
  if (n == null) return 0;
  return n * 100;
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
 * Stage 1 basic filter — reads the trending rank[] row. A gated field that is
 * missing/non-numeric is UNKNOWN and rejects (kind "unknown"), never 0.
 */
function passBasicRankFilter(token, g = config.gmgn) {
  const reasons = [];
  const unknown = [];
  const need = (label, value) => {
    const n = optionalNum(value);
    if (n == null) { unknown.push(label); reasons.push(`${label} unknown`); }
    return n;
  };
  const ageGated = g.minTokenAgeHours != null || g.maxTokenAgeHours != null;
  const created = ageGated ? need("creation_timestamp", token.creation_timestamp) : null;
  const tokenAgeHours = created != null && created > 0 ? (Date.now() / 1000 - created) / 3600 : null;
  const mcap = need("market_cap", token.market_cap);
  if (mcap != null && mcap < g.minMcap) reasons.push(`mcap ${mcap} < ${g.minMcap}`);
  if (mcap != null && g.maxMcap != null && mcap > g.maxMcap) reasons.push(`mcap ${mcap} > ${g.maxMcap}`);
  const bundler = g.maxBundlerRate != null ? need("bundler_rate", token.bundler_rate) : null;
  if (bundler != null && bundler > g.maxBundlerRate) {
    reasons.push(`bundler ${(bundler * 100).toFixed(1)}% > ${(g.maxBundlerRate * 100).toFixed(1)}%`);
  }
  if (tokenAgeHours != null && g.minTokenAgeHours != null && tokenAgeHours < g.minTokenAgeHours) {
    reasons.push(`age ${tokenAgeHours.toFixed(2)}h < ${g.minTokenAgeHours}h`);
  }
  if (tokenAgeHours != null && g.maxTokenAgeHours != null && tokenAgeHours > g.maxTokenAgeHours) {
    reasons.push(`age ${tokenAgeHours.toFixed(2)}h > ${g.maxTokenAgeHours}h`);
  }
  const volume = need("volume", token.volume);
  if (volume != null && volume < g.minVolume) reasons.push(`volume ${volume} < ${g.minVolume}`);
  // Optional security gates available on the trending row.
  const rug = g.maxRugRatio != null ? need("rug_ratio", token.rug_ratio) : null;
  if (rug != null && rug > g.maxRugRatio) reasons.push(`rug ratio ${ratioPct(rug)}%`);
  const snipers = g.maxSniperCount != null ? need("sniper_count", token.sniper_count) : null;
  if (snipers != null && snipers > g.maxSniperCount) reasons.push(`snipers ${snipers} > ${g.maxSniperCount}`);
  if (boolish(token.is_honeypot)) reasons.push("honeypot");
  if (boolish(token.is_wash_trading) && (g.filters || []).includes("not_wash_trading")) {
    reasons.push("wash trading");
  }
  return { pass: reasons.length === 0, reasons, unknown, tokenAgeHours };
}

/**
 * Stage 3 token-info filter — reads `token info` (unwrapped object). Fields:
 * holder_count, total_fee, stat.*, wallet_tags_stat.*, ath_price, price.price.
 *
 * Fail closed: an unpopulated `stat` block (every chain-analysis metric 0/absent)
 * or any gated field that is absent is "unknown" and rejects. top_10_holder_rate
 * of 0 is impossible for a live token, so it is treated as unknown too.
 */
function analyzeTokenInfo(info = {}, g = config.gmgn) {
  const stat = info.stat || {};
  const tags = info.wallet_tags_stat || {};
  const reasons = [];
  const unknown = [];
  const need = (label, value, { zeroIsUnknown = false } = {}) => {
    const n = optionalNum(value);
    if (n == null || (zeroIsUnknown && n === 0)) { unknown.push(label); reasons.push(`${label} unknown`); return null; }
    return n;
  };

  const smartWallets = num(tags.smart_wallets);
  const kolWallets = num(tags.renowned_wallets);
  const tradeFeeSol = num(info.trade_fee);
  // `price` may be an object ({ price, price_5m, ... }) or a scalar.
  const price = num(info.price?.price ?? info.price);
  const athPrice = num(info.ath_price);
  const priceVsAthPct = athPrice > 0 && price > 0 ? (price / athPrice) * 100 : null;
  // NOTE: price/ATH is <= 100 by construction, so threshold = 100 + athFilterPct
  // only ever fires for NEGATIVE athFilterPct (e.g. -20 = reject above 80% of ATH).
  const athFilter = g.athFilterPct;
  if (athFilter != null) {
    if (priceVsAthPct == null) { unknown.push("price_vs_ath"); reasons.push("price_vs_ath unknown"); }
    else {
      const threshold = 100 + Number(athFilter);
      if (priceVsAthPct > threshold) reasons.push(`price ${priceVsAthPct.toFixed(1)}% of ATH > ${threshold}%`);
    }
  }

  // A null threshold makes the field log-only (used by the Meteora-source gate for total_fee).
  const holderCount = g.minHolders != null ? need("holder_count", info.holder_count) : optionalNum(info.holder_count);
  if (holderCount != null && g.minHolders != null && holderCount < g.minHolders) reasons.push(`holders ${holderCount} < ${g.minHolders}`);
  const totalFeeSol = g.minTotalFeeSol != null ? need("total_fee", info.total_fee) : optionalNum(info.total_fee);
  if (totalFeeSol != null && g.minTotalFeeSol != null && totalFeeSol < g.minTotalFeeSol) reasons.push(`total fee ${totalFeeSol} SOL < ${g.minTotalFeeSol} SOL`);

  // contract-dd: take the non-zero of stat vs the dev block's top_10_holder_rate (same info payload).
  const nz = (v) => (optionalNum(v) > 0 ? optionalNum(v) : null);
  const top10Raw = nz(stat.top_10_holder_rate) ?? nz(info.dev?.top_10_holder_rate) ?? stat.top_10_holder_rate;
  const statUnpopulated = isStatUnpopulated(info.stat, info);
  if (statUnpopulated) {
    unknown.push("stat");
    reasons.push("stat block unpopulated (all risk metrics 0/absent)");
  } else {
    const top10 = need("top_10_holder_rate", top10Raw, { zeroIsUnknown: true });
    if (top10 != null && g.maxTop10HolderRate != null && top10 > g.maxTop10HolderRate) reasons.push(`top10 ${ratioPct(top10)}%`);
    if (g.maxDevTeamHoldRate != null) {
      const v = need("dev_team_hold_rate", stat.dev_team_hold_rate);
      if (v != null && v > g.maxDevTeamHoldRate) reasons.push(`dev team ${ratioPct(v)}%`);
    }
    if (g.maxBotDegenRate != null) {
      const v = need("bot_degen_rate", stat.bot_degen_rate);
      if (v != null && v > g.maxBotDegenRate) reasons.push(`bot degen ${ratioPct(v)}%`);
    }
    if (g.maxFreshWalletRate != null) {
      const v = need("fresh_wallet_rate", stat.fresh_wallet_rate);
      if (v != null && v > g.maxFreshWalletRate) reasons.push(`fresh wallets ${ratioPct(v)}%`);
    }
    if (g.maxBundlerRate != null) {
      const v = need("top_bundler_trader_percentage", stat.top_bundler_trader_percentage);
      if (v != null && v > g.maxBundlerRate) reasons.push(`bundler ${ratioPct(v)}%`);
    }
    if (g.maxRatTraderRate != null) {
      const v = need("top_rat_trader_percentage", stat.top_rat_trader_percentage);
      if (v != null && v > g.maxRatTraderRate) reasons.push(`insider ${ratioPct(v)}%`);
    }
  }

  return {
    passed: reasons.length === 0,
    reasons,
    unknown,
    statUnpopulated,
    smartWallets,
    kolWallets,
    priceVsAthPct,
    tradeFeeSol,
    totalFeeSol,
    top10HolderPct: ratioPct(top10Raw),
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
function analyzeHoldersAndTraders(holdersRaw = [], traders = [], g = config.gmgn) {
  // Burn / DEX-pool rows are not holders: drop them from every holder metric.
  const holders = holdersRaw.filter(isRealHolderRow);
  const combined = [...holders, ...traders];
  const kolHolders = holders.filter((entry) => isKolEntry(entry) && !entry.end_holding_at);
  const kolHolding = kolHolders.length;
  const smartHolding = holders.filter((entry) => hasTag(entry, "smart_degen") && !entry.end_holding_at).length;
  const kolTraders = traders.filter((entry) => isKolEntry(entry));
  const smartTraders = traders.filter((entry) => hasTag(entry, "smart_degen"));
  const smartAccumulating = smartTraders.filter((entry) => num(entry.buy_volume_cur) > num(entry.sell_volume_cur)).length;
  const smartExiting = smartTraders.filter((entry) => num(entry.sell_volume_cur) > num(entry.buy_volume_cur)).length;
  const mostlyExited = combined.filter(
    (entry) => (isKolEntry(entry) || hasTag(entry, "smart_degen")) && num(entry.sell_amount_percentage) >= 0.8
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
  // Row-count share (legacy metric, kept so the gate never loosens) and the real
  // thing: sniper-tagged share of TOTAL SUPPLY (amount_percentage is a 0-1 fraction).
  const sniperRowRate = holders.length > 0 ? sniperTopHolders.length / holders.length : 0;
  // No real row carrying amount_percentage => supply share is UNKNOWN (null), never 0.
  const supplyShareKnown = holders.some((entry) => optionalNum(entry.amount_percentage) != null);
  const sniperSupplyShare = supplyShareKnown
    ? sniperTopHolders.reduce((sum, entry) => sum + (optionalNum(entry.amount_percentage) ?? 0), 0)
    : null;
  const sniperHoldRate = Math.max(sniperRowRate, sniperSupplyShare ?? 0);

  const reasons = [];
  // A non-empty list whose rows are all DEX/burn leaves nothing to judge: unknown, not a 0/0 pass.
  const noRealHolders = holders.length === 0;
  if (noRealHolders) reasons.push("no real holder rows after excluding DEX/burn (fail closed)");
  if (sniperRowRate > g.maxSniperHoldRate) reasons.push(`sniper top-holder row rate ${(sniperRowRate * 100).toFixed(1)}%`);
  if (sniperSupplyShare != null && sniperSupplyShare > g.maxSniperHoldRate) reasons.push(`sniper supply share ${(sniperSupplyShare * 100).toFixed(1)}%`);

  return {
    passed: reasons.length === 0,
    reasons,
    noRealHolders,
    supplyShareKnown,
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
    sniperRowRate,
    sniperSupplyShare,
  };
}

/* ====================== Token -> Meteora pool resolver ====================== */

/**
 * Find SOL-quoted DLMM pools for a mint via the dlmm.datapi search endpoint.
 * (pool-discovery-api `filter_by` has no per-mint field — only this search works.)
 * DLMM is inferred from the presence of pool_config.bin_step.
 */
export async function fetchTopMeteoraDlmmPoolsForMint(mint, minTvl = 0, limit = 2) {
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
export async function fetchPoolDetailDirect(poolAddress) {
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=5m`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

/** Score candidate pools by fee_active_tvl_ratio desc then active_tvl desc. */
async function pickBestPool(pools, fetchDetail = fetchPoolDetailDirect) {
  const details = await Promise.all(
    pools.map((pool) => fetchDetail(pool.address || pool.pool_address).catch(() => null))
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
 * Bounce-setup check using our LOCAL candle summary (fetchGmgnPriceInfoResult().data.candles)
 * instead of any remote chart-indicators API. Supertrend direction is mapped
 * green->bullish / red->bearish; supertrend.flipped_green is the "break up" signal.
 *
 * FAILS CLOSED: no candles / no price is "unknown" (rejects this cycle), a
 * rate-limited fetch is "deferred" (neither pass nor reject).
 */
function checkBounceSetup(priceRes, g = config.gmgn) {
  if (priceRes?.status === GMGN_STATUS.RATE_LIMITED) {
    return { passed: false, deferred: true, reasons: ["GMGN rate limited"], signal: null };
  }
  const price = priceRes?.data;
  const c = price?.candles;
  if (!price || !c) {
    return { passed: false, kind: "unknown", reasons: ["no candles from GMGN kline (fail closed)"], signal: null };
  }
  if (!(optionalNum(price.price) > 0)) {
    return { passed: false, kind: "unknown", reasons: ["no GMGN price (fail closed)"], signal: null };
  }

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

  const rules = g?.indicatorRules || {};
  const reasons = [];

  if (rules.requireBullishSupertrend !== false && !isBullish) {
    reasons.push(`no bounce support: ${dir} supertrend`);
  }
  // bb_lower used to be undefined, so rejectAlreadyAtBottom never fired (even when a user set it
  // true). To preserve that effective behavior, the LEGACY key stays log-only forever; enforcement
  // needs the new explicit opt-in `enforceAlreadyAtBottom` (config.js warns once on legacy true).
  if (rules.enforceAlreadyAtBottom === true && alreadyAtBottom) {
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
      alreadyAtBottom,
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
function condenseGmgnCandidate({ token, pool, poolDetail, security, info, infoAnalysis, holdersAnalysis, indicatorSignal, riskFields = {} }) {
  const poolAddress = pool.address || pool.pool_address;
  const tvl = num(poolDetail?.tvl ?? pool.tvl ?? pool.liquidity);
  const activeTvl = num(poolDetail?.active_tvl ?? pool.active_tvl ?? tvl);
  const feeActiveTvlRatio = Number.isFinite(Number(poolDetail?.fee_active_tvl_ratio))
    ? Number(Number(poolDetail.fee_active_tvl_ratio).toFixed(4))
    : null;
  holdersAnalysis = holdersAnalysis || {};
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
    // Unknown rug_ratio earns NO bonus (it used to read as 0 => the full +500).
    (optionalNum(security?.rug_ratio ?? token.rug_ratio) == null
      ? 0
      : Math.max(0, 100 - optionalNum(security?.rug_ratio ?? token.rug_ratio) * 100) * 5);

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
    // creation_timestamp everywhere (open_timestamp is the migration/open event,
    // far younger for Pump.fun graduates and inconsistent with the age gate).
    token_age_hours: num(token.creation_timestamp ?? info?.creation_timestamp) > 0
      ? Math.floor((Date.now() / 1000 - num(token.creation_timestamp ?? info?.creation_timestamp)) / 3600)
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
    gmgn_gated: true, // GMGN safety gates ran for this candidate (Meteora-source path checks this)
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
    gmgn_sniper_count: optionalNum(security?.sniper_count ?? token.sniper_count),
    gmgn_sniper_supply_share_pct: holdersAnalysis?.sniperSupplyShare != null ? Number((holdersAnalysis.sniperSupplyShare * 100).toFixed(2)) : null,
    gmgn_sniper_row_rate_pct: holdersAnalysis?.sniperRowRate != null ? Number((holdersAnalysis.sniperRowRate * 100).toFixed(2)) : null,
    ...riskFields,
    gmgn_kol_holding: holdersAnalysis?.kolHolding ?? null,
    gmgn_smart_holding: holdersAnalysis?.smartHolding ?? null,
    gmgn_smart_accumulating: holdersAnalysis?.smartAccumulating ?? null,
    gmgn_smart_exiting: holdersAnalysis?.smartExiting ?? null,
    gmgn_mostly_exited: holdersAnalysis?.mostlyExited ?? null,
    price_vs_ath_pct: infoAnalysis?.priceVsAthPct != null ? Number(infoAnalysis.priceVsAthPct.toFixed(2)) : null,
    ath: info?.ath_price || null,
    launchpad: token.launchpad_platform || info?.launchpad_platform || info?.launchpad || null,
    indicators: indicatorSignal ?? null,
  };
}

/* ============================== pipeline ============================== */

const FINALIST_REASON = "beyond finalist cap (holders/traders run only for the top N; not rejected)";

function defaultDeps(cfg = config) {
  return {
    cfg,
    call: spawnGmgnResult,
    fetchInfo: fetchGmgnTokenInfoResult,
    fetchSecurity: fetchGmgnSecurityResult,
    fetchPrice: fetchGmgnPriceInfoResult,
    fetchHolders: fetchGmgnHoldersResult,
    fetchPools: fetchTopMeteoraDlmmPoolsForMint,
    fetchPoolDetail: fetchPoolDetailDirect,
  };
}

/**
 * GMGN discovery via gmgn-cli + Meteora resolver. Returns
 * { total, stage_counts, pools, filtered_examples, rate_limited }. `pools` are
 * candidates in the same shape discoverPools() returns (consumed by getTopCandidates).
 * Every dependency is injectable (`deps`) so tests run with no network / CLI.
 */
export async function discoverGmgnPools({ limit = 10, deps = {} } = {}) {
  const d = { ...defaultDeps(deps.cfg || config), ...deps };
  const g = d.cfg.gmgn;
  const filtered = [];
  const stageCounts = {};
  let rateLimited = false;
  const name = (t) => t.symbol || t.address;
  const note = (stage, token, reason, kind = "reject") => filtered.push({ stage, name: name(token), reason, kind });
  const deferRest = (stage, list, why) => { for (const t of list) note(stage, t.token || t, why, "deferred"); };

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

  const rankRes = await d.call(args);
  if (rankRes.status === GMGN_STATUS.RATE_LIMITED) {
    log("gmgn", "Stage1 rank: rate limited, skipping this cycle");
    return { total: 0, stage_counts: { s1: 0 }, pools: [], filtered_examples: [{ stage: 1, name: "*", reason: "GMGN rate limited", kind: "deferred" }], rate_limited: true };
  }
  if (rankRes.status !== GMGN_STATUS.OK) {
    log("gmgn", `Stage1 rank unavailable (${rankRes.status}), skipping this cycle`);
    return { total: 0, stage_counts: { s1: 0 }, pools: [], filtered_examples: [{ stage: 1, name: "*", reason: `trending unavailable (${rankRes.status})`, kind: "unknown" }], rate_limited: false };
  }
  const ranked = unwrap(rankRes.data, "rank");
  const s1 = ranked
    .filter((token) => {
      const check = passBasicRankFilter(token, g);
      if (!check.pass) {
        note(1, token, check.reasons.join(", "), check.unknown.length ? "unknown" : "reject");
        return false;
      }
      return true;
    })
    .sort((a, b) => num(b.volume) - num(a.volume))
    .slice(0, Math.max(limit, Number(g.enrichLimit || 20)));
  stageCounts.s1 = s1.length;
  log("gmgn", `Stage1 rank: ${ranked.length} → ${s1.length} pass`);

  // ── Stage 2: Meteora SOL DLMM pool existence (free; before any weighted call) ──
  const minTvl = num(g.minTvl ?? d.cfg.screening.minTvl ?? 0);
  const s2 = [];
  for (const token of s1) {
    try {
      const topPools = await d.fetchPools(token.address, minTvl, 2);
      if (topPools.length === 0) { note(2, token, `no SOL DLMM pool above tvl>${minTvl}`); continue; }
      s2.push({ token, topPools });
    } catch (error) {
      log("gmgn", `Stage2 pool lookup failed ${name(token)}: ${error.message}`);
      note(2, token, `pool lookup failed: ${error.message}`, "unknown");
    }
  }
  stageCounts.s2 = s2.length;
  log("gmgn", `Stage2 pool: ${s1.length} → ${s2.length} have a SOL DLMM pool`);

  // ── Stage 3: token info filter (one shared fetch per mint) ─────────────────
  const s3 = [];
  for (let i = 0; i < s2.length; i++) {
    const entry = s2[i];
    const { token } = entry;
    const infoRes = await d.fetchInfo(token.address);
    if (infoRes.status === GMGN_STATUS.RATE_LIMITED) {
      rateLimited = true;
      deferRest(3, s2.slice(i), "GMGN rate limited (retry next cycle)");
      break;
    }
    if (!infoRes.info) { note(3, token, `token info unavailable (${infoRes.status})`, "unknown"); continue; }
    const infoCheck = analyzeTokenInfo(infoRes.info, g);
    if (!infoCheck.passed) { note(3, token, infoCheck.reasons.join(", "), infoCheck.unknown.length ? "unknown" : "reject"); continue; }
    s3.push({ ...entry, info: infoRes.info, infoCheck });
  }
  stageCounts.s3 = s3.length;
  log("gmgn", `Stage3 info: ${s2.length} → ${s3.length} pass`);

  // ── Stage 4: local candle indicators (fail closed on missing candles) ──────
  const s4 = [];
  if (g.indicatorFilter !== false && !rateLimited) {
    for (let i = 0; i < s3.length; i++) {
      const entry = s3[i];
      const check = checkBounceSetup(await d.fetchPrice(entry.token.address), g);
      if (check.deferred) {
        rateLimited = true;
        deferRest(4, s3.slice(i), "GMGN rate limited (retry next cycle)");
        break;
      }
      if (!check.passed) { note(4, entry.token, check.reasons.join(", "), check.kind || "reject"); continue; }
      s4.push({ ...entry, indicatorSignal: check.signal });
    }
  } else if (g.indicatorFilter === false) {
    s4.push(...s3);
  } else {
    deferRest(4, s3, "GMGN rate limited (retry next cycle)");
  }
  stageCounts.s4 = s4.length;
  log("gmgn", `Stage4 indicators: ${s3.length} → ${s4.length} pass`);

  // ── Stage 5: FINALISTS ONLY — security (log-only) + holders/traders (gate) ──
  const finalistCap = Math.max(1, Number(gmgnSetting(d.cfg, "finalistLimit")) || 5);
  const finalists = s4.slice(0, finalistCap);
  for (const t of s4.slice(finalistCap)) note(5, t.token, FINALIST_REASON, "deferred");
  const s5 = [];
  for (let i = 0; i < finalists.length; i++) {
    const entry = finalists[i];
    const { token } = entry;
    const mint = token.address;
    const sec = await d.fetchSecurity(mint);
    if (sec.status === GMGN_STATUS.RATE_LIMITED) {
      rateLimited = true;
      deferRest(5, finalists.slice(i), "GMGN rate limited (retry next cycle)");
      break;
    }
    const hRes = await d.fetchHolders(mint, g.holdersLimit || 100);
    if (hRes.status === GMGN_STATUS.RATE_LIMITED) {
      rateLimited = true;
      deferRest(5, finalists.slice(i), "GMGN rate limited (retry next cycle)");
      break;
    }
    const holders = hRes.status === GMGN_STATUS.OK ? unwrap(hRes.data, "list") : [];
    if (!holders.length) {
      note(5, token, `holders unavailable (${hRes.status === GMGN_STATUS.OK ? "empty list" : hRes.status}) (fail closed)`, "unknown");
      continue;
    }
    const tRes = await d.call([
      "token", "traders", "--chain", CHAIN, "--address", mint,
      "--limit", String(g.holdersLimit || 100), "--order-by", "profit", "--direction", "desc",
    ]);
    if (tRes.status === GMGN_STATUS.RATE_LIMITED) {
      rateLimited = true;
      deferRest(5, finalists.slice(i), "GMGN rate limited (retry next cycle)");
      break;
    }
    // Traders only feed soft signals (smart/KOL activity); missing => empty, flagged.
    const traders = tRes.status === GMGN_STATUS.OK ? unwrap(tRes.data, "list") : [];
    const holdersCheck = analyzeHoldersAndTraders(holders, traders, g);
    if (!holdersCheck.passed) { note(5, token, holdersCheck.reasons.join(", "), holdersCheck.noRealHolders ? "unknown" : undefined); continue; }
    const infoRisk = summarizeInfoRisk(entry.info);
    const security = sec.status === GMGN_STATUS.OK ? summarizeSecurity(sec.security) : null;
    const riskFields = riskSnapshotFields({ infoRisk, security, securityStatus: sec.status === GMGN_STATUS.OK ? "ok" : sec.status });
    if (riskFields.gmgn_risk_log_only_flags.length) {
      log("gmgn_risk", `LOG-ONLY ${name(token)}: ${riskFields.gmgn_risk_log_only_flags.join(", ")}`);
    }
    s5.push({ ...entry, holdersCheck, riskFields, tradersAvailable: tRes.status === GMGN_STATUS.OK });
  }
  stageCounts.s5 = s5.length;
  log("gmgn", `Stage5 finalists: ${finalists.length} → ${s5.length} pass holders/traders`);

  // ── Stage 6: pick best pool + condense ─────────────────────────────────────
  const pools = [];
  for (const { token, info, infoCheck, holdersCheck, topPools, indicatorSignal, riskFields } of s5) {
    if (pools.length >= limit) break;
    const mint = token.address;
    try {
      const { pool, detail: poolDetail } = await pickBestPool(topPools, d.fetchPoolDetail);
      if (!pool) { note(6, token, "pool selection failed"); continue; }
      const candidate = condenseGmgnCandidate({
        token,
        pool,
        poolDetail,
        security: {},
        info,
        infoAnalysis: infoCheck,
        holdersAnalysis: holdersCheck,
        indicatorSignal,
        riskFields,
      });
      if (!candidate.pool || !candidate.base?.mint) { note(6, token, "incomplete pool mapping"); continue; }
      if (isBlacklisted(candidate.base.mint)) {
        log("blacklist", `Filtered blacklisted token ${candidate.base.symbol} (${candidate.base.mint?.slice(0, 8)}) in pool ${candidate.name}`);
        note(6, token, "blacklisted token");
        continue;
      }
      pools.push(candidate);
    } catch (error) {
      log("gmgn", `Stage6 skip ${name(token)}: ${error.message}`);
      note(6, token, error.message, "unknown");
    }
  }
  stageCounts.s6 = pools.length;
  log("gmgn", `Stage6 final: ${s5.length} → ${pools.length} candidates${rateLimited ? " (cycle cut short: GMGN rate limited)" : ""}`);

  return {
    total: ranked.length,
    stage_counts: stageCounts,
    pools,
    filtered_examples: filtered,
    rate_limited: rateLimited,
  };
}

/* ====================== Meteora-source safety gates ====================== */

/** True when the GMGN safety checks should run on Meteora-source candidates (mode !== "off" and a key exists). */
export function gmgnGatesAvailable(cfg = config) {
  if (meteoraGateMode(cfg) === "off") return false;
  return !!(cfg.gmgn?.apiKey || process.env.GMGN_API_KEY);
}

/**
 * Run the GMGN safety checks on candidates that did NOT come from the GMGN pipeline (the default
 * Meteora source, and Meteora-only rows in "both"), using the SEPARATE `meteoraGateThresholds`
 * (never the trending-pipeline values).
 *
 * Modes (gmgn.gateMeteoraSource):
 *   "shadow" (default)  evaluate everything but NEVER drop: each candidate gets
 *                       gmgn_gate_would_drop (bool) + gmgn_gate_would_drop_reasons[] + _kind, recorded in
 *                       the signal snapshot so would-drop can be compared with realized outcomes per
 *                       origin before any hard gate exists.
 *   "hard"              unknown data drops the candidate for this cycle (fail closed); a rate limit
 *                       defers the rest (kind "deferred"), never passes.
 *   "off"               skipped.
 * Outage detector: gmgn-cli missing / bad key, or >= outageMinCandidates candidates whose token info
 * failed at the transport level (status error/empty) with none healthy => one notification per outage
 * (tools/gmgn-outage.js) and `outage: true` on the result. In hard mode the cycle still fails closed.
 * Skipped entirely (candidates pass untouched) when no GMGN key is configured or mode is "off".
 */
export async function gateMeteoraSourceCandidates(pools, { limit = 10, deps = {} } = {}) {
  const d = { ...defaultDeps(deps.cfg || config), ...deps };
  const input = Array.isArray(pools) ? pools : [];
  if (!deps.force && !gmgnGatesAvailable(d.cfg)) return { kept: input, dropped: [], would_drop: [], rate_limited: false, skipped: true, mode: "off", outage: false };

  const mode = deps.mode || meteoraGateMode(d.cfg);
  const shadow = mode === "shadow";
  const g = meteoraGateThresholds(d.cfg);
  const dropped = [];
  const wouldDrop = [];
  const label = (p) => p.base?.symbol || p.name || p.pool;
  const out = [];
  const pending = [];
  let rateLimited = false;
  let healthyInfo = 0;
  let transportFailures = 0;
  let evaluated = 0;
  let preGated = 0;

  // Hard mode drops; shadow mode keeps the candidate and records what hard mode would have done.
  const reject = (p, reason, kind, extra = {}) => {
    const entry = { pool: p.pool, symbol: label(p), source: "meteora", reason, kind };
    if (shadow) {
      wouldDrop.push(entry);
      out.push({ ...p, gmgn_gate_would_drop: true, gmgn_gate_would_drop_reasons: String(reason).split(", "), gmgn_gate_would_drop_kind: kind, ...extra });
      log("gmgn_gate", `SHADOW would drop ${label(p)} (${(p.pool || "").slice(0, 8)}) [${kind}]: ${reason}`);
    } else {
      dropped.push(entry);
      log("gmgn_gate", `dropped ${label(p)} (${(p.pool || "").slice(0, 8)}) [${kind}]: ${reason}`);
    }
  };

  // Phase A: token-info gates for everything not already gated by the GMGN pipeline.
  for (let i = 0; i < input.length; i++) {
    const p = input[i];
    if (p.gmgn || p.gmgn_gated) { out.push(p); preGated += 1; continue; }
    const mint = p.base?.mint;
    if (!mint) { reject(p, "no base mint to check (fail closed)", "unknown"); continue; }
    evaluated += 1;
    const infoRes = await d.fetchInfo(mint);
    if (infoRes.status === GMGN_STATUS.RATE_LIMITED) {
      rateLimited = true;
      for (const rest of input.slice(i)) if (!(rest.gmgn || rest.gmgn_gated)) reject(rest, "GMGN rate limited (retry next cycle)", "deferred");
      break;
    }
    if (!infoRes.info) {
      if (infoRes.status === GMGN_STATUS.ERROR || infoRes.status === GMGN_STATUS.EMPTY) transportFailures += 1;
      reject(p, `token info unavailable (${infoRes.status}) (fail closed)`, "unknown");
      continue;
    }
    healthyInfo += 1;
    const check = analyzeTokenInfo(infoRes.info, g);
    if (!check.passed) { reject(p, check.reasons.join(", "), check.unknown.length ? "unknown" : "reject"); continue; }
    pending.push({ p, info: infoRes.info, check });
  }

  // Outage detection (cycle-wide): never a per-candidate event.
  const minN = Math.max(1, Number(gmgnSetting(d.cfg, "outageMinCandidates")) || 3);
  const transport = getGmgnTransportState();
  let outage = false;
  let outageReason = null;
  if (transport.binaryMissing) outageReason = "gmgn-cli is missing (ENOENT)";
  else if (transport.authFailed) outageReason = "GMGN rejected the API key (401)";
  else if (evaluated >= minN && healthyInfo === 0 && transportFailures >= minN && transportFailures === evaluated) {
    outageReason = `${transportFailures}/${evaluated} token-info lookups failed with no data (gmgn-cli broken or unreachable)`;
  }
  if (outageReason && !rateLimited) {
    outage = true;
    reportGmgnOutage(`${outageReason}; Meteora-source GMGN gate is ${shadow ? "in shadow mode (candidates kept, would-drop recorded)" : "failing closed: no Meteora candidates will pass"}`, { detail: { mode } });
  } else if (healthyInfo > 0) {
    clearGmgnOutage();
  }

  // Phase B: security (log-only) + holders sniper gate, until `limit` are verified.
  const need = Math.max(1, limit - preGated);
  let verified = 0;
  for (let i = 0; i < pending.length; i++) {
    const { p, info, check } = pending[i];
    if (rateLimited || verified >= need) {
      reject(p, rateLimited ? "GMGN rate limited (retry next cycle)" : "not needed this cycle (limit reached)", "deferred");
      continue;
    }
    const mint = p.base.mint;
    const sec = await d.fetchSecurity(mint);
    const hRes = sec.status === GMGN_STATUS.RATE_LIMITED
      ? { status: GMGN_STATUS.RATE_LIMITED }
      : await d.fetchHolders(mint, g.holdersLimit || 100);
    if (hRes.status === GMGN_STATUS.RATE_LIMITED) {
      rateLimited = true;
      reject(p, "GMGN rate limited (retry next cycle)", "deferred");
      continue;
    }
    const holders = hRes.status === GMGN_STATUS.OK ? unwrap(hRes.data, "list") : [];
    if (!holders.length) { reject(p, `holders unavailable (${hRes.status === GMGN_STATUS.OK ? "empty list" : hRes.status}) (fail closed)`, "unknown"); continue; }
    const hCheck = analyzeHoldersAndTraders(holders, [], g);
    if (hCheck.noRealHolders) { reject(p, hCheck.reasons.join(", "), "unknown"); continue; }
    // On this path the supply share is the ONLY holder gate: absent amount_percentage is unknown.
    if (!hCheck.supplyShareKnown) { reject(p, "holder amount_percentage missing: sniper supply share unknown (fail closed)", "unknown"); continue; }
    if (!hCheck.passed) { reject(p, hCheck.reasons.join(", "), "reject"); continue; }
    verified += 1;
    const infoRisk = summarizeInfoRisk(info);
    const security = sec.status === GMGN_STATUS.OK ? summarizeSecurity(sec.security) : null;
    const riskFields = riskSnapshotFields({ infoRisk, security, securityStatus: sec.status === GMGN_STATUS.OK ? "ok" : sec.status });
    if (riskFields.gmgn_risk_log_only_flags.length) log("gmgn_risk", `LOG-ONLY ${label(p)}: ${riskFields.gmgn_risk_log_only_flags.join(", ")}`);
    out.push({
      ...p,
      gmgn_gated: true,
      ...(shadow ? { gmgn_gate_would_drop: false, gmgn_gate_would_drop_reasons: [], gmgn_gate_would_drop_kind: null } : {}),
      gmgn_total_fee_sol: num(check.totalFeeSol),
      gmgn_token_info_top10_pct: check.top10HolderPct,
      gmgn_dev_team_hold_pct: check.devTeamHoldPct,
      gmgn_fresh_wallet_pct: check.freshWalletPct,
      gmgn_token_info_bundler_pct: check.bundlerPct,
      gmgn_token_info_insider_pct: check.insiderPct,
      gmgn_sniper_supply_share_pct: Number((hCheck.sniperSupplyShare * 100).toFixed(2)),
      gmgn_sniper_row_rate_pct: Number((hCheck.sniperRowRate * 100).toFixed(2)),
      ...riskFields,
    });
  }
  log("gmgn_gate", `Meteora-source GMGN gate [${mode}]: ${input.length} in → ${out.length} kept, ${dropped.length} dropped, ${wouldDrop.length} would-drop${rateLimited ? " (GMGN rate limited)" : ""}${outage ? " (OUTAGE)" : ""}`);
  return { kept: out, dropped, would_drop: wouldDrop, rate_limited: rateLimited, skipped: false, mode, outage };
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

  const src = Array.isArray(p.sources) && p.sources.length
    ? `src=${p.sources.join("+")}${p.confirmed_by_both ? " (confirmed by both)" : ""}`
    : "";

  const header = [sym, launchpad, age, mcap, binStep, src].filter(Boolean).join(" | ");
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

/** Test hook: the pure stage functions. Not part of the runtime API. */
export const _test = { passBasicRankFilter, analyzeTokenInfo, analyzeHoldersAndTraders, checkBounceSetup, condenseGmgnCandidate };
