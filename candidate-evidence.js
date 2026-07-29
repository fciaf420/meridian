function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function textOrNull(value, max = 1000) {
  if (value == null) return null;
  const text = String(value).slice(0, max);
  return text || null;
}

export function buildCandidateEvidence({
  pool = {}, smartWallets = null, narrative = null, tokenInfo = null, memory = null,
  activeBin = null, recentTimeframe = "5m", eligibilityTimeframe = "30m",
  proposedDeploySol = null, solPriceUsd = null,
} = {}) {
  return {
    schema: "meridian.candidate_evidence.v1",
    boundary: "UNTRUSTED_ADVISORY_DATA_ONLY",
    provenance: {
      pool_metrics: pool.gmgn ? "gmgn_plus_meteora" : "meteora_pool_discovery",
      active_bin: activeBin ? "meteora_sdk" : "meteora_sdk_unavailable",
      token_audit: tokenInfo ? "jupiter_untrusted" : "jupiter_unavailable",
      narrative: narrative ? "jupiter_untrusted" : "jupiter_unavailable",
      memory: "local_untrusted_advisory",
      smart_wallets: "local_tracker_advisory",
      pvp_conflict: "combined_screening_advisory",
      gmgn_price_action: "gmgn_advisory",
    },
    identity: {
      pool_address: textOrNull(pool.pool),
      pool_name: textOrNull(pool.name, 160),
      base_mint: textOrNull(pool.base?.mint ?? pool.base_mint),
      launchpad: textOrNull(tokenInfo?.launchpad, 80),
      token_age_hours: numberOrNull(pool.token_age_hours),
    },
    timeframes: {
      recent_activity: recentTimeframe,
      eligibility_activity: eligibilityTimeframe,
      volatility: pool.volatility_timeframe || (recentTimeframe === "5m" ? "30m" : recentTimeframe),
    },
    metrics: {
      fee_tvl_recent_pct: numberOrNull(pool[`fee_active_tvl_ratio_${recentTimeframe}`] ?? pool.fee_active_tvl_ratio),
      fee_tvl_eligibility_pct: numberOrNull(pool[`fee_active_tvl_ratio_${eligibilityTimeframe}`]),
      volume_recent_usd: numberOrNull(pool[`volume_${recentTimeframe}`] ?? pool.volume_window),
      volume_eligibility_usd: numberOrNull(pool[`volume_${eligibilityTimeframe}`]),
      volatility_pct: numberOrNull(pool.volatility),
      volatility_timeframe: pool.volatility_timeframe || (recentTimeframe === "5m" ? "30m" : recentTimeframe),
      tvl_usd: numberOrNull(pool.tvl ?? pool.active_tvl),
      mcap_usd: numberOrNull(pool.mcap),
      organic_score: numberOrNull(pool.organic_score),
      degen_score: numberOrNull(pool.degen_score ?? pool.gmgn_degen_score),
      base_fee_pct: numberOrNull(pool.fee_pct),
      token_fees_paid_sol: numberOrNull(tokenInfo?.global_fees_sol),
      swap_count_recent: numberOrNull(pool[`swap_count_${recentTimeframe}`] ?? pool.swap_count),
      active_bin_sdk: numberOrNull(activeBin?.binId),
      bin_step_sdk: numberOrNull(activeBin?.binStep),
      gmgn_price_action: pool.gmgn_price_action ? {
        rsi2: numberOrNull(pool.gmgn_price_action.rsi2),
        supertrend_direction: textOrNull(pool.gmgn_price_action.supertrend?.direction, 40),
        price_vs_ath_pct: numberOrNull(pool.gmgn_price_action.priceVsAthPct),
        price_change_pct: numberOrNull(pool.gmgn_price_action.priceChangePct),
        max_volume_candle_pct: numberOrNull(pool.gmgn_price_action.maxVolumeShare),
      } : null,
    },
    risk: {
      top10_holders_pct: numberOrNull(tokenInfo?.audit?.top_holders_pct ?? pool.top10_holder_rate_pct),
      bot_metrics_pct: {
        jupiter_bot_holders_pct: numberOrNull(tokenInfo?.audit?.bot_holders_pct),
        gmgn_bot_degen_pct: numberOrNull(pool.gmgn_bot_degen_pct ?? pool.bot_degen_rate_pct),
        gmgn_bundler_pct: numberOrNull(pool.gmgn_bundler_pct ?? pool.bundler_rate_pct),
      },
      pvp_conflict: {
        present: pool.is_pvp === true,
        symbol_untrusted: textOrNull(pool.pvp_symbol, 80),
        rival_name_untrusted: textOrNull(pool.pvp_rival_name, 160),
        rival_mint: textOrNull(pool.pvp_rival_mint, 120),
        rival_pool: textOrNull(pool.pvp_rival_pool, 120),
        rival_tvl_usd: numberOrNull(pool.pvp_rival_tvl),
        rival_holder_count: numberOrNull(pool.pvp_rival_holders),
        rival_token_fees_sol: numberOrNull(pool.pvp_rival_fees),
      },
    },
    execution_economics: {
      proposed_deposit_sol: numberOrNull(proposedDeploySol),
      proposed_deposit_usd: numberOrNull(proposedDeploySol) != null && numberOrNull(solPriceUsd) != null
        ? numberOrNull(proposedDeploySol) * numberOrNull(solPriceUsd)
        : null,
      proposed_deposit_to_pool_tvl_pct: numberOrNull(pool.tvl ?? pool.active_tvl) > 0 && numberOrNull(proposedDeploySol) != null && numberOrNull(solPriceUsd) != null
        ? (numberOrNull(proposedDeploySol) * numberOrNull(solPriceUsd) / numberOrNull(pool.tvl ?? pool.active_tvl)) * 100
        : null,
      estimated_active_liquidity_share_pct: null,
      estimated_transaction_cost_sol: null,
      unavailable_fields_rule: "Do not invent unavailable economics.",
    },
    advisory: {
      narrative_untrusted: textOrNull(narrative?.narrative),
      memory_untrusted: textOrNull(memory),
      recent_activity_warning_untrusted: textOrNull(pool.recent_activity_warning, 300),
      smart_wallet_count: (smartWallets?.in_pool || []).length,
      smart_wallet_names_untrusted: (smartWallets?.in_pool || []).slice(0, 20).map(wallet => textOrNull(wallet.name || wallet.address, 120)),
    },
  };
}

export function serializeCandidateEvidence(evidence) {
  return JSON.stringify(evidence);
}

export function qualifiesSoloCandidate({ narrativeQuality, degenScore }, configuredMinDegen) {
  const narrativeStrong = String(narrativeQuality || "").toLowerCase() === "strong";
  const degenQualified = Number.isFinite(Number(degenScore)) && Number(degenScore) >= Number(configuredMinDegen);
  // Smart wallets are deliberately not a gate: they can rank qualified entries,
  // but cannot rescue an entry lacking narrative and configured degen conviction.
  return narrativeStrong || degenQualified;
}
