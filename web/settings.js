import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config, reloadScreeningThresholds, MIN_SAFE_BINS_BELOW } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, "..");
const KEEP_SECRET = "__KEEP_SECRET__";

export const SETTINGS_PATHS = {
  env: path.join(ROOT_DIR, ".env"),
  userConfig: path.join(ROOT_DIR, "user-config.json"),
  gmgnConfig: path.join(ROOT_DIR, "gmgn-config.json"),
};

export const ENV_SECTIONS = [
  {
    id: "required",
    title: "Required Runtime",
    description: "Fill these before expecting wallet reads, screening, and agent reasoning to work.",
    fields: [
      { key: "WALLET_PRIVATE_KEY", label: "Wallet private key", type: "secret", required: true },
      { key: "RPC_URL", label: "Solana RPC URL", type: "string", required: true },
      { key: "OPENROUTER_API_KEY", label: "OpenRouter API key", type: "secret" },
      { key: "LLM_BASE_URL", label: "LLM base URL", type: "string" },
      { key: "LLM_API_KEY", label: "LLM API key", type: "secret" },
      { key: "LLM_MODEL", label: "LLM model", type: "string" },
      { key: "DRY_RUN", label: "Dry run mode", type: "boolean" },
      { key: "WEB_LIVE_TRADING_ENABLED", label: "Enable live browser trading", type: "boolean" },
    ],
  },
  {
    id: "integrations",
    title: "Integrations",
    description: "Optional services used by screening, routing, notifications, and shared lessons.",
    fields: [
      { key: "HELIUS_API_KEY", label: "Helius API key", type: "secret" },
      { key: "GMGN_API_KEY", label: "GMGN API key", type: "secret" },
      { key: "LPAGENT_API_KEY", label: "LPAgent API key", type: "secret" },
      { key: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token", type: "secret" },
      { key: "TELEGRAM_CHAT_ID", label: "Telegram chat ID", type: "string" },
      { key: "TELEGRAM_ALLOWED_USER_IDS", label: "Telegram allowed user IDs", type: "list" },
      { key: "PUBLIC_API_KEY", label: "Agent Meridian public API key", type: "secret" },
      { key: "AGENT_MERIDIAN_API_URL", label: "Agent Meridian API URL", type: "string" },
      { key: "HIVEMIND_API_KEY", label: "HiveMind API key", type: "secret" },
      { key: "JUPITER_API_KEY", label: "Jupiter API key", type: "secret" },
      { key: "JUPITER_REFERRAL_ACCOUNT", label: "Jupiter referral account", type: "string" },
      { key: "JUPITER_REFERRAL_FEE_BPS", label: "Jupiter referral fee bps", type: "number" },
    ],
  },
  {
    id: "admin",
    title: "Admin",
    description: "Operational flags. Self-update stays disabled unless explicitly enabled.",
    fields: [
      { key: "ALLOW_SELF_UPDATE", label: "Allow self update", type: "boolean" },
      { key: "LOG_LEVEL", label: "Log level", type: "choice", choices: ["debug", "info", "warn", "error"].map((key) => ({ key, label: key })) },
      { key: "PORT", label: "Web API port", type: "number" },
      { key: "HOST", label: "Web API host", type: "string" },
    ],
  },
];

export const CONFIG_SECTIONS = [
  {
    id: "wallet",
    title: "Wallet & RPC Fallbacks",
    fields: [
      { key: "rpcUrl", label: "RPC URL", type: "string" },
      { key: "walletKey", label: "Wallet private key", type: "secret" },
      { key: "dryRun", label: "Dry run mode", type: "boolean" },
    ],
  },
  {
    id: "deployment",
    title: "Deployment",
    fields: [
      { key: "deployAmountSol", label: "SOL per position", type: "number", min: 0.01 },
      { key: "maxPositions", label: "Max concurrent positions", type: "number", min: 1 },
      { key: "minSolToOpen", label: "Min SOL to open", type: "number", min: 0.01 },
      { key: "maxDeployAmount", label: "Max SOL per position", type: "number", min: 0.01 },
      { key: "gasReserve", label: "Gas reserve SOL", type: "number", min: 0 },
      { key: "positionSizePct", label: "Position size pct", type: "number", min: 0, max: 1 },
    ],
  },
  {
    id: "strategy",
    title: "Strategy",
    fields: [
      { key: "strategy", label: "Default LP strategy", type: "choice", choices: ["bid_ask", "spot", "curve"].map((key) => ({ key, label: key })) },
      { key: "minBinsBelow", label: "Min bins below", type: "number", min: MIN_SAFE_BINS_BELOW },
      { key: "maxBinsBelow", label: "Max bins below", type: "number", min: MIN_SAFE_BINS_BELOW },
      { key: "defaultBinsBelow", label: "Default bins below", type: "number", min: MIN_SAFE_BINS_BELOW },
    ],
  },
  {
    id: "screening",
    title: "Screening Filters",
    fields: [
      { key: "screeningSource", label: "Screening source", type: "choice", choices: ["meteora", "gmgn"].map((key) => ({ key, label: key })) },
      { key: "timeframe", label: "Timeframe", type: "choice", choices: ["5m", "30m", "1h", "4h", "12h", "24h"].map((key) => ({ key, label: key })) },
      { key: "category", label: "Category", type: "string" },
      { key: "excludeHighSupplyConcentration", label: "Exclude high supply concentration", type: "boolean" },
      { key: "minTvl", label: "Min TVL", type: "number", min: 0 },
      { key: "maxTvl", label: "Max TVL", type: "number", min: 0, nullable: true },
      { key: "minVolume", label: "Min volume", type: "number", min: 0 },
      { key: "minOrganic", label: "Min organic", type: "number", min: 0, max: 100 },
      { key: "minQuoteOrganic", label: "Min quote organic", type: "number", min: 0, max: 100 },
      { key: "minHolders", label: "Min holders", type: "number", min: 0 },
      { key: "minMcap", label: "Min market cap", type: "number", min: 0 },
      { key: "maxMcap", label: "Max market cap", type: "number", min: 0, nullable: true },
      { key: "minBinStep", label: "Min bin step", type: "number", min: 1 },
      { key: "maxBinStep", label: "Max bin step", type: "number", min: 1 },
      { key: "minFeeActiveTvlRatio", label: "Min fee/TVL ratio", type: "number", min: 0 },
      { key: "minTokenFeesSol", label: "Min token fees SOL", type: "number", min: 0 },
      { key: "avoidPvpSymbols", label: "Avoid PVP symbols", type: "boolean" },
      { key: "blockPvpSymbols", label: "Block PVP symbols", type: "boolean" },
      { key: "maxBundlePct", label: "Max bundle pct", type: "number", min: 0, max: 100 },
      { key: "maxBotHoldersPct", label: "Max bot holders pct", type: "number", min: 0, max: 100 },
      { key: "maxTop10Pct", label: "Max top 10 pct", type: "number", min: 0, max: 100 },
      { key: "allowedLaunchpads", label: "Allowed launchpads", type: "list" },
      { key: "blockedLaunchpads", label: "Blocked launchpads", type: "list" },
      { key: "minTokenAgeHours", label: "Min token age hours", type: "number", min: 0, nullable: true },
      { key: "maxTokenAgeHours", label: "Max token age hours", type: "number", min: 0, nullable: true },
      { key: "athFilterPct", label: "ATH filter pct", type: "number", nullable: true },
    ],
  },
  {
    id: "management",
    title: "Management Rules",
    fields: [
      { key: "minClaimAmount", label: "Min claim amount", type: "number", min: 0 },
      { key: "autoSwapAfterClaim", label: "Auto swap after claim", type: "boolean" },
      { key: "outOfRangeBinsToClose", label: "OOR bins to close", type: "number", min: 0 },
      { key: "outOfRangeWaitMinutes", label: "OOR wait minutes", type: "number", min: 1 },
      { key: "minVolumeToRebalance", label: "Min volume to rebalance", type: "number", min: 0 },
      { key: "stopLossPct", label: "Stop loss pct", type: "number" },
      { key: "takeProfitPct", label: "Take profit pct", type: "number", min: 0 },
      { key: "minFeePerTvl24h", label: "Min fee/TVL 24h", type: "number", min: 0 },
      { key: "trailingTakeProfit", label: "Trailing take profit", type: "boolean" },
      { key: "trailingTriggerPct", label: "Trailing trigger pct", type: "number" },
      { key: "trailingDropPct", label: "Trailing drop pct", type: "number", min: 0 },
      { key: "pnlSanityMaxDiffPct", label: "PNL sanity max diff pct", type: "number", min: 0 },
      { key: "solMode", label: "SOL mode", type: "boolean" },
    ],
  },
  {
    id: "schedule-llm",
    title: "Schedule & LLM",
    fields: [
      { key: "managementIntervalMin", label: "Management interval min", type: "number", min: 1 },
      { key: "screeningIntervalMin", label: "Screening interval min", type: "number", min: 1 },
      { key: "healthCheckIntervalMin", label: "Health check interval min", type: "number", min: 1 },
      { key: "llmBaseUrl", label: "LLM base URL", type: "string" },
      { key: "llmApiKey", label: "LLM API key", type: "secret" },
      { key: "llmModel", label: "Default LLM model", type: "string" },
      { key: "managementModel", label: "Management model", type: "string" },
      { key: "screeningModel", label: "Screening model", type: "string" },
      { key: "generalModel", label: "General model", type: "string" },
      { key: "temperature", label: "Temperature", type: "number", min: 0, max: 2 },
      { key: "maxTokens", label: "Max tokens", type: "number", min: 256 },
      { key: "maxSteps", label: "Max steps", type: "number", min: 1 },
    ],
  },
  {
    id: "integrations",
    title: "Meridian Integrations",
    fields: [
      { key: "agentId", label: "Agent ID", type: "string" },
      { key: "publicApiKey", label: "Public API key", type: "secret" },
      { key: "agentMeridianApiUrl", label: "Agent Meridian API URL", type: "string" },
      { key: "lpAgentRelayEnabled", label: "LPAgent relay enabled", type: "boolean" },
      { key: "telegramChatId", label: "Telegram chat ID", type: "string" },
      { key: "hiveMindUrl", label: "HiveMind URL", type: "string" },
      { key: "hiveMindApiKey", label: "HiveMind API key", type: "secret" },
      { key: "hiveMindPullMode", label: "HiveMind pull mode", type: "choice", choices: ["auto", "manual"].map((key) => ({ key, label: key })) },
    ],
  },
];

export const GMGN_SECTIONS = [
  {
    id: "gmgn",
    title: "GMGN Screening",
    fields: [
      { key: "apiKey", label: "GMGN API key", type: "secret" },
      { key: "baseUrl", label: "GMGN base URL", type: "string" },
      { key: "interval", label: "Interval", type: "choice", choices: ["1m", "5m", "15m", "1h", "6h", "24h"].map((key) => ({ key, label: key })) },
      { key: "orderBy", label: "Order by", type: "string" },
      { key: "direction", label: "Direction", type: "choice", choices: ["desc", "asc"].map((key) => ({ key, label: key })) },
      { key: "limit", label: "Rank limit", type: "number", min: 1 },
      { key: "enrichLimit", label: "Enrich limit", type: "number", min: 1 },
      { key: "requestDelayMs", label: "Request delay ms", type: "number", min: 0 },
      { key: "maxRetries", label: "Max retries", type: "number", min: 0 },
      { key: "holdersLimit", label: "Holders limit", type: "number", min: 1 },
      { key: "klineResolution", label: "Kline resolution", type: "string" },
      { key: "klineLookbackMinutes", label: "Kline lookback minutes", type: "number", min: 1 },
      { key: "filters", label: "Filters", type: "list" },
      { key: "platforms", label: "Platforms", type: "list" },
      { key: "minMcap", label: "Min market cap", type: "number", min: 0 },
      { key: "maxMcap", label: "Max market cap", type: "number", min: 0 },
      { key: "minVolume", label: "Min volume", type: "number", min: 0 },
      { key: "minHolders", label: "Min holders", type: "number", min: 0 },
      { key: "minTokenAgeHours", label: "Min token age hours", type: "number", min: 0 },
      { key: "maxTokenAgeHours", label: "Max token age hours", type: "number", min: 0 },
      { key: "requireKol", label: "Require KOL", type: "boolean" },
      { key: "minKolCount", label: "Min KOL count", type: "number", min: 0 },
      { key: "minSmartDegenCount", label: "Min smart degen count", type: "number", min: 0 },
      { key: "minTotalFeeSol", label: "Min total fee SOL", type: "number", min: 0 },
      { key: "athFilterPct", label: "ATH filter pct", type: "number", nullable: true },
      { key: "maxRugRatio", label: "Max rug ratio", type: "number", min: 0 },
      { key: "maxTop10HolderRate", label: "Max top 10 holder rate", type: "number", min: 0 },
      { key: "maxBundlerRate", label: "Max bundler rate", type: "number", min: 0 },
      { key: "maxRatTraderRate", label: "Max rat trader rate", type: "number", min: 0 },
      { key: "maxFreshWalletRate", label: "Max fresh wallet rate", type: "number", min: 0 },
      { key: "maxDevTeamHoldRate", label: "Max dev team hold rate", type: "number", min: 0 },
      { key: "maxBotDegenRate", label: "Max bot degen rate", type: "number", min: 0 },
      { key: "maxSniperCount", label: "Max sniper count", type: "number", min: 0 },
      { key: "maxSniperHoldRate", label: "Max sniper hold rate", type: "number", min: 0 },
      { key: "preferredKolNames", label: "Preferred KOL names", type: "list" },
      { key: "preferredKolMinHoldPct", label: "Preferred KOL min hold pct", type: "number", min: 0 },
      { key: "dumpKolNames", label: "Dump KOL names", type: "list" },
      { key: "dumpKolMinHoldPct", label: "Dump KOL min hold pct", type: "number", min: 0 },
      { key: "rejectSingleVolumeSpike", label: "Reject single volume spike", type: "boolean" },
      { key: "maxSingleCandleVolumeShare", label: "Max single candle volume share", type: "number", min: 0, max: 1 },
      { key: "indicatorFilter", label: "Indicator filter", type: "boolean" },
      { key: "indicatorInterval", label: "Indicator interval", type: "string" },
      { key: "indicatorRules.requireBullishSupertrend", label: "Require bullish supertrend", type: "boolean" },
      { key: "indicatorRules.rejectAlreadyAtBottom", label: "Reject already at bottom", type: "boolean" },
      { key: "indicatorRules.requireAboveSupertrend", label: "Require above supertrend", type: "boolean" },
      { key: "indicatorRules.minRsi", label: "Min RSI", type: "number", nullable: true },
      { key: "indicatorRules.maxRsi", label: "Max RSI", type: "number", nullable: true },
      { key: "indicatorRules.requireBbPosition", label: "Require BB position", type: "string", nullable: true },
    ],
  },
];

const SECRET_RE = /(PRIVATE|SECRET|TOKEN|KEY|PASSPHRASE|PASSWORD)/i;

const CONFIG_MAP = {
  screeningSource: ["screening", "source"],
  minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
  excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
  minTvl: ["screening", "minTvl"],
  maxTvl: ["screening", "maxTvl"],
  minVolume: ["screening", "minVolume"],
  minOrganic: ["screening", "minOrganic"],
  minQuoteOrganic: ["screening", "minQuoteOrganic"],
  minHolders: ["screening", "minHolders"],
  minMcap: ["screening", "minMcap"],
  maxMcap: ["screening", "maxMcap"],
  minBinStep: ["screening", "minBinStep"],
  maxBinStep: ["screening", "maxBinStep"],
  timeframe: ["screening", "timeframe"],
  category: ["screening", "category"],
  minTokenFeesSol: ["screening", "minTokenFeesSol"],
  avoidPvpSymbols: ["screening", "avoidPvpSymbols"],
  blockPvpSymbols: ["screening", "blockPvpSymbols"],
  maxBundlePct: ["screening", "maxBundlePct"],
  maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
  maxTop10Pct: ["screening", "maxTop10Pct"],
  allowedLaunchpads: ["screening", "allowedLaunchpads"],
  blockedLaunchpads: ["screening", "blockedLaunchpads"],
  minTokenAgeHours: ["screening", "minTokenAgeHours"],
  maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
  athFilterPct: ["screening", "athFilterPct"],
  minClaimAmount: ["management", "minClaimAmount"],
  autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
  outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
  outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
  minVolumeToRebalance: ["management", "minVolumeToRebalance"],
  stopLossPct: ["management", "stopLossPct"],
  takeProfitPct: ["management", "takeProfitPct"],
  trailingTakeProfit: ["management", "trailingTakeProfit"],
  trailingTriggerPct: ["management", "trailingTriggerPct"],
  trailingDropPct: ["management", "trailingDropPct"],
  pnlSanityMaxDiffPct: ["management", "pnlSanityMaxDiffPct"],
  solMode: ["management", "solMode"],
  minSolToOpen: ["management", "minSolToOpen"],
  deployAmountSol: ["management", "deployAmountSol"],
  gasReserve: ["management", "gasReserve"],
  positionSizePct: ["management", "positionSizePct"],
  minFeePerTvl24h: ["management", "minFeePerTvl24h"],
  maxPositions: ["risk", "maxPositions"],
  maxDeployAmount: ["risk", "maxDeployAmount"],
  managementIntervalMin: ["schedule", "managementIntervalMin"],
  screeningIntervalMin: ["schedule", "screeningIntervalMin"],
  healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
  managementModel: ["llm", "managementModel"],
  screeningModel: ["llm", "screeningModel"],
  generalModel: ["llm", "generalModel"],
  temperature: ["llm", "temperature"],
  maxTokens: ["llm", "maxTokens"],
  maxSteps: ["llm", "maxSteps"],
  strategy: ["strategy", "strategy"],
  minBinsBelow: ["strategy", "minBinsBelow"],
  maxBinsBelow: ["strategy", "maxBinsBelow"],
  defaultBinsBelow: ["strategy", "defaultBinsBelow"],
  hiveMindUrl: ["hiveMind", "url"],
  hiveMindApiKey: ["hiveMind", "apiKey"],
  agentId: ["hiveMind", "agentId"],
  hiveMindPullMode: ["hiveMind", "pullMode"],
  publicApiKey: ["api", "publicApiKey"],
  agentMeridianApiUrl: ["api", "url"],
  lpAgentRelayEnabled: ["api", "lpAgentRelayEnabled"],
};

function fieldsFrom(sections) {
  return sections.flatMap((section) => section.fields);
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function getPathValue(source, dottedKey) {
  if (!dottedKey.includes(".")) return source?.[dottedKey];
  return dottedKey.split(".").reduce((target, part) => (
    target && typeof target === "object" ? target[part] : undefined
  ), source);
}

function setPathValue(target, dottedKey, value) {
  const parts = dottedKey.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

function unquoteEnv(raw = "") {
  const value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function serializeEnvValue(value) {
  const raw = value == null ? "" : String(value);
  if (!raw || /^[A-Za-z0-9_./:@?=&,+%-]+$/.test(raw)) return raw;
  return JSON.stringify(raw);
}

function readEnv(filePath) {
  const values = {};
  const lines = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").split(/\r?\n/) : [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = unquoteEnv(match[2]);
  }
  return { values, lines };
}

function writeEnv(filePath, updates) {
  const { lines } = readEnv(filePath);
  const remaining = { ...updates };
  const nextLines = lines.map((line) => {
    const match = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(=)(.*)$/);
    if (!match || !(match[2] in remaining)) return line;
    const value = remaining[match[2]];
    delete remaining[match[2]];
    return `${match[1]}${match[2]}=${serializeEnvValue(value)}`;
  });

  const additions = Object.entries(remaining);
  if (additions.length > 0) {
    if (nextLines.length && nextLines[nextLines.length - 1].trim() !== "") nextLines.push("");
    nextLines.push("# Web app settings");
    for (const [key, value] of additions) nextLines.push(`${key}=${serializeEnvValue(value)}`);
  }

  fs.writeFileSync(filePath, `${nextLines.join("\n").replace(/\n+$/, "")}\n`);
}

function isSecretField(field) {
  return field.type === "secret" || (field.key === field.key.toUpperCase() && SECRET_RE.test(field.key));
}

function configured(value) {
  return typeof value === "string" ? value.trim().length > 0 : value != null && value !== false;
}

function maskValue(key, value, field = {}) {
  if (!isSecretField(field)) return value ?? "";
  return configured(value)
    ? { configured: true, display: "Configured", value: KEEP_SECRET }
    : { configured: false, display: "Not set", value: "" };
}

function coerceValue(value, field = {}) {
  if (value === KEEP_SECRET) return KEEP_SECRET;
  if (value === "" && field.nullable) return null;
  if (field.type === "boolean") {
    if (typeof value === "boolean") return value;
    return String(value).toLowerCase() === "true";
  }
  if (field.type === "number") {
    if (value === "" || value == null) return field.nullable ? null : "";
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${field.key} must be a number.`);
    return n;
  }
  if (field.type === "list") {
    if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
    return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  }
  return value == null ? "" : String(value);
}

function envRuntimeValue(key, envValues, userConfig = {}, gmgnConfig = {}) {
  const map = {
    RPC_URL: userConfig.rpcUrl,
    WALLET_PRIVATE_KEY: userConfig.walletKey,
    LLM_BASE_URL: userConfig.llmBaseUrl,
    LLM_API_KEY: userConfig.llmApiKey,
    LLM_MODEL: userConfig.llmModel,
    DRY_RUN: userConfig.dryRun != null ? String(userConfig.dryRun) : undefined,
    PUBLIC_API_KEY: userConfig.publicApiKey,
    AGENT_MERIDIAN_API_URL: userConfig.agentMeridianApiUrl,
    GMGN_API_KEY: gmgnConfig.apiKey || userConfig.gmgnApiKey,
    TELEGRAM_CHAT_ID: userConfig.telegramChatId,
    HIVEMIND_API_KEY: userConfig.hiveMindApiKey,
  };
  return envValues[key] ?? process.env[key] ?? map[key] ?? "";
}

function currentConfigValue(key, userConfig, gmgnConfig) {
  if (key in userConfig) return userConfig[key];
  if (key === "dryRun") return config.management?.dryRun ?? (process.env.DRY_RUN === "true");
  if (key === "rpcUrl") return process.env.RPC_URL || "";
  if (key === "walletKey") return process.env.WALLET_PRIVATE_KEY || "";
  if (key === "llmBaseUrl") return process.env.LLM_BASE_URL || "";
  if (key === "llmApiKey") return process.env.LLM_API_KEY || "";
  if (key === "llmModel") return process.env.LLM_MODEL || config.llm?.generalModel || "";
  if (CONFIG_MAP[key]) {
    const [section, field] = CONFIG_MAP[key];
    return config[section]?.[field] ?? "";
  }
  if (key in gmgnConfig) return gmgnConfig[key];
  return "";
}

function currentGmgnValue(key, gmgnConfig) {
  const fromFile = getPathValue(gmgnConfig, key);
  if (fromFile !== undefined) return fromFile;
  return getPathValue(config.gmgn, key) ?? "";
}

function schema() {
  return {
    keepSecret: KEEP_SECRET,
    env: ENV_SECTIONS,
    userConfig: CONFIG_SECTIONS,
    gmgnConfig: GMGN_SECTIONS,
  };
}

function buildReadiness(envValues, userConfig, gmgnConfig) {
  const llmConfigured = configured(envRuntimeValue("OPENROUTER_API_KEY", envValues, userConfig, gmgnConfig))
    || configured(envRuntimeValue("LLM_API_KEY", envValues, userConfig, gmgnConfig));
  const checks = [
    { id: "wallet", label: "Wallet private key", ok: configured(envRuntimeValue("WALLET_PRIVATE_KEY", envValues, userConfig, gmgnConfig)), required: true },
    { id: "rpc", label: "Solana RPC URL", ok: configured(envRuntimeValue("RPC_URL", envValues, userConfig, gmgnConfig)), required: true },
    { id: "llm", label: "LLM provider key", ok: llmConfigured, required: true },
    { id: "live-web", label: "Live browser trading enabled", ok: envRuntimeValue("WEB_LIVE_TRADING_ENABLED", envValues, userConfig, gmgnConfig) === "true", required: false },
    { id: "dry-run", label: "Dry-run flag set", ok: configured(envRuntimeValue("DRY_RUN", envValues, userConfig, gmgnConfig)), required: false },
    { id: "gmgn", label: "GMGN credentials", ok: configured(envRuntimeValue("GMGN_API_KEY", envValues, userConfig, gmgnConfig)), required: userConfig.screeningSource === "gmgn" },
    { id: "telegram", label: "Telegram notifications", ok: configured(envRuntimeValue("TELEGRAM_BOT_TOKEN", envValues, userConfig, gmgnConfig)), required: false },
  ];
  const missingRequired = checks.filter((check) => check.required && !check.ok);
  return {
    ready: missingRequired.length === 0,
    missingRequired: missingRequired.map((check) => check.id),
    checks,
  };
}

function updateProcessEnv(updates) {
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value == null ? "" : String(value);
  }
}

function hydrateRuntimeEnvFromFiles(paths = SETTINGS_PATHS) {
  const envValues = readEnv(paths.env).values;
  const userConfig = readJsonIfExists(paths.userConfig);
  const gmgnConfig = readJsonIfExists(paths.gmgnConfig);
  const runtimeKeys = new Set([
    ...fieldsFrom(ENV_SECTIONS).map((field) => field.key),
    "RPC_URL",
    "WALLET_PRIVATE_KEY",
    "LLM_BASE_URL",
    "LLM_API_KEY",
    "LLM_MODEL",
    "DRY_RUN",
    "PUBLIC_API_KEY",
    "AGENT_MERIDIAN_API_URL",
    "GMGN_API_KEY",
    "TELEGRAM_CHAT_ID",
    "HIVEMIND_API_KEY",
  ]);

  for (const key of runtimeKeys) {
    const value = envRuntimeValue(key, envValues, userConfig, gmgnConfig);
    if (configured(value)) process.env[key] = String(value);
  }
}

function applyUserConfigToRuntime(updates) {
  const envMap = {
    rpcUrl: "RPC_URL",
    walletKey: "WALLET_PRIVATE_KEY",
    llmBaseUrl: "LLM_BASE_URL",
    llmApiKey: "LLM_API_KEY",
    llmModel: "LLM_MODEL",
    dryRun: "DRY_RUN",
    publicApiKey: "PUBLIC_API_KEY",
    agentMeridianApiUrl: "AGENT_MERIDIAN_API_URL",
    telegramChatId: "TELEGRAM_CHAT_ID",
    hiveMindApiKey: "HIVEMIND_API_KEY",
  };
  for (const [key, value] of Object.entries(updates)) {
    if (key in envMap) process.env[envMap[key]] = String(value ?? "");
    const target = CONFIG_MAP[key];
    if (!target) continue;
    const [section, field] = target;
    if (!config[section] || typeof config[section] !== "object") config[section] = {};
    config[section][field] = value;
  }
  if (
    updates.minBinsBelow != null ||
    updates.maxBinsBelow != null ||
    updates.defaultBinsBelow != null
  ) {
    config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW)));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(Number(config.strategy.maxBinsBelow ?? config.strategy.minBinsBelow)));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(config.strategy.maxBinsBelow, Math.round(Number(config.strategy.defaultBinsBelow ?? config.strategy.maxBinsBelow))),
    );
  }
}

function applyGmgnConfigToRuntime(updates) {
  if (!config.gmgn || typeof config.gmgn !== "object") config.gmgn = {};
  for (const [key, value] of Object.entries(updates)) setPathValue(config.gmgn, key, value);
  if (updates.apiKey) process.env.GMGN_API_KEY = String(updates.apiKey);
}

export function getSettings(paths = SETTINGS_PATHS) {
  const envData = readEnv(paths.env);
  const userConfig = readJsonIfExists(paths.userConfig);
  const gmgnConfig = readJsonIfExists(paths.gmgnConfig);
  const envValues = {};
  const userValues = {};
  const gmgnValues = {};

  for (const field of fieldsFrom(ENV_SECTIONS)) {
    envValues[field.key] = maskValue(field.key, envRuntimeValue(field.key, envData.values, userConfig, gmgnConfig), field);
  }
  for (const field of fieldsFrom(CONFIG_SECTIONS)) {
    userValues[field.key] = maskValue(field.key, currentConfigValue(field.key, userConfig, gmgnConfig), field);
  }
  for (const field of fieldsFrom(GMGN_SECTIONS)) {
    gmgnValues[field.key] = maskValue(field.key, currentGmgnValue(field.key, gmgnConfig), field);
  }

  return {
    schema: schema(),
    values: {
      env: envValues,
      userConfig: userValues,
      gmgnConfig: gmgnValues,
    },
    readiness: buildReadiness(envData.values, userConfig, gmgnConfig),
    files: {
      env: paths.env,
      userConfig: paths.userConfig,
      gmgnConfig: paths.gmgnConfig,
      exists: {
        env: fs.existsSync(paths.env),
        userConfig: fs.existsSync(paths.userConfig),
        gmgnConfig: fs.existsSync(paths.gmgnConfig),
      },
    },
  };
}

export function saveSettings(payload = {}, paths = SETTINGS_PATHS) {
  const now = new Date().toISOString();
  const envFields = Object.fromEntries(fieldsFrom(ENV_SECTIONS).map((field) => [field.key, field]));
  const userFields = Object.fromEntries(fieldsFrom(CONFIG_SECTIONS).map((field) => [field.key, field]));
  const gmgnFields = Object.fromEntries(fieldsFrom(GMGN_SECTIONS).map((field) => [field.key, field]));

  const envUpdates = {};
  for (const [key, raw] of Object.entries(payload.env || {})) {
    const field = envFields[key];
    if (!field) throw new Error(`Unknown env setting: ${key}`);
    const value = coerceValue(raw, field);
    if (value === KEEP_SECRET) continue;
    envUpdates[key] = field.type === "boolean" ? String(value) : field.type === "list" ? value.join(",") : String(value ?? "");
  }
  if (Object.keys(envUpdates).length > 0) {
    writeEnv(paths.env, envUpdates);
    updateProcessEnv(envUpdates);
  }

  const userConfig = readJsonIfExists(paths.userConfig);
  const userUpdates = {};
  for (const [key, raw] of Object.entries(payload.userConfig || {})) {
    const field = userFields[key];
    if (!field) throw new Error(`Unknown user config setting: ${key}`);
    const value = coerceValue(raw, field);
    if (value === KEEP_SECRET) continue;
    userUpdates[key] = value;
    userConfig[key] = value;
  }
  if (Object.keys(userUpdates).length > 0) {
    userConfig._lastWebUpdate = now;
    writeJson(paths.userConfig, userConfig);
    applyUserConfigToRuntime(userUpdates);
  }

  const gmgnConfig = readJsonIfExists(paths.gmgnConfig);
  const gmgnUpdates = {};
  for (const [key, raw] of Object.entries(payload.gmgnConfig || {})) {
    const field = gmgnFields[key];
    if (!field) throw new Error(`Unknown GMGN setting: ${key}`);
    const value = coerceValue(raw, field);
    if (value === KEEP_SECRET) continue;
    gmgnUpdates[key] = value;
    setPathValue(gmgnConfig, key, value);
  }
  if (Object.keys(gmgnUpdates).length > 0) {
    gmgnConfig._lastWebUpdate = now;
    writeJson(paths.gmgnConfig, gmgnConfig);
    applyGmgnConfigToRuntime(gmgnUpdates);
  }

  if (Object.keys(userUpdates).length > 0 || Object.keys(gmgnUpdates).length > 0) {
    reloadScreeningThresholds();
  }
  hydrateRuntimeEnvFromFiles(paths);

  return {
    ok: true,
    saved: {
      env: Object.keys(envUpdates),
      userConfig: Object.keys(userUpdates),
      gmgnConfig: Object.keys(gmgnUpdates),
    },
    settings: getSettings(paths),
  };
}

export { KEEP_SECRET };
