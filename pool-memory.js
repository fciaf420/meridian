/**
 * Pool memory — persistent deploy history per pool.
 *
 * Keyed by pool address. Automatically updated when positions close
 * (via recordPerformance in lessons.js). Agent can query before deploying.
 */

import fs from "fs";
import { log } from "./logger.js";

const POOL_MEMORY_FILE = "./pool-memory.json";

function load() {
  if (!fs.existsSync(POOL_MEMORY_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(POOL_MEMORY_FILE, JSON.stringify(data, null, 2));
}

// ─── Write ─────────────────────────────────────────────────────

/**
 * Record a closed deploy into pool-memory.json.
 * Called automatically from recordPerformance() in lessons.js.
 */
export function recordPoolDeploy(poolAddress, deployData) {
  if (!poolAddress) return;

  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: deployData.pool_name || poolAddress.slice(0, 8),
      base_mint: deployData.base_mint || null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  const entry = db[poolAddress];

  const deploy = {
    deployed_at: deployData.deployed_at || null,
    closed_at: deployData.closed_at || new Date().toISOString(),
    pnl_pct: deployData.pnl_pct ?? null,
    pnl_usd: deployData.pnl_usd ?? null,
    range_efficiency: deployData.range_efficiency ?? null,
    minutes_held: deployData.minutes_held ?? null,
    close_reason: deployData.close_reason || null,
    strategy: deployData.strategy || null,
    volatility_at_deploy: deployData.volatility ?? null,
    price_range_pct: deployData.price_range_pct ?? null,
  };

  entry.deploys.push(deploy);
  entry.total_deploys = entry.deploys.length;
  entry.last_deployed_at = deploy.closed_at;
  entry.last_outcome = (deploy.pnl_pct ?? 0) >= 0 ? "profit" : "loss";

  // Recompute aggregates
  const withPnl = entry.deploys.filter((d) => d.pnl_pct != null);
  if (withPnl.length > 0) {
    entry.avg_pnl_pct = Math.round(
      (withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100
    ) / 100;
    entry.win_rate = Math.round(
      (withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length) * 100
    ) / 100;
  }

  if (deployData.base_mint && !entry.base_mint) {
    entry.base_mint = deployData.base_mint;
  }

  save(db);
  log("pool-memory", `Recorded deploy for ${entry.name} (${poolAddress.slice(0, 8)}): PnL ${deploy.pnl_pct}%`);
}

// ─── Read ──────────────────────────────────────────────────────

export function getPoolMemory({ pool_address }) {
  if (!pool_address) return { error: "pool_address required" };

  const db = load();
  const entry = db[pool_address];

  if (!entry) {
    return {
      pool_address,
      known: false,
      message: "No history for this pool — first time deploying here.",
    };
  }

  return {
    pool_address,
    known: true,
    name: entry.name,
    base_mint: entry.base_mint,
    total_deploys: entry.total_deploys,
    avg_pnl_pct: entry.avg_pnl_pct,
    win_rate: entry.win_rate,
    last_deployed_at: entry.last_deployed_at,
    last_outcome: entry.last_outcome,
    notes: entry.notes,
    history: entry.deploys.slice(-10),
  };
}

// ─── Mid-position snapshots ─────────────────────────────────────

const MAX_SNAPSHOTS = 48; // ~4 hours at 5-min intervals

/**
 * Record a live position snapshot for trend analysis.
 * Called every management cycle for each open position.
 */
export function recordPositionSnapshot(poolAddress, snapshot) {
  if (!poolAddress) return;
  const db = load();
  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: snapshot.pair || poolAddress.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
      snapshots: [],
    };
  }
  const entry = db[poolAddress];
  if (!entry.snapshots) entry.snapshots = [];

  entry.snapshots.push({
    ts: new Date().toISOString(),
    pnl_pct: snapshot.pnl_pct ?? null,
    in_range: snapshot.in_range ?? null,
    fees_sol: snapshot.unclaimed_fees_sol ?? null,
    age_min: snapshot.age_minutes ?? null,
    oor_min: snapshot.minutes_out_of_range ?? 0,
  });

  // Keep rolling window
  if (entry.snapshots.length > MAX_SNAPSHOTS) {
    entry.snapshots = entry.snapshots.slice(-MAX_SNAPSHOTS);
  }
  save(db);
}

/**
 * Generate a concise 2-3 line summary for prompt injection.
 * Includes deploy history + recent PnL trend from snapshots.
 */
export function recallForPool(poolAddress) {
  if (!poolAddress) return null;
  const db = load();
  const entry = db[poolAddress];
  if (!entry) return null;

  const lines = [];

  // Deploy history with range info
  if (entry.total_deploys > 0) {
    const ranges = entry.deploys.map(d => d.price_range_pct).filter(r => r != null);
    const rangeInfo = ranges.length > 0 ? `, avg range ${(ranges.reduce((a, b) => a + b, 0) / ranges.length).toFixed(0)}%` : "";
    lines.push(`${entry.name}: ${entry.total_deploys} deploys, avg PnL ${entry.avg_pnl_pct}%, win rate ${(entry.win_rate * 100).toFixed(0)}%${rangeInfo}, last: ${entry.last_outcome}`);
  }

  // Recent trend from snapshots (last 6 = ~30 min at 5-min intervals)
  const snaps = entry.snapshots || [];
  if (snaps.length >= 2) {
    const recent = snaps.slice(-6);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const drift = ((last.pnl_pct || 0) - (first.pnl_pct || 0)).toFixed(1);
    const oorCount = recent.filter(s => !s.in_range).length;
    lines.push(`Trend (${recent.length} checks): PnL drift ${drift}%, OOR ${oorCount}/${recent.length}`);
  }

  // Latest note
  if (entry.notes?.length > 0) {
    const latest = entry.notes[entry.notes.length - 1];
    lines.push(`Note: ${latest.note}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

export function addPoolNote({ pool_address, note }) {
  if (!pool_address) return { error: "pool_address required" };
  if (!note) return { error: "note required" };

  const db = load();

  if (!db[pool_address]) {
    db[pool_address] = {
      name: pool_address.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  db[pool_address].notes.push({
    note,
    added_at: new Date().toISOString(),
  });

  save(db);
  log("pool-memory", `Note added to ${pool_address.slice(0, 8)}: ${note}`);
  return { saved: true, pool_address, note };
}
