/**
 * Re-center shadow log (LOG ONLY — no behavior change).
 *
 * When a position is out of range on the upside, log what an in-place
 * re-center (SDK rebalancePosition) would do instead of the close + redeploy
 * that rule 4 performs: the new range, the estimated transactions, whether the
 * bin arrays for the new range already exist, and whether the TWAP gate would
 * allow it. Nothing here signs, sends or changes state; the close path is untouched.
 */

import { log as defaultLog } from "../logger.js";
import { currentEntryFilters, readTwap, evaluateTwapGuard } from "./entry-safety.js";

// Beyond this token share the position is not ~100% SOL: re-centering would
// average down into the token, so the shadow says it would NOT re-center.
const MAX_TOKEN_PCT = 2;

/**
 * Build the shadow plan for one position (from getMyPositions()).
 * deps: { getPool(addr), binArrayWindow(pool, min, max, active), filters, nowSec }
 * Returns the plan object (also used by the test), or null when not applicable.
 */
export async function buildRecenterShadow(p, deps = {}) {
  if (!p || p.in_range || p.oor_direction !== "upside") return null;
  const lower = Number(p.lower_bin);
  const upper = Number(p.upper_bin);
  const active = Number(p.active_bin);
  if (![lower, upper, active].every(Number.isFinite) || active <= upper) return null;

  const filters = deps.filters || currentEntryFilters();
  const width = upper - lower + 1;
  // Same convention as deployPosition for SOL-only bid_ask: all bins at/below active.
  const newMin = active - (width - 1);
  const newMax = active;
  const plan = {
    position: p.position,
    pair: p.pair,
    minutes_oor: p.minutes_out_of_range ?? null,
    from: [lower, upper],
    to: [newMin, newMax],
    width,
    bins_above_range: active - upper,
    token_pct: p.composition?.token_pct ?? null,
    would_recenter: true,
    blockers: [],
    bin_arrays: null,
    est_txs: null,
    twap: null,
    twap_gate: null,
  };
  if (plan.token_pct != null && plan.token_pct > MAX_TOKEN_PCT) {
    plan.would_recenter = false;
    plan.blockers.push(`holds ${plan.token_pct}% token (re-centering would average down)`);
  }

  let pool = null;
  try {
    pool = await deps.getPool(p.pool);
  } catch (e) {
    plan.blockers.push(`pool read failed: ${e.message}`);
  }
  if (pool) {
    try {
      const w = await deps.binArrayWindow(pool, newMin, newMax, active);
      plan.bin_arrays = { missing: w.missing.length, all_exist: w.missing.length === 0 };
    } catch (e) {
      plan.bin_arrays = { error: e.message };
    }
    const tw = await readTwap(pool, { windowMinutes: filters.twapWindowMinutes ?? 60, nowSec: deps.nowSec });
    plan.twap = tw;
    // The gate a live re-center would use: the entry TWAP limit (15% when the guard is off).
    const gate = evaluateTwapGuard(tw, { maxPct: filters.twapSpikeMaxPct ?? 15, strategy: "bid_ask" });
    plan.twap_gate = gate.pass ? (tw.known ? "allow" : "allow (TWAP unknown)") : "deny";
    if (!gate.pass) plan.blockers.push(`TWAP gate: ${gate.reason}`);
  }
  const missing = plan.bin_arrays?.missing ?? null;
  // rebalancePosition = one rebalance_liquidity tx (withdraw + deposit + resize,
  // optional fee claim), plus bin-array init instructions when arrays are missing.
  plan.est_txs = missing == null ? "1 rebalance_liquidity tx (+ bin-array inits if any are missing)"
    : `1 rebalance_liquidity tx${missing ? ` + ${missing} bin-array init (~${(missing * 0.0714).toFixed(4)} SOL non-refundable)` : ""} vs close + redeploy (≈3–5 txs + a screening cycle)`;
  if (plan.blockers.length && plan.would_recenter) plan.would_recenter = !plan.blockers.some((b) => /^TWAP gate|pool read failed/.test(b));
  return plan;
}

export function formatRecenterShadow(plan) {
  const ba = plan.bin_arrays;
  const arrays = !ba ? "unknown" : ba.error ? `unknown (${ba.error})` : ba.all_exist ? "all exist" : `${ba.missing} missing`;
  const tw = plan.twap;
  const twap = !tw ? "not read" : tw.known ? `${tw.devPct >= 0 ? "+" : ""}${tw.devPct}% vs ${tw.windowMinutes}m TWAP` : `unknown (${tw.note})`;
  return `${plan.pair ?? "?"} ${String(plan.position ?? "").slice(0, 8)}: upside OOR ${plan.minutes_oor ?? "?"}m ` +
    `(active ${plan.to[1]} is ${plan.bins_above_range} bins above upper ${plan.from[1]}); ` +
    `would re-center ${plan.from[0]}..${plan.from[1]} → ${plan.to[0]}..${plan.to[1]} (${plan.width} bins); ` +
    `est. txs: ${plan.est_txs}; bin arrays: ${arrays}; TWAP gate: ${plan.twap_gate ?? "n/a"} (${twap}); ` +
    `verdict: ${plan.would_recenter ? "WOULD re-center" : "would NOT re-center"}${plan.blockers.length ? ` [${plan.blockers.join("; ")}]` : ""}. ` +
    "Shadow only — no action taken; rule 4 close behavior unchanged.";
}

/** Log one [RECENTER_SHADOW] line for an upside-OOR position. Never throws. */
export async function logRecenterShadow(p, deps = {}) {
  const log = deps.log || defaultLog;
  try {
    if (!deps.getPool || !deps.binArrayWindow) {
      const dlmm = await import("./dlmm.js");
      deps = { getPool: dlmm.getPoolForRead, binArrayWindow: dlmm.initializedBinArrayWindow, ...deps };
    }
    const plan = await buildRecenterShadow(p, deps);
    if (plan) log("recenter_shadow", formatRecenterShadow(plan));
    return plan;
  } catch (e) {
    log("recenter_shadow", `${p?.pair ?? "?"}: shadow plan failed: ${e.message}`);
    return null;
  }
}
