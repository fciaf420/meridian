export const CONFIG_KEY_MAP = {
  minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
  minTvl: ["screening", "minTvl"],
  maxTvl: ["screening", "maxTvl"],
  minVolume: ["screening", "minVolume"],
  minOrganic: ["screening", "minOrganic"],
  minHolders: ["screening", "minHolders"],
  minMcap: ["screening", "minMcap"],
  maxMcap: ["screening", "maxMcap"],
  minBinStep: ["screening", "minBinStep"],
  maxBinStep: ["screening", "maxBinStep"],
  maxVolatility: ["screening", "maxVolatility"],
  maxPriceChangePct: ["screening", "maxPriceChangePct"],
  timeframe: ["screening", "timeframe"],
  category: ["screening", "category"],
  minTokenFeesSol: ["screening", "minTokenFeesSol"],
  minClaimAmount: ["management", "minClaimAmount"],
  outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
  outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
  minVolumeToRebalance: ["management", "minVolumeToRebalance"],
  emergencyPriceDropPct: ["management", "emergencyPriceDropPct"],
  stopLossPct: ["management", "stopLossPct"],
  takeProfitFeePct: ["management", "takeProfitFeePct"],
  trailingTakeProfit: ["management", "trailingTakeProfit"],
  trailingTriggerPct: ["management", "trailingTriggerPct"],
  trailingDropPct: ["management", "trailingDropPct"],
  minSolToOpen: ["management", "minSolToOpen"],
  deployAmountSol: ["management", "deployAmountSol"],
  gasReserve: ["management", "gasReserve"],
  positionSizePct: ["management", "positionSizePct"],
  pnlUnit: ["management", "pnlUnit"],
  maxPositions: ["risk", "maxPositions"],
  maxDeployAmount: ["risk", "maxDeployAmount"],
  managementIntervalMin: ["schedule", "managementIntervalMin"],
  screeningIntervalMin: ["schedule", "screeningIntervalMin"],
  pnlWatcherIntervalSec: ["schedule", "pnlWatcherIntervalSec"],
  managementModel: ["llm", "managementModel"],
  screeningModel: ["llm", "screeningModel"],
  generalModel: ["llm", "generalModel"],
  binsBelow: ["strategy", "binsBelow"],
};

export function calculateBinsForPriceRange(binStep, priceRangePct) {
  if (!(binStep > 0)) throw new Error("binStep must be greater than 0");
  if (!(priceRangePct > 0) || priceRangePct >= 100) {
    throw new Error("priceRangePct must be between 0 and 100");
  }

  const stepPct = binStep / 10000;
  const pct = Math.abs(priceRangePct) / 100;
  return Math.abs(Math.ceil(Math.log(1 - pct) / Math.log(1 + stepPct)));
}

export function splitRangeBins(totalBins, solSplitPct) {
  const solPct = Math.min(100, Math.max(0, solSplitPct)) / 100;
  const binsBelow = Math.round(totalBins * solPct);
  return {
    binsBelow,
    binsAbove: totalBins - binsBelow,
  };
}

export function getRequiredSolBalance({ deployAmountSol = 0, gasReserve = 0 }) {
  const required = Number(deployAmountSol) + Number(gasReserve);
  return Number(required.toFixed(3));
}

export function getEffectiveMinSolToOpen({
  minSolToOpen = 0,
  deployAmountSol = 0,
  gasReserve = 0,
}) {
  return Math.max(Number(minSolToOpen) || 0, getRequiredSolBalance({ deployAmountSol, gasReserve }));
}

export function getScreeningThresholdSummary(screening) {
  return [
    ["maxVolatility", screening.maxVolatility],
    ["minFeeActiveTvlRatio", screening.minFeeActiveTvlRatio],
    ["minOrganic", screening.minOrganic],
    ["minHolders", screening.minHolders],
    ["maxPriceChangePct", screening.maxPriceChangePct],
    ["timeframe", screening.timeframe],
    ["minTokenFeesSol", screening.minTokenFeesSol],
  ];
}

export function getStartupMode({ isTTY }) {
  return {
    interactive: Boolean(isTTY),
    startServer: true,
    startCron: true,
    runStartupCheck: !isTTY,
  };
}

export function normalizeCandidatesPayload(payload) {
  const candidates = Array.isArray(payload?.candidates)
    ? payload.candidates
        .filter((candidate) => typeof candidate?.pool === "string" && candidate.pool.length > 0)
        .map((candidate) => ({
          pool: candidate.pool,
          name: candidate.name ?? null,
          fee_active_tvl_ratio: candidate.fee_active_tvl_ratio ?? null,
          volume: candidate.volume ?? candidate.volume_window ?? candidate.volume_24h ?? null,
          organic_score: candidate.organic_score ?? null,
          active_pct: candidate.active_pct ?? candidate.active_bin_pct ?? null,
        }))
    : [];

  return {
    candidates,
    total_eligible: Number(payload?.total_eligible ?? candidates.length),
    total_screened: Number(payload?.total_screened ?? candidates.length),
  };
}
