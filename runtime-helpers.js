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
  athTopThresholdPct: ["screening", "athTopThresholdPct"],
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
  ohlcvBufferMult: ["strategy", "ohlcvBufferMult"], // candle range-depth buffer; bounded 1.0–1.8 in executor
  // usdc mode
  usdcMode: ["usdc", "enabled"],
  deployAmountUsd: ["usdc", "deployAmountUsd"],
  maxDeployUsd: ["usdc", "maxDeployUsd"],
  minUsdcToOpen: ["usdc", "minUsdcToOpen"],
  gasReserveSol: ["usdc", "gasReserveSol"],
  // entry-safety filters: the agent may only TIGHTEN these (tools/entry-safety.js
  // checkAgentEntryFilterChange); the user loosens via Telegram or the file.
  blockTransferFeeAbovePct: ["entryFilters", "blockTransferFeeAbovePct"],
  blockTransferHook: ["entryFilters", "blockTransferHook"],
  blockPermanentDelegate: ["entryFilters", "blockPermanentDelegate"],
  blockFreezeAuthority: ["entryFilters", "blockFreezeAuthority"],
  blockMintAuthority: ["entryFilters", "blockMintAuthority"],
  blockPausable: ["entryFilters", "blockPausable"],
  blockNonTransferable: ["entryFilters", "blockNonTransferable"],
  solFeePoolsOnly: ["entryFilters", "solFeePoolsOnly"],
  twapSpikeMaxPct: ["entryFilters", "twapSpikeMaxPct"],
  twapWindowMinutes: ["entryFilters", "twapWindowMinutes"],
  blockJupiterSuspicious: ["entryFilters", "blockJupiterSuspicious"],
};

/**
 * Absolute floor for a deploy's price range (%). deploy_position widens any
 * narrower range to this; the Telegram range picker labels presets below it.
 */
export const MIN_RANGE_PCT = 35;

/** deploy_position rejects a position with fewer total bins than this. */
export const MIN_BINS = 20;

export function calculateBinsForPriceRange(binStep, priceRangePct) {
  if (!(binStep > 0)) throw new Error("binStep must be greater than 0");
  if (!(priceRangePct > 0) || priceRangePct >= 100) {
    throw new Error("priceRangePct must be between 0 and 100");
  }

  const stepPct = binStep / 10000;
  const pct = Math.abs(priceRangePct) / 100;
  // Round the MAGNITUDE up so the range covers at least priceRangePct.
  // (Math.abs(Math.ceil(x)) with x < 0 is floor(|x|): one bin short.)
  // The tiny epsilon keeps float noise on an exact integer (e.g. 69.0000000001)
  // from adding a spurious extra bin.
  const exact = Math.abs(Math.log(1 - pct) / Math.log(1 + stepPct));
  return Math.max(1, Math.ceil(exact - 1e-9));
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

/** Current USD value of an LP Agent open position: `value`, else parsed `currentValue`, else 0. */
export function lpaCurrentValueUsd(lpa) {
  if (typeof lpa?.value === "number" && Number.isFinite(lpa.value)) return lpa.value;
  const parsed = parseFloat(lpa?.currentValue);
  return Number.isFinite(parsed) ? parsed : 0;
}

export const SCREENING_SOURCES = ["meteora", "gmgn", "both"];

/**
 * Validate `screeningSource`. Accepts "meteora" | "gmgn" | "both" (case- and
 * whitespace-insensitive); anything else falls back to "meteora" with a warning.
 * Unset (null/undefined) is the default and does not warn.
 */
export function normalizeScreeningSource(value, { warn = (msg) => console.warn(msg) } = {}) {
  if (value == null) return "meteora";
  const normalized = String(value).trim().toLowerCase();
  if (SCREENING_SOURCES.includes(normalized)) return normalized;
  warn(`[config] Invalid screeningSource ${JSON.stringify(value)}: expected one of ${SCREENING_SOURCES.join(" | ")}. Falling back to "meteora".`);
  return "meteora";
}

/**
 * Gate for the screening cycle (cron tick or a manual "run now").
 * The operator pause only stops the scheduled cron; a manual run still goes,
 * but never overlaps a running cycle or a position action.
 * Returns { run, reason, touchTimer }; touchTimer mirrors the old cron, which
 * reset the countdown when it deferred.
 */
export function screeningCronGate({ paused = false, busy = false, screeningBusy = false, managementBusy = false, manual = false } = {}) {
  if (paused && !manual) return { run: false, reason: "screening paused by operator", touchTimer: true };
  if (busy) return { run: false, reason: "a position action is in progress", touchTimer: true };
  if (screeningBusy) return { run: false, reason: "a screening cycle is already running", touchTimer: false };
  if (managementBusy) return { run: false, reason: "a management cycle is in progress", touchTimer: true };
  return { run: true, reason: null, touchTimer: false };
}

// ─── Deploy overhead (position rent + tx fees) ───────────────────
// A DLMM position account's rent grows with its bin count. Measured live:
// ~0.0574 SOL for a standard 70-bin position, ~0.0948 SOL for 162 bins, i.e.
// ~0.00041 SOL per extra bin. Rent comes back when the position closes, but
// it must come out of free SOL at deploy, never out of the gas reserve.
export const POSITION_RENT_BASE_SOL = 0.0574;
export const POSITION_RENT_PER_EXTRA_BIN_SOL = 0.00041;
export const DEPLOY_TX_FEES_SOL = 0.01; // priority fees + Sender tips across create/add txs

export function estimatePositionRentSol(totalBins) {
  const bins = Math.max(0, Number(totalBins) || 0);
  return POSITION_RENT_BASE_SOL + POSITION_RENT_PER_EXTRA_BIN_SOL * Math.max(0, bins - 70);
}

/** Rent + fees for the deepest range a deploy can use (maxRangePct at the smallest allowed bin step). */
export function worstCaseDeployOverheadSol({ minBinStep = 80, maxRangePct = 80 } = {}) {
  const step = Number(minBinStep) > 0 ? Number(minBinStep) : 80;
  const pct = Number(maxRangePct) > 0 && Number(maxRangePct) < 100 ? Number(maxRangePct) : 80;
  return estimatePositionRentSol(calculateBinsForPriceRange(step, pct)) + DEPLOY_TX_FEES_SOL;
}

/**
 * Fit a SOL deposit so deposit + rent(totalBins) + fees leaves the gas reserve
 * intact. Returns { amount, shrunk, overhead, available }. amount can be <= 0
 * when nothing fits (caller rejects).
 */
export function fitDeployAmount({ freeSol, reserve, amount, totalBins }) {
  const overhead = estimatePositionRentSol(totalBins) + DEPLOY_TX_FEES_SOL;
  const available = Number(freeSol) - Number(reserve) - overhead;
  const fitted = Math.floor(Math.max(0, available) * 100) / 100;
  if (Number(amount) <= fitted + 1e-9) return { amount: Number(amount), shrunk: false, overhead, available };
  return { amount: fitted, shrunk: true, overhead, available };
}
