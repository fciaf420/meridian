/**
 * Nuggets holographic memory integration.
 * Provides cross-session learning via HRR-based memory.
 */

import { NuggetShelf } from "nuggets";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAVE_DIR = path.join(__dirname, "data", "nuggets");

// Unique session ID per process — needed for nuggets hit tracking
const SESSION_ID = `session_${Date.now()}`;

let shelf = null;

/**
 * Initialize the memory system. Call once at startup.
 */
export function initMemory() {
  shelf = new NuggetShelf({ saveDir: SAVE_DIR, autoSave: true });
  shelf.loadAll();

  // Ensure core nuggets exist
  shelf.getOrCreate("pools");       // pool outcomes and patterns
  shelf.getOrCreate("strategies");  // strategy effectiveness
  shelf.getOrCreate("lessons");     // general learned lessons
  shelf.getOrCreate("patterns");    // market patterns

  log("memory", `Nuggets memory initialized (${shelf.size} nuggets loaded from ${SAVE_DIR})`);
  return shelf;
}

/**
 * Get the shelf instance (initializes if needed).
 */
export function getShelf() {
  if (!shelf) initMemory();
  return shelf;
}

/**
 * Remember a pool outcome.
 */
export function rememberPoolOutcome(poolName, result) {
  const s = getShelf();
  const key = poolName.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
  const value = typeof result === "string" ? result : JSON.stringify(result);
  s.remember("pools", key, value.slice(0, 200));
  log("memory", `Remembered pool outcome: ${key}`);
}

/**
 * Remember a strategy outcome.
 */
export function rememberStrategy(pattern, result) {
  const s = getShelf();
  const key = pattern.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
  const value = typeof result === "string" ? result : JSON.stringify(result);
  s.remember("strategies", key, value.slice(0, 200));
  log("memory", `Remembered strategy: ${key}`);
}

/** Sanitize keys the same way as write paths — strip special chars */
function sanitizeKey(str) {
  return str.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
}

/**
 * Recall relevant memories for pool screening context.
 */
export function recallForScreening(poolData) {
  const s = getShelf();
  const results = [];

  // Check if we have memory about this pool or token
  const rawName = poolData?.name || poolData?.pair;
  if (rawName) {
    const name = sanitizeKey(rawName);
    const r = s.recall(name, "pools", SESSION_ID);
    if (r.found) results.push({ source: "pools", ...r });
  }

  if (poolData?.base_token) {
    const r = s.recall(sanitizeKey(poolData.base_token), "pools", SESSION_ID);
    if (r.found && !results.some(x => x.key === r.key)) {
      results.push({ source: "pools", ...r });
    }
  }

  // Check strategy patterns by bin_step
  if (poolData?.bin_step) {
    const r = s.recall(`bid_ask_bs${poolData.bin_step}`, "strategies", SESSION_ID);
    if (r.found) results.push({ source: "strategies", ...r });
  }

  return results;
}

/**
 * Recall relevant memories for position management.
 */
export function recallForManagement(position) {
  const s = getShelf();
  const results = [];

  // Position objects have `pair` (e.g. "Gany-SOL"), not `pool_name`
  const rawKey = position?.pair || position?.pool_name;
  if (rawKey) {
    const poolKey = sanitizeKey(rawKey);
    const r = s.recall(poolKey, "pools", SESSION_ID);
    if (r.found) results.push({ source: "pools", ...r });
  }

  // Check for learned lessons about management
  const r = s.recall("management", "lessons", SESSION_ID);
  if (r.found) results.push({ source: "lessons", ...r });

  return results;
}

/**
 * Get all high-confidence memories formatted for prompt injection.
 */
export function getMemoryContext() {
  const s = getShelf();
  const lines = [];

  for (const nuggetInfo of s.list()) {
    try {
      const nugget = s.get(nuggetInfo.name);
      const facts = nugget.facts();
      // Include facts that have been recalled at least once (validated relevance)
      const relevant = facts.filter(f => f.hits >= 1);
      if (relevant.length === 0) continue;

      lines.push(`[${nuggetInfo.name}]`);
      for (const f of relevant.slice(0, 10)) { // cap at 10 per nugget
        lines.push(`  ${f.key}: ${f.value}`);
      }
    } catch {
      continue;
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Store mid-position observations during management cycles.
 * Builds up a picture of how pools behave over time.
 */
export function rememberPositionSnapshot(position) {
  const s = getShelf();
  const pair = position.pair || position.pool_name || "unknown";
  const key = pair.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);

  // Pool behavior snapshot — use configured PnL unit
  const inRange = position.in_range ? "in-range" : "OOR";
  const pnl = position.pnl_pct != null ? `${position.pnl_pct.toFixed(1)}%` : "?";
  const unit = config.management.pnlUnit || "sol";
  const useSol = unit === "sol" && position.unclaimed_fees_sol != null;
  const fees = useSol ? `${position.unclaimed_fees_sol} SOL` : (position.unclaimed_fees_usd != null ? `$${position.unclaimed_fees_usd}` : "?");
  const age = position.age_minutes != null ? `${position.age_minutes}m` : "?";

  const snapshot = `${inRange}, PnL ${pnl}, fees ${fees}, age ${age}`;
  s.remember("pools", key, snapshot);

  // Track pool patterns (volume/fee trends)
  if (position.fee_tvl_ratio != null) {
    const patternKey = `${key}_feeTvl`;
    s.getOrCreate("patterns");
    s.remember("patterns", patternKey, `fee/TVL=${position.fee_tvl_ratio} at ${new Date().toISOString().slice(11, 16)}`);
  }

  log("memory", `Snapshot stored: ${key} → ${snapshot}`);
}

/**
 * Let the LLM explicitly remember something.
 */
export function rememberFact(nuggetName, key, value) {
  const s = getShelf();
  s.getOrCreate(nuggetName);
  s.remember(nuggetName, key, value);
  log("memory", `LLM stored fact in ${nuggetName}: ${key}`);
  return { saved: true, nugget: nuggetName, key };
}

/**
 * Let the LLM query memory.
 */
export function recallMemory(query, nuggetName) {
  const s = getShelf();
  const result = s.recall(query, nuggetName || undefined, SESSION_ID);
  log("memory", `LLM recall "${query}" → ${result.found ? result.answer : "not found"}`);
  return result;
}
