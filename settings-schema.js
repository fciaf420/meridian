// settings-schema.js — the single source of truth for every user-editable
// setting: its config.js location, type, default, range, unit, tier, whether it
// needs a restart and whether a `profile` governs it.
//
// config.js builds `config` by reading through this table (resolveSetting), the
// Telegram settings console and the "All settings" editor are generated from it,
// and test/test-settings-schema.js keeps the pieces honest.
//
// TIERS
//   0  secrets          .env only (WALLET_PRIVATE_KEY, RPC_URL, TELEGRAM_BOT_TOKEN,
//                       LLM key, GMGN_API_KEY ...). Never in this table, never in Telegram.
//   1  basics           the handful of knobs a normal user touches
//   2  profile-governed bundles a `profile` sets (exits, screening, cadence, sizing, entry filters)
//   3  advanced         defaults are fine; editable, collapsed in the console
//   4  removed/hidden   dead keys were deleted (see REMOVED_KEYS); structured keys are hidden
//
// RESOLUTION ORDER for a key (first hit wins)
//   user-config.json value  >  active profile preset  >  schema default
// `profile: "custom"` (also what a file with no `profile` key means) has an EMPTY
// preset, so an existing user-config.json resolves to exactly what it always did.
//
// ADDING A SETTING (e.g. another branch's `bidAskFlip: {mode, fillPct, ...}` block):
//   add one row per leaf to SCHEMA below with a unique flat key (bidAskFlipMode,
//   bidAskFlipFillPct, ...), `path: ["bidAskFlip", "mode"]`, a default, a tier and
//   (if it should follow the profile) `gov: true` plus a value per profile in PROFILES.
//   Then read it in config.js as `bidAskFlip: { mode: S("bidAskFlipMode"), ... }`.
//   The console, the All-settings editor, validation and docs pick it up automatically.

export const TIERS = {
  1: { id: "basics", label: "Basics" },
  2: { id: "tuning", label: "Tuning (profile-governed)" },
  3: { id: "advanced", label: "Advanced" },
};

/**
 * Row: key (user-config.json key) · path (location in `config`) · type
 * (int|float|bool|enum|string|list) · def · tier · gov (profile-governed) ·
 * unit · min/max · restart (read only at boot) · nullable (explicit null is a
 * real value: "off"/"no limit") · enum · label · hidden (not editable in Telegram).
 */
const row = (key, path, type, def, o = {}) => ({ key, path, type, def, tier: 3, gov: false, restart: false, nullable: false, ...o });

export const SCHEMA = [
  // ── Mode ──
  row("dryRun", null, "bool", false, { tier: 1, label: "Dry run (no real transactions)", special: "dryRun" }),
  row("profile", null, "enum", "custom", { tier: 1, label: "Profile", enum: ["conservative", "balanced", "degen", "custom"], special: "profile" }),

  // ── Risk / sizing ──
  row("maxPositions", ["risk", "maxPositions"], "int", 3, { tier: 1, gov: true, min: 1, max: 50, label: "Max open positions" }),
  row("maxDeployAmount", ["risk", "maxDeployAmount"], "float", 50, { tier: 1, min: 0.1, unit: "SOL", label: "Max SOL per position (ceiling)" }),
  row("positionSizePct", ["management", "positionSizePct"], "float", 0.35, { tier: 1, gov: true, min: 0.01, max: 1, label: "Position size (share of capital)" }),
  row("maxSwapPriceImpactPct", ["risk", "maxSwapPriceImpactPct"], "float", 5, { min: 0.1, max: 50, unit: "%" }),
  row("maxCloseSwapPriceImpactPct", ["risk", "maxCloseSwapPriceImpactPct"], "float", 25, { min: 0.1, max: 90, unit: "%" }),
  row("deployAmountSol", ["management", "deployAmountSol"], "float", 0.5, { tier: 2, gov: true, min: 0.1, unit: "SOL", label: "Deploy size floor" }),
  row("gasReserve", ["management", "gasReserve"], "float", 0.2, { tier: 2, gov: true, min: 0, max: 5, unit: "SOL" }),
  row("minSolToOpen", ["management", "minSolToOpen"], "float", 0.55, { min: 0, unit: "SOL" }), // raised automatically to floor + reserve + overhead
  row("positionSizeBase", ["management", "positionSizeBase"], "enum", "total", { enum: ["total", "wallet"] }),
  row("pnlUnit", ["management", "pnlUnit"], "enum", "sol", { enum: ["sol", "usd"] }),
  row("priorityFeeLevel", ["management", "priorityFeeLevel"], "enum", "Medium", { enum: ["Min", "Low", "Medium", "High", "VeryHigh", "UnsafeMax"] }),

  // ── Exits ──
  row("stopLossPct", ["management", "stopLossPct"], "int", -20, { tier: 2, gov: true, min: -100, max: 0, unit: "%" }),
  row("takeProfitFeePct", ["management", "takeProfitFeePct"], "int", 5, { tier: 2, gov: true, min: 0.1, max: 100, unit: "%" }),
  row("trailingTriggerPct", ["management", "trailingTriggerPct"], "float", 3, { tier: 2, gov: true, min: 0.1, max: 100, unit: "%" }),
  row("trailingDropPct", ["management", "trailingDropPct"], "float", 1.5, { tier: 2, gov: true, min: 0.1, max: 99.9, unit: "%" }),
  row("outOfRangeWaitMinutes", ["management", "outOfRangeWaitMinutes"], "int", 30, { tier: 2, gov: true, min: 1, max: 1440, unit: "min" }),
  row("trailingTakeProfit", ["management", "trailingTakeProfit"], "bool", true),
  row("emergencyPriceDropPct", ["management", "emergencyPriceDropPct"], "int", -50, { min: -100, max: -1, unit: "%" }),

  // ── Screening (Meteora) ──
  row("screeningSource", ["screening", "source"], "enum", "meteora", { tier: 1, enum: ["meteora", "gmgn", "both"], label: "Screening source" }),
  row("minFeeActiveTvlRatio", ["screening", "minFeeActiveTvlRatio"], "float", 0.05, { tier: 2, gov: true, min: 0 }),
  row("minTvl", ["screening", "minTvl"], "int", 10_000, { tier: 2, gov: true, min: 0, unit: "USD" }),
  row("minVolume", ["screening", "minVolume"], "int", 500, { tier: 2, gov: true, min: 0, unit: "USD" }),
  row("minOrganic", ["screening", "minOrganic"], "int", 60, { tier: 2, gov: true, min: 0, max: 100 }),
  row("minMcap", ["screening", "minMcap"], "int", 150_000, { tier: 2, gov: true, min: 0, unit: "USD" }),
  row("timeframe", ["screening", "timeframe"], "enum", "5m", { tier: 2, gov: true, enum: ["5m", "30m", "1h", "2h", "4h", "12h", "24h"] }),
  row("minTokenFeesSol", ["screening", "minTokenFeesSol"], "int", 30, { tier: 2, gov: true, min: 0, unit: "SOL" }),
  row("maxVolatility", ["screening", "maxVolatility"], "int", 8, { tier: 2, gov: true, min: 0 }),
  row("minTokenAgeHours", ["screening", "minTokenAgeHours"], "float", null, { tier: 2, gov: true, nullable: true, min: 0, unit: "h" }),
  row("maxTokenAgeHours", ["screening", "maxTokenAgeHours"], "float", null, { tier: 2, gov: true, nullable: true, min: 0, unit: "h" }),
  row("maxBinStep", ["screening", "maxBinStep"], "int", 125, { tier: 2, gov: true, min: 1 }),
  row("feeDataDownRatio", ["screening", "feeDataDownRatio"], "float", 0.8, { min: 0, max: 1 }), // PR #130: share of candidates with a failed fee fetch that raises fee_data_down
  row("maxTvl", ["screening", "maxTvl"], "int", 150_000, { min: 0, unit: "USD" }),
  row("minHolders", ["screening", "minHolders"], "int", 500, { min: 0 }),
  row("maxMcap", ["screening", "maxMcap"], "int", 10_000_000, { min: 0, unit: "USD" }),
  row("minBinStep", ["screening", "minBinStep"], "int", 80, { min: 1 }),
  row("maxPriceChangePct", ["screening", "maxPriceChangePct"], "int", 300, { unit: "%" }),
  row("category", ["screening", "category"], "string", "trending"),
  row("athTopThresholdPct", ["screening", "athTopThresholdPct"], "int", 90, { min: 0, max: 100, unit: "%" }),
  row("gmgnSignalsEnabled", ["screening", "gmgnSignalsEnabled"], "bool", true),

  // ── Deploy-path safety (PR #129; ported from yunus-0x/meridian) ──
  row("recheckScreeningAtDeploy", ["safety", "recheckScreeningAtDeploy"], "bool", true),
  row("requireKnownVolatility", ["safety", "requireKnownVolatility"], "bool", true),
  row("maxEntryPriceMovePct", ["safety", "maxEntryPriceMovePct"], "float", 5, { min: 0, max: 100, unit: "%" }),
  row("maxScreenToDeployDropPct", ["safety", "maxScreenToDeployDropPct"], "float", 12, { min: 0, max: 100, unit: "%" }),
  row("depositSlippagePct", ["safety", "depositSlippagePct"], "float", 5, { min: 0.1, max: 50, unit: "%" }),

  // ── Exit safety (PR #132) ──
  row("exitConfirmTicks", ["exits", "confirmTicks"], "int", 2, { min: 1, max: 10 }),
  row("peakConfirmTicks", ["exits", "peakConfirmTicks"], "int", null, { nullable: true, min: 1, max: 10, derived: "exitConfirmTicks" }),
  row("exitConfirmMinSpacingSec", ["exits", "confirmMinSpacingSec"], "int", 20, { min: 0, max: 600, unit: "sec" }),
  row("stopLossUnverifiedMaxWaitSec", ["exits", "stopLossUnverifiedMaxWaitSec"], "int", 300, { min: 0, max: 3600, unit: "sec" }),
  row("stopLossEmergencyMaxWaitSec", ["exits", "stopLossEmergencyMaxWaitSec"], "int", 120, { min: 0, max: 3600, unit: "sec" }),
  row("onchainReadIntervalSec", ["exits", "onchainReadIntervalSec"], "int", 60, { min: 0, max: 3600, unit: "sec" }),
  row("pnlMismatchPts", ["exits", "pnlMismatchPts"], "float", 2, { min: 0, max: 100, unit: "pts" }),
  row("trailingMismatchAlertTicks", ["exits", "trailingMismatchAlertTicks"], "int", 3, { min: 1, max: 100 }),
  row("walletLockWarnSec", ["exits", "walletLockWarnSec"], "int", 300, { min: 0, max: 7200, unit: "sec" }),
  row("walletLockTimeoutSec", ["exits", "walletLockTimeoutSec"], "int", 900, { min: 0, max: 7200, unit: "sec" }),
  row("exitReadTimeoutSec", ["exits", "readTimeoutSec"], "int", 20, { min: 1, max: 600, unit: "sec" }),
  row("stopLossCooldownMinutes", ["exits", "stopLossCooldownMinutes"], "int", 240, { min: 0, max: 10080, unit: "min" }),
  row("oorCooldownTriggerCount", ["exits", "oorCooldownTriggerCount"], "int", 3, { min: 1, max: 100 }),
  row("oorCooldownMinutes", ["exits", "oorCooldownMinutes"], "int", 360, { min: 0, max: 10080, unit: "min" }),

  // ── Bid-ask flip (PR #133). user-config.json may also carry this as a nested "bidAskFlip": {mode, fillPct, ...} object (see NESTED_KEYS) ──
  row("bidAskFlipMode", ["bidAskFlip", "mode"], "enum", "shadow", { tier: 1, enum: ["off", "shadow", "live"], label: "Bid-ask flip (off | shadow | live)" }),
  row("bidAskFlipFillPct", ["bidAskFlip", "fillPct"], "float", 30, { min: 1, max: 100, unit: "%" }),
  row("bidAskFlipReflipStepPct", ["bidAskFlip", "reflipStepPct"], "float", 20, { min: 1, max: 100, unit: "%" }),
  row("bidAskFlipMinTrancheSol", ["bidAskFlip", "minTrancheSol"], "float", 0.05, { min: 0, unit: "SOL" }),

  // ── Entry-safety filters ──
  row("blockTransferFeeAbovePct", ["entryFilters", "blockTransferFeeAbovePct"], "float", 1.0, { tier: 2, gov: true, nullable: true, unit: "%" }),
  row("twapSpikeMaxPct", ["entryFilters", "twapSpikeMaxPct"], "float", 15, { tier: 2, gov: true, nullable: true, unit: "%" }),
  row("solFeePoolsOnly", ["entryFilters", "solFeePoolsOnly"], "bool", false, { tier: 2, gov: true }),
  row("blockJupiterSuspicious", ["entryFilters", "blockJupiterSuspicious"], "bool", false, { tier: 2, gov: true }),
  row("blockTransferHook", ["entryFilters", "blockTransferHook"], "bool", true),
  row("blockPermanentDelegate", ["entryFilters", "blockPermanentDelegate"], "bool", true),
  row("blockFreezeAuthority", ["entryFilters", "blockFreezeAuthority"], "bool", true),
  row("blockMintAuthority", ["entryFilters", "blockMintAuthority"], "bool", false),
  row("blockPausable", ["entryFilters", "blockPausable"], "bool", true),
  row("blockNonTransferable", ["entryFilters", "blockNonTransferable"], "bool", true),
  row("twapWindowMinutes", ["entryFilters", "twapWindowMinutes"], "int", 60, { min: 5, max: 1440, unit: "min" }),

  // ── Strategy ──
  row("activeStrategy", ["strategy", "activeStrategy"], "enum", "evil_panda", { tier: 1, enum: ["classic", "evil_panda"], label: "Entry strategy" }),
  row("strategy", ["strategy", "strategy"], "enum", "spot", { tier: 1, enum: ["spot", "bid_ask"], label: "Liquidity shape" }),
  row("maxRangePct", ["strategy", "maxRangePct"], "int", 80, { min: 1, max: 99, unit: "%" }),
  row("rangeDepthMode", ["strategy", "rangeDepthMode"], "enum", "ohlcv", { enum: ["ohlcv", "volatility"] }),
  row("ohlcvBufferMult", ["strategy", "ohlcvBufferMult"], "float", 1.3, { min: 1, max: 1.8 }),
  row("solanaTrackerDailyCap", ["strategy", "solanaTrackerDailyCap"], "int", 60, { min: 0, max: 2500 }),
  row("ohlcvTiers", ["strategy", "ohlcvTiers"], "list", null, { hidden: true, nullable: true }), // structured; edit user-config.json
  row("binsBelow", ["strategy", "binsBelow"], "int", 69, { min: 1, max: 69 }),
  row("evilPandaMinTokenVolume24h", ["strategy", "evilPanda", "minTokenVolume24h"], "int", 750_000, { min: 0, unit: "USD" }),
  row("evilPandaMinMcap", ["strategy", "evilPanda", "minMcap"], "int", 200_000, { min: 0, unit: "USD" }),
  row("evilPandaPriceRangePct", ["strategy", "evilPanda", "priceRangePct"], "int", 80, { min: 1, max: 99, unit: "%" }),

  // ── USDC mode ──
  row("usdcMode", ["usdc", "enabled"], "bool", false, { label: "USDC mode" }),
  row("deployAmountUsd", ["usdc", "deployAmountUsd"], "float", 50, { min: 1, max: 100_000, unit: "USD" }),
  row("maxDeployUsd", ["usdc", "maxDeployUsd"], "float", 500, { min: 1, max: 100_000, unit: "USD" }),
  row("minUsdcToOpen", ["usdc", "minUsdcToOpen"], "float", null, { min: 0, unit: "USD", derived: "defaults to deployAmountUsd" }),
  row("gasReserveSol", ["usdc", "gasReserveSol"], "float", 0.2, { min: 0, max: 5, unit: "SOL" }),

  // ── Schedule ──
  row("managementIntervalMin", ["schedule", "managementIntervalMin"], "int", 10, { tier: 2, gov: true, min: 1, max: 1440, unit: "min" }),
  row("screeningIntervalMin", ["schedule", "screeningIntervalMin"], "int", 30, { tier: 2, gov: true, min: 1, max: 1440, unit: "min" }),
  row("pnlWatcherIntervalSec", ["schedule", "pnlWatcherIntervalSec"], "int", 30, { min: 5, max: 3600, unit: "sec" }),

  // ── LLM ──
  row("llmProvider", null, "enum", "claude", { tier: 1, enum: ["codex", "claude", "deepseek", "minimax", "openrouter"], restart: true, label: "LLM provider", special: "llmProvider" }),
  row("llmModel", null, "string", null, { restart: true, hidden: true, special: "llmModel", derived: "provider default" }),
  row("temperature", ["llm", "temperature"], "float", 0.373, { min: 0, max: 2 }),
  row("maxTokens", ["llm", "maxTokens"], "int", 4096, { min: 256, max: 200_000 }),
  row("maxSteps", ["llm", "maxSteps"], "int", 20, { min: 1, max: 100 }),
  row("deepseekFallbackModel", ["llm", "deepseekFallbackModel"], "string", "deepseek-flash"),
  row("managementModel", ["llm", "managementModel"], "string", null, { nullable: true, derived: "llmModel / provider default" }),
  row("screeningModel", ["llm", "screeningModel"], "string", null, { nullable: true, derived: "llmModel / provider default" }),
  row("generalModel", ["llm", "generalModel"], "string", null, { nullable: true, derived: "llmModel / provider default" }),
  row("managementFallbackModel", ["llm", "managementFallbackModel"], "string", null, { nullable: true }),
  row("screeningFallbackModel", ["llm", "screeningFallbackModel"], "string", null, { nullable: true }),
  row("generalFallbackModel", ["llm", "generalFallbackModel"], "string", null, { nullable: true }),
  row("llmReasoningEffort", ["llm", "reasoningEffort"], "enum", null, { nullable: true, enum: [null, "low", "medium", "high", "xhigh"] }),

  // ── Web ──
  row("webPort", ["web", "port"], "int", 3737, { min: 1, max: 65_535, restart: true }),

  // ── Learning ──
  // Auto-tuning of thresholds from closed-trade history. OFF by default: when
  // off, lessons.js only LOGS the changes it would have made (never writes them).
  row("autoTune", ["learning", "autoTune"], "bool", false, { label: "Auto-tune thresholds from trade history" }),
  row("darwinianWeights", ["darwin", "enabled"], "bool", false),
  row("darwinianWindowDays", ["darwin", "windowDays"], "int", 60),
  row("darwinianBoostFactor", ["darwin", "boostFactor"], "float", 1.05),
  row("darwinianDecayFactor", ["darwin", "decayFactor"], "float", 0.95),
  row("darwinianWeightFloor", ["darwin", "weightFloor"], "float", 0.3),
  row("darwinianWeightCeiling", ["darwin", "weightCeiling"], "float", 2.5),
  row("darwinianMinSamples", ["darwin", "minSamples"], "int", 10),
  row("darwinianPerSignalMinSamples", ["darwin", "perSignalMinSamples"], "int", 12),
  row("darwinianMinAbsLiftToAdjust", ["darwin", "minAbsLiftToAdjust"], "float", 0.05),
  row("darwinianStrongLiftThreshold", ["darwin", "strongLiftThreshold"], "float", 0.2),
  row("darwinianCalibrationMinSamples", ["darwin", "calibrationMinSamples"], "int", 20),
  row("darwinianMeanReversionRate", ["darwin", "meanReversionRate"], "float", 0.02),

  // ── Autoresearch ──
  row("autoresearch", ["autoresearch", "enabled"], "bool", false),
  row("autoresearchMinClosesPerArm", ["autoresearch", "minClosesPerArm"], "int", 100),
  row("autoresearchMinEffectPct", ["autoresearch", "minEffectPct"], "float", 1.5),
  row("autoresearchMaxExperimentDays", ["autoresearch", "maxExperimentDays"], "int", 14),
  row("autoresearchAutoKeep", ["autoresearch", "autoKeep"], "bool", false),
  row("autoresearchMinAttributedLosses", ["autoresearch", "minAttributedLosses"], "int", 3),
  row("autoresearchCooldownCloses", ["autoresearch", "cooldownCloses"], "int", 5),
  row("autoresearchModel", ["autoresearch", "llmModel"], "string", null, { derived: "provider default" }),
  row("autoresearchReasoningEffort", ["autoresearch", "reasoningEffort"], "enum", "medium", { enum: ["low", "medium", "high", "xhigh"] }),
  row("autoresearchMaxDiffPct", ["autoresearch", "maxDiffPct"], "int", 30, { unit: "%" }),
];

/** Nested user-config.json objects accepted as an alias for flat schema keys (flat key wins). */
export const NESTED_KEYS = {
  bidAskFlip: { mode: "bidAskFlipMode", fillPct: "bidAskFlipFillPct", reflipStepPct: "bidAskFlipReflipStepPct", minTrancheSol: "bidAskFlipMinTrancheSol" },
};
export function flattenNested(raw = {}) {
  let out = raw;
  for (const [obj, map] of Object.entries(NESTED_KEYS)) {
    const nested = raw?.[obj];
    if (!nested || typeof nested !== "object") continue;
    for (const [k, flat] of Object.entries(map)) {
      if (nested[k] !== undefined && raw[flat] === undefined) { if (out === raw) out = { ...raw }; out[flat] = nested[k]; }
    }
  }
  return out;
}

export const BY_KEY = new Map(SCHEMA.map((r) => [r.key, r]));
export const GOVERNED_KEYS = SCHEMA.filter((r) => r.gov).map((r) => r.key);

/**
 * Keys that used to exist and were deleted because nothing reads them (verified
 * by grep over code, prompts and tool text). A leftover value in an old
 * user-config.json is ignored (and flagged by `npm run settings`).
 */
export const REMOVED_KEYS = [
  "minClaimAmount", "outOfRangeBinsToClose", "minVolumeToRebalance", "healthCheckIntervalMin",
  "gmgn.minKolCount", "gmgn.minSmartDegenCount", "gmgn.requireKol",
];

/** Keys that are machine bookkeeping, not settings; they live in the state file. */
export const BOOKKEEPING_KEYS = ["_lastEvolved", "_positionsAtEvolution", "_lastAgentTune"];

/**
 * Profile presets for the profile-governed keys. `custom` is intentionally
 * empty: it means "exactly what user-config.json says, defaults otherwise".
 *
 *   balanced      = the values the live bot has been running (tested in production)
 *   conservative  = UNTESTED starting point (tighter exits, stricter screening, fewer/smaller positions)
 *   degen         = UNTESTED starting point (wider exits, looser screening, more/larger positions)
 */
export const PROFILE_NAMES = ["conservative", "balanced", "degen", "custom"];
export const PROFILES = {
  conservative: {
    maxPositions: 2, positionSizePct: 0.2, deployAmountSol: 0.5, gasReserve: 0.2,
    stopLossPct: -10, takeProfitFeePct: 5, trailingTriggerPct: 3, trailingDropPct: 1.5, outOfRangeWaitMinutes: 15,
    minFeeActiveTvlRatio: 0.15, minTvl: 10_000, minVolume: 5000, minOrganic: 70, minMcap: 250_000,
    timeframe: "1h", minTokenFeesSol: 30, maxVolatility: 4, minTokenAgeHours: 6, maxTokenAgeHours: 72, maxBinStep: 125,
    managementIntervalMin: 10, screeningIntervalMin: 30,
    blockTransferFeeAbovePct: 1, twapSpikeMaxPct: 15, solFeePoolsOnly: false, blockJupiterSuspicious: true,
  },
  balanced: {
    maxPositions: 3, positionSizePct: 0.32, deployAmountSol: 1, gasReserve: 0.1,
    stopLossPct: -15, takeProfitFeePct: 12, trailingTriggerPct: 5, trailingDropPct: 4, outOfRangeWaitMinutes: 24,
    minFeeActiveTvlRatio: 0.38, minTvl: 1000, minVolume: 5000, minOrganic: 67, minMcap: 200_000,
    timeframe: "1h", minTokenFeesSol: 12, maxVolatility: 5, minTokenAgeHours: 2, maxTokenAgeHours: 72, maxBinStep: 200,
    managementIntervalMin: 5, screeningIntervalMin: 20,
    blockTransferFeeAbovePct: 5, twapSpikeMaxPct: null, solFeePoolsOnly: false, blockJupiterSuspicious: false,
  },
  degen: {
    maxPositions: 4, positionSizePct: 0.35, deployAmountSol: 1, gasReserve: 0.1,
    stopLossPct: -25, takeProfitFeePct: 15, trailingTriggerPct: 6, trailingDropPct: 5, outOfRangeWaitMinutes: 40,
    minFeeActiveTvlRatio: 0.2, minTvl: 1000, minVolume: 2000, minOrganic: 55, minMcap: 100_000,
    timeframe: "30m", minTokenFeesSol: 8, maxVolatility: 8, minTokenAgeHours: 1, maxTokenAgeHours: 96, maxBinStep: 250,
    managementIntervalMin: 5, screeningIntervalMin: 15,
    blockTransferFeeAbovePct: 5, twapSpikeMaxPct: null, solFeePoolsOnly: false, blockJupiterSuspicious: false,
  },
  custom: {},
};
export const UNTESTED_PROFILES = new Set(["conservative", "degen"]);

export function normalizeProfile(name) {
  const n = String(name ?? "custom").trim().toLowerCase();
  return PROFILE_NAMES.includes(n) ? n : "custom";
}

/**
 * Build a resolver over a raw user-config object.
 *   get(key)    → effective value
 *   source(key) → "user" | "profile" | "default"
 */
export function makeResolver(rawIn = {}) {
  const raw = flattenNested(rawIn);
  const profile = normalizeProfile(raw.profile);
  const preset = PROFILES[profile] ?? {};
  const resolve = (key) => {
    const r = BY_KEY.get(key);
    if (!r) throw new Error(`unknown setting: ${key}`);
    const v = raw[key];
    // Nullable keys: an explicit null is a real value ("off" / "no limit"), same as the old `nullable()` helper.
    if (r.nullable ? v !== undefined : v != null) return { value: v, source: "user" };
    if (key in preset) return { value: preset[key], source: "profile" };
    return { value: r.def, source: "default" };
  };
  return { profile, get: (key) => resolve(key).value, source: (key) => resolve(key).source };
}

/** Preset values that differ from what `effective` currently holds. */
export function diffProfile(name, effective) {
  const p = PROFILES[normalizeProfile(name)] ?? {};
  const out = [];
  for (const [key, to] of Object.entries(p)) {
    const from = effective[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) out.push({ key, from, to });
  }
  return out;
}

/** Counts per tier, for docs and the PR. */
export function tierCounts() {
  const c = { basics: 0, governed: 0, advanced: 0, hidden: 0 };
  for (const r of SCHEMA) {
    if (r.hidden) c.hidden++;
    else if (r.tier === 1) c.basics++;
    else if (r.tier === 2) c.governed++;
    else c.advanced++;
  }
  return c;
}
