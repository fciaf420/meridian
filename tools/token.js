import { searchTokens, getTokenInfo as getJupTokenInfo, datapiSearchRaw } from "./jup-tokens.js";

// Token search + metadata use Jupiter's official Tokens API V2 (tools/jup-tokens.js,
// datapi search fallback). The internal datapi below is kept only for what the
// official API has no equivalent for: holders (/holders), holder PnL
// (/pnl-positions), global fees / bot-holder % (assets/search extras) and the
// deprecated ChainInsight narrative.
const DATAPI_BASE = "https://datapi.jup.ag/v1";

// Coerce API-sourced values (which may arrive as numeric strings or unexpected
// types) before formatting, so a type change upstream can't throw and break the
// whole lookup. Returns null for non-finite input instead of throwing.
const fix = (v, d) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(d)) : null);
// String-returning variant: preserves the existing `?.toFixed(d)` shape (a
// string, or undefined when absent) but won't throw if the field is a numeric
// string or other unexpected type.
const fixStr = (v, d) => (v == null ? undefined : (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : undefined));

/**
 * Get the narrative/story behind a token from Jupiter ChainInsight.
 * Useful for understanding if a token has a real community/theme vs nothing.
 */
export async function getTokenNarrative({ mint }) {
  // Jupiter deprecated community content; this endpoint may 404 or disappear.
  // Optional: a missing/removed narrative returns { narrative: null } instead of throwing.
  try {
    const res = await fetch(`${DATAPI_BASE}/chaininsight/narrative/${mint}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { mint, narrative: null, status: res.status === 404 ? "unavailable" : `error ${res.status}` };
    const data = await res.json();
    return { mint, narrative: data?.narrative || null, status: data?.status ?? null };
  } catch (e) {
    return { mint, narrative: null, status: `error: ${e.message}` };
  }
}

/**
 * Search for token data by name, symbol, or mint address.
 * Returns condensed token info useful for confidence scoring.
 */
export async function getTokenInfo({ query }) {
  // Official Tokens API (datapi fallback inside searchTokens), in parallel with
  // the datapi search for the extras the official API lacks (global fees, bot %).
  const [list, legacy] = await Promise.all([searchTokens(query), datapiSearchRaw(query)]);
  if (!list) return { found: false, query, error: "Token search unavailable (Jupiter Tokens API and datapi both failed)" };
  if (!list.length) return { found: false, query };
  const extras = new Map((legacy || []).filter((t) => t?.id).map((t) => [t.id, t]));
  const stats = (s) => (s ? {
    price_change: fixStr(s.price_change, 2),
    buy_vol: fixStr(s.buy_volume, 0),
    sell_vol: fixStr(s.sell_volume, 0),
    buyers: s.num_organic_buyers,
    net_buyers: s.num_net_buyers,
  } : null);

  return {
    found: true,
    query,
    results: list.slice(0, 5).map((t) => {
      const x = extras.get(t.mint);
      return {
        mint: t.mint,
        name: t.name,
        symbol: t.symbol,
        mcap: t.mcap,
        price: t.usd_price,
        liquidity: t.liquidity,
        holders: t.holder_count,
        // Jupiter's raw 0–100 organic score (prefer it over the label).
        organic_score: t.organic_score,
        organic_label: t.organic_score_label,
        jup_verified: t.is_verified,
        jup_suspicious: t.is_sus || undefined,
        jup_banned: t.banned || undefined,
        launchpad: t.launchpad,
        graduated: !!t.graduated_pool,
        // Global fees paid by traders (priority + jito tips) in SOL (datapi only).
        // Low value = bundled txs or scam token. Minimum threshold: ~30 SOL.
        global_fees_sol: fix(t.global_fees_sol ?? x?.fees, 2),
        audit: t.audit ? {
          mint_disabled: t.audit.mint_authority_disabled,
          freeze_disabled: t.audit.freeze_authority_disabled,
          top_holders_pct: fixStr(t.audit.top_holders_pct, 2),
          bot_holders_pct: fixStr(t.audit.bot_holders_pct ?? x?.audit?.botHoldersPercentage, 2),
          dev_migrations: t.audit.dev_migrations,
        } : null,
        stats_5m: stats(t.stats_5m),
        stats_1h: stats(t.stats_1h),
        stats_6h: stats(t.stats_6h),
        stats_24h: stats(t.stats_24h),
        source: t.source,
      };
    }),
  };
}

/**
 * Get holder distribution for a token mint.
 * Fetches top 100 holders — caller decides how many to display.
 */
export async function getTokenHolders({ mint, limit = 20 }) {
  // Fetch holders and total supply in parallel
  // Holders and holder PnL stay on datapi: the official Tokens API has no
  // holder-list or PnL endpoint. Supply comes from the Tokens API; global fees
  // are a datapi-only extra.
  const [holdersRes, tokenInfo, legacy] = await Promise.all([
    fetch(`${DATAPI_BASE}/holders/${mint}?limit=100`),
    getJupTokenInfo(mint),
    datapiSearchRaw(mint),
  ]);
  if (!holdersRes.ok) throw new Error(`Holders API error: ${holdersRes.status}`);
  const data = await holdersRes.json();
  const legacyInfo = (legacy || []).find((t) => t?.id === mint) || null;
  const totalSupply = tokenInfo?.total_supply || tokenInfo?.circ_supply || legacyInfo?.totalSupply || legacyInfo?.circSupply || null;

  const holders = Array.isArray(data) ? data : (data.holders || data.data || []);

  const mapped = holders.slice(0, Math.min(limit, 100)).map((h) => {
    const tags = (h.tags || []).map((t) => t.name || t.id || t);
    const isPool = tags.some((t) => /pool|amm|liquidity|raydium|orca|meteora/i.test(t));
    const pct = totalSupply ? (Number(h.amount) / totalSupply) * 100 : (h.percentage ?? h.pct ?? null);
    return {
      address: h.address || h.wallet,
      amount: h.amount,
      pct: fix(pct, 4),
      sol_balance: h.solBalanceDisplay ?? h.solBalance,
      tags: tags.length ? tags : undefined,
      is_pool: isPool || undefined,
      funding: h.addressInfo?.fundingAddress ? {
        address: h.addressInfo.fundingAddress,
        amount: h.addressInfo.fundingAmount,
        slot: h.addressInfo.fundingSlot,
      } : undefined,
    };
  });

  const realHolders = mapped.filter((h) => !h.is_pool);
  const top10Pct = realHolders.slice(0, 10).reduce((s, h) => s + (Number(h.pct) || 0), 0);

  // ─── Bundler Detection ────────────────────────────────────────
  // common_funder: 2+ wallets funded by same address
  const funderGroups = {};
  for (const h of realHolders) {
    if (h.funding?.address) {
      (funderGroups[h.funding.address] ||= []).push(h.address);
    }
  }
  const commonFunderSet = new Set(
    Object.values(funderGroups).filter((g) => g.length >= 2).flat()
  );

  // funded_same_window: funded within ±5000 slots of any other holder
  const SLOT_WINDOW = 5000;
  const withSlots = realHolders.filter((h) => h.funding?.slot);
  const sorted = [...withSlots].sort((a, b) => a.funding.slot - b.funding.slot);
  const sameWindowSet = new Set();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].funding.slot - sorted[i].funding.slot <= SLOT_WINDOW) {
        sameWindowSet.add(sorted[i].address);
        sameWindowSet.add(sorted[j].address);
      } else break;
    }
  }

  // similar_amount: virtually identical % holdings (absolute diff <= 0.02 percentage points)
  // e.g. 0.15% and 0.152% match, but 2.33% and 2.4% do not
  const SIMILAR_PCT_THRESHOLD = 0.02;
  const similarAmountSet = new Set();
  for (let i = 0; i < realHolders.length; i++) {
    for (let j = i + 1; j < realHolders.length; j++) {
      const a = Number(realHolders[i].pct);
      const b = Number(realHolders[j].pct);
      if (a > 0 && b > 0 && Math.abs(a - b) <= SIMILAR_PCT_THRESHOLD) {
        similarAmountSet.add(realHolders[i].address);
        similarAmountSet.add(realHolders[j].address);
      }
    }
  }

  const bundlers = realHolders
    .map((h) => {
      const reasons = [];
      if (commonFunderSet.has(h.address)) reasons.push("common_funder");
      if (sameWindowSet.has(h.address)) reasons.push("funded_same_window");
      if (similarAmountSet.has(h.address)) reasons.push("similar_amount");
      return reasons.length ? { address: h.address, balance: h.amount, percentage: h.pct, reasons, slot: h.funding?.slot } : null;
    })
    .filter(Boolean);

  const totalBundlersPct = bundlers.reduce((s, b) => s + (Number(b.percentage) || 0), 0);

  // ─── Smart Wallet / KOL Cross-reference ──────────────────────
  // Use targeted holders endpoint — only returns matching wallets, no noise
  const { listSmartWallets } = await import("../smart-wallets.js");
  const { wallets: smartWallets } = listSmartWallets();
  let smartWalletsHolding = [];

  if (smartWallets.length > 0) {
    const addresses = smartWallets.map((w) => w.address).join(",");
    const kwRes = await fetch(
      `${DATAPI_BASE}/holders/${mint}?addresses=${addresses}`
    ).catch(() => null);
    const kwData = kwRes?.ok ? await kwRes.json() : null;
    const kwHolders = Array.isArray(kwData) ? kwData : (kwData?.holders || kwData?.data || []);

    const smartWalletMap = new Map(smartWallets.map((w) => [w.address, w]));
    const matchedHolders = kwHolders
      .map((h) => ({ ...h, addr: h.address || h.wallet }))
      .filter((h) => smartWalletMap.has(h.addr));

    await Promise.all(matchedHolders.map(async (h) => {
      const wallet = smartWalletMap.get(h.addr);
      const pct = totalSupply ? fix((Number(h.amount) / totalSupply) * 100, 4) : null;

      let pnl = null;
      try {
        const pnlRes = await fetch(`${DATAPI_BASE}/pnl-positions?address=${h.addr}&assetId=${mint}`);
        if (pnlRes.ok) {
          const pnlData = await pnlRes.json();
          const pos = pnlData?.[h.addr]?.tokenPositions?.[0];
          if (pos) pnl = {
            balance: pos.balance,
            balance_usd: pos.balanceValue,
            avg_cost: pos.averageCost,
            realized_pnl: pos.realizedPnl,
            unrealized_pnl: pos.unrealizedPnl,
            total_pnl: pos.totalPnl,
            total_pnl_pct: pos.totalPnlPercentage,
            buys: pos.totalBuys,
            sells: pos.totalSells,
            wins: pos.totalWins,
            bought_value: pos.boughtValue,
            sold_value: pos.soldValue,
            first_active: pos.firstActiveTime,
            last_active: pos.lastActiveTime,
            holding_days: pos.holdingPeriodInSeconds ? Math.round(pos.holdingPeriodInSeconds / 86400) : null,
          };
        }
      } catch { /* ignore */ }

      smartWalletsHolding.push({
        name: wallet.name,
        category: wallet.category,
        address: h.addr,
        pct,
        sol_balance: h.solBalanceDisplay ?? h.solBalance,
        pnl,
      });
    }));
  }

  return {
    mint,
    global_fees_sol: fix(tokenInfo?.global_fees_sol ?? legacyInfo?.fees, 2),
    total_fetched: holders.length,
    showing: mapped.length,
    top_10_real_holders_pct: fixStr(top10Pct, 2),
    bundlers_pct_in_top_100: fixStr(totalBundlersPct, 4),
    bundlers,
    smart_wallets_holding: smartWalletsHolding,
    holders: mapped,
  };
}
