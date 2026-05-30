// server.js — Express + WebSocket server for the web chat UI
// Provides REST API, static file serving, and real-time WebSocket communication.

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import {
  sessionHistory,
  getHistory,
  appendHistory,
  isBusy,
  setBusy,
  isManagementBusy,
  isScreeningBusy,
  setScreeningBusy,
} from "./session.js";
import { emit, on } from "./notifier.js";
import { agentLoop, lightChat, screenerLoop } from "./agent.js";
import { getMyPositions } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { getLpOverview } from "./tools/lp-overview.js";
import { generateBriefing } from "./briefing.js";

// Cached startup data — avoids duplicate Helius calls when WebSocket connects
let _startupCache = { wallet: null, positions: null, candidates: null, lpOverview: null, ts: 0 };
export function setStartupCache({ wallet, positions, candidates, lpOverview }) {
  _startupCache = { wallet, positions, candidates, lpOverview, ts: Date.now() };
}
import { getPerformanceSummary, getPerformanceHistory, listLessons, evolveThresholds } from "./lessons.js";
import { getMemoryDashboardData } from "./memory.js";
import { loadWeights } from "./signal-weights.js";
import { getActiveExperiment, loadAutoresearch } from "./autoresearch.js";
import { buildKnowledgeGraph } from "./tools/knowledge-graph.js";
import { log } from "./logger.js";
import { getScreeningThresholdSummary, normalizeCandidatesPayload } from "./runtime-helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.join(__dirname, "web", "dist");

const DEFAULT_PORT = 3737;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Send JSON through a WebSocket if it's open. */
function wsSend(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

/** Broadcast JSON to every connected WebSocket client. */
function broadcast(wss, data) {
  const payload = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

/** Build the current status object. */
function buildStatus() {
  return {
    type: "status",
    busy: isBusy(),
    managementBusy: isManagementBusy(),
    screeningBusy: isScreeningBusy(),
  };
}

function buildDarwinPayload() {
  const data = loadWeights();
  const weights = Object.entries(data.weights || {})
    .map(([signal, weight]) => ({
      signal,
      weight,
      direction: data.directions?.[signal] ?? "unknown",
    }))
    .sort((a, b) => b.weight - a.weight);

  return {
    enabled: config.darwin?.enabled === true,
    config: config.darwin ?? {},
    last_recalc: data.last_recalc ?? null,
    recalc_count: data.recalc_count ?? 0,
    weights,
    history: Array.isArray(data.history) ? data.history.slice(-12) : [],
  };
}

function buildAutoresearchPayload() {
  const state = loadAutoresearch();
  const activeExperiment = getActiveExperiment();
  const recentExperiments = Array.isArray(state.experiments)
    ? state.experiments
        .slice(-12)
        .reverse()
        .map((experiment) => ({
          id: experiment.id,
          section: experiment.section,
          hypothesis: experiment.hypothesis,
          status: experiment.status,
          started_at: experiment.started_at,
          baseline: experiment.baseline ?? null,
          trial: experiment.trial ?? null,
        }))
    : [];

  return {
    enabled: config.autoresearch?.enabled === true,
    config: config.autoresearch ?? {},
    cooldownRemaining: state.cooldownRemaining ?? 0,
    active: activeExperiment
      ? {
          id: activeExperiment.id,
          section: activeExperiment.section,
          hypothesis: activeExperiment.hypothesis,
          status: activeExperiment.status,
          started_at: activeExperiment.started_at,
          baseline: activeExperiment.baseline ?? null,
          trial: activeExperiment.trial ?? null,
        }
      : null,
    keptOverrideSections: Object.keys(state.kept_overrides || {}),
    recentExperiments,
    recentLessons: listLessons({ tag: "autoresearch", limit: 20 }).lessons,
  };
}

function buildInsightsPayload() {
  return {
    lessons: listLessons({ limit: 30 }),
    memory: getMemoryDashboardData(),
    darwin: buildDarwinPayload(),
    autoresearch: buildAutoresearchPayload(),
  };
}

// ---------------------------------------------------------------------------
// startServer(timersFn)
// ---------------------------------------------------------------------------

/**
 * Start the Express + WebSocket server.
 *
 * @param {Function} timersFn — Returns { management: string, screening: string }
 *   with formatted countdown strings. Timer state lives in index.js; this
 *   function bridges that gap.
 * @returns {Promise<{ app, server, wss }>} Resolves when the server is listening.
 */
export function startServer(timersFn) {
  const port = config.web?.port ?? DEFAULT_PORT;

  const app = express();
  app.use(express.json());

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  // ═══════════════════════════════════════════
  //  DASHBOARD AUTH (fund-moving surfaces)
  // ═══════════════════════════════════════════
  //
  // DASHBOARD_TOKEN gates every state-mutating / fund-moving WebSocket message
  // (deploys, /auto, /learn, /evolve) and the full settings dump. Read-only
  // status / subscribe / data views remain open so the dashboard still renders.
  //
  // If DASHBOARD_TOKEN is set: clients must present it (via the `?token=` query
  // string on the /ws URL, or an `{ type: "auth", token }` message) before any
  // fund-moving command is honored.
  //
  // If DASHBOARD_TOKEN is UNSET: we log a warning and REFUSE all fund-moving
  // commands (fail-closed) while continuing to serve read-only data.
  const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || "";
  if (!DASHBOARD_TOKEN) {
    log(
      "server",
      "WARNING: DASHBOARD_TOKEN is not set — fund-moving dashboard commands " +
        "(deploy, /auto, /learn, /evolve, full settings) are DISABLED. " +
        "Read-only views remain available. Set DASHBOARD_TOKEN to enable them.",
    );
  }

  /** Constant-time-ish equality for the shared token. */
  function tokenMatches(provided) {
    if (!DASHBOARD_TOKEN || typeof provided !== "string") return false;
    if (provided.length !== DASHBOARD_TOKEN.length) return false;
    let diff = 0;
    for (let i = 0; i < provided.length; i++) {
      diff |= provided.charCodeAt(i) ^ DASHBOARD_TOKEN.charCodeAt(i);
    }
    return diff === 0;
  }

  /**
   * Whether a WebSocket connection is allowed to run fund-moving / secret-
   * exposing commands. Requires DASHBOARD_TOKEN to be configured AND the client
   * to have presented a matching token (query string or auth message).
   */
  function isAuthorized(ws) {
    return Boolean(DASHBOARD_TOKEN) && ws._authed === true;
  }

  /**
   * Recursively redact secret-looking fields from a config object so the
   * dashboard never leaks the wallet key or any private credential. Matches
   * `walletKey`, anything ending in `Key`/`Token`, and anything containing
   * `private`/`secret`/`mnemonic`/`seed` (case-insensitive).
   */
  function redactSecrets(value) {
    const SECRET_RE = /(walletkey|key$|token$|private|secret|mnemonic|seed|passphrase)/i;
    if (Array.isArray(value)) {
      return value.map((v) => redactSecrets(v));
    }
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (SECRET_RE.test(k)) {
          out[k] = "***REDACTED***";
        } else {
          out[k] = redactSecrets(v);
        }
      }
      return out;
    }
    return value;
  }

  /** Reject an unauthorized fund-moving request with a clear reason. */
  function denyUnauthorized(ws) {
    const reason = DASHBOARD_TOKEN
      ? "Unauthorized — this action requires a valid dashboard token."
      : "Unauthorized — fund-moving actions are disabled because DASHBOARD_TOKEN is not configured on the server.";
    wsSend(ws, { type: "error", text: reason });
  }

  // ═══════════════════════════════════════════
  //  HTTP ROUTES
  // ═══════════════════════════════════════════

  app.get("/api/status", (_req, res) => {
    res.json({
      busy: isBusy(),
      managementBusy: isManagementBusy(),
      screeningBusy: isScreeningBusy(),
    });
  });

  app.get("/api/history", (_req, res) => {
    res.json(getHistory());
  });

  app.get("/api/candidates", async (_req, res) => {
    try {
      const result = await getTopCandidates({ limit: 5 });
      res.json(normalizeCandidatesPayload(result));
    } catch (err) {
      log("server_error", `GET /api/candidates failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/insights", (_req, res) => {
    try {
      res.json(buildInsightsPayload());
    } catch (err) {
      log("server_error", `GET /api/insights failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // Static files — only if the dist directory exists (production build)
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));

    // SPA fallback — serve index.html for any non-API route
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // ═══════════════════════════════════════════
  //  NOTIFIER → WebSocket BRIDGE
  // ═══════════════════════════════════════════

  const FORWARDED_EVENTS = [
    "deploy",
    "close",
    "out_of_range",
    "briefing",
  ];

  for (const eventName of FORWARDED_EVENTS) {
    on(eventName, (data) => {
      broadcast(wss, { type: "notification", event: eventName, data });
    });
  }

  // Post-cycle data broadcasts — send notification + fresh structured data
  on("cycle:management", async (data) => {
    broadcast(wss, { type: "notification", event: "cycle:management", data });
    const [pos, wal] = await Promise.allSettled([getMyPositions(), getWalletBalances()]);
    if (pos.status === "fulfilled") broadcast(wss, { type: "positions", data: pos.value });
    if (wal.status === "fulfilled") broadcast(wss, { type: "wallet", data: wal.value });
  });

  on("cycle:screening", async (data) => {
    broadcast(wss, { type: "notification", event: "cycle:screening", data });
    const cands = await getTopCandidates({ limit: 5 }).catch(() => null);
    if (cands) broadcast(wss, { type: "candidates", data: normalizeCandidatesPayload(cands) });
  });

  // Also broadcast fresh data after deploy/close events
  on("deploy", async () => {
    const [pos, wal] = await Promise.allSettled([getMyPositions(), getWalletBalances()]);
    if (pos.status === "fulfilled") broadcast(wss, { type: "positions", data: pos.value });
    if (wal.status === "fulfilled") broadcast(wss, { type: "wallet", data: wal.value });
  });

  on("close", async () => {
    const [pos, wal] = await Promise.allSettled([getMyPositions(), getWalletBalances()]);
    if (pos.status === "fulfilled") broadcast(wss, { type: "positions", data: pos.value });
    if (wal.status === "fulfilled") broadcast(wss, { type: "wallet", data: wal.value });
  });

  on("chat:response", (data) => {
    broadcast(wss, { type: "chat:response", ...data });
  });

  on("status", () => {
    broadcast(wss, buildStatus());
  });

  // ═══════════════════════════════════════════
  //  TIMER BROADCAST (every 10 s)
  // ═══════════════════════════════════════════

  const timerInterval = setInterval(() => {
    if (wss.clients.size === 0) return;
    const info = typeof timersFn === "function" ? timersFn() : {};
    broadcast(wss, {
      type: "timer",
      management: info.management ?? "---",
      screening: info.screening ?? "---",
    });
  }, 10_000);

  // Clean up interval if server closes
  server.on("close", () => clearInterval(timerInterval));

  // ═══════════════════════════════════════════
  //  WEBSOCKET CONNECTION HANDLING
  // ═══════════════════════════════════════════

  wss.on("connection", async (ws, req) => {
    log("server", "WebSocket client connected");

    // Per-connection auth state. Read-only views work regardless; fund-moving
    // commands require this to be true (which also requires DASHBOARD_TOKEN).
    ws._authed = false;
    if (DASHBOARD_TOKEN && req?.url) {
      try {
        const qs = new URL(req.url, "http://localhost").searchParams;
        const provided = qs.get("token");
        if (provided && tokenMatches(provided)) {
          ws._authed = true;
        }
      } catch {
        // Malformed URL — leave unauthenticated.
      }
    }

    // Send init payload with status, history, timers, and data
    const timerInfo = typeof timersFn === "function" ? timersFn() : {};

    // Use cached startup data if fresh (< 30s), otherwise fetch live
    const useCached = _startupCache.ts && (Date.now() - _startupCache.ts < 30000);
    const [wallet, positions, candidateResult, lpOverviewResult] = useCached
      ? [
          { status: "fulfilled", value: _startupCache.wallet },
          { status: "fulfilled", value: _startupCache.positions },
          { status: "fulfilled", value: _startupCache.candidates },
          { status: "fulfilled", value: _startupCache.lpOverview },
        ]
      : await Promise.allSettled([
          getWalletBalances(),
          getMyPositions(),
          getTopCandidates({ limit: 5 }),
          getLpOverview(),
        ]);

    wsSend(ws, {
      type: "init",
      authed: isAuthorized(ws),
      authRequired: Boolean(DASHBOARD_TOKEN),
      status: {
        busy: isBusy(),
        managementBusy: isManagementBusy(),
        screeningBusy: isScreeningBusy(),
      },
      history: getHistory(),
      timers: {
        management: timerInfo.management ?? "---",
        screening: timerInfo.screening ?? "---",
      },
      positions: positions.status === "fulfilled" ? positions.value : null,
      wallet: wallet.status === "fulfilled" ? wallet.value : null,
      candidates: candidateResult.status === "fulfilled" ? normalizeCandidatesPayload(candidateResult.value) : null,
      lpOverview: lpOverviewResult.status === "fulfilled" ? lpOverviewResult.value : null,
    });

    // ── Incoming messages ──
    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        wsSend(ws, { type: "error", text: "Invalid JSON" });
        return;
      }

      if (msg.type === "auth") {
        // Authenticate an already-open connection (alternative to the ?token=
        // query string). Never reveal the expected token; just report success.
        if (DASHBOARD_TOKEN && tokenMatches(msg.token)) {
          ws._authed = true;
          wsSend(ws, { type: "auth:result", ok: true });
        } else {
          ws._authed = false;
          wsSend(ws, { type: "auth:result", ok: false });
        }
      } else if (msg.type === "quick-action") {
        await handleQuickAction(ws, msg.action);
      } else if (msg.type === "chat") {
        await handleChat(ws, wss, msg.text);
      } else if (msg.type === "command") {
        await handleCommand(ws, msg.command);
      } else {
        wsSend(ws, { type: "error", text: `Unknown message type: ${msg.type}` });
      }
    });

    ws.on("close", () => {
      log("server", "WebSocket client disconnected");
    });
  });

  // ═══════════════════════════════════════════
  //  CHAT HANDLER (with message queue)
  // ═══════════════════════════════════════════

  const chatQueue = [];
  let processingChat = false;

  async function processNextChat() {
    if (processingChat || chatQueue.length === 0) return;

    // Wait until agent is free
    if (isBusy() || isManagementBusy() || isScreeningBusy()) {
      setTimeout(processNextChat, 2000); // retry in 2s
      return;
    }

    processingChat = true;
    const { ws, text } = chatQueue.shift();

    setBusy(true);
    try {
      log("server", `Chat from web: ${text}`);
      const { content } = await lightChat(
        text,
        sessionHistory,
        config.llm.generalModel,
      );

      appendHistory(text, content);

      const response = {
        type: "chat:response",
        text: content,
        ts: new Date().toISOString(),
      };

      emit("chat:response", response);
    } catch (err) {
      log("server_error", `Chat handler failed: ${err.message}`);
      wsSend(ws, { type: "error", text: `Error: ${err.message}` });
    } finally {
      setBusy(false);
      processingChat = false;
      processNextChat(); // process next queued message
    }
  }

  function handleChat(ws, _wss, text) {
    if (!text || typeof text !== "string" || !text.trim()) {
      wsSend(ws, { type: "error", text: "Empty message" });
      return;
    }

    chatQueue.push({ ws, text: text.trim() });

    if (chatQueue.length > 1) {
      wsSend(ws, { type: "chat:response", text: `Message queued (${chatQueue.length - 1} ahead). Will process when agent is free.`, ts: new Date().toISOString() });
    }

    processNextChat();
  }

  // ═══════════════════════════════════════════
  //  COMMAND HANDLER
  // ═══════════════════════════════════════════

  async function handleCommand(ws, command) {
    if (!command || typeof command !== "string") {
      wsSend(ws, { type: "error", text: "Invalid command" });
      return;
    }

    try {
      switch (command) {
        case "/briefing": {
          const briefing = await generateBriefing();
          wsSend(ws, {
            type: "chat:response",
            text: briefing,
            ts: new Date().toISOString(),
          });
          break;
        }

        case "/status": {
          const [wallet, positions] = await Promise.all([
            getWalletBalances(),
            getMyPositions(),
          ]);
          const unit = config.management.pnlUnit || "sol";
          const lines = [
            `Wallet: ${wallet.sol} SOL ($${wallet.sol_usd}) | SOL price: $${wallet.sol_price}`,
            `Positions: ${positions.total_positions} open`,
          ];
          for (const p of positions.positions || []) {
            const status = p.in_range ? "in-range" : "OUT OF RANGE";
            const fees = unit === "sol" ? `${p.unclaimed_fees_sol ?? "?"} SOL` : `$${p.unclaimed_fees_usd}`;
            const pnl = unit === "sol" ? `${p.pnl_sol ?? "?"} SOL` : `$${p.pnl_usd}`;
            lines.push(`  ${p.pair} — ${status} | fees: ${fees} | pnl: ${pnl} (${p.pnl_pct}%)`);
          }
          wsSend(ws, {
            type: "chat:response",
            text: lines.join("\n"),
            ts: new Date().toISOString(),
          });
          break;
        }

        case "/candidates": {
          const result = await getTopCandidates({ limit: 5 });
          const { candidates, total_eligible, total_screened } = result;
          const lines = [
            `Top pools (${total_eligible} eligible from ${total_screened} screened):`,
          ];
          for (const [i, c] of candidates.entries()) {
            const name = c.name || "unknown";
            const ratio = c.fee_active_tvl_ratio ?? c.fee_tvl_ratio ?? "?";
            lines.push(
              `  [${i + 1}] ${name} — fee/aTVL: ${ratio}% | vol: $${((c.volume || 0) / 1000).toFixed(1)}k | organic: ${c.organic_score}`,
            );
          }
          wsSend(ws, {
            type: "chat:response",
            text: lines.join("\n"),
            ts: new Date().toISOString(),
          });
          break;
        }

        case "/thresholds": {
          const lines = ["Current screening thresholds:"];
          for (const [label, value] of getScreeningThresholdSummary(config.screening)) {
            lines.push(`  ${label}: ${value ?? "n/a"}`);
          }
          const perf = getPerformanceSummary();
          if (perf) {
            lines.push("", `  Based on ${perf.total_positions_closed} closed positions`);
            lines.push(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
          } else {
            lines.push("", "  No closed positions yet — thresholds are preset defaults.");
          }
          wsSend(ws, {
            type: "chat:response",
            text: lines.join("\n"),
            ts: new Date().toISOString(),
          });
          break;
        }

        case "/learn": {
          if (!isAuthorized(ws)) {
            denyUnauthorized(ws);
            break;
          }
          setBusy(true);
          try {
            const { candidates } = await getTopCandidates({ limit: 5 });
            if (!candidates.length) {
              wsSend(ws, { type: "chat:response", text: "No eligible pools found to study.", ts: new Date().toISOString() });
              break;
            }
            const poolList = candidates.map((c, i) => `${i + 1}. ${c.name} (${c.pool})`).join("\n");
            const { content } = await agentLoop(
              `Study top LPers across these ${candidates.length} pools by calling study_top_lpers for each:\n\n${poolList}\n\nFor each pool, call study_top_lpers then move to the next. After studying all pools:\n1. Identify patterns across multiple pools.\n2. Derive 4-8 concrete lessons using add_lesson.\n3. Summarize what you learned.`,
              config.llm.maxSteps, [], "GENERAL", config.llm.generalModel,
            );
            emit("chat:response", { text: content, ts: new Date().toISOString() });
          } finally {
            setBusy(false);
          }
          break;
        }

        case "/evolve": {
          if (!isAuthorized(ws)) {
            denyUnauthorized(ws);
            break;
          }
          const perf = getPerformanceSummary();
          if (!perf || perf.total_positions_closed < 5) {
            const needed = 5 - (perf?.total_positions_closed || 0);
            wsSend(ws, { type: "chat:response", text: `Need at least 5 closed positions to evolve. ${needed} more needed.`, ts: new Date().toISOString() });
            break;
          }
          const lessonsData = JSON.parse(fs.readFileSync(path.join(__dirname, "lessons.json"), "utf8"));
          const result = evolveThresholds(lessonsData.performance, config);
          if (!result || Object.keys(result.changes).length === 0) {
            wsSend(ws, { type: "chat:response", text: "No threshold changes needed — current settings already match performance data.", ts: new Date().toISOString() });
          } else {
            reloadScreeningThresholds();
            const lines = ["Thresholds evolved:"];
            for (const [key, val] of Object.entries(result.changes)) {
              lines.push(`  ${key}: ${result.rationale[key]}`);
            }
            lines.push("", "Saved to user-config.json. Applied immediately.");
            wsSend(ws, { type: "chat:response", text: lines.join("\n"), ts: new Date().toISOString() });
          }
          break;
        }

        case "/auto": {
          if (!isAuthorized(ws)) {
            denyUnauthorized(ws);
            break;
          }
          if (isBusy() || isManagementBusy() || isScreeningBusy()) {
            wsSend(ws, { type: "error", text: "Agent is busy right now — try again in a moment." });
            break;
          }
          setBusy(true);
          setScreeningBusy(true);
          try {
            const currentBalance = await getWalletBalances().catch(() => null);
            const deployAmount = currentBalance ? computeDeployAmount(currentBalance.sol) : config.management.deployAmountSol;
            const { content } = await screenerLoop(
              `get_top_candidates, pick the best one, get_active_bin, deploy_position with ${deployAmount} SOL. Execute now, don't ask.`,
              config.llm.maxSteps, [],
            );
            appendHistory("auto", content);
            emit("chat:response", { text: content, ts: new Date().toISOString() });
          } finally {
            setScreeningBusy(false);
            setBusy(false);
          }
          break;
        }

        default: {
          // Handle number picks: "1", "2", "3" etc. — deploy into that candidate.
          // Require a STRICT all-digits command (optionally prefixed with "/") so
          // garbage like "/1abc" is NOT treated as pool pick #1.
          const isNumericPick = /^\/?\d+$/.test(command.trim());
          const pick = isNumericPick ? parseInt(command.replace("/", ""), 10) : NaN;
          if (isNumericPick && !isNaN(pick) && pick >= 1) {
            // Deploying real funds — gate behind the dashboard token.
            if (!isAuthorized(ws)) {
              denyUnauthorized(ws);
              break;
            }
            if (isBusy() || isManagementBusy() || isScreeningBusy()) {
              wsSend(ws, { type: "error", text: "Agent is busy right now." });
              break;
            }
            setBusy(true);
            setScreeningBusy(true);
            try {
              const { candidates } = await getTopCandidates({ limit: 10 });
              if (pick > candidates.length) {
                wsSend(ws, { type: "error", text: `Only ${candidates.length} candidates available.` });
                break;
              }
              const pool = candidates[pick - 1];
              const currentBalance = await getWalletBalances().catch(() => null);
              const deployAmount = currentBalance ? computeDeployAmount(currentBalance.sol) : config.management.deployAmountSol;
              const { content } = await screenerLoop(
                `Deploy ${deployAmount} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
                config.llm.maxSteps, [],
              );
              appendHistory(`deploy #${pick} ${pool.name}`, content);
              emit("chat:response", { text: content, ts: new Date().toISOString() });
            } finally {
              setScreeningBusy(false);
              setBusy(false);
            }
            break;
          }
          wsSend(ws, {
            type: "error",
            text: `Unknown command: ${command}`,
          });
        }
      }
    } catch (err) {
      log("server_error", `Command "${command}" failed: ${err.message}`);
      wsSend(ws, { type: "error", text: `Error: ${err.message}` });
    }
  }

  // ═══════════════════════════════════════════
  //  QUICK-ACTION HANDLER
  // ═══════════════════════════════════════════

  async function handleQuickAction(ws, action) {
    if (!action || typeof action !== "string") {
      wsSend(ws, { type: "quick-action:error", action: action ?? "unknown", error: "Invalid action" });
      return;
    }

    try {
      let data;
      switch (action) {
        case "top-pools": {
          const result = await getTopCandidates({ limit: 10 });
          data = result.candidates ?? result;
          break;
        }
        case "recent-closes": {
          const result = getPerformanceHistory({ hours: 24, limit: 10 });
          data = result;
          break;
        }
        case "lessons": {
          data = listLessons({ limit: 20 });
          break;
        }
        case "memory": {
          data = getMemoryDashboardData();
          break;
        }
        case "darwin-weights": {
          data = buildDarwinPayload();
          break;
        }
        case "autoresearch": {
          data = buildAutoresearchPayload();
          break;
        }
        case "settings": {
          const raw = fs.readFileSync(path.join(__dirname, "user-config.json"), "utf8");
          const parsed = JSON.parse(raw);
          // Always strip secret fields (walletKey, *Key, *token, private*, …) so
          // the wallet key is never sent to any client.
          const safe = redactSecrets(parsed);
          if (isAuthorized(ws)) {
            // Authorized clients get the full (still secret-redacted) settings.
            data = safe;
          } else {
            // Unauthorized clients only see that settings are gated; no full dump.
            data = {
              gated: true,
              message: DASHBOARD_TOKEN
                ? "Full settings require a valid dashboard token."
                : "Full settings are unavailable because DASHBOARD_TOKEN is not configured on the server.",
            };
          }
          break;
        }
        case "briefing": {
          data = await generateBriefing();
          break;
        }
        case "performance": {
          data = getPerformanceSummary();
          break;
        }
        case "knowledge-graph": {
          data = await buildKnowledgeGraph();
          break;
        }
        default:
          wsSend(ws, { type: "quick-action:error", action, error: `Unknown action: ${action}` });
          return;
      }
      wsSend(ws, { type: "quick-action:result", action, data });
    } catch (err) {
      log("server_error", `Quick-action "${action}" failed: ${err.message}`);
      wsSend(ws, { type: "quick-action:error", action, error: err.message });
    }
  }

  // ═══════════════════════════════════════════
  //  START LISTENING
  // ═══════════════════════════════════════════

  return new Promise((resolve) => {
    server.listen(port, () => {
      log("server", `Web server listening on http://localhost:${port}`);
      resolve({ app, server, wss });
    });
  });
}
