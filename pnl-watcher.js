/**
 * pnl-watcher.js - Lightweight PnL watcher for the Meridian DLMM agent.
 *
 * Runs on a fast interval (default 30s), checks all open positions against
 * stop-loss / trailing TP / fixed TP thresholds, and auto-closes without any
 * LLM call.
 *
 * Every PnL exit is confirmed against on-chain PnL first (pnl-confirm.js):
 * the PnL APIs misreport fresh positions (e/acc-SOL closed on a +7.4%
 * FIXED_TP while flat on-chain). Take profit / trailing hold when on-chain
 * doesn't confirm or can't be read; stop loss still exits when it can't be read.
 */

import { log } from "./logger.js";
import { config } from "./config.js";
import { updatePnlAndCheckExits, getTrackedPosition, recordPnlHold, recordAutoClose } from "./state.js";
import { getMyPositions, closePosition } from "./tools/dlmm.js";
import { getOnchainPnl, onchainPctForUnit } from "./tools/onchain-pnl.js";
import { confirmPnlExit, exitKindFromReason } from "./pnl-confirm.js";
import { emit } from "./notifier.js";
import { getPositionBins, withTimeout } from "./tools/bin-visual.js";
import { isBusy, isManagementBusy, isScreeningBusy, isDraining } from "./session.js";

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

/**
 * Would this API reading move the trailing peak or trip an exit? Only then is
 * the on-chain read (≈3 RPC calls, cached 20s) worth doing this tick.
 */
function needsOnchain(apiPct, tracked, mgmt) {
  const peak = tracked?.peak_pnl_pct || 0;
  if (apiPct > peak) return true;
  if (mgmt.takeProfitFeePct && apiPct >= mgmt.takeProfitFeePct) return true;
  if (mgmt.stopLossPct && apiPct <= mgmt.stopLossPct) return true;
  const drop = Number(mgmt.trailingDropPct);
  if (mgmt.trailingTakeProfit && tracked?.trailing_active && Number.isFinite(drop) && drop > 0 && peak - apiPct >= drop) return true;
  return false;
}

/** SOL-PnL-based override for the close record (pnl_usd at the entry SOL price). */
function onchainOverride(p, tracked, onchain, pct) {
  const initialUsd = Number(tracked?.initial_value_usd) || 0;
  const pnlUsd = initialUsd > 0
    ? Math.round(initialUsd * pct) / 100
    : (Number(p.sol_price) > 0 ? Math.round(onchain.pnlSol * Number(p.sol_price) * 100) / 100 : p.pnl_usd);
  return {
    pnl_usd: pnlUsd,
    pnl_pct: pct,
    total_value_usd: initialUsd > 0 ? Math.round((initialUsd + pnlUsd) * 100) / 100 : p.total_value_usd,
    collected_fees_usd: p.collected_fees_usd,
    unclaimed_fees_usd: p.unclaimed_fees_usd,
    pnl_source: "onchain",
    pnl_sol: onchain?.pnlSol ?? null,
  };
}

export async function runPnlWatcher() {
  // Inflight guard: if a previous tick is still running, skip this one so
  // overlapping ticks can't process stale data or race position closes.
  if (_tickRunning) return;
  // Shutdown drain in progress: start no new work (no new closes).
  if (dep("isDraining", isDraining)()) return;
  _tickRunning = true;
  maybePingHealthcheck();
  try {
    // Skip while other agent flows are already active.
    if (dep("isBusy", isBusy)() || dep("isManagementBusy", isManagementBusy)() || dep("isScreeningBusy", isScreeningBusy)()) return;

    const getPositions = dep("getMyPositions", getMyPositions);
    const cached = await getPositions();
    if (!cached?.positions?.length) return;

    const result = await getPositions({ force: true });
    const positions = result?.positions || [];
    if (positions.length === 0) return;

    const mgmt = config.management;
    for (const p of positions) {
      if (p.pnl_pct == null) continue;

      const tracked = getTrackedPosition(p.position);
      if (tracked?.deployed_at) {
        const ageMs = Date.now() - new Date(tracked.deployed_at).getTime();
        if (ageMs < 120_000) continue;
      }

      try {
        const label = p.pair || p.position.slice(0, 8);
        const readOnchain = dep("getOnchainPnl", getOnchainPnl);
        // One on-chain read per position per tick at most (and cached 20s).
        let onchain;
        const onchainOnce = async () => {
          if (onchain === undefined) onchain = await readOnchain(p).catch(() => null);
          return onchain;
        };
        if (needsOnchain(p.pnl_pct, tracked, mgmt)) await onchainOnce();

        const exitAction = updatePnlAndCheckExits(p.position, p.pnl_pct, config, { onchainPct: onchainPctForUnit(onchain, mgmt.pnlUnit) });
        // updatePnlAndCheckExits leaves a pending marker when it held this reading
        // as a warm-up spike. Fixed TP must respect that too (it didn't: a +33%
        // spike at age 2m closed through FIXED_TP while the guard was "waiting").
        const warmupHeld = !exitAction && !!getTrackedPosition(p.position)?._pnl_pending_extreme;
        const fixedTpHit =
          !exitAction &&
          !warmupHeld &&
          mgmt.takeProfitFeePct &&
          p.pnl_pct >= mgmt.takeProfitFeePct;

        const reason = exitAction || (fixedTpHit
          ? `FIXED_TP: PnL ${p.pnl_pct.toFixed(1)}% >= take profit (${mgmt.takeProfitFeePct}%)`
          : null);

        if (!reason) continue;

        // ─── Confirm on-chain before closing ───
        const kind = exitKindFromReason(reason);
        const trackedNow = getTrackedPosition(p.position);
        const decision = await confirmPnlExit({
          position: p,
          kind,
          apiPct: p.pnl_pct,
          threshold: kind === "stop_loss" ? mgmt.stopLossPct : mgmt.takeProfitFeePct,
          peakPct: trackedNow?.peak_pnl_pct,
          dropPct: mgmt.trailingDropPct,
          label,
          unit: mgmt.pnlUnit,
          getOnchain: onchainOnce,
        });
        if (!decision.close) {
          log("pnl_watcher", `EXIT HELD for ${label}: ${reason} — ${decision.why}`);
          recordPnlHold(p.position, reason, decision.why, { onchainPct: decision.onchainPct, config });
          continue;
        }

        log("pnl_watcher", `EXIT TRIGGERED for ${label}: ${reason} (on-chain ${decision.onchainPct != null ? `${decision.onchainPct}%` : "unavailable"})`);

        const override = decision.onchainPct != null
          ? onchainOverride(p, trackedNow, decision.onchain, decision.onchainPct)
          : {
            pnl_usd: p.pnl_usd,
            pnl_pct: p.pnl_pct,
            total_value_usd: p.total_value_usd,
            collected_fees_usd: p.collected_fees_usd,
            unclaimed_fees_usd: p.unclaimed_fees_usd,
          };

        // Read-only bin snapshot for the alert, started alongside the close; never fails it.
        const preCloseBins = dep("getPositionBins", getPositionBins)(p).catch(() => null);
        const closeResult = await dep("closePosition", closePosition)({
          position_address: p.position,
          _pnlOverride: override,
          _close_reason: `${reason}${p.oor_direction ? ` (OOR ${p.oor_direction})` : ""}`,
        });

        if (!closeResult?.success) {
          log("pnl_watcher_error", `Failed to close ${p.position.slice(0, 8)}: ${closeResult?.error || "unknown error"}`);
          continue;
        }

        log("pnl_watcher", `Closed ${label} | PnL: ${override.pnl_pct}% ($${override.pnl_usd})${decision.onchain ? ` on-chain (API said ${p.pnl_pct}%)` : ""}`);

        try {
          recordAutoClose({
            position: p.position,
            pair: p.pair,
            reason,
            pnl_pct: override.pnl_pct,
            ...(decision.onchain && { api_pnl_pct: p.pnl_pct }),
            ts: new Date().toISOString(),
          });
        } catch (stateErr) {
          log("pnl_watcher_error", `Failed to record auto-close in state: ${stateErr.message}`);
        }

        dep("emit", emit)("pnl_watcher_close", {
          pair: p.pair,
          position: p.position,
          pool: p.pool,
          txs: closeResult.txs ?? null,
          pnlPct: override.pnl_pct,
          pnlSol: decision.onchain ? decision.onchain.pnlSol : p.pnl_sol,
          pnlUsd: override.pnl_usd,
          autoClose: true,
          reason,
          bins: await withTimeout(preCloseBins, 1_500),
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
