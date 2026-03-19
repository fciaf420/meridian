/**
 * pnl-watcher.js — Lightweight PnL watcher for the Meridian DLMM agent.
 *
 * Runs on a fast interval (default 30s), checks all open positions against
 * stop-loss / trailing TP / fixed TP thresholds, and auto-closes + swaps
 * without any LLM call.
 */

import { log } from "./logger.js";
import { config } from "./config.js";
import { updatePnlAndCheckExits } from "./state.js";
import { getMyPositions, closePosition } from "./tools/dlmm.js";
import { getWalletBalances, swapToken } from "./tools/wallet.js";
import { emit } from "./notifier.js";
import { isManagementBusy } from "./session.js";
import fs from "fs";

const STATE_FILE = "./state.json";
const SOL_MINT = "So11111111111111111111111111111111111111112";

let _intervalHandle = null;

// ─── State helpers (mirror the load/save pattern from state.js) ──────────

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

// ─── Core watcher tick ───────────────────────────────────────────────────

export async function runPnlWatcher() {
  try {
    // Guard: skip if management cycle is currently running
    if (isManagementBusy()) return;

    // Fetch positions (use cache if fresh, avoids spamming RPC every 30s)
    const result = await getMyPositions();
    const positions = result?.positions || [];

    if (positions.length === 0) return;

    for (const p of positions) {
      // Skip positions without PnL data
      if (p.pnl_pct == null) continue;

      try {
        // Check trailing TP / stop loss via state.js
        const exitAction = updatePnlAndCheckExits(p.position, p.pnl_pct, config);

        // Check fixed take profit
        const fixedTpHit =
          !exitAction &&
          config.management.takeProfitFeePct &&
          p.pnl_pct >= config.management.takeProfitFeePct;

        const reason = exitAction || (fixedTpHit
          ? `FIXED_TP: PnL ${p.pnl_pct.toFixed(1)}% >= take profit (${config.management.takeProfitFeePct}%)`
          : null);

        if (!reason) continue;

        // ─── Exit triggered — close position ──────────────────────
        log("pnl_watcher", `EXIT TRIGGERED for ${p.pair || p.position.slice(0, 8)}: ${reason}`);

        const closeResult = await closePosition({ position_address: p.position });

        if (!closeResult?.success) {
          log("pnl_watcher_error", `Failed to close ${p.position.slice(0, 8)}: ${closeResult?.error || "unknown error"}`);
          continue;
        }

        log("pnl_watcher", `Closed ${p.pair || p.position.slice(0, 8)} | PnL: ${p.pnl_pct}% ($${p.pnl_usd})`);

        // ─── Swap base token back to SOL ──────────────────────────
        try {
          const walletBalances = await getWalletBalances();
          const baseMint = p.base_mint;

          // Skip if no base mint, or base mint is SOL itself
          if (baseMint && baseMint !== SOL_MINT) {
            const baseToken = walletBalances.tokens?.find((t) => t.mint === baseMint);

            if (baseToken && baseToken.balance > 0 && (baseToken.usd ?? 0) >= 0.10) {
              log("pnl_watcher", `Swapping ${baseToken.balance} ${baseToken.symbol || baseMint.slice(0, 8)} -> SOL (worth $${baseToken.usd})`);

              const swapResult = await swapToken({
                input_mint: baseMint,
                output_mint: SOL_MINT,
                amount: baseToken.balance,
              });

              if (swapResult?.success) {
                log("pnl_watcher", `Swap OK: tx ${swapResult.tx}`);
              } else {
                log("pnl_watcher_warn", `Swap failed for ${baseMint.slice(0, 8)}: ${swapResult?.error || "unknown"}`);
              }
            }
          }
        } catch (swapErr) {
          log("pnl_watcher_warn", `Post-close swap error: ${swapErr.message}`);
        }

        // ─── Record auto-close in state.json ──────────────────────
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
          // Keep only last 20 entries
          state.recentAutoCloses = state.recentAutoCloses.slice(-20);
          saveState(state);
        } catch (stateErr) {
          log("pnl_watcher_error", `Failed to record auto-close in state: ${stateErr.message}`);
        }

        // ─── Emit custom event (closePosition already emits "close") ─
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
  }
}

// ─── Interval management ─────────────────────────────────────────────────

/**
 * Start the PnL watcher on a repeating interval.
 * @param {number} intervalSec — polling interval in seconds (default 30)
 */
export function startPnlWatcher(intervalSec = 30) {
  if (_intervalHandle) {
    log("pnl_watcher", "Already running — stopping previous instance");
    clearInterval(_intervalHandle);
  }

  const intervalMs = intervalSec * 1000;
  log("pnl_watcher", `Starting PnL watcher (every ${intervalSec}s)`);

  // Run once immediately, then on interval
  runPnlWatcher();
  _intervalHandle = setInterval(runPnlWatcher, intervalMs);
}

/**
 * Stop the PnL watcher.
 */
export function stopPnlWatcher() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
    log("pnl_watcher", "Stopped");
  }
}
