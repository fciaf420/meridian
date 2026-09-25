// all-settings.js — the Telegram "🧾 All settings" editor: every user-config
// (and gmgn-config) key config.js reads, grouped, typed, validated, risk-checked
// and applied live where the running config supports it.
//
// The key list is derived from config.js's own source (every `u.<key>`,
// `nullable("<key>")` and `gmgnValue/gmgnArray("<key>")` it reads), so a new key
// added there shows up here without a hand-written list. Live locations come
// from CONFIG_KEY_MAP first, then from where the key sits in the `config`
// object literal.
//
// Everything with side effects is injected (createAllSettings(deps)), so tests
// run against temp files and mocks.
import fs from "fs";
import { CONFIG_KEY_MAP } from "./runtime-helpers.js";
import { validateTradingValue, riskIncreases, readTradingSettings, TRADING_KEYS } from "./trading-settings.js";

// Never listed or editable: credentials, endpoints, owner identity.
export const SECRET_KEY_RE = /(api_?key|wallet_?key|private_?key|secret|password|passphrase|token$|rpc_?url|chat_?id|allowlist|^telegram)/i;

export const GROUPS = [
  ["mode", "Mode"],
  ["cap", "Capital & sizing"],
  ["exit", "Exits"],
  ["strat", "Strategy"],
  ["scrm", "Screening (Meteora)"],
  ["scrg", "Screening (GMGN)"],
  ["entry", "Entry filters"],
  ["sched", "Schedule"],
  ["llm", "LLM"],
  ["learn", "Learning"],
  ["usdc", "USDC mode"],
  ["other", "Other"],
];

const SIZING_FIELDS = new Set(["deployAmountSol", "minSolToOpen", "gasReserve", "positionSizePct", "positionSizeBase"]);
const OTHER_FIELDS = new Set(["pnlUnit", "priorityFeeLevel"]);
const SECTION_GROUP = {
  risk: "cap", strategy: "strat", screening: "scrm", gmgn: "scrg", entryFilters: "entry",
  schedule: "sched", llm: "llm", darwin: "learn", autoresearch: "learn", knowledgeBase: "learn",
  usdc: "usdc", web: "other",
};

/** Keys with a fixed set of valid values. `null` in a list means "unset / default". */
export const ENUMS = {
  strategy: ["spot", "bid_ask"],
  screeningSource: ["meteora", "gmgn", "both"],
  llmProvider: ["codex", "claude", "deepseek", "minimax", "openrouter"],
  priorityFeeLevel: ["Min", "Low", "Medium", "High", "VeryHigh", "UnsafeMax"],
  llmReasoningEffort: [null, "low", "medium", "high", "xhigh"],
  autoresearchReasoningEffort: ["low", "medium", "high", "xhigh"],
  timeframe: ["5m", "30m", "1h", "2h", "4h", "12h", "24h"],
  pnlUnit: ["sol", "usd"],
  positionSizeBase: ["total", "wallet"],
  direction: ["asc", "desc"],
  rangeDepthMode: ["ohlcv", "volatility"],
};

/** Structured keys edited in user-config.json directly (not listed here). */
const HIDDEN_KEYS = new Set(["ohlcvTiers"]);

/** Keys read only at startup: saved now, used after a restart. */
export const RESTART_KEYS = new Set(["llmProvider", "webPort"]);

/** Explicit numeric bounds; other numbers get generic checks (see validate). */
const BOUNDS = {
  managementIntervalMin: [1, 1440], screeningIntervalMin: [1, 1440], healthCheckIntervalMin: [1, 1440],
  positionSizePct: [0.01, 1], gasReserve: [0, 5], gasReserveSol: [0, 5],
  deployAmountUsd: [1, 100_000], maxDeployUsd: [1, 100_000], minUsdcToOpen: [0, 1_000_000],
  maxDeployAmount: [0.1, 100], temperature: [0, 2], maxTokens: [256, 200_000], maxSteps: [1, 100],
  emergencyPriceDropPct: [-100, -1], webPort: [1, 65_535], twapWindowMinutes: [5, 1440],
  ohlcvBufferMult: [1, 1.8], solanaTrackerDailyCap: [0, 2500],
};

/**
 * Parse config.js source → the keys it reads.
 * Returns [{ key, file: "user"|"gmgn"|"env", path: [section, field(, sub)] | null }].
 */
export function parseConfigKeys(src) {
  const out = [];
  const seen = new Set();
  const add = (key, file, pathArr) => {
    const id = `${file}:${key}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ key, file, path: pathArr });
  };
  const lines = String(src).split("\n");
  let inConfig = false;
  let section = null;
  let nested = null;
  for (const line of lines) {
    if (!inConfig) {
      if (/^export const config = \{/.test(line)) { inConfig = true; continue; }
      if (/^\s*(\/\/|\*)/.test(line)) continue;
      for (const m of line.matchAll(/\bu\.(\w+)\b(?!\?\.)/g)) add(m[1], "env", null);
      continue;
    }
    if (/^\};/.test(line)) { inConfig = false; section = null; continue; }
    let m;
    if ((m = /^ {2}(\w+):\s*\{/.exec(line))) { section = m[1]; nested = null; continue; }
    if (/^ {2}\},?/.test(line)) { section = null; continue; }
    if (!section) continue;
    if ((m = /^ {4}(\w+):\s*(?:\(\(\) => )?\{\s*$/.exec(line)) || (m = /^ {4}(\w+):\s*\{\s*$/.exec(line))) { nested = m[1]; continue; }
    if (nested && /^ {4}\}/.test(line)) { nested = null; continue; }
    const field = /^ {4}(\w+):/.exec(line)?.[1] ?? /^ {6}(\w+):/.exec(line)?.[1];
    if (!field) continue;
    const inner = /^ {6}/.test(line);
    // Inner lines of a call like getEffectiveMinSolToOpen({ … }) belong to the
    // parent field; the live location then comes from CONFIG_KEY_MAP.
    const pathArr = inner ? (nested ? [section, nested, field] : null) : [section, field];
    const g = /gmgn(?:Value|Array)\("(\w+)"/.exec(line);
    if (g) { add(g[1], "gmgn", pathArr); continue; }
    const n = /nullable\("(\w+)"/.exec(line);
    if (n) { add(n[1], "user", pathArr); continue; }
    const uref = /\bu\.(\w+)\b(\?\.)?/.exec(line);
    if (uref && !uref[2]) add(uref[1], "user", pathArr);
  }
  return out;
}

const getPath = (obj, p) => p.reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, p, v) {
  let o = obj;
  for (const k of p.slice(0, -1)) { o[k] ||= {}; o = o[k]; }
  o[p.at(-1)] = v;
}

export function fmtValue(v) {
  if (v === null || v === undefined) return "unset";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "(empty)";
  return String(v);
}

/**
 * deps: {
 *   config, source (config.js text; default: read it), lockedKeys, integerKeys,
 *   persistUserConfig(changes), persistGmgnConfig(changes),
 *   entryFilters: { normalize(key, v) → {value}|{error}, isLoosening(key, before, after) },
 *   dryRunInEnv, env (default process.env), onScheduleChange(key, value)?, log?
 * }
 */
export function createAllSettings(deps) {
  const config = deps.config;
  const env = deps.env ?? process.env;
  const log = deps.log ?? (() => {});
  const locked = deps.lockedKeys ?? new Set(["walletKey", "rpcUrl", "llmModel"]);
  const integers = deps.integerKeys ?? new Set();
  const source = deps.source ?? fs.readFileSync(new URL("./config.js", import.meta.url), "utf8");
  const entryKeys = new Set(Object.keys(config.entryFilters || {}));

  // ── registry ──
  const parsed = parseConfigKeys(source);
  const mappedUser = new Set(parsed.filter((e) => e.file === "user").map((e) => e.key));
  const entries = [];
  for (const e of parsed) {
    if (locked.has(e.key) || SECRET_KEY_RE.test(e.key) || HIDDEN_KEYS.has(e.key)) continue;
    if (e.file === "env" && mappedUser.has(e.key)) continue; // e.g. usdcMode → usdc.enabled
    const livePath = e.file === "user" && CONFIG_KEY_MAP[e.key] ? CONFIG_KEY_MAP[e.key] : e.path;
    const entry = { key: e.key, file: e.file === "gmgn" ? "gmgn" : "user", path: livePath, special: null };
    if (e.key === "dryRun") entry.special = "dryRun";
    const cur = currentOf(entry);
    if (cur !== null && typeof cur === "object" && !Array.isArray(cur)) continue; // nested objects aren't edited here
    entry.type = ENUMS[e.key] ? "enum"
      : entry.special === "dryRun" || typeof cur === "boolean" ? "boolean"
        : Array.isArray(cur) ? "list"
          : typeof cur === "number" ? "number"
            : cur === null || cur === undefined ? (/Model$/.test(e.key) ? "string" : "number")
              : "string";
    entry.nullable = cur === null || ["blockTransferFeeAbovePct", "twapSpikeMaxPct"].includes(e.key) || /Model$/.test(e.key);
    entry.enum = ENUMS[e.key] ?? null;
    entry.restart = RESTART_KEYS.has(e.key) || (!entry.path && entry.special !== "dryRun");
    const section = entry.path?.[0];
    const field = entry.path?.at(-1);
    entry.group = entry.special === "dryRun" ? "mode"
      : e.key === "llmProvider" ? "llm"
        : section === "management" ? (SIZING_FIELDS.has(field) ? "cap" : OTHER_FIELDS.has(field) ? "other" : "exit")
          : SECTION_GROUP[section] ?? "other";
    entry.id = entries.length.toString(36);
    entries.push(entry);
  }

  function currentOf(entry) {
    if (entry.special === "dryRun") return env.DRY_RUN === "true";
    if (entry.path) return getPath(config, entry.path);
    if (entry.key === "llmProvider") return env.LLM_PROVIDER ?? null;
    return undefined;
  }

  function describe(entry) {
    const t = entry.type;
    if (t === "boolean") return "on / off";
    if (t === "enum") return `one of: ${entry.enum.map((v) => (v === null ? "default" : v)).join(", ")}`;
    if (t === "list") return "comma-separated list";
    if (t === "string") return `text${entry.nullable ? ' ("off" clears it)' : ""}`;
    const b = BOUNDS[entry.key];
    const trading = TRADING_KEYS.includes(entry.key) ? tradingRange(entry.key) : null;
    const range = trading ?? (b ? `${b[0]}…${b[1]}` : /Pct$/.test(entry.key) ? "−100…1000" : "any finite number");
    return `${integers.has(entry.key) ? "whole number" : "number"}, ${range}${entry.nullable ? ' (or "off")' : ""}`;
  }

  function tradingRange(key) {
    return {
      takeProfitFeePct: "> 0 … 100", stopLossPct: "−100 … 0 (0 = off)", trailingTriggerPct: "> 0 … 100",
      trailingDropPct: "> 0 … < 100", outOfRangeWaitMinutes: "1…1440", deployAmountSol: "0.1…10",
      maxDeployAmount: "0.1…10", minSolToOpen: "> 0", maxPositions: "1…50", pnlWatcherIntervalSec: "5…3600",
    }[key] ?? null;
  }

  /** Parse + validate a raw value (button payload or typed text). → { value } | { error } */
  function validate(entry, raw) {
    const text = typeof raw === "string" ? raw.trim() : raw;
    const isOff = typeof text === "string" && /^(off|null|none|unset|default)$/i.test(text);
    switch (entry.type) {
      case "boolean": {
        if (typeof text === "boolean") return { value: text };
        if (/^(on|true|yes|1)$/i.test(String(text))) return { value: true };
        if (/^(off|false|no|0)$/i.test(String(text))) return { value: false };
        return { error: "send on or off" };
      }
      case "enum": {
        if (isOff && entry.enum.includes(null)) return { value: null };
        const hit = entry.enum.find((v) => v !== null && String(v).toLowerCase() === String(text).toLowerCase());
        return hit !== undefined ? { value: hit } : { error: `must be one of ${entry.enum.filter((v) => v !== null).join(", ")}` };
      }
      case "list": {
        const items = String(text).split(",").map((s) => s.trim()).filter(Boolean);
        if (items.length > 50 || items.some((s) => s.length > 64)) return { error: "at most 50 items of up to 64 characters" };
        return { value: items };
      }
      case "string": {
        if (isOff && entry.nullable) return { value: null };
        const s = String(text ?? "");
        if (!s || s.length > 200 || /[\n\r]/.test(s)) return { error: "must be one line of 1–200 characters" };
        return { value: s };
      }
      default: { // number
        if (isOff && entry.nullable) return { value: null };
        const n = typeof text === "number" ? text : /^-?\d+(\.\d+)?$/.test(String(text).replace(",", ".")) ? Number(String(text).replace(",", ".")) : NaN;
        if (!Number.isFinite(n)) return { error: `not a number${entry.nullable ? ' (or "off")' : ""}` };
        if (entryKeys.has(entry.key)) {
          const r = deps.entryFilters?.normalize?.(entry.key, n);
          return r?.error ? { error: r.error } : { value: r?.value ?? n };
        }
        if (TRADING_KEYS.includes(entry.key)) {
          if (entry.key === "stopLossPct" && n > 0) return { error: "stop loss must be negative (or 0 = off)" };
          const r = validateTradingValue(entry.key, n);
          return r.error ? { error: r.error } : { value: r.value };
        }
        if (integers.has(entry.key) && !Number.isInteger(n)) return { error: "must be a whole number" };
        const b = BOUNDS[entry.key] ?? (/Pct$/.test(entry.key) ? [-100, 1000] : null);
        if (b && (n < b[0] || n > b[1])) return { error: `must be between ${b[0]} and ${b[1]}` };
        const cur = currentOf(entry);
        if (!b && typeof cur === "number" && cur >= 0 && n < 0) return { error: "must not be negative" };
        return { value: n };
      }
    }
  }

  /** Reasons the change raises risk (empty = one tap). dryRun always confirms. */
  function risk(entry, value) {
    const before = currentOf(entry);
    const k = entry.key;
    if (entry.special === "dryRun") return [value ? "switches to DRY RUN (no transactions are sent)" : "switches to LIVE trading with real funds"];
    if (entryKeys.has(k)) return deps.entryFilters?.isLoosening?.(k, before, value) ? ["turns an entry-safety guard off or loosens it"] : [];
    if (["stopLossPct", "deployAmountSol", "maxPositions", "trailingTakeProfit"].includes(k)) {
      return riskIncreases({ [k]: value }, readTradingSettings(config));
    }
    const up = (label) => (Number(value) > Number(before) ? [`raises ${label} (${fmtValue(before)} → ${fmtValue(value)})`] : []);
    if (k === "maxDeployAmount") return up("the deploy ceiling");
    if (k === "positionSizePct") return up("the position size");
    if (k === "positionSizeBase") return value === "total" && before !== "total" ? ["sizes deploys from the whole portfolio (wallet + open positions), so deploys get larger"] : [];
    if (k === "deployAmountUsd" || k === "maxDeployUsd") return up("the USDC deploy size");
    if (k === "gasReserve" || k === "gasReserveSol") return Number(value) < Number(before) ? ["lowers the gas reserve"] : [];
    if (k === "emergencyPriceDropPct") return Number(value) < Number(before) ? [`widens the emergency stop (${before}% → ${value}%)`] : [];
    if (k === "usdcMode") return value !== before ? [`turns USDC mode ${value ? "on" : "off"} (changes how deploys are funded)`] : [];
    return [];
  }

  /** Persist, then apply live. → { ok, text, restart, before, after } | { ok: false, error } */
  function apply(entry, value) {
    const before = currentOf(entry);
    try {
      if (entry.file === "gmgn") deps.persistGmgnConfig({ [entry.key]: value });
      else deps.persistUserConfig({ [entry.key]: value });
    } catch (e) {
      log("config_error", `Setting ${entry.key} not saved (telegram): ${e.message}`);
      return { ok: false, error: `could not save ${entry.file === "gmgn" ? "gmgn-config.json" : "user-config.json"}: ${e.message}` };
    }
    if (entry.special === "dryRun") env.DRY_RUN = value ? "true" : "false";
    else if (entry.path && !RESTART_KEYS.has(entry.key)) setPath(config, entry.path, value);
    const text = `${entry.key}: ${fmtValue(before)} → ${fmtValue(value)}`;
    log("config", `Setting (telegram, ${entry.file === "gmgn" ? "gmgn-config.json" : "user-config.json"}): ${text}${entry.restart ? " (applies after restart)" : ""}`);
    if (entry.path?.[0] === "schedule" && value !== before) {
      try { deps.onScheduleChange?.(entry.key, value); } catch (e) { log("config_error", `Reschedule after ${entry.key} failed: ${e.message}`); }
    }
    return { ok: true, text, restart: entry.restart, before, after: value };
  }

  const byId = new Map(entries.map((e) => [e.id, e]));
  return {
    entries,
    groups: () => GROUPS.map(([id, label]) => ({ id, label, entries: entries.filter((e) => e.group === id) })).filter((g) => g.entries.length),
    get: (id) => byId.get(id) ?? null,
    find: (key) => entries.find((e) => e.key === key) ?? null,
    current: currentOf,
    describe,
    validate,
    risk,
    apply,
    dryRunInEnv: !!deps.dryRunInEnv,
  };
}
