import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.usdcMode !== undefined) process.env.USDC_MODE ||= String(u.usdcMode);

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
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        5,
    outOfRangeBinsToClose: 5,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    minVolumeToRebalance:  1000,
    emergencyPriceDropPct: -50,
    stopLossPct:           u.stopLossPct ?? -20,
    takeProfitFeePct:      u.takeProfitFeePct ?? 5,
    trailingTakeProfit:    u.trailingTakeProfit ?? true,
    trailingTriggerPct:    u.trailingTriggerPct ?? 3,
    trailingDropPct:       u.trailingDropPct ?? 1.5,
    minSolToOpen:          u.minSolToOpen ?? 0.55,
    deployAmountSol:       u.deployAmountSol ?? 0.5,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:   "bid_ask",
    binsBelow:  69,  // activeBin - 69 to activeBin = 70 bins total (program max)
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
    gasReserveSol:   u.gasReserveSol   ?? 0.05,  // native SOL kept for gas (warn-only floor)
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin: u.managementIntervalMin ?? 10,
    screeningIntervalMin:  u.screeningIntervalMin  ?? 30,
    healthCheckIntervalMin: 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: 0.373,
    maxTokens: 4096,
    maxSteps: 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "deepseek-chat",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "deepseek-reasoner",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "deepseek-chat",
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
};

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
    if (fresh.timeframe      != null) s.timeframe      = fresh.timeframe;
    if (fresh.category       != null) s.category       = fresh.category;
  } catch { /* ignore */ }
}

