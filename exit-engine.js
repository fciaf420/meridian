/**
 * exit-engine.js — the one place a PnL exit (stop loss, emergency stop,
 * trailing take profit, fixed take profit) is decided and executed.
 *
 * Both the fast PnL watcher (pnl-watcher.js) and the management cycle
 * (index.js, rules 3 and 6) call evaluatePnlExit() per position, so they share
 * one state-persisted confirmation streak (state.js registerExitTick):
 *
 *   1. Suspicious tick (the API could not price the position: PnL missing or
 *      value ≤ 0 / not finite) → the API number is never acted on. Only an
 *      on-chain stop-loss reading can count; everything else is frozen.
 *   2. Signal from updatePnlAndCheckExits (stop loss / trailing, warm-up spike
 *      guard, both-source peak confirmation) or the fixed-TP / emergency check.
 *   3. On-chain confirmation (pnl-confirm.js). Unavailable → "unverified"
 *      (frozen, retried next tick); contradicted → streak reset.
 *   4. N consecutive confirming ticks (config.exits.confirmTicks, default 2)
 *      → close. A stop loss whose on-chain read keeps failing exits on the API
 *      value after config.exits.stopLossUnverifiedMaxWaitSec (bounded wait).
 *
 * closeForExit() runs the close under the wallet lock at close priority, so a
 * stop-loss close is never queued behind a deploy.
 */

import { log as realLog } from "./logger.js";
import { onchainPctForUnit } from "./tools/onchain-pnl.js";
import { confirmPnlExit } from "./pnl-confirm.js";
import { withWalletLock, WALLET_PRIORITY } from "./wallet-lock.js";
import { emit as realEmit } from "./notifier.js";

const finite = (v) => v != null && Number.isFinite(Number(v));

/**
 * L3: is the PnL exit path (stop loss / TP / trailing) degraded or off for this
 * position? Returns a short warning string, or null when fully active.
 */
export function pnlExitsWarning(p, tracked) {
  if (!tracked) return "PnL exits OFF (no state record)";
  if (tracked.closed) return null;
  if (!(Number(tracked.amount_sol) > 0)) return "PnL exits degraded (adopted: API-only stop, no on-chain/TP/trailing)";
  return null;
}

/**
 * A tick is suspicious only when it cannot be priced (yunus-0x/meridian@9f94792,
 * 196c1a2): PnL missing / not a number, or the position value is missing,
 * non-finite or ≤ 0 (a price outage collapses value to 0, which reads as
 * ≈ -100% and would otherwise fire a false stop loss). A large move on valid
 * inputs is NOT suspicious; the warm-up guard and on-chain check handle those.
 */
export function isUnpriceableTick(p) {
  if (!p) return { suspicious: true, why: "no position data" };
  if (p.pnl_unknown) return { suspicious: true, why: "PnL unknown (API did not return it)" };
  if (!finite(p.pnl_pct)) return { suspicious: true, why: "PnL not a number" };
  if ("total_value_usd" in p && !(finite(p.total_value_usd) && Number(p.total_value_usd) > 0)) {
    return { suspicious: true, why: `position value ${p.total_value_usd ?? "missing"} (could not be priced)` };
  }
  return { suspicious: false, why: null };
}

// Slack so a watcher tick landing a hair early (setInterval jitter) still reads.
const ONCHAIN_READ_SLACK_MS = 5_000;

/**
 * Would this API reading move the peak or trip an exit? Only then read on-chain
 * — plus (H1) a forced read at least every `intervalMs` per tracked position,
 * so a stale API reading that sits harmlessly above the stop cannot hide a
 * crash the chain already shows. opts: { now, intervalMs }.
 */
export function needsOnchain(apiPct, tracked, mgmt, { now = Date.now(), intervalMs = 60_000, source = null } = {}) {
  if (intervalMs > 0) {
    const stamp = (source && tracked?.last_onchain_by?.[source]) || (source ? null : tracked?.last_onchain_at);
    const last = stamp ? Date.parse(stamp) : NaN;
    if (!Number.isFinite(last) || now - last >= intervalMs - ONCHAIN_READ_SLACK_MS) return true;
  }
  const peak = tracked?.peak_pnl_pct || 0;
  if (apiPct > peak) return true;
  if (tracked?.exit_streak) return true; // a streak in progress always re-checks
  if (mgmt.takeProfitFeePct && apiPct >= mgmt.takeProfitFeePct) return true;
  if (mgmt.stopLossPct && apiPct <= mgmt.stopLossPct) return true;
  if (mgmt.emergencyPriceDropPct != null && apiPct <= mgmt.emergencyPriceDropPct) return true;
  const drop = Number(mgmt.trailingDropPct);
  if (mgmt.trailingTakeProfit && tracked?.trailing_active && Number.isFinite(drop) && drop > 0 && peak - apiPct >= drop) return true;
  return false;
}

/** Stop-kind signal from one PnL number (used on suspicious ticks with on-chain only). */
function stopSignal(pct, mgmt) {
  if (mgmt.stopLossPct && pct <= mgmt.stopLossPct) {
    return { reason: `STOP_LOSS: on-chain PnL ${pct.toFixed(1)}% hit stop loss (${mgmt.stopLossPct}%)`, threshold: mgmt.stopLossPct };
  }
  if (mgmt.emergencyPriceDropPct != null && pct <= mgmt.emergencyPriceDropPct) {
    return { reason: `EMERGENCY: on-chain PnL ${pct.toFixed(1)}% hit emergency stop (${mgmt.emergencyPriceDropPct}%)`, threshold: mgmt.emergencyPriceDropPct };
  }
  return null;
}

// ─── API vs on-chain bias measurement (M4) ───
// Rolling window of |API − on-chain| (points) from priced ticks that had an
// on-chain read. Logged as pnl_bias every 20 samples so the real bias can be
// read from the logs before tuning exits.pnlMismatchPts.
const BIAS_WINDOW = 200;
const biasSamples = [];
let biasSinceLog = 0;
export function recordPnlBias(apiPct, onchainPct, log = realLog) {
  const a = Number(apiPct), o = Number(onchainPct);
  if (!Number.isFinite(a) || !Number.isFinite(o)) return;
  biasSamples.push(Math.abs(a - o));
  if (biasSamples.length > BIAS_WINDOW) biasSamples.shift();
  if (++biasSinceLog >= 20) {
    biasSinceLog = 0;
    const s = getPnlBiasStats();
    log("pnl_bias", `API vs on-chain |diff| over last ${s.n} ticks: median ${s.median.toFixed(2)}pt, p90 ${s.p90.toFixed(2)}pt, max ${s.max.toFixed(2)}pt`);
  }
}
export function getPnlBiasStats() {
  const v = [...biasSamples].sort((x, y) => x - y);
  const q = (p) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : 0);
  return { n: v.length, median: q(0.5), p90: q(0.9), max: v.length ? v[v.length - 1] : 0 };
}
export function _resetBiasForTest() { biasSamples.length = 0; biasSinceLog = 0; trailingMismatchHolds.clear(); noStateWarned.clear(); }

// Consecutive ticks a trailing exit was held ONLY because the two sources
// disagree; alerts so trailing is never disabled silently (M4).
const trailingMismatchHolds = new Map();
const noStateWarned = new Set();

export function exitKind(reason) {
  const r = String(reason || "");
  if (/^STOP_LOSS/.test(r) || /^EMERGENCY/.test(r)) return "stop_loss";
  if (/^TRAILING_TP/.test(r)) return "trailing";
  if (/^FIXED_TP/.test(r)) return "take_profit";
  return null;
}

/**
 * Decide this tick for one position. Never closes anything itself.
 * deps: { config, getTracked, update (updatePnlAndCheckExits), register
 *   (registerExitTick), recordHold (recordPnlHold), readOnchain, log, now, source }
 * Returns { action: "close" | "hold" | "none", kind, reason, decision,
 *   onchain, onchainPct, fireOnApi, tick, suspicious }.
 */
export async function evaluatePnlExit(p, deps) {
  const { config, getTracked, update, register, recordHold, readOnchain, markOnchain, now = Date.now(), source = "watcher" } = deps;
  const emit = deps.emit || realEmit;
  const log = deps.log || realLog;
  const mgmt = config.management;
  const label = p.pair || String(p.position).slice(0, 8);
  const tracked = getTracked(p.position);
  const none = { action: "none", kind: null, reason: null, decision: null, onchain: null, onchainPct: null, fireOnApi: false, tick: null, suspicious: false };
  if (!tracked || tracked.closed) {
    // L3: no state record → no streak to confirm against → no PnL exits at all.
    if (!tracked && !noStateWarned.has(p.position)) {
      noStateWarned.add(p.position);
      log("exit_confirm", `${label}: no state record — PnL exits (stop loss / TP / trailing) are NOT active for this position [${source}]`);
    }
    return none;
  }

  let onchain;
  const onchainOnce = async () => {
    if (onchain === undefined) {
      try { onchain = await readOnchain(p); } catch { onchain = null; }
      if (onchain != null && finite(onchainPctForUnit(onchain, unit))) { try { markOnchain?.(p.position, now, source); } catch { /* best-effort */ } }
    }
    return onchain;
  };
  const unit = mgmt.pnlUnit;
  const sus = isUnpriceableTick(p);

  // ─── Suspicious tick: never act on the API number ───
  if (sus.suspicious) {
    await onchainOnce();
    const ocPct = onchainPctForUnit(onchain, unit);
    const streakKind = tracked.exit_streak?.kind ?? null;
    if (!finite(ocPct)) {
      if (streakKind) register(p.position, { kind: streakKind, outcome: "unverified", suspicious: true, reason: sus.why, config, now });
      log("exit_confirm", `${label}: suspicious tick (${sus.why}) and no on-chain reading — no exit action [${source}]`);
      return { ...none, action: streakKind ? "hold" : "none", suspicious: true };
    }
    const sig = stopSignal(Number(ocPct), mgmt);
    if (!sig) {
      // On-chain shows no stop. A stop streak is contradicted; TP / trailing
      // streaks are frozen (those need a priced API reading too).
      if (streakKind === "stop_loss") register(p.position, { kind: streakKind, outcome: "refute", reason: "on-chain above stop on a suspicious tick", config, now });
      else if (streakKind) register(p.position, { kind: streakKind, outcome: "unverified", suspicious: true, reason: sus.why, config, now });
      return { ...none, action: streakKind ? "hold" : "none", onchain, onchainPct: ocPct, suspicious: true };
    }
    const tick = register(p.position, { kind: "stop_loss", outcome: "confirm", reason: sig.reason, config, now });
    return {
      action: tick.fire ? "close" : "hold",
      kind: "stop_loss",
      reason: sig.reason,
      decision: { close: tick.fire, pnlPct: Number(ocPct), source: "onchain", why: `on-chain confirms (API unpriceable: ${sus.why})` },
      onchain,
      onchainPct: Number(ocPct),
      fireOnApi: false,
      tick,
      suspicious: true,
      threshold: sig.threshold,
    };
  }

  // ─── Priced tick ───
  const apiPct = Number(p.pnl_pct);
  const readEverySec = Number(config.exits?.onchainReadIntervalSec ?? 60);
  if (needsOnchain(apiPct, tracked, mgmt, { now, intervalMs: Number.isFinite(readEverySec) ? readEverySec * 1000 : 60_000, source })) await onchainOnce();
  const ocPct = onchainPctForUnit(onchain, unit);
  if (finite(ocPct)) recordPnlBias(apiPct, ocPct, log);
  const exitAction = update(p.position, apiPct, config, { onchainPct: ocPct, strict: true, now });
  const after = getTracked(p.position);
  const warmupHeld = !exitAction && !!after?._pnl_pending_extreme;
  if (warmupHeld) {
    // A held warm-up spike neither counts nor resets a streak.
    if (after?.exit_streak) register(p.position, { kind: after.exit_streak.kind, outcome: "unverified", suspicious: true, reason: "warm-up spike guard", config, now });
    return { ...none, action: after?.exit_streak ? "hold" : "none", onchain, onchainPct: ocPct };
  }

  let reason = exitAction;
  if (!reason && mgmt.emergencyPriceDropPct != null && apiPct <= mgmt.emergencyPriceDropPct) {
    reason = `EMERGENCY: PnL ${apiPct.toFixed(1)}% hit emergency stop (${mgmt.emergencyPriceDropPct}%)`;
  }
  if (!reason && mgmt.takeProfitFeePct && apiPct >= mgmt.takeProfitFeePct) {
    reason = `FIXED_TP: PnL ${apiPct.toFixed(1)}% >= take profit (${mgmt.takeProfitFeePct}%)`;
  }
  if (!reason) {
    register(p.position, { kind: null, outcome: "clear", reason: "no exit signal", config, now });
    return { ...none, onchain, onchainPct: ocPct };
  }

  const kind = exitKind(reason);
  const threshold = kind === "stop_loss"
    ? (/^EMERGENCY/.test(reason) ? mgmt.emergencyPriceDropPct : mgmt.stopLossPct)
    : mgmt.takeProfitFeePct;
  const decision = await confirmPnlExit({
    position: p,
    kind,
    apiPct,
    threshold,
    peakPct: after?.peak_pnl_pct,
    dropPct: mgmt.trailingDropPct,
    label,
    unit,
    getOnchain: onchainOnce,
    mismatchPts: config.exits?.pnlMismatchPts,
  });

  // M4: a trailing exit held only because API and on-chain disagree is trailing
  // effectively disabled for this position. Count it and alert, never silent.
  if (kind === "trailing" && decision.crosses && decision.apiAgrees && decision.mismatch && !decision.close) {
    const n = (trailingMismatchHolds.get(p.position) || 0) + 1;
    trailingMismatchHolds.set(p.position, n);
    const alertAt = Math.max(1, Math.floor(Number(config.exits?.trailingMismatchAlertTicks ?? 3)));
    if (n === alertAt || (n > alertAt && (n - alertAt) % 10 === 0)) {
      const msg = `${label}: trailing take profit is being HELD for ${n} consecutive ticks because API (${Number(apiPct).toFixed(1)}%) and on-chain (${Number(decision.onchainPct ?? decision.pnlPct).toFixed(1)}%) PnL disagree by more than ${config.exits?.pnlMismatchPts ?? 2}pt. Trailing is effectively off for this position; stop loss still active.`;
      log("exit_confirm", msg);
      try { emit("ops_alert", { key: `trail:${p.position}`, title: "Trailing TP disabled by PnL source mismatch", text: msg }); } catch { /* alerts are best-effort */ }
    }
  } else {
    trailingMismatchHolds.delete(p.position);
  }
  const outcome = decision.close ? "confirm" : decision.unverified ? "unverified" : "refute";
  if (!decision.close) recordHold(p.position, reason, decision.why, { onchainPct: decision.onchainPct, config });
  const emergencyTick = finite(apiPct) && mgmt.emergencyPriceDropPct != null && apiPct <= mgmt.emergencyPriceDropPct;
  const tick = register(p.position, { kind, outcome, reason, config, now, emergency: emergencyTick });
  const close = tick.fire || tick.fireOnApi;
  if (!close) {
    const need = Number(config.exits?.confirmTicks ?? 2);
    log("exit_confirm", `${label}: ${reason} — ${outcome} (${tick.count}/${need} confirming ticks${outcome === "unverified" ? `, waited ${Math.round(tick.waitedMs / 1000)}s` : ""}) [${source}]`);
  }
  return {
    action: close ? "close" : "hold",
    kind,
    reason: tick.fireOnApi
      ? `${reason} [on-chain PnL unavailable for ${Math.round(tick.waitedMs / 1000)}s — exited on the API value]`
      : reason,
    decision,
    onchain: decision.onchain ?? onchain ?? null,
    onchainPct: decision.onchainPct ?? null,
    fireOnApi: tick.fireOnApi,
    tick,
    suspicious: false,
    threshold,
  };
}

/** SOL-PnL-based override for the close record (pnl_usd at the entry SOL price). */
export function onchainOverride(p, tracked, onchain, pct) {
  const initialUsd = Number(tracked?.initial_value_usd) || 0;
  const pnlUsd = initialUsd > 0
    ? Math.round(initialUsd * pct) / 100
    : (Number(p.sol_price) > 0 && onchain?.pnlSol != null ? Math.round(onchain.pnlSol * Number(p.sol_price) * 100) / 100 : p.pnl_usd);
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

/**
 * Execute a close the engine decided, under the wallet lock at close priority.
 * Skips (without error) a position that is already closed or whose close is in
 * flight (the watcher and the management cycle may both decide the same exit).
 * deps: { closePosition, getTracked, isCloseInflight, recordAutoClose, emit,
 *   getPositionBins, withTimeout, postClose, log, source }
 * postClose(args, result, durationMs) (M3) runs under the lock after a
 * successful close for parity with the executeTool path: actions log, USDC
 * settle, signal capture. Its failure never fails the close.
 * Returns { closed, skipped?, result, override }.
 */
export async function closeForExit(p, res, deps) {
  const log = deps.log || realLog;
  const label = p.pair || String(p.position).slice(0, 8);
  const source = deps.source || "watcher";
  return withWalletLock(async () => {
    const t = deps.getTracked(p.position);
    if (t?.closed) {
      log("exit_close", `${label}: already closed — skipping ${res.reason} [${source}]`);
      return { closed: false, skipped: "already_closed" };
    }
    if (deps.isCloseInflight?.(p.position)) {
      log("exit_close", `${label}: a close is already in flight — skipping ${res.reason} [${source}]`);
      return { closed: false, skipped: "close_in_flight" };
    }
    const override = res.onchainPct != null && res.onchain
      ? onchainOverride(p, t, res.onchain, res.onchainPct)
      : {
        pnl_usd: p.pnl_usd,
        pnl_pct: p.pnl_pct,
        total_value_usd: p.total_value_usd,
        collected_fees_usd: p.collected_fees_usd,
        unclaimed_fees_usd: p.unclaimed_fees_usd,
      };
    const closeReason = `${res.reason}${p.oor_direction ? ` (OOR ${p.oor_direction})` : ""}`;
    log("exit_close", `EXIT TRIGGERED for ${label}: ${closeReason} (on-chain ${res.onchainPct != null ? `${res.onchainPct}%` : "unavailable"}) [${source}]`);
    const preCloseBins = deps.getPositionBins ? Promise.resolve(deps.getPositionBins(p)).catch(() => null) : Promise.resolve(null);
    const closeArgs = { position_address: p.position, _pnlOverride: override, _close_reason: closeReason };
    const startedAt = Date.now();
    const result = await deps.closePosition(closeArgs);
    if (!result?.success) {
      log("pnl_watcher_error", `Failed to close ${String(p.position).slice(0, 8)}: ${result?.error || "unknown error"}`);
      return { closed: false, result, override };
    }
    log("pnl_watcher", `Closed ${label} | PnL: ${override.pnl_pct}% ($${override.pnl_usd})${res.onchainPct != null ? ` on-chain (API said ${p.pnl_pct}%)` : ""} [${source}]`);
    if (deps.postClose) {
      try { await deps.postClose(closeArgs, result, Date.now() - startedAt); }
      catch (postErr) { log("pnl_watcher_error", `Post-close bookkeeping failed for ${label}: ${postErr.message}`); }
    }
    try {
      deps.recordAutoClose?.({
        position: p.position,
        pair: p.pair,
        reason: res.reason,
        source,
        pnl_pct: override.pnl_pct,
        ...(res.onchainPct != null && { api_pnl_pct: p.pnl_pct }),
        ts: new Date().toISOString(),
      });
    } catch (stateErr) {
      log("pnl_watcher_error", `Failed to record auto-close in state: ${stateErr.message}`);
    }
    const bins = deps.withTimeout ? await deps.withTimeout(preCloseBins, 1_500) : null;
    deps.emit?.("pnl_watcher_close", {
      pair: p.pair,
      position: p.position,
      pool: p.pool,
      txs: result.txs ?? null,
      pnlPct: override.pnl_pct,
      pnlSol: res.onchainPct != null && res.onchain ? res.onchain.pnlSol : p.pnl_sol,
      pnlUsd: override.pnl_usd,
      autoClose: true,
      reason: res.reason,
      bins,
    });
    return { closed: true, result, override };
  }, WALLET_PRIORITY.close_position, `close ${label} (${source})`);
}
