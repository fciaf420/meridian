const DATAPI_BASE = "https://datapi.jup.ag/v1";

/**
 * Search for token data by name, symbol, or mint address.
 * Returns condensed token info useful for confidence scoring.
 */
export async function getTokenInfo({ query }) {
  const url = `${DATAPI_BASE}/assets/search?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Token search API error: ${res.status}`);
  const data = await res.json();
  const tokens = Array.isArray(data) ? data : [data];
  if (!tokens.length) return { found: false, query };

  return {
    found: true,
    query,
    results: tokens.slice(0, 5).map((t) => ({
      mint: t.id,
      name: t.name,
      symbol: t.symbol,
      mcap: t.mcap,
      price: t.usdPrice,
      liquidity: t.liquidity,
      holders: t.holderCount,
      organic_score: t.organicScore,
      organic_label: t.organicScoreLabel,
      launchpad: t.launchpad,
      graduated: !!t.graduatedPool,
      audit: t.audit ? {
        mint_disabled: t.audit.mintAuthorityDisabled,
        freeze_disabled: t.audit.freezeAuthorityDisabled,
        top_holders_pct: t.audit.topHoldersPercentage?.toFixed(2),
        bot_holders_pct: t.audit.botHoldersPercentage?.toFixed(2),
        dev_migrations: t.audit.devMigrations,
      } : null,
      stats_1h: t.stats1h ? {
        price_change: t.stats1h.priceChange?.toFixed(2),
        buy_vol: t.stats1h.buyVolume?.toFixed(0),
        sell_vol: t.stats1h.sellVolume?.toFixed(0),
        buyers: t.stats1h.numOrganicBuyers,
        net_buyers: t.stats1h.numNetBuyers,
      } : null,
      stats_24h: t.stats24h ? {
        price_change: t.stats24h.priceChange?.toFixed(2),
        buy_vol: t.stats24h.buyVolume?.toFixed(0),
        sell_vol: t.stats24h.sellVolume?.toFixed(0),
        buyers: t.stats24h.numOrganicBuyers,
        net_buyers: t.stats24h.numNetBuyers,
      } : null,
    })),
  };
}

/**
 * Get holder distribution for a token mint.
 * Fetches top 100 holders — caller decides how many to display.
 */
export async function getTokenHolders({ mint, limit = 20 }) {
  const url = `${DATAPI_BASE}/holders/${mint}?limit=100`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Holders API error: ${res.status}`);
  const data = await res.json();

  const holders = Array.isArray(data) ? data : (data.holders || data.data || []);

  const mapped = holders.slice(0, Math.min(limit, 100)).map((h) => {
    const tags = (h.tags || []).map((t) => t.name || t.id || t);
    const isPool = tags.some((t) => /pool|amm|liquidity|raydium|orca|meteora/i.test(t));
    return {
      address: h.address || h.wallet,
      amount: h.amount,
      pct: h.percentage ?? h.pct,
      sol_balance: h.solBalanceDisplay ?? h.solBalance,
      tags: tags.length ? tags : undefined,
      is_pool: isPool || undefined,
      funding: h.fundingAddress ? {
        address: h.fundingAddress,
        amount: h.fundingAmount,
        slot: h.fundingSlot,
      } : undefined,
    };
  });

  const realHolders = mapped.filter((h) => !h.is_pool);
  const top10Pct = realHolders.slice(0, 10).reduce((s, h) => s + (Number(h.pct) || 0), 0);

  return {
    mint,
    total_fetched: holders.length,
    showing: mapped.length,
    top_10_real_holders_pct: top10Pct.toFixed(2),
    holders: mapped,
  };
}
