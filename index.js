import "dotenv/config";
import fs from "fs";
import path from "path";
import cron from "node-cron";
import readline from "readline";
import { agentLoop, lightChat, getScreenerModelLabel, screenerLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates, rankCandidatesByDarwin } from "./tools/screening.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary, deduplicateLessons } from "./lessons.js";
import { registerCronRestarter } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, isEnabled as telegramEnabled } from "./telegram.js";
import { usdcModeEnabled } from "./tools/usdc-mode.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate } from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { initMemory, recallForScreening, recallForManagement, rememberPositionSnapshot, maybePromote, checkCapacity } from "./memory.js";
import { updatePnlAndCheckExits } from "./state.js";
import { emit } from "./notifier.js";
import { stageSignals } from "./signal-tracker.js";
import { getWeightsSummary } from "./signal-weights.js";
import { startPnlWatcher, stopPnlWatcher } from "./pnl-watcher.js";
import { recordPositionSnapshot as recordPoolSnapshot, recallForPool } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenHolders, getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { fetchGmgnPriceInfo, fetchGmgnSignal } from "./tools/gmgn.js";
import {
  sessionHistory, appendHistory, getHistory,
  isBusy, setBusy,
  isManagementBusy, setManagementBusy,
  isScreeningBusy, setScreeningBusy,
} from "./session.js";
import { startServer } from "./server.js";
import { getScreeningThresholdSummary, getStartupMode } from "./runtime-helpers.js";
import { getRangeSelectionText } from "./prompt.js";
import { shouldFileObservations, getKbStats, migrateFromJson, kbRecallForScreening, kbRecallForManagement, fileScreeningResult } from "./knowledge-base.js";

log("startup", "DLMM LP Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${config.llm.managementModel} (provider: ${process.env.LLM_PROVIDER || "openrouter"})`);

// Initialize holographic memory at startup
initMemory();

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
const DEPLOY  = config.management.deployAmountSol;

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
    const cfgPath = new URL("./user-config.json", import.meta.url);
    const fs = await import("fs");
    const cur = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
    cur.usdcMode = config.usdc.enabled;
    fs.writeFileSync(cfgPath, JSON.stringify(cur, null, 2));
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

function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
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

    // Skip management entirely if no open positions — saves LLM tokens
    try {
      const preCheck = await getMyPositions();
      if (!preCheck?.positions?.length) {
        log("cron", "Management skipped — no open positions");
        timers.managementLastRun = Date.now();
        return;
      }
    } catch { /* proceed if check fails */ }

    setManagementBusy(true);
    timers.managementLastRun = Date.now();
    log("cron", `Starting management cycle [model: ${config.llm.managementModel}]`);
    let mgmtReport = null;
    try {
      // Targeted recall + trailing TP / stop loss pre-check
      let memoryHints = "";
      let exitAlerts = "";
      try {
        const pos = await getMyPositions();
        const recalls = [];
        const exits = [];
        const holdTimeHints = [];
        for (const p of pos.positions || []) {
          // Memory recall
          const hits = recallForManagement(p);
          for (const h of hits) {
            recalls.push(`[${h.source}] ${h.key}: ${h.answer} (confidence: ${(h.confidence * 100).toFixed(0)}%)`);
          }
          // Store mid-position snapshot in nuggets + pool-memory
          rememberPositionSnapshot(p);
          if (p.pool) recordPoolSnapshot(p.pool, p);

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
        if (recalls.length > 0) {
          memoryHints = `\n\nMEMORY RECALL (from past sessions):\n${recalls.join("\n")}\n`;
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

      const pnlUnit = config.management.pnlUnit?.toUpperCase() || "SOL";
      const { content } = await agentLoop(`
MANAGEMENT CYCLE${memoryHints}${exitAlerts}${autoCloseInfo}${kbContext}

HARD CLOSE RULES (check in order — close immediately on first match, no further analysis):
1. Position instruction condition met → CLOSE immediately (highest priority)
2. Position instruction exists but condition NOT met → HOLD (skip all other rules)
3. pnl_pct >= ${config.management.takeProfitFeePct}% → CLOSE (take profit)
4. minutes_out_of_range >= ${config.management.outOfRangeWaitMinutes} → CLOSE (OOR timeout). No exceptions — this is a hard rule regardless of OOR direction or PnL. Close and move on.
5. fee_active_tvl_ratio < ${config.screening.minFeeActiveTvlRatio}% AND volume < $${config.screening.minVolume} → CLOSE (yield dead)
6. pnl_pct <= ${config.management.emergencyPriceDropPct}% → CLOSE (emergency stop)

These rules come from user-config. They are not suggestions. Do not override them.
If NO rule triggers → HOLD. Do not close for any other reason.

STEPS:
1. get_my_positions — check all open positions.
2. For each position:
   - Call get_position_pnl.
   - Apply HARD CLOSE RULES above in order. First match → close, stop checking.
   - If no rule triggers: HOLD.
3. If closing: ${usdcModeEnabled()
    ? `do NOT swap manually — the system auto-settles all recovered tokens and surplus SOL back to USDC after the close.`
    : `swap base tokens to SOL immediately after.`}
4. After any close — recalibrate management interval (MANDATORY):
   - No positions remaining → update_config setting=managementIntervalMin value=10
   - Positions still open → keep current interval
5. After closing a LOSING position — check MEMORY RECALL for patterns:
   - If 3+ similar losses (same pool type, volatility range, or strategy) → use update_config to adjust the threshold that would have prevented it
   - Examples: tighten maxVolatility, raise minOrganic, adjust stopLossPct, raise minVolume

IMPORTANT: pnl_pct ALREADY includes all fees. Negative PnL = losing money AFTER fees. Never say "fees will offset" — they are already counted.

REPORT FORMAT (Strictly follow this for each position — use ${pnlUnit} values):
**[PAIR]** | Age: [X]m | Fees: [X] ${pnlUnit} | PnL: [X]% | OOR: [direction or "in-range"]
**Rule triggered:** [rule number or "none"]
**Decision:** [STAY/CLOSE]
**Reason:** [1 short sentence — if PnL is negative, say IL exceeds fees]

FAILURE ANALYSIS: When closing a LOSING position (negative PnL), you MUST call add_lesson with a specific, actionable lesson that explains:
- What went wrong (entered during pump reversal? too volatile for the range? held too long for a scalper pool?)
- What signal you missed or should have weighted differently
- What you would do differently next time
Do NOT write generic "FAILED: pool X with stats Y" — explain the WHY.
Example: "AVOID: Entering NOTHING-SOL during 4h +70% pump — reversal risk is high. Top LPers hold 0.2h in this pool but we held 3.8h. Next time: match scalper cadence or skip pumping tokens."
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel);
      mgmtReport = content;
    } catch (error) {
      log("cron_error", `Management cycle failed: ${error.message}`);
      mgmtReport = `Management cycle failed: ${error.message}`;
    } finally {
      setManagementBusy(false);
      if (mgmtReport) emit("cycle:management", { report: mgmtReport });
      try {
        const pos = await getMyPositions().catch(() => null);
        for (const p of pos?.positions || []) {
          if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
            emit("out_of_range", { pair: p.pair, minutesOOR: p.minutes_out_of_range });
          }
        }
      } catch { /* best-effort */ }
      // Promote high-hit nugget facts to MEMORY.md
      maybePromote();
      checkCapacity();
      // Pattern synthesis to knowledge base (throttled, max once/hour, only when recent closes exist)
      try {
        const kbGoal = shouldFileObservations();
        if (kbGoal && !isBusy() && !isScreeningBusy()) {
          log("kb", "Running KB pattern synthesis...");
          await agentLoop(kbGoal, 3, [], "GENERAL", config.llm.generalModel)
            .catch(e => log("kb", `Synthesis skipped: ${e.message}`));
        }
      } catch { /* kb synthesis is best-effort */ }
    }
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, async () => {
    if (isBusy()) {
      timers.screeningLastRun = Date.now();
      log("cron", "Screening deferred — position action in progress");
      return;
    }
    if (isScreeningBusy()) return;
    if (isManagementBusy()) {
      timers.screeningLastRun = Date.now();
      log("cron", "Screening deferred — management cycle in progress");
      return;
    }

    // Hard guards — don't even run the agent if preconditions aren't met
    try {
      const [positions, balance] = await Promise.all([getMyPositions(), getWalletBalances()]);
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

    setScreeningBusy(true);
    timers.screeningLastRun = Date.now();
    const screenModel = getScreenerModelLabel();
    log("cron", `Starting screening cycle [model: ${screenModel}]`);
    let screenReport = null;
    try {
      // Compute dynamic deploy amount based on current wallet (compounding)
      const currentBalance = await getWalletBalances().catch(() => null);
      const deployAmount = currentBalance ? computeDeployAmount(currentBalance.sol) : config.management.deployAmountSol;
      log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance?.sol ?? "?"} SOL)`);

      // Load saved strategies for reference (LLM picks per token)
      const activeStrategy = getActiveStrategy();
      const strategyBlock = `
STRATEGY SELECTION — choose per token based on its profile:

  Token Profile                         │ Strategy  │ Range       │ Reasoning
  ──────────────────────────────────────┼───────────┼─────────────┼──────────────────────────
  New memecoin, < 24h, high volatility  │ bid_ask   │ 25–35%      │ Single-sided SOL only = no bag risk
  Pumping token, price up > 50% recent  │ bid_ask   │ 35–50%      │ Catch sell pressure safely
  Proven token, organic > 80, ranging   │ spot      │ 35–50%      │ Two-sided = max fee capture
  High vol, stable, large bin_step      │ spot      │ 50–70%      │ Wide range, ride the trend
  High volume, stable, range-bound      │ spot      │ 30–40%      │ Both sides earn, low IL risk
  Cautious on decent token              │ spot      │ 25–35%      │ Single-sided spot (SOL side only)
  Unknown/uncertain                     │ bid_ask   │ 30–40%      │ Safe default

Range = % price drop from entry (active bin at deploy time).
Convert to bins using: bins = ceil(abs(log(1 - pct) / log(1 + bin_step/10000)))
Examples at different bin steps:
  25% range → 37 bins at 80bps, 24 bins at 125bps
  35% range → 55 bins at 80bps, 35 bins at 125bps
  50% range → 87 bins at 80bps, 56 bins at 125bps
  70% range → 152 bins at 80bps, 97 bins at 125bps
Always compute bins from the pool's actual bin_step — never use raw bin counts from this table.

Strategy types:
- bid_ask: Always single-sided (SOL only). Safest — no token exposure.
- spot: Can be EITHER two-sided or single-sided depending on bin placement.
  * Two-sided spot: bins above AND below active bin → earns fees on both sides, but holds token.
  * Single-sided spot (SOL only): all bins BELOW active bin → earns fees when price drops into range, no bag risk.
  * Use single-sided spot when you like the pool but want safety. Use two-sided spot only for high-conviction tokens.

Rules:
- Default to bid_ask or single-sided spot when unsure — always the safer choice.
- Only use two-sided spot if organic score > 80, holders > 1000, and price is stable/ranging.
- Wide ranges (>69 bins) are supported — the deploy tool handles multi-tx automatically.
- Report which strategy you chose, single vs two-sided, bin count, and the % range it covers.
${activeStrategy ? `\nSAVED STRATEGY (reference, not mandatory): ${activeStrategy.name} — ${activeStrategy.lp_strategy}, best for: ${activeStrategy.best_for}` : ""}`;

      // Targeted recall: recall strategy memories for common bin steps
      let memoryHints = "";
      try {
        const recalls = [];
        for (const bs of [80, 100, 125]) {
          const hits = recallForScreening({ bin_step: bs });
          for (const h of hits) recalls.push(h);
        }
        const recentPos = await getMyPositions();
        for (const p of recentPos.positions || []) {
          const hits = recallForScreening({ name: p.pair });
          for (const h of hits) {
            if (!recalls.some(x => x.key === h.key)) recalls.push(h);
          }
        }
        if (recalls.length > 0) {
          memoryHints = `\n\nMEMORY RECALL (from past sessions):\n${recalls.map(h => `[${h.source}] ${h.key}: ${h.answer}`).join("\n")}\n`;
        }
      } catch { /* memory recall is best-effort */ }

      // Pre-load top 3 candidates with recon data in parallel
      let candidateBlocks = "";
      let loadedCandidates = [];
      try {
        const result = await getTopCandidates({ limit: 5 });
        const candidates = result?.candidates || [];
        loadedCandidates = candidates;
        // Fetch dynamic fees sequentially to avoid RPC rate limit bursts
        const { fetchDynamicFee } = await import("./tools/screening.js");
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
          const dynFeeResult = dynFeeMap[c.pool] || null;
          const tokenData = infoResult?.results?.[0];
          const smartWalletCount = swResult?.in_pool?.length || 0;
          c._smartWalletCount = smartWalletCount;

          let block = `[${c.name}] pool: ${c.pool} | darwin: ${c.darwin_score ?? "?"}/100 | bin_step: ${c.bin_step} | fee/aTVL: ${c.fee_active_tvl_ratio}% | vol: $${c.volume} | organic: ${c.organic_score} | holders: ${c.holders} | volatility: ${c.volatility ?? "?"}`;

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
              block += `\n  Evil Panda entry: ${epPass ? "PASS" : "FAIL"} | need token24hVol>=${config.strategy.evilPanda?.minTokenVolume24h ?? 750000}, mcap>=${config.strategy.evilPanda?.minMcap ?? 200000}, 5m Supertrend green/price above`;
              block += ` | supertrend=${gmgnResult.candles.supertrend_direction ?? "?"}/${gmgnResult.candles.supertrend_price_above ? "above" : "not-above"} | RSI(2)=${gmgnResult.candles.rsi_2 ?? "?"}`;
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
          return { pool: c.pool, block };
        }));
        const rankedCandidates = rankCandidatesByDarwin(candidates);
        loadedCandidates = rankedCandidates;
        const blockMap = new Map(
          blocks
            .filter((b) => b.status === "fulfilled")
            .map((b) => [b.value.pool, b.value.block])
        );
        const validBlocks = rankedCandidates
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
            }, c.base_mint || c.base?.mint || null);
          } catch { /* staging is best-effort */ }
        }
      } catch (e) {
        log("cron", `Pre-load failed (${e.message}), agent will fetch manually`);
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
        ? `\n\nGMGN SIGNAL INTERPRETATION:\n- latest_signal_age_min lower = fresher smart-money / KOL interest\n- signal_count_30m / signal_count_2h and signal_amount_usd_30m / signal_amount_usd_2h measure recent smart-money + KOL conviction\n- latest_sold_ratio_percent lower = signal wallets are still holding; higher = signal more exhausted\n- Use GMGN signal as confirmation only, never as a standalone deploy trigger\n- Missing GMGN signal is neutral, not a hard fail\n- Evil Panda entry requires token-level GMGN volume24H >= $${config.strategy.evilPanda?.minTokenVolume24h ?? 750000}, GMGN marketCap >= $${config.strategy.evilPanda?.minMcap ?? 200000}, and 5m Supertrend green with price above Supertrend\n`
        : "";

      const { content } = await screenerLoop(`
SCREENING CYCLE — DEPLOY ONLY${memoryHints}${signalWeightsBlock}${kbScreenContext}${candidateBlocks}${gmgnSignalGuide}
${strategyBlock}
${candidateBlocks ? `The candidates above are PRE-LOADED with smart wallet, holder, narrative, memory, and GMGN signal data.
Evaluate them directly — no need to call get_top_candidates, check_smart_wallets_on_pool, get_token_holders, or get_token_narrative again.
HARD SKIP rules still apply:
- global_fees_sol < ${config.screening.minTokenFeesSol} SOL → skip (bundled/scam)
- top_10_real_holders_pct > 60% OR bundlers > 30% → skip
- No smart wallets or GMGN confirmation + empty/hype narrative → skip

Pick the best candidate, then: study_top_lpers → deploy_position with ${deployAmount} SOL.
Size your price_range_pct from the VOLATILITY TABLE in the range selection rules below — NOT from study avg_range_pct.
study_top_lpers is useful for strategy choice (bid_ask vs spot), hold times, and win rates — but their range data is from a different market regime and should not drive your range.` : `1. get_top_candidates, pick the best one.
2. check_smart_wallets_on_pool, get_token_holders (check global_fees_sol >= ${config.screening.minTokenFeesSol}), get_token_narrative.
3. HARD SKIP if global_fees_sol < ${config.screening.minTokenFeesSol} SOL or holders/narrative red flags.
4. study_top_lpers → use for strategy choice, hold times, win rates. Do NOT use avg_range_pct for your range — size from the VOLATILITY TABLE instead.
5. deploy_position with ${deployAmount} SOL and price_range_pct from volatility table (adjusted by lessons).`}
${getRangeSelectionText(deployAmount, currentBalance?.sol)}${usdcModeEnabled()
  ? `\n\nUSDC MODE IS ON: deploy sizing/funding is automatic — the system swaps USDC→SOL ($${config.usdc.deployAmountUsd}/position) and deploys single-sided. Do NOT pick a SOL amount or call swap_token to prepare funds; just call deploy_position for the chosen pool.`
  : ""}
      `, config.llm.maxSteps, []);
      screenReport = content;
    } catch (error) {
      log("cron_error", `Screening cycle failed: ${error.message}`);
      screenReport = `Screening cycle failed: ${error.message}`;
    } finally {
      setScreeningBusy(false);
      if (screenReport) {
        emit("cycle:screening", { report: screenReport });
        // File screening deploy to KB (direct write, no LLM)
        try { fileScreeningResult(screenReport); } catch { /* best-effort */ }
      }
    }
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
async function shutdown(signal) {
  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPnlWatcher();
  stopPolling();
  const positions = await getMyPositions();
  log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  process.exit(0);
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
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

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

const TELEGRAM_HELP = [
  "DLMM LP Agent — Telegram control",
  "",
  "/status — wallet + open positions",
  "/usdc [on|off] — show or toggle USDC mode",
  "/candidates — refresh top pools (then reply a number to deploy)",
  "1 / 2 / 3 … — deploy into that pool",
  "auto — agent picks the best pool and deploys",
  "go — start autonomous cycles",
  "/briefing — last-24h briefing",
  "/thresholds — screening thresholds + performance",
  "/learn [pool] — study top LPers (all top pools, or one address)",
  "/evolve — evolve thresholds from performance",
  "/stop — shut the agent down",
  "/help — this list",
  "",
  "Anything else is sent to the agent as a chat message.",
].join("\n");

// Telegram caps a single message at 4096 chars — chunk longer replies.
async function tgSend(text) {
  const s = String(text ?? "").trim();
  if (!s) return;
  for (let i = 0; i < s.length; i += 3900) {
    await sendMessage(s.slice(i, i + 3900));
  }
}

// Remote busy-guard — mirror of the terminal runBusy/runScreeningBusy, but
// replies over Telegram and never references readline (safe when headless).
async function runRemote(fn, { screening = false } = {}) {
  if (isBusy() || isManagementBusy() || isScreeningBusy()) {
    await tgSend("⏳ Agent is busy right now — try again in a moment.");
    return;
  }
  setBusy(true);
  if (screening) setScreeningBusy(true);
  try {
    await fn();
  } catch (e) {
    await tgSend(`❌ Error: ${e.message}`);
  } finally {
    if (screening) setScreeningBusy(false);
    setBusy(false);
  }
}

async function handleTelegramCommand(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return;
  log("telegram", `Incoming: ${text}`);
  const lower = text.toLowerCase();

  // ── Help ──
  if (text === "/help" || text === "/start" || text === "/commands") {
    return tgSend(TELEGRAM_HELP);
  }

  // ── Shutdown ──
  if (text === "/stop") {
    await tgSend("🛑 Shutting down the agent…");
    await shutdown("telegram /stop");
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
        const pnl = unit === "sol" ? `${p.pnl_sol ?? "?"} SOL` : `$${p.pnl_usd}`;
        lines.push(`• ${p.pair}  ${status}  fees: ${fees}  pnl: ${pnl} (${p.pnl_pct}%)`);
      }
      await tgSend(lines.join("\n"));
    });
  }

  // ── USDC mode (show/toggle) — terminal-parity with the CLI /usdc command ──
  if (text === "/usdc" || lower.startsWith("/usdc ")) {
    const arg = text.slice(5).trim().toLowerCase();
    if (arg === "on" || arg === "off") await setUsdcMode(arg === "on");
    return tgSend(usdcStatusText());
  }

  // ── Candidates (refresh + number the list for deploy) ──
  if (text === "/candidates") {
    return runRemote(async () => {
      const result = await getTopCandidates({ limit: 5 });
      const candidates = result.candidates || [];
      startupCandidates = candidates;
      const header = `🔍 Top pools (${result.total_eligible ?? candidates.length} eligible from ${result.total_screened ?? 0} screened):`;
      const hint = candidates.length
        ? `\n\nReply with a number (1-${candidates.length}) to deploy ${DEPLOY} SOL.`
        : "";
      await tgSend(`${header}\n\n${formatCandidates(candidates)}${hint}`);
    });
  }

  // ── Number pick: deploy into pool N ──
  const pick = parseInt(text, 10);
  const isBareNumber = !Number.isNaN(pick) && String(pick) === text;
  if (isBareNumber && pick >= 1 && pick <= startupCandidates.length) {
    return runRemote(async () => {
      const pool = startupCandidates[pick - 1];
      const balance = await getWalletBalances().catch(() => null);
      const amt = balance ? computeDeployAmount(balance.sol) : DEPLOY;
      await tgSend(`🚀 Deploying ${amt} SOL into ${pool.name}…`);
      const { content } = await screenerLoop(
        `Deploy ${amt} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
        config.llm.maxSteps,
      );
      launchCron({ announce: true });
      await tgSend(content);
    }, { screening: true });
  }
  if (isBareNumber) {
    return tgSend(`No pool #${pick} in the current list. Send /candidates first.`);
  }

  // ── auto: agent picks and deploys ──
  if (lower === "auto") {
    return runRemote(async () => {
      await tgSend("🤖 Agent is picking and deploying…");
      const balance = await getWalletBalances().catch(() => null);
      const amt = balance ? computeDeployAmount(balance.sol) : DEPLOY;
      const { content } = await screenerLoop(
        `get_top_candidates, pick the best one, get_active_bin, deploy_position with ${amt} SOL. Execute now, don't ask.`,
        config.llm.maxSteps,
      );
      launchCron({ announce: true });
      await tgSend(content);
    }, { screening: true });
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
    if (isBusy() || isScreeningBusy()) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
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
        const pnl = unit === "sol" ? `${p.pnl_sol ?? "?"} SOL` : `$${p.pnl_usd}`;
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${fees}  pnl: ${pnl} (${p.pnl_pct}%)`);
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
  startPolling(handleTelegramCommand);

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
        const currentBalance = await getWalletBalances().catch(() => null);
        const deployAmount = currentBalance ? computeDeployAmount(currentBalance.sol) : DEPLOY;
        const amtPhrase = usdcModeEnabled() ? `$${config.usdc.deployAmountUsd} (USDC mode — auto-funded from USDC)` : `${deployAmount} SOL`;
        console.log(`\nDeploying ${amtPhrase} into ${pool.name}...\n`);
        const { content: reply } = await screenerLoop(
          `Deploy ${amtPhrase} into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
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
        const currentBalance = await getWalletBalances().catch(() => null);
        const deployAmount = currentBalance ? computeDeployAmount(currentBalance.sol) : DEPLOY;
        const amtPhrase = usdcModeEnabled() ? `$${config.usdc.deployAmountUsd} (USDC mode — auto-funded from USDC)` : `${deployAmount} SOL`;
        const { content: reply } = await screenerLoop(
          `get_top_candidates, pick the best one, get_active_bin, deploy_position with ${amtPhrase}. Execute now, don't ask.`,
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
    if (input === "/stop") { await shutdown("user command"); return; }

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
          const pnl = unit === "sol" ? `${p.pnl_sol ?? "?"} SOL` : `$${p.pnl_usd}`;
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${fees}  pnl: ${pnl} (${p.pnl_pct}%)`);
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
    shutdown("stdin closed");
  });

} else {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  launchCron();
  maybeRunMissedBriefing().catch(() => {});

  // Telegram bot — full remote control works headless too.
  startPolling(handleTelegramCommand);
  if (runtimeMode.runStartupCheck) (async () => {
    try {
      const currentBalance = await getWalletBalances().catch(() => null);
      const deployAmount = currentBalance ? computeDeployAmount(currentBalance.sol) : DEPLOY;
      await screenerLoop(`
STARTUP CHECK
1. get_wallet_balance. 2. get_my_positions. 3. If SOL >= ${config.management.minSolToOpen}: get_top_candidates then deploy ${deployAmount} SOL. 4. Report.
      `, config.llm.maxSteps, []);
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
