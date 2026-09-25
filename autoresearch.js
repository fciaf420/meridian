/**
 * Autoresearch — automated prompt optimization system inspired by ATLAS.
 *
 * Identifies the worst-performing prompt section, generates a targeted
 * modification via a cheap LLM, tests it over N real closes, and
 * keeps/reverts based on actual PnL improvement.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";
import {
  getPromptSectionText,
  getDefaultPromptSectionText,
  setPromptSectionOverride,
  clearPromptSectionOverride,
} from "./prompt.js";
import { loadWeights, getWeightsSummary } from "./signal-weights.js";
import {
  getDefaultModelForProvider,
  getChatCompletionsEndpoint,
  getLlmProvider,
  getProviderApiKey,
  runCodexExec,
} from "./llm-provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// MERIDIAN_AUTORESEARCH_FILE lets tests point at a scratch copy instead of the repo file.
const AUTORESEARCH_FILE = process.env.MERIDIAN_AUTORESEARCH_FILE || path.join(__dirname, "autoresearch.json");

// Hard cap on one generator call (HTTP or CLI). Autoresearch never runs on the close
// path, but a hung call would still hold the single-experiment lock forever.
export const AUTORESEARCH_LLM_TIMEOUT_MS = 60_000;

// ─── Persistence ─────────────────────────────────────────────

const DEFAULTS = {
  enabled: false,
  experiments: [],       // history of all experiments
  active: null,          // currently running experiment (or null)
  cooldownRemaining: 0,  // closes remaining before next experiment
  kept_overrides: {},    // section → text for permanently kept experiment overrides
  kept_meta: {},         // section → { experiment_id, kept_at, strategy, default_hash }
  quarantined_overrides: {}, // section → { text, reason, quarantined_at, strategy, ... } (never applied)
  reverted_overrides: [],    // operator-reverted kept overrides, newest last
};

const freshDefaults = () => structuredClone(DEFAULTS);

const MANAGEMENT_THRESHOLD_KEYS = ["stopLossPct", "takeProfitFeePct", "trailingTriggerPct", "trailingDropPct"];

/**
 * Fingerprint of the threshold VALUES that shape which pools get deployed and
 * when they exit. evolveThresholds rewrites _lastEvolved/_positionsAtEvolution
 * every 5 closes even when it changes nothing (lessons.js "Always update the
 * counter"), so those counters must not be what invalidates an experiment.
 */
export function thresholdFingerprint(cfg = config) {
  const screening = cfg.screening || {};
  const management = cfg.management || {};
  const sorted = Object.fromEntries(Object.keys(screening).sort().map((k) => [k, screening[k] ?? null]));
  const mgmt = Object.fromEntries(MANAGEMENT_THRESHOLD_KEYS.map((k) => [k, management[k] ?? null]));
  return JSON.stringify({ screening: sorted, management: mgmt, activeStrategy: cfg.strategy?.activeStrategy ?? null });
}

export function getEnvironmentSnapshot(cfg = config) {
  let weightsMeta = {};
  try {
    const weights = loadWeights();
    weightsMeta = {
      last_recalc: weights.last_recalc ?? null,
      recalc_count: weights.recalc_count ?? 0,
    };
  } catch {
    weightsMeta = {
      last_recalc: null,
      recalc_count: 0,
    };
  }

  return {
    thresholds_fingerprint: thresholdFingerprint(cfg),
    // Darwin metadata is recorded for the audit trail only; weight recalcs
    // change prompt summary text, not hard filters, so they don't invalidate.
    darwin_last_recalc: weightsMeta.last_recalc,
    darwin_recalc_count: weightsMeta.recalc_count,
  };
}

/**
 * True only when a threshold VALUE changed since the snapshot was taken.
 * Legacy snapshots (evolution counters, no fingerprint) never invalidate.
 */
export function environmentChangedSince(snapshot = {}, cfg = config) {
  if (snapshot?.thresholds_fingerprint == null) return false;
  return thresholdFingerprint(cfg) !== snapshot.thresholds_fingerprint;
}

function getTrialPositionsForExperiment(experiment, perfData) {
  if (!experiment) return [];

  if (experiment.section === "manager_logic") {
    return perfData.filter((p) => {
      const closedAt = p.recorded_at || p.closed_at;
      return closedAt ? closedAt >= experiment.started_at : false;
    });
  }

  return perfData.slice(experiment.started_at_position)
    .filter((p) => {
      const deployedAt = p.deployed_at;
      if (deployedAt) return deployedAt >= experiment.started_at;
      const closedAt = p.recorded_at || p.closed_at;
      return closedAt ? closedAt >= experiment.started_at : true;
    });
}

// Set when autoresearch.json is present but unparseable. While degraded we
// refuse to overwrite the (recoverable) bad file with defaults.
let _autoresearchDegraded = false;

export function loadAutoresearch() {
  if (!fs.existsSync(AUTORESEARCH_FILE)) {
    // File absent — safe to create fresh defaults.
    saveAutoresearch(freshDefaults());
    return freshDefaults();
  }
  try {
    const data = JSON.parse(fs.readFileSync(AUTORESEARCH_FILE, "utf8"));
    // Merge with (fresh copies of) DEFAULTS so existing files gain new fields
    // without later mutations leaking into the shared DEFAULTS object.
    return { ...freshDefaults(), ...data };
  } catch (err) {
    // File PRESENT but corrupt: do NOT silently fall back to DEFAULTS (a later
    // save would wipe experiment history and kept overrides). Preserve the bad
    // file for recovery and enter a degraded, read-only state.
    if (!_autoresearchDegraded) {
      try {
        const backup = `${AUTORESEARCH_FILE}.corrupt-${Date.now()}`;
        fs.copyFileSync(AUTORESEARCH_FILE, backup);
        log("autoresearch", `autoresearch.json is corrupt (${err.message}); preserved as ${backup}. Refusing to overwrite until recovered.`);
      } catch (backupErr) {
        log("autoresearch", `autoresearch.json is corrupt (${err.message}) and backup failed: ${backupErr.message}. Refusing to overwrite until recovered.`);
      }
    }
    _autoresearchDegraded = true;
    throw new Error(`autoresearch.json is corrupt and was preserved for recovery: ${err.message}`);
  }
}

export function saveAutoresearch(data) {
  // Never persist over a corrupt-but-present file; that would destroy
  // recoverable history. Skip saves until the file is restored.
  if (_autoresearchDegraded) {
    log("autoresearch", "Skipping autoresearch.json save: file is in degraded (corrupt) state. Restore or remove the corrupt backup to re-enable saves.");
    return;
  }
  fs.writeFileSync(AUTORESEARCH_FILE, serializeAutoresearch(data));
}

/**
 * 2-space JSON with non-ASCII escaped as \uXXXX. That is the format the
 * tracked file has always used, so rewriting it leaves the experiment history
 * byte-identical.
 */
export function serializeAutoresearch(data) {
  return JSON.stringify(data, null, 2)
    .replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// ─── Override provenance, staleness and migration ────────────

const LEGACY_QUARANTINE_MIGRATION = "quarantine_legacy_kept_overrides_v1";
const LEGACY_QUARANTINE_REASON =
  "Kept by the pre-A/B loop: each verdict compared one 7-close window against a different 7-close window " +
  "with no concurrent control (a placebo is 'kept' ~45% of the time), all 32 experiments ran 2026-03-27..04-04 " +
  "under the bid_ask default, and the text was hand-edited after it was tested. Quarantined: inactive until an " +
  "operator restores it (/autoresearch restore <section>).";

export function hashText(text) {
  return createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);
}

/** Current default-template fingerprint for a section (detects later prompt.js edits). */
export function defaultSectionHash(section) {
  const text = getDefaultPromptSectionText(section);
  return text == null ? null : hashText(text);
}

/**
 * One-time migration: move the legacy kept_overrides into quarantined_overrides
 * and close any legacy (pre-A/B) active experiment. Mutates `state`; returns
 * true when something changed. Idempotent: a marker in state.migrations
 * makes every later call a no-op. Experiments are never rewritten.
 */
export function migrateAutoresearchState(state, now = new Date()) {
  if (!state || typeof state !== "object") return false;
  state.migrations = state.migrations || {};
  if (state.migrations[LEGACY_QUARANTINE_MIGRATION]) return false;
  const at = now.toISOString();
  const kept = state.kept_overrides || {};
  state.quarantined_overrides = state.quarantined_overrides || {};
  const experiments = Array.isArray(state.experiments) ? state.experiments : [];
  for (const [section, text] of Object.entries(kept)) {
    state.quarantined_overrides[section] = {
      text,
      reason: LEGACY_QUARANTINE_REASON,
      quarantined_at: at,
      source: "kept_overrides",
      strategy: "bid_ask",
      default_hash: null,
      experiment_ids: experiments.filter((e) => e?.section === section && e?.status === "kept").map((e) => e.id),
    };
  }
  state.kept_overrides = {};
  state.kept_meta = {};
  state.migrations[LEGACY_QUARANTINE_MIGRATION] = at;
  return true;
}

/**
 * Reasons an override may no longer fit the running bot (empty = fresh).
 * `meta` is the provenance recorded when it was kept: { strategy, default_hash }.
 */
export function overrideStaleness(section, meta, cfg = config) {
  const reasons = [];
  const current = cfg.strategy?.activeStrategy ?? null;
  if (!meta) {
    reasons.push("no provenance recorded (legacy override)");
  } else {
    if (meta.strategy && current && meta.strategy !== current) {
      reasons.push(`generated under ${meta.strategy}, current strategy is ${current}`);
    }
    if (meta.default_hash && meta.default_hash !== defaultSectionHash(section)) {
      reasons.push("the prompt.js default for this section changed after it was kept");
    } else if (!meta.default_hash) {
      reasons.push("no default fingerprint recorded, so later prompt.js edits can't be detected");
    }
  }
  if (section === "range_selection" && current === "evil_panda") {
    reasons.push("inert under evil_panda (the Evil Panda range text takes precedence)");
  }
  return reasons;
}

/** Set-based line diff: lines only in `before` (removed) and only in `after` (added). */
export function lineDiff(before, after) {
  const norm = (t) => String(t ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const a = norm(before);
  const b = norm(after);
  const aSet = new Set(a);
  const bSet = new Set(b);
  return {
    removed: a.filter((l) => !bSet.has(l)),
    added: b.filter((l) => !aSet.has(l)),
    total: a.length,
  };
}

function diffSummary(section, text) {
  const d = lineDiff(getDefaultPromptSectionText(section), text);
  return { added: d.added, removed: d.removed, summary: `+${d.added.length} / -${d.removed.length} lines vs default` };
}

// ─── Startup Restoration ─────────────────────────────────────

/**
 * Apply persisted overrides to the in-memory prompt. Overrides are inert
 * unless autoresearch is enabled: with it off, the bot runs on the prompt.js
 * defaults and nothing in autoresearch.json reaches the agent.
 */
export function applyStartupOverrides(state, cfg = config) {
  const applied = [];
  if (cfg?.autoresearch?.enabled !== true) {
    const n = Object.keys(state?.kept_overrides || {}).length;
    if (n || state?.active) {
      log("autoresearch", `Autoresearch disabled — ${n} kept override(s)${state?.active ? " and the active experiment" : ""} left inactive`);
    }
    return applied;
  }
  for (const [section, text] of Object.entries(state.kept_overrides || {})) {
    setPromptSectionOverride(section, text);
    applied.push(section);
    const stale = overrideStaleness(section, state.kept_meta?.[section], cfg);
    log("autoresearch", `Restored kept override: ${section}${stale.length ? ` — WARNING stale: ${stale.join("; ")}` : ""}`);
  }
  if (state.active?.modified_text && state.active?.section) {
    setPromptSectionOverride(state.active.section, state.active.modified_text);
    applied.push(`active:${state.active.section}`);
    log("autoresearch", `Restored active experiment override: ${state.active.id} (${state.active.section})`);
  }
  return applied;
}

try {
  const state = loadAutoresearch();
  if (migrateAutoresearchState(state)) {
    saveAutoresearch(state);
    const q = Object.keys(state.quarantined_overrides || {});
    log("autoresearch", `Migrated autoresearch.json: legacy kept overrides quarantined (${q.join(", ") || "none"})`);
  }
  applyStartupOverrides(state, config);
} catch { /* ignore on first load if file doesn't exist yet */ }

// ─── Operator commands (Telegram + REPL: /autoresearch …) ────

const SECTIONS = ["screener_criteria", "manager_logic", "range_selection"];

function fmtOverrideBlock(section, text, meta, cfg, { full = false } = {}) {
  const d = diffSummary(section, text);
  const stale = overrideStaleness(section, meta, cfg);
  const lines = [`• ${section}: ${d.summary}${meta?.experiment_id ? ` (from ${meta.experiment_id})` : ""}`];
  if (stale.length) lines.push(`  ⚠ stale: ${stale.join("; ")}`);
  const cap = full ? Infinity : 6;
  for (const l of d.removed.slice(0, cap)) lines.push(`  - ${l}`);
  for (const l of d.added.slice(0, cap)) lines.push(`  + ${l}`);
  if (!full && (d.removed.length > cap || d.added.length > cap)) lines.push(`  … /autoresearch show ${section} for the full text`);
  if (full) lines.push("", "Full text:", text);
  return lines.join("\n");
}

const AUTORESEARCH_HELP = [
  "/autoresearch — status",
  "/autoresearch list — kept and quarantined overrides with a diff vs the default",
  "/autoresearch show <section> — full text + diff (kept, else quarantined)",
  "/autoresearch revert <section> — deactivate a kept override (kept in reverted history)",
  "/autoresearch restore <section> — re-keep the latest reverted or quarantined text",
].join("\n");

/**
 * Operator path for overrides. Returns plain text (callers escape for
 * Telegram HTML). Not exposed as an LLM tool on purpose.
 */
export function handleAutoresearchCommand(argString = "", cfg = config) {
  const [sub = "status", sectionArg] = String(argString).trim().split(/\s+/).filter(Boolean);
  const cmd = sub.toLowerCase();
  let state;
  try {
    state = loadAutoresearch();
  } catch (e) {
    return `autoresearch.json is unreadable: ${e.message}`;
  }
  const enabled = cfg?.autoresearch?.enabled === true;
  const kept = state.kept_overrides || {};
  const quarantined = state.quarantined_overrides || {};
  const needSection = () => (SECTIONS.includes(sectionArg) ? null : `Unknown or missing section. Use one of: ${SECTIONS.join(", ")}`);

  if (cmd === "help") return AUTORESEARCH_HELP;

  if (cmd === "status") {
    const lines = [
      `Autoresearch: ${enabled ? "enabled" : "disabled (overrides inactive)"} | strategy: ${cfg.strategy?.activeStrategy ?? "?"}`,
      `Kept overrides: ${Object.keys(kept).join(", ") || "none"}`,
      `Quarantined: ${Object.keys(quarantined).join(", ") || "none"}`,
      `Active experiment: ${state.active ? `${state.active.id} (${state.active.section})` : "none"}`,
      `Experiments recorded: ${(state.experiments || []).length}`,
      "",
      AUTORESEARCH_HELP,
    ];
    return lines.join("\n");
  }

  if (cmd === "list") {
    const lines = [`Kept overrides (${enabled ? "applied" : "inactive while autoresearch is disabled"}):`];
    if (!Object.keys(kept).length) lines.push("  none");
    for (const [section, text] of Object.entries(kept)) lines.push(fmtOverrideBlock(section, text, state.kept_meta?.[section], cfg));
    lines.push("", "Quarantined (never applied):");
    if (!Object.keys(quarantined).length) lines.push("  none");
    for (const [section, q] of Object.entries(quarantined)) {
      lines.push(fmtOverrideBlock(section, q.text, q, cfg));
      lines.push(`  quarantined ${q.quarantined_at}: ${q.reason}`);
    }
    return lines.join("\n");
  }

  if (cmd === "show") {
    const bad = needSection();
    if (bad) return bad;
    if (kept[sectionArg]) return `Kept override\n${fmtOverrideBlock(sectionArg, kept[sectionArg], state.kept_meta?.[sectionArg], cfg, { full: true })}`;
    if (quarantined[sectionArg]) return `Quarantined override\n${fmtOverrideBlock(sectionArg, quarantined[sectionArg].text, quarantined[sectionArg], cfg, { full: true })}`;
    return `No kept or quarantined override for ${sectionArg}; the prompt.js default is in use.`;
  }

  if (cmd === "revert") {
    const bad = needSection();
    if (bad) return bad;
    if (!kept[sectionArg]) return `No kept override for ${sectionArg}.`;
    state.reverted_overrides = Array.isArray(state.reverted_overrides) ? state.reverted_overrides : [];
    state.reverted_overrides.push({
      section: sectionArg,
      text: kept[sectionArg],
      meta: state.kept_meta?.[sectionArg] ?? null,
      reverted_at: new Date().toISOString(),
    });
    delete state.kept_overrides[sectionArg];
    if (state.kept_meta) delete state.kept_meta[sectionArg];
    saveAutoresearch(state);
    clearPromptSectionOverride(sectionArg);
    return `Reverted ${sectionArg}: the prompt.js default is live again. /autoresearch restore ${sectionArg} undoes this.`;
  }

  if (cmd === "restore") {
    const bad = needSection();
    if (bad) return bad;
    if (kept[sectionArg]) return `${sectionArg} already has a kept override; /autoresearch revert ${sectionArg} first.`;
    const reverted = (state.reverted_overrides || []).filter((r) => r.section === sectionArg);
    let text, meta, from;
    if (reverted.length) {
      const last = reverted[reverted.length - 1];
      text = last.text;
      meta = last.meta;
      from = "reverted history";
      state.reverted_overrides = state.reverted_overrides.filter((r) => r !== last);
    } else if (quarantined[sectionArg]) {
      const q = quarantined[sectionArg];
      text = q.text;
      meta = { strategy: q.strategy ?? null, default_hash: q.default_hash ?? null, experiment_id: q.experiment_ids?.at(-1) ?? null, restored_from: "quarantine" };
      from = "quarantine";
      delete state.quarantined_overrides[sectionArg];
    } else {
      return `Nothing to restore for ${sectionArg}.`;
    }
    state.kept_overrides = { ...(state.kept_overrides || {}), [sectionArg]: text };
    state.kept_meta = { ...(state.kept_meta || {}), [sectionArg]: { ...(meta || {}), restored_at: new Date().toISOString() } };
    saveAutoresearch(state);
    if (enabled) setPromptSectionOverride(sectionArg, text);
    const stale = overrideStaleness(sectionArg, state.kept_meta[sectionArg], cfg);
    return [
      `Restored ${sectionArg} from ${from}. ${enabled ? "Applied now." : "Inactive until autoresearch is enabled."}`,
      stale.length ? `⚠ stale: ${stale.join("; ")}` : null,
    ].filter(Boolean).join("\n");
  }

  return `Unknown subcommand "${sub}".\n${AUTORESEARCH_HELP}`;
}

/** Dashboard view of kept/quarantined overrides: text, diff vs default, staleness. */
export function describeOverrides(state, cfg = config) {
  const enabled = cfg?.autoresearch?.enabled === true;
  const describe = (section, text, meta, status) => {
    const d = diffSummary(section, text);
    return {
      section,
      status,
      applied: status === "kept" && enabled,
      text,
      summary: d.summary,
      added: d.added,
      removed: d.removed,
      stale: overrideStaleness(section, meta, cfg),
      experiment_id: meta?.experiment_id ?? meta?.experiment_ids?.at?.(-1) ?? null,
      reason: meta?.reason ?? null,
    };
  };
  return {
    kept: Object.entries(state?.kept_overrides || {}).map(([s, t]) => describe(s, t, state.kept_meta?.[s], "kept")),
    quarantined: Object.entries(state?.quarantined_overrides || {}).map(([s, q]) => describe(s, q.text, q, "quarantined")),
  };
}

/** Escape for Telegram's HTML parse mode and split under its 4096-char cap. */
export function autoresearchTelegramChunks(text, size = 3500) {
  const s = String(text ?? "");
  const out = [];
  for (let i = 0; i < s.length; i += size) {
    out.push(s.slice(i, i + size).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
  }
  return out;
}

// ─── Main Entry Point ────────────────────────────────────────

// In-process single-flight lock. Two closes arriving while the generator is
// thinking must never both see active=null and start two experiments (M3).
let _running = null;

/**
 * Called (fire-and-forget) after each close is recorded. Evaluates the active
 * experiment or starts a new one. Never awaited by the close path: the returned
 * promise exists for tests and always resolves (errors are logged, not thrown).
 */
export function maybeRunAutoresearch(perfData, lessons, cfg) {
  if (cfg?.autoresearch?.enabled !== true) return Promise.resolve({ skipped: "disabled" });
  if (_running) {
    log("autoresearch", "Previous autoresearch run still in progress — skipping this close (the next close re-evaluates)");
    return Promise.resolve({ skipped: "busy" });
  }
  _running = (async () => {
    try {
      await runAutoresearchOnce(perfData, lessons, cfg);
      return { ran: true };
    } catch (e) {
      log("autoresearch", `Error: ${e.message}`);
      return { error: e.message };
    } finally {
      _running = null;
    }
  })();
  return _running;
}

/** True while a run holds the lock (for tests and status output). */
export function isAutoresearchRunning() {
  return _running !== null;
}

async function runAutoresearchOnce(perfData, lessons, cfg) {
  const state = loadAutoresearch();

  if (state.active) {
    await evaluateExperiment(perfData, cfg, state);
  } else {
    // Decrement cooldown
    if (state.cooldownRemaining > 0) {
      state.cooldownRemaining--;
      saveAutoresearch(state);
      log("autoresearch", `Cooldown: ${state.cooldownRemaining} closes remaining`);
      return;
    }
    await analyzeAndGenerate(perfData, lessons, cfg, state);
  }
}

// ─── Analyze + Generate Experiment ───────────────────────────

/**
 * Sections an experiment may target under the current strategy. Under
 * evil_panda, getRangeSelectionText returns the fixed Evil Panda text before
 * it looks at any override (PR #9), so a range_selection edit would be a
 * placebo that silently activates if the strategy is ever switched back.
 */
export function eligibleSections(cfg = config) {
  const sections = ["screener_criteria", "manager_logic"];
  if (cfg?.strategy?.activeStrategy !== "evil_panda") sections.push("range_selection");
  return sections;
}

/** Map recent losing closes to the prompt section most likely responsible. */
export function attributeLosses(recent) {
  const sectionLosses = { screener_criteria: [], manager_logic: [], range_selection: [] };
  for (const p of recent) {
    if ((p.pnl_usd ?? 0) >= 0) continue; // skip winners
    if (p.pnl_unknown) continue;          // a 0 placeholder, not a measured loss

    const reason = (p.close_reason || "").toLowerCase();

    if (reason.includes("stop_loss") || reason.includes("trailing_tp") || reason.includes("oor downside")) {
      sectionLosses.manager_logic.push(p);
    } else if (reason.includes("oor upside")) {
      // Checked BEFORE range efficiency: a single-sided-below position that went
      // OOR upside always has low range efficiency, but wider range only adds
      // bins below and cannot catch an upside move. That is a strategy/screening
      // problem, so bid_ask and SOL-only spot go to the screener.
      const strat = (p.strategy || "").toLowerCase();
      const twoSided = p.sol_split_pct != null && p.sol_split_pct < 100;
      if (strat.includes("bid_ask") || (strat === "spot" && !twoSided)) {
        sectionLosses.screener_criteria.push(p);
      } else {
        sectionLosses.range_selection.push(p);
      }
    } else if ((p.range_efficiency ?? 100) < 30) {
      sectionLosses.range_selection.push(p);
    } else {
      sectionLosses.screener_criteria.push(p);
    }
  }
  return sectionLosses;
}

// A line is protected when it states a binding rule. Candidates must keep every
// protected line verbatim and may not add new ones (added HARD rules can never
// be removed by a later experiment, which is how the 1h-appreciation filter
// ratcheted from 25% down to 0.5%).
const PROTECTED_LINE = /HARD RULE|HARD SKIP|\bMUST\b|\bNEVER\b/;

/**
 * Validate a generated candidate against the section it replaces.
 * Returns null when acceptable, otherwise the rejection reason.
 */
export function validateCandidate(original, modified, cfg = config) {
  const maxDiffPct = cfg?.autoresearch?.maxDiffPct ?? 30;
  const origLines = String(original ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const modLines = String(modified ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!modLines.length) return "empty candidate";
  const modSet = new Set(modLines);
  const origSet = new Set(origLines);

  const dropped = origLines.filter((l) => PROTECTED_LINE.test(l) && !modSet.has(l));
  if (dropped.length) return `changes or drops a protected line: "${dropped[0].slice(0, 100)}"`;
  const addedProtected = modLines.filter((l) => PROTECTED_LINE.test(l) && !origSet.has(l));
  if (addedProtected.length) return `adds a new binding rule: "${addedProtected[0].slice(0, 100)}"`;

  if (/^-{3,}$/m.test(String(modified))) return "contains --- delimiter lines";

  const placeholders = (t) => new Set(String(t).match(/\$\{\w+\}/g) || []);
  const missing = [...placeholders(original)].filter((ph) => !placeholders(modified).has(ph));
  if (missing.length) return `drops template placeholder(s): ${missing.join(", ")}`;

  const { removed, added } = lineDiff(original, modified);
  const changed = Math.max(removed.length, added.length);
  const pct = (changed / Math.max(origLines.length, 1)) * 100;
  if (pct > maxDiffPct) return `diff too large: ${changed}/${origLines.length} lines (${pct.toFixed(0)}% > ${maxDiffPct}%)`;
  return null;
}

async function analyzeAndGenerate(perfData, lessons, cfg, state) {
  const minCloses = cfg.autoresearch?.minClosesPerTrial ?? 7;

  // Need at least 15 closes to analyze, or at minimum minCloses * 2
  if (perfData.length < Math.max(15, minCloses * 2)) {
    log("autoresearch", `Not enough data (${perfData.length} closes) — skipping`);
    return;
  }

  // 1. Attribute recent losses to prompt sections
  const sectionLosses = attributeLosses(perfData.slice(-15));

  // 2. Pick the worst section — with rotation to avoid optimizing the same section repeatedly.
  // Sections whose text the agent never sees under the current strategy are skipped.
  const allowed = new Set(eligibleSections(cfg));
  const sections = Object.entries(sectionLosses).filter(([s, losses]) => allowed.has(s) && losses.length > 0);
  if (sections.length === 0) {
    log("autoresearch", `No attributed losses in an eligible section (${[...allowed].join(", ")}) — nothing to optimize`);
    return;
  }

  // Check last N experiments — if the same section was targeted 3+ times in a row, rotate
  const MAX_CONSECUTIVE = 3;
  const recentSections = (state.experiments || []).slice(-MAX_CONSECUTIVE).map(e => e.section);
  const lastSection = recentSections[0];
  const allSame = recentSections.length >= MAX_CONSECUTIVE && recentSections.every(s => s === lastSection);

  // Sort by loss count descending
  sections.sort((a, b) => b[1].length - a[1].length);

  let worstSection, worstCount;
  if (allSame && sections.length > 1) {
    // Force rotation to the second-worst section
    [worstSection, { length: worstCount }] = [sections[1][0], { length: sections[1][1].length }];
    log("autoresearch", `Rotating away from ${lastSection} (${MAX_CONSECUTIVE}x consecutive) → trying ${worstSection}`);
  } else {
    [worstSection, { length: worstCount }] = [sections[0][0], { length: sections[0][1].length }];
  }

  log("autoresearch", `Worst section: ${worstSection} (${worstCount} attributed losses)`);

  const minAttributedLosses = cfg.autoresearch?.minAttributedLosses ?? 3;
  if (worstCount < minAttributedLosses) {
    log("autoresearch", `Only ${worstCount} attributed losses for ${worstSection} (need ${minAttributedLosses}) — skipping`);
    return;
  }

  // 3. Read current prompt text for that section
  const currentText = getPromptSectionText(worstSection);
  if (!currentText) {
    log("autoresearch", `Could not read section text for "${worstSection}" — skipping`);
    return;
  }

  // 4. Generate modification via LLM with KB context
  const failures = sectionLosses[worstSection];
  const failureDesc = failures
    .map(f => `- ${f.pool_name || "unknown"}: PnL ${f.pnl_pct}%, reason: ${f.close_reason || "unknown"}, strategy: ${f.strategy || "?"}, volatility: ${f.volatility || "?"}`)
    .join("\n");

  // Search KB for patterns related to the failing pools/strategies
  let kbContext = "";
  try {
    const { searchArticles, readArticle } = await import("./knowledge-base.js");
    const kbQueries = new Set();
    for (const f of failures) {
      if (f.pool_name) kbQueries.add(f.pool_name.replace(/-SOL$/, ""));
      if (f.strategy) kbQueries.add(f.strategy);
      if (f.close_reason?.includes("OOR")) kbQueries.add("oor");
    }
    kbQueries.add(worstSection.replace("_", " "));

    const seen = new Set();
    const kbSnippets = [];
    for (const q of kbQueries) {
      const results = searchArticles(q);
      for (const r of (results.results || []).slice(0, 3)) {
        if (seen.has(r.path)) continue;
        seen.add(r.path);
        const article = readArticle(r.path);
        if (article?.content) {
          kbSnippets.push(`--- ${r.path} ---\n${article.content.slice(0, 500)}`);
        }
        if (kbSnippets.length >= 8) break;
      }
      if (kbSnippets.length >= 8) break;
    }
    if (kbSnippets.length > 0) {
      kbContext = `\n\nKNOWLEDGE BASE CONTEXT (relevant articles from prior experience):\n${kbSnippets.join("\n\n")}`;
    }
  } catch (e) {
    log("autoresearch", `KB lookup failed (non-fatal): ${e.message}`);
  }

  const llmModel = cfg.autoresearch?.llmModel ?? getDefaultModelForProvider(getLlmProvider());
  let hypothesis, modifiedText;

  try {
    const result = await _generator(llmModel, worstSection, worstCount, currentText, failureDesc + kbContext);
    hypothesis = result.hypothesis;
    modifiedText = result.modifiedText;
  } catch (e) {
    log("autoresearch", `LLM call failed: ${e.message}`);
    return;
  }

  if (!modifiedText || modifiedText.trim() === currentText.trim()) {
    log("autoresearch", "LLM returned identical or empty text — skipping");
    return;
  }

  // Reject before anything goes live. A cooldown stops the next close from
  // immediately asking the generator again.
  const invalid = validateCandidate(currentText, modifiedText, cfg);
  if (invalid) {
    log("autoresearch", `Rejected candidate for ${worstSection} (never went live): ${invalid}`);
    try {
      const fresh = loadAutoresearch();
      if (!fresh.active) {
        fresh.cooldownRemaining = cfg.autoresearch?.cooldownCloses ?? 5;
        saveAutoresearch(fresh);
      }
    } catch { /* degraded file: nothing to record */ }
    return;
  }

  // 5. Compute baseline from last N positions
  const baselinePositions = perfData.slice(-minCloses);
  const baselineWins = baselinePositions.filter(p => (p.pnl_usd ?? 0) > 0).length;
  const baselineWR = baselinePositions.length > 0
    ? (baselineWins / baselinePositions.length) * 100
    : 0;
  const baselineAvgPnl = baselinePositions.length > 0
    ? baselinePositions.reduce((s, p) => s + (p.pnl_pct ?? 0), 0) / baselinePositions.length
    : 0;

  // 6. Create experiment
  const experiment = {
    id: `exp_${Date.now()}`,
    section: worstSection,
    hypothesis: hypothesis || "Targeted modification to reduce losses",
    original_text: currentText,
    modified_text: modifiedText,
    started_at: new Date().toISOString(),
    started_at_position: perfData.length,
    baseline: {
      win_rate: Math.round(baselineWR * 10) / 10,
      avg_pnl_pct: Math.round(baselineAvgPnl * 100) / 100,
      positions: baselinePositions.length,
    },
    trial: {
      win_rate: null,
      avg_pnl_pct: null,
      positions: 0,
    },
    status: "active",
    environment_snapshot: getEnvironmentSnapshot(),
  };

  // Snapshot current Darwin signal weights for audit trail.
  // NOTE: If Darwin adjusts weights during this experiment, the trial results
  // may be confounded — we cannot fully isolate prompt changes from weight
  // changes. This snapshot at least records the starting conditions.
  try {
    experiment.weights_at_start = loadWeights().weights;
  } catch {
    experiment.weights_at_start = null;
  }

  // Re-check the persisted state after the (slow) generator call: another run
  // or an operator command may have changed it meanwhile. Never start a second
  // experiment, and never overwrite newer state with the pre-LLM snapshot.
  const fresh = loadAutoresearch();
  if (fresh.active) {
    log("autoresearch", `Experiment ${fresh.active.id} became active while generating — discarding this candidate`);
    return;
  }
  fresh.active = experiment;
  saveAutoresearch(fresh);

  // 7. Activate the override
  setPromptSectionOverride(worstSection, modifiedText);

  log("autoresearch", `Experiment ${experiment.id} started: ${worstSection}`);
  log("autoresearch", `Hypothesis: ${hypothesis}`);
  log("autoresearch", `Baseline WR: ${experiment.baseline.win_rate}%, avg PnL: ${experiment.baseline.avg_pnl_pct}%`);
}

// ─── Evaluate Active Experiment ──────────────────────────────

async function evaluateExperiment(perfData, cfg, state) {
  const experiment = state.active;
  if (!experiment) return;

  const minCloses = cfg.autoresearch?.minClosesPerTrial ?? 7;
  const minEvidenceCloses = cfg.autoresearch?.minEvidenceCloses ?? Math.max(10, minCloses + 2);
  const minAbsoluteWinRateDeltaPct = cfg.autoresearch?.minAbsoluteWinRateDeltaPct ?? 10;
  const minAbsolutePnlDeltaPct = cfg.autoresearch?.minAbsolutePnlDeltaPct ?? 0.5;
  const improvementPct = cfg.autoresearch?.improvementPct ?? 15;
  const declinePct = cfg.autoresearch?.declinePct ?? 15;
  const cooldownCloses = cfg.autoresearch?.cooldownCloses ?? 5;

  if (environmentChangedSince(experiment.environment_snapshot, cfg)) {
    log("autoresearch", `Threshold values changed during ${experiment.id} — invalidating trial to avoid confounded results`);
    finishExperiment(state, "invalidated_environment_change", 0);
    return;
  }

  // Screener/range changes should only be judged on positions deployed after the
  // experiment started. Manager changes should be judged on any positions CLOSED
  // after the experiment started, including positions that were already open.
  const trialPositions = getTrialPositionsForExperiment(experiment, perfData);
  const trialCount = trialPositions.length;

  experiment.trial.positions = trialCount;

  // Circuit breaker: if first 3 trial closes are ALL losses, auto-revert
  if (trialCount >= 3 && trialCount < minCloses) {
    const first3 = trialPositions.slice(0, 3);
    const allLosses = first3.every(p => (p.pnl_usd ?? 0) < 0);
    if (allLosses) {
      log("autoresearch", `Circuit breaker: first 3 closes all losses — reverting ${experiment.id}`);
      finishExperiment(state, "reverted_circuit_breaker", cooldownCloses);
      return;
    }
  }

  // Not enough data yet
  if (trialCount < minCloses) {
    saveAutoresearch(state);
    log("autoresearch", `Experiment ${experiment.id}: ${trialCount}/${minCloses} closes`);
    return;
  }

  // Require a slightly larger evidence window before making a keep/revert call.
  // This reduces noisy decisions when the default minCloses is just barely met.
  if (trialCount < minEvidenceCloses) {
    saveAutoresearch(state);
    log("autoresearch", `Experiment ${experiment.id}: ${trialCount}/${minEvidenceCloses} evidence closes (waiting for a less noisy verdict)`);
    return;
  }

  // Compute trial metrics
  const trialWins = trialPositions.filter(p => (p.pnl_usd ?? 0) > 0).length;
  const trialWR = (trialWins / trialCount) * 100;
  const trialAvgPnl = trialPositions.reduce((s, p) => s + (p.pnl_pct ?? 0), 0) / trialCount;

  experiment.trial.win_rate = Math.round(trialWR * 10) / 10;
  experiment.trial.avg_pnl_pct = Math.round(trialAvgPnl * 100) / 100;

  // Compare to baseline using composite score: 60% win rate + 40% avg PnL
  const baselineWR = experiment.baseline.win_rate;
  const wrImprovement = ((trialWR - baselineWR) / Math.max(baselineWR, 1)) * 100;
  const absoluteWinRateDelta = trialWR - baselineWR;

  const baselinePnl = experiment.baseline.avg_pnl_pct;
  const pnlImprovement = baselinePnl !== 0
    ? ((trialAvgPnl - baselinePnl) / Math.max(Math.abs(baselinePnl), 0.1)) * 100
    : (trialAvgPnl > 0 ? 100 : trialAvgPnl < 0 ? -100 : 0);
  const absolutePnlDelta = trialAvgPnl - baselinePnl;

  const compositeImprovement = (wrImprovement * 0.6) + (pnlImprovement * 0.4);

  const trialLosses = trialCount - trialWins;
  const isImbalancedTinySample = trialCount < 2 * minEvidenceCloses && (trialWins === 0 || trialLosses === 0);
  if (isImbalancedTinySample) {
    log("autoresearch", `Experiment ${experiment.id}: ${trialWins}/${trialCount} wins/losses too one-sided for a confident verdict — waiting for more closes`);
    saveAutoresearch(state);
    return;
  }

  const hasMeaningfulAbsoluteDelta =
    Math.abs(absoluteWinRateDelta) >= minAbsoluteWinRateDeltaPct ||
    Math.abs(absolutePnlDelta) >= minAbsolutePnlDeltaPct;

  if (!hasMeaningfulAbsoluteDelta) {
    log("autoresearch", `Experiment ${experiment.id}: absolute deltas too small for a confident verdict (WR Δ ${absoluteWinRateDelta.toFixed(1)} pts, PnL Δ ${absolutePnlDelta.toFixed(2)} pts)`);
    finishExperiment(state, "inconclusive", cooldownCloses);
    return;
  }

  log("autoresearch", `Experiment ${experiment.id}: trial WR ${trialWR.toFixed(1)}% vs baseline ${baselineWR.toFixed(1)}% (WR improvement: ${wrImprovement.toFixed(1)}%, PnL improvement: ${pnlImprovement.toFixed(1)}%, composite: ${compositeImprovement.toFixed(1)}%)`);

  if (compositeImprovement >= improvementPct) {
    // KEEP — the modification helped
    log("autoresearch", `KEEPING experiment ${experiment.id} — composite ${compositeImprovement.toFixed(1)}% improvement (WR: ${wrImprovement.toFixed(1)}%, PnL: ${pnlImprovement.toFixed(1)}%)`);
    experiment.status = "kept";
    // Persist the kept override so it survives restarts
    if (!state.kept_overrides) state.kept_overrides = {};
    state.kept_overrides[experiment.section] = experiment.modified_text;
    state.kept_meta = { ...(state.kept_meta || {}), [experiment.section]: {
      experiment_id: experiment.id,
      kept_at: new Date().toISOString(),
      strategy: cfg.strategy?.activeStrategy ?? null,
      default_hash: defaultSectionHash(experiment.section),
    } };
    // Log as lesson
    logExperimentLesson(experiment, "kept", compositeImprovement);
    state.experiments.push(experiment);
    state.active = null;
    state.cooldownRemaining = cooldownCloses;
    saveAutoresearch(state);
  } else if (compositeImprovement <= -declinePct) {
    // REVERT — the modification hurt
    log("autoresearch", `REVERTING experiment ${experiment.id} — composite ${compositeImprovement.toFixed(1)}% decline (WR: ${wrImprovement.toFixed(1)}%, PnL: ${pnlImprovement.toFixed(1)}%)`);
    logExperimentLesson(experiment, "reverted", compositeImprovement);
    finishExperiment(state, "reverted", cooldownCloses);
  } else {
    // INCONCLUSIVE — revert to be safe
    log("autoresearch", `DISCARDING experiment ${experiment.id} — inconclusive (composite: ${compositeImprovement.toFixed(1)}%, WR: ${wrImprovement.toFixed(1)}%, PnL: ${pnlImprovement.toFixed(1)}%)`);
    logExperimentLesson(experiment, "inconclusive", compositeImprovement);
    finishExperiment(state, "inconclusive", cooldownCloses);
  }
}

function finishExperiment(state, status, cooldownCloses) {
  const experiment = state.active;
  if (!experiment) return;

  experiment.status = status;
  // If this section has a kept override, restore it instead of clearing entirely
  const keptText = state.kept_overrides?.[experiment.section];
  if (keptText) {
    setPromptSectionOverride(experiment.section, keptText);
  } else {
    clearPromptSectionOverride(experiment.section);
  }
  state.experiments.push(experiment);
  state.active = null;
  state.cooldownRemaining = cooldownCloses;
  saveAutoresearch(state);
}

function logExperimentLesson(experiment, outcome, improvementPct) {
  try {
    // Dynamic import to avoid circular dependency
    import("./lessons.js").then(({ addLesson }) => {
      const label = outcome === "kept" ? "KEPT" : outcome === "reverted" ? "REVERTED" : "INCONCLUSIVE";
      addLesson(
        `[AUTORESEARCH ${label}] Section "${experiment.section}": ${experiment.hypothesis}. ` +
        `Trial WR: ${experiment.trial.win_rate}% vs baseline ${experiment.baseline.win_rate}% ` +
        `(${improvementPct > 0 ? "+" : ""}${improvementPct.toFixed(1)}%).`,
        ["autoresearch", experiment.section, outcome],
      );
    }).catch(() => {});
  } catch { /* best-effort */ }
}

// ─── LLM Call ────────────────────────────────────────────────

function safeWeightsSummary() {
  try {
    return getWeightsSummary() || "(none yet)";
  } catch {
    return "(unavailable)";
  }
}

// Human-written research direction (karpathy/autoresearch's program.md idea).
const PROGRAM_FILE = path.join(__dirname, "autoresearch-program.md");
const PROGRAM_FALLBACK = "(autoresearch-program.md is missing.) Make one small, reversible change that reduces losses. Prefer removing or simplifying a rule over adding one.";

export function loadResearchProgram() {
  try {
    // Drop the leading editor note (an HTML comment addressed to the human).
    const text = fs.readFileSync(PROGRAM_FILE, "utf8").replace(/^\s*<!--[\s\S]*?-->\s*/, "").trim();
    return text || PROGRAM_FALLBACK;
  } catch {
    return PROGRAM_FALLBACK;
  }
}

async function callLLM(model, sectionName, lossCount, currentText, failureDesc) {
  const provider = getLlmProvider();

  const systemMsg = `You optimize prompts for an autonomous LP (Liquidity Provider) trading agent on Meteora/Solana DLMM. The agent uses these prompts as behavioral instructions. Your candidate is tested on live closes before anything is kept.

RESEARCH DIRECTION (human-edited, from autoresearch-program.md):
${loadResearchProgram()}

MECHANICAL RULES (enforced in code; a candidate that breaks one is rejected before it goes live):
- Keep every line containing HARD RULE, HARD SKIP, MUST or NEVER exactly as written, and do not add new ones.
- Change at most ~${config.autoresearch?.maxDiffPct ?? 30}% of the lines.
- Keep template placeholders such as \${deployAmount} and \${currentBalanceSol} exactly as written; the runner fills them in.
- Active trading strategy: ${config.strategy.activeStrategy}. Changes must stay compatible with it.
- Current learned signal weights:
${safeWeightsSummary()}`;

  const userMsg = `Section "${sectionName}" was attributed ${lossCount} recent losses.

Current text:
---
${currentText}
---

Recent failures:
${failureDesc}

Propose exactly ONE small change. Removing or simplifying an instruction is as valid as adding or tightening one, and is preferred when a rule is not clearly earning its keep: all else equal, a shorter prompt wins. Do not rewrite the whole section.

Return a JSON object: {"hypothesis": one sentence on what you changed (added, removed, loosened or tightened) and why, "modified_text": the full section text with your single change applied, without the --- delimiters}.`;
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["hypothesis", "modified_text"],
    properties: { hypothesis: { type: "string" }, modified_text: { type: "string" } },
  };
  // The CLI providers enforce the schema; HTTP providers only get JSON mode (or nothing),
  // so a non-JSON reply falls back to the previous HYPOTHESIS / MODIFIED_TEXT format.
  // Either way the result has the same { hypothesis, modifiedText } shape the experiment
  // record (hypothesis / modified_text) has always stored.
  const toResult = (raw) => {
    let obj = raw;
    if (typeof raw === "string") {
      try {
        obj = JSON.parse(raw);
      } catch {
        const hypothesisMatch = raw.match(/HYPOTHESIS:\s*(.+?)(?:\n|$)/i);
        const modifiedMatch = raw.match(/MODIFIED_TEXT:\s*\n([\s\S]+)/i);
        obj = { hypothesis: hypothesisMatch?.[1], modified_text: modifiedMatch?.[1] };
      }
    }
    if (typeof obj?.modified_text !== "string" || !obj.modified_text.trim()) throw new Error("autoresearch LLM returned no modified_text");
    return { hypothesis: String(obj.hypothesis || "").trim() || "Targeted modification", modifiedText: obj.modified_text.trim() };
  };

  if (provider === "codex") {
    const schemaPath = path.join(os.tmpdir(), `meridian-autoresearch-${process.pid}.schema.json`);
    fs.writeFileSync(schemaPath, JSON.stringify(schema));
    const content = await runCodexExec(model, `${systemMsg}\n\n${userMsg}`, {
      timeoutMs: AUTORESEARCH_LLM_TIMEOUT_MS,
      cwd: process.cwd(),
      sandbox: "read-only",
      skipGitRepoCheck: true,
      outputSchemaPath: schemaPath,
      config: {
        "suppress_unstable_features_warning": "true",
        "model_reasoning_effort": config.autoresearch?.reasoningEffort ?? "medium",
      },
    });

    if (!content) throw new Error("Empty response from Codex CLI");
    return toResult(content);
  }

  if (provider === "claude") {
    const { runClaudeCli } = await import("./llm-provider.js");

    const content = await runClaudeCli(model, userMsg, {
      timeoutMs: AUTORESEARCH_LLM_TIMEOUT_MS,
      effort: "high",
      systemPrompt: systemMsg,
      jsonSchema: schema,
    });

    if (!content) throw new Error("Empty response from Claude CLI");
    return toResult(content);
  }

  const baseURL = getChatCompletionsEndpoint();
  const apiKey = getProviderApiKey();
  if (!apiKey) throw new Error("LLM API key/token not available for autoresearch");

  const body = {
    model,
    messages: [
      { role: "system", content: systemMsg },
      { role: "user", content: userMsg },
    ],
    temperature: 0.4,
    max_tokens: 4096,
  };
  // JSON mode for DeepSeek / OpenRouter. MiniMax (reasoning_split) is left on plain text;
  // toResult accepts the legacy format as a fallback.
  if (provider !== "minimax") body.response_format = { type: "json_object" };

  if (provider === "minimax") {
    body.reasoning_split = true;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTORESEARCH_LLM_TIMEOUT_MS);
  let data;
  try {
    const response = await fetch(baseURL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "unknown");
      throw new Error(`LLM provider returned ${response.status}: ${errText}`);
    }

    data = await response.json();
  } catch (e) {
    if (controller.signal.aborted) throw new Error(`autoresearch LLM call timed out after ${AUTORESEARCH_LLM_TIMEOUT_MS / 1000}s`, { cause: e });
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const message = data.choices?.[0]?.message;
  const content = message?.content;
  if (!content) throw new Error("Empty response from LLM");

  return toResult(content);
}

// The generator is swappable so tests can mock it (no LLM or network in tests).
let _generator = callLLM;
export function __setAutoresearchGeneratorForTests(fn) {
  _generator = typeof fn === "function" ? fn : callLLM;
}
export function __resetAutoresearchLockForTests() {
  _running = null;
}

// ─── Public Accessors ────────────────────────────────────────

/**
 * Get the currently active experiment, or null.
 */
export function getActiveExperiment() {
  const state = loadAutoresearch();
  return state.active || null;
}

/**
 * Interface for prompt.js — get current text for a section.
 */
export function getPromptSection(sectionName) {
  return getPromptSectionText(sectionName);
}

/**
 * Interface for prompt.js — set override.
 */
export function setPromptOverride(sectionName, text) {
  setPromptSectionOverride(sectionName, text);
}

/**
 * Interface for prompt.js — clear override.
 */
export function clearPromptOverride(sectionName) {
  clearPromptSectionOverride(sectionName);
}
