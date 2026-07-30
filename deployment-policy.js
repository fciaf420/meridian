export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number`);
  return number;
}

export function binsForDownsidePct(targetDownsidePct, actualBinStep, bounds) {
  const downside = finiteNumber(targetDownsidePct, "targetDownsidePct");
  const binStep = finiteNumber(actualBinStep, "actualBinStep");
  const min = Math.max(0, Math.ceil(finiteNumber(bounds?.min, "minimum bins")));
  const max = Math.max(min, Math.floor(finiteNumber(bounds?.max, "maximum bins")));
  if (downside <= 0 || downside >= 100) throw new Error("targetDownsidePct must be between 0 and 100");
  if (binStep <= 0) throw new Error("actualBinStep must be positive");
  // DLMM adjacent-bin price ratio is 1 + binStep/10_000. Moving N bins
  // down covers 1 - ratio^-N of downside from the active price.
  const raw = Math.ceil(Math.log(1 / (1 - downside / 100)) / Math.log(1 + binStep / 10_000));
  return Math.min(max, Math.max(min, raw));
}

export function downsidePctForVolatility(volatility, strategyConfig = {}) {
  const defaultDownside = finiteNumber(strategyConfig.targetDownsidePct ?? 60, "targetDownsidePct");
  const minDownside = finiteNumber(strategyConfig.minDownsidePct ?? defaultDownside, "minDownsidePct");
  const maxDownside = finiteNumber(strategyConfig.maxDownsidePct ?? defaultDownside, "maxDownsidePct");
  const minVolatility = finiteNumber(strategyConfig.minDownsideVolatilityPct ?? 2.5, "minDownsideVolatilityPct");
  const defaultVolatility = finiteNumber(strategyConfig.defaultDownsideVolatilityPct ?? 5, "defaultDownsideVolatilityPct");
  const maxVolatility = finiteNumber(strategyConfig.maxDownsideVolatilityPct ?? 12, "maxDownsideVolatilityPct");

  if (!(0 < minDownside && minDownside <= defaultDownside && defaultDownside <= maxDownside && maxDownside < 100)) {
    throw new Error("Downside percentages must satisfy 0 < min <= default <= max < 100");
  }
  if (!(0 <= minVolatility && minVolatility < defaultVolatility && defaultVolatility < maxVolatility)) {
    throw new Error("Volatility anchors must satisfy 0 <= min < default < max");
  }
  if (volatility == null || volatility === "" || !Number.isFinite(Number(volatility))) return defaultDownside;

  const value = Number(volatility);
  if (value <= minVolatility) return minDownside;
  if (value >= maxVolatility) return maxDownside;
  if (value <= defaultVolatility) {
    const progress = (value - minVolatility) / (defaultVolatility - minVolatility);
    return minDownside + progress * (defaultDownside - minDownside);
  }
  const progress = (value - defaultVolatility) / (maxVolatility - defaultVolatility);
  return defaultDownside + progress * (maxDownside - defaultDownside);
}

export function validateSingleSidedSolOrientation(authoritative, amounts) {
  const amountY = finiteNumber(amounts?.amountY ?? 0, "amountY");
  const amountX = finiteNumber(amounts?.amountX ?? 0, "amountX");
  if (amountY > 0 && amountX === 0 && authoritative?.tokenYMint !== WRAPPED_SOL_MINT) {
    throw new Error(`Single-sided SOL requires authoritative token Y to be wrapped SOL (${WRAPPED_SOL_MINT})`);
  }
  return true;
}

export function buildAutonomousDeploymentPlan({
  modelSelection,
  candidate,
  authoritative,
  deployAmountSol,
  strategyConfig,
}) {
  const poolAddress = String(modelSelection?.pool_address || "");
  if (!poolAddress || poolAddress !== candidate?.pool) throw new Error("Selected pool is not an eligible host candidate");
  if (strategyConfig?.strategy !== "hybrid") throw new Error("Autonomous deployment requires configured hybrid strategy");
  const required = ["tokenXMint", "tokenYMint", "tokenXDecimals", "tokenYDecimals", "binStep", "activeBin"];
  for (const field of required) {
    if (authoritative?.[field] == null) throw new Error(`Missing authoritative SDK field: ${field}`);
  }
  const amountY = finiteNumber(deployAmountSol, "host deploy amount");
  if (amountY <= 0) throw new Error("host deploy amount must be positive");
  validateSingleSidedSolOrientation(authoritative, { amountY, amountX: 0 });
  const targetDownsidePct = downsidePctForVolatility(candidate.volatility, strategyConfig);
  const binsBelow = binsForDownsidePct(
    targetDownsidePct,
    authoritative.binStep,
    { min: strategyConfig.minBinsBelow, max: strategyConfig.maxBinsBelow },
  );
  return Object.freeze({
    __trustedAutonomousPlan: true,
    pool_address: poolAddress,
    pool_name: candidate.name || null,
    amount_y: amountY,
    amount_x: 0,
    strategy: strategyConfig.strategy,
    bins_below: binsBelow,
    bins_above: 0,
    base_mint: authoritative.tokenXMint,
    token_x_mint: authoritative.tokenXMint,
    token_y_mint: authoritative.tokenYMint,
    token_x_decimals: finiteNumber(authoritative.tokenXDecimals, "token X decimals"),
    token_y_decimals: finiteNumber(authoritative.tokenYDecimals, "token Y decimals"),
    bin_step: finiteNumber(authoritative.binStep, "bin step"),
    active_bin: finiteNumber(authoritative.activeBin, "active bin"),
    target_downside_pct: targetDownsidePct,
    volatility: candidate.volatility ?? null,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio_30m ?? candidate.fee_active_tvl_ratio ?? null,
    organic_score: candidate.organic_score ?? null,
  });
}
