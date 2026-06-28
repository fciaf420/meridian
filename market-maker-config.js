/**
 * Market Maker per-pool config store.
 *
 * Persists per-pool market-maker settings to market-maker-config.json so several
 * pools can each run with their own parameters. The stored keys are the same
 * `marketMaker` keys defined in config.js (which act as global defaults); a pool
 * entry only needs to override what differs. Mirrors the load/save pattern in
 * strategy-library.js.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MM_CONFIG_PATH = path.join(__dirname, "market-maker-config.json");

// Keys a pool entry may store: every marketMaker config key, plus a display label.
const ALLOWED_KEYS = new Set([...Object.keys(config.marketMaker || {}), "label"]);

function load() {
  if (!fs.existsSync(MM_CONFIG_PATH)) return { pools: {} };
  try {
    const data = JSON.parse(fs.readFileSync(MM_CONFIG_PATH, "utf8"));
    return data && typeof data === "object" && data.pools ? data : { pools: {} };
  } catch {
    return { pools: {} };
  }
}

function save(data) {
  fs.writeFileSync(MM_CONFIG_PATH, JSON.stringify(data, null, 2));
}

/** Filter an arbitrary object down to recognised market-maker keys. */
function pick(partial) {
  const out = {};
  for (const [k, v] of Object.entries(partial || {})) {
    if (ALLOWED_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/** Whole store: { pools: { <pool>: {...} } }. */
export function loadMmConfigs() {
  return load();
}

/** The saved overrides for one pool (null if none). */
export function getPoolConfig(pool) {
  if (!pool) return null;
  const db = load();
  return db.pools[pool] || null;
}

/** Array form for the UI/CLI: [{ pool, ...overrides }]. */
export function listPoolConfigs() {
  const db = load();
  return Object.entries(db.pools).map(([pool, cfg]) => ({ pool, ...cfg }));
}

/** Create or merge a pool's config (only recognised keys are stored). */
export function upsertPoolConfig(pool, partial = {}) {
  if (!pool) return { error: "pool address required" };
  const db = load();
  const existing = db.pools[pool] || {};
  db.pools[pool] = { ...existing, ...pick(partial), updated_at: new Date().toISOString() };
  save(db);
  log("mm_config", `Saved config for pool ${pool.slice(0, 8)}`);
  return { saved: true, pool, config: db.pools[pool] };
}

/** Remove a pool's config. */
export function removePoolConfig(pool) {
  if (!pool) return { error: "pool address required" };
  const db = load();
  if (!db.pools[pool]) return { error: `No config for pool ${pool}` };
  delete db.pools[pool];
  save(db);
  log("mm_config", `Removed config for pool ${pool.slice(0, 8)}`);
  return { removed: true, pool };
}
