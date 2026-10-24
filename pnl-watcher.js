/**
 * pnl-watcher.js - Lightweight PnL watcher for the Meridian DLMM agent.
 *
 * Runs on a fast interval (default 30s), checks all open positions against
 * stop-loss / trailing TP / fixed TP thresholds, and auto-closes without any
 * LLM call.
 *
 * Decisions come from exit-engine.js (shared with the management cycle):
 * on-chain confirmation (pnl-confirm.js), N consecutive confirming ticks
 * (config.exits.confirmTicks), suspicious-tick handling, and a bounded
 * API-value fallback for a stop loss whose on-chain read keeps failing.
 */

import { log } from "./logger.js";
import { config } from "./config.js";
import { updatePnlAndCheckExits, getTrackedPosition, recordPnlHold, recordAutoClose, registerExitTick } from "./state.js";
import { getMyPositions, closePosition, isCloseInflight } from "./tools/dlmm.js";
import { getOnchainPnl } from "./tools/onchain-pnl.js";
import { evaluatePnlExit, closeForExit } from "./exit-engine.js";
import { emit } from "./notifier.js";
import { getPositionBins, withTimeout } from "./tools/bin-visual.js";
import { isDraining } from "./session.js";

let _intervalHandle = null;
// Per-tick inflight guard: prevents overlapping setInterval ticks from
// processing stale data / racing closes when a tick runs longer than the interval.
let _tickRunning = false;

// Test seam only: production never sets it.
let _deps = null;
export function _setPnlWatcherDepsForTest(d) { _deps = d; }
const dep = (name, real) => _deps?.[name] ?? real;

/** True while a watcher tick is running (the shutdown drain waits for it). */
export function isPnlTickRunning() {
  return _tickRunning;
}

// ─── Dead-man switch ───────────────────────────────────────────
// HEALTHCHECK_URL (e.g. https://hc-ping.com/<uuid>) is GET-pinged every
// HEALTHCHECK_EVERY_TICKS watcher ticks (default 10, i.e. every 5 min at 30s).
// If the process dies or the event loop wedges, the pings stop and the
// external service alerts, which in-process Telegram alerts can't do.
// Fire-and-forget with a 5s timeout: it can never slow down or fail a tick.
let _ticksSincePing = 0;
export function maybePingHealthcheck() {
  const url = process.env.HEALTHCHECK_URL;
  if (!url) return false;
  const every = Math.max(1, Math.floor(Number(process.env.HEALTHCHECK_EVERY_TICKS) || 10));
  // Ping on the first tick after start, then every `every` ticks.
  if (_ticksSincePing++ % every !== 0) return false;
  const f = dep("fetch", globalThis.fetch);
  try {
    Promise.resolve(f(url, { method: "GET", signal: AbortSignal.timeout(5_000) }))
      .catch((e) => log("pnl_watcher_warn", `Healthcheck ping failed: ${e.message}`));
  } catch (e) {
    log("pnl_watcher_warn", `Healthcheck ping failed: ${e.message}`);
  }
  return true;
}
export function _resetHealthcheckForTest() { _ticksSincePing = 0; }

export async function runPnlWatcher() {
  // Inflight guard: if a previous tick is still running, skip this one so
  // overlapping ticks can't process stale data or race position closes.
  if (_tickRunning) return;
  // Shutdown drain in progress: start no new work (no new closes).
  if (dep("isDraining", isDraining)()) return;
  _tickRunning = true;
  maybePingHealthcheck();
  try {
    // The watcher no longer skips while a management / screening cycle or an
    // owner action is running: exits used to wait out a whole screening cycle
    // (LLM + deploy). Closes now serialize through the wallet lock at close
    // priority, and closeForExit skips a position already closed / closing.
    const getPositions = dep("getMyPositions", getMyPositions);
    const cached = await getPositions();
    if (!cached?.positions?.length) return;

    const result = await getPositions({ force: true });
    const positions = result?.positions || [];
    if (positions.length === 0) return;

    const now = dep("now", () => Date.now())();
    for (const p of positions) {
      const tracked = getTrackedPosition(p.position);
      if (tracked?.deployed_at) {
        const ageMs = now - new Date(tracked.deployed_at).getTime();
        if (ageMs < 120_000) continue;
      }

      try {
        const res = await evaluatePnlExit(p, {
          config,
          getTracked: getTrackedPosition,
          update: updatePnlAndCheckExits,
          register: registerExitTick,
          recordHold: recordPnlHold,
          readOnchain: dep("getOnchainPnl", getOnchainPnl),
          now,
          source: "watcher",
        });
        if (res.action !== "close") continue;
        await closeForExit(p, res, {
          closePosition: dep("closePosition", closePosition),
          getTracked: getTrackedPosition,
          isCloseInflight: dep("isCloseInflight", isCloseInflight),
          recordAutoClose,
          emit: dep("emit", emit),
          getPositionBins: dep("getPositionBins", getPositionBins),
          withTimeout,
          source: "watcher",
        });
      } catch (posErr) {
        log("pnl_watcher_error", `Error processing position ${String(p.position).slice(0, 8)}: ${posErr.message}`);
      }
    }
  } catch (err) {
    log("pnl_watcher_error", `Tick failed: ${err.message}`);
  } finally {
    _tickRunning = false;
  }
}

export function startPnlWatcher(intervalSec = 30) {
  if (isDraining()) {
    log("pnl_watcher", "Not starting: shutdown drain in progress");
    return;
  }
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
