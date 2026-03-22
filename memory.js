/**
 * Nuggets holographic memory integration.
 * Provides cross-session learning via HRR-based memory.
 */

import { NuggetShelf, promoteFacts } from "nuggets";
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
  shelf.getOrCreate("pools", { maxFacts: 150 });       // pool outcomes and patterns
  shelf.getOrCreate("strategies", { maxFacts: 80 });    // strategy effectiveness
  shelf.getOrCreate("lessons", { maxFacts: 100 });      // general learned lessons
  shelf.getOrCreate("patterns", { maxFacts: 80 });      // market patterns

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
    if (r.found && r.confidence >= 0.4) results.push({ source: "pools", ...r });
  }

  if (poolData?.base_token) {
    const r = s.recall(sanitizeKey(poolData.base_token), "pools", SESSION_ID);
    if (r.found && r.confidence >= 0.4 && !results.some(x => x.key === r.key)) {
      results.push({ source: "pools", ...r });
    }
  }

  // Check strategy patterns by bin_step
  if (poolData?.bin_step) {
    const r = s.recall(`bid_ask_bs${poolData.bin_step}`, "strategies", SESSION_ID);
    if (r.found && r.confidence >= 0.4) results.push({ source: "strategies", ...r });
  }

  return results;
}

/**
 * Recall relevant memories for position management.
 */
export function recallForManagement(position) {
  const s = getShelf();
  const results = [];
  const seen = new Set();

  const MIN_CONFIDENCE = 0.4;
  const addResult = (source, r) => {
    if (r.found && r.confidence >= MIN_CONFIDENCE && !seen.has(r.key)) {
      seen.add(r.key);
      results.push({ source, ...r });
    }
  };

  // 1. Pool name — direct history for this specific pool
  const rawKey = position?.pair || position?.pool_name;
  if (rawKey) {
    const poolKey = sanitizeKey(rawKey);
    addResult("pools", s.recall(poolKey, "pools", SESSION_ID));
  }

  // 2. Strategy + bin step — recalls past outcomes for this combo (e.g. "bid_ask_bs125")
  if (position?.strategy && position?.bin_step) {
    const stratKey = `${position.strategy}_bs${position.bin_step}`;
    addResult("strategies", s.recall(stratKey, "strategies", SESSION_ID));
  }

  // 3. Strategy alone — broader pattern (e.g. "bid_ask" across all bin steps)
  if (position?.strategy) {
    addResult("strategies", s.recall(position.strategy, "strategies", SESSION_ID));
  }

  // 4. Volatility range — recall patterns for similar volatility levels
  if (position?.volatility != null) {
    const volBucket = `volatility_${Math.round(position.volatility)}`;
    addResult("patterns", s.recall(volBucket, "patterns", SESSION_ID));
  }

  // 5. General management lessons
  addResult("lessons", s.recall("management", "lessons", SESSION_ID));

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
  const inRange = position.in_range ? "in-range" : `OOR-${position.oor_direction || "unknown"}`;
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

  // Track volatility patterns — builds up data for volatility-based decisions
  if (position.volatility != null) {
    const volBucket = `volatility_${Math.round(position.volatility)}`;
    s.getOrCreate("patterns");
    s.remember("patterns", volBucket, `${pair} ${inRange} at vol=${position.volatility}, PnL ${pnl}`);
  }

  // Track strategy+bin_step performance snapshots
  if (position.strategy && position.bin_step) {
    const stratKey = `${position.strategy}_bs${position.bin_step}`;
    s.remember("strategies", stratKey, `${pair} ${inRange}, PnL ${pnl}, age ${age}`);
  }

  log("memory", `Snapshot stored: ${key} → ${snapshot}`);
}

/**
 * Clean up transient nugget entries when a position closes.
 * Removes the mid-position snapshot and pattern entries that are no longer relevant.
 * Pool outcomes and strategy lessons are kept (they inform future decisions).
 */
export function forgetPositionSnapshot(position) {
  const s = getShelf();
  const pair = position?.pair || position?.pool_name;
  if (!pair) return;
  const key = pair.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);

  // Remove transient snapshot (the "in-range, PnL X%" entry)
  // Pool outcomes stored by rememberPoolOutcome are different keys and kept
  try { s.forget("patterns", `${key}_feeTvl`); } catch { /* ignore */ }

  log("memory", `Cleaned up transient snapshot for ${key}`);
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

/**
 * Let the LLM forget a fact from memory.
 */
export function forgetFact(nuggetName, key) {
  const s = getShelf();
  try {
    const nugget = s.get(nuggetName);
    nugget.forget(key);
    log("memory", `LLM forgot fact in ${nuggetName}: ${key}`);
    return { forgotten: true, nugget: nuggetName, key };
  } catch (e) {
    log("memory", `Failed to forget ${nuggetName}/${key}: ${e.message}`);
    return { forgotten: false, error: e.message };
  }
}

/**
 * Promote high-hit facts to MEMORY.md for permanent context.
 * Call periodically (e.g. after each management cycle).
 */
export function maybePromote() {
  const s = getShelf();
  try {
    const promoted = promoteFacts(s);
    if (promoted > 0) {
      log("memory", `Promoted ${promoted} facts to MEMORY.md`);
    }
    return promoted;
  } catch (e) {
    log("memory", `Promotion failed: ${e.message}`);
    return 0;
  }
}

/**
 * Log capacity warnings for any nuggets approaching their limits.
 */
export function checkCapacity() {
  const s = getShelf();
  for (const info of s.list()) {
    try {
      const nugget = s.get(info.name);
      const st = nugget.status();
      if (st.capacity_used_pct > 70) {
        log("memory", `WARNING: ${info.name} nugget at ${st.capacity_used_pct}% capacity (${st.fact_count} facts)`);
      }
    } catch { continue; }
  }
}
