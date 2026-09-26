import "dotenv/config";
import fs from "fs";
import path from "path";
import cron from "node-cron";
import readline from "readline";
import { agentLoop, lightChat, getScreenerModelLabel, screenerLoop } from "./agent.js";
import { log, enableLogPathFile } from "./logger.js";
import { getMyPositions, isCloseInflight, getInflightCloses } from "./tools/dlmm.js";
import { llmHealth, isLlmUnavailableError } from "./llm-health.js";
import { runManagementWithOorFallback, formatOorFallbackReport } from "./oor-fallback.js";
import { getPositionBins } from "./tools/bin-visual.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates, rankCandidatesByDarwin, getPoolDetail, formatCandidateSources } from "./tools/screening.js";
import { config, reloadScreeningThresholds, computeDeployAmount, resolveDeploySizing, persistUserConfig, persistGmgnConfig, LOCKED_KEYS, INTEGER_KEYS, DRY_RUN_SET_IN_ENV } from "./config.js";
import { createAllSettings } from "./all-settings.js";
import { normalizeEntryFilterValue, isLooseningChange } from "./tools/entry-safety.js";
import { applyTradingSettings } from "./trading-settings.js";
import { evolveThresholds, getPerformanceSummary, deduplicateLessons } from "./lessons.js";
import { registerCronRestarter, executeTool } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, sendHTML, editHTML, answerCallback, setMyCommands, isEnabled as telegramEnabled } from "./telegram.js";
import { createTelegramUI, BOT_COMMANDS, readRecentErrors } from "./telegram-ui.js";
import { lookupToken, parseMint } from "./tools/token-lookup.js";
import { isScreeningPaused, setScreeningPaused } from "./state.js";
import { usdcModeEnabled } from "./tools/usdc-mode.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate } from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { updatePnlAndCheckExits, getTrackedPosition } from "./state.js";
import { emit, on } from "./notifier.js";
import { stageSignals } from "./signal-tracker.js";
import { getWeightsSummary } from "./signal-weights.js";
import { startPnlWatcher, stopPnlWatcher, isPnlTickRunning } from "./pnl-watcher.js";
import { createShutdownController, installCrashHandlers, drainTimeoutMsFromEnv } from "./shutdown.js";
import { recordPositionSnapshot as recordPoolSnapshot, recallForPool } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenHolders, getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { fetchGmgnPriceInfo, fetchGmgnSignal } from "./tools/gmgn.js";
import { getOhlcvDepth } from "./tools/ohlcv.js";
import { formatGmgnSignalsLine, gmgnSignalSnapshotFields, GMGN_MARKET_SIGNALS_GUIDE } from "./tools/gmgn-signals.js";
import {
  sessionHistory, appendHistory, getHistory,
  isBusy, setBusy,
  isManagementBusy, setManagementBusy,
  isScreeningBusy, setScreeningBusy,
  setManagementCloseReasons,
  clearManagementCloseReasons,
  isDraining, setDraining, getInflightOps,
} from "./session.js";
import { startServer } from "./server.js";
import { buildSettingsReport } from "./settings-report.js";
import { handleAutoresearchCommand, autoresearchTelegramChunks } from "./autoresearch.js";
import { getScreeningThresholdSummary, getStartupMode, screeningCronGate } from "./runtime-helpers.js";
import { getRangeSelectionText, evilPandaCandidateText, evilPandaGuideLine, buildManagementGoal, formatRunnerPrecheck } from "./prompt.js";
import { shouldFileObservations, getKbStats, migrateFromJson, kbRecallForScreening, kbRecallForManagement, fileScreeningResult } from "./knowledge-base.js";

log("startup", "DLMM LP Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${config.llm.managementModel} (provider: ${process.env.LLM_PROVIDER || "openrouter"})`);

// Crash handlers first, so a throw anywhere below is logged, alerted and exits 1
// (the launchd supervisor restarts on a non-zero exit). The alert is resolved
// lazily: Telegram may not be configured, and is only usable once loaded.
installCrashHandlers({
  alert: async (msg) => { if (telegramEnabled()) await sendMessage(msg); },
});

// Let operators find this process and its log without guessing (ops/README.md).
const PID_FILE = path.join("logs", "bot.pid");
try {
  fs.mkdirSync("logs", { recursive: true });
  fs.writeFileSync(PID_FILE, `${process.pid}\n`);
  enableLogPathFile(path.join("logs", "bot.logpath"));
} catch (e) {
  log("startup_warn", `Could not write logs/bot.pid / logs/bot.logpath: ${e.message}`);
}

// One-time lesson dedup on startup
deduplicateLessons();

// Auto-migrate existing JSON data to knowledge base on first run
if (config.knowledgeBase?.enabled) {
  const kbDir = config.knowledgeBase.dir || "./knowledge";
  if (!fs.existsSync(path.join(kbDir, "INDEX.md"))) {
    const hasData = fs.existsSync("./lessons.json") || fs.existsSync("./pool-memory.json");
    if (hasData) {
      log("kb", "Knowledge base not found — running initial migration...");
      migrateFromJson().then(r => {
        log("kb", `Initial migration complete: ${r.created} articles created, ${r.skipped} skipped`);
      }).catch(e => log("kb", `Initial migration failed: ${e.message}`));
    }
  }
}

const TP_PCT  = config.management.takeProfitFeePct;

// Human-readable "how much to deploy" directive, mode-aware. In USDC mode the
// agent thinks in USD and the executor auto-funds the SOL from USDC.
function deployDirective() {
  return usdcModeEnabled()
    ? `$${config.usdc.deployAmountUsd} (USD — the system auto-swaps USDC→SOL to fund it)`
    : `${config.management.deployAmountSol} SOL`;
}

// Toggle USDC mode in live config and persist to user-config.json.
// Shared by the CLI `/usdc` command and the Telegram `/usdc` command.
async function setUsdcMode(enabled) {
  config.usdc.enabled = !!enabled;
  try {
    persistUserConfig({ usdcMode: config.usdc.enabled });
  } catch (e) {
    log("config", `Failed to persist usdcMode: ${e.message}`);
  }
  log("config", `USDC mode ${config.usdc.enabled ? "ENABLED" : "DISABLED"}`);
}

// Plain-text USDC-mode status block (used by CLI and Telegram).
function usdcStatusText() {
  if (!config.usdc.enabled) {
    return "💵 USDC mode: OFF\nToggle with: /usdc on";
  }
  return [
    "💵 USDC mode: ON",
    `Deploy:       $${config.usdc.deployAmountUsd} per position`,
    `Max/position: $${config.usdc.maxDeployUsd}`,
    `Min to open:  $${config.usdc.minUsdcToOpen} USDC`,
    `Gas reserve:  ${config.usdc.gasReserveSol} SOL (warn-only, no auto top-up)`,
    "Toggle with: /usdc off",
  ].join("\n");
}

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = isManagementBusy()
    ? "running"
    : formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = isScreeningBusy()
    ? "running"
    : formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    deduplicateLessons();
    const briefing = await generateBriefing();
    emit("briefing", { html: briefing });
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return;

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  _cronTasks = [];
  stopPnlWatcher();
}

// With no open positions, management relaxes to the idle cadence (10 min). This used
// to be a MANDATORY prompt step after every close; it is a fixed rule, so run it here.
const IDLE_MANAGEMENT_INTERVAL_MIN = 10;
async function resetIdleManagementInterval() {
  if (config.schedule.managementIntervalMin === IDLE_MANAGEMENT_INTERVAL_MIN) return;
  // Re-read uncached so a stale positions cache can't relax cadence while a position is open.
  const fresh = await getMyPositions({ force: true }).catch(() => null);
  if (!fresh || fresh.error || fresh.positions?.length) return;
  await executeTool("update_config", {
    setting: "managementIntervalMin",
    value: IDLE_MANAGEMENT_INTERVAL_MIN,
    reason: "no open positions",
  });
}

// Screening cycle, shared by the cron and Telegram's "Run screening now".
// The gate (runtime-helpers screeningCronGate) is checked synchronously and the
// screening lock taken BEFORE any await, so a cron tick, Telegram command or web
// request can't slip in between. The operator pause (state.json) only stops the
// scheduled cron; management and the PnL watcher never look at it.
// Counts deploy/close events from any path so a cycle can tell whether it
// actually moved funds. Cycle reports are only "routine" (not pushed to
// Telegram; still visible under Status) when nothing happened.
let _fundEvents = 0;
on("deploy", () => { _fundEvents++; });
on("close", () => { _fundEvents++; });

function runScreeningCycle({ manual = false } = {}) {
  if (isDraining()) {
    return { started: false, reason: "shutting down", done: Promise.resolve(null) };
  }
  const gate = screeningCronGate({
    paused: isScreeningPaused(),
    busy: isBusy(),
    screeningBusy: isScreeningBusy(),
    managementBusy: isManagementBusy(),
    manual,
  });
  if (!gate.run) {
    if (gate.touchTimer) timers.screeningLastRun = Date.now();
    if (gate.reason !== "a screening cycle is already running") log("cron", `Screening skipped — ${gate.reason}`);
    return { started: false, reason: gate.reason, done: Promise.resolve(null) };
  }
  setScreeningBusy(true);
  timers.screeningLastRun = Date.now();
  if (manual) log("cron", "Screening cycle triggered manually (Telegram)");
  return { started: true, reason: null, done: screeningCycleBody() };
}

async function screeningCycleBody() {
  let screenReport = null;
  let screenFailed = false;
  let screenRoutine = false;
  const fundEventsBefore = _fundEvents;
  try {
    // No deploys without the LLM. While a recent call failed, skip with one line
    // instead of pre-loading candidates only to hit the same provider error.
    // llmHealth lets a cycle probe again after LLM_PROBE_INTERVAL_MS.
    if (llmHealth.isUnavailable()) {
      const outage = llmHealth.getOutage();
      log("cron", `Screening skipped — LLM unavailable (${String(outage?.reason || "").slice(0, 200)}${outage?.resetText ? `; resets ${outage.resetText}` : ""})`);
      return;
    }

    // Hard guards — don't even run the agent if preconditions aren't met
    let preCheckPositions;
    try {
      const [positions, balance] = await Promise.all([getMyPositions(), getWalletBalances()]);
      preCheckPositions = positions;
      if (positions.total_positions >= config.risk.maxPositions) {
        log("cron", `Screening skipped — max positions reached (${positions.total_positions}/${config.risk.maxPositions})`);
        return;
      }
      if (usdcModeEnabled()) {
        // Warn-only gas reserve: don't auto top-up, just pause + alert.
        if (balance.sol < config.usdc.gasReserveSol) {
          log("cron", `Screening skipped — SOL ${balance.sol.toFixed(4)} below gas reserve ${config.usdc.gasReserveSol}`);
          emit("gas_low", { sol: balance.sol, reserve: config.usdc.gasReserveSol });
          return;
        }
        if ((balance.usdc ?? 0) < config.usdc.minUsdcToOpen) {
          log("cron", `Screening skipped — insufficient USDC ($${(balance.usdc ?? 0).toFixed(2)} < $${config.usdc.minUsdcToOpen})`);
          return;
        }
      } else if (balance.sol < config.management.minSolToOpen) {
        log("cron", `Screening skipped — insufficient SOL (${balance.sol.toFixed(3)} < ${config.management.minSolToOpen})`);
        return;
      }
    } catch (e) {
      log("cron_error", `Screening pre-check failed: ${e.message}`);
      return;
    }

    const screenModel = getScreenerModelLabel();
    log("cron", `Starting screening cycle [model: ${screenModel}]`);
    // Deploy size from the whole portfolio (free SOL + open positions, just
    // fetched above) or the free wallet (positionSizeBase), capped by free SOL.
    // USDC mode sizes in USD (deployAmountUsd), so the SOL figure there is only a placeholder.
    const currentBalance = await getWalletBalances().catch((e) => ({ error: e.message }));
    const sizing = usdcModeEnabled() ? null : await resolveDeploySizing({ wallet: currentBalance, positions: preCheckPositions });
    if (sizing?.skip) {
      log("cron", `Screening skipped — ${sizing.reason}`);
      return;
    }
    const deployAmount = sizing ? sizing.amount : config.management.deployAmountSol;
    const sizingNote = sizing ? ` (${sizing.label})` : "";
    log("cron", `Computed deploy amount: ${sizing ? sizing.label : `USDC mode, $${config.usdc.deployAmountUsd}`} (wallet: ${currentBalance?.sol ?? "?"} SOL)`);

    // Load saved strategies for reference (LLM picks per token)
    const activeStrategy = getActiveStrategy();
    const strategyBlock = activeStrategy
      ? `\nSAVED STRATEGY (reference, not mandatory): ${activeStrategy.name} — ${activeStrategy.lp_strategy}, best for: ${activeStrategy.best_for}`
      : "";

    // Pre-load top 3 candidates with recon data in parallel
    let candidateBlocks = "";
    let loadedCandidates = [];
    const hardSkipped = [];
    try {
      const result = await getTopCandidates({ limit: 5 });
      const candidates = result?.candidates || [];
      loadedCandidates = candidates;
      // Fetch dynamic fees sequentially to avoid RPC rate limit bursts
      const { fetchDynamicFee } = await import("./tools/screening.js");
      const ohlcvDepthOn = config.strategy.rangeDepthMode === "ohlcv" && config.strategy.activeStrategy !== "evil_panda";
      const dynFeeMap = {};
      for (const c of candidates) {
        dynFeeMap[c.pool] = await fetchDynamicFee(c.pool);
      }
      const blocks = await Promise.allSettled(candidates.map(async (c) => {
        const baseMint = c.base_mint || c.base?.mint || null;
        const [sw, holders, narrative, poolMem, tokenInfo, gmgnData, gmgnSignal] = await Promise.allSettled([
          checkSmartWalletsOnPool({ pool_address: c.pool }),
          baseMint ? getTokenHolders({ mint: baseMint }) : null,
          baseMint ? getTokenNarrative({ mint: baseMint }) : null,
          recallForPool(c.pool),
          baseMint ? getTokenInfo({ query: baseMint }) : null,
          baseMint ? fetchGmgnPriceInfo(baseMint) : null,
          baseMint ? fetchGmgnSignal(baseMint) : null,
        ]);
        const swResult = sw.status === "fulfilled" ? sw.value : null;
        const holdResult = holders.status === "fulfilled" ? holders.value : null;
        const narrResult = narrative.status === "fulfilled" ? narrative.value : null;
        const memResult = poolMem.status === "fulfilled" ? poolMem.value : null;
        const infoResult = tokenInfo.status === "fulfilled" ? tokenInfo.value : null;
        const gmgnResult = gmgnData.status === "fulfilled" ? gmgnData.value : null;
        const gmgnSignalResult = gmgnSignal.status === "fulfilled" ? gmgnSignal.value : null;
        c._gmgnResult = gmgnResult;  // attach to candidate for signal staging
        c._gmgnSignal = gmgnSignalResult;
        // Candle-based range depth (tools/ohlcv.js). Token age from GMGN picks the timeframe tier.
        if (ohlcvDepthOn) {
          const od = await getOhlcvDepth({ pool: c.pool, mint: baseMint, ageHours: c.token_age_hours ?? gmgnResult?.token_age_hours ?? null }).catch(() => null);
          c.ohlcv_depth = od ? { depthPct: od.depthPct, basis: od.short } : null;
        }
        const dynFeeResult = dynFeeMap[c.pool] || null;
        const tokenData = infoResult?.results?.[0];
        const smartWalletCount = swResult?.in_pool?.length || 0;
        c._smartWalletCount = smartWalletCount;
        c._globalFeesSol = holdResult?.global_fees_sol ?? null;
        c._top10Pct = holdResult?.top_10_real_holders_pct != null ? Number(holdResult.top_10_real_holders_pct) : null;

        let block = `[${c.name}] pool: ${c.pool} | darwin: ${c.darwin_score ?? "?"}/100 | bin_step: ${c.bin_step} | fee/aTVL: ${c.fee_active_tvl_ratio}% | vol: $${c.volume} | organic: ${c.organic_score} | holders: ${c.holders} | volatility: ${c.volatility ?? "?"}`;
        block += ` | token_age: ${c.token_age_hours != null ? `${c.token_age_hours}h (${c.token_age_source ?? "?"})` : "unknown"}`;
        if (c.jupiter) block += ` | jup_organic: ${c.jupiter.organic_score ?? "?"}/100 | jup_verified: ${c.jupiter.verified ?? "?"}`; // Jupiter Tokens API, informational
        if (ohlcvDepthOn) block += ` | ohlcv_depth: ${c.ohlcv_depth ? `${c.ohlcv_depth.depthPct}% (${c.ohlcv_depth.basis})` : "n/a (use volatility table)"}`;
        const srcTag = formatCandidateSources(c);
        if (srcTag) block += ` | ${srcTag}`;

        if (Array.isArray(c.darwin_top_signals) && c.darwin_top_signals.length > 0) {
          const topSignals = c.darwin_top_signals
            .map((s) => `${s.signal}=${s.value} (${s.direction})`)
            .join(", ");
          block += `\n  Darwin context: higher score = better fit to learned winning signals. Top drivers: ${topSignals}`;
        }

        if (dynFeeResult) block += ` | base_fee: ${c.fee_pct}% | dynamic_fee: ${dynFeeResult.dynamic_fee_pct}%`;
        if (tokenData) {
          if (tokenData.mcap) block += ` | mcap: $${(tokenData.mcap / 1000).toFixed(0)}k`;
          if (tokenData.stats_1h?.price_change) block += ` | 1h: ${tokenData.stats_1h.price_change}%`;
        }
        // GMGN token signals (screeningSource gmgn/both): KOL / smart money / indicators.
        if (c.gmgn) {
          const kolNames = c.gmgn_kol_names?.length ? ` (${c.gmgn_kol_names.slice(0, 3).join(", ")})` : "";
          const ind = c.indicators ? ` | supertrend=${c.indicators.supertrendDirection ?? "?"} rsi=${c.indicators.rsi ?? "?"}` : "";
          block += `\n  GMGN screen: smart=${c.gmgn_smart_wallets ?? "?"} kol=${c.gmgn_kol_wallets ?? "?"}${kolNames}${c.gmgn_dump_kol_significant ? ` dump_kol=${c.gmgn_dump_kol_significant}` : ""}${ind}`;
        }
        if (smartWalletCount > 0) block += `\n  Smart wallets: ${smartWalletCount} found`;
        else block += `\n  Smart wallets: none`;
        if (holdResult?.global_fees_sol != null) block += ` | global_fees: ${holdResult.global_fees_sol} SOL`;
        if (holdResult?.top_10_real_holders_pct != null) block += ` | top10: ${holdResult.top_10_real_holders_pct}%`;
        if (narrResult?.narrative) block += `\n  Narrative: ${narrResult.narrative.slice(0, 500)}`;
        if (memResult) block += `\n  Memory: ${memResult}`;
        if (gmgnResult) {
          block += ` | ath: ${gmgnResult.ath_proximity_pct ?? "?"}%`;
          block += ` | momentum: 5m=${gmgnResult.change_5m ?? "?"}% 1h=${gmgnResult.change_1h ?? "?"}%`;
          block += ` | token24hVol: $${Math.round(gmgnResult.volume_24h ?? 0)} | tokenMcap: $${Math.round(gmgnResult.market_cap ?? 0)}`;
          if (gmgnResult.candles) {
            const epPass = gmgnResult.volume_24h >= (config.strategy.evilPanda?.minTokenVolume24h ?? 750000)
              && gmgnResult.market_cap >= (config.strategy.evilPanda?.minMcap ?? 200000)
              && gmgnResult.candles.evil_panda_entry_ok;
            c._evilPandaPass = !!epPass;
            block += evilPandaCandidateText(epPass, gmgnResult.candles);
          }
          if (gmgnResult.ath_proximity_pct != null && gmgnResult.ath_proximity_pct >= config.screening.athTopThresholdPct) {
            block += `\n  ATH WARNING: ${gmgnResult.ath_proximity_pct}% of ATH (>=${config.screening.athTopThresholdPct}%) — override bid_ask range to 65-80%`;
          }
          if (gmgnResult.change_1h > 10 && gmgnResult.change_5m < -2) {
            block += `\n  MOMENTUM WARNING: pump fading (1h +${gmgnResult.change_1h}%, 5m ${gmgnResult.change_5m}%) — widen range or consider skipping`;
          }
        }
        if (gmgnSignalResult) {
          block += `\n  GMGN signal: ${gmgnSignalResult.summary}`;
        }
        const marketSignalsLine = formatGmgnSignalsLine(c.gmgn_signals);
        if (marketSignalsLine) block += `\n  ${marketSignalsLine}`;
        return { pool: c.pool, block };
      }));
      const rankedCandidates = rankCandidatesByDarwin(candidates);
      loadedCandidates = rankedCandidates;
      const blockMap = new Map(
        blocks
          .filter((b) => b.status === "fulfilled")
          .map((b) => [b.value.pool, b.value.block])
      );
      // Hard skips are threshold checks on pre-loaded data: drop failing candidates in
      // code so the model only judges the survivors (narrative, momentum, pick-or-skip).
      // Unknown values (null) never cause a skip here; the model still sees them.
      const hardSkipReason = (c) => {
        if (c._globalFeesSol != null && c._globalFeesSol < config.screening.minTokenFeesSol) return `global_fees ${c._globalFeesSol} SOL < ${config.screening.minTokenFeesSol}`;
        if (Number.isFinite(c._top10Pct) && c._top10Pct > 60) return `top10 ${c._top10Pct}% > 60%`;
        if (config.strategy.activeStrategy === "evil_panda" && c._evilPandaPass === false) return "Evil Panda entry FAIL";
        return null;
      };
      const survivors = [];
      for (const c of rankedCandidates) {
        const reason = hardSkipReason(c);
        if (reason) hardSkipped.push(`${c.name}: ${reason}`);
        else survivors.push(c);
      }
      if (hardSkipped.length > 0) log("cron", `Screening hard-skipped in code: ${hardSkipped.join("; ")}`);
      const validBlocks = survivors
        .map((c) => blockMap.get(c.pool))
        .filter(Boolean);
      if (validBlocks.length > 0) {
        candidateBlocks = `\n\nPRE-LOADED CANDIDATES (recon already done — evaluate and deploy the best one):\nDarwin score is a learned 0-100 ranking over the current shortlist. Higher = stronger fit to historically winning signal patterns. Use it as a ranking aid, not a hard deploy rule.\n${validBlocks.join("\n\n")}\n`;
      }
      // Stage signals for each candidate so deploy can snapshot them
      for (const c of rankedCandidates) {
        try {
          stageSignals(c.pool, {
            organic_score: c.organic_score ?? null,
            fee_tvl_ratio: c.fee_active_tvl_ratio ?? null,
            volume: c.volume ?? null,
            volatility: c.volatility ?? null,
            mcap: c.mcap ?? null,
            holder_count: c.holders ?? null,
            smart_wallets_present: (c._smartWalletCount || 0) > 0,
            narrative_quality: null, // filled by tool signal capture in executor
            study_win_rate: null,    // filled by tool signal capture in executor
            ath_proximity: c._gmgnResult?.ath_proximity_pct ?? null,
            // New Darwinian signals
            volume_trend: c._gmgnResult?.candles?.volume_trend ?? null,
            gmgn_signal_present: (c._gmgnSignal?.signal_count_30m || 0) > 0,
            change_1h: c._gmgnResult?.change_1h ?? null,
            candle_price_range: c._gmgnResult?.candles?.price_range_pct ?? null,
            token_volume_24h: c._gmgnResult?.volume_24h ?? null,
            token_market_cap: c._gmgnResult?.market_cap ?? null,
            supertrend_green: c._gmgnResult?.candles?.supertrend_green ?? null,
            rsi_2: c._gmgnResult?.candles?.rsi_2 ?? null,
            // Extra GMGN signal metadata (not weighted but stored for analysis)
            gmgn_signal_count_30m: c._gmgnSignal?.signal_count_30m ?? null,
            gmgn_signal_count_2h: c._gmgnSignal?.signal_count_2h ?? null,
            gmgn_signal_amount_30m: c._gmgnSignal?.signal_amount_usd_30m ?? null,
            gmgn_signal_amount_2h: c._gmgnSignal?.signal_amount_usd_2h ?? null,
            gmgn_latest_signal_age_min: c._gmgnSignal?.latest_signal_age_min ?? null,
            gmgn_latest_sold_ratio: c._gmgnSignal?.latest_sold_ratio_percent ?? null,
            // GMGN market-signal feed: gmgn_buy_pressure / gmgn_spike (weighted) + raw counts
            ...gmgnSignalSnapshotFields(c.gmgn_signals),
          }, c.base_mint || c.base?.mint || null);
        } catch { /* staging is best-effort */ }
      }
    } catch (e) {
      log("cron", `Pre-load failed (${e.message}), agent will fetch manually`);
    }

    // Every pre-loaded candidate failed a hard skip: nothing is left to judge, and the
    // no-preload fallback would only re-fetch the same shortlist. Skip the LLM call.
    if (loadedCandidates.length > 0 && hardSkipped.length >= loadedCandidates.length) {
      screenReport = `Screening: all ${loadedCandidates.length} candidate(s) failed hard-skip rules in code — no deploy.\n${hardSkipped.map((s) => `- ${s}`).join("\n")}`;
      return screenReport; // finally{} still releases the screening lock and emits the report
    }

    // Inject Darwinian signal weights if available
    let signalWeightsBlock = "";
    try {
      const weightsSummary = getWeightsSummary();
      if (weightsSummary) {
        signalWeightsBlock = `\n\n${weightsSummary}\n`;
      }
    } catch { /* best-effort */ }

    // Pre-load KB articles relevant to candidates
    let kbScreenContext = "";
    try {
      const kbHints = kbRecallForScreening(loadedCandidates);
      if (kbHints) kbScreenContext = `\n\n${kbHints}`;
    } catch { /* best-effort */ }

    const gmgnSignalGuide = candidateBlocks
      ? `\n\nGMGN SIGNAL INTERPRETATION:\n- latest_signal_age_min lower = fresher smart-money / KOL interest\n- signal_count_30m / signal_count_2h and signal_amount_usd_30m / signal_amount_usd_2h measure recent smart-money + KOL conviction\n- latest_sold_ratio_percent lower = signal wallets are still holding; higher = signal more exhausted\n- Use GMGN signal as confirmation only, never as a standalone deploy trigger\n- Missing GMGN signal is neutral, not a hard fail\n${evilPandaGuideLine()}${loadedCandidates.some((c) => c.gmgn_signals) ? `${GMGN_MARKET_SIGNALS_GUIDE}\n` : ""}`
      : "";

    const rangeSourceLine = config.strategy.activeStrategy === "evil_panda"
      ? "Use the Evil Panda price_range_pct from the range sizing rules below — not study avg_range_pct."
      : config.strategy.rangeDepthMode === "ohlcv"
        ? "Size your price_range_pct from the candidate's ohlcv_depth (see OHLCV RANGE DEPTH below); use the VOLATILITY TABLE only when ohlcv_depth is n/a. NOT from study avg_range_pct."
        : "Size your price_range_pct from the VOLATILITY TABLE in the range selection rules below — NOT from study avg_range_pct.";
    const { content } = await screenerLoop(`
SCREENING CYCLE — DEPLOY ONLY${signalWeightsBlock}${kbScreenContext}${candidateBlocks}${gmgnSignalGuide}
${strategyBlock}
${candidateBlocks ? `The candidates above are PRE-LOADED with smart wallet, holder, narrative, memory, and GMGN signal data.
Evaluate them directly — no need to call get_top_candidates, check_smart_wallets_on_pool, get_token_holders, or get_token_narrative again.
HARD SKIP rules still apply (code has already dropped candidates whose known global_fees_sol or top_10 value fails the first two):
- global_fees_sol < ${config.screening.minTokenFeesSol} SOL → skip (bundled/scam)
- top_10_real_holders_pct > 60% OR bundlers > 30% → skip
- No smart wallets or GMGN confirmation + empty/hype narrative → skip

Pick the best candidate, then: study_top_lpers → deploy_position with ${deployAmount} SOL${sizingNote}.
${rangeSourceLine}` : `1. get_top_candidates, pick the best one.
2. check_smart_wallets_on_pool, get_token_holders (check global_fees_sol >= ${config.screening.minTokenFeesSol}), get_token_narrative.
3. HARD SKIP if global_fees_sol < ${config.screening.minTokenFeesSol} SOL or holders/narrative red flags.
4. study_top_lpers → use for strategy choice, hold times, win rates. Do NOT use avg_range_pct for your range — size from the VOLATILITY TABLE instead.
5. deploy_position with ${deployAmount} SOL${sizingNote} and price_range_pct from volatility table (adjusted by lessons)${config.strategy.rangeDepthMode === "ohlcv" ? "; deploy_position widens it to the pool's candle-based depth when that is deeper" : ""}.`}
${getRangeSelectionText(deployAmount, currentBalance?.sol)}${usdcModeEnabled()
? `\n\nUSDC MODE IS ON: deploy sizing/funding is automatic — the system swaps USDC→SOL ($${config.usdc.deployAmountUsd}/position) and deploys single-sided. Do NOT pick a SOL amount or call swap_token to prepare funds; just call deploy_position for the chosen pool.`
: ""}
    `, config.llm.maxSteps, []);
    screenReport = content;
  } catch (error) {
    if (isLlmUnavailableError(error)) {
      // The llm_unavailable alert (deduped) already tells the operator; this is a skip, not a failure.
      log("cron", `Screening skipped — ${error.message}`);
      screenReport = `Screening skipped — ${error.message}`;
      screenRoutine = true;
    } else {
      log("cron_error", `Screening cycle failed: ${error.message}`);
      screenReport = `Screening cycle failed: ${error.message}`;
      screenFailed = true;
    }
  } finally {
    setScreeningBusy(false);
    if (screenReport) {
      // A screening cycle that deployed nothing is routine: no Telegram message.
      emit("cycle:screening", { report: screenReport, routine: screenRoutine || (!screenFailed && _fundEvents === fundEventsBefore) });
      // File screening deploy to KB (direct write, no LLM)
      try { fileScreeningResult(screenReport); } catch { /* best-effort */ }
    }
  }
  return screenReport;
}

function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting
  if (isDraining()) return; // shutting down: never (re)start cycles

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (isDraining()) return;
    if (isBusy()) {
      timers.managementLastRun = Date.now();
      log("cron", "Management deferred — position action in progress");
      return;
    }
    if (isManagementBusy()) return;
    if (isScreeningBusy()) {
      timers.managementLastRun = Date.now();
      log("cron", "Management deferred — screening cycle in progress");
      return;
    }

    // Acquire the management lock BEFORE any awaited precheck so a Telegram
    // command / web request / overlapping cron can't slip in during the await.
    setManagementBusy(true);
    timers.managementLastRun = Date.now();

    // Skip management entirely if no open positions — saves LLM tokens
    try {
      const preCheck = await getMyPositions();
      if (!preCheck?.positions?.length) {
        log("cron", "Management skipped — no open positions");
        if (!preCheck?.error) await resetIdleManagementInterval().catch(() => {});
        timers.managementLastRun = Date.now();
        setManagementBusy(false);
        return;
      }
    } catch { /* proceed if check fails */ }

    log("cron", `Starting management cycle [model: ${config.llm.managementModel}]`);
    let mgmtReport = null;
    let mgmtFailed = false;
    let mgmtRuleFired = false; // a hard close rule or exit alert fired this cycle
    let fallbackSummary = null; // set when the LLM failed and the rule-4 fallback ran
    const fundEventsBefore = _fundEvents;
    try {
      // Pool context + trailing TP / stop loss pre-check
      let memoryHints = "";
      let exitAlerts = "";
      // Set only when the exit pre-check below ran to completion; the code-side
      // HOLD gate further down requires it so a partial pre-check never skips the LLM.
      let precheckedPositions = null;
      try {
        const pos = await getMyPositions();
        const exits = [];
        const holdTimeHints = [];
        for (const p of pos.positions || []) {
          // Store mid-position snapshot in pool-memory (keyed by pool address)
          if (p.pool) recordPoolSnapshot(p.pool, p);
          // Re-center shadow log (read-only, not awaited): what an in-place
          // re-center would do for an upside-OOR position. Close rules unchanged.
          if (!p.in_range && p.oor_direction === "upside") {
            import("./tools/recenter-shadow.js").then((m) => m.logRecenterShadow(p)).catch(() => {});
          }

          // Trailing TP / stop loss check
          if (p.pnl_pct != null) {
            const exitAction = updatePnlAndCheckExits(p.position, p.pnl_pct, config);
            if (exitAction) {
              exits.push(`⚠ ${p.pair}: ${exitAction}`);
              log("exit_check", `${p.pair}: ${exitAction}`);
            }
          }

          // Study hold time context — compare your age to top LPers
          if (p.study_avg_hold_hours != null) {
            const yourHours = p.age_minutes != null ? Math.round(p.age_minutes / 6) / 10 : null;
            const hint = `${p.pair}: Top LPer avg hold: ${p.study_avg_hold_hours}h (from study at deploy)`;
            holdTimeHints.push(yourHours != null ? `${hint} — your age: ${yourHours}h` : hint);
          }

          if (p.strategy_profile === "evil_panda" && p.base_mint) {
            try {
              const gmgn = await fetchGmgnPriceInfo(p.base_mint);
              const c = gmgn?.candles;
              if (c) {
                const pnlPositive = (p.pnl_pct ?? 0) > 0;
                const exitOk = pnlPositive && c.evil_panda_exit_signal;
                const line = `${p.pair}: Evil Panda exit check - pnl=${p.pnl_pct ?? "?"}% (${pnlPositive ? "positive" : "not positive"}), RSI(2)=${c.rsi_2 ?? "?"}, close>BB_upper=${!!c.close_above_bb_upper}, MACD_first_green=${!!c.macd_first_green_histogram}, exit=${exitOk ? "YES" : "NO"}${c.evil_panda_exit_reason ? ` (${c.evil_panda_exit_reason})` : ""}`;
                if (exitOk) exits.push(line);
                else holdTimeHints.push(line);
              }
            } catch { /* GMGN exit context is best-effort */ }
          }
        }
        if (exits.length > 0) {
          exitAlerts = `\n\nEXIT ALERTS (CLOSE THESE IMMEDIATELY):\n${exits.join("\n")}\n`;
        }
        if (holdTimeHints.length > 0) {
          memoryHints += `\n\nTOP LPER HOLD TIME CONTEXT:\n${holdTimeHints.join("\n")}\n`;
        }
        // Pool context from pool-memory (deploy history + live trend)
        const poolContextLines = [];
        for (const p of pos.positions || []) {
          if (p.pool) {
            const ctx = recallForPool(p.pool);
            if (ctx) poolContextLines.push(ctx);
          }
        }
        if (poolContextLines.length > 0) {
          memoryHints += `\n\nPOOL CONTEXT (from memory):\n${poolContextLines.join("\n\n")}\n`;
        }
        // Dynamic fee context for open positions (sequential to avoid RPC rate limit)
        try {
          const { fetchDynamicFee } = await import("./tools/screening.js");
          const feeLines = [];
          for (const p of (pos.positions || []).filter(p => p.pool)) {
            const fee = await fetchDynamicFee(p.pool);
            if (fee) feeLines.push(`${p.pair}: base_fee: ${fee.base_fee_pct}% | dynamic_fee: ${fee.dynamic_fee_pct}%`);
          }
          if (feeLines.length > 0) {
            memoryHints += `\n\nDYNAMIC FEES (current):\n${feeLines.join("\n")}\n`;
          }
        } catch { /* best-effort */ }
        precheckedPositions = pos.positions || [];
      } catch { /* best-effort */ }

      // Inject recent auto-closes from PnL watcher so LLM knows what happened
      let autoCloseInfo = "";
      try {
        const stateRaw = (await import("fs")).readFileSync("./state.json", "utf8");
        const stateData = JSON.parse(stateRaw);
        const recent = (stateData.recentAutoCloses || []).filter(
          ac => Date.now() - new Date(ac.ts).getTime() < 60 * 60 * 1000 // last hour
        );
        if (recent.length > 0) {
          autoCloseInfo = `\n\nPNL WATCHER AUTO-CLOSES (last hour):\n${recent.map(ac => `• ${ac.pair}: ${ac.reason} (PnL: ${ac.pnl_pct?.toFixed(1)}% at ${ac.ts})`).join("\n")}\n`;
        }
      } catch { /* best-effort */ }

      // Pre-load KB articles relevant to open positions
      let kbContext = "";
      try {
        const pos = await getMyPositions().catch(() => null);
        const kbHints = kbRecallForManagement(pos?.positions || []);
        if (kbHints) kbContext = `\n\n${kbHints}`;
      } catch { /* best-effort */ }

      // Hard-close rules 2-6 are threshold checks on data already in hand. Evaluate them
      // here and start a model session only when a position carries a free-text
      // instruction, a rule fired, a rule could not be evaluated, or there are exit
      // alerts. All-HOLD cycles skip the LLM call. This only gates the LLM: nothing is
      // closed in code here, and the PnL watcher's own exits are unaffected.
      if (precheckedPositions?.length && !exitAlerts) {
        const m = config.management;
        const ruleHits = [];
        const closeReasons = []; // [position, label] for the close history (tools/executor.js withCloseReason)
        for (const p of precheckedPositions) {
          if (getTrackedPosition(p.position)?.instruction) { ruleHits.push(`${p.pair}: instruction`); closeReasons.push([p.position, "rule 1: instruction met"]); }
          else if (p.pnl_pct == null) ruleHits.push(`${p.pair}: pnl unknown`);
          else if (p.pnl_pct >= m.takeProfitFeePct) { ruleHits.push(`${p.pair}: rule 3`); closeReasons.push([p.position, `rule 3: take profit (${p.pnl_pct}% ≥ ${m.takeProfitFeePct}%)`]); }
          else if ((p.minutes_out_of_range ?? 0) >= m.outOfRangeWaitMinutes) { ruleHits.push(`${p.pair}: rule 4`); closeReasons.push([p.position, `rule 4: OOR timeout${p.oor_direction ? ` (OOR ${p.oor_direction})` : ""}`]); }
          else if (p.pnl_pct <= m.emergencyPriceDropPct) { ruleHits.push(`${p.pair}: rule 6`); closeReasons.push([p.position, `rule 6: emergency stop (${p.pnl_pct}%)`]); }
          else if (!p.pool) ruleHits.push(`${p.pair}: pool unknown`);
          else {
            const d = await getPoolDetail({ pool_address: p.pool, timeframe: config.screening.timeframe || "5m" }).catch(() => null);
            if (!d || !Number.isFinite(d.fee_active_tvl_ratio) || !Number.isFinite(d.volume)) ruleHits.push(`${p.pair}: rule 5 unverified`);
            else if (d.fee_active_tvl_ratio < config.screening.minFeeActiveTvlRatio && d.volume < config.screening.minVolume) {
              ruleHits.push(`${p.pair}: rule 5`);
              closeReasons.push([p.position, "rule 5: yield dead"]);
            }
          }
        }
        setManagementCloseReasons(closeReasons);
        if (ruleHits.length === 0) {
          log("cron", `Management: ${precheckedPositions.length} position(s) checked in code, no close rule triggered — HOLD (LLM skipped)`);
          mgmtReport = `Management: ${precheckedPositions.length} position(s) checked in code, no close rule triggered — HOLD.`;
          return; // finally{} still releases the lock and emits the report
        }
        log("cron", `Management: LLM needed — ${ruleHits.join(", ")}`);
        memoryHints += formatRunnerPrecheck(ruleHits);
        mgmtRuleFired = ruleHits.some((h) => /: rule [3-6]$/.test(h));
      }

      if (exitAlerts) mgmtRuleFired = true;
      const managementGoal = buildManagementGoal(`${memoryHints}${exitAlerts}${autoCloseInfo}${kbContext}`, { usdcMode: usdcModeEnabled() });
      // If the LLM path fails (provider down, or no assistant message), rule 4
      // (OOR timeout) is a pure threshold, so those positions are closed in code
      // through the same close_position path; every other rule waits for the LLM.
      // The management lock is still held, so the PnL watcher, Telegram actions
      // and screening cannot race these closes.
      const mgmtRun = await runManagementWithOorFallback({
        runLlm: () => agentLoop(managementGoal, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel),
        onLlmError: (llmError) => {
          const outage = isLlmUnavailableError(llmError);
          log(outage ? "cron" : "cron_error", `Management LLM call failed (${llmError.message}) — running the rule-4 OOR fallback in code`);
          // A provider outage is reported once by the deduped llm_unavailable alert;
          // anything else is a real cycle failure and keeps the cycle_error alert.
          if (!outage) emit("cycle_error", { cycle: "Management", error: llmError.message });
        },
        fallbackDeps: {
          getPositions: () => getMyPositions({ force: true }),
          executeTool,
          getTrackedPosition,
          isBusy,
          isCloseInflight,
          management: config.management,
          log,
          dryRun: process.env.DRY_RUN === "true",
        },
      });
      fallbackSummary = mgmtRun.fallbackSummary;
      mgmtReport = fallbackSummary
        ? formatOorFallbackReport(fallbackSummary, mgmtRun.error?.message)
        : mgmtRun.content;
    } catch (error) {
      log("cron_error", `Management cycle failed: ${error.message}`);
      mgmtReport = `Management cycle failed: ${error.message}`;
      mgmtFailed = true;
      emit("cycle_error", { cycle: "Management", error: error.message });
    } finally {
      setManagementBusy(false);
      clearManagementCloseReasons();
      // Routine = nothing happened (code-only HOLD, or the LLM ran and changed
      // nothing without a close rule firing). Routine reports aren't pushed to Telegram.
      // An LLM-down cycle is routine unless the OOR fallback tried to close something.
      if (mgmtReport) {
        const routine = fallbackSummary
          ? fallbackSummary.attempted.length === 0
          : !mgmtFailed && !mgmtRuleFired && _fundEvents === fundEventsBefore;
        emit("cycle:management", { report: mgmtReport, routine });
      }
      try {
        const pos = await getMyPositions().catch(() => null);
        for (const p of pos?.positions || []) {
          if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
            emit("out_of_range", { pair: p.pair, minutesOOR: p.minutes_out_of_range });
          }
        }
        if (pos && !pos.error && !pos.positions?.length) await resetIdleManagementInterval();
      } catch { /* best-effort */ }
      // Pattern synthesis to knowledge base (throttled, max once/hour, only when recent closes exist)
      try {
        const kbGoal = shouldFileObservations();
        if (kbGoal && !isBusy() && !isScreeningBusy() && !llmHealth.isUnavailable()) {
          log("kb", "Running KB pattern synthesis...");
          await agentLoop(kbGoal, 3, [], "GENERAL", config.llm.generalModel)
            .catch(e => log("kb", `Synthesis skipped: ${e.message}`));
        }
      } catch { /* kb synthesis is best-effort */ }
    }
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, async () => {
    let run = runScreeningCycle();
    // Management and screening fire on shared clock boundaries (e.g. every 10
    // and every 20 min both hit :00/:20/:40), so the screening tick landed while
    // management was running and was skipped every single time. Instead of
    // dropping the slot, wait for that management cycle to finish (max 5 min)
    // and try once more; every other gate (pause, a position action) is unchanged.
    if (!run.started && run.reason === "a management cycle is in progress") {
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline && isManagementBusy()) {
        await new Promise((r) => setTimeout(r, 5_000));
      }
      run = runScreeningCycle();
      if (run.started) log("cron", "Screening started after the management cycle finished");
    }
    await run.done;
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Knowledge base health check (every N hours, configurable)
  const kbHealthHours = config.knowledgeBase?.healthCheckIntervalHours || 12;
  const kbHealthTask = cron.schedule(`0 */${Math.max(1, kbHealthHours)} * * *`, async () => {
    if (!config.knowledgeBase?.enabled) return;
    const stats = getKbStats();
    if (stats.totalArticles < 3) return; // Not enough articles to lint
    if (isBusy() || isManagementBusy() || isScreeningBusy()) return;

    log("cron", "Starting KB health check");
    try {
      // Fast deterministic lint first — no LLM needed
      const { lintKnowledgeBase } = await import("./knowledge-base.js");
      const lintResult = lintKnowledgeBase();
      if (lintResult) {
        log("cron", `KB lint: ${lintResult.total_articles} articles, ${lintResult.issues.length} issues (${lintResult.orphan_count} orphans, ${lintResult.stale_count} stale, ${lintResult.empty_count} empty)`);
      }
      // Only call LLM for deeper review if lint found issues
      const issueCount = lintResult?.issues?.length || 0;
      const lintContext = issueCount > 0 ? `\n\nLINT RESULTS (${issueCount} issues):\n${lintResult.issues.join("\n")}` : "";
      const { content } = await agentLoop(
        `KNOWLEDGE BASE HEALTH CHECK:${lintContext}\nRead kb_read("INDEX.md") to see all articles. Review 3-5 articles that seem most likely to have issues. Look for: contradictions, stale data, missing cross-references, and articles that could be merged. Fix any issues using kb_write. Report what you checked and any changes made.`,
        10, [], "GENERAL", config.llm.generalModel
      );
      emit("cycle:kb_health", { report: content });
      log("cron", "KB health check complete");
    } catch (e) {
      log("cron_error", `KB health check failed: ${e.message}`);
    }
  }, { timezone: 'UTC' });

  _cronTasks = [mgmtTask, screenTask, briefingTask, briefingWatchdog, kbHealthTask];

  // Start lightweight PnL watcher (sub-minute interval, no LLM)
  startPnlWatcher(config.schedule.pnlWatcherIntervalSec);

  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m, pnl watcher every ${config.schedule.pnlWatcherIntervalSec}s`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
// What the drain still waits for. A close started by the PnL watcher shows up
// only in getInflightCloses(); one started via executeTool shows up in both.
function pendingWork() {
  const pending = [];
  for (const addr of getInflightCloses()) pending.push(`close ${addr.slice(0, 8)}`);
  for (const op of getInflightOps()) pending.push(op);
  if (isBusy()) pending.push("position action");
  if (isManagementBusy()) pending.push("management cycle");
  if (isScreeningBusy()) pending.push("screening cycle");
  if (isPnlTickRunning()) pending.push("PnL watcher tick");
  return pending;
}

const shutdownController = createShutdownController({
  timeoutMs: drainTimeoutMsFromEnv(),
  stopIntake: () => {
    setDraining(true);  // executeTool refuses new deploys; the watcher and crons start nothing
    stopCronJobs();     // also stops the PnL watcher interval
    stopPolling();      // no new Telegram commands
  },
  getPending: pendingWork,
  onDrained: async () => {
    const positions = await getMyPositions().catch(() => null);
    log("shutdown", `Open positions at shutdown: ${positions?.total_positions ?? "unknown"}`);
    try {
      if (fs.readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
    } catch { /* already gone */ }
  },
});

function shutdown(signal, opts) {
  return shutdownController.handleSignal(signal, opts);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name   = (p.name || "unknown").padEnd(20);
    const ftvl   = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const rawVol = p.volume || 0;
    const vol    = (rawVol >= 1000 ? `$${(rawVol / 1000).toFixed(1)}k` : `$${Math.round(rawVol)}`).padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org    = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  const tf = config.screening.timeframe || "1h";
  return [
    `  #   pool                  fee/aTVL     vol(${tf})  in-range  organic`,
    "  " + "─".repeat(72),
    ...lines,
  ].join("\n");
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
const runtimeMode = getStartupMode({ isTTY });
let cronStarted = false;
let serverStarted = false;

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted && !isDraining()) startCronJobs(); });

function ensureServerStarted() {
  if (serverStarted || !runtimeMode.startServer) return;
  serverStarted = true;
  startServer(() => ({
    management: formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin)),
    screening:  formatCountdown(nextRunIn(timers.screeningLastRun,  config.schedule.screeningIntervalMin)),
  })).catch((e) => log("server_error", `Web server failed to start: ${e.message}`));
}

function launchCron(options = {}) {
  if (!cronStarted && runtimeMode.startCron) {
    cronStarted = true;
    timers.managementLastRun = Date.now();
    timers.screeningLastRun = Date.now();
    startCronJobs();
    if (options.announce) {
      console.log("Autonomous cycles are now running.\n");
    }
  }
}

// ═══════════════════════════════════════════
//  TELEGRAM REMOTE CONTROL
//  Full command parity with the terminal REPL. Works in both interactive and
//  headless (non-TTY) mode — never touches readline so it runs as a service.
// ═══════════════════════════════════════════
let startupCandidates = [];

const buildSettingsReportSync = () => buildSettingsReport({ color: false });

const TELEGRAM_HELP = [
  "DLMM LP Agent — Telegram control",
  "",
  "/menu — button menu (status, positions, candidates, wallet, settings, bot controls, trading settings)",
  "⚙️ Trading settings (menu) — TP, stop loss, trailing TP, OOR wait, deploy size, max positions, PnL watcher; risk-raising changes ask for a second tap",
  "🧾 All settings (Settings) — edit any user-config / gmgn-config key; /cancel aborts a pending value; dryRun and risk-raising edits ask for a second tap",
  "/status — wallet + open positions",
  "/settings — effective config + which file each setting lives in",
  "/usdc [on|off] — show or toggle USDC mode",
  "/candidates — refresh top pools (then reply a number to deploy)",
  "1 / 2 / 3 … — deploy into that pool: pick Bid-Ask or Spot (single-sided SOL) and a range (Auto/25/50/80%), then confirm",
  "/token <mint> (or just paste a mint) — SOL DLMM pools, token signals and your screening filters (✅/❌), with Deploy via the same picker",
  "auto — agent picks the best pool and deploys (asks for confirmation)",
  "go — start autonomous cycles",
  "/briefing — last-24h briefing",
  "/thresholds — screening thresholds + performance",
  "/learn [pool] — study top LPers (all top pools, or one address)",
  "/evolve — evolve thresholds from performance",
  "/autoresearch [list|show|revert|restore|approve|reject …] — prompt overrides (operator only)",
  "/stop — shut the agent down",
  "/help — this list",
  "",
  "Anything else is sent to the agent as a chat message.",
  "Closing or deploying from buttons always asks for a second confirming tap.",
].join("\n");

// Telegram caps a single message at 4096 chars — chunk longer replies.
async function tgSend(text) {
  const s = String(text ?? "").trim();
  if (!s) return;
  for (let i = 0; i < s.length; i += 3900) {
    await sendMessage(s.slice(i, i + 3900));
  }
}

// Busy-guard shared by Telegram text commands and button actions. The check and
// the lock happen synchronously (no await in between), so two taps can't both
// get in. Returns { busy: true } without running fn, else { value }.
async function tryExclusive(fn, { screening = false } = {}) {
  if (isBusy() || isManagementBusy() || isScreeningBusy()) return { busy: true };
  setBusy(true);
  if (screening) setScreeningBusy(true);
  try {
    return { busy: false, value: await fn() };
  } finally {
    if (screening) setScreeningBusy(false);
    setBusy(false);
  }
}

// Remote busy-guard — mirror of the terminal runBusy/runScreeningBusy, but
// replies over Telegram and never references readline (safe when headless).
async function runRemote(fn, { screening = false } = {}) {
  try {
    const r = await tryExclusive(fn, { screening });
    if (r.busy) await tgSend("⏳ Agent is busy right now — try again in a moment.");
  } catch (e) {
    await tgSend(`❌ Error: ${e.message}`);
  }
}

// Legacy "auto": the screener LLM picks a pool and calls deploy_position.
async function autoDeployViaAgent() {
  const sizing = usdcModeEnabled() ? null : await resolveDeploySizing();
  if (sizing?.skip) return `Deploy skipped — ${sizing.reason}`;
  const amt = usdcModeEnabled() ? `$${config.usdc.deployAmountUsd} (USDC mode — auto-funded from USDC)` : `${sizing.amount} SOL (${sizing.label})`;
  const { content } = await screenerLoop(
    `get_top_candidates, pick the best one, deploy_position with ${amt}. Execute now, don't ask.`,
    config.llm.maxSteps,
  );
  return content;
}

// Menus, views, two-tap confirmations and alerts (telegram-ui.js). Fund-moving
// buttons execute through executeTool, the same path the agent's tools use.
const tgUI = createTelegramUI({
  tg: { sendHTML, editHTML, answerCallback },
  config,
  computeDeployAmount,
  resolveDeploySizing,
  usdcModeEnabled,
  getMyPositions,
  getPositionBins, // read-only bin charts (📊 Bins, Positions strips); never throws
  getWalletBalances,
  getTopCandidates,
  lookupToken: (mint) => lookupToken(mint), // read-only; deploys still go through the picker + executeTool
  // Settings → 🛡 Entry filters: user changes, persisted like update_config.
  setEntryFilter: async (key, value) => {
    const { applyEntryFilterChange } = await import("./tools/entry-safety.js");
    return applyEntryFilterChange(key, value, { source: "telegram" });
  },
  // Menu / Settings → ⚙️ Trading settings: user changes, persisted like
  // update_config and applied to the running config (PnL watcher + management
  // rules read config.management / config.risk live). The PnL watcher only runs
  // once cycles are started; startCronJobs() picks the new interval up otherwise.
  // Settings → 🧾 All settings: every non-secret key config.js reads.
  allSettings: createAllSettings({
    config,
    lockedKeys: LOCKED_KEYS,
    integerKeys: INTEGER_KEYS,
    persistUserConfig,
    persistGmgnConfig,
    entryFilters: { normalize: normalizeEntryFilterValue, isLoosening: isLooseningChange },
    dryRunInEnv: DRY_RUN_SET_IN_ENV,
    onScheduleChange: (key, value) => {
      if (!cronStarted) return; // startCronJobs() reads the new value when cycles start
      if (key === "pnlWatcherIntervalSec") startPnlWatcher(value);
      else startCronJobs();
    },
    log,
  }),
  applyTradingSettings: (changes) => applyTradingSettings(changes, {
    config,
    persistUserConfig,
    restartPnlWatcher: (sec) => {
      if (!cronStarted) return false;
      startPnlWatcher(sec);
      return true;
    },
    log,
    source: "telegram",
  }),
  // Read-only pool status / fee mode / TWAP for the deploy confirm card.
  entryPreview: async (c, opts) => {
    const { readPoolEntryState } = await import("./tools/entry-safety.js");
    return readPoolEntryState(c.pool, { apiBlacklisted: c.is_blacklisted ?? null, ...opts });
  },
  // Token age for the deploy confirm card (same window deploy_position enforces).
  tokenAge: async (c) => {
    const { candidateTokenAge, getTokenAgeInfo } = await import("./tools/token-age.js");
    return candidateTokenAge(c) ?? getTokenAgeInfo(c.base_mint || c.base?.mint || null, { pool: c.pool });
  },
  // Candle-based range depth for the picker's Auto option (rangeDepthMode "ohlcv").
  getOhlcvDepth: (c) => getOhlcvDepth({ pool: c.pool, mint: c.base_mint || c.base?.mint || null, ageHours: c.token_age_hours ?? null }),
  parseMint,
  executeTool,
  runExclusive: tryExclusive,
  autoDeploy: autoDeployViaAgent,
  afterDeploy: () => launchCron({ announce: true }),
  runScreeningNow: () => runScreeningCycle({ manual: true }),
  isScreeningPaused,
  setScreeningPaused: (paused) => setScreeningPaused(paused, "telegram"),
  getStatusInfo: () => ({
    activeStrategy: config.strategy.activeStrategy,
    strategy: config.strategy.strategy,
    managementModel: config.llm.managementModel,
    screeningModel: getScreenerModelLabel(),
    screeningSource: config.screening.source,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
    pnlWatcherIntervalSec: config.schedule.pnlWatcherIntervalSec,
    nextManagement: formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin)),
    nextScreening: formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin)),
    busy: isBusy(),
    managementBusy: isManagementBusy(),
    screeningBusy: isScreeningBusy(),
    cronStarted,
    usdcMode: usdcModeEnabled(),
  }),
  buildSettingsReport: () => buildSettingsReportSync(),
  handleAutoresearchCommand: (args) => handleAutoresearchCommand(args),
  readRecentErrors: () => readRecentErrors({ n: 15 }),
  log,
});
tgUI.attachAlerts(on);

const telegramHandlers = {
  onMessage: (text, ctx) => handleTelegramCommand(text, ctx),
  onCallback: (data, ctx) => tgUI.handleCallback(data, ctx),
};

function startTelegram() {
  if (!telegramEnabled()) return;
  setMyCommands(BOT_COMMANDS).catch(() => {}); // best-effort
  startPolling(telegramHandlers);
}

async function handleTelegramCommand(rawText, ctx = {}) {
  const text = String(rawText || "").trim();
  if (!text) return;
  log("telegram", `Incoming: ${text.slice(0, 200)}`);
  const lower = text.toLowerCase();

  // ── Help ──
  if (text === "/help" || text === "/commands") {
    return tgSend(TELEGRAM_HELP);
  }

  // ── Menu, /candidates, number-reply deploy and "auto" (all confirm first) ──
  if (await tgUI.handleMessage(text, ctx)) return;

  // ── Shutdown ──
  if (text === "/stop") {
    await tgSend("🛑 Shutting down the agent (finishing in-flight work first)…");
    await shutdown("telegram /stop", { force: false });
    return;
  }

  // ── Start cron (no busy needed) ──
  if (lower === "go") {
    launchCron({ announce: true });
    return tgSend("▶️ Autonomous cycles are running.");
  }

  // ── Status ──
  if (text === "/status") {
    return runRemote(async () => {
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
      const unit = config.management.pnlUnit || "sol";
      const lines = [
        `💰 Wallet: ${wallet.sol} SOL ($${wallet.sol_usd})`,
        `📊 Positions: ${positions.total_positions}`,
      ];
      if (usdcModeEnabled()) lines.splice(1, 0, `💵 USDC mode: $${wallet.usdc} | deploy $${config.usdc.deployAmountUsd} | gas reserve ${config.usdc.gasReserveSol} SOL`);
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        const fees = unit === "sol" ? `${p.unclaimed_fees_sol ?? "?"} SOL` : `$${p.unclaimed_fees_usd}`;
        const pnl = unit === "sol" ? `${p.pnl_sol ?? "?"} SOL` : `$${p.pnl_usd ?? "?"}`;
        lines.push(`• ${p.pair}  ${status}  fees: ${fees}  pnl: ${pnl} (${p.pnl_pct != null ? `${p.pnl_pct}%` : "PnL unknown"})`);
      }
      await tgSend(lines.join("\n"));
    });
  }

  // ── Settings (effective config + which file each value lives in) ──
  if (text === "/settings" || text === "/config") {
    return tgSend(buildSettingsReportSync());
  }

  // ── USDC mode (show/toggle) — terminal-parity with the CLI /usdc command ──
  if (text === "/usdc" || lower.startsWith("/usdc ")) {
    const arg = text.slice(5).trim().toLowerCase();
    if (arg === "on" || arg === "off") await setUsdcMode(arg === "on");
    return tgSend(usdcStatusText());
  }

  // ── Briefing (uses the same HTML path as notifications) ──
  if (text === "/briefing") {
    return runRemote(async () => {
      const briefing = await generateBriefing();
      emit("briefing", { html: briefing });
    });
  }

  // ── Thresholds (read-only) ──
  if (text === "/thresholds") {
    const lines = ["⚙️ Screening thresholds"];
    for (const [label, value] of getScreeningThresholdSummary(config.screening)) {
      lines.push(`• ${label}: ${value}`);
    }
    const perf = getPerformanceSummary();
    if (perf) {
      lines.push("", `Based on ${perf.total_positions_closed} closed positions`, `Win rate: ${perf.win_rate_pct}% | Avg PnL: ${perf.avg_pnl_pct}%`);
    } else {
      lines.push("", "No closed positions yet — preset defaults.");
    }
    return tgSend(lines.join("\n"));
  }

  // ── Learn (study top LPers) ──
  if (lower.startsWith("/learn")) {
    return runRemote(async () => {
      const parts = text.split(/\s+/);
      const poolArg = parts[1] || null;
      let poolsToStudy = [];
      if (poolArg) {
        poolsToStudy = [{ pool: poolArg, name: poolArg }];
      } else {
        const { candidates } = await getTopCandidates({ limit: 10 });
        if (!candidates.length) { await tgSend("No eligible pools found to study."); return; }
        poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
      }
      await tgSend(`📚 Studying top LPers across ${poolsToStudy.length} pool(s)…`);
      const poolList = poolsToStudy.map((p, i) => `${i + 1}. ${p.name} (${p.pool})`).join("\n");
      const { content } = await agentLoop(
        `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:\n\n${poolList}\n\nFor each pool, call study_top_lpers then move to the next. After studying all pools:\n1. Identify cross-pool patterns (hold time, scalping vs holding, win rates).\n2. Note pool-specific differences.\n3. Derive 4-8 concrete lessons using add_lesson. Prioritize cross-pool patterns.\n4. Summarize what you learned.`,
        config.llm.maxSteps, [], "GENERAL", config.llm.generalModel,
      );
      await tgSend(content);
    });
  }

  // ── Evolve thresholds ──
  if (text === "/evolve") {
    return runRemote(async () => {
      const perf = getPerformanceSummary();
      if (!perf || perf.total_positions_closed < 5) {
        const needed = 5 - (perf?.total_positions_closed || 0);
        await tgSend(`Need at least 5 closed positions to evolve. ${needed} more needed.`);
        return;
      }
      const fsMod = await import("fs");
      const lessonsData = JSON.parse(fsMod.default.readFileSync("./lessons.json", "utf8"));
      const result = evolveThresholds(lessonsData.performance, config);
      if (!result || Object.keys(result.changes).length === 0) {
        await tgSend("No threshold changes needed — current settings already match performance data.");
      } else {
        reloadScreeningThresholds();
        const lines = ["✅ Thresholds evolved:"];
        for (const [key] of Object.entries(result.changes)) lines.push(`• ${key}: ${result.rationale[key]}`);
        lines.push("", "Saved to user-config.json. Applied immediately.");
        await tgSend(lines.join("\n"));
      }
    });
  }

  // ── Autoresearch overrides (operator path; logic lives in autoresearch.js) ──
  if (lower === "/autoresearch" || lower.startsWith("/autoresearch ")) {
    for (const chunk of autoresearchTelegramChunks(handleAutoresearchCommand(text.slice(13)))) await sendHTML(chunk); // chunks are HTML-escaped
    return;
  }

  // ── Free-form chat ──
  return runRemote(async () => {
    const { content } = await lightChat(text, sessionHistory, config.llm.generalModel);
    appendHistory(text, content);
    await tgSend(content);
  });
}

ensureServerStarted();

if (runtimeMode.interactive) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });

  // Update prompt countdown/status frequently so cron state does not look stale.
  const promptInterval = setInterval(() => {
    if (!isBusy()) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 1_000);

  async function runBusy(fn) {
    if (isBusy()) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    setBusy(true); rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { setBusy(false); rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  async function runScreeningBusy(fn) {
    if (isBusy() || isScreeningBusy() || isManagementBusy()) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    setBusy(true);
    setScreeningBusy(true);
    rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally {
      setScreeningBusy(false);
      setBusy(false);
      rl.setPrompt(buildPrompt());
      rl.resume();
      rl.prompt();
    }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  setBusy(true);
  startupCandidates = [];

  try {
    const positions = await getMyPositions();
    await new Promise(r => setTimeout(r, 1000));
    const wallet = await getWalletBalances();
    await new Promise(r => setTimeout(r, 1000));
    const screenResult = await getTopCandidates({ limit: 5 });

    const candidates = screenResult.candidates || [];
    const total_eligible = screenResult.total_eligible ?? candidates.length;

    // Cache for WebSocket init — avoids duplicate Helius calls
    try {
      const { setStartupCache } = await import("./server.js");
      setStartupCache({ wallet, positions, candidates: screenResult });
    } catch { /* best-effort */ }
    const total_screened = screenResult.total_screened ?? 0;
    startupCandidates = candidates;

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    if (usdcModeEnabled()) {
      console.log(`Mode:      💵 USDC MODE — USDC: $${wallet.usdc}  |  deploy $${config.usdc.deployAmountUsd}/position  |  gas reserve ${config.usdc.gasReserveSol} SOL`);
    }
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      const unit = config.management.pnlUnit || "sol";
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        const fees = unit === "sol" ? `${p.unclaimed_fees_sol ?? "?"} SOL` : `$${p.unclaimed_fees_usd}`;
        const pnl = unit === "sol" ? `${p.pnl_sol ?? "?"} SOL` : `$${p.pnl_usd ?? "?"}`;
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${fees}  pnl: ${pnl} (${p.pnl_pct != null ? `${p.pnl_pct}%` : "PnL unknown"})`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    setBusy(false);
  }

  // Always start autonomous cycles on launch
  launchCron({ announce: true });
  maybeRunMissedBriefing().catch(() => {});

  // Telegram bot — full remote control (shared dispatcher, terminal-parity).
  startTelegram();

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${deployDirective()} into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /usdc          Show USDC-mode status   (/usdc on | /usdc off to toggle)
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /autoresearch  Prompt overrides: list | show | revert | restore <section>
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    if (!isNaN(pick) && pick >= 1 && pick <= startupCandidates.length) {
      await runScreeningBusy(async () => {
        const pool = startupCandidates[pick - 1];
        const sizing = usdcModeEnabled() ? null : await resolveDeploySizing();
        if (sizing?.skip) { console.log(`\nDeploy skipped — ${sizing.reason}\n`); launchCron({ announce: true }); return; }
        const amtPhrase = usdcModeEnabled() ? `$${config.usdc.deployAmountUsd} (USDC mode — auto-funded from USDC)` : `${sizing.amount} SOL (${sizing.label})`;
        console.log(`\nDeploying ${amtPhrase} into ${pool.name}...\n`);
        const { content: reply } = await screenerLoop(
          `Deploy ${amtPhrase} into pool ${pool.pool} (${pool.name}). Call deploy_position. Report result.`,
          config.llm.maxSteps
        );
        console.log(`\n${reply}\n`);
        launchCron({ announce: true });
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runScreeningBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const sizing = usdcModeEnabled() ? null : await resolveDeploySizing();
        if (sizing?.skip) { console.log(`\nDeploy skipped — ${sizing.reason}\n`); launchCron({ announce: true }); return; }
        const amtPhrase = usdcModeEnabled() ? `$${config.usdc.deployAmountUsd} (USDC mode — auto-funded from USDC)` : `${sizing.amount} SOL (${sizing.label})`;
        const { content: reply } = await screenerLoop(
          `get_top_candidates, pick the best one, deploy_position with ${amtPhrase}. Execute now, don't ask.`,
          config.llm.maxSteps
        );
        console.log(`\n${reply}\n`);
        launchCron({ announce: true });
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron({ announce: true });
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command", { force: false }); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
        const unit = config.management.pnlUnit || "sol";
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        if (usdcModeEnabled()) {
          console.log(`💵 USDC MODE — USDC: $${wallet.usdc}  |  deploy $${config.usdc.deployAmountUsd}  |  gas reserve ${config.usdc.gasReserveSol} SOL`);
        }
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          const fees = unit === "sol" ? `${p.unclaimed_fees_sol ?? "?"} SOL` : `$${p.unclaimed_fees_usd}`;
          const pnl = unit === "sol" ? `${p.pnl_sol ?? "?"} SOL` : `$${p.pnl_usd ?? "?"}`;
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${fees}  pnl: ${pnl} (${p.pnl_pct != null ? `${p.pnl_pct}%` : "PnL unknown"})`);
        }
        console.log();
      });
      return;
    }

    // ── /usdc [on|off]: show or toggle USDC mode ──
    if (input === "/usdc" || input.toLowerCase().startsWith("/usdc ")) {
      const arg = input.slice(5).trim().toLowerCase();
      if (arg === "on" || arg === "off") await setUsdcMode(arg === "on");
      console.log(`\n${usdcStatusText()}\n`);
      rl.prompt();
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const result = await getTopCandidates({ limit: 5 });
        const candidates = result.candidates || [];
        startupCandidates = candidates;
        console.log(`\nTop pools (${result.total_eligible ?? candidates.length} eligible from ${result.total_screened ?? 0} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      console.log("\nCurrent screening thresholds:");
      for (const [label, value] of getScreeningThresholdSummary(config.screening)) {
        console.log(`  ${label}: ${value}`);
      }
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL",
          config.llm.generalModel
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    if (input === "/autoresearch" || input.toLowerCase().startsWith("/autoresearch ")) {
      console.log(`\n${handleAutoresearchCommand(input.slice(13))}\n`);
      rl.prompt();
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await lightChat(input, sessionHistory, config.llm.generalModel);
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => {
    clearInterval(promptInterval);
    shutdown("stdin closed", { force: false });
  });

} else {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  launchCron();
  maybeRunMissedBriefing().catch(() => {});

  // Telegram bot — full remote control works headless too.
  startTelegram();
  if (runtimeMode.runStartupCheck) (async () => {
    // Guard the startup screener with the screening busy flag so it can't
    // overlap a cron screening cycle or a remote-deploy command.
    if (isBusy() || isScreeningBusy() || isManagementBusy()) {
      log("startup", "Startup check skipped — another cycle already in progress");
      return;
    }
    setScreeningBusy(true);
    try {
      const sizing = usdcModeEnabled() ? null : await resolveDeploySizing();
      const deployStep = usdcModeEnabled()
        ? `get_top_candidates then deploy $${config.usdc.deployAmountUsd} (USDC mode — auto-funded from USDC)`
        : sizing.skip
          ? `do NOT deploy (sizing skip: ${sizing.reason})`
          : `get_top_candidates then deploy ${sizing.amount} SOL (${sizing.label})`;
      await screenerLoop(`
STARTUP CHECK
1. get_wallet_balance. 2. get_my_positions. 3. If SOL >= ${config.management.minSolToOpen}: ${deployStep}. 4. Report.
      `, config.llm.maxSteps, []);
    } catch (e) {
      log("startup_error", e.message);
    } finally {
      setScreeningBusy(false);
    }
  })();
}
