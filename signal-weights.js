/**
 * Darwinian signal weighting system.
 *
 * Tracks which screening signals actually predict profitable positions
 * and adjusts their weights over time. Signals that consistently appear
 * in winners get boosted; those associated with losers get decayed.
 *
 * Weights are persisted in signal-weights.json and injected into the
 * LLM prompt so the agent can prioritize the right screening criteria.
 */

import fs from "fs";
import { log } from "./logger.js";

const WEIGHTS_FILE = "./signal-weights.json";
const LESSONS_FILE = "./lessons.json";
const CALIBRATION_WINDOW_DAYS = 90;
const MIN_CALIBRATION_SAMPLES = 20;
let _signalCalibrationCache = { mtimeMs: null, calibration: null };
// Set when signal-weights.json is present but unparseable. While degraded we
// refuse to overwrite the (recoverable) bad file with defaults.
let _weightsDegraded = false;

// ─── Signal Definitions ─────────────────────────────────────────

const SIGNAL_NAMES = [
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "mcap",
  "holder_count",
  "smart_wallets_present",
  "narrative_quality",
  "study_win_rate",
  "volatility",
  "ath_proximity",
  // New signals from GMGN candle + signal feed
  "volume_trend",       // increasing/decreasing/stable — from 5m candles
  "gmgn_signal_present", // smart money/KOL/whale activity on token
  "change_1h",          // 1-hour price change from GMGN
  "candle_price_range",  // real-time volatility from 5m candle spread
];

const DEFAULT_WEIGHTS = Object.fromEntries(SIGNAL_NAMES.map((s) => [s, 1.0]));

// Signals where higher values generally indicate better candidates
const HIGHER_IS_BETTER = new Set([
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "holder_count",
  "study_win_rate",
]);

// Boolean signals — compared by win rate when present vs absent
const BOOLEAN_SIGNALS = new Set(["smart_wallets_present", "gmgn_signal_present"]);

// Categorical signals — compared by win rate across categories
const CATEGORICAL_SIGNALS = new Set(["narrative_quality", "volume_trend"]);

// ─── Persistence ─────────────────────────────────────────────────

const DEFAULT_DIRECTIONS = Object.fromEntries(
  SIGNAL_NAMES.map((s) => {
    if (HIGHER_IS_BETTER.has(s)) return [s, "higher"];
    if (BOOLEAN_SIGNALS.has(s)) return [s, "present=better"];
    return [s, "unknown"];
  })
);

export function loadWeights() {
  if (!fs.existsSync(WEIGHTS_FILE)) {
    const initial = {
      weights: { ...DEFAULT_WEIGHTS },
      directions: { ...DEFAULT_DIRECTIONS },
      calibration: {},
      last_recalc: null,
      recalc_count: 0,
      history: [],
    };
    saveWeights(initial);
    log("signal_weights", "Created signal-weights.json with default weights");
    return initial;
  }
  try {
    const data = JSON.parse(fs.readFileSync(WEIGHTS_FILE, "utf8"));
    // Gracefully add directions field to existing files that lack it
    if (!data.directions) {
      data.directions = { ...DEFAULT_DIRECTIONS };
    } else {
      // Ensure all signals have a direction entry
      for (const name of SIGNAL_NAMES) {
        if (data.directions[name] == null) {
          if (HIGHER_IS_BETTER.has(name)) data.directions[name] = "higher";
          else if (BOOLEAN_SIGNALS.has(name)) data.directions[name] = "present=better";
          else data.directions[name] = "unknown";
        }
      }
    }
    if (!data.calibration || typeof data.calibration !== "object") {
      data.calibration = {};
    }
    return data;
  } catch (err) {
    // File PRESENT but corrupt: do NOT silently fall back to defaults (a later
    // saveWeights would wipe the learned weights/history). Preserve the bad
    // file for recovery and enter a degraded, read-only state.
    if (!_weightsDegraded) {
      try {
        const backup = `${WEIGHTS_FILE}.corrupt-${Date.now()}`;
        fs.copyFileSync(WEIGHTS_FILE, backup);
        log("signal_weights_error", `signal-weights.json is corrupt (${err.message}); preserved as ${backup}. Refusing to overwrite until recovered.`);
      } catch (backupErr) {
        log("signal_weights_error", `signal-weights.json is corrupt (${err.message}) and backup failed: ${backupErr.message}. Refusing to overwrite until recovered.`);
      }
    }
    _weightsDegraded = true;
    throw new Error(`signal-weights.json is corrupt and was preserved for recovery: ${err.message}`);
  }
}

export function saveWeights(data) {
  // Never persist over a corrupt-but-present file; that would destroy
  // recoverable learned weights. Skip saves until the file is restored.
  if (_weightsDegraded) {
    log("signal_weights_error", "Skipping signal-weights.json save: file is in degraded (corrupt) state. Restore or remove the corrupt backup to re-enable saves.");
    return;
  }
  try {
    fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log("signal_weights_error", `Failed to write signal-weights.json: ${err.message}`);
  }
}

// ─── Core Algorithm ──────────────────────────────────────────────

/**
 * Recalculate signal weights based on actual position performance.
 *
 * @param {Array}  perfData - Array of performance records (from lessons.json)
 * @param {Object} cfg      - Live config object (reads cfg.darwin for tuning)
 * @returns {{ changes: Array, weights: Object }}
 */
export function recalculateWeights(perfData, cfg = {}) {
  const darwin = cfg.darwin || {};
  const windowDays   = darwin.windowDays   ?? 60;
  const minSamples   = darwin.minSamples   ?? 10;
  const perSignalMinSamples = darwin.perSignalMinSamples ?? 12;
  const minAbsLiftToAdjust = darwin.minAbsLiftToAdjust ?? 0.05;
  const strongLiftThreshold = darwin.strongLiftThreshold ?? 0.2;
  const boostFactor  = darwin.boostFactor  ?? 1.05;
  const decayFactor  = darwin.decayFactor  ?? 0.95;
  const weightFloor  = darwin.weightFloor  ?? 0.3;
  const weightCeiling = darwin.weightCeiling ?? 2.5;
  const calibrationMinSamples = darwin.calibrationMinSamples ?? 20;
  const meanReversionRate = darwin.meanReversionRate ?? 0.02;
  const minAbsLift = minAbsLiftToAdjust;
  const strongLift = strongLiftThreshold;

  const data = loadWeights();
  const weights = data.weights || { ...DEFAULT_WEIGHTS };

  // Ensure all signals exist (handles new signals added after initial creation)
  for (const name of SIGNAL_NAMES) {
    if (weights[name] == null) weights[name] = 1.0;
  }

  // Filter to rolling window
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffISO = cutoff.toISOString();

  const recent = perfData.filter((p) => {
    const ts = p.recorded_at || p.closed_at || p.deployed_at;
    return ts && ts >= cutoffISO;
  });

  if (recent.length < minSamples) {
    log("signal_weights", `Only ${recent.length} records in ${windowDays}d window (need ${minSamples}), skipping recalc`);
    return { changes: [], weights };
  }

  // Classify wins and losses
  const wins  = recent.filter((p) => (p.pnl_usd ?? 0) > 0);
  const losses = recent.filter((p) => (p.pnl_usd ?? 0) <= 0);

  if (wins.length === 0 || losses.length === 0) {
    log("signal_weights", `Need both wins (${wins.length}) and losses (${losses.length}) to compute lift, skipping`);
    return { changes: [], weights };
  }

  data.calibration = buildCalibrationStats(recent, calibrationMinSamples);

  // Compute predictive lift for each signal
  const lifts = {};
  const sampleCounts = {};

  for (const signal of SIGNAL_NAMES) {
    sampleCounts[signal] = countSignalSamples(signal, recent);
    const lift = computeLift(signal, wins, losses, perSignalMinSamples);
    if (lift !== null) {
      lifts[signal] = lift;
    }
  }

  // Rank by absolute lift — high-predictive signals regardless of direction get boosted
  const ranked = Object.entries(lifts)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const adjustable = ranked.filter(([signal, lift]) =>
    (sampleCounts[signal] ?? 0) >= perSignalMinSamples &&
    Math.abs(lift) >= minAbsLiftToAdjust
  );

  if (ranked.length === 0) {
    log("signal_weights", "No signals had enough samples for lift calculation");
    return { changes: [], weights };
  }

  // Track signal directions
  const directions = data.directions || { ...DEFAULT_DIRECTIONS };

  for (const [signal, lift] of ranked) {
    if ((sampleCounts[signal] ?? 0) < perSignalMinSamples) continue;
    if (Math.abs(lift) < minAbsLiftToAdjust) continue;
    // HIGHER_IS_BETTER signals always have direction "higher" — don't overwrite
    if (HIGHER_IS_BETTER.has(signal)) {
      directions[signal] = "higher";
    } else if (BOOLEAN_SIGNALS.has(signal)) {
      // Boolean: positive lift means present=better, negative means absent=better
      directions[signal] = lift > 0 ? "present=better" : "absent=better";
    } else {
      // Numeric non-HIGHER_IS_BETTER: track learned direction
      directions[signal] = lift > 0 ? "higher" : "lower";
    }
  }

  data.directions = directions;

  // Split into quartiles using only signals with enough evidence to adjust.
  const q1End = Math.ceil(adjustable.length * 0.25);
  const q3Start = Math.floor(adjustable.length * 0.75);

  const topQuartile = new Set(adjustable.slice(0, q1End).map(([name]) => name));
  const bottomQuartile = new Set(adjustable.slice(q3Start).map(([name]) => name));

  // Apply boosts and decays with mean reversion
  const changes = [];

  for (const [signal, lift] of ranked) {
    const prev = weights[signal];
    let next = prev;
    const confidence = clamp01(Math.abs(lift) / Math.max(strongLiftThreshold, 0.001));

    if (topQuartile.has(signal)) {
      next = prev * (1 + ((boostFactor - 1) * confidence));
    } else if (bottomQuartile.has(signal)) {
      next = prev * (1 - ((1 - decayFactor) * confidence));
    }

    // Mean reversion: gently pull toward neutral (1.0) to prevent runaway drift
    next = next + (1.0 - next) * meanReversionRate;

    // Clamp to floor/ceiling
    next = Math.max(weightFloor, Math.min(weightCeiling, next));

    next = Math.round(next * 1000) / 1000;

    if (next !== prev) {
      const dir = next > prev ? "boosted" : "decayed";
      changes.push({
        signal,
        from: prev,
        to: next,
        lift: Math.round(lift * 1000) / 1000,
        direction: directions[signal],
        action: dir,
        samples: sampleCounts[signal] ?? 0,
        confidence: Math.round(confidence * 1000) / 1000,
      });
      weights[signal] = next;
      log("signal_weights", `${signal}: ${prev} -> ${next} (${dir}, lift=${lift.toFixed(3)}, confidence=${confidence.toFixed(3)}, samples=${sampleCounts[signal] ?? 0}, direction=${directions[signal]})`);
    }
  }

  // Persist
  data.weights = weights;
  data.last_recalc = new Date().toISOString();
  data.recalc_count = (data.recalc_count || 0) + 1;

  // Keep last 20 history entries
  if (!data.history) data.history = [];
  if (changes.length > 0) {
    data.history.push({
      timestamp: data.last_recalc,
      changes,
      window_size: recent.length,
      win_count: wins.length,
      loss_count: losses.length,
    });
    if (data.history.length > 20) {
      data.history = data.history.slice(-20);
    }
  }

  saveWeights(data);

  if (changes.length > 0) {
    log("signal_weights", `Recalculated: ${changes.length} weight(s) adjusted from ${recent.length} records`);
  } else {
    log("signal_weights", `Recalculated: no changes needed (${recent.length} records, ${ranked.length} signals evaluated)`);
  }

  return { changes, weights };
}

// ─── Lift Computation ────────────────────────────────────────────

/**
 * Compute the predictive lift of a signal.
 *
 * For numeric signals: mean normalized value in winners vs losers.
 * For boolean signals: win rate when true vs win rate when false.
 * For categorical signals: win rate difference for best vs worst category.
 *
 * Returns null if insufficient data.
 */
function computeLift(signal, wins, losses, minSamples) {
  if (BOOLEAN_SIGNALS.has(signal)) {
    return computeBooleanLift(signal, wins, losses, minSamples);
  }
  if (CATEGORICAL_SIGNALS.has(signal)) {
    return computeCategoricalLift(signal, wins, losses, minSamples);
  }
  return computeNumericLift(signal, wins, losses, minSamples);
}

/**
 * Numeric lift: difference in mean normalized signal value between
 * winners and losers. Higher lift = signal is more predictive.
 */
function computeNumericLift(signal, wins, losses, minSamples) {
  const winVals  = extractNumeric(signal, wins);
  const lossVals = extractNumeric(signal, losses);

  if (winVals.length + lossVals.length < minSamples) return null;
  if (winVals.length === 0 || lossVals.length === 0) return null;

  // Normalize across the combined population to make signals comparable
  const all = [...winVals, ...lossVals];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const range = max - min;

  // If no variance, signal is not informative
  if (range === 0) return 0;

  const normalize = (v) => (v - min) / range;

  const winMean  = mean(winVals.map(normalize));
  const lossMean = mean(lossVals.map(normalize));

  // Return signed lift for ALL numeric signals.
  // Positive lift = winners have higher values; negative = winners have lower values.
  // Direction information is preserved so the agent knows which way to optimize.
  return winMean - lossMean;
}

/**
 * Boolean lift: difference in win rate when signal is true vs false.
 */
function computeBooleanLift(signal, wins, losses, minSamples) {
  const allEntries = [...wins.map((w) => ({ w: true, snap: w })), ...losses.map((l) => ({ w: false, snap: l }))];

  let trueWins = 0, trueTotal = 0;
  let falseWins = 0, falseTotal = 0;

  for (const { w, snap } of allEntries) {
    const val = snap.signal_snapshot?.[signal];
    if (val === undefined || val === null) continue;

    if (val) {
      trueTotal++;
      if (w) trueWins++;
    } else {
      falseTotal++;
      if (w) falseWins++;
    }
  }

  if (trueTotal + falseTotal < minSamples) return null;
  if (trueTotal === 0 || falseTotal === 0) return null;

  const trueWR  = trueWins / trueTotal;
  const falseWR = falseWins / falseTotal;

  return trueWR - falseWR;
}

/**
 * Categorical lift: best category win rate minus worst category win rate.
 */
function computeCategoricalLift(signal, wins, losses, minSamples) {
  const allEntries = [...wins.map((w) => ({ w: true, snap: w })), ...losses.map((l) => ({ w: false, snap: l }))];

  const buckets = {}; // category -> { wins, total }

  for (const { w, snap } of allEntries) {
    const val = snap.signal_snapshot?.[signal];
    if (val === undefined || val === null) continue;

    if (!buckets[val]) buckets[val] = { wins: 0, total: 0 };
    buckets[val].total++;
    if (w) buckets[val].wins++;
  }

  const totalSamples = Object.values(buckets).reduce((s, b) => s + b.total, 0);
  if (totalSamples < minSamples) return null;

  const rates = Object.values(buckets)
    .filter((b) => b.total >= 2)  // need at least 2 per category
    .map((b) => b.wins / b.total);

  if (rates.length < 2) return null;

  return Math.max(...rates) - Math.min(...rates);
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Extract numeric signal values from performance entries.
 * Only includes entries where the signal is present in signal_snapshot.
 */
function extractNumeric(signal, entries) {
  const vals = [];
  for (const entry of entries) {
    const snap = entry.signal_snapshot;
    if (!snap) continue;
    const v = snap[signal];
    if (v != null && typeof v === "number" && isFinite(v)) {
      vals.push(v);
    }
  }
  return vals;
}

function countSignalSamples(signal, entries) {
  let count = 0;
  for (const entry of entries) {
    const snap = entry.signal_snapshot;
    if (!snap) continue;
    const v = snap[signal];
    if (v !== undefined && v !== null && v !== "") count++;
  }
  return count;
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function buildCalibrationStats(entries, minSamples) {
  const calibration = {};
  for (const signal of SIGNAL_NAMES) {
    if (BOOLEAN_SIGNALS.has(signal) || CATEGORICAL_SIGNALS.has(signal)) continue;
    const values = extractNumeric(signal, entries).sort((a, b) => a - b);
    if (values.length < minSamples) continue;
    const low = percentile(values, 0.1);
    const high = percentile(values, 0.9);
    if (low == null || high == null || high <= low) continue;
    calibration[signal] = { low, high };
  }
  return calibration;
}

function percentile(sorted, pct) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * pct)));
  return sorted[idx];
}

function loadSignalCalibration(windowDays = CALIBRATION_WINDOW_DAYS) {
  try {
    if (!fs.existsSync(LESSONS_FILE)) return {};
    const stat = fs.statSync(LESSONS_FILE);
    if (_signalCalibrationCache.mtimeMs === stat.mtimeMs && _signalCalibrationCache.calibration) {
      return _signalCalibrationCache.calibration;
    }

    const raw = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
    const perfData = raw.performance || [];
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - windowDays);
    const cutoffISO = cutoff.toISOString();
    const recent = perfData.filter((p) => {
      const ts = p.recorded_at || p.closed_at || p.deployed_at;
      return ts && ts >= cutoffISO;
    });

    const calibration = {};
    for (const signal of SIGNAL_NAMES) {
      if (BOOLEAN_SIGNALS.has(signal) || CATEGORICAL_SIGNALS.has(signal)) continue;
      const values = extractNumeric(signal, recent).sort((a, b) => a - b);
      if (values.length < MIN_CALIBRATION_SAMPLES) continue;
      const low = percentile(values, 0.1);
      const high = percentile(values, 0.9);
      if (low == null || high == null || high <= low) continue;
      calibration[signal] = { low, high };
    }

    _signalCalibrationCache = { mtimeMs: stat.mtimeMs, calibration };
    return calibration;
  } catch {
    return {};
  }
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

function normalizeLinear(value, min, max) {
  if (value == null || !Number.isFinite(value)) return null;
  if (max <= min) return 0.5;
  return clamp01((value - min) / (max - min));
}

function normalizeLog(value, min, max) {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  if (max <= min) return 0.5;
  const num = Math.log10(Math.max(value, min));
  const den = Math.log10(max) - Math.log10(min);
  if (den <= 0) return 0.5;
  return clamp01((num - Math.log10(min)) / den);
}

function normalizeCategorical(signal, value) {
  if (value == null) return null;
  const normalized = String(value).toLowerCase();

  if (signal === "volume_trend") {
    if (normalized === "increasing") return 1;
    if (normalized === "stable") return 0.5;
    if (normalized === "decreasing") return 0;
  }

  if (signal === "narrative_quality") {
    if (["strong", "excellent"].includes(normalized)) return 1;
    if (["good", "specific", "real"].includes(normalized)) return 0.8;
    if (["neutral", "mixed"].includes(normalized)) return 0.5;
    if (["weak", "hype"].includes(normalized)) return 0.2;
    if (["bad", "empty", "none", "null"].includes(normalized)) return 0;
  }

  return null;
}

function getBaseSignalScore(signal, value, calibration = {}) {
  if (value == null) return null;

  if (typeof value === "boolean") return value ? 1 : 0;

  if (BOOLEAN_SIGNALS.has(signal)) {
    return value ? 1 : 0;
  }

  if (CATEGORICAL_SIGNALS.has(signal) || typeof value === "string") {
    return normalizeCategorical(signal, value);
  }

  if (!Number.isFinite(value)) return null;

  const bounds = calibration?.[signal] || null;

  switch (signal) {
    case "organic_score":
    case "study_win_rate":
      return bounds ? normalizeLinear(value, bounds.low, bounds.high) : normalizeLinear(value, 0, 100);
    case "fee_tvl_ratio":
      return bounds ? normalizeLinear(value, bounds.low, bounds.high) : normalizeLinear(value, 0, 5);
    case "volume":
      return bounds ? normalizeLog(value, Math.max(bounds.low, 1), Math.max(bounds.high, bounds.low * 1.01)) : normalizeLog(value, 100, 1_000_000);
    case "mcap":
      return bounds ? normalizeLog(value, Math.max(bounds.low, 1), Math.max(bounds.high, bounds.low * 1.01)) : normalizeLog(value, 100_000, 100_000_000);
    case "holder_count":
      return bounds ? normalizeLog(value, Math.max(bounds.low, 1), Math.max(bounds.high, bounds.low * 1.01)) : normalizeLog(value, 100, 50_000);
    case "volatility":
      return bounds ? normalizeLinear(value, bounds.low, bounds.high) : normalizeLinear(value, 0, 15);
    case "ath_proximity":
      return bounds ? normalizeLinear(value, bounds.low, bounds.high) : normalizeLinear(value, 0, 100);
    case "change_1h":
      return bounds ? normalizeLinear(value, bounds.low, bounds.high) : normalizeLinear(value, -50, 50);
    case "candle_price_range":
      return bounds ? normalizeLinear(value, bounds.low, bounds.high) : normalizeLinear(value, 0, 25);
    default:
      return bounds ? normalizeLinear(value, bounds.low, bounds.high) : normalizeLinear(value, 0, 1);
  }
}

function applyDirection(baseScore, direction) {
  if (baseScore == null) return null;
  if (direction === "lower" || direction === "absent=better") {
    return 1 - baseScore;
  }
  return baseScore;
}

export function scoreSignalSnapshot(snapshot = {}, opts = {}) {
  const data = opts.weightData || loadWeights();
  const calibration = opts.calibration || loadSignalCalibration(opts.windowDays ?? CALIBRATION_WINDOW_DAYS);
  const weights = data.weights || {};
  const directions = data.directions || {};
  const contributions = [];

  let weightedSum = 0;
  let totalWeight = 0;

  for (const signal of SIGNAL_NAMES) {
    const value = snapshot?.[signal];
    const baseScore = getBaseSignalScore(signal, value, calibration);
    if (baseScore == null) continue;

    const weight = weights[signal] ?? 1.0;
    const direction = directions[signal] || "unknown";
    const score = applyDirection(baseScore, direction);
    const contribution = score * weight;

    contributions.push({
      signal,
      value,
      weight,
      direction,
      score: Math.round(score * 1000) / 1000,
      contribution: Math.round(contribution * 1000) / 1000,
    });

    weightedSum += contribution;
    totalWeight += weight;
  }

  contributions.sort((a, b) => b.contribution - a.contribution);

  const normalizedScore = totalWeight > 0 ? weightedSum / totalWeight : 0.5;
  const topN = opts.topN ?? 4;

  return {
    score: normalizedScore,
    score_pct: Math.round(normalizedScore * 1000) / 10,
    totalWeight: Math.round(totalWeight * 1000) / 1000,
    coverage: contributions.length,
    topSignals: contributions.slice(0, topN),
    contributions,
  };
}

// ─── Summary for LLM Prompt Injection ────────────────────────────

/**
 * Return a formatted string summarizing signal weights for inclusion
 * in the LLM system prompt. Helps the agent understand which signals
 * to prioritize during screening.
 */
export function getWeightsSummary() {
  const data = loadWeights();
  const w = data.weights || {};
  const dirs = data.directions || {};

  const lines = ["Signal Weights (Darwinian — learned from past positions):"];
  lines.push("  (direction shows how the agent should interpret each signal)");

  const sorted = SIGNAL_NAMES
    .filter((s) => w[s] != null)
    .sort((a, b) => (w[b] ?? 1) - (w[a] ?? 1));

  for (const signal of sorted) {
    const val = w[signal] ?? 1.0;
    const label = interpretWeight(val);
    const bar = weightBar(val);
    const direction = dirs[signal] || "unknown";
    const dirLabel = formatDirection(val, direction);
    lines.push(`  ${signal.padEnd(24)} ${val.toFixed(2)}  ${bar}  ${label} ${dirLabel}`);
  }

  if (data.last_recalc) {
    lines.push(`\nLast recalculated: ${data.last_recalc} (${data.recalc_count || 0} total)`);
  } else {
    lines.push("\nWeights have not been recalculated yet (using defaults).");
  }

  return lines.join("\n");
}

function interpretWeight(val) {
  if (val >= 1.8) return "[STRONG]";
  if (val >= 1.2) return "[above avg]";
  if (val >= 0.8) return "[neutral]";
  if (val >= 0.5) return "[below avg]";
  return "[weak]";
}

/**
 * Format direction info for LLM consumption.
 * Examples:
 *   "↑ higher=better"   — high values of this signal predict wins
 *   "↓ lower=better"    — low values predict wins
 *   "↑ present=better"  — boolean signal: presence predicts wins
 *   "? unknown"          — not yet computed
 */
function formatDirection(weight, direction) {
  if (direction === "higher") return "↑ higher=better";
  if (direction === "lower") return "↓ lower=better";
  if (direction === "present=better") return "↑ present=better";
  if (direction === "absent=better") return "↓ absent=better";
  return "? unknown";
}

function weightBar(val) {
  // Visual bar: 0.3 = ., 2.5 = full
  const filled = Math.round(((val - 0.3) / (2.5 - 0.3)) * 10);
  const clamped = Math.max(0, Math.min(10, filled));
  return "#".repeat(clamped) + ".".repeat(10 - clamped);
}
