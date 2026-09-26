/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";

const STATE_FILE = "./state.json";

// Points of API vs on-chain PnL disagreement above which the API reading is
// treated as wrong (same value as PNL_MISMATCH_PTS in pnl-confirm.js).
const PNL_MISMATCH_PTS = 2;

const MAX_RECENT_EVENTS = 20;

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return { positions: {}, lastUpdated: null };
  }
}

function save(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  strategy_type = null,
  sol_split_pct = null,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  active_bin_at_deploy,
  bin_step,
  volatility,
  fee_tvl_ratio,
  initial_fee_tvl_24h,
  organic_score,
  initial_value_usd,
  deployed_at,
  base_mint,
  adopted = false,
  study_avg_hold_hours = null,
  signal_snapshot = null,
  experiment_id = null,   // autoresearch A/B: set when deployed inside an experiment arm
  experiment_arm = null,  // "control" | "candidate"
  range_depth_mode = null,   // strategy.rangeDepthMode at deploy
  ohlcv_buffer_mult = null,  // strategy.ohlcvBufferMult at deploy (ohlcv mode only)
  ohlcv_depth_pct = null,    // candle depth deploy_position saw, when it had one
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    base_mint: base_mint || null,
    strategy,
    strategy_type,
    sol_split_pct,
    bin_range,
    amount_sol,
    amount_x,
    active_bin_at_deploy: active_bin_at_deploy || active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: initial_fee_tvl_24h || fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    deployed_at: deployed_at || new Date().toISOString(),
    adopted,
    study_avg_hold_hours: study_avg_hold_hours || null,
    signal_snapshot: signal_snapshot || null,
    ...(experiment_id && { experiment_id, experiment_arm }),
    range_depth_mode: range_depth_mode || null,
    ohlcv_buffer_mult: ohlcv_buffer_mult ?? null,
    ohlcv_depth_pct: ohlcv_depth_pct ?? null,
    min_active_bin: null,   // lowest active bin seen while open (recordActiveBin)
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    peak_pnl_pct: 0,
    trailing_active: false,
    closed: false,
    closed_at: null,
    notes: adopted ? ["Auto-adopted: position was opened externally"] : [],
  };
  const action = adopted ? "adopt" : "deploy";
  pushEvent(state, { action, position, pool_name: pool_name || pool });
  save(state);
  log("state", `Tracked ${adopted ? "adopted" : "new"} position: ${position} in pool ${pool}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address, direction = null) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    pos.oor_direction = direction || null;
    save(state);
    log("state", `Position ${position_address} marked out of range (${direction || "unknown"})`);
  }
}

/**
 * Remember the lowest active bin seen while the position is open, so the close
 * record can say how deep into the range price actually went. Writes only when
 * a new low is seen.
 */
export function recordActiveBin(position_address, activeBin) {
  if (!Number.isFinite(Number(activeBin))) return;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return;
  const bin = Number(activeBin);
  if (pos.min_active_bin == null || bin < pos.min_active_bin) {
    pos.min_active_bin = bin;
    save(state);
  }
}

/**
 * How far into its downside range (0–100%) price went while a position was
 * open: from the deploy-time active bin down to the lowest active bin seen,
 * as a share of the range depth (price terms when bin_step is known). Below
 * the range = 100. null when the bins are unknown.
 */
export function deepestBinReachedPct(pos) {
  const entry = Number(pos?.active_bin_at_deploy ?? pos?.bin_range?.max);
  const lower = Number(pos?.bin_range?.min);
  const low = Number(pos?.min_active_bin);
  if (![entry, lower, low].every(Number.isFinite) || !(entry > lower)) return null;
  const binsDown = Math.max(0, entry - low);
  const binsDeep = entry - lower;
  const step = Number(pos?.bin_step) / 10000;
  const frac = step > 0
    ? (1 - Math.pow(1 + step, -Math.min(binsDown, binsDeep))) / (1 - Math.pow(1 + step, -binsDeep))
    : Math.min(binsDown, binsDeep) / binsDeep;
  return Math.round(Math.min(1, Math.max(0, frac)) * 1000) / 10;
}

/**
 * Depth-use fields for a close record (performance history): how deep price
 * went, the OOR side at close, whether it was a stop loss, and the buffer the
 * deploy used. Fed to the ohlcvBufferMult evolution (lessons.js).
 */
export function depthUseAtClose(pos, closeReason = "") {
  if (!pos) return {};
  const notes = Array.isArray(pos.notes) ? pos.notes : [];
  return {
    deepest_bin_reached_pct: deepestBinReachedPct(pos),
    oor_direction_at_close: pos.out_of_range_since ? (pos.oor_direction || null) : null,
    stop_loss_close: /stop[_ ]?loss/i.test(String(closeReason || "")) || notes.some((n) => /^STOP_LOSS:/.test(String(n))),
    range_depth_mode: pos.range_depth_mode ?? null,
    ohlcv_buffer_mult: pos.ohlcv_buffer_mult ?? null,
    ohlcv_depth_pct: pos.ohlcv_depth_pct ?? null,
  };
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    pos.oor_direction = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  pos.notes.push(`Claimed ~${fees_usd?.toFixed(2) || "?"} USD fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

/**
 * Patch fields on an existing tracked position (e.g. partial deploy amounts)
 * and optionally append a note. No-op if the position is not tracked.
 */
export function updateTrackedPosition(position_address, patch = {}, note = null) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  Object.assign(pos, patch);
  if (note) pos.notes.push(note);
  save(state);
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address, reason) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  save(state);
  log("state", `Position ${position_address} marked closed: ${reason}`);
}

// ─── Close exposure (what an agent swap_token may sell) ────────
// A close whose post-close swap left withdrawn base token unsold records it
// here. tools/swap-guard.js lets the agent sell at most this, within
// CLOSE_EXPOSURE_WINDOW_MS, and never while the close's swap may still land.

/**
 * @param {string} position_address
 * @param {{ mint: string, decimals: number|null, pre_raw: string|null,
 *   unsold_raw: string, ambiguous?: boolean }} exposure (tools/close-swap.js)
 * @param {{ now?: number, ambiguousWindowMs?: number }} [opts]
 */
export function recordCloseExposure(position_address, exposure, { now = Date.now(), ambiguousWindowMs = 90_000 } = {}) {
  if (!exposure?.mint) return null;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return null;
  pos.close_exposure = {
    mint: exposure.mint,
    decimals: Number.isInteger(exposure.decimals) ? exposure.decimals : null,
    pre_raw: exposure.pre_raw ?? null,
    unsold_raw: String(exposure.unsold_raw ?? "0"),
    agent_sold_raw: "0",
    recorded_at: new Date(now).toISOString(),
    ambiguous_until: exposure.ambiguous ? new Date(now + ambiguousWindowMs).toISOString() : null,
  };
  save(state);
  return { position: position_address, ...pos.close_exposure };
}

/**
 * Most recent close exposure recorded for `mint` within `windowMs`, as
 * { position, ...close_exposure }, or null.
 */
export function findRecentCloseExposure(mint, { now = Date.now(), windowMs = 2 * 60 * 60 * 1000 } = {}) {
  if (!mint) return null;
  const state = load();
  let best = null;
  for (const [address, pos] of Object.entries(state.positions || {})) {
    const e = pos?.close_exposure;
    if (!e || e.mint !== mint) continue;
    const at = Date.parse(e.recorded_at);
    if (!Number.isFinite(at) || now - at > windowMs || at > now + 60_000) continue;
    if (!best || at > Date.parse(best.recorded_at)) best = { position: address, ...e };
  }
  return best;
}

/**
 * After an agent swap_token against a close exposure: add what it sold, or
 * open a new in-flight window when its outcome is ambiguous.
 */
export function noteAgentExposureSwap(position_address, { soldRaw = null, ambiguous = false } = {}, { now = Date.now(), ambiguousWindowMs = 90_000 } = {}) {
  const state = load();
  const e = state.positions[position_address]?.close_exposure;
  if (!e) return;
  if (soldRaw != null) e.agent_sold_raw = (BigInt(e.agent_sold_raw || "0") + BigInt(soldRaw)).toString();
  if (ambiguous) e.ambiguous_until = new Date(now + ambiguousWindowMs).toISOString();
  save(state);
}

/**
 * Record a rebalance (close + redeploy).
 */
export function recordRebalance(old_position, new_position) {
  const state = load();
  const old = state.positions[old_position];
  if (old) {
    old.closed = true;
    old.closed_at = new Date().toISOString();
    old.notes.push(`Rebalanced into ${new_position} at ${old.closed_at}`);
  }
  const newPos = state.positions[new_position];
  if (newPos) {
    newPos.rebalance_count = (old?.rebalance_count || 0) + 1;
    newPos.notes.push(`Rebalanced from ${old_position}`);
  }
  save(state);
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = instruction || null;
  save(state);
  log("state", `Position ${position_address} instruction set: ${instruction}`);
  return true;
}

/**
 * Update peak PnL and check trailing take profit / stop loss.
 * Returns an action string if a threshold is hit, or null.
 */
export function updatePnlAndCheckExits(position_address, currentPnlPct, config, { onchainPct = null } = {}) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  // Unknown PnL (null/NaN from a failed PnL fetch) → take no exit action and
  // leave peak/trailing state untouched this tick.
  if (currentPnlPct == null || !Number.isFinite(Number(currentPnlPct))) return null;
  currentPnlPct = Number(currentPnlPct);

  const mgmt = config.management;
  let action = null;

  // Warm-up spike guard. For the first minutes after a (chunked) deploy the PnL
  // sources can report nonsense before every deposit is indexed — seen live: +48.6%
  // 20s after deploy armed trailing TP and the next normal reading closed the position.
  // An extreme reading on a young position is held as pending and acted on only if the
  // next reading roughly agrees, so a real crash still exits one tick later.
  const warmupMin = mgmt.pnlWarmupMinutes ?? 15;
  const extremeAbsPct = mgmt.pnlWarmupMaxAbsPct ?? 25;
  const ageMs = pos.deployed_at ? Date.now() - new Date(pos.deployed_at).getTime() : Infinity;
  if (ageMs < warmupMin * 60_000 && Math.abs(currentPnlPct) > extremeAbsPct) {
    const pending = pos._pnl_pending_extreme;
    const agrees = pending
      && Math.sign(pending.pct) === Math.sign(currentPnlPct)
      && Math.abs(pending.pct - currentPnlPct) <= Math.max(5, Math.abs(pending.pct) * 0.25);
    if (!agrees) {
      pos._pnl_pending_extreme = { pct: currentPnlPct, at: new Date().toISOString() };
      save(state);
      log("state", `Position ${position_address} PnL ${currentPnlPct.toFixed(1)}% looks like a warm-up spike (age ${Math.round(ageMs / 60000)}m) — waiting for confirmation`);
      return null;
    }
  }
  if (pos._pnl_pending_extreme) {
    delete pos._pnl_pending_extreme; // a stale pending must not "confirm" a later spike
    save(state);
  }

  // Hard stop loss
  if (mgmt.stopLossPct && currentPnlPct <= mgmt.stopLossPct) {
    action = `STOP_LOSS: PnL ${currentPnlPct.toFixed(1)}% hit stop loss (${mgmt.stopLossPct}%)`;
    pos.notes.push(action);
    save(state);
    return action;
  }

  // Track peak PnL. When the caller has an on-chain reading (pnl-watcher) that
  // disagrees with the API by more than 2 points, the on-chain value sets the
  // peak and arms trailing: a bad API reading must not become the trailing peak.
  let peakCandidate = currentPnlPct;
  const oc = onchainPct == null ? NaN : Number(onchainPct);
  if (Number.isFinite(oc)) {
    if (oc > (pos.peak_onchain_pnl_pct ?? -Infinity)) pos.peak_onchain_pnl_pct = oc;
    if (Math.abs(oc - currentPnlPct) > PNL_MISMATCH_PTS) peakCandidate = oc;
  }
  if (peakCandidate > (pos.peak_pnl_pct || 0)) {
    pos.peak_pnl_pct = peakCandidate;
  }

  // Trailing take profit
  if (mgmt.trailingTakeProfit) {
    // Activate trailing once profit exceeds trigger
    if (!pos.trailing_active && peakCandidate >= mgmt.trailingTriggerPct) {
      pos.trailing_active = true;
      pos.notes.push(`Trailing TP activated at ${peakCandidate.toFixed(1)}%`);
      log("state", `Position ${position_address} trailing TP activated (peak: ${peakCandidate.toFixed(1)}%)`);
    }

    // Check if profit has dropped from peak by trailingDropPct.
    // Guard: only apply trailing-TP exit when trailingDropPct is a sane value
    // (finite, > 0 and < 100). An invalid/zero/NaN config must NOT trigger an
    // immediate exit — skip the trailing logic entirely in that case.
    const dropPct = mgmt.trailingDropPct;
    const dropPctValid = Number.isFinite(dropPct) && dropPct > 0 && dropPct < 100;
    if (pos.trailing_active && dropPctValid) {
      const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
      if (dropFromPeak >= dropPct) {
        action = `TRAILING_TP: PnL dropped ${dropFromPeak.toFixed(1)}% from peak ${pos.peak_pnl_pct.toFixed(1)}% (trail: ${mgmt.trailingDropPct}%)`;
        pos.notes.push(action);
        save(state);
        return action;
      }
    }
  }

  save(state);
  return action;
}

/**
 * A PnL exit that on-chain PnL did not confirm (pnl-confirm.js). Replaces the
 * exit note updatePnlAndCheckExits just pushed with a HELD note, so a later
 * close isn't recorded as that exit (depthUseAtClose reads STOP_LOSS notes).
 * When the stored peak is more than 2 points above the on-chain reading, the
 * peak came from a bad API reading: pull it down to the best on-chain reading
 * seen, and disarm trailing if that is below the trigger.
 */
export function recordPnlHold(position_address, action, detail, { onchainPct = null, config = null } = {}) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return;
  if (!Array.isArray(pos.notes)) pos.notes = [];
  if (action && pos.notes[pos.notes.length - 1] === action) pos.notes.pop();
  // One HELD note per position (the latest): a hold repeats every tick.
  pos.notes = pos.notes.filter((n) => !String(n).startsWith("HELD (on-chain PnL did not confirm)"));
  pos.notes.push(`HELD (on-chain PnL did not confirm): ${action || "PnL exit"} — ${detail} [${new Date().toISOString()}]`);
  const oc = onchainPct == null ? NaN : Number(onchainPct);
  if (Number.isFinite(oc) && (pos.peak_pnl_pct || 0) > oc + PNL_MISMATCH_PTS) {
    const before = Number(pos.peak_pnl_pct);
    pos.peak_pnl_pct = Math.max(0, oc, pos.peak_onchain_pnl_pct ?? -Infinity);
    const trigger = Number(config?.management?.trailingTriggerPct);
    if (pos.trailing_active && Number.isFinite(trigger) && pos.peak_pnl_pct < trigger) pos.trailing_active = false;
    log("state", `Position ${position_address} peak PnL ${before.toFixed(1)}% not backed on-chain — reset to ${pos.peak_pnl_pct.toFixed(1)}%${pos.trailing_active ? "" : " (trailing off)"}`);
  }
  save(state);
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      oor_direction: p.oor_direction || null,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

// ─── Screening pause (Telegram bot controls) ───────────────────

/**
 * Operator pause for the screening cron. Persisted in state.json so a restart
 * keeps it paused. Management and the PnL watcher ignore it on purpose.
 */
export function isScreeningPaused() {
  const state = load();
  return state._screeningPaused?.paused === true;
}

export function getScreeningPause() {
  const state = load();
  return state._screeningPaused || { paused: false, at: null, by: null };
}

export function setScreeningPaused(paused, by = "operator") {
  const state = load();
  state._screeningPaused = { paused: !!paused, at: new Date().toISOString(), by };
  save(state);
  log("state", `Screening ${paused ? "PAUSED" : "RESUMED"} by ${by}`);
  return state._screeningPaused;
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
const SYNC_GRACE_MS = 1 * 60_000; // don't auto-close positions deployed < 1 min ago

export async function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  // Collect positions that need closing first to batch the LP Agent fetch
  const toClose = [];
  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    toClose.push(posId);
  }

  if (toClose.length === 0) return;

  // Single LP Agent fetch for all positions that need closing (avoids N+1)
  let lpAgentMap = new Map();
  try {
    const { fetchHistoricalPositionMap } = await import("./tools/lp-overview.js");
    lpAgentMap = await fetchHistoricalPositionMap();
  } catch { /* LP Agent unavailable */ }

  // Lazy import of recordPerformance (only needed if we have closed positions)
  let recordPerformance = null;

  for (const posId of toClose) {
    const pos = state.positions[posId];
    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);

    // Use pre-fetched LP Agent data
    try {
      const closedData = lpAgentMap.get(posId) || null;
      if (closedData) {
        if (!recordPerformance) {
          recordPerformance = (await import("./lessons.js")).recordPerformance;
        }
        const minutesHeld = pos.deployed_at
          ? Math.floor((Date.now() - new Date(pos.deployed_at).getTime()) / 60000)
          : Math.round((closedData.age_hours || 0) * 60);
        let minutesOOR = 0;
        if (pos.out_of_range_since) {
          minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
        }

        await recordPerformance({
          position: posId,
          pool: pos.pool || closedData.pool,
          pool_name: pos.pool_name || closedData.pair || "unknown",
          strategy: pos.strategy || closedData.strategy,
          strategy_type: pos.strategy_type || null,
          sol_split_pct: pos.sol_split_pct ?? null,
          bin_range: pos.bin_range || { min: closedData.lower_bin, max: closedData.upper_bin },
          bin_step: pos.bin_step || closedData.bin_step,
          volatility: pos.volatility || null,
          fee_tvl_ratio: pos.fee_tvl_ratio || null,
          organic_score: pos.organic_score || null,
          amount_sol: pos.amount_sol || closedData.initial_value_sol,
          base_mint: pos.base_mint || closedData.base_mint,
          fees_earned_usd: closedData.fees_usd,
          final_value_usd: closedData.final_value_usd,
          initial_value_usd: pos.initial_value_usd || closedData.initial_value_usd,
          actual_pnl_usd: closedData.pnl_usd,
          actual_pnl_pct: closedData.pnl_pct,
          minutes_in_range: Math.max(0, minutesHeld - minutesOOR),
          minutes_held: minutesHeld,
          close_reason: pos.oor_direction
            ? `external close (detected during sync, OOR ${pos.oor_direction})`
            : "external close (detected during sync)",
          ...depthUseAtClose(pos),
          signal_snapshot: pos.signal_snapshot || null,
          ...(pos.experiment_id && { experiment_id: pos.experiment_id, experiment_arm: pos.experiment_arm }),
        });

        pos.notes.push(`LP Agent PnL: ${closedData.pnl_pct}% ($${closedData.pnl_usd})`);
        log("state", `Recorded performance for externally closed ${posId}: PnL ${closedData.pnl_pct}%`);
      }
    } catch (e) {
      log("state_warn", `Could not fetch LP Agent data for closed position ${posId}: ${e.message}`);
    }

    // ─── Hard rule: swap ONLY the withdrawn base token back to SOL ───
    // The position was closed externally before we observed it, so we no longer
    // have a clean pre-close snapshot. We use pos.pre_close_base_balance if some
    // upstream step recorded it; otherwise the pre-close balance is UNKNOWN and
    // we must NOT swap the whole wallet balance (it may include unrelated holdings
    // or other open positions' base tokens). In that case skip the swap and flag
    // the leftover exposure rather than risk dumping everything.
    try {
      const baseMint = pos.base_mint;
      const SOL = "So11111111111111111111111111111111111111112";
      if (baseMint && baseMint !== SOL) {
        const { getWalletBalances, swapToken } = await import("./tools/wallet.js");
        const preBal =
          typeof pos.pre_close_base_balance === "number"
            ? pos.pre_close_base_balance
            : null;

        if (preBal == null) {
          pos.exposure = { mint: baseMint, reason: "pre-close base balance unknown; auto-swap skipped" };
          pos.notes.push(`Leftover base-token exposure (${baseMint.slice(0, 8)}): pre-close balance unknown, swap manually`);
          log("state_warn", `Post-sync-close swap skipped for ${baseMint}: pre-close balance unknown — leftover exposure flagged.`);
        } else {
          const walletBals = await getWalletBalances();
          const baseToken = walletBals.tokens?.find((t) => t.mint === baseMint);
          const currentBal = baseToken?.balance ?? 0;
          const swapAmount = Math.max(0, currentBal - preBal);
          const unitUsd = (baseToken && currentBal > 0) ? (baseToken.usd ?? 0) / currentBal : 0;
          const deltaUsd = unitUsd * swapAmount;

          if (swapAmount > 0 && deltaUsd >= 0.10) {
            log("state", `Post-sync-close: swapping ${swapAmount} ${baseToken.symbol || baseMint.slice(0, 8)} -> SOL (withdrawn delta, worth ~$${deltaUsd.toFixed(2)})`);
            const swapResult = await swapToken({
              input_mint: baseMint,
              output_mint: SOL,
              amount: swapAmount,
            }, { impactCap: "close" }); // post-close swap-back: maxCloseSwapPriceImpactPct
            if (swapResult?.success) {
              log("state", `Post-sync-close swap OK: tx ${swapResult.tx}`);
            } else {
              pos.exposure = { mint: baseMint, reason: swapResult?.error || "swap failed" };
              log("state_warn", `Post-sync-close swap failed: ${swapResult?.error || "unknown"}`);
            }
          }
        }
      }
    } catch (swapErr) {
      log("state_warn", `Post-sync-close swap error: ${swapErr.message}`);
    }
  }

  if (changed) save(state);
}
