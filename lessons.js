/**
 * Agent learning system.
 *
 * After each position closes, performance is analyzed and lessons are
 * derived. These lessons are injected into the system prompt so the
 * agent avoids repeating mistakes and doubles down on what works.
 */

import fs from "fs";
import { log } from "./logger.js";
import { config, reloadScreeningThresholds, USER_CONFIG_PATH } from "./config.js";
import { recordPoolDeploy } from "./pool-memory.js";
import { recalculateWeights } from "./signal-weights.js";
import { filePositionClose } from "./knowledge-base.js";
import {
  classifyRecord,
  exclusionReason,
  isExcludedLesson,
  learnableRecords,
  recordPnlPct,
} from "./learning-data.js";

const LESSONS_FILE = "./lessons.json";
const MIN_EVOLVE_POSITIONS = 5;   // don't evolve until we have real data
const LESSON_STRONG_PCT    = 5;   // |PnL| a win/loss needs before it becomes a lesson rule
const MAX_CHANGE_PER_STEP  = 0.20; // never shift a threshold more than 20% at once

/** Read user-config.json once — shared across evolution passes to avoid double reads. */
function readUserConfig() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { return {}; }
}

/** Write user-config.json — called once after all evolution passes complete. */
function writeUserConfig(userConfig) {
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));
}

// Set when the persisted lessons file is present but unparseable. While
// degraded we refuse to overwrite the (recoverable) bad file with defaults.
let _lessonsDegraded = false;

function load() {
  if (!fs.existsSync(LESSONS_FILE)) {
    // File absent — safe to create fresh defaults.
    return { lessons: [], performance: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
  } catch (err) {
    // File PRESENT but corrupt: do NOT silently fall back to empty defaults
    // (a later save() would wipe real history). Preserve the bad file for
    // recovery and enter a degraded, read-only state.
    if (!_lessonsDegraded) {
      try {
        const backup = `${LESSONS_FILE}.corrupt-${Date.now()}`;
        fs.copyFileSync(LESSONS_FILE, backup);
        log("lessons_error", `lessons.json is corrupt (${err.message}); preserved as ${backup}. Refusing to overwrite until recovered.`);
      } catch (backupErr) {
        log("lessons_error", `lessons.json is corrupt (${err.message}) and backup failed: ${backupErr.message}. Refusing to overwrite until recovered.`);
      }
    }
    _lessonsDegraded = true;
    throw new Error(`lessons.json is corrupt and was preserved for recovery: ${err.message}`);
  }
}

function save(data) {
  // Never persist over a corrupt-but-present file; that would destroy
  // recoverable history. Skip saves until the file is restored.
  if (_lessonsDegraded) {
    log("lessons_error", "Skipping lessons.json save: file is in degraded (corrupt) state. Restore or remove the corrupt backup to re-enable saves.");
    return;
  }
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
}

// ─── Record Position Performance ──────────────────────────────

/**
 * Call this when a position closes. Captures performance data and
 * derives a lesson if the outcome was notably good or bad.
 *
 * @param {Object} perf
 * @param {string} perf.position       - Position address
 * @param {string} perf.pool           - Pool address
 * @param {string} perf.pool_name      - Pool name (e.g. "Mustard-SOL")
 * @param {string} perf.strategy       - "spot" | "curve" | "bid_ask"
 * @param {number} [perf.sol_split_pct]  - SOL split % (100=single-sided, <100=two-sided spot)
 * @param {number} perf.bin_range      - Bin range used
 * @param {number} perf.bin_step       - Pool bin step
 * @param {number} perf.volatility     - Pool volatility at deploy time
 * @param {number} perf.fee_tvl_ratio  - fee/TVL ratio at deploy time
 * @param {number} perf.organic_score  - Token organic score at deploy time
 * @param {number} perf.amount_sol     - Amount deployed
 * @param {number} perf.fees_earned_usd - Total fees earned
 * @param {number} perf.final_value_usd - Value when closed
 * @param {number} perf.initial_value_usd - Value when opened
 * @param {number} perf.minutes_in_range  - Total minutes position was in range
 * @param {number} perf.minutes_held      - Total minutes position was held
 * @param {string} perf.close_reason   - Why it was closed
 */
export async function recordPerformance(perf) {
  const data = load();

  // Use actual API PnL when available, fall back to calculation
  const pnl_usd = perf.actual_pnl_usd != null
    ? perf.actual_pnl_usd
    : (perf.final_value_usd + perf.fees_earned_usd) - perf.initial_value_usd;
  const pnl_pct = perf.actual_pnl_pct != null
    ? perf.actual_pnl_pct
    : (perf.initial_value_usd > 0 ? (pnl_usd / perf.initial_value_usd) * 100 : 0);
  const range_efficiency = perf.minutes_held > 0
    ? (perf.minutes_in_range / perf.minutes_held) * 100
    : 0;
  // PnL unknown at close (PR #9 flag): the close path records a placeholder 0
  // when it could not derive PnL. When it left actual_pnl_pct null, the value
  // above was derived from final vs initial value and is a real measurement.
  const pnlUnknown = perf.pnl_unknown === true && perf.actual_pnl_pct != null;

  const entry = {
    ...perf,
    pnl_usd: Math.round(pnl_usd * 100) / 100,
    pnl_pct: Math.round(pnl_pct * 100) / 100,
    range_efficiency: Math.round(range_efficiency * 10) / 10,
    pnl_unknown: pnlUnknown || undefined,
    ...(perf.pnl_unknown === true && !pnlUnknown && { pnl_derived: true }),
    recorded_at: new Date().toISOString(),
  };

  data.performance.push(entry);

  // Derive and store a lesson (with deduplication). A record excluded from
  // learning (learning-data.js) teaches nothing.
  const excluded = exclusionReason(entry);
  if (excluded) log("lessons", `Close ${entry.position?.slice?.(0, 8) ?? "?"} excluded from learning: ${excluded}`);
  const lesson = excluded ? null : derivLesson(entry);
  if (lesson) {
    const dupeIdx = findDuplicate(data.lessons, lesson);
    if (dupeIdx >= 0) {
      // Update existing lesson with fresh data instead of creating duplicate
      const existing = data.lessons[dupeIdx];
      existing.rule = lesson.rule;
      existing.pnl_pct = lesson.pnl_pct;
      existing.range_efficiency = lesson.range_efficiency;
      existing.pool = lesson.pool;
      existing.context = lesson.context;
      existing.created_at = lesson.created_at; // refresh timestamp
      existing.update_count = (existing.update_count || 1) + 1;
      log("lessons", `Updated existing lesson (${existing.update_count}x): ${lesson.rule}`);
    } else {
      data.lessons.push(lesson);
      log("lessons", `New lesson: ${lesson.rule}`);
    }
  }

  save(data);

  // Update pool-level memory
  if (perf.pool) {
    try {
      // Calculate price_range_pct from bin_range if available
      let deployRangePct = null;
      if (perf.bin_range && perf.bin_step) {
        const bins = typeof perf.bin_range === "object"
          ? (perf.bin_range.bins_below || 0) + (perf.bin_range.bins_above || 0)
          : perf.bin_range;
        if (bins > 0) {
          const stepPct = perf.bin_step / 10000;
          deployRangePct = Math.round((1 - Math.pow(1 + stepPct, -bins)) * 1000) / 10;
        }
      }
      recordPoolDeploy(perf.pool, {
        pool_name: perf.pool_name,
        base_mint: perf.base_mint,
        deployed_at: perf.deployed_at,
        closed_at: entry.recorded_at,
        pnl_pct: pnlUnknown ? null : entry.pnl_pct,
        pnl_usd: pnlUnknown ? null : entry.pnl_usd,
        range_efficiency: entry.range_efficiency,
        minutes_held: perf.minutes_held,
        close_reason: perf.close_reason,
        strategy: perf.strategy,
        sol_split_pct: perf.sol_split_pct ?? null,
        volatility: perf.volatility,
        price_range_pct: deployRangePct,
        ...(excluded && { exclude_from_learning: excluded }),
      });
    } catch (e) {
      log("pool-memory", `Failed to record pool deploy: ${e.message}`);
    }
  }

  // File position close to knowledge base (direct write, no LLM)
  try {
    filePositionClose({ ...perf, pnl_pct: pnlUnknown ? null : pnl_pct, pnl_unknown: pnlUnknown, minutes_in_range: perf.minutes_in_range });
  } catch (e) {
    log("kb", `Failed to file position close to KB: ${e.message}`);
  }

  // Evolve thresholds every 5 closed positions (compare against stored counter, not modulo)
  {
    const lastEvolvedAt = readUserConfig()._positionsAtEvolution || 0;
    if (data.performance.length - lastEvolvedAt >= MIN_EVOLVE_POSITIONS) {
      // Single read of user-config.json shared by both evolution passes
      let userConfig = readUserConfig();

      const result = evolveThresholds(data.performance, config, { userConfig, lessonsData: data });
      if (result?.changes && Object.keys(result.changes).length > 0) {
        userConfig = result.userConfig; // carry forward mutations
        log("evolve", `Auto-evolved thresholds: ${JSON.stringify(result.changes)}`);
      }
      // Also evolve from lessons (reuses same userConfig + data)
      const lessonResult = evolveFromLessons(data.lessons || [], config, { userConfig, lessonsData: data });
      if (lessonResult?.changes && Object.keys(lessonResult.changes).length > 0) {
        userConfig = lessonResult.userConfig;
        log("evolve", `Lesson-based evolution: ${JSON.stringify(lessonResult.changes)}`);
      }

      // Single reload covers both passes
      if ((result?.changes && Object.keys(result.changes).length > 0) ||
          (lessonResult?.changes && Object.keys(lessonResult.changes).length > 0)) {
        reloadScreeningThresholds();
      }

      // Recalculate Darwinian signal weights alongside threshold evolution
      if (config.darwin?.enabled) {
        try {
          recalculateWeights(data.performance, config);
        } catch (e) {
          log("darwin", `Signal weight recalc failed: ${e.message}`);
        }
      }
    }
  }

  // Autoresearch: evaluate or start an experiment. Fire-and-forget: the close
  // path (and pnl-watcher's sequential stop-loss closes) must never wait on an
  // LLM. autoresearch.js serializes itself and times out its own calls.
  if (config.autoresearch?.enabled) {
    const perfSnapshot = data.performance.slice();
    const lessonsSnapshot = (data.lessons || []).slice();
    import("./autoresearch.js")
      .then(({ maybeRunAutoresearch }) => maybeRunAutoresearch(perfSnapshot, lessonsSnapshot, config))
      .catch((e) => log("autoresearch", `Error: ${e.message}`));
  }
}

/**
 * Derive a lesson from a closed position's performance.
 * Only generates a lesson if the outcome was clearly good or bad.
 */
function derivLesson(perf) {
  if (perf.pnl_unknown) return null; // placeholder 0% PnL: not an outcome to learn from
  const tags = [];

  // Categorize outcome with the shared classifier (learning-data.js): only a
  // win (> +1%) or a loss (< −1%) can teach, and a lesson rule needs a clear
  // one (±LESSON_STRONG_PCT). Break-even closes never become WORKED/PREFER.
  const cls = classifyRecord(perf);
  if (cls !== "win" && cls !== "loss") return null;
  if (Math.abs(recordPnlPct(perf)) < LESSON_STRONG_PCT) return null; // not clear enough to be a rule
  const outcome = cls === "win" ? "good" : "bad";

  // Parse OOR direction from close_reason (e.g. "agent decision (OOR upside)")
  const oorDir = perf.close_reason?.match(/OOR (upside|downside)/)?.[1] || null;

  // Build context description
  const context = [
    `${perf.pool_name}`,
    `strategy=${perf.strategy}`,
    `bin_step=${perf.bin_step}`,
    `volatility=${perf.volatility}`,
    `fee_tvl_ratio=${perf.fee_tvl_ratio}`,
    `organic=${perf.organic_score}`,
    `bin_range=${typeof perf.bin_range === 'object' ? JSON.stringify(perf.bin_range) : perf.bin_range}`,
    perf.sol_split_pct != null ? `sol_split_pct=${perf.sol_split_pct}` : null,
  ].filter(Boolean).join(", ");

  let rule = "";
  const isTwoSided = perf.sol_split_pct != null && perf.sol_split_pct < 100;

  if (outcome === "good" || outcome === "bad") {
    if (perf.range_efficiency < 30 && outcome === "bad") {
      const isSingleSidedBelow = perf.strategy === "bid_ask" || (perf.strategy === "spot" && !isTwoSided);
      const dirHint = oorDir === "downside"
        ? " Price dropped below range (downside OOR) — SOL converted to token, realized loss. Wider range may help catch deeper dips."
        : oorDir === "upside" && isSingleSidedBelow
        ? " Price pumped above range (upside OOR) — wider range will NOT fix this since bid_ask/SOL-only liquidity only extends downward. Token is pumping away from position. Consider: waiting for pump to end before deploying, using two-sided spot with token exposure, or skipping this pool."
        : oorDir === "upside"
        ? " Price rose above range (upside OOR) — SOL sat idle, missed fees but no IL."
        : "";
      rule = `AVOID: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — went OOR ${100 - perf.range_efficiency}% of the time.${dirHint}`;
      tags.push("oor", oorDir || "unknown", perf.strategy, `volatility_${Math.round(perf.volatility)}`);
      if (isTwoSided) tags.push("two-sided", `split_${perf.sol_split_pct}`);
    } else if (perf.range_efficiency > 80 && outcome === "good") {
      const splitNote = isTwoSided ? ` (two-sided, sol_split=${perf.sol_split_pct}%)` : "";
      rule = `PREFER: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}"${splitNote} — ${perf.range_efficiency}% in-range efficiency, PnL +${perf.pnl_pct}%.`;
      tags.push("efficient", perf.strategy);
    } else if (outcome === "bad" && perf.close_reason?.includes("volume")) {
      rule = `AVOID: Pools with fee_tvl_ratio=${perf.fee_tvl_ratio} that showed volume collapse — fees evaporated quickly. Minimum sustained volume check needed before deploying.`;
      tags.push("volume_collapse");
    } else if (outcome === "good") {
      rule = `WORKED: ${context} → PnL +${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%.`;
      tags.push("worked");
    } else {
      rule = `FAILED: ${context} → PnL ${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%. Reason: ${perf.close_reason}.`;
      tags.push("failed");
    }
  }

  if (!rule) return null;

  return {
    id: Date.now(),
    rule,
    tags,
    outcome,
    context,
    pnl_pct: perf.pnl_pct,
    range_efficiency: perf.range_efficiency,
    pool: perf.pool,
    created_at: new Date().toISOString(),
  };
}

// ─── Adaptive Threshold Evolution ──────────────────────────────

/**
 * Analyze closed position performance and evolve screening thresholds.
 * Writes changes to user-config.json and returns a summary.
 *
 * @param {Array}  perfData - Array of performance records (from lessons.json)
 * @param {Object} config   - Live config object (mutated in place)
 * @param {Object} [opts]   - Optional shared state to avoid redundant file I/O
 * @param {Object} [opts.userConfig] - Pre-read user-config.json (will be mutated + written)
 * @param {Object} [opts.lessonsData] - Pre-loaded lessons.json data (avoids extra load/save)
 * @returns {{ changes: Object, rationale: Object, userConfig: Object } | null}
 */
export const OHLCV_BUFFER_MIN = 1.0;
export const OHLCV_BUFFER_MAX = 1.8;
export const OHLCV_BUFFER_STEP = 0.1;
const OHLCV_BUFFER_MIN_CLOSES = 5;

/**
 * Evolve strategy.ohlcvBufferMult (candle range depth = drawdown × buffer) from
 * how positions deployed with the CURRENT buffer ended:
 *  - downside OOR or stop-loss closes >= 40% → +0.1 (ranges too shallow)
 *  - those <= 20% and the median depth actually used < 50% → -0.1 (unused depth)
 * Upside OOR is ignored: depth below the price cannot fix a pump. One step per
 * evolution, clamped to 1.0–1.8. Returns { value, rationale } or null.
 */
export function evolveOhlcvBuffer(perfData, config) {
  if (config?.strategy?.rangeDepthMode !== "ohlcv") return null;
  const current = Number(config.strategy.ohlcvBufferMult ?? 1.3);
  if (!Number.isFinite(current)) return null;
  // Only closes deployed with the current buffer count as evidence for moving it.
  const sample = (perfData || []).filter((p) =>
    p.range_depth_mode === "ohlcv" && Number(p.ohlcv_buffer_mult) === current);
  if (sample.length < OHLCV_BUFFER_MIN_CLOSES) return null;

  const adverse = sample.filter((p) => p.oor_direction_at_close === "downside" || p.stop_loss_close === true);
  const adverseRate = adverse.length / sample.length;
  const used = sample.map((p) => p.deepest_bin_reached_pct).filter(isFiniteNum);
  const medianUsed = used.length >= 3 ? percentile(used, 50) : null;

  let next = current;
  let why = null;
  if (adverseRate >= 0.4) {
    next = current + OHLCV_BUFFER_STEP;
    why = `${adverse.length}/${sample.length} closes at buffer ${current} were downside OOR or stop loss — ranges too shallow`;
  } else if (adverseRate <= 0.2 && medianUsed != null && medianUsed < 50) {
    next = current - OHLCV_BUFFER_STEP;
    why = `only ${adverse.length}/${sample.length} downside/stop-loss closes and median depth used ${medianUsed.toFixed(0)}% — ranges deeper than needed`;
  }
  next = Number(clamp(next, OHLCV_BUFFER_MIN, OHLCV_BUFFER_MAX).toFixed(1));
  if (next === current || !why) return null;
  return { value: next, rationale: `${why}: ohlcvBufferMult ${current} → ${next}` };
}

// ─── Trailing take-profit evolution ─────────────────────────────

export const TRAILING_TRIGGER_BOUNDS = { min: 1.5, max: 15, step: 0.5 };
export const TRAILING_DROP_BOUNDS    = { min: 1.0, max: 8,  step: 0.5 };
const TRAILING_MIN_CLOSES = 5;   // relevant closes since the parameter last changed
const TRAILING_MIN_EXITS  = 3;   // trailing exits needed by the raise-trigger / widen-drop rules
const TRAILING_MIN_GAP    = 0.5; // keep trigger − drop ≥ 0.5 so the trail level stays above break-even

const isTrailingExit = (p) => p.trailing_exit === true || /TRAILING_TP/i.test(String(p.close_reason || ""));
const median = (arr) => percentile(arr, 50);
const step1 = (n) => Number(n.toFixed(1));

/**
 * Evolve management.trailingTriggerPct / trailingDropPct — the only exit
 * settings evolution touches — from closes whose peak PnL is known
 * (peak_pnl_pct, persisted at close by state.js trailingAtClose).
 *
 * A close is evidence for a parameter only if it ran under the current value
 * of that parameter (trailing_trigger_pct / trailing_drop_pct on the record),
 * so "≥ 5 relevant closes" counts closes since the parameter last changed.
 * One 0.5 step per parameter per run. Wins/non-wins use the shared classifier.
 *
 * Trigger (1.5–15):
 *   lower  when ≥ 40% of non-winning closes (PnL ≤ +1%) peaked at
 *          ≥ 0.5 × trigger but < trigger: profits that were never protected.
 *   raise  when most (> 50%, ≥ 3) trailing exits closed within 1pt of the
 *          PnL where trailing armed: the trail is too twitchy.
 * Drop (1–8):
 *   tighten when trailing exits give back more than the peak: median exit
 *           PnL < 0, or median give-back (peak − exit) ≥ drop + 2.
 *   widen   when ≥ 60% (≥ 3) of trailing exits still closed above +2% while
 *           in range and earning fees: they were cut early.
 * Conflicting rules for one parameter cancel out. trigger − drop ≥ 0.5 is
 * kept where the current values allow it, and the trigger is not raised to
 * the fixed take profit or above.
 *
 * Returns { changes, rationale } or null.
 */
export function evolveTrailing(perfData, config) {
  const m = config?.management || {};
  if (!m.trailingTakeProfit) return null;
  const trigger = Number(m.trailingTriggerPct);
  const drop = Number(m.trailingDropPct);
  if (!Number.isFinite(trigger) || !Number.isFinite(drop)) return null;

  const known = learnableRecords(perfData).filter((p) =>
    isFiniteNum(p.peak_pnl_pct) && classifyRecord(p) != null);
  const changes = {};
  const rationale = {};
  let newTrigger = trigger;
  let newDrop = drop;

  // ── trailingTriggerPct ──
  const relT = known.filter((p) => Number(p.trailing_trigger_pct) === trigger);
  if (relT.length >= TRAILING_MIN_CLOSES) {
    const nonWinners = relT.filter((p) => classifyRecord(p) !== "win");
    const unprotected = nonWinners.filter((p) => p.peak_pnl_pct >= 0.5 * trigger && p.peak_pnl_pct < trigger);
    const lower = nonWinners.length > 0 && unprotected.length / nonWinners.length >= 0.4;

    const exits = relT.filter(isTrailingExit);
    const armLevel = (p) => (isFiniteNum(p.trailing_armed_pct) ? p.trailing_armed_pct : trigger);
    const twitchy = exits.filter((p) => Math.abs(recordPnlPct(p) - armLevel(p)) <= 1);
    const raise = exits.length >= TRAILING_MIN_EXITS && twitchy.length / exits.length > 0.5;

    if (lower && !raise) {
      newTrigger = step1(clamp(trigger - TRAILING_TRIGGER_BOUNDS.step, TRAILING_TRIGGER_BOUNDS.min, TRAILING_TRIGGER_BOUNDS.max));
      if (newTrigger < trigger) {
        const peaks = unprotected.map((p) => p.peak_pnl_pct.toFixed(2)).join(", ");
        rationale.trailingTriggerPct = `${unprotected.length}/${nonWinners.length} non-winning closes peaked between ${step1(0.5 * trigger)}% and the ${trigger}% trigger (peaks ${peaks}%) — profits never protected: lowered trigger ${trigger}% → ${newTrigger}%`;
      }
    } else if (raise && !lower) {
      newTrigger = step1(clamp(trigger + TRAILING_TRIGGER_BOUNDS.step, TRAILING_TRIGGER_BOUNDS.min, TRAILING_TRIGGER_BOUNDS.max));
      const tp = Number(m.takeProfitFeePct);
      if (Number.isFinite(tp) && tp > 0 && newTrigger >= tp) newTrigger = trigger; // fixed TP would fire first
      if (newTrigger > trigger) {
        rationale.trailingTriggerPct = `${twitchy.length}/${exits.length} trailing exits closed within 1pt of where trailing armed — too twitchy: raised trigger ${trigger}% → ${newTrigger}%`;
      }
    }
  }

  // ── trailingDropPct ──
  const relD = known.filter((p) => Number(p.trailing_drop_pct) === drop);
  if (relD.length >= TRAILING_MIN_CLOSES) {
    const exits = relD.filter(isTrailingExit);
    const exitPnls = exits.map(recordPnlPct);
    const giveBacks = exits.map((p) => p.peak_pnl_pct - recordPnlPct(p));
    const medExit = exits.length ? median(exitPnls) : null;
    const medGive = exits.length ? median(giveBacks) : null;
    const tighten = exits.length > 0 && (medExit < 0 || medGive >= drop + 2);

    const cutEarly = exits.filter((p) => recordPnlPct(p) > 2 && p.in_range_at_close === true && Number(p.fees_earned_usd) > 0);
    const widen = exits.length >= TRAILING_MIN_EXITS && cutEarly.length / exits.length >= 0.6;

    if (tighten) {
      newDrop = step1(clamp(drop - TRAILING_DROP_BOUNDS.step, TRAILING_DROP_BOUNDS.min, TRAILING_DROP_BOUNDS.max));
      if (newDrop < drop) {
        rationale.trailingDropPct = `${exits.length} trailing exit(s): median exit ${medExit.toFixed(2)}%, median give-back ${medGive.toFixed(2)}pt from peak (drop ${drop}) — gave back too much: tightened drop ${drop}% → ${newDrop}%`;
      }
    } else if (widen) {
      newDrop = step1(clamp(drop + TRAILING_DROP_BOUNDS.step, TRAILING_DROP_BOUNDS.min, TRAILING_DROP_BOUNDS.max));
      if (newDrop > drop) {
        rationale.trailingDropPct = `${cutEarly.length}/${exits.length} trailing exits closed above +2% while in range and earning fees — cut early: widened drop ${drop}% → ${newDrop}%`;
      }
    }
  }

  // ── Keep trigger − drop ≥ 0.5 where possible ──
  if (newDrop > drop && newTrigger - newDrop < TRAILING_MIN_GAP) {
    newDrop = step1(Math.max(drop, newTrigger - TRAILING_MIN_GAP));
    if (newDrop <= drop) { newDrop = drop; delete rationale.trailingDropPct; }
  }
  if (newTrigger < trigger && newTrigger - newDrop < TRAILING_MIN_GAP) {
    newTrigger = step1(Math.min(trigger, newDrop + TRAILING_MIN_GAP));
    if (newTrigger >= trigger) { newTrigger = trigger; delete rationale.trailingTriggerPct; }
  }

  if (newTrigger !== trigger && rationale.trailingTriggerPct) changes.trailingTriggerPct = newTrigger;
  if (newDrop !== drop && rationale.trailingDropPct) changes.trailingDropPct = newDrop;
  if (!Object.keys(changes).length) return null;
  return { changes, rationale };
}

export function evolveThresholds(perfData, config, { userConfig, lessonsData } = {}) {
  const computed = computeThresholdChanges(perfData, config);
  if (!computed) return null;
  const { changes, rationale } = computed;
  return persistThresholdChanges(perfData, config, changes, rationale, { userConfig, lessonsData });
}

/**
 * The threshold changes evolution would make from these performance records,
 * without writing anything. Null when there is too little data.
 *
 * Wins and losses come from the shared classifier (learning-data.js): > +1% is
 * a winner, < −1% a loser, and break-even closes are neither. Records excluded
 * from learning (known-bad, corrupt, corrected) are dropped first.
 *
 * takeProfitFeePct and stopLossPct are the operator's and are never evolved.
 */
export function computeThresholdChanges(perfData, config) {
  const learnable = learnableRecords(perfData);
  if (learnable.length < MIN_EVOLVE_POSITIONS) return null;

  const winners = learnable.filter((p) => classifyRecord(p) === "win");
  const losers  = learnable.filter((p) => classifyRecord(p) === "loss");

  // The depth buffer and the trailing TP learn from how positions ended, not
  // from the win/loss split below, so they are evaluated even when it is thin.
  const bufferEvo = evolveOhlcvBuffer(learnable, config);
  const trailingEvo = evolveTrailing(learnable, config);

  // Need at least some signal in both directions before adjusting
  const hasSignal = winners.length >= 2 || losers.length >= 2;
  if (!hasSignal && !bufferEvo && !trailingEvo) return null;

  const changes   = {};
  const rationale = {};
  if (bufferEvo) {
    changes.ohlcvBufferMult = bufferEvo.value;
    rationale.ohlcvBufferMult = bufferEvo.rationale;
  }
  if (trailingEvo) {
    Object.assign(changes, trailingEvo.changes);
    Object.assign(rationale, trailingEvo.rationale);
  }
  if (!hasSignal) return { changes, rationale };

  // ── 1. maxVolatility ─────────────────────────────────────────
  // If losers tend to cluster at higher volatility → tighten the ceiling.
  // If winners span higher volatility safely → we can loosen a bit.
  {
    const winnerVols = winners.map((p) => p.volatility).filter(isFiniteNum);
    const loserVols  = losers.map((p) => p.volatility).filter(isFiniteNum);
    const current    = config.screening.maxVolatility;

    if (loserVols.length >= 2) {
      // 25th percentile of loser volatilities — this is where things start going wrong
      const loserP25 = percentile(loserVols, 25);
      if (loserP25 < current) {
        // Tighten: new ceiling = loserP25 + a small buffer
        const target  = loserP25 * 1.15;
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 1.0, 20.0);
        const rounded = Number(newVal.toFixed(1));
        if (rounded < current) {
          changes.maxVolatility = rounded;
          rationale.maxVolatility = `Losers clustered at volatility ~${loserP25.toFixed(1)} — tightened from ${current} → ${rounded}`;
        }
      }
    } else if (winnerVols.length >= 3 && losers.length === 0) {
      // All winners so far — loosen conservatively so we don't miss good pools
      const winnerP75 = percentile(winnerVols, 75);
      if (winnerP75 > current * 1.1) {
        const target  = winnerP75 * 1.1;
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 1.0, 20.0);
        const rounded = Number(newVal.toFixed(1));
        if (rounded > current) {
          changes.maxVolatility = rounded;
          rationale.maxVolatility = `All ${winners.length} positions profitable — loosened from ${current} → ${rounded}`;
        }
      }
    }
  }

  // ── 2. minFeeActiveTvlRatio ───────────────────────────────────
  // Raise the floor if low-fee pools consistently underperform.
  {
    const winnerFees = winners.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const loserFees  = losers.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const current    = config.screening.minFeeActiveTvlRatio;

    if (winnerFees.length >= 2) {
      // Minimum fee/TVL among winners — we know pools below this don't work for us
      const minWinnerFee = Math.min(...winnerFees);
      if (minWinnerFee > current * 1.2) {
        const target  = minWinnerFee * 0.85; // stay slightly below min winner
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
        const rounded = Number(newVal.toFixed(2));
        if (rounded > current) {
          changes.minFeeActiveTvlRatio = rounded;
          rationale.minFeeActiveTvlRatio = `Lowest winner fee_tvl=${minWinnerFee.toFixed(2)} — raised floor from ${current} → ${rounded}`;
        }
      }
    }

    if (loserFees.length >= 2) {
      // If losers all had high fee/TVL, that's noise (pumps then crash) — don't raise min
      // But if losers had low fee/TVL, raise min
      const maxLoserFee = Math.max(...loserFees);
      if (maxLoserFee < current * 1.5 && winnerFees.length > 0) {
        const minWinnerFee = Math.min(...winnerFees);
        if (minWinnerFee > maxLoserFee) {
          const target  = maxLoserFee * 1.2;
          const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 10.0);
          const rounded = Number(newVal.toFixed(2));
          if (rounded > current && !changes.minFeeActiveTvlRatio) {
            changes.minFeeActiveTvlRatio = rounded;
            rationale.minFeeActiveTvlRatio = `Losers had fee_tvl<=${maxLoserFee.toFixed(2)}, winners higher — raised floor from ${current} → ${rounded}`;
          }
        }
      }
    }
  }

  // ── 3. minOrganic ─────────────────────────────────────────────
  // Raise organic floor if low-organic tokens consistently failed.
  {
    const loserOrganics  = losers.map((p) => p.organic_score).filter(isFiniteNum);
    const winnerOrganics = winners.map((p) => p.organic_score).filter(isFiniteNum);
    const current        = config.screening.minOrganic;

    if (loserOrganics.length >= 2 && winnerOrganics.length >= 1) {
      const avgLoserOrganic  = avg(loserOrganics);
      const avgWinnerOrganic = avg(winnerOrganics);
      // Only raise if there's a clear gap (winners consistently more organic)
      if (avgWinnerOrganic - avgLoserOrganic >= 10) {
        // Set floor just below worst winner
        const minWinnerOrganic = Math.min(...winnerOrganics);
        const target = Math.max(minWinnerOrganic - 3, current);
        const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 60, 90);
        if (newVal > current) {
          changes.minOrganic = newVal;
          rationale.minOrganic = `Winner avg organic ${avgWinnerOrganic.toFixed(0)} vs loser avg ${avgLoserOrganic.toFixed(0)} — raised from ${current} → ${newVal}`;
        }
      }
    }
  }

  // (stopLossPct and takeProfitFeePct are not evolved: they are the operator's.)

  // ── 6. minBinStep / maxBinStep ─────────────────────────────────
  {
    const winnerBinSteps = winners.map(p => p.bin_step).filter(isFiniteNum);
    const loserBinSteps = losers.map(p => p.bin_step).filter(isFiniteNum);
    const currentMin = config.screening.minBinStep ?? 1;
    const currentMax = config.screening.maxBinStep ?? 200;

    if (loserBinSteps.length >= 2 && winnerBinSteps.length >= 2) {
      const loserP25 = percentile(loserBinSteps, 25);
      const winnerMin = Math.min(...winnerBinSteps);
      const winnerMax = Math.max(...winnerBinSteps);
      // Tighten min if losers cluster at low bin steps
      if (loserP25 < winnerMin && winnerMin > currentMin) {
        const newMin = clamp(Math.round(nudge(currentMin, winnerMin - 5, MAX_CHANGE_PER_STEP)), 1, 200);
        if (newMin > currentMin) {
          changes.minBinStep = newMin;
          rationale.minBinStep = `Losers at bin_step ~${loserP25}, winners start at ${winnerMin} — raised min from ${currentMin} → ${newMin}`;
        }
      }
      // Tighten max if losers cluster at high bin steps
      const loserP75 = percentile(loserBinSteps, 75);
      if (loserP75 > winnerMax && winnerMax < currentMax) {
        const newMax = clamp(Math.round(nudge(currentMax, winnerMax + 5, MAX_CHANGE_PER_STEP)), 50, 500);
        if (newMax < currentMax) {
          changes.maxBinStep = newMax;
          rationale.maxBinStep = `Losers at bin_step ~${loserP75}, winners cap at ${winnerMax} — lowered max from ${currentMax} → ${newMax}`;
        }
      }
    }
  }

  // ── 7. outOfRangeWaitMinutes ───────────────────────────────────
  {
    const current = config.management.outOfRangeWaitMinutes ?? 10;
    const oorDownLosers = losers.filter(p => p.close_reason?.includes("OOR downside"));
    const oorUpWinners = winners.filter(p => p.close_reason?.includes("OOR upside"));

    // If downside OOR losers waited too long → shorten wait
    if (oorDownLosers.length >= 2) {
      const avgHeld = avg(oorDownLosers.map(p => p.minutes_held).filter(isFiniteNum));
      if (avgHeld > current * 1.5) {
        const newVal = clamp(Math.round(nudge(current, current * 0.8, MAX_CHANGE_PER_STEP)), 3, 30);
        if (newVal < current) {
          changes.outOfRangeWaitMinutes = newVal;
          rationale.outOfRangeWaitMinutes = `Downside OOR losers held avg ${avgHeld.toFixed(0)}m — shortened wait from ${current}m → ${newVal}m`;
        }
      }
    }
    // If upside OOR positions recovered and won → lengthen wait
    if (oorUpWinners.length >= 2 && oorDownLosers.length === 0) {
      const newVal = clamp(Math.round(nudge(current, current * 1.2, MAX_CHANGE_PER_STEP)), 3, 30);
      if (newVal > current) {
        changes.outOfRangeWaitMinutes = newVal;
        rationale.outOfRangeWaitMinutes = `Upside OOR positions recovered — extended wait from ${current}m → ${newVal}m`;
      }
    }
  }

  // ── 8. athTopThresholdPct ─────────────────────────────────────
  // If positions opened near ATH consistently lose → lower threshold (stricter)
  // If positions near ATH consistently win → raise threshold (more permissive)
  {
    const current = config.screening.athTopThresholdPct ?? 90;
    const winnersNearAth = winners.filter(p => {
      const ath = p.signal_snapshot?.ath_proximity;
      return ath != null && ath >= current;
    });
    const losersNearAth = losers.filter(p => {
      const ath = p.signal_snapshot?.ath_proximity;
      return ath != null && ath >= current;
    });

    if (losersNearAth.length >= 2 && winnersNearAth.length === 0) {
      const target = current - 3;
      const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 75, 98);
      if (newVal < current) {
        changes.athTopThresholdPct = newVal;
        rationale.athTopThresholdPct = `${losersNearAth.length} near-ATH losses, 0 wins — tightened from ${current}% → ${newVal}%`;
      }
    } else if (winnersNearAth.length >= 2 && losersNearAth.length === 0) {
      const target = current + 2;
      const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 75, 98);
      if (newVal > current) {
        changes.athTopThresholdPct = newVal;
        rationale.athTopThresholdPct = `${winnersNearAth.length} near-ATH wins, 0 losses — loosened from ${current}% → ${newVal}%`;
      }
    }
  }

  return { changes, rationale };
}

function persistThresholdChanges(perfData, config, changes, rationale, { userConfig, lessonsData } = {}) {
  // ── Persist changes to user-config.json ───────────────────────
  // Use shared userConfig if provided by caller (avoids redundant read/write
  // when evolveThresholds + evolveFromLessons run back-to-back).
  if (!userConfig) userConfig = readUserConfig();

  // Always update the counter so we don't re-check the same data every close
  userConfig._lastEvolved = new Date().toISOString();
  userConfig._positionsAtEvolution = perfData.length;

  if (Object.keys(changes).length === 0) {
    writeUserConfig(userConfig);
    return { changes: {}, rationale: {}, userConfig };
  }

  Object.assign(userConfig, changes);
  writeUserConfig(userConfig);

  // Apply to live config object immediately
  const s = config.screening;
  const m = config.management;
  if (changes.maxVolatility        != null) s.maxVolatility        = changes.maxVolatility;
  if (changes.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = changes.minFeeActiveTvlRatio;
  if (changes.minOrganic           != null) s.minOrganic           = changes.minOrganic;
  if (changes.minBinStep           != null) s.minBinStep           = changes.minBinStep;
  if (changes.maxBinStep           != null) s.maxBinStep           = changes.maxBinStep;
  if (changes.outOfRangeWaitMinutes != null) m.outOfRangeWaitMinutes = changes.outOfRangeWaitMinutes;
  if (changes.trailingTriggerPct   != null) m.trailingTriggerPct   = changes.trailingTriggerPct;
  if (changes.trailingDropPct      != null) m.trailingDropPct      = changes.trailingDropPct;
  if (changes.athTopThresholdPct != null) s.athTopThresholdPct = changes.athTopThresholdPct;
  if (changes.ohlcvBufferMult != null && config.strategy) config.strategy.ohlcvBufferMult = changes.ohlcvBufferMult;

  // Log a lesson summarizing the evolution
  for (const [k, v] of Object.entries(changes)) log("evolve", `${k} → ${v}: ${rationale[k] ?? ""}`);
  const ld = lessonsData || load();
  ld.lessons.push({
    id: Date.now(),
    rule: `[AUTO-EVOLVED @ ${perfData.length} positions] ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(", ")} — ${Object.values(rationale).join("; ")}`,
    tags: ["evolution", "config_change"],
    outcome: "manual",
    created_at: new Date().toISOString(),
  });
  save(ld);

  return { changes, rationale, userConfig };
}

// ─── Deduplication Helpers ──────────────────────────────────────

/**
 * Normalize a lesson rule into a dedup key.
 * Strips numbers, pool names, and normalizes whitespace to catch
 * "same lesson, different numbers" duplicates.
 */
function lessonDedupKey(rule) {
  return rule
    .toLowerCase()
    .replace(/[\d.]+%/g, 'N%')           // "5.2%" → "N%"
    .replace(/\$[\d,.]+k?/g, '$N')        // "$17.5k" → "$N"
    .replace(/[\d.]+ sol/g, 'N SOL')      // "0.5 SOL" → "N SOL"
    .replace(/[\d.]+ minutes?/g, 'N min')  // "15 minutes" → "N min"
    .replace(/[\d.]+ hours?/g, 'N hours')  // "2 hours" → "N hours"
    .replace(/[\d.]+ bins?/g, 'N bins')    // "50 bins" → "N bins"
    .replace(/\b\d+\b/g, 'N')             // standalone numbers → "N"
    .replace(/[A-Z][a-z]+-SOL/gi, 'X-SOL') // "Downald-SOL" → "X-SOL"
    .replace(/\s+/g, ' ')                  // collapse whitespace
    .trim();
}

/**
 * Check if two tag arrays are equivalent (same elements, any order).
 */
function tagsMatch(a, b) {
  if (!a?.length && !b?.length) return true;
  if (!a?.length || !b?.length) return false;
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every(t => setA.has(t));
}

/**
 * Find an existing lesson that duplicates the candidate.
 * Returns the index if found, -1 otherwise.
 */
function findDuplicate(lessons, candidate) {
  const candidateKey = lessonDedupKey(candidate.rule);

  for (let i = lessons.length - 1; i >= 0; i--) {
    const existing = lessons[i];
    if (isExcludedLesson(existing)) continue; // never refresh a lesson from a known-bad record

    // Method 1: Tag + outcome match
    if (existing.outcome === candidate.outcome && tagsMatch(existing.tags, candidate.tags)) {
      return i;
    }

    // Method 2: Normalized key match
    if (lessonDedupKey(existing.rule) === candidateKey) {
      return i;
    }
  }

  return -1;
}

// ─── Lesson-Based Evolution ────────────────────────────────────

/**
 * Evolve thresholds based on lesson patterns and tags.
 * Complements evolveThresholds() which only looks at raw PnL numbers.
 * This function reads what the agent learned about WHY positions won/lost.
 *
 * @param {Object} [opts]   - Optional shared state to avoid redundant file I/O
 * @param {Object} [opts.userConfig] - Pre-read user-config.json (will be mutated + written)
 * @param {Object} [opts.lessonsData] - Pre-loaded lessons.json data (avoids extra load/save)
 */
export function evolveFromLessons(lessons, config, { userConfig, lessonsData } = {}) {
  lessons = (lessons || []).filter((l) => !isExcludedLesson(l));
  if (lessons.length < 5) return null;

  const recent = lessons.slice(-30); // last 30 lessons
  const changes = {};
  const rationale = {};

  // Count lesson tags
  const tagCounts = {};
  for (const l of recent) {
    for (const tag of (l.tags || [])) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }

  // (Downside-OOR lessons used to tighten stopLossPct here. The stop loss is
  // the operator's and is not evolved.)

  // 2. Volume collapse pattern → raise minVolume
  const volCollapseCount = tagCounts["volume_collapse"] || 0;
  if (volCollapseCount >= 3) {
    const current = config.screening.minVolume ?? 10000;
    const newVal = clamp(Math.round(current * 1.2), 5000, 100000);
    if (newVal > current) {
      changes.minVolume = newVal;
      rationale.minVolume = `${volCollapseCount} volume collapse lessons — raised minVolume from $${current} → $${newVal}`;
    }
  }

  // 3. High failure rate at specific volatility levels (from tags like "volatility_4")
  const volTags = Object.entries(tagCounts).filter(([t]) => t.startsWith("volatility_"));
  for (const [tag, count] of volTags) {
    if (count >= 3) {
      const vol = parseFloat(tag.replace("volatility_", ""));
      const current = config.screening.maxVolatility ?? 10;
      if (vol < current) {
        const newVal = clamp(Number((vol * 1.1).toFixed(1)), 1.0, 20.0);
        if (newVal < current && !changes.maxVolatility) {
          changes.maxVolatility = newVal;
          rationale.maxVolatility = `${count} failure lessons at volatility ~${vol} — tightened max from ${current} → ${newVal}`;
        }
      }
    }
  }

  if (Object.keys(changes).length === 0) return { changes: {}, rationale: {} };

  // Persist to user-config.json (use shared userConfig if provided)
  if (!userConfig) userConfig = readUserConfig();
  Object.assign(userConfig, changes);
  userConfig._lastEvolved = new Date().toISOString();
  writeUserConfig(userConfig);

  // Apply to live config
  const s = config.screening;
  if (changes.minVolume      != null) s.minVolume      = changes.minVolume;
  if (changes.maxVolatility  != null) s.maxVolatility  = changes.maxVolatility;

  // Log as lesson (use shared lessonsData if provided)
  const ld = lessonsData || load();
  ld.lessons.push({
    id: Date.now(),
    rule: `[LESSON-EVOLVED] ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(", ")} — ${Object.values(rationale).join("; ")}`,
    tags: ["evolution", "lesson_based"],
    outcome: "manual",
    created_at: new Date().toISOString(),
  });
  save(ld);

  return { changes, rationale, userConfig };
}

// ─── Helpers ───────────────────────────────────────────────────

function isFiniteNum(n) {
  return typeof n === "number" && isFinite(n);
}

function avg(arr) {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/** Move current toward target by at most maxChange fraction. */
function nudge(current, target, maxChange) {
  const delta = target - current;
  const maxDelta = current * maxChange;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

// ─── One-Time Deduplication ────────────────────────────────────

/**
 * One-time cleanup: deduplicate existing lessons.
 * Keeps the most recent version of each duplicate group.
 * Returns count of removed duplicates.
 */
export function deduplicateLessons() {
  const data = load();
  if (data.lessons.length === 0) return 0;

  const seen = new Map(); // dedupKey → index of kept lesson
  const toRemove = new Set();

  // Process newest first so we keep the most recent version
  for (let i = data.lessons.length - 1; i >= 0; i--) {
    const lesson = data.lessons[i];
    const key = lessonDedupKey(lesson.rule);
    const tagKey = `${lesson.outcome}:${(lesson.tags || []).sort().join(',')}`;

    if (seen.has(key) || seen.has(tagKey)) {
      toRemove.add(i);
    } else {
      seen.set(key, i);
      seen.set(tagKey, i);
    }
  }

  if (toRemove.size === 0) return 0;

  data.lessons = data.lessons.filter((_, i) => !toRemove.has(i));
  save(data);
  log("lessons", `Deduplicated: removed ${toRemove.size} duplicate lessons (${data.lessons.length} remaining)`);
  return toRemove.size;
}

// ─── Manual Lessons ────────────────────────────────────────────

/**
 * Add a manual lesson (e.g. from operator observation).
 */
export function addLesson(rule, tags = [], { pinned = false, role = null } = {}) {
  const data = load();
  const candidate = {
    id: Date.now(),
    rule,
    tags,
    outcome: "manual",
    pinned: !!pinned,
    role: role || null,
    created_at: new Date().toISOString(),
  };

  const dupeIdx = findDuplicate(data.lessons, candidate);
  if (dupeIdx >= 0) {
    // Update existing lesson instead of creating duplicate
    const existing = data.lessons[dupeIdx];
    existing.rule = candidate.rule;
    existing.tags = candidate.tags;
    existing.created_at = candidate.created_at; // refresh timestamp
    if (candidate.pinned) existing.pinned = true; // upgrade to pinned if requested
    if (candidate.role) existing.role = candidate.role;
    existing.update_count = (existing.update_count || 1) + 1;
    save(data);
    log("lessons", `Updated existing lesson (${existing.update_count}x)${pinned ? " [PINNED]" : ""}${role ? ` [${role}]` : ""}: ${rule}`);
  } else {
    data.lessons.push(candidate);
    save(data);
    log("lessons", `Manual lesson added${pinned ? " [PINNED]" : ""}${role ? ` [${role}]` : ""}: ${rule}`);
  }
}

/**
 * Remove a lesson by ID.
 */
export function removeLesson(id) {
  const data = load();
  const before = data.lessons.length;
  data.lessons = data.lessons.filter((l) => l.id !== id);
  save(data);
  return before - data.lessons.length;
}

/**
 * Pin a lesson by ID — pinned lessons are always injected regardless of cap.
 */
export function pinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = true;
  save(data);
  log("lessons", `Pinned lesson ${id}: ${lesson.rule.slice(0, 60)}`);
  return { found: true, pinned: true, id, rule: lesson.rule };
}

/**
 * Unpin a lesson by ID.
 */
export function unpinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = false;
  save(data);
  return { found: true, pinned: false, id, rule: lesson.rule };
}

/**
 * List lessons with optional filters.
 */
export function listLessons({ role = null, pinned = null, tag = null, limit = 30 } = {}) {
  const data = load();
  let lessons = [...data.lessons];

  if (pinned !== null) lessons = lessons.filter((l) => !!l.pinned === pinned);
  if (role)            lessons = lessons.filter((l) => !l.role || l.role === role);
  if (tag)             lessons = lessons.filter((l) => l.tags?.includes(tag));

  return {
    total: lessons.length,
    lessons: lessons.slice(-limit).map((l) => ({
      id: l.id,
      rule: l.rule.slice(0, 120),
      tags: l.tags,
      outcome: l.outcome,
      pinned: !!l.pinned,
      role: l.role || "all",
      created_at: l.created_at?.slice(0, 10),
    })),
  };
}

/**
 * Remove lessons matching a keyword in their rule text (case-insensitive).
 */
export function removeLessonsByKeyword(keyword) {
  const data = load();
  const before = data.lessons.length;
  const kw = keyword.toLowerCase();
  data.lessons = data.lessons.filter((l) => !l.rule.toLowerCase().includes(kw));
  save(data);
  return before - data.lessons.length;
}

/**
 * Clear ALL lessons (keeps performance data).
 */
export function clearAllLessons() {
  const data = load();
  const count = data.lessons.length;
  data.lessons = [];
  save(data);
  return count;
}

/**
 * Clear ALL performance records.
 */
export function clearPerformance() {
  const data = load();
  const count = data.performance.length;
  data.performance = [];
  save(data);
  return count;
}

// ─── Lesson Retrieval ──────────────────────────────────────────

// Tags that map to each agent role — used for role-aware lesson injection
const ROLE_TAGS = {
  SCREENER: ["screening", "narrative", "strategy", "deployment", "token", "volume", "entry", "bundler", "holders", "organic"],
  MANAGER:  ["management", "risk", "oor", "fees", "position", "hold", "close", "pnl", "rebalance", "claim"],
  GENERAL:  [], // all lessons
};

/**
 * Get lessons formatted for injection into the system prompt.
 * Structured injection with three tiers:
 *   1. Pinned        — always injected, up to PINNED_CAP
 *   2. Role-matched  — lessons tagged for this agentType, up to ROLE_CAP
 *   3. Recent        — fill remaining slots up to RECENT_CAP
 */
export function getLessonRecordsForPrompt(opts = {}) {
  // Support legacy call signature: getLessonRecordsForPrompt(20)
  if (typeof opts === "number") opts = { maxLessons: opts };

  const { agentType = "GENERAL", maxLessons = 35 } = opts;
  const loaded = load();
  // Lessons derived from known-bad records (learning-data.js) stay out of the prompt.
  const data = { ...loaded, lessons: (loaded.lessons || []).filter((l) => !isExcludedLesson(l)) };
  if (data.lessons.length === 0) {
    return { pinned: [], roleMatched: [], recent: [], selected: [] };
  }

  const PINNED_CAP = 10;
  const ROLE_CAP   = 15;
  const RECENT_CAP = maxLessons; // fills remaining slots up to total

  const outcomePriority = { bad: 0, poor: 1, failed: 1, good: 2, worked: 2, manual: 1, neutral: 3, evolution: 2 };
  const byPriority = (a, b) => (outcomePriority[a.outcome] ?? 3) - (outcomePriority[b.outcome] ?? 3);

  // Tier 1: Pinned
  const pinned = data.lessons
    .filter((l) => l.pinned && (!l.role || l.role === agentType || agentType === "GENERAL"))
    .sort(byPriority)
    .slice(0, PINNED_CAP);

  const usedIds = new Set(pinned.map((l) => l.id));

  // Tier 2: Role-matched
  const roleTags = ROLE_TAGS[agentType] || [];
  const roleMatched = data.lessons
    .filter((l) => {
      if (usedIds.has(l.id)) return false;
      const roleOk = !l.role || l.role === agentType || agentType === "GENERAL";
      const tagOk  = roleTags.length === 0 || !l.tags?.length || l.tags.some((t) => roleTags.includes(t));
      return roleOk && tagOk;
    })
    .sort(byPriority)
    .slice(0, ROLE_CAP);

  roleMatched.forEach((l) => usedIds.add(l.id));

  // Tier 3: Recent fill
  const remainingBudget = RECENT_CAP - pinned.length - roleMatched.length;
  const recent = remainingBudget > 0
    ? data.lessons
        .filter((l) => !usedIds.has(l.id))
        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
        .slice(0, remainingBudget)
    : [];

  return {
    pinned,
    roleMatched,
    recent,
    selected: [...pinned, ...roleMatched, ...recent],
  };
}

export function getLessonsForPrompt(opts = {}) {
  // Support legacy call signature: getLessonsForPrompt(20)
  const normalizedOpts = typeof opts === "number" ? { maxLessons: opts } : opts;
  const { agentType = "GENERAL" } = normalizedOpts;
  const { pinned, roleMatched, recent, selected } = getLessonRecordsForPrompt(normalizedOpts);
  if (selected.length === 0) return null;

  const sections = [];
  if (pinned.length)      sections.push(`── PINNED (${pinned.length}) ──\n` + fmtLessons(pinned));
  if (roleMatched.length) sections.push(`── ${agentType} (${roleMatched.length}) ──\n` + fmtLessons(roleMatched));
  if (recent.length)      sections.push(`── RECENT (${recent.length}) ──\n` + fmtLessons(recent));

  return sections.join("\n\n");
}

function fmtLessons(lessons) {
  return lessons.map((l) => {
    const date = l.created_at ? l.created_at.slice(0, 16).replace("T", " ") : "unknown";
    const pin  = l.pinned ? ">> " : "";
    return `${pin}[${l.outcome.toUpperCase()}] [${date}] ${l.rule}`;
  }).join("\n");
}

/**
 * Get individual performance records filtered by time window.
 */
export function getPerformanceHistory({ hours = 24, limit = 50 } = {}) {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return { positions: [], count: 0, hours };

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const filtered = p
    .filter((r) => r.recorded_at >= cutoff)
    .slice(-limit)
    .map((r) => ({
      pool_name: r.pool_name,
      pool: r.pool,
      strategy: r.strategy,
      pnl_usd: r.pnl_usd,
      pnl_pct: r.pnl_pct,
      fees_earned_usd: r.fees_earned_usd,
      range_efficiency: r.range_efficiency,
      minutes_held: r.minutes_held,
      close_reason: r.close_reason,
      closed_at: r.recorded_at,
    }));

  const totalPnl = filtered.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
  const wins = filtered.filter((r) => r.pnl_usd > 0).length;

  return {
    hours,
    count: filtered.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    win_rate_pct: filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : null,
    positions: filtered,
  };
}

/**
 * Get performance stats summary.
 */
export function getPerformanceSummary() {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return null;

  // Closes with unknown PnL carry a placeholder 0; keep them out of PnL/win-rate stats.
  const known = p.filter((x) => !x.pnl_unknown);
  const totalPnl = known.reduce((s, x) => s + x.pnl_usd, 0);
  const avgPnlPct = known.length ? known.reduce((s, x) => s + x.pnl_pct, 0) / known.length : 0;
  const avgRangeEfficiency = p.reduce((s, x) => s + x.range_efficiency, 0) / p.length;
  const wins = known.filter((x) => x.pnl_usd > 0).length;

  return {
    total_positions_closed: p.length,
    ...(p.length !== known.length && { pnl_unknown_closes: p.length - known.length }),
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    avg_pnl_pct: Math.round(avgPnlPct * 100) / 100,
    avg_range_efficiency_pct: Math.round(avgRangeEfficiency * 10) / 10,
    win_rate_pct: known.length ? Math.round((wins / known.length) * 100) : 0,
    total_lessons: data.lessons.length,
  };
}
