/**
 * Market Maker runtime manager — runs one market-maker loop per pool in-process,
 * each with its own AbortController and latest status snapshot. Used by the
 * standalone control panel (scripts/mm-panel.js) to start/stop/monitor pools.
 *
 * Mirrors the start/stop lifecycle of pnl-watcher.js but keyed by pool address.
 * Independent of the agent dashboard (server.js / web).
 */

import { log } from "./logger.js";
import { runMarketMaker, loadMarketMakerConfig } from "./tools/market-maker.js";

// pool -> { controller, status, startedAt, dry, error }
const running = new Map();

export function isMmRunning(pool) {
  return running.has(pool);
}

/**
 * Start a market-maker loop for a pool. Merges global defaults ← per-pool file ←
 * `overrides`. Returns immediately; the loop runs until stopMm/stopAllMm aborts it.
 */
export function startMm(pool, overrides = {}) {
  pool = (pool || "").trim();
  if (!pool) return { error: "pool address required" };
  if (running.has(pool)) return { error: `Market maker already running for ${pool}`, running: true };

  let mm;
  try {
    mm = loadMarketMakerConfig(overrides || {}, { poolAddress: pool });
    mm.__resolved = true;
  } catch (e) {
    return { error: `Config error: ${e.message}` };
  }

  const controller = new AbortController();
  const entry = {
    controller,
    startedAt: Date.now(),
    dry: process.env.DRY_RUN === "true",
    status: null,
    error: null,
  };
  running.set(pool, entry);

  runMarketMaker({
    poolAddress: pool,
    config: mm,
    signal: controller.signal,
    onStatus: (snap) => { const e = running.get(pool); if (e) e.status = snap; },
  })
    .then(() => { log("mm_runtime", `Loop ended for ${pool.slice(0, 8)}`); })
    .catch((e) => {
      log("mm_runtime", `Loop error for ${pool.slice(0, 8)}: ${e.message}`);
      const en = running.get(pool);
      if (en) en.error = e.message;
    })
    .finally(() => { running.delete(pool); });

  log("mm_runtime", `Started market maker for ${pool.slice(0, 8)}${entry.dry ? " [DRY_RUN]" : ""}`);
  return { started: true, pool, dry: entry.dry, config: mm };
}

/** Stop a pool's loop (aborts → the loop cancels & closes all its orders). */
export function stopMm(pool) {
  pool = (pool || "").trim();
  const entry = running.get(pool);
  if (!entry) return { error: `No market maker running for ${pool}`, running: false };
  entry.controller.abort();
  log("mm_runtime", `Stop requested for ${pool.slice(0, 8)} (cancelling orders)`);
  return { stopping: true, pool };
}

/** Stop every running loop (used on panel shutdown). Returns the pools signalled. */
export function stopAllMm() {
  const pools = [...running.keys()];
  for (const [, entry] of running) entry.controller.abort();
  if (pools.length) log("mm_runtime", `Stopping all market makers: ${pools.length}`);
  return { stopping: pools };
}

/** Snapshot of all running loops + their latest status for the UI. */
export function getMmStatus() {
  const dry = process.env.DRY_RUN === "true";
  return {
    dry,
    count: running.size,
    pools: [...running.entries()].map(([pool, e]) => ({
      pool,
      startedAt: e.startedAt,
      uptimeMs: Date.now() - e.startedAt,
      error: e.error,
      status: e.status,
    })),
  };
}
