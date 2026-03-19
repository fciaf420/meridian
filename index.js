import "dotenv/config";
import cron from "node-cron";
import readline from "readline";
import { agentLoop, lightChat } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary, deduplicateLessons } from "./lessons.js";
import { registerCronRestarter } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, isEnabled as telegramEnabled } from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate } from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { initMemory, recallForScreening, recallForManagement, rememberPositionSnapshot, maybePromote, checkCapacity } from "./memory.js";
import { updatePnlAndCheckExits } from "./state.js";
import { emit } from "./notifier.js";
import { startPnlWatcher, stopPnlWatcher } from "./pnl-watcher.js";
import { recordPositionSnapshot as recordPoolSnapshot, recallForPool } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenHolders, getTokenNarrative } from "./tools/token.js";
import {
  sessionHistory, appendHistory, getHistory,
  isBusy, setBusy,
  isManagementBusy, setManagementBusy,
  isScreeningBusy, setScreeningBusy,
} from "./session.js";
import { startServer } from "./server.js";

log("startup", "DLMM LP Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${config.llm.managementModel} (provider: ${process.env.LLM_PROVIDER || "openrouter"})`);

// Initialize holographic memory at startup
initMemory();

// One-time lesson dedup on startup
deduplicateLessons();

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
    if (isManagementBusy()) return;
    if (isScreeningBusy()) { log("cron", "Management deferred — screening cycle in progress"); return; }
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
        }
        if (recalls.length > 0) {
          memoryHints = `\n\nMEMORY RECALL (from past sessions):\n${recalls.join("\n")}\n`;
        }
        if (exits.length > 0) {
          exitAlerts = `\n\nEXIT ALERTS (CLOSE THESE IMMEDIATELY):\n${exits.join("\n")}\n`;
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

      const pnlUnit = config.management.pnlUnit?.toUpperCase() || "SOL";
      const { content } = await agentLoop(`
MANAGEMENT CYCLE${memoryHints}${exitAlerts}${autoCloseInfo}

HARD CLOSE RULES (check in order — close immediately on first match, no further analysis):
1. Position instruction condition met → CLOSE immediately (highest priority)
2. Position instruction exists but condition NOT met → HOLD (skip all other rules)
3. pnl_pct >= ${config.management.takeProfitFeePct}% → CLOSE (take profit)
4. minutes_out_of_range >= ${config.management.outOfRangeWaitMinutes} → CLOSE (OOR timeout)
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
3. If closing: swap base tokens to SOL immediately after.
4. After any close — recalibrate management interval (MANDATORY):
   - No positions remaining → update_config setting=managementIntervalMin value=10
   - Positions still open → keep current interval

REPORT FORMAT (Strictly follow this for each position — use ${pnlUnit} values):
**[PAIR]** | Age: [X]m | Fees: [X] ${pnlUnit} | PnL: [X]%
**Rule triggered:** [rule number or "none"]
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
      // Promote high-hit nugget facts to MEMORY.md
      maybePromote();
      checkCapacity();
    }
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, async () => {
    if (isScreeningBusy()) return;
    if (isManagementBusy()) { log("cron", "Screening deferred — management cycle in progress"); return; }

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
      try {
        const result = await getTopCandidates({ limit: 3 });
        const candidates = result?.candidates || [];
        const blocks = await Promise.allSettled(candidates.map(async (c) => {
          const [sw, holders, narrative, poolMem] = await Promise.allSettled([
            checkSmartWalletsOnPool({ pool_address: c.pool }),
            c.base_mint ? getTokenHolders({ mint: c.base_mint }) : null,
            c.base_mint ? getTokenNarrative({ mint: c.base_mint }) : null,
            recallForPool(c.pool),
          ]);
          const swResult = sw.status === "fulfilled" ? sw.value : null;
          const holdResult = holders.status === "fulfilled" ? holders.value : null;
          const narrResult = narrative.status === "fulfilled" ? narrative.value : null;
          const memResult = poolMem.status === "fulfilled" ? poolMem.value : null;

          let block = `[${c.name}] pool: ${c.pool} | bin_step: ${c.bin_step} | fee/aTVL: ${c.fee_active_tvl_ratio}% | vol: $${c.volume} | organic: ${c.organic_score} | holders: ${c.holders}`;
          if (swResult?.found?.length > 0) block += `\n  Smart wallets: ${swResult.found.length} found`;
          else block += `\n  Smart wallets: none`;
          if (holdResult?.global_fees_sol != null) block += ` | global_fees: ${holdResult.global_fees_sol} SOL`;
          if (holdResult?.top_10_real_holders_pct != null) block += ` | top10: ${holdResult.top_10_real_holders_pct}%`;
          if (narrResult?.narrative) block += `\n  Narrative: ${narrResult.narrative.slice(0, 150)}`;
          if (memResult) block += `\n  Memory: ${memResult}`;
          return block;
        }));
        const validBlocks = blocks.filter(b => b.status === "fulfilled").map(b => b.value);
        if (validBlocks.length > 0) {
          candidateBlocks = `\n\nPRE-LOADED CANDIDATES (recon already done — evaluate and deploy the best one):\n${validBlocks.join("\n\n")}\n`;
        }
      } catch (e) {
        log("cron", `Pre-load failed (${e.message}), agent will fetch manually`);
      }

      const { content } = await agentLoop(`
SCREENING CYCLE — DEPLOY ONLY${memoryHints}${candidateBlocks}
${strategyBlock}
${candidateBlocks ? `The candidates above are PRE-LOADED with smart wallet, holder, narrative, and memory data.
Evaluate them directly — no need to call get_top_candidates, check_smart_wallets_on_pool, get_token_holders, or get_token_narrative again.
HARD SKIP rules still apply:
- global_fees_sol < ${config.screening.minTokenFeesSol} SOL → skip (bundled/scam)
- top_10_real_holders_pct > 60% OR bundlers > 30% → skip
- No smart wallets + empty/hype narrative → skip

Pick the best candidate, then: get_active_bin → calculate_bins → deploy_position with ${deployAmount} SOL.` : `1. get_top_candidates, pick the best one.
2. check_smart_wallets_on_pool, get_token_holders (check global_fees_sol >= ${config.screening.minTokenFeesSol}), get_token_narrative.
3. HARD SKIP if global_fees_sol < ${config.screening.minTokenFeesSol} SOL or holders/narrative red flags.
4. get_active_bin → calculate_bins → deploy_position with ${deployAmount} SOL.`}
- Choose strategy (bid_ask or spot) and bin range based on the token profile table above.
- COMPOUNDING: Deploy amount is ${deployAmount} SOL (scaled from wallet: ${currentBalance?.sol ?? "?"} SOL). Do NOT override with a smaller amount.
- After deploy: update_config setting=managementIntervalMin based on volatility (>=5→3, 2-5→5, <2→10).
- Report: strategy chosen + why, smart wallet signal, holder check, deploy amount, interval set.
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

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  _cronTasks = [mgmtTask, screenTask, briefingTask, briefingWatchdog];

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
  const promptInterval = setInterval(() => {
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
    const [wallet, positions, screenResult] = await Promise.all([
      getWalletBalances(),
      getMyPositions(),
      getTopCandidates({ limit: 5 }),
    ]);

    const candidates = screenResult.candidates || [];
    const total_eligible = screenResult.total_eligible ?? candidates.length;
    const total_screened = screenResult.total_screened ?? 0;
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
      const { content } = await lightChat(text, sessionHistory, config.llm.generalModel);
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
