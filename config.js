import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getEffectiveMinSolToOpen, normalizeScreeningSource } from "./runtime-helpers.js";
import { getDefaultModelForProvider, getLlmProvider } from "./llm-provider.js";
import { computePortfolioSol } from "./portfolio-value.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// MERIDIAN_USER_CONFIG_PATH lets tests point every reader/writer at a temp file.
export const USER_CONFIG_PATH = process.env.MERIDIAN_USER_CONFIG_PATH || path.join(__dirname, "user-config.json");
// MERIDIAN_GMGN_CONFIG_PATH lets tests point the gmgn-config.json reader/writer at a temp file.
export const GMGN_CONFIG_PATH = process.env.MERIDIAN_GMGN_CONFIG_PATH || path.join(__dirname, "gmgn-config.json");

function readJsonIfExists(filePath) {
  return fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf8"))
    : {};
}

const u = readJsonIfExists(USER_CONFIG_PATH);
const gmgnUserConfig = readJsonIfExists(GMGN_CONFIG_PATH);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmProvider) process.env.LLM_PROVIDER     ||= u.llmProvider;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
// True when DRY_RUN came from the environment (.env), which wins over user-config dryRun at startup.
export const DRY_RUN_SET_IN_ENV = process.env.DRY_RUN !== undefined;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.usdcMode !== undefined) process.env.USDC_MODE ||= String(u.usdcMode);
if (gmgnUserConfig.apiKey || u.gmgnApiKey) {
  process.env.GMGN_API_KEY ||= gmgnUserConfig.apiKey || u.gmgnApiKey;
}

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

const DEFAULT_MODEL = getDefaultModelForProvider(getLlmProvider());

// Numeric keys where an explicit null disables the guard (so `??` can't be used).
const nullable = (key, fallback) => (u[key] !== undefined ? u[key] : fallback);

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    source:            normalizeScreeningSource(u.screeningSource), // "meteora" | "gmgn" | "both"; invalid → "meteora"
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

  // ─── GMGN Screening (opt-in via screening.source = "gmgn" or "both") ─
  // Sourced from gmgn-config.json (preferred), then legacy user-config.json
  // keys (gmgn*), then defaults. See gmgn-config.example.json for the schema.
  gmgn: {
    apiKey: nonEmptyString(gmgnUserConfig.apiKey, u.gmgnApiKey, process.env.GMGN_API_KEY),
    // Stage-1 (trending rank) controls
    interval:    gmgnValue("interval",    "gmgnInterval",    "5m"),
    orderBy:     gmgnValue("orderBy",     "gmgnOrderBy",     "volume"),
    direction:   gmgnValue("direction",   "gmgnDirection",   "desc"),
    limit:       gmgnValue("limit",       "gmgnLimit",       100),
    enrichLimit: gmgnValue("enrichLimit", "gmgnEnrichLimit", 20),
    filters:     gmgnArray("filters",   "gmgnFilters",   ["renounced", "frozen", "not_wash_trading"]),
    platforms:   gmgnArray("platforms", "gmgnPlatforms", ["Pump.fun", "meteora_virtual_curve", "pool_meteora"]),
    // Stage-1 basic filters (trending row)
    minMcap:          gmgnValue("minMcap",          "gmgnMinMcap",          150_000),
    maxMcap:          gmgnValue("maxMcap",          "gmgnMaxMcap",          10_000_000),
    maxBundlerRate:   gmgnValue("maxBundlerRate",   "gmgnMaxBundlerRate",   0.5),
    minTokenAgeHours: gmgnValue("minTokenAgeHours", "gmgnMinTokenAgeHours", 2),
    maxTokenAgeHours: gmgnValue("maxTokenAgeHours", "gmgnMaxTokenAgeHours", 24 * 7),
    minVolume:        gmgnValue("minVolume",        "gmgnMinVolume",        1000),
    minTvl:           gmgnValue("minTvl",           "gmgnMinTvl",           u.minTvl ?? 10_000),
    // Stage-2 token-info filters
    minHolders:          gmgnValue("minHolders",          "gmgnMinHolders",          1000),
    minTotalFeeSol:      gmgnValue("minTotalFeeSol",      "gmgnMinTotalFeeSol",      30),
    maxTop10HolderRate:  gmgnValue("maxTop10HolderRate",  "gmgnMaxTop10HolderRate",  0.5),
    maxDevTeamHoldRate:  gmgnValue("maxDevTeamHoldRate",  "gmgnMaxDevTeamHoldRate",  0.02),
    maxBotDegenRate:     gmgnValue("maxBotDegenRate",     "gmgnMaxBotDegenRate",     0.4),
    maxFreshWalletRate:  gmgnValue("maxFreshWalletRate",  "gmgnMaxFreshWalletRate",  0.2),
    maxRatTraderRate:    gmgnValue("maxRatTraderRate",    "gmgnMaxRatTraderRate",    0.2),
    athFilterPct:        gmgnValue("athFilterPct",        "gmgnAthFilterPct",        null),
    // Optional Stage-1/2 gates (read from trending row where available)
    minSmartDegenCount:  gmgnValue("minSmartDegenCount",  "gmgnMinSmartDegenCount",  1),
    requireKol:          gmgnValue("requireKol",          "gmgnRequireKol",          true),
    minKolCount:         gmgnValue("minKolCount",         "gmgnMinKolCount",         1),
    maxRugRatio:         gmgnValue("maxRugRatio",         "gmgnMaxRugRatio",         0.3),
    maxSniperCount:      gmgnValue("maxSniperCount",      "gmgnMaxSniperCount",      20),
    // Stage-3 holders/traders enrichment + KOL config
    holdersLimit:           gmgnValue("holdersLimit",           "gmgnHoldersLimit",           100),
    maxSniperHoldRate:      gmgnValue("maxSniperHoldRate",      "gmgnMaxSniperHoldRate",      0.3),
    preferredKolNames:      gmgnArray("preferredKolNames",      "gmgnPreferredKolNames",      []),
    preferredKolMinHoldPct: gmgnValue("preferredKolMinHoldPct", "gmgnPreferredKolMinHoldPct", 1),
    dumpKolNames:           gmgnArray("dumpKolNames",           "gmgnDumpKolNames",           []),
    dumpKolMinHoldPct:      gmgnValue("dumpKolMinHoldPct",      "gmgnDumpKolMinHoldPct",      0.5),
    // Stage-4 indicator filter (reuses local fetchGmgnPriceInfo().candles)
    indicatorFilter: gmgnValue("indicatorFilter", "gmgnIndicatorFilter", true),
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
    positionSizeBase:      u.positionSizeBase  ?? "total", // "total" (wallet SOL + open DLMM positions) or "wallet" (free SOL only)
    pnlUnit:               u.pnlUnit           ?? "sol", // "sol" or "usd" — how PnL is displayed
    priorityFeeLevel:      u.priorityFeeLevel  ?? "Medium",
  },

  // ─── Entry-safety filters ───────────────
  // Hard entry guards applied in screening, the token lookup card and
  // deployPosition. The user loosens them (Telegram "🛡 Entry filters" or this
  // file); the LLM's update_config may only tighten them.
  entryFilters: {
    blockTransferFeeAbovePct: nullable("blockTransferFeeAbovePct", 1.0), // Token-2022 transfer fee %, null = off
    blockTransferHook:        u.blockTransferHook        ?? true,
    blockPermanentDelegate:   u.blockPermanentDelegate   ?? true,
    blockFreezeAuthority:     u.blockFreezeAuthority     ?? true, // also default-account-state frozen
    blockMintAuthority:       u.blockMintAuthority       ?? false,
    blockPausable:            u.blockPausable            ?? true,
    blockNonTransferable:     u.blockNonTransferable     ?? true,
    // Only enter pools whose CollectFeeMode pays LP fees in SOL (OnlyY, SOL = token Y).
    solFeePoolsOnly:          u.solFeePoolsOnly          ?? false,
    // Don't open bid_ask when price is > N% above the on-chain oracle TWAP; null = off.
    twapSpikeMaxPct:          nullable("twapSpikeMaxPct", 15),
    twapWindowMinutes:        u.twapWindowMinutes        ?? 60,
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
    // Codex agent-loop reasoning effort for every role (low|medium|high|xhigh).
    // null keeps the per-role default: MANAGER high, others medium.
    reasoningEffort: u.llmReasoningEffort ?? null,
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

  // ─── Autoresearch (prompt A/B experiments, after karpathy/autoresearch) ─────
  autoresearch: {
    enabled: u.autoresearch ?? false,
    // Concurrent A/B verdict: control vs candidate arms, size-weighted mean PnL,
    // seeded bootstrap 95% CI. Keep only if CI lower bound > 0 AND effect >= minEffectPct.
    minClosesPerArm: u.autoresearchMinClosesPerArm ?? 100,
    minEffectPct: u.autoresearchMinEffectPct ?? 1.5,          // percentage points of mean PnL
    maxExperimentDays: u.autoresearchMaxExperimentDays ?? 14, // cap: inconclusive, candidate discarded
    autoKeep: u.autoresearchAutoKeep ?? false,                // false = a passing candidate becomes a pending proposal
    minAttributedLosses: u.autoresearchMinAttributedLosses ?? 3,
    cooldownCloses: u.autoresearchCooldownCloses ?? 5,
    llmModel: u.autoresearchModel ?? DEFAULT_MODEL,
    reasoningEffort: u.autoresearchReasoningEffort ?? "medium",
    maxDiffPct: u.autoresearchMaxDiffPct ?? 30, // reject candidates that change more than this % of lines
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

/** "total" unless positionSizeBase is "wallet" (case-insensitive). */
export function getPositionSizeBase() {
  return String(config.management.positionSizeBase ?? "total").toLowerCase() === "wallet" ? "wallet" : "total";
}

// Round half-up to 2 dp; the epsilon absorbs float noise (0.55 × 1.1 = 0.6049…).
const round2 = (x) => Math.round(Number(x) * 100 + 1e-6) / 100;
// Round DOWN to 2 dp; the epsilon absorbs float noise (1.2 − 0.1 = 1.0999…).
const floor2 = (x) => Math.floor(Number(x) * 100 + 1e-6) / 100;
const fmtSol = (x) => Number(x).toFixed(2);
const fmtPct = (p) => `${parseFloat((Number(p) * 100).toFixed(1))}%`;

/**
 * Deploy size (pure). `portfolio` is computePortfolioSol()'s result, or null.
 *
 *   base   = total SOL (free wallet SOL + open DLMM positions incl. unclaimed
 *            fees) when positionSizeBase is "total" and the total is known;
 *            otherwise free wallet SOL (the conservative fallback)
 *   size   = min(maxDeployAmount, positionSizePct × max(0, base − gasReserve))
 *   amount = min(round2(size), floor2(max(0, freeSol − gasReserve)))  ← never more than deployable SOL
 *   amount < deployAmountSol (the floor) → amount 0 + skip reason; the floor is never forced
 *
 * The floor is min(deployAmountSol, maxDeployAmount) so a floor above the
 * ceiling can't block every deploy. Returns { amount, skip, reason, label,
 * basis, preferredBasis, fallbackReason, baseSol, freeSol, size, cap, floor,
 * ceil, pct, reserve }.
 */
export function computeDeploySizing(walletSol, portfolio = null) {
  const reserve = Number(config.management.gasReserve ?? 0.2);
  const pct     = Number(config.management.positionSizePct ?? 0.35);
  const ceil    = Number(config.risk.maxDeployAmount);
  const floor   = Math.min(Number(config.management.deployAmountSol), ceil);
  const preferredBasis = getPositionSizeBase();
  const common = { preferredBasis, pct, reserve, floor, ceil };

  const freeSol = Number(walletSol);
  if (walletSol == null || !Number.isFinite(freeSol) || freeSol < 0) {
    const reason = "free wallet SOL unknown";
    return { ...common, amount: 0, skip: true, reason, label: `skip: ${reason}`, basis: null, fallbackReason: null, baseSol: null, freeSol: null, size: 0, cap: 0 };
  }

  const useTotal = preferredBasis === "total" && portfolio?.ok === true && Number.isFinite(Number(portfolio.totalSol));
  const basis = useTotal ? "total" : "wallet";
  const fallbackReason = preferredBasis === "total" && !useTotal ? (portfolio?.reason || "portfolio total not provided") : null;
  const baseSol = useTotal ? Number(portfolio.totalSol) : freeSol;

  const raw  = pct * Math.max(0, baseSol - reserve);
  const size = Math.min(ceil, raw);
  const cap  = Math.max(0, freeSol - reserve);
  const capAmt = floor2(cap);
  const amount = Math.min(round2(size), capAmt);

  const of = `${fmtPct(pct)} of (${fmtSol(baseSol)} SOL ${basis === "total" ? "total" : "free wallet"} − ${reserve} reserve)`;
  let why;
  if (round2(size) > capAmt) why = `free SOL ${fmtSol(freeSol)} − ${reserve} reserve (cap; ${of} = ${fmtSol(size)})`;
  else if (raw > ceil) why = `max ${ceil} (${of} = ${fmtSol(raw)})`;
  else why = of;
  const note = fallbackReason ? ` [wallet basis: ${fallbackReason}]` : "";

  if (amount + 1e-9 < floor || !(amount > 0)) {
    const reason = `size ${fmtSol(amount)} below floor ${floor} (${why})${note}`;
    return { ...common, amount: 0, skip: true, reason, label: `skip: ${reason}`, basis, fallbackReason, baseSol, freeSol, size, cap };
  }
  return { ...common, amount, skip: false, reason: null, label: `${fmtSol(amount)} SOL = ${why}${note}`, basis, fallbackReason, baseSol, freeSol, size, cap };
}

/**
 * Deploy size from live data. Pass `wallet` (getWalletBalances() result)
 * and/or `positions` (getMyPositions() result) when the caller already has
 * them; anything left undefined is fetched (getMyPositions is cached 5 min and
 * invalidated on deploy/close). positions are only needed on the "total" basis.
 * A failed/unknown valuation falls back to the free-wallet basis and is logged.
 */
export async function resolveDeploySizing({ wallet, positions } = {}) {
  let w = wallet;
  if (w === undefined) {
    w = await import("./tools/wallet.js").then((m) => m.getWalletBalances()).catch((e) => ({ error: e.message }));
  }
  if (!w || w.error) {
    const s = computeDeploySizing(null);
    const reason = `wallet balance unavailable${w?.error ? ` (${w.error})` : ""}`;
    return { ...s, reason, label: `skip: ${reason}` };
  }
  let portfolio = null;
  if (getPositionSizeBase() === "total") {
    let pr = positions;
    if (pr === undefined) {
      pr = await import("./tools/dlmm.js").then((m) => m.getMyPositions()).catch((e) => ({ error: e.message }));
    }
    portfolio = computePortfolioSol({ walletSol: w.sol, wallet: w, positionsResult: pr });
  }
  const s = computeDeploySizing(Number(w.sol), portfolio);
  const { log } = await import("./logger.js");
  if (s.fallbackReason) log("sizing_warn", `Portfolio total unknown (${s.fallbackReason}) — sizing from free wallet SOL instead`);
  log("sizing", s.label);
  return s;
}

/**
 * Deploy amount (SOL) for a free wallet balance, 0 when sizing skips.
 * Sync, so without a `portfolio` it sizes on the free-wallet basis; live
 * callers use resolveDeploySizing() for the portfolio total.
 */
export function computeDeployAmount(walletSol, portfolio = null) {
  return computeDeploySizing(walletSol, portfolio).amount;
}

// Keys that map into each config section
const SECTION_MAP = {
  screening: new Set(Object.keys(config.screening)),
  gmgn: new Set(Object.keys(config.gmgn)),
  management: new Set(Object.keys(config.management)),
  risk: new Set(Object.keys(config.risk)),
  schedule: new Set(Object.keys(config.schedule)),
  strategy: new Set(Object.keys(config.strategy)),
  llm: new Set(Object.keys(config.llm)),
  knowledgeBase: new Set(Object.keys(config.knowledgeBase)),
  research: config.research ? new Set(Object.keys(config.research)) : new Set(),
};

// Keys that no caller may change
export const LOCKED_KEYS = new Set(["walletKey", "rpcUrl", "llmModel"]);

// Keys that atlas_autotune may NOT change (cadence / owner-level)
const ATLAS_DISALLOWED = new Set([
  "managementIntervalMin",
  "healthCheckIntervalMin",
  "pnlWatcherIntervalSec",
]);

// Keys whose values should be rounded to the nearest integer
export const INTEGER_KEYS = new Set([
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
 * Merge `changes` into user-config.json (read, Object.assign, write with
 * 2-space JSON), keeping every other key. The one write path shared by
 * update_config and the Telegram entry-filter toggles. Throws on failure.
 */
export function persistUserConfig(changes, extra = {}) {
  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /**/ }
  }
  Object.assign(userConfig, changes, extra);
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));
  return userConfig;
}

/**
 * Merge `changes` into gmgn-config.json (same read / Object.assign / 2-space
 * JSON write as persistUserConfig), keeping every other key. Throws on failure,
 * including an unparsable existing file.
 */
export function persistGmgnConfig(changes) {
  let gmgnConfig = {};
  if (fs.existsSync(GMGN_CONFIG_PATH)) {
    // An unreadable file is an error, not {}: rewriting it would drop the API key.
    gmgnConfig = JSON.parse(fs.readFileSync(GMGN_CONFIG_PATH, "utf8"));
  }
  Object.assign(gmgnConfig, changes);
  fs.writeFileSync(GMGN_CONFIG_PATH, JSON.stringify(gmgnConfig, null, 2));
  return gmgnConfig;
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
  try {
    const fresh = readJsonIfExists(USER_CONFIG_PATH);
    const s = config.screening;
    if (fresh.screeningSource != null) s.source = normalizeScreeningSource(fresh.screeningSource);
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
  // Refresh GMGN screening keys from gmgn-config.json (mirrors the gmgn block above)
  try {
    const freshGmgn = readJsonIfExists(GMGN_CONFIG_PATH);
    const g = config.gmgn;
    for (const [key, value] of Object.entries(freshGmgn)) {
      if (key in g && key !== "apiKey") g[key] = value;
    }
    if (freshGmgn.apiKey) g.apiKey = freshGmgn.apiKey;
  } catch { /* ignore */ }
}
