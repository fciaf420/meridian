import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getEffectiveMinSolToOpen } from "./runtime-helpers.js";
import { getDefaultModelForProvider, getLlmProvider } from "./llm-provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmProvider) process.env.LLM_PROVIDER     ||= u.llmProvider;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.usdcMode !== undefined) process.env.USDC_MODE ||= String(u.usdcMode);

const DEFAULT_MODEL = getDefaultModelForProvider(getLlmProvider());

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl            ?? 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    maxVolatility:     u.maxVolatility     ?? 8,
    maxPriceChangePct: u.maxPriceChangePct ?? 300,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    athTopThresholdPct: u.athTopThresholdPct ?? 90,
    minTokenAgeHours:  u.minTokenAgeHours  ?? null, // null = no minimum (token age from GMGN creation_timestamp)
    maxTokenAgeHours:  u.maxTokenAgeHours  ?? null, // null = no maximum
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 5,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    emergencyPriceDropPct: u.emergencyPriceDropPct ?? -50,
    stopLossPct:           u.stopLossPct ?? -20,
    takeProfitFeePct:      u.takeProfitFeePct ?? 5,
    trailingTakeProfit:    u.trailingTakeProfit ?? true,
    trailingTriggerPct:    u.trailingTriggerPct ?? 3,
    trailingDropPct:       u.trailingDropPct ?? 1.5,
    minSolToOpen:          getEffectiveMinSolToOpen({
      minSolToOpen: u.minSolToOpen ?? 0.55,
      deployAmountSol: u.deployAmountSol ?? 0.5,
      gasReserve: u.gasReserve ?? 0.2,
    }),
    deployAmountSol:       u.deployAmountSol ?? 0.5,
    gasReserve:            u.gasReserve        ?? 0.2,   // always keep this much SOL for gas
    positionSizePct:       u.positionSizePct   ?? 0.35,  // % of deployable capital per position
    pnlUnit:               u.pnlUnit           ?? "sol", // "sol" or "usd" — how PnL is displayed
    priorityFeeLevel:      u.priorityFeeLevel  ?? "Medium",
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    activeStrategy: u.activeStrategy ?? "evil_panda",
    strategy:   u.strategy   ?? "spot",
    binsBelow:  u.binsBelow  ?? 69,  // activeBin - 69 to activeBin = 70 bins total (program max)
    evilPanda: {
      minTokenVolume24h: u.evilPandaMinTokenVolume24h ?? 750_000,
      minMcap: u.evilPandaMinMcap ?? 200_000,
      priceRangePct: u.evilPandaPriceRangePct ?? 80,
    },
  },

  // ─── USDC Mode ──────────────────────────
  // When enabled, the agent holds capital in USDC. On entry it swaps the
  // configured USD amount into SOL and LPs single-sided (bid_ask); on exit
  // it settles all recovered tokens + surplus SOL back to USDC, keeping only
  // a small native-SOL buffer for gas. Pools are still SOL-quoted; USDC is
  // just the home/accounting currency.
  usdc: {
    enabled:         u.usdcMode ?? (process.env.USDC_MODE === "true"),
    deployAmountUsd: u.deployAmountUsd ?? 50,    // USD deployed per position
    maxDeployUsd:    u.maxDeployUsd    ?? 500,   // hard per-position USD cap
    minUsdcToOpen:   u.minUsdcToOpen   ?? (u.deployAmountUsd ?? 50), // min USDC to start screening
    gasReserveSol:   u.gasReserveSol   ?? 0.2,   // native SOL kept for gas (hard floor — enforced in swapToken + settle; matches upstream)
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin: u.managementIntervalMin ?? 10,
    screeningIntervalMin:  u.screeningIntervalMin  ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
    pnlWatcherIntervalSec: u.pnlWatcherIntervalSec ?? 30,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps: u.maxSteps ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? DEFAULT_MODEL,
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? DEFAULT_MODEL,
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? DEFAULT_MODEL,
    managementFallbackModel: u.managementFallbackModel ?? null,
    screeningFallbackModel:  u.screeningFallbackModel  ?? null,
    generalFallbackModel:    u.generalFallbackModel    ?? null,
  },

  memory: {
    nuggetsFirst: u.memoryNuggetsFirst ?? true,
  },

  // ─── Web UI ───────────────────────────
  web: {
    port: parseInt(u.webPort || process.env.WEB_PORT || "3737", 10),
  },

  // ─── Darwinian Signal Weighting ─────────
  darwin: {
    enabled: u.darwinianWeights ?? false,
    windowDays: u.darwinianWindowDays ?? 60,
    boostFactor: u.darwinianBoostFactor ?? 1.05,
    decayFactor: u.darwinianDecayFactor ?? 0.95,
    weightFloor: u.darwinianWeightFloor ?? 0.3,
    weightCeiling: u.darwinianWeightCeiling ?? 2.5,
    minSamples: u.darwinianMinSamples ?? 10,
    perSignalMinSamples: u.darwinianPerSignalMinSamples ?? 12,
    minAbsLiftToAdjust: u.darwinianMinAbsLiftToAdjust ?? 0.05,
    strongLiftThreshold: u.darwinianStrongLiftThreshold ?? 0.2,
    calibrationMinSamples: u.darwinianCalibrationMinSamples ?? 20,
    meanReversionRate: u.darwinianMeanReversionRate ?? 0.02,
  },

  // ─── Autoresearch (ATLAS-inspired prompt optimization) ─────
  autoresearch: {
    enabled: u.autoresearch ?? false,
    minClosesPerTrial: u.autoresearchMinCloses ?? 7,
    minEvidenceCloses: u.autoresearchMinEvidenceCloses ?? Math.max(10, (u.autoresearchMinCloses ?? 7) + 2),
    minAttributedLosses: u.autoresearchMinAttributedLosses ?? 3,
    minAbsoluteWinRateDeltaPct: u.autoresearchMinAbsoluteWinRateDeltaPct ?? 10,
    minAbsolutePnlDeltaPct: u.autoresearchMinAbsolutePnlDeltaPct ?? 0.5,
    improvementPct: u.autoresearchImprovementPct ?? 15,
    declinePct: u.autoresearchDeclinePct ?? 15,
    cooldownCloses: u.autoresearchCooldownCloses ?? 5,
    llmModel: u.autoresearchModel ?? DEFAULT_MODEL,
    reasoningEffort: u.autoresearchReasoningEffort ?? "medium",
  },

  // ─── Knowledge Base ─────────────��──────
  knowledgeBase: {
    enabled:                   u.knowledgeBase?.enabled ?? true,
    dir:                       u.knowledgeBase?.dir ?? "./knowledge",
    autoFile:                  u.knowledgeBase?.autoFile ?? true,
    healthCheckIntervalHours:  u.knowledgeBase?.healthCheckIntervalHours ?? 12,
    maxArticles:               u.knowledgeBase?.maxArticles ?? 500,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
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

// Keys that map into each config section
const SECTION_MAP = {
  screening: new Set(Object.keys(config.screening)),
  management: new Set(Object.keys(config.management)),
  risk: new Set(Object.keys(config.risk)),
  schedule: new Set(Object.keys(config.schedule)),
  strategy: new Set(Object.keys(config.strategy)),
  llm: new Set(Object.keys(config.llm)),
  memory: new Set(Object.keys(config.memory)),
  knowledgeBase: new Set(Object.keys(config.knowledgeBase)),
  research: config.research ? new Set(Object.keys(config.research)) : new Set(),
};

// Keys that no caller may change
const LOCKED_KEYS = new Set(["walletKey", "rpcUrl", "llmModel"]);

// Keys that atlas_autotune may NOT change (cadence / owner-level)
const ATLAS_DISALLOWED = new Set([
  "managementIntervalMin",
  "healthCheckIntervalMin",
  "pnlWatcherIntervalSec",
]);

// Keys whose values should be rounded to the nearest integer
const INTEGER_KEYS = new Set([
  "minTvl", "maxTvl", "minVolume", "minOrganic", "minHolders",
  "minMcap", "maxMcap", "minBinStep", "maxBinStep", "maxVolatility",
  "maxPriceChangePct", "minTokenFeesSol", "athTopThresholdPct",
  "maxTop10Pct", "maxBundlersPct",
  "outOfRangeBinsToClose", "outOfRangeWaitMinutes",
  "emergencyPriceDropPct", "stopLossPct", "takeProfitFeePct",
  "maxPositions", "maxDeployAmount",
  "managementIntervalMin", "screeningIntervalMin",
  "healthCheckIntervalMin", "pnlWatcherIntervalSec",
  "maxTokens", "maxSteps",
]);

function findSection(key) {
  for (const [name, keys] of Object.entries(SECTION_MAP)) {
    if (keys.has(key)) return name;
  }
  return null;
}

/**
 * Apply a set of config changes to the in-memory config and persist them
 * to user-config.json.  Returns { success, applied, normalized, rejected }.
 */
export function applyConfigChanges({ changes = {}, source = "manual", reason = "" } = {}) {
  const applied = {};
  const normalized = {};
  const rejected = { locked: {}, atlas_disallowed: {}, unknown: {} };

  for (const [key, value] of Object.entries(changes)) {
    // Block locked keys
    if (LOCKED_KEYS.has(key)) {
      rejected.locked[key] = value;
      continue;
    }

    // Block atlas-disallowed keys when source is atlas_autotune
    if (source === "atlas_autotune" && ATLAS_DISALLOWED.has(key)) {
      rejected.atlas_disallowed[key] = value;
      continue;
    }

    const section = findSection(key);
    if (!section) {
      rejected.unknown[key] = value;
      continue;
    }

    // Normalize
    let final = value;
    if (INTEGER_KEYS.has(key) && typeof value === "number") {
      final = Math.round(value);
    }

    config[section][key] = final;
    applied[key] = final;
    if (final !== value) normalized[key] = final;
  }

  // Persist applied changes to user-config.json
  if (Object.keys(applied).length > 0) {
    try {
      const existing = fs.existsSync(USER_CONFIG_PATH)
        ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
        : {};
      Object.assign(existing, applied);
      fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(existing, null, 2));
    } catch { /* best effort */ }
  }

  // Clean up empty rejection buckets
  for (const bucket of Object.keys(rejected)) {
    if (Object.keys(rejected[bucket]).length === 0) delete rejected[bucket];
  }

  return {
    success: Object.keys(applied).length > 0,
    applied,
    normalized,
    rejected,
  };
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return;
  try {
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         != null) s.maxTvl         = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.maxVolatility  != null) s.maxVolatility  = fresh.maxVolatility;
    if (fresh.maxPriceChangePct != null) s.maxPriceChangePct = fresh.maxPriceChangePct;
    if (fresh.timeframe      != null) s.timeframe      = fresh.timeframe;
    if (fresh.category       != null) s.category       = fresh.category;
    if (fresh.athTopThresholdPct != null) s.athTopThresholdPct = fresh.athTopThresholdPct;
    if (fresh.minTokenAgeHours !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    // Also reload management thresholds that evolution may have changed
    const m = config.management;
    if (fresh.stopLossPct           != null) m.stopLossPct           = fresh.stopLossPct;
    if (fresh.takeProfitFeePct      != null) m.takeProfitFeePct      = fresh.takeProfitFeePct;
    if (fresh.outOfRangeWaitMinutes != null) m.outOfRangeWaitMinutes = fresh.outOfRangeWaitMinutes;
  } catch { /* ignore */ }
}
