import fs from "fs";
import { REPO_ROOT, repoPath } from "./repo-root.js";
import { getScreeningDefaultsForTimeframe, normalizeTimeframe, scaleScreeningToTimeframe, TIMEFRAME_SCREENING_SCALES } from "./screening-scales.js";

export { REPO_ROOT, repoPath, getScreeningDefaultsForTimeframe, normalizeTimeframe, scaleScreeningToTimeframe, TIMEFRAME_SCREENING_SCALES };

const USER_CONFIG_PATH = repoPath("user-config.json");
const GMGN_CONFIG_PATH = repoPath("gmgn-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

function readJsonIfExists(filePath) {
  return fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf8"))
    : {};
}

const u = readJsonIfExists(USER_CONFIG_PATH);
const gmgnUserConfig = readJsonIfExists(GMGN_CONFIG_PATH);
export const MIN_SAFE_BINS_BELOW = 35;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const legacyBinsBelow = numericConfig(u.binsBelow);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 180);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;
if (gmgnUserConfig.apiKey || u.gmgnApiKey) {
  process.env.GMGN_API_KEY ||= gmgnUserConfig.apiKey || u.gmgnApiKey;
}
if (u.telegramChatId) process.env.TELEGRAM_CHAT_ID ||= String(u.telegramChatId);

const indicatorUserConfig = u.chartIndicators ?? {};

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function gmgnValue(key, legacyKey, fallback) {
  return gmgnUserConfig[key] ?? u[legacyKey] ?? fallback;
}

function gmgnArray(key, legacyKey, fallback) {
  if (Array.isArray(gmgnUserConfig[key])) return gmgnUserConfig[key];
  if (Array.isArray(u[legacyKey])) return u[legacyKey];
  return fallback;
}

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    source:            u.screeningSource    ?? "meteora", // meteora | gmgn | both
    activityTimeframe: u.screeningActivityTimeframe ?? "30m",
    excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minQuoteOrganic:   u.minQuoteOrganic   ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    useDiscordSignals: u.useDiscordSignals ?? false,
    discordSignalMode: u.discordSignalMode ?? "merge", // merge | only
    avoidPvpSymbols:   u.avoidPvpSymbols   ?? true, // avoid exact-symbol rivals with real active pools
    blockPvpSymbols:   u.blockPvpSymbols   ?? false, // hard-filter PVP rivals before the LLM sees them
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    loneCandidateMinDegen: u.loneCandidateMinDegen ?? 50, // degen score that lets a SOLO candidate deploy without a narrative
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
  },

  gmgn: {
    apiKey: nonEmptyString(gmgnUserConfig.apiKey, u.gmgnApiKey, process.env.GMGN_API_KEY),
    baseUrl: nonEmptyString(gmgnUserConfig.baseUrl, u.gmgnBaseUrl, "https://openapi.gmgn.ai"),
    // gmgn = use GMGN /v1/token/info total_fee for global_fees_sol (minTokenFeesSol gate); jupiter = legacy Jupiter fees
    feeSource: nonEmptyString(gmgnUserConfig.feeSource, u.gmgnFeeSource, "gmgn"),
    interval: gmgnValue("interval", "gmgnInterval", "5m"),
    orderBy: gmgnValue("orderBy", "gmgnOrderBy", "default"),
    direction: gmgnValue("direction", "gmgnDirection", "desc"),
    limit: gmgnValue("limit", "gmgnLimit", 100),
    enrichLimit: gmgnValue("enrichLimit", "gmgnEnrichLimit", 20),
    requestDelayMs: gmgnValue("requestDelayMs", "gmgnRequestDelayMs", 350),
    maxRetries: gmgnValue("maxRetries", "gmgnMaxRetries", 2),
    holdersLimit: gmgnValue("holdersLimit", "gmgnHoldersLimit", 100),
    klineResolution: gmgnValue("klineResolution", "gmgnKlineResolution", "5m"),
    klineLookbackMinutes: gmgnValue("klineLookbackMinutes", "gmgnKlineLookbackMinutes", 60),
    filters: gmgnArray("filters", "gmgnFilters", ["renounced", "frozen", "not_wash_trading"]),
    platforms: gmgnArray("platforms", "gmgnPlatforms", ["Pump.fun", "meteora_virtual_curve", "pool_meteora"]),
    minMcap: gmgnValue("minMcap", "gmgnMinMcap", u.minMcap ?? 150_000),
    maxMcap: gmgnValue("maxMcap", "gmgnMaxMcap", u.maxMcap ?? 10_000_000),
    minTvl: gmgnValue("minTvl", "gmgnMinTvl", u.minTvl ?? 10_000),
    minVolume: gmgnValue("minVolume", "gmgnMinVolume", 1000),
    minHolders: gmgnValue("minHolders", "gmgnMinHolders", u.minHolders ?? 500),
    minTokenAgeHours: gmgnValue("minTokenAgeHours", "gmgnMinTokenAgeHours", 2),
    maxTokenAgeHours: gmgnValue("maxTokenAgeHours", "gmgnMaxTokenAgeHours", 24 * 7),
    minSmartDegenCount: gmgnValue("minSmartDegenCount", "gmgnMinSmartDegenCount", 1),
    requireKol: gmgnValue("requireKol", "gmgnRequireKol", true),
    minKolCount: gmgnValue("minKolCount", "gmgnMinKolCount", 1),
    maxRugRatio: gmgnValue("maxRugRatio", "gmgnMaxRugRatio", 0.3),
    maxTop10HolderRate: gmgnValue("maxTop10HolderRate", "gmgnMaxTop10HolderRate", 0.5),
    maxBundlerRate: gmgnValue("maxBundlerRate", "gmgnMaxBundlerRate", 0.5),
    maxRatTraderRate: gmgnValue("maxRatTraderRate", "gmgnMaxRatTraderRate", 0.2),
    maxFreshWalletRate: gmgnValue("maxFreshWalletRate", "gmgnMaxFreshWalletRate", 0.2),
    maxDevTeamHoldRate: gmgnValue("maxDevTeamHoldRate", "gmgnMaxDevTeamHoldRate", 0.02),
    preferredKolMinHoldPct: gmgnValue("preferredKolMinHoldPct", "gmgnPreferredKolMinHoldPct", 1),
    dumpKolMinHoldPct: gmgnValue("dumpKolMinHoldPct", "gmgnDumpKolMinHoldPct", 0.5),
    maxBotDegenRate: gmgnValue("maxBotDegenRate", "gmgnMaxBotDegenRate", 0.4),
    maxSniperCount: gmgnValue("maxSniperCount", "gmgnMaxSniperCount", 20),
    maxSniperHoldRate: gmgnValue("maxSniperHoldRate", "gmgnMaxSniperHoldRate", 0.3),
    minTotalFeeSol: gmgnValue("minTotalFeeSol", "gmgnMinTotalFeeSol", 30),
    athFilterPct: gmgnValue("athFilterPct", "gmgnAthFilterPct", null),
    preferredKolNames: gmgnArray("preferredKolNames", "gmgnPreferredKolNames", []),
    dumpKolNames: gmgnArray("dumpKolNames", "gmgnDumpKolNames", []),
    indicatorFilter: gmgnValue("indicatorFilter", "gmgnIndicatorFilter", true),
    indicatorInterval: gmgnValue("indicatorInterval", "gmgnIndicatorInterval", "15_MINUTE"),
    indicatorRules: (() => {
      const r = gmgnUserConfig.indicatorRules || {};
      return {
        requireBullishSupertrend: r.requireBullishSupertrend ?? true,
        rejectAlreadyAtBottom:    r.rejectAlreadyAtBottom    ?? true,
        requireAboveSupertrend:   r.requireAboveSupertrend   ?? false,
        minRsi:                   r.minRsi                   ?? null,
        maxRsi:                   r.maxRsi                   ?? null,
        requireBbPosition:        r.requireBbPosition        ?? null,
      };
    })(),
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? true,
    autoSwapRetryAttempts: u.autoSwapRetryAttempts ?? 3,    // retries for base→SOL auto-swap on Jupiter failure
    autoSwapRetryDelayMs:  u.autoSwapRetryDelayMs  ?? 3000, // delay between auto-swap retries
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 7,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 10,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -20,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 15,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    hybridBidAskPct: u.hybridBidAskPct ?? 60,
    hybridSpotPct:   u.hybridSpotPct   ?? 40,
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
    minDownsidePct: Number(u.minDownsidePct ?? 50),
    targetDownsidePct: Number(u.targetDownsidePct ?? 60),
    maxDownsidePct: Number(u.maxDownsidePct ?? 75),
    minDownsideVolatilityPct: Number(u.minDownsideVolatilityPct ?? 2.5),
    defaultDownsideVolatilityPct: Number(u.defaultDownsideVolatilityPct ?? 5),
    maxDownsideVolatilityPct: Number(u.maxDownsideVolatilityPct ?? 12),
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        u.darwinEnabled     ?? true,
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── HiveMind ─────────────────────────
  hiveMind: {
    url: nonEmptyString(u.hiveMindUrl, DEFAULT_HIVEMIND_URL),
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY),
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
  },

  api: {
    url: nonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL),
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY),
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  // ─── PnL fetcher / poller (public infra: RPC + Meteora deposits + Jupiter) ──
  pnl: {
    rpcUrl: nonEmptyString(u.pnlRpcUrl, process.env.PNL_RPC_URL, "https://pump.helius-rpc.com"),
    source: nonEmptyString(u.pnlSource, "rpc"), // rpc | meteora (fallback-only)
    pollIntervalSec: Number(u.pnlPollIntervalSec ?? 3),
    depositCacheTtlSec: Number(u.pnlDepositCacheTtlSec ?? 300),
    // Consecutive confirming polls required before a peak is raised or an exit fires.
    // At a 3s poll cadence, 2 ticks ≈ 3-6s — filters single-tick noise without the
    // old fixed 15s setTimeout recheck.
    confirmTicks: Number(u.pnlConfirmTicks ?? 2),
  },

  // ─── Opportunity poller (catches strong pools between screening cycles) ──
  opportunity: {
    enabled: u.opportunityPollEnabled ?? true,
    pollIntervalSec: Number(u.opportunityPollIntervalSec ?? 45),
    limit: Number(u.opportunityPollLimit ?? 10),
    // Pre-gate: only trigger the full deploy decision when the best candidate's
    // Degen Score (0..100) clears this bar — avoids running screening every 45s.
    minScore: Number(u.opportunityMinScore ?? 40),
    // A smart wallet (from the agentmeridian server) sitting on the pool LOWERS the
    // effective minScore by this much — a strong signal nudges a borderline pool through.
    smartWalletScoreBonus: Number(u.opportunitySmartWalletBonus ?? 20),
    // Degen Score targets (each sub-score saturates at its target). Tune to calibrate.
    // Inputs are normalized to a fixed 30m reference window, so these are timeframe-independent.
    targetVolRatio: Number(u.degenTargetVolRatio ?? 20),     // (30m) volume/active_tvl for full trading sub-score
    targetLpCount: Number(u.degenTargetLpCount ?? 40),       // (30m) unique_lps + positions_created for full LP sub-score
    targetFeeRatio: Number(u.degenTargetFeeRatio ?? 0.20),   // (30m) fee/active_tvl for full fee sub-score (tune per timeframe; fees don't normalize as cleanly as volume)
    // active_tvl ($) for full liquidity sub-score. NOT timeframe-scaled. Set near your
    // active-TVL floor (≈ minTvl) so it acts as a dust floor, not a stretch goal — the
    // screening minTvl filter already removes tiny pools.
    targetLiquidity: Number(u.degenTargetLiquidity ?? 20000),
  },

  jupiter: {
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount: process.env.JUPITER_REFERRAL_ACCOUNT ?? "",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 0,
    ),
  },

  indicators: {
    enabled: indicatorUserConfig.enabled ?? false,
    entryPreset: indicatorUserConfig.entryPreset ?? "supertrend_break",
    exitPreset: indicatorUserConfig.exitPreset ?? "supertrend_break",
    rsiLength: indicatorUserConfig.rsiLength ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? indicatorUserConfig.intervals
      : ["5_MINUTE"],
    candles: indicatorUserConfig.candles ?? 298,
    rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
    rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
    requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  try {
    const fresh = readJsonIfExists(USER_CONFIG_PATH);
    const s = config.screening;
    if (fresh.screeningSource != null) s.source = fresh.screeningSource;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minTokenFeesSol  != null) s.minTokenFeesSol  = fresh.minTokenFeesSol;
    if (fresh.maxTop10Pct      != null) s.maxTop10Pct      = fresh.maxTop10Pct;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
    const minBinsBelow = numericConfig(fresh.minBinsBelow) ?? config.strategy.minBinsBelow;
    const maxBinsBelow = numericConfig(fresh.maxBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.maxBinsBelow;
    const defaultBinsBelow = numericConfig(fresh.defaultBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.defaultBinsBelow ?? maxBinsBelow;
    config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(minBinsBelow));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(maxBinsBelow));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(config.strategy.maxBinsBelow, Math.round(defaultBinsBelow)),
    );
  } catch { /* ignore */ }
  try {
    const freshGmgn = readJsonIfExists(GMGN_CONFIG_PATH);
    const g = config.gmgn;
    for (const [key, value] of Object.entries(freshGmgn)) {
      if (key in g && key !== "apiKey") g[key] = value;
    }
    if (freshGmgn.apiKey) g.apiKey = freshGmgn.apiKey;
  } catch { /* ignore */ }
}
