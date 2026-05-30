import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
} from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { usdcModeEnabled, prepareUsdcEntry, settleToUsdc } from "./usdc-mode.js";
import { studyTopLPers, getPoolInfo } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import { setPositionInstruction } from "../state.js";
import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, reloadScreeningThresholds } from "../config.js";
import { updateStagedSignals, getPoolForMint } from "../signal-tracker.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";
import { CONFIG_KEY_MAP, getRequiredSolBalance } from "../runtime-helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "../user-config.json");
import { log, logAction } from "../logger.js";
import { rememberFact, recallMemory, forgetFact } from "../memory.js";
import { emit } from "../notifier.js";
import { kbRead, kbWrite, kbSearch, kbList, kbDelete, kbMigrate, kbGetStats, kbRebuildIndexes } from "./knowledge-base-tools.js";

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  get_pool_info: getPoolInfo,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_strategy: addStrategy,
  list_strategies: listStrategies,
  get_strategy: getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy: removeStrategy,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  get_performance_history: getPerformanceHistory,
  calculate_bins: ({ bin_step, price_range_pct, bin_count }) => {
    if (!bin_step || bin_step <= 0) return { error: "bin_step is required and must be > 0" };
    const stepPct = bin_step / 10000; // e.g. 100 → 0.01 (1%)
    if (price_range_pct != null) {
      // Convert % range to bin count
      const pct = Math.abs(price_range_pct) / 100;
      const bins = Math.abs(Math.ceil(Math.log(1 - pct) / Math.log(1 + stepPct)));
      const actualPct = (1 - Math.pow(1 + stepPct, -bins)) * 100;
      return { bin_step, price_range_pct: Math.abs(price_range_pct), bins_needed: bins, actual_range_pct: Math.round(actualPct * 100) / 100, wide_range: bins > 69, per_bin_pct: Math.round(stepPct * 10000) / 100 };
    }
    if (bin_count != null) {
      // Convert bin count to % range
      const pct = (1 - Math.pow(1 + stepPct, -bin_count)) * 100;
      return { bin_step, bin_count, range_pct: Math.round(pct * 100) / 100, wide_range: bin_count > 69, per_bin_pct: Math.round(stepPct * 10000) / 100 };
    }
    // Just show per-bin info
    return { bin_step, per_bin_pct: Math.round(stepPct * 10000) / 100, example_50pct_bins: Math.ceil(Math.log(0.5) / Math.log(1 + stepPct)) };
  },
  pin_lesson: ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: process.cwd(), encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: "inherit",
          cwd: process.cwd(),
        });
        child.unref();
        process.exit(0);
      }, 3000);
      return { success: true, updated: true, message: `Updated! Restarting in 3s...\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  remember_fact: ({ nugget, key, value }) => rememberFact(nugget, key, value),
  recall_memory: ({ query, nugget }) => recallMemory(query, nugget),
  forget_fact: ({ nugget, key }) => forgetFact(nugget, key),
  kb_read: kbRead,
  kb_write: kbWrite,
  kb_search: kbSearch,
  kb_list: kbList,
  kb_delete: kbDelete,
  kb_migrate: kbMigrate,
  kb_stats: kbGetStats,
  kb_rebuild_indexes: kbRebuildIndexes,
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: (args) => {
    // Support 3 formats:
    // 1. { setting: "key", value: val, reason } — single setting (preferred)
    // 2. { changes: { key: val, ... }, reason } — nested batch
    // 3. { key: val, reason } — flat batch
    let changes, reason;
    if (args.setting && args.value !== undefined) {
      // Strip section prefix if model passes "management.managementIntervalMin" instead of "managementIntervalMin"
      const key = args.setting.includes(".") ? args.setting.split(".").pop() : args.setting;
      changes = { [key]: args.value };
      reason = args.reason;
    } else if (args.changes && typeof args.changes === "object") {
      changes = args.changes;
      reason = args.reason;
    } else {
      const { reason: r, ...rest } = args;
      changes = rest;
      reason = r;
    }
    const applied = {};
    const unknown = [];

    for (const [key, val] of Object.entries(changes)) {
      if (!CONFIG_KEY_MAP[key]) { unknown.push(key); continue; }
      // Coerce numeric strings to numbers (model sometimes passes "5" instead of 5)
      const coerced = typeof val === "string" && /^-?\d+(\.\d+)?$/.test(val) ? Number(val) : val;
      applied[key] = coerced;
    }

    if (Object.keys(applied).length === 0) {
      return { success: false, unknown, reason };
    }

    // Apply to live config immediately
    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_KEY_MAP[key];
      const before = config[section][field];
      config[section][field] = val;
      log("config", `update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`);
    }

    // Persist to user-config.json
    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /**/ }
    }
    Object.assign(userConfig, applied);
    userConfig._lastAgentTune = new Date().toISOString();
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

    // Restart cron jobs if intervals changed
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null || applied.pnlWatcherIntervalSec != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`);
    }

    // Save as a lesson — but skip ephemeral per-deploy interval changes
    // (managementIntervalMin / screeningIntervalMin change every deploy based on volatility;
    //  the rule is already in the system prompt, storing it 75+ times is pure noise)
    const lessonsKeys = Object.keys(applied).filter(
      k => k !== "managementIntervalMin" && k !== "screeningIntervalMin" && k !== "pnlWatcherIntervalSec"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
  "kb_write",
  "kb_delete",
  "kb_migrate",
  // update_config changes live risk params (maxDeployAmount, maxPositions, stop loss,
  // trailing, intervals) — route it through the write-safety path for bounded validation.
  "update_config",
]);

// Sane bounded ranges for risk-relevant config keys. Any update_config change that
// targets one of these keys with an out-of-range (or non-numeric) value is rejected
// before it can touch live config. Keys not listed here keep their existing behavior.
const RISK_CONFIG_BOUNDS = {
  maxDeployAmount: { min: 0, max: 100 },        // SOL per position
  maxPositions: { min: 1, max: 50, integer: true },
  stopLossPct: { min: 0, max: 100 },            // percent loss
  trailingTriggerPct: { min: 0, max: 1000 },    // percent gain to arm trailing
  trailingDropPct: { min: 0, max: 100 },        // percent drop from peak to exit
  managementIntervalMin: { min: 1, max: 1440, integer: true },
  screeningIntervalMin: { min: 1, max: 1440, integer: true },
  pnlWatcherIntervalSec: { min: 5, max: 86400, integer: true },
};

/**
 * Validate the risk-relevant keys inside an update_config call against bounded ranges.
 * Returns { pass: true } or { pass: false, reason }. Boolean toggles (e.g.
 * trailingTakeProfit) are left to update_config's own handling; only numeric
 * risk levers are range-checked here.
 */
function validateConfigUpdate(args) {
  // Normalize into a flat { key: value } map matching update_config's own parsing.
  let changes;
  if (args.setting && args.value !== undefined) {
    const key = args.setting.includes(".") ? args.setting.split(".").pop() : args.setting;
    changes = { [key]: args.value };
  } else if (args.changes && typeof args.changes === "object") {
    changes = args.changes;
  } else {
    const { reason: _r, ...rest } = args;
    changes = rest;
  }

  for (const [key, rawVal] of Object.entries(changes)) {
    const bounds = RISK_CONFIG_BOUNDS[key];
    if (!bounds) continue;
    // Coerce numeric strings the same way update_config does.
    const val = typeof rawVal === "string" && /^-?\d+(\.\d+)?$/.test(rawVal) ? Number(rawVal) : rawVal;
    if (typeof val !== "number" || !Number.isFinite(val)) {
      return { pass: false, reason: `update_config rejected: ${key} must be a finite number, got ${JSON.stringify(rawVal)}.` };
    }
    if (bounds.integer && !Number.isInteger(val)) {
      return { pass: false, reason: `update_config rejected: ${key} must be an integer, got ${val}.` };
    }
    if (val < bounds.min || val > bounds.max) {
      return { pass: false, reason: `update_config rejected: ${key}=${val} is outside the allowed range [${bounds.min}-${bounds.max}].` };
    }
  }
  return { pass: true };
}

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── USDC-mode entry: fund the deploy from USDC ───
  // Runs BEFORE safety checks/execution so we only swap USDC→SOL once the
  // deploy is known to be eligible (no swap-then-block left holding SOL).
  if (name === "deploy_position" && usdcModeEnabled()) {
    const elig = await checkDeployEligibility(args);
    if (!elig.pass) {
      log("safety_block", `deploy_position blocked (usdc preflight): ${elig.reason}`);
      return { blocked: true, reason: elig.reason };
    }
    const entry = await prepareUsdcEntry({ amountUsd: args.amount_usd });
    if (!entry.ok) {
      log("usdc", `Entry blocked: ${entry.reason}`);
      if (entry.gas_low) emit("gas_low", { reason: entry.reason });
      return { blocked: true, reason: entry.reason, gas_low: !!entry.gas_low };
    }
    // Force single-sided SOL deposit — in USDC mode we only acquire SOL.
    args.amount_y = entry.amount_y;
    args.amount_sol = entry.amount_y;
    args.amount_x = 0;
    args.strategy = "bid_ask";
    args.bins_above = 0;
    if (args.initial_value_usd == null) args.initial_value_usd = entry.usd_spent;
    log("usdc", `Entry funded: deploying ${entry.amount_y} SOL (~$${entry.usd_spent})${entry.dry_run ? " [DRY RUN]" : ""}`);
  }

  // ─── Pre-execution safety checks ──────────
  if (WRITE_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "deploy_position") {
        emit("deploy", { pair: args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, amountUsd: usdcModeEnabled() ? (args.initial_value_usd ?? null) : null, position: result.position, tx: result.tx });
      } else if (name === "close_position") {
        emit("close", { pair: args.position_address?.slice(0, 8), pnlUsd: result.pnl_usd ?? 0, pnlSol: result.pnl_sol ?? null, pnlPct: result.pnl_pct ?? 0 });
        // USDC mode: auto-settle recovered base token + surplus SOL back to USDC.
        if (usdcModeEnabled()) {
          try {
            const settle = await settleToUsdc();
            result.usdc_settled = settle;
            log("usdc", `Post-close settle: ${settle.settled ?? 0} swap(s) to USDC${settle.dry_run ? " [DRY RUN]" : ""}`);
          } catch (e) {
            log("usdc", `Post-close settle failed: ${e.message}`);
            result.usdc_settle_error = e.message;
          }
        }
      }

      // ─── Capture screening signals from tool results ────────
      try {
        captureToolSignals(name, args, result);
      } catch { /* signal capture is best-effort */ }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Amount-independent deploy eligibility checks (bin step, position count,
 * duplicate pool/token). Shared between the USDC-mode entry preflight and the
 * standard safety checks so USDC mode never swaps before confirming the deploy
 * is even allowed.
 */
async function checkDeployEligibility(args) {
  // Resolve bin_step — fall back to the pool detail API if the caller didn't pass it.
  let effectiveBinStep = args.bin_step;
  if (effectiveBinStep == null && args.pool_address) {
    try {
      const { getPoolDetail } = await import("./screening.js");
      const poolDetail = await getPoolDetail({ pool_address: args.pool_address });
      effectiveBinStep = poolDetail?.bin_step ?? null;
    } catch {
      effectiveBinStep = null;
    }
  }

  // Reject pools with bin_step out of configured range. Fail closed: if we could
  // not resolve a numeric bin_step (caller omitted it AND the pool detail lookup
  // failed / lacked it), block the deploy rather than skip the risk limit.
  const minStep = config.screening.minBinStep;
  const maxStep = config.screening.maxBinStep;
  if (typeof effectiveBinStep !== "number" || !Number.isFinite(effectiveBinStep)) {
    return {
      pass: false,
      reason: `Could not resolve bin_step for pool ${args.pool_address ?? "(unknown)"}; cannot verify it is within the allowed range [${minStep}-${maxStep}]. Provide bin_step explicitly.`,
    };
  }
  if (effectiveBinStep < minStep || effectiveBinStep > maxStep) {
    return {
      pass: false,
      reason: `bin_step ${effectiveBinStep} is outside the allowed range of [${minStep}-${maxStep}].`,
    };
  }

  // Check position count limit + duplicate pool guard
  const positions = await getMyPositions();
  if (positions.total_positions >= config.risk.maxPositions) {
    return {
      pass: false,
      reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
    };
  }
  const alreadyInPool = positions.positions.some((p) => p.pool === args.pool_address);
  if (alreadyInPool) {
    return {
      pass: false,
      reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
    };
  }

  // Block same base token across different pools
  if (args.base_mint) {
    const alreadyHasMint = positions.positions.some((p) => p.base_mint === args.base_mint);
    if (alreadyHasMint) {
      return {
        pass: false,
        reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
      };
    }
  }

  return { pass: true };
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      const elig = await checkDeployEligibility(args);
      if (!elig.pass) return elig;

      const usdc = usdcModeEnabled();

      // Check amount limits
      const amountY = args.amount_y ?? args.amount_sol ?? 0;
      if (amountY <= 0 && (!args.amount_x || args.amount_x <= 0)) {
        return {
          pass: false,
          reason: `Must provide a positive amount for either SOL (amount_y) or base token (amount_x).`,
        };
      }

      // Enforce minimum deploy amount. In USDC mode the USD floor is enforced
      // in the entry preflight, so skip the SOL floor (a small $ deploy can be
      // < 0.1 SOL and that's intentional).
      if (!usdc) {
        const minDeploy = Math.max(0.1, config.management.deployAmountSol);
        if (amountY < minDeploy) {
          return {
            pass: false,
            reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
          };
        }
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // Check SOL balance — must have enough to deploy + gas reserve.
      // In USDC mode the USDC→SOL swap has already run, so the acquired SOL is present.
      const balance = await getWalletBalances();
      const gasReserve = usdc ? config.usdc.gasReserveSol : (config.management.gasReserve ?? 0.05);
      const minRequired = getRequiredSolBalance({ deployAmountSol: amountY, gasReserve });
      if (balance.sol < minRequired) {
        return {
          pass: false,
          reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas).`,
        };
      }

      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    case "update_config":
      return validateConfigUpdate(args);

    default:
      return { pass: true };
  }
}

/**
 * Capture screening-relevant signals from tool results and merge into staged signals.
 * Called after each successful tool execution — only acts on tools that produce signal data.
 */
function captureToolSignals(name, args, result) {
  switch (name) {
    case "check_smart_wallets_on_pool": {
      const pool = args.pool_address;
      if (!pool) break;
      updateStagedSignals(pool, {
        smart_wallets_present: !!result.confidence_boost,
      });
      break;
    }

    case "get_token_narrative": {
      const mint = args.mint;
      if (!mint) break;
      const pool = getPoolForMint(mint);
      if (!pool) break;
      // Infer narrative quality from whether a narrative string was returned
      let quality = "skip";
      if (result.narrative && typeof result.narrative === "string" && result.narrative.trim().length > 0) {
        quality = "good";
      } else if (result.status === "none" || result.narrative === null) {
        quality = "bad";
      }
      updateStagedSignals(pool, {
        narrative_quality: quality,
      });
      break;
    }

    case "study_top_lpers":
    case "get_top_lpers": {
      const pool = args.pool_address;
      if (!pool) break;
      const winRate = result.patterns?.avg_win_rate;
      if (winRate != null) {
        updateStagedSignals(pool, {
          study_win_rate: winRate,
        });
      }
      break;
    }

    case "get_token_holders": {
      const mint = args.mint;
      if (!mint) break;
      const pool = getPoolForMint(mint);
      if (!pool) break;
      updateStagedSignals(pool, {
        holder_count: result.total_fetched ?? null,
        top_10_holders_pct: result.top_10_real_holders_pct != null
          ? parseFloat(result.top_10_real_holders_pct)
          : null,
        bundlers_pct: result.bundlers_pct_in_top_100 != null
          ? parseFloat(result.bundlers_pct_in_top_100)
          : null,
      });
      break;
    }

    // No default needed — other tools are silently ignored
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
