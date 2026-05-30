/**
 * signal-tracker.js — Captures screening signals at deploy time for Darwinian weighting.
 *
 * During screening, signals are "staged" for each candidate pool.
 * When deploy_position fires, the staged signals are retrieved and stored
 * in state.json alongside the position, so we know exactly what signals
 * were present when the decision was made.
 *
 * This enables post-hoc analysis: which signals actually predicted wins?
 */

import { log } from "./logger.js";

// In-memory staging area — cleared after retrieval or after 10 minutes
const _staged = new Map();
const STAGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Reverse map: mint address → pool address (for tools that receive mint instead of pool)
const _mintToPool = new Map();

/**
 * Stage signals for a pool during screening.
 * Called after candidate data is loaded, before the LLM decides.
 * @param {string} poolAddress
 * @param {object} signals — { organic_score, fee_tvl_ratio, volume, mcap, holder_count, smart_wallets_present, narrative_quality, study_win_rate, volatility }
 * @param {string} [baseMint] — optional base token mint to register in the mint→pool reverse map
 */
export function stageSignals(poolAddress, signals, baseMint) {
  _staged.set(poolAddress, {
    ...signals,
    staged_at: Date.now(),
  });
  if (baseMint) {
    _mintToPool.set(baseMint, poolAddress);
  }
  // Clean up stale entries
  for (const [addr, data] of _staged) {
    if (Date.now() - data.staged_at > STAGE_TTL_MS) {
      _staged.delete(addr);
    }
  }
}

/**
 * Merge partial signals into an existing staged entry without overwriting other fields.
 * If no entry exists for this pool, creates one with just the partial signals.
 * @param {string} poolAddress
 * @param {object} partialSignals — subset of signal fields to update
 */
export function updateStagedSignals(poolAddress, partialSignals) {
  const existing = _staged.get(poolAddress);
  if (existing) {
    // Merge: only overwrite fields that are non-null in partialSignals
    for (const [key, val] of Object.entries(partialSignals)) {
      if (val != null) {
        existing[key] = val;
      }
    }
    existing.staged_at = Date.now(); // refresh TTL
  } else {
    _staged.set(poolAddress, {
      ...partialSignals,
      staged_at: Date.now(),
    });
  }
  log("signals", `Updated staged signals for ${poolAddress.slice(0, 8)}: ${Object.keys(partialSignals).join(", ")}`);
}

/**
 * Look up the pool address for a given token mint.
 * Returns null if no mapping exists (mint was never staged).
 * @param {string} mint
 * @returns {string|null}
 */
export function getPoolForMint(mint) {
  return _mintToPool.get(mint) || null;
}

/**
 * Retrieve and clear staged signals for a pool.
 * Called from deployPosition after the position is created.
 * @param {string} poolAddress
 * @returns {object|null} Signal snapshot or null if not staged
 */
export function getAndClearStagedSignals(poolAddress) {
  const data = _staged.get(poolAddress);
  if (!data) return null;
  _staged.delete(poolAddress);
  const { staged_at, ...signals } = data;
  log("signals", `Retrieved staged signals for ${poolAddress.slice(0, 8)}: ${Object.keys(signals).filter(k => signals[k] != null).length} signals`);
  return signals;
}

/**
 * Get all currently staged pool addresses (for debugging).
 */
export function getStagedPools() {
  return [..._staged.keys()];
}
