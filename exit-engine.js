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

const finite = (v) => v != null && Number.isFinite(Number(v));

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

/** Would this API reading move the peak or trip an exit? Only then read on-chain. */
export function needsOnchain(apiPct, tracked, mgmt) {
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
  const { config, getTracked, update, register, recordHold, readOnchain, now = Date.now(), source = "watcher" } = deps;
  const log = deps.log || realLog;
  const mgmt = config.management;
  const label = p.pair || String(p.position).slice(0, 8);
  const tracked = getTracked(p.position);
  const none = { action: "none", kind: null, reason: null, decision: null, onchain: null, onchainPct: null, fireOnApi: false, tick: null, suspicious: false };
  if (!tracked || tracked.closed) return none; // untracked: no streak state to confirm against

  let onchain;
  const onchainOnce = async () => {
    if (onchain === undefined) {
      try { onchain = await readOnchain(p); } catch { onchain = null; }
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
  if (needsOnchain(apiPct, tracked, mgmt)) await onchainOnce();
  const ocPct = onchainPctForUnit(onchain, unit);
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
  });
  const outcome = decision.close ? "confirm" : decision.unverified ? "unverified" : "refute";
  if (!decision.close) recordHold(p.position, reason, decision.why, { onchainPct: decision.onchainPct, config });
  const tick = register(p.position, { kind, outcome, reason, config, now });
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
 *   getPositionBins, withTimeout, log, source }
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
    const result = await deps.closePosition({ position_address: p.position, _pnlOverride: override, _close_reason: closeReason });
    if (!result?.success) {
      log("pnl_watcher_error", `Failed to close ${String(p.position).slice(0, 8)}: ${result?.error || "unknown error"}`);
      return { closed: false, result, override };
    }
    log("pnl_watcher", `Closed ${label} | PnL: ${override.pnl_pct}% ($${override.pnl_usd})${res.onchainPct != null ? ` on-chain (API said ${p.pnl_pct}%)` : ""} [${source}]`);
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
