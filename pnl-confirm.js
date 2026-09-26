/**
 * pnl-confirm.js — confirm a PnL-triggered exit against on-chain PnL.
 *
 * The PnL APIs (LP Agent / Meteora) can misreport a fresh position for minutes:
 * e/acc-SOL (2026-09-26 00:07) read +7.4% and closed on FIXED_TP while it was
 * flat on-chain. Every PnL-based close (watcher TP / trailing TP / stop loss,
 * management rules 3 and 6) now checks getOnchainPnl() first.
 *
 * Rules (points = PnL percentage points):
 *  - take profit: on-chain ≥ threshold − 1
 *  - stop loss / emergency: on-chain ≤ threshold + 1
 *  - trailing: on-chain ≤ (peak − drop) + 1, i.e. on-chain confirms the drop
 *  - API and on-chain more than 2 points apart: hold take profit / trailing and
 *    log pnl_mismatch. A stop loss still exits when on-chain itself crosses it
 *    (on-chain is the truth and it shows the loss).
 *  - on-chain read failed: stop loss exits on the API value (today's
 *    behaviour, safety first); take profit and trailing hold until next tick.
 */

import { log } from "./logger.js";
import { onchainPctForUnit } from "./tools/onchain-pnl.js";

export const PNL_CONFIRM_TOLERANCE_PTS = 1;
export const PNL_MISMATCH_PTS = 2;

/** Exit kind from an exit reason string (updatePnlAndCheckExits / watcher). */
export function exitKindFromReason(reason) {
  const r = String(reason || "");
  if (/^STOP_LOSS/.test(r) || /^EMERGENCY/.test(r)) return "stop_loss";
  if (/^TRAILING_TP/.test(r)) return "trailing";
  if (/^FIXED_TP/.test(r) || /^TAKE_PROFIT/.test(r)) return "take_profit";
  return null;
}

const fmt = (n) => (Number.isFinite(Number(n)) ? `${Number(n).toFixed(2)}%` : "?");

/**
 * Pure decision. kind: "take_profit" | "stop_loss" | "trailing".
 * threshold: TP / SL % (take_profit, stop_loss); for trailing pass peakPct and dropPct.
 * onchainPct: null/undefined when the on-chain read failed.
 * Returns { close, pnlPct (value to record), source, mismatch, why }.
 */
export function decidePnlExit({ kind, apiPct, onchainPct, threshold, peakPct, dropPct }) {
  const tol = PNL_CONFIRM_TOLERANCE_PTS;
  const api = Number(apiPct);
  const hasOnchain = onchainPct != null && Number.isFinite(Number(onchainPct));
  if (!hasOnchain) {
    const close = kind === "stop_loss";
    return {
      close,
      pnlPct: Number.isFinite(api) ? api : null,
      source: "api",
      mismatch: false,
      why: close
        ? "on-chain PnL unavailable — stop loss exits on the API value (safety first)"
        : "on-chain PnL unavailable — holding, retry next tick",
    };
  }
  const oc = Number(onchainPct);
  const mismatch = Number.isFinite(api) && Math.abs(oc - api) > PNL_MISMATCH_PTS;
  let crosses;
  let rule;
  if (kind === "take_profit") {
    crosses = oc >= Number(threshold) - tol;
    rule = `on-chain ${fmt(oc)} vs take profit ${threshold}% (−${tol}pt)`;
  } else if (kind === "stop_loss") {
    crosses = oc <= Number(threshold) + tol;
    rule = `on-chain ${fmt(oc)} vs stop ${threshold}% (+${tol}pt)`;
  } else if (kind === "trailing") {
    const level = Number(peakPct) - Number(dropPct);
    crosses = Number.isFinite(level) && oc <= level + tol;
    rule = `on-chain ${fmt(oc)} vs trail level ${fmt(level)} (peak ${fmt(peakPct)} − ${dropPct}pt, +${tol}pt)`;
  } else {
    return { close: true, pnlPct: oc, source: "onchain", mismatch, why: "not a PnL exit" };
  }
  // A stop loss that on-chain itself confirms exits even when the API is off;
  // for take profit / trailing a >2pt disagreement means one source is wrong: hold.
  const close = crosses && (kind === "stop_loss" || !mismatch);
  const why = !crosses
    ? `not confirmed: ${rule}`
    : !close
      ? `API ${fmt(api)} and on-chain ${fmt(oc)} disagree by more than ${PNL_MISMATCH_PTS}pt — holding`
      : `confirmed: ${rule}`;
  return { close, pnlPct: oc, source: "onchain", mismatch, why };
}

/**
 * Fetch on-chain PnL (cached ~20s) and decide. `getOnchain` is injectable for tests.
 * Logs pnl_mismatch when the two sources disagree by more than 2 points.
 * Returns the decision plus `onchain` (the raw read, or null).
 */
export async function confirmPnlExit({ position, kind, apiPct, threshold, peakPct, dropPct, label = null, unit = "sol", getOnchain }) {
  let onchain;
  try {
    const fn = getOnchain || (await import("./tools/onchain-pnl.js")).getOnchainPnl;
    onchain = await fn(position);
  } catch { onchain = null; }
  const onchainPct = onchainPctForUnit(onchain, unit);
  const decision = decidePnlExit({ kind, apiPct, onchainPct, threshold, peakPct, dropPct });
  const name = label || String(position?.position ?? position ?? "").slice(0, 8);
  if (decision.mismatch) {
    log("pnl_mismatch", `${name}: API ${fmt(apiPct)} vs on-chain ${fmt(onchainPct)} (value ${onchain?.valueSol ?? "?"} SOL, deposit ${onchain?.depositSol ?? "?"} SOL, fees ${onchain?.feesSol ?? "?"} SOL) — ${kind} ${decision.close ? "exits" : "held"}`);
  }
  log("pnl_confirm", `${name}: ${kind} ${decision.close ? "CONFIRMED" : "HELD"} — ${decision.why}`);
  return { ...decision, onchain, onchainPct };
}

/**
 * Which PnL rule a management close_position is acting on, from the data the
 * management cycle saw. null = not a PnL close (instruction, OOR timeout, yield
 * dead, judgment), which the gate leaves alone.
 */
export function classifyManagementClose(p, tracked, mgmt) {
  if (!p || p.pnl_pct == null || !Number.isFinite(Number(p.pnl_pct))) return null;
  if (tracked?.instruction) return null; // rule 1
  if ((p.minutes_out_of_range ?? 0) >= (mgmt.outOfRangeWaitMinutes ?? Infinity)) return null; // rule 4
  const pct = Number(p.pnl_pct);
  if (mgmt.takeProfitFeePct && pct >= mgmt.takeProfitFeePct) {
    return { kind: "take_profit", threshold: mgmt.takeProfitFeePct, rule: "rule 3 (take profit)" };
  }
  const dropPct = Number(mgmt.trailingDropPct);
  if (mgmt.trailingTakeProfit && tracked?.trailing_active && Number.isFinite(dropPct) && dropPct > 0
    && Number(tracked.peak_pnl_pct) - pct >= dropPct) {
    return { kind: "trailing", peakPct: Number(tracked.peak_pnl_pct), dropPct, rule: "trailing take profit" };
  }
  if (mgmt.stopLossPct && pct <= mgmt.stopLossPct) {
    return { kind: "stop_loss", threshold: mgmt.stopLossPct, rule: "stop loss" };
  }
  if (mgmt.emergencyPriceDropPct != null && pct <= mgmt.emergencyPriceDropPct) {
    return { kind: "stop_loss", threshold: mgmt.emergencyPriceDropPct, rule: "rule 6 (emergency stop)" };
  }
  return null;
}

/**
 * Gate for a close_position the management LLM makes. Uses the position data
 * the cycle acted on (getPositions: cached getMyPositions) to see whether the
 * close is a PnL rule; if so, on-chain PnL must confirm it.
 * Returns { pass: true } or { pass: false, reason }. Deps are injected so the
 * executor (and tests) can supply them.
 */
export async function managementPnlCloseGate({ position_address, mgmt, getPositions, getTracked, getOnchain, onHold }) {
  let p;
  try {
    const res = await getPositions();
    p = (res?.positions || []).find((x) => x.position === position_address) || null;
  } catch { p = null; }
  if (!p) return { pass: true }; // nothing to classify: not a PnL decision we can check
  const tracked = getTracked(position_address);
  const cls = classifyManagementClose(p, tracked, mgmt);
  if (!cls) return { pass: true };
  const decision = await confirmPnlExit({
    position: p,
    kind: cls.kind,
    apiPct: p.pnl_pct,
    threshold: cls.threshold,
    peakPct: cls.peakPct,
    dropPct: cls.dropPct,
    label: p.pair || null,
    unit: mgmt.pnlUnit,
    getOnchain,
  });
  if (decision.close) return { pass: true, onchainPct: decision.onchainPct };
  onHold?.(cls, decision);
  const ocText = decision.onchainPct != null ? `${decision.onchainPct}%` : "unavailable";
  return {
    pass: false,
    reason: `close_position held: ${cls.rule} was read from the PnL API (pnl_pct ${p.pnl_pct}%), but on-chain PnL is ${ocText} — ${decision.why}. Treat this position as HOLD for PnL rules this cycle; it is re-checked next cycle (rule 4 OOR-timeout closes are not gated).`,
  };
}
