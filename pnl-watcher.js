/**
 * pnl-watcher.js - Lightweight PnL watcher for the Meridian DLMM agent.
 *
 * Runs on a fast interval (default 30s), checks all open positions against
 * stop-loss / trailing TP / fixed TP thresholds, and auto-closes without any
 * LLM call.
 */

import { log } from "./logger.js";
import { config } from "./config.js";
import { updatePnlAndCheckExits, getTrackedPosition } from "./state.js";
import { getMyPositions, closePosition } from "./tools/dlmm.js";
import { emit } from "./notifier.js";
import { isBusy, isManagementBusy, isScreeningBusy } from "./session.js";
import fs from "fs";

const STATE_FILE = "./state.json";

let _intervalHandle = null;
// Per-tick inflight guard: prevents overlapping setInterval ticks from
// processing stale data / racing closes when a tick runs longer than the interval.
let _tickRunning = false;

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { positions: {}, lastUpdated: null };
  }
}

function saveState(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("pnl_watcher_error", `Failed to write state.json: ${err.message}`);
  }
}

export async function runPnlWatcher() {
  // Inflight guard: if a previous tick is still running, skip this one so
  // overlapping ticks can't process stale data or race position closes.
  if (_tickRunning) return;
  _tickRunning = true;
  try {
    // Skip while other agent flows are already active.
    if (isBusy() || isManagementBusy() || isScreeningBusy()) return;

    const cached = await getMyPositions();
    if (!cached?.positions?.length) return;

    const result = await getMyPositions({ force: true });
    const positions = result?.positions || [];
    if (positions.length === 0) return;

    for (const p of positions) {
      if (p.pnl_pct == null) continue;

      const tracked = getTrackedPosition(p.position);
      if (tracked?.deployed_at) {
        const ageMs = Date.now() - new Date(tracked.deployed_at).getTime();
        if (ageMs < 120_000) continue;
      }

      try {
        const exitAction = updatePnlAndCheckExits(p.position, p.pnl_pct, config);
        const fixedTpHit =
          !exitAction &&
          config.management.takeProfitFeePct &&
          p.pnl_pct >= config.management.takeProfitFeePct;

        const reason = exitAction || (fixedTpHit
          ? `FIXED_TP: PnL ${p.pnl_pct.toFixed(1)}% >= take profit (${config.management.takeProfitFeePct}%)`
          : null);

        if (!reason) continue;

        log("pnl_watcher", `EXIT TRIGGERED for ${p.pair || p.position.slice(0, 8)}: ${reason}`);

        const closeResult = await closePosition({
          position_address: p.position,
          _pnlOverride: {
            pnl_usd: p.pnl_usd,
            pnl_pct: p.pnl_pct,
            total_value_usd: p.total_value_usd,
            collected_fees_usd: p.collected_fees_usd,
            unclaimed_fees_usd: p.unclaimed_fees_usd,
          },
        });

        if (!closeResult?.success) {
          log("pnl_watcher_error", `Failed to close ${p.position.slice(0, 8)}: ${closeResult?.error || "unknown error"}`);
          continue;
        }

        log("pnl_watcher", `Closed ${p.pair || p.position.slice(0, 8)} | PnL: ${p.pnl_pct}% ($${p.pnl_usd})`);

        try {
          const state = loadState();
          state.recentAutoCloses = state.recentAutoCloses || [];
          state.recentAutoCloses.push({
            position: p.position,
            pair: p.pair,
            reason,
            pnl_pct: p.pnl_pct,
            ts: new Date().toISOString(),
          });
          state.recentAutoCloses = state.recentAutoCloses.slice(-20);
          saveState(state);
        } catch (stateErr) {
          log("pnl_watcher_error", `Failed to record auto-close in state: ${stateErr.message}`);
        }

        emit("pnl_watcher_close", {
          pair: p.pair,
          pnlPct: p.pnl_pct,
          pnlSol: p.pnl_sol,
          pnlUsd: p.pnl_usd,
          autoClose: true,
          reason,
        });
      } catch (posErr) {
        log("pnl_watcher_error", `Error processing position ${p.position.slice(0, 8)}: ${posErr.message}`);
      }
    }
  } catch (err) {
    log("pnl_watcher_error", `Tick failed: ${err.message}`);
  } finally {
    _tickRunning = false;
  }
}

export function startPnlWatcher(intervalSec = 30) {
  if (_intervalHandle) {
    log("pnl_watcher", "Already running - stopping previous instance");
    clearInterval(_intervalHandle);
  }

  const intervalMs = intervalSec * 1000;
  log("pnl_watcher", `Starting PnL watcher (every ${intervalSec}s)`);

  runPnlWatcher();
  _intervalHandle = setInterval(runPnlWatcher, intervalMs);
}

export function stopPnlWatcher() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
    log("pnl_watcher", "Stopped");
  }
}
