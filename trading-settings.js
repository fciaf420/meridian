// trading-settings.js — the Telegram "⚙️ Trading settings" presets: validation,
// risk classification and the persist-and-apply-live write path.
//
// Pure module: config, persistUserConfig, the PnL-watcher rescheduler and the
// logger are passed in, so tests run it against mocks. index.js wires the real
// ones (config.js, persistUserConfig, startPnlWatcher).
//
// These are user changes, like the entry-filter toggles. The LLM's
// update_config keeps its own path and bounds (tools/executor.js) for the same
// keys in both directions; nothing here restricts it.
import { CONFIG_KEY_MAP, getRequiredSolBalance } from "./runtime-helpers.js";

export const DEPLOY_SIZE_MIN_SOL = 0.1;
export const DEPLOY_SIZE_MAX_SOL = 10;

/**
 * Preset groups. `code` is the 2-letter id used in callback_data (tv:<code>:<v>).
 * Stop loss "Off" is stored as 0 (state.js: `if (mgmt.stopLossPct && …)` treats 0
 * and null as disabled; config.js would turn a persisted null back into the -20
 * default on restart, so 0 is the only Off value that survives a restart).
 */
export const TRADING_PRESETS = {
  tp: { key: "takeProfitFeePct", label: "Take profit", values: [3, 5, 7, 10, 15, 20] },
  sl: { key: "stopLossPct", label: "Stop loss", values: [-5, -8, -10, -15, -20, 0] },
  tt: { key: "trailingTakeProfit", label: "Trailing TP", values: [true, false] },
  tg: { key: "trailingTriggerPct", label: "Trailing trigger", values: [3, 5, 8, 10] },
  td: { key: "trailingDropPct", label: "Trailing drop", values: [2, 3, 4, 6] },
  oo: { key: "outOfRangeWaitMinutes", label: "Out-of-range wait", values: [5, 10, 20, 30, 60] },
  ds: { key: "deployAmountSol", label: "Deploy size", values: [0.5, 1.1, 1.5, 2] },
  mp: { key: "maxPositions", label: "Max positions", values: [1, 2, 3, 4] },
  pw: { key: "pnlWatcherIntervalSec", label: "PnL watcher", values: [15, 30, 60] },
};

/** Keys this screen may write (deploy size also writes maxDeployAmount / minSolToOpen). */
export const TRADING_KEYS = [
  "takeProfitFeePct", "stopLossPct", "trailingTakeProfit", "trailingTriggerPct", "trailingDropPct",
  "outOfRangeWaitMinutes", "deployAmountSol", "maxDeployAmount", "minSolToOpen", "maxPositions",
  "pnlWatcherIntervalSec",
];

/** Encode a preset value for callback_data. */
export function encodePresetValue(v) {
  if (v === true) return "on";
  if (v === false) return "off";
  if (v === 0) return "off"; // stop loss Off
  return String(v);
}

/** Decode a preset tap; only exact preset values are accepted. Returns { key, value } or null. */
export function decodePreset(code, raw) {
  const p = TRADING_PRESETS[code];
  if (!p) return null;
  let v;
  if (p.key === "trailingTakeProfit") v = raw === "on" ? true : raw === "off" ? false : undefined;
  else if (p.key === "stopLossPct" && raw === "off") v = 0;
  else v = raw != null && /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : undefined;
  if (v === undefined || !p.values.includes(v)) return null;
  return { key: p.key, value: v };
}

export const stopLossOff = (v) => v == null || Number(v) === 0;

/** Current values, read from the running config. */
export function readTradingSettings(config) {
  const m = config.management || {};
  return {
    takeProfitFeePct: m.takeProfitFeePct,
    stopLossPct: m.stopLossPct,
    trailingTakeProfit: !!m.trailingTakeProfit,
    trailingTriggerPct: m.trailingTriggerPct,
    trailingDropPct: m.trailingDropPct,
    outOfRangeWaitMinutes: m.outOfRangeWaitMinutes,
    deployAmountSol: m.deployAmountSol,
    maxDeployAmount: config.risk?.maxDeployAmount,
    minSolToOpen: m.minSolToOpen,
    gasReserve: m.gasReserve ?? 0.2,
    maxPositions: config.risk?.maxPositions,
    pnlWatcherIntervalSec: config.schedule?.pnlWatcherIntervalSec,
  };
}

export function fmtTradingValue(key, v) {
  if (v === undefined) return "?";
  switch (key) {
    case "stopLossPct": return stopLossOff(v) ? "Off" : `${v}%`;
    case "trailingTakeProfit": return v ? "on" : "off";
    case "takeProfitFeePct":
    case "trailingTriggerPct":
    case "trailingDropPct": return `${v}%`;
    case "outOfRangeWaitMinutes": return `${v} min`;
    case "deployAmountSol":
    case "maxDeployAmount":
    case "minSolToOpen": return `${v} SOL`;
    case "pnlWatcherIntervalSec": return `${v}s`;
    default: return String(v);
  }
}

const LABELS = {
  takeProfitFeePct: "Take profit",
  stopLossPct: "Stop loss",
  trailingTakeProfit: "Trailing TP",
  trailingTriggerPct: "Trailing trigger",
  trailingDropPct: "Trailing drop",
  outOfRangeWaitMinutes: "Out-of-range wait",
  deployAmountSol: "Deploy size (floor)",
  maxDeployAmount: "Deploy ceiling",
  minSolToOpen: "Min SOL to open",
  maxPositions: "Max positions",
  pnlWatcherIntervalSec: "PnL watcher",
};
export const labelFor = (key) => LABELS[key] ?? key;

/** Validate one value. Returns { value } (normalized) or { error }. */
export function validateTradingValue(key, value) {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  const v = num(value);
  switch (key) {
    case "takeProfitFeePct":
      return v > 0 && v <= 100 ? { value: v } : { error: "take profit must be > 0 and ≤ 100%" };
    case "stopLossPct":
      if (value == null || v === 0) return { value: 0 }; // Off
      return v < 0 && v >= -100 ? { value: v } : { error: "stop loss must be negative (−100…0) or Off" };
    case "trailingTakeProfit":
      return typeof value === "boolean" ? { value } : { error: "trailing TP must be on or off" };
    case "trailingTriggerPct":
      return v > 0 && v <= 100 ? { value: v } : { error: "trailing trigger must be > 0 and ≤ 100%" };
    case "trailingDropPct":
      return v > 0 && v < 100 ? { value: v } : { error: "trailing drop must be > 0 and < 100%" };
    case "outOfRangeWaitMinutes":
      return Number.isInteger(v) && v >= 1 && v <= 1440 ? { value: v } : { error: "out-of-range wait must be 1…1440 min" };
    case "deployAmountSol":
    case "maxDeployAmount":
    case "minSolToOpen": {
      if (!(v > 0)) return { error: `${labelFor(key)} must be a positive SOL amount` };
      if (key !== "minSolToOpen" && (v < DEPLOY_SIZE_MIN_SOL || v > DEPLOY_SIZE_MAX_SOL)) {
        return { error: `deploy size must be ${DEPLOY_SIZE_MIN_SOL}–${DEPLOY_SIZE_MAX_SOL} SOL` };
      }
      return { value: v };
    }
    case "maxPositions":
      return Number.isInteger(v) && v >= 1 && v <= 50 ? { value: v } : { error: "max positions must be 1…50" };
    case "pnlWatcherIntervalSec":
      return Number.isInteger(v) && v >= 5 && v <= 3600 ? { value: v } : { error: "PnL watcher interval must be 5…3600 s" };
    default:
      return { error: `${key} is not a trading setting` };
  }
}

/**
 * Parse the "Custom…" deploy-size message. Accepts "1.3", "1,3", "1.3 sol".
 * Rounds to 2 decimals (computeDeployAmount's precision). Returns { value } or { error }.
 */
export function parseCustomDeploySize(text) {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(?:sol)?\s*$/i.exec(String(text ?? ""));
  if (!m) return { error: "not a number" };
  const v = Math.round(Number(m[1].replace(",", ".")) * 100) / 100;
  if (!(v >= DEPLOY_SIZE_MIN_SOL && v <= DEPLOY_SIZE_MAX_SOL)) {
    return { error: `${m[1]} SOL is outside ${DEPLOY_SIZE_MIN_SOL}–${DEPLOY_SIZE_MAX_SOL} SOL` };
  }
  return { value: v };
}

/**
 * Turn one requested setting into the full change set. Deploy size sets the
 * floor AND the ceiling (fixed size), and raises minSolToOpen to at least
 * size + gasReserve when it would be lower. Returns
 * { changes, notes, warnings } or { error }.
 */
export function planTradingChange(key, value, current) {
  const val = validateTradingValue(key, value);
  if (val.error) return { error: val.error };
  const changes = { [key]: val.value };
  const notes = [];
  const warnings = [];
  if (key === "deployAmountSol") {
    changes.maxDeployAmount = val.value;
    const required = getRequiredSolBalance({ deployAmountSol: val.value, gasReserve: current.gasReserve ?? 0.2 });
    if (!(Number(current.minSolToOpen) >= required)) {
      changes.minSolToOpen = required;
      notes.push(`Min SOL to open raised ${fmtTradingValue("minSolToOpen", current.minSolToOpen)} → ${required} SOL (size ${val.value} + gas reserve ${current.gasReserve ?? 0.2}).`);
    }
  }
  const after = { ...current, ...changes };
  if (after.trailingTakeProfit && Number(after.trailingDropPct) >= Number(after.trailingTriggerPct)) {
    warnings.push(`Trailing drop ${after.trailingDropPct}% ≥ trigger ${after.trailingTriggerPct}%: a trailing exit can land at or below break-even.`);
  }
  if (after.trailingTakeProfit && after.takeProfitFeePct != null && Number(after.takeProfitFeePct) <= Number(after.trailingTriggerPct)) {
    warnings.push(`Take profit ${after.takeProfitFeePct}% ≤ trailing trigger ${after.trailingTriggerPct}%: fixed TP fires before trailing arms.`);
  }
  return { changes, notes, warnings };
}

/**
 * Reasons a change set raises risk (empty = risk-reducing or neutral, one tap).
 * Risk-increasing: stop loss turned Off or made wider (more negative), deploy
 * size raised (above the current floor or ceiling), max positions raised,
 * trailing TP turned off.
 */
export function riskIncreases(changes, current) {
  const out = [];
  if ("stopLossPct" in changes) {
    const b = current.stopLossPct;
    const a = changes.stopLossPct;
    if (stopLossOff(a) && !stopLossOff(b)) out.push("turns the stop loss off");
    else if (!stopLossOff(a) && !stopLossOff(b) && a < b) out.push(`widens the stop loss (${b}% → ${a}%)`);
  }
  if ("deployAmountSol" in changes) {
    const a = changes.deployAmountSol;
    const floor = Number(current.deployAmountSol);
    const ceil = Number(current.maxDeployAmount);
    if (!(a <= floor) || !(a <= ceil)) out.push(`raises the deploy size (${Number.isFinite(floor) ? floor : "?"}${Number.isFinite(ceil) && ceil !== floor ? `–${ceil}` : ""} → ${a} SOL)`);
  }
  if ("maxPositions" in changes && !(changes.maxPositions <= Number(current.maxPositions))) {
    out.push(`raises max positions (${current.maxPositions} → ${changes.maxPositions})`);
  }
  if ("trailingTakeProfit" in changes && changes.trailingTakeProfit === false && current.trailingTakeProfit) {
    out.push("turns trailing TP off");
  }
  return out;
}

/** "Take profit: 5% → 7%" lines for the changed keys. */
export function describeChanges(changes, before) {
  return Object.keys(changes).map((k) => `${labelFor(k)}: ${fmtTradingValue(k, before[k])} → ${fmtTradingValue(k, changes[k])}`);
}

/**
 * Persist and apply a validated change set. Writes user-config.json first
 * (through persistUserConfig, the update_config write path) and only then
 * updates the running config, so a failed write changes nothing. Reschedules
 * the PnL watcher when its interval changed. Logs every change.
 *
 * deps: { config, persistUserConfig(changes), restartPnlWatcher(sec)?, log(cat, msg)?, source? }
 * Returns { ok, before, after, text, rescheduled } or { ok: false, error }.
 */
export function applyTradingSettings(changes, { config, persistUserConfig, restartPnlWatcher = null, log = () => {}, source = "telegram" }) {
  const clean = {};
  for (const [k, v] of Object.entries(changes || {})) {
    if (!TRADING_KEYS.includes(k)) return { ok: false, error: `${k} is not a trading setting` };
    const r = validateTradingValue(k, v);
    if (r.error) return { ok: false, error: r.error };
    clean[k] = r.value;
  }
  if (!Object.keys(clean).length) return { ok: false, error: "nothing to change" };
  const before = readTradingSettings(config);
  try {
    persistUserConfig(clean);
  } catch (e) {
    log("config_error", `Trading settings not saved (${source}): ${e.message}`);
    return { ok: false, error: `could not save user-config.json: ${e.message}` };
  }
  for (const [k, v] of Object.entries(clean)) {
    const [section, field] = CONFIG_KEY_MAP[k];
    config[section] ||= {};
    config[section][field] = v;
  }
  const lines = describeChanges(clean, before);
  for (const l of lines) log("config", `Trading setting (${source}): ${l}`);
  let rescheduled = false;
  if ("pnlWatcherIntervalSec" in clean && clean.pnlWatcherIntervalSec !== before.pnlWatcherIntervalSec && restartPnlWatcher) {
    try {
      rescheduled = restartPnlWatcher(clean.pnlWatcherIntervalSec) !== false;
      if (rescheduled) log("config", `PnL watcher rescheduled: every ${clean.pnlWatcherIntervalSec}s`);
    } catch (e) {
      log("config_error", `PnL watcher reschedule failed: ${e.message}`);
    }
  }
  return { ok: true, before, after: readTradingSettings(config), changes: clean, text: lines.join("; "), rescheduled };
}
