import fs from "fs";
import { isTruthyDryRun } from "./env-flags.js";
import path from "path";
import { fileURLToPath } from "url";
import { writeJsonAtomicSync } from "./atomic-write.js";
import { getEffectiveMinSolToOpen, normalizeScreeningSource, worstCaseDeployOverheadSol } from "./runtime-helpers.js";
import { getDefaultModelForProvider, getLlmProvider } from "./llm-provider.js";
import { computePortfolioSol } from "./portfolio-value.js";
import { BY_KEY, GOVERNED_KEYS, makeResolver, normalizeProfile, PROFILE_NAMES } from "./settings-schema.js";
import { userConfigPath, gmgnConfigPath } from "./config-paths.js";
import { migrateLegacyBookkeeping } from "./config-state.js";
import { syncWalletLockFromConfig } from "./wallet-lock.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// MERIDIAN_USER_CONFIG_PATH lets tests point every reader/writer at a temp file.
export const USER_CONFIG_PATH = userConfigPath();
// MERIDIAN_GMGN_CONFIG_PATH lets tests point the gmgn-config.json reader/writer at a temp file.
export const GMGN_CONFIG_PATH = gmgnConfigPath();

function readJsonIfExists(filePath) {
  return fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf8"))
    : {};
}

// `_last*` bookkeeping moved to config-state.json; this is a no-op once migrated.
migrateLegacyBookkeeping(USER_CONFIG_PATH);

const u = readJsonIfExists(USER_CONFIG_PATH);
const gmgnUserConfig = readJsonIfExists(GMGN_CONFIG_PATH);

/** Deprecation / precedence warnings collected at boot (also printed once). Shown by `npm run settings`. */
export const CONFIG_WARNINGS = [];
function warn(msg) {
  CONFIG_WARNINGS.push(msg);
  console.warn(`[config] ${msg}`);
}

// ─── Precedence ───────────────────────────────────────────────────
//  * Secrets (WALLET_PRIVATE_KEY, RPC_URL, GMGN_API_KEY): .env wins; the old
//    user-config.json copies still work for one release, with a warning.
//  * Everything else: user-config.json (= what Telegram edits) wins over a stale
//    .env value. The old env names (DRY_RUN, USDC_MODE, LLM_PROVIDER, LLM_MODEL,
//    WEB_PORT) are only a fallback when user-config.json has no value, with a warning.
//    Downstream code reads process.env.DRY_RUN etc., so the RESOLVED value is
//    written back to process.env (overwriting the stale one).
if (u.rpcUrl) {
  if (!process.env.RPC_URL) warn("rpcUrl in user-config.json is deprecated; put RPC_URL in .env (secrets belong in .env only).");
  process.env.RPC_URL ||= u.rpcUrl;
}
if (u.walletKey) {
  if (!process.env.WALLET_PRIVATE_KEY) warn("walletKey in user-config.json is deprecated; put WALLET_PRIVATE_KEY in .env.");
  process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
}
if (!process.env.GMGN_API_KEY && (gmgnUserConfig.apiKey || u.gmgnApiKey)) {
  warn("GMGN api key in gmgn-config.json / user-config.json is deprecated; put GMGN_API_KEY in .env.");
}
// True when DRY_RUN=true is in the environment (`npm run dev`, a .env line, a service unit). That is the ONE
// env value that still beats user-config.json, because it can only make the bot safer: it forces dry run for
// this process. DRY_RUN=false in the environment never overrides a dry-run user-config.
export const DRY_RUN_SET_IN_ENV = isTruthyDryRun(process.env.DRY_RUN);

const ENV_FALLBACKS = [
  ["dryRun", "DRY_RUN", (v) => isTruthyDryRun(v)],
  ["usdcMode", "USDC_MODE", (v) => String(v) === "true"],
  ["llmProvider", "LLM_PROVIDER", (v) => v],
  ["llmModel", "LLM_MODEL", (v) => v],
  ["webPort", "WEB_PORT", (v) => parseInt(v, 10)],
];
for (const [key, envName, parse] of ENV_FALLBACKS) {
  const envVal = process.env[envName];
  if (key === "dryRun" && DRY_RUN_SET_IN_ENV) {
    if (u.dryRun === false) warn("DRY_RUN=true in the environment forces DRY RUN for this run; user-config.json dryRun=false is NOT used while it is set. Unset DRY_RUN (or remove it from .env) to go live.");
    else if (u.dryRun === undefined) warn("DRY_RUN in .env is deprecated (used as a fallback for one more release). Set dryRun in user-config.json or Telegram instead.");
    u.dryRun = true;
    process.env.DRY_RUN = "true";
    continue;
  }
  if (u[key] !== undefined && u[key] !== null) {
    if (envVal !== undefined && String(envVal) !== String(u[key])) {
      warn(`${envName}=${envVal} in .env is ignored: user-config.json ${key}=${u[key]} wins. Remove ${envName} from .env.`);
    }
    process.env[envName] = String(u[key]);
  } else if (envVal !== undefined && envVal !== "") {
    warn(`${envName} in .env is deprecated (used as a fallback for one more release). Set ${key} in user-config.json or Telegram instead.`);
    u[key] = parse(envVal);
    if (key === "dryRun") process.env.DRY_RUN = u.dryRun ? "true" : "false"; // normalize: downstream readers see exactly true/false
  }
}
if (u.profile !== undefined && !PROFILE_NAMES.includes(String(u.profile).toLowerCase())) {
  warn(`unknown profile "${u.profile}" in user-config.json; treating it as "custom".`);
}

const R = makeResolver(u);
const S = (key) => R.get(key);
/** Where an effective value came from: "user" | "profile" | "default". */
export const settingSource = (key) => {
  try { return makeResolver(readJsonIfExists(USER_CONFIG_PATH)).source(key); } catch { return R.source(key); }
};

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

// Every plain setting below is read through the schema (settings-schema.js):
// user-config.json value > active profile preset > schema default.
export const config = {
  // Active profile: "conservative" | "balanced" | "degen" | "custom" (custom = user-config.json only).
  profile: R.profile,

  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    S("maxPositions"),
    maxDeployAmount: S("maxDeployAmount"),
    // Refuse a swap whose quoted price impact is above this (%): agent swap_token,
    // deploy auto-swap, USDC entry (wallet.js swapToken).
    maxSwapPriceImpactPct: S("maxSwapPriceImpactPct"),
    // Looser cap for post-close swap-backs (close-swap.js, sync-close, USDC settle):
    // leaving the withdrawn bag is worse than the slippage. Owner-only (not in update_config).
    maxCloseSwapPriceImpactPct: S("maxCloseSwapPriceImpactPct"),
  },

  // ─── Deploy-path safety (ported from yunus-0x/meridian) ─────────
  // Pure guards: they only ever REFUSE a deploy, never change what is sent.
  safety: {
    // Re-check TVL / volume / fee-ratio / volatility / token thresholds against a
    // fresh Pool Discovery read at deploy time (fails closed if unreadable).
    recheckScreeningAtDeploy: S("recheckScreeningAtDeploy"),
    // Refuse a deploy when the pool's volatility is unknown (null/NaN). 0 is valid
    // (every trade stayed inside one bin).
    requireKnownVolatility: S("requireKnownVolatility"),
    // Max price move (%) between the start of a deploy and the first tx send.
    // DROP-ONLY for SOL-only deposits (a rise leaves the bins below the active
    // bin, harmless); symmetric when a token X leg is deposited (two-sided).
    maxEntryPriceMovePct: S("maxEntryPriceMovePct"),
    // Max price DROP (%) between the price shown at screening and the fresh pool
    // price at deploy time (the minutes-long screening -> LLM -> deploy gap).
    // Rises are logged, never refused. 0 disables. Skipped when screening.source
    // is "gmgn" (different price source) or no Pool Discovery screening price exists.
    maxScreenToDeployDropPct: S("maxScreenToDeployDropPct"),
    // Deposit slippage (%) handed to the DLMM SDK. The SDK converts it to an
    // allowed active-bin drift: ceil(pct / (binStep/100)) bins. Was a hard-coded
    // 10%. See deploy-guards.js depositSlippage().
    depositSlippagePct: S("depositSlippagePct"),
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    source:            normalizeScreeningSource(S("screeningSource")), // "meteora" | "gmgn" | "both"; invalid → "meteora"
    minFeeActiveTvlRatio: S("minFeeActiveTvlRatio"),
    minTvl:            S("minTvl"),
    maxTvl:            S("maxTvl"),
    minVolume:         S("minVolume"),
    minOrganic:        S("minOrganic"),
    minHolders:        S("minHolders"),
    minMcap:           S("minMcap"),
    maxMcap:           S("maxMcap"),
    minBinStep:        S("minBinStep"),
    maxBinStep:        S("maxBinStep"),
    maxVolatility:     S("maxVolatility"),
    maxPriceChangePct: S("maxPriceChangePct"),
    timeframe:         S("timeframe"),
    category:          S("category"),
    feeDataDownRatio:  S("feeDataDownRatio"),   // share of candidates with a FAILED fee fetch that raises fee_data_down (once per outage)
    minTokenFeesSol:   S("minTokenFeesSol"),  // global fees paid (priority+jito tips). below = bundled/scam
    athTopThresholdPct: S("athTopThresholdPct"),
    minTokenAgeHours:  S("minTokenAgeHours"), // null = no minimum (token age from GMGN creation_timestamp)
    maxTokenAgeHours:  S("maxTokenAgeHours"), // null = no maximum
    gmgnSignalsEnabled: S("gmgnSignalsEnabled"), // GMGN market-signal feed (buy pressure / spikes) on candidates; informational
  },

  // ─── GMGN Screening (opt-in via screening.source = "gmgn" or "both") ─
  // Sourced from gmgn-config.json (preferred), then legacy user-config.json
  // keys (gmgn*), then defaults. See gmgn-config.example.json for the schema.
  // (Advanced tier: not profile-governed. The three keys nothing read — requireKol,
  // minKolCount, minSmartDegenCount — were removed.)
  gmgn: {
    apiKey: nonEmptyString(process.env.GMGN_API_KEY, gmgnUserConfig.apiKey, u.gmgnApiKey),
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
    maxRugRatio:         gmgnValue("maxRugRatio",         "gmgnMaxRugRatio",         0.3),
    maxSniperCount:      gmgnValue("maxSniperCount",      "gmgnMaxSniperCount",      20),
    // Reliability (tools/gmgn-policy.js): pacing plan, holders/traders finalist cap, and
    // whether Meteora-source candidates also run the GMGN safety gates (needs a GMGN key).
    plan:              gmgnValue("plan",              "gmgnPlan",              "free"),
    finalistLimit:     gmgnValue("finalistLimit",     "gmgnFinalistLimit",     5),
    // "shadow" (default: record gmgn_gate_would_drop, never drop) | "hard" | "off" (true/false accepted).
    gateMeteoraSource: gmgnValue("gateMeteoraSource", "gmgnGateMeteoraSource", "shadow"),
    // Separate thresholds for the Meteora-source gate (see METEORA_GATE_DEFAULTS in tools/gmgn-policy.js).
    meteoraGate:       (gmgnUserConfig.meteoraGate && typeof gmgnUserConfig.meteoraGate === "object") ? gmgnUserConfig.meteoraGate : {},
    outageMinCandidates: gmgnValue("outageMinCandidates", "gmgnOutageMinCandidates", 3),
    // Max GMGN weight the SHADOW Meteora-source gate may spend per cycle (hard mode is unbudgeted).
    meteoraShadowBudget: gmgnValue("meteoraShadowBudget", "gmgnMeteoraShadowBudget", 30),
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
        // Legacy key: dead code before (bb_lower never existed), so it stays log-only to preserve the
        // effective behavior of configs that set it true. Enforcement is the new explicit opt-in below.
        rejectAlreadyAtBottom:    r.rejectAlreadyAtBottom    ?? false,
        enforceAlreadyAtBottom:   r.enforceAlreadyAtBottom   ?? false,
        requireAboveSupertrend:   r.requireAboveSupertrend   ?? false,
        minRsi:                   r.minRsi                   ?? null,
        maxRsi:                   r.maxRsi                   ?? null,
        requireBbPosition:        r.requireBbPosition        ?? null,
      };
    })(),
  },

  // ─── Position Management ────────────────
  management: {
    outOfRangeWaitMinutes: S("outOfRangeWaitMinutes"),
    emergencyPriceDropPct: S("emergencyPriceDropPct"),
    stopLossPct:           S("stopLossPct"),
    takeProfitFeePct:      S("takeProfitFeePct"),
    trailingTakeProfit:    S("trailingTakeProfit"),
    trailingTriggerPct:    S("trailingTriggerPct"),
    trailingDropPct:       S("trailingDropPct"),
    minSolToOpen:          getEffectiveMinSolToOpen({
      minSolToOpen: S("minSolToOpen"),
      deployAmountSol: S("deployAmountSol"),
      gasReserve: S("gasReserve"),
    }),
    deployAmountSol:       S("deployAmountSol"),
    gasReserve:            S("gasReserve"),   // always keep this much SOL for gas
    positionSizePct:       S("positionSizePct"),  // % of deployable capital per position
    positionSizeBase:      S("positionSizeBase"), // "total" (wallet SOL + open DLMM positions) or "wallet" (free SOL only)
    pnlUnit:               S("pnlUnit"), // "sol" or "usd" — how PnL is displayed
    priorityFeeLevel:      S("priorityFeeLevel"),
  },

  // ─── Entry-safety filters ───────────────
  // Hard entry guards applied in screening, the token lookup card and
  // deployPosition. The user loosens them (Telegram "🛡 Entry filters" or this
  // file); the LLM's update_config may only tighten them.
  entryFilters: {
    blockTransferFeeAbovePct: S("blockTransferFeeAbovePct"), // Token-2022 transfer fee %, null = off
    blockTransferHook:        S("blockTransferHook"),
    blockPermanentDelegate:   S("blockPermanentDelegate"),
    blockFreezeAuthority:     S("blockFreezeAuthority"), // also default-account-state frozen
    blockMintAuthority:       S("blockMintAuthority"),
    blockPausable:            S("blockPausable"),
    blockNonTransferable:     S("blockNonTransferable"),
    // Only enter pools whose CollectFeeMode pays LP fees in SOL (OnlyY, SOL = token Y).
    solFeePoolsOnly:          S("solFeePoolsOnly"),
    // Don't open bid_ask when price is > N% above the on-chain oracle TWAP; null = off.
    twapSpikeMaxPct:          S("twapSpikeMaxPct"),
    twapWindowMinutes:        S("twapWindowMinutes"),
    // Jupiter Tokens API scam flag (audit.isSus present, or banned); lookup failure = allow.
    blockJupiterSuspicious:   S("blockJupiterSuspicious"), // off by default; the owner turns it on in Telegram
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    activeStrategy: S("activeStrategy"),
    maxRangePct: S("maxRangePct"), // deepest downside range any deploy may use (%), enforced in deploy_position
    // Range depth from candles (tools/ohlcv.js): "ohlcv" sizes price_range_pct from
    // max drawdown × ohlcvBufferMult + ATR slack and deploy_position widens to it;
    // "volatility" = the prompt's volatility table only.
    rangeDepthMode: S("rangeDepthMode"),
    ohlcvBufferMult: S("ohlcvBufferMult"),
    solanaTrackerDailyCap: S("solanaTrackerDailyCap"), // SolanaTracker fallback calls per UTC day (free-plan credits)
    ohlcvTiers: S("ohlcvTiers"), // token-age → candle timeframe tiers; null = DEFAULT_OHLCV_TIERS in tools/ohlcv.js
    strategy:   S("strategy"),
    binsBelow:  S("binsBelow"),  // activeBin - 69 to activeBin = 70 bins total (program max)
    evilPanda: {
      minTokenVolume24h: S("evilPandaMinTokenVolume24h"),
      minMcap: S("evilPandaMinMcap"),
      priceRangePct: S("evilPandaPriceRangePct"),
    },
  },

  // ─── USDC Mode ──────────────────────────
  // When enabled, the agent holds capital in USDC. On entry it swaps the
  // configured USD amount into SOL and LPs single-sided (bid_ask); on exit
  // it settles all recovered tokens + surplus SOL back to USDC, keeping only
  // a small native-SOL buffer for gas. Pools are still SOL-quoted; USDC is
  // just the home/accounting currency.
  // (usdcMode precedence: user-config.json wins over a stale USDC_MODE env var — see ENV_FALLBACKS above.)
  usdc: {
    enabled:         S("usdcMode"),
    deployAmountUsd: S("deployAmountUsd"),    // USD deployed per position
    maxDeployUsd:    S("maxDeployUsd"),   // hard per-position USD cap
    minUsdcToOpen:   S("minUsdcToOpen") ?? S("deployAmountUsd"), // min USDC to start screening
    gasReserveSol:   S("gasReserveSol"),   // native SOL kept for gas (hard floor — enforced in swapToken + settle; matches upstream)
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin: S("managementIntervalMin"),
    screeningIntervalMin:  S("screeningIntervalMin"),
    pnlWatcherIntervalSec: S("pnlWatcherIntervalSec"),
  },

  // ─── Exit safety (fix/exits-in-code) ────
  // Read-only from user-config.json; not exposed to update_config / auto-tune.
  exits: {
    // Consecutive confirming ticks before a PnL exit (stop loss, emergency,
    // trailing, take profit) closes, and before a new trailing peak counts.
    confirmTicks:              S("exitConfirmTicks"),
    peakConfirmTicks:          S("peakConfirmTicks") ?? S("exitConfirmTicks"),
    // Two ticks closer together than this count once (the management cycle and
    // the watcher can tick seconds apart on the same ~20s-cached on-chain read).
    confirmMinSpacingSec:      S("exitConfirmMinSpacingSec"),
    // Stop loss whose on-chain read keeps failing: exit on the API value once the
    // signal has persisted this long (and on >= confirmTicks priced ticks).
    // Default 300s (M5): with a 60s watcher that is 5 priced observations.
    stopLossUnverifiedMaxWaitSec: S("stopLossUnverifiedMaxWaitSec"),
    // N4: API-only fallback wait when every priced tick is at/below the emergency level.
    stopLossEmergencyMaxWaitSec: S("stopLossEmergencyMaxWaitSec"),
    // H1: force an on-chain PnL read for every tracked position at least this
    // often, even when the API reading looks harmless, so a stale API cannot
    // hide a crash the chain already shows.
    onchainReadIntervalSec:    S("onchainReadIntervalSec"),
    // M4: API-vs-on-chain disagreement (points) above which a trailing / take
    // profit exit is held (stop loss is exempt). Measured via pnl_bias logs.
    pnlMismatchPts:            S("pnlMismatchPts"),
    // Alert after this many consecutive ticks a trailing exit was held only
    // because the two sources disagree (trailing is effectively disabled).
    trailingMismatchAlertTicks: S("trailingMismatchAlertTicks"),
    // M1: wallet-lock stale-holder alert / hard release (seconds; 0 disables hard release).
    walletLockWarnSec:         S("walletLockWarnSec"),
    walletLockTimeoutSec:      S("walletLockTimeoutSec"),
    // M1: bound on a single on-chain / positions read inside the watcher.
    readTimeoutSec:            S("exitReadTimeoutSec"),
    // Re-entry cooldowns (pool + base mint), checked at deploy time.
    stopLossCooldownMinutes:   S("stopLossCooldownMinutes"),
    oorCooldownTriggerCount:   S("oorCooldownTriggerCount"),
    oorCooldownMinutes:        S("oorCooldownMinutes"),
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: S("temperature"),
    maxTokens:   S("maxTokens"),
    deepseekFallbackModel: S("deepseekFallbackModel"), // DeepSeek V4.1 Flash; used when the primary provider fails
    maxSteps: S("maxSteps"),
    managementModel: S("managementModel") ?? process.env.LLM_MODEL ?? DEFAULT_MODEL,
    screeningModel:  S("screeningModel")  ?? process.env.LLM_MODEL ?? DEFAULT_MODEL,
    generalModel:    S("generalModel")    ?? process.env.LLM_MODEL ?? DEFAULT_MODEL,
    managementFallbackModel: S("managementFallbackModel"),
    screeningFallbackModel:  S("screeningFallbackModel"),
    generalFallbackModel:    S("generalFallbackModel"),
    // Codex agent-loop reasoning effort for every role (low|medium|high|xhigh).
    // null keeps the per-role default: MANAGER high, others medium.
    reasoningEffort: S("llmReasoningEffort"),
  },

  // ─── Web UI ───────────────────────────
  web: {
    port: parseInt(S("webPort"), 10),
  },

  // ─── Learning ──────────────────────────
  // autoTune: lessons.js may rewrite thresholds from closed-trade history. OFF by
  // default; when off it only logs what it would have changed.
  learning: {
    autoTune: S("autoTune"),
  },

  // ─── Darwinian Signal Weighting ─────────
  darwin: {
    enabled: S("darwinianWeights"),
    windowDays: S("darwinianWindowDays"),
    boostFactor: S("darwinianBoostFactor"),
    decayFactor: S("darwinianDecayFactor"),
    weightFloor: S("darwinianWeightFloor"),
    weightCeiling: S("darwinianWeightCeiling"),
    minSamples: S("darwinianMinSamples"),
    perSignalMinSamples: S("darwinianPerSignalMinSamples"),
    minAbsLiftToAdjust: S("darwinianMinAbsLiftToAdjust"),
    strongLiftThreshold: S("darwinianStrongLiftThreshold"),
    calibrationMinSamples: S("darwinianCalibrationMinSamples"),
    meanReversionRate: S("darwinianMeanReversionRate"),
  },

  // ─── Autoresearch (prompt A/B experiments, after karpathy/autoresearch) ─────
  autoresearch: {
    enabled: S("autoresearch"),
    // Concurrent A/B verdict: control vs candidate arms, size-weighted mean PnL,
    // seeded bootstrap 95% CI. Keep only if CI lower bound > 0 AND effect >= minEffectPct.
    minClosesPerArm: S("autoresearchMinClosesPerArm"),
    minEffectPct: S("autoresearchMinEffectPct"),          // percentage points of mean PnL
    maxExperimentDays: S("autoresearchMaxExperimentDays"), // cap: inconclusive, candidate discarded
    autoKeep: S("autoresearchAutoKeep"),                // false = a passing candidate becomes a pending proposal
    minAttributedLosses: S("autoresearchMinAttributedLosses"),
    cooldownCloses: S("autoresearchCooldownCloses"),
    llmModel: S("autoresearchModel") ?? DEFAULT_MODEL,
    reasoningEffort: S("autoresearchReasoningEffort"),
    maxDiffPct: S("autoresearchMaxDiffPct"), // reject candidates that change more than this % of lines
  },

  // ─── Knowledge Base ─────────────────────
  knowledgeBase: {
    enabled:                   u.knowledgeBase?.enabled ?? true,
    dir:                       u.knowledgeBase?.dir ?? "./knowledge",
    autoFile:                  u.knowledgeBase?.autoFile ?? true,
    healthCheckIntervalHours:  u.knowledgeBase?.healthCheckIntervalHours ?? 12,
    maxArticles:               u.knowledgeBase?.maxArticles ?? 500,
  },

  // ─── Bid-Ask flip (tools/bidask-flip.js) ─
  // Once ≥ fillPct % of a single-sided SOL bid_ask position's SOL has converted
  // to token, move that token from the bins just above active into a
  // top-weighted ask that tops out at the original band top, in one atomic
  // rebalance_liquidity tx. "shadow" = plan + simulate + log only (default);
  // "live" = also sign/send; "off" = nothing runs.
  bidAskFlip: {
    mode:          S("bidAskFlipMode"),         // "off" | "shadow" | "live"
    fillPct:       S("bidAskFlipFillPct"),      // first flip at this % of deposited SOL converted
    reflipStepPct: S("bidAskFlipReflipStepPct"),// re-flip only a fresh tranche worth ≥ this % of the deposit
    minTrancheSol: S("bidAskFlipMinTrancheSol"),  // never flip a tranche worth less than this
    timeoutSec:    S("bidAskFlipTimeoutSec"),   // M1: flip-pass deadline (s)
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
};

// Nit: wallet-lock timeouts follow config from load onward (not only once cycles start).
syncWalletLockFromConfig(config);

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

  // pct is a share of the whole capital; the gas reserve and position rent come
  // out of the remainder (the free-SOL cap below), not out of the base.
  const raw  = pct * Math.max(0, baseSol);
  const size = Math.min(ceil, raw);
  // Position rent + tx fees also come out of free SOL (worst case: the deepest
  // allowed range at the smallest bin step); deploy_position re-fits exactly.
  const overhead = worstCaseDeployOverheadSol({ minBinStep: config.screening.minBinStep, maxRangePct: config.strategy.maxRangePct });
  const cap  = Math.max(0, freeSol - reserve - overhead);
  const capAmt = floor2(cap);
  const amount = Math.min(round2(size), capAmt);

  const of = `${fmtPct(pct)} of ${fmtSol(baseSol)} SOL ${basis === "total" ? "total" : "free wallet"}`;
  let why;
  if (round2(size) > capAmt) why = `free SOL ${fmtSol(freeSol)} − ${reserve} reserve − ~${fmtSol(overhead)} rent/fees (cap; ${of} = ${fmtSol(size)})`;
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
  "pnlWatcherIntervalSec",
]);

// Keys whose values should be rounded to the nearest integer
export const INTEGER_KEYS = new Set([
  "minTvl", "maxTvl", "minVolume", "minOrganic", "minHolders",
  "minMcap", "maxMcap", "minBinStep", "maxBinStep", "maxVolatility",
  "maxPriceChangePct", "minTokenFeesSol", "athTopThresholdPct",
  "outOfRangeWaitMinutes",
  "emergencyPriceDropPct", "stopLossPct", "takeProfitFeePct",
  "maxPositions", "maxDeployAmount",
  "managementIntervalMin", "screeningIntervalMin",
  "pnlWatcherIntervalSec",
  "maxTokens", "maxSteps", "solanaTrackerDailyCap",
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
    // An unreadable file is an error, not {}: rewriting it would drop the RPC
    // URL, wallet key and every other setting.
    userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
  }
  Object.assign(userConfig, changes, extra);
  writeJsonAtomicSync(USER_CONFIG_PATH, userConfig);
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
  writeJsonAtomicSync(GMGN_CONFIG_PATH, gmgnConfig);
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
      writeJsonAtomicSync(USER_CONFIG_PATH, existing);
    } catch { /* best effort */ }
  }

  // Clean up empty rejection buckets
  for (const bucket of Object.keys(rejected)) {
    if (Object.keys(rejected[bucket]).length === 0) delete rejected[bucket];
  }

  syncWalletLockFromConfig(config);
  return {
    success: Object.keys(applied).length > 0,
    applied,
    normalized,
    rejected,
  };
}

// Keys reloadScreeningThresholds() re-applies from the file (and from the active
// profile). Everything governed by a profile is included except the schedule
// (cron intervals only change through switchProfile / the schedule hooks).
const RELOAD_KEYS = [
  "screeningSource", "minFeeActiveTvlRatio", "minOrganic", "minHolders", "minMcap", "maxMcap", "minTvl", "maxTvl",
  "minVolume", "minBinStep", "maxBinStep", "maxVolatility", "maxPriceChangePct", "timeframe", "category",
  "athTopThresholdPct", "minTokenAgeHours", "maxTokenAgeHours", "stopLossPct", "takeProfitFeePct",
  "outOfRangeWaitMinutes", "trailingTriggerPct", "trailingDropPct", "ohlcvBufferMult",
  ...GOVERNED_KEYS.filter((k) => !/IntervalMin$|IntervalSec$/.test(k)),
];

function setConfigPath(pathArr, value) {
  let o = config;
  for (const k of pathArr.slice(0, -1)) o = o[k];
  o[pathArr.at(-1)] = pathArr.join(".") === "screening.source" ? normalizeScreeningSource(value) : value;
}

/** Recompute the derived minSolToOpen from the live deploy floor / gas reserve. */
function refreshMinSolToOpen(resolver) {
  config.management.minSolToOpen = getEffectiveMinSolToOpen({
    minSolToOpen: resolver.get("minSolToOpen"),
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
  });
}

/**
 * Reload user-config.json and apply updated thresholds to the in-memory config
 * object (user value, else the active profile's preset; schema defaults are not
 * re-applied so a value set in memory is never clobbered). Called after a profile
 * switch or threshold change so the next agent cycle sees it without a restart.
 */
export function reloadScreeningThresholds() {
  try {
    const fresh = readJsonIfExists(USER_CONFIG_PATH);
    const res = makeResolver(fresh);
    config.profile = res.profile;
    for (const key of RELOAD_KEYS) {
      const row = BY_KEY.get(key);
      if (!row?.path || res.source(key) === "default") continue;
      setConfigPath(row.path, res.get(key));
    }
    refreshMinSolToOpen(res);
  } catch { /* ignore */ }
  // Refresh GMGN screening keys from gmgn-config.json (mirrors the gmgn block above)
  try {
    const freshGmgn = readJsonIfExists(GMGN_CONFIG_PATH);
    const g = config.gmgn;
    for (const [key, value] of Object.entries(freshGmgn)) {
      if (key in g && key !== "apiKey") g[key] = value;
    }
    if (freshGmgn.apiKey && !process.env.GMGN_API_KEY) g.apiKey = freshGmgn.apiKey;
  } catch { /* ignore */ }
}

// rejectAlreadyAtBottom=true used to be a silent no-op (bb_lower was never computed). It is still a no-op;
// say so once instead of letting it flip into a live hard reject. Opt in with indicatorRules.enforceAlreadyAtBottom.
if ((gmgnUserConfig.indicatorRules || {}).rejectAlreadyAtBottom === true && (gmgnUserConfig.indicatorRules || {}).enforceAlreadyAtBottom !== true) {
  console.warn("[config] gmgn indicatorRules.rejectAlreadyAtBottom=true is log-only (it never fired before either). Set indicatorRules.enforceAlreadyAtBottom=true to actually reject.");
}

/** Effective value of every profile-governed key, as currently in memory. */
export function currentGovernedValues() {
  const out = {};
  for (const key of GOVERNED_KEYS) {
    const row = BY_KEY.get(key);
    out[key] = row.path.reduce((o, k) => o?.[k], config);
  }
  return out;
}

/**
 * Switch profile and persist it.
 *  - conservative | balanced | degen: write `profile` and DROP the user's explicit
 *    values for every governed key, so the preset takes effect (the caller shows the
 *    diff and asks for confirmation first).
 *  - custom: write `profile: "custom"` and PIN every governed key to its current
 *    effective value, so leaving a profile never changes behavior.
 * Returns { profile, changed: [{key, from, to}], scheduleChanged: [keys] }.
 */
export function switchProfile(name) {
  const target = normalizeProfile(name);
  const before = currentGovernedValues();
  const file = readJsonIfExists(USER_CONFIG_PATH);
  const next = { ...file, profile: target };
  if (target === "custom") {
    for (const [k, v] of Object.entries(before)) next[k] = v;
  } else {
    for (const k of GOVERNED_KEYS) delete next[k];
  }
  writeJsonAtomicSync(USER_CONFIG_PATH, next);
  const res = makeResolver(next);
  config.profile = res.profile;
  const changed = [];
  const scheduleChanged = [];
  for (const key of GOVERNED_KEYS) {
    const row = BY_KEY.get(key);
    const to = res.get(key);
    if (JSON.stringify(before[key]) !== JSON.stringify(to)) {
      changed.push({ key, from: before[key], to });
      if (row.path[0] === "schedule") scheduleChanged.push(key);
    }
    setConfigPath(row.path, to);
  }
  refreshMinSolToOpen(res);
  syncWalletLockFromConfig(config);
  return { profile: target, changed, scheduleChanged };
}
