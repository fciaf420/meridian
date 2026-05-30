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
export function updatePnlAndCheckExits(position_address, currentPnlPct, config) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  const mgmt = config.management;
  let action = null;

  // Hard stop loss
  if (mgmt.stopLossPct && currentPnlPct <= mgmt.stopLossPct) {
    action = `STOP_LOSS: PnL ${currentPnlPct.toFixed(1)}% hit stop loss (${mgmt.stopLossPct}%)`;
    pos.notes.push(action);
    save(state);
    return action;
  }

  // Track peak PnL
  if (currentPnlPct > (pos.peak_pnl_pct || 0)) {
    pos.peak_pnl_pct = currentPnlPct;
  }

  // Trailing take profit
  if (mgmt.trailingTakeProfit) {
    // Activate trailing once profit exceeds trigger
    if (!pos.trailing_active && currentPnlPct >= mgmt.trailingTriggerPct) {
      pos.trailing_active = true;
      pos.notes.push(`Trailing TP activated at ${currentPnlPct.toFixed(1)}%`);
      log("state", `Position ${position_address} trailing TP activated (peak: ${currentPnlPct.toFixed(1)}%)`);
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
          signal_snapshot: pos.signal_snapshot || null,
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
            });
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
