import "dotenv/config";
import cron from "node-cron";
import readline from "readline";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary } from "./lessons.js";
import { registerCronRestarter } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, isEnabled as telegramEnabled } from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate } from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { initMemory, recallForScreening, recallForManagement, rememberPositionSnapshot } from "./memory.js";
import { updatePnlAndCheckExits } from "./state.js";
import { emit } from "./notifier.js";
import {
  sessionHistory, appendHistory, getHistory,
  isBusy, setBusy,
  isManagementBusy, setManagementBusy,
  isScreeningBusy, setScreeningBusy,
} from "./session.js";
import { startServer } from "./server.js";

log("startup", "DLMM LP Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${process.env.LLM_MODEL || "deepseek-chat"}`);

// Initialize holographic memory at startup
initMemory();

const TP_PCT  = config.management.takeProfitFeePct;
const DEPLOY  = config.management.deployAmountSol;

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
  const mgmt  = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn  = formatCountdown(nextRunIn(timers.screeningLastRun,  config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
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
}

function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (isManagementBusy()) return;
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
        for (const p of pos.positions || []) {
          // Memory recall
          const hits = recallForManagement(p);
          for (const h of hits) {
            recalls.push(`[${h.source}] ${h.key}: ${h.answer} (confidence: ${(h.confidence * 100).toFixed(0)}%)`);
          }
          // Store mid-position snapshot in nuggets
          rememberPositionSnapshot(p);

          // Trailing TP / stop loss check
          if (p.pnl_pct != null) {
            const exitAction = updatePnlAndCheckExits(p.position, p.pnl_pct, config);
            if (exitAction) {
              exits.push(`⚠ ${p.pair}: ${exitAction}`);
              log("exit_check", `${p.pair}: ${exitAction}`);
            }
          }
        }
        if (recalls.length > 0) {
          memoryHints = `\n\nMEMORY RECALL (from past sessions):\n${recalls.join("\n")}\n`;
        }
        if (exits.length > 0) {
          exitAlerts = `\n\nEXIT ALERTS (CLOSE THESE IMMEDIATELY):\n${exits.join("\n")}\n`;
        }
      } catch { /* best-effort */ }

      const { content } = await agentLoop(`
MANAGEMENT CYCLE${memoryHints}${exitAlerts}

1. get_my_positions — check all open positions.
2. For each position:
   - Call get_position_pnl.
   - Check state summary for any position instruction (e.g. "close at 5% profit").
   - INSTRUCTION OVERRIDE: If instruction condition IS MET → close immediately, no further analysis.
   - INSTRUCTION OVERRIDE: If instruction condition NOT YET MET → hold, regardless of other signals.
   - If no instruction: BIAS = STAY. Only close if yield died, pool collapsed, or extreme loss.
3. If closing: swap base tokens to SOL.
4. After any close — recalibrate management interval (MANDATORY):
   - No positions remaining → update_config management.managementIntervalMin = 10 (reset to default)
   - Positions still open → keep current interval (already set by deploy volatility)

REPORT FORMAT (Strictly follow this for each position — use ${config.management.pnlUnit?.toUpperCase() || "SOL"} values):
**[PAIR]** | Age: [X]m | Fees: [X] ${config.management.pnlUnit?.toUpperCase() || "SOL"} | PnL: [X]%
**Instruction:** [instruction if set, else "none"]
**Decision:** [STAY/CLOSE]
**Reason:** [1 short sentence]
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
    }
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, async () => {
    if (isScreeningBusy()) return;

    // Hard guards — don't even run the agent if preconditions aren't met
    try {
      const [positions, balance] = await Promise.all([getMyPositions(), getWalletBalances()]);
      if (positions.total_positions >= config.risk.maxPositions) {
        log("cron", `Screening skipped — max positions reached (${positions.total_positions}/${config.risk.maxPositions})`);
        return;
      }
      if (balance.sol < config.management.minSolToOpen) {
        log("cron", `Screening skipped — insufficient SOL (${balance.sol.toFixed(3)} < ${config.management.minSolToOpen})`);
        return;
      }
    } catch (e) {
      log("cron_error", `Screening pre-check failed: ${e.message}`);
      return;
    }

    setScreeningBusy(true);
    timers.screeningLastRun = Date.now();
    log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
    let screenReport = null;
    try {
      // Compute dynamic deploy amount based on current wallet (compounding)
      const currentBalance = await getWalletBalances().catch(() => null);
      const deployAmount = currentBalance ? computeDeployAmount(currentBalance.sol) : config.management.deployAmountSol;
      log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance?.sol ?? "?"} SOL)`);

      // Load active strategy
      const activeStrategy = getActiveStrategy();
      const strategyBlock = activeStrategy ? `
ACTIVE STRATEGY: ${activeStrategy.name} (by ${activeStrategy.author})
Apply these criteria during token selection and deployment:
- LP Type: ${activeStrategy.lp_strategy}
- Token: ${JSON.stringify(activeStrategy.token_criteria)}
- Entry: ${JSON.stringify(activeStrategy.entry)}
- Range: ${JSON.stringify(activeStrategy.range)}
- Exit: ${JSON.stringify(activeStrategy.exit)}
- Best for: ${activeStrategy.best_for}
Deviate from this strategy only if the token clearly doesn't match — explain why in your report.
` : `No active strategy set — use default bid_ask with standard settings.`;

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

      const { content } = await agentLoop(`
SCREENING CYCLE — DEPLOY ONLY${memoryHints}
${strategyBlock}
1. get_my_positions first. Only proceed if positions < ${config.risk.maxPositions}.
2. get_wallet_balance. Proceed if SOL >= ${config.management.minSolToOpen}.
3. get_top_candidates, pick the best one, and call study_top_lpers.
4. Call get_pool_memory for the chosen pool. If it has a bad track record (losing avg_pnl_pct, low win_rate), skip and try next candidate.
5. Call check_smart_wallets_on_pool for the chosen pool.
   - Smart wallets present → strong confidence boost, proceed to deploy.
   - For ALL pools (smart wallets or not): call get_token_holders (base mint) and check global_fees_sol.
     * global_fees_sol = total priority/jito tips paid by ALL traders on this token — NOT Meteora LP fees, do not confuse them.
     * HARD SKIP if global_fees_sol < ${config.screening.minTokenFeesSol} SOL — low fees = bundled txs or scam token, no exceptions.
   - No smart wallets → ALSO call get_token_narrative before deciding:
     * SKIP if: top_10_real_holders_pct > 60% OR bundlers_pct_in_top_100 > 30% OR narrative is empty/null OR narrative is pure hype with no specific story
     * CAUTION (check organic score + buy/sell pressure before deciding) if: bundlers_pct 15–30% AND top_10 > 40%
     * DEPLOY if: global_fees_sol >= ${config.screening.minTokenFeesSol}, distribution is healthy AND narrative has a specific origin
     * Bundlers 5–15% are normal and not a reason to skip on their own — weigh against overall token health
     * Report global_fees_sol, holder check, and narrative outcome in your reasoning.
6. If the pool passes all checks: get_active_bin and deploy_position with ${deployAmount} SOL.
   COMPOUNDING: This amount is scaled from your current wallet (${currentBalance?.sol ?? "?"} SOL).
   As profits accumulate and wallet grows, deploy amount increases automatically. Do NOT override with a smaller amount.
7. Report result and reasoning including smart wallet signal, holder check outcome, deploy amount used, and interval set.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel);
      screenReport = content;
    } catch (error) {
      log("cron_error", `Screening cycle failed: ${error.message}`);
      screenReport = `Screening cycle failed: ${error.message}`;
    } finally {
      setScreeningBusy(false);
      if (screenReport) emit("cycle:screening", { report: screenReport });
    }
  });

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (isManagementBusy()) return;
    setManagementBusy(true);
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      setManagementBusy(false);
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

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog];
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
async function shutdown(signal) {
  log("shutdown", `Received ${signal}. Shutting down...`);
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
    const vol    = `$${((p.volume_24h || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org    = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!isBusy()) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun  = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (isBusy()) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    setBusy(true); rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { setBusy(false); rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  setBusy(true);
  let startupCandidates = [];

  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions(),
      getTopCandidates({ limit: 5 }),
    ]);

    startupCandidates = candidates;

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
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
  launchCron();
  maybeRunMissedBriefing().catch(() => {});

  // Web server — provides timer countdowns to the frontend
  startServer(() => ({
    management: formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin)),
    screening:  formatCountdown(nextRunIn(timers.screeningLastRun,  config.schedule.screeningIntervalMin)),
  })).catch((e) => log("server_error", `Web server failed to start: ${e.message}`));

  // Telegram bot
  startPolling(async (text) => {
    if (isManagementBusy() || isScreeningBusy() || isBusy()) {
      sendMessage("Agent is busy right now — try again in a moment.").catch(() => {});
      return;
    }

    if (text === "/briefing") {
      try {
        const briefing = await generateBriefing();
        emit("briefing", { html: briefing });
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => {});
      }
      return;
    }

    setBusy(true);
    try {
      log("telegram", `Incoming: ${text}`);
      const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel);
      appendHistory(text, content);
      await sendMessage(content);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    } finally {
      setBusy(false);
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  });

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
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
      await runBusy(async () => {
        const pool = startupCandidates[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates, pick the best one, get_active_bin, deploy_position with ${DEPLOY} SOL. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
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

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        startupCandidates = candidates;
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  maxVolatility:    ${s.maxVolatility}`);
      console.log(`  minFeeTvlRatio:   ${s.minFeeTvlRatio}`);
      console.log(`  minOrganic:       ${s.minOrganic}`);
      console.log(`  minHolders:       ${s.minHolders}`);
      console.log(`  maxPriceChangePct: ${s.maxPriceChangePct}`);
      console.log(`  timeframe:        ${s.timeframe}`);
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
          "GENERAL"
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
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel);
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => {});
  (async () => {
    try {
      await agentLoop(`
STARTUP CHECK
1. get_wallet_balance. 2. get_my_positions. 3. If SOL >= ${config.management.minSolToOpen}: get_top_candidates then deploy ${DEPLOY} SOL. 4. Report.
      `, config.llm.maxSteps, [], "SCREENER");
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
