/**
 * Autoresearch — automated prompt optimization, inspired by karpathy/autoresearch
 * (an agent edits one thing, a fixed budget scores it, keep or discard, and a
 * human-written program.md sets the direction).
 *
 * How it differs: live PnL is a noisy, non-stationary metric, not a fixed
 * validation score, so each candidate runs as a concurrent A/B test against
 * the current text and a human approves any winner.
 *
 * Flow: attribute recent losses to a prompt section that is active for the
 * current strategy, ask the generator (steered by autoresearch-program.md) for
 * one small edit, reject edits that touch protected lines or change too much,
 * alternate screener runs between control and candidate, and after enough
 * closes per arm, propose the candidate only if the bootstrap CI of the
 * size-weighted PnL difference clears zero and the minimum effect.
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
  setExperimentCandidate,
  clearExperimentCandidate,
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
  pending_proposal: null,    // A/B winner awaiting operator approve/reject
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

// Set when autoresearch.json is present but unparseable. While degraded we
// refuse to overwrite the (recoverable) bad file. The flag clears as soon as
// the file parses again (an operator fixed or restored it), without a restart.
let _autoresearchDegraded = false;
let _corruptBackupPath = null;

function fileParses() {
  try {
    JSON.parse(fs.readFileSync(AUTORESEARCH_FILE, "utf8"));
    return true;
  } catch {
    return false;
  }
}

function clearDegraded() {
  if (!_autoresearchDegraded) return;
  _autoresearchDegraded = false;
  _corruptBackupPath = null;
  log("autoresearch", `${AUTORESEARCH_FILE} parses again — leaving degraded mode, saves re-enabled`);
}

export function isAutoresearchDegraded() {
  return _autoresearchDegraded;
}

export function loadAutoresearch() {
  if (!fs.existsSync(AUTORESEARCH_FILE)) {
    // File absent — safe to create fresh defaults.
    clearDegraded();
    saveAutoresearch(freshDefaults());
    return freshDefaults();
  }
  try {
    const data = JSON.parse(fs.readFileSync(AUTORESEARCH_FILE, "utf8"));
    clearDegraded();
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
        _corruptBackupPath = backup;
        log("autoresearch", `${AUTORESEARCH_FILE} is corrupt (${err.message}); a copy was preserved as ${backup}. Saves are disabled until ${AUTORESEARCH_FILE} itself is fixed or replaced.`);
      } catch (backupErr) {
        log("autoresearch", `${AUTORESEARCH_FILE} is corrupt (${err.message}) and backup failed: ${backupErr.message}. Saves are disabled until ${AUTORESEARCH_FILE} itself is fixed or replaced.`);
      }
    }
    _autoresearchDegraded = true;
    throw new Error(`autoresearch.json is corrupt and was preserved for recovery: ${err.message}`, { cause: err });
  }
}

export function saveAutoresearch(data) {
  // Never persist over a corrupt-but-present file; that would destroy
  // recoverable history. Once the file parses again the save goes through.
  if (_autoresearchDegraded) {
    if (fs.existsSync(AUTORESEARCH_FILE) && !fileParses()) {
      log("autoresearch", `Skipping save: ${AUTORESEARCH_FILE} is corrupt. Fix or replace that file (not the backup${_corruptBackupPath ? ` ${_corruptBackupPath}` : ""}); saves resume once it parses.`);
      return;
    }
    clearDegraded();
  }
  // Atomic: write a temp file in the same directory, then rename over the
  // original, so a crash mid-write can't leave a truncated autoresearch.json.
  const tmp = `${AUTORESEARCH_FILE}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, serializeAutoresearch(data));
    fs.renameSync(tmp, AUTORESEARCH_FILE);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw e;
  }
}

/**
 * 2-space JSON with non-ASCII escaped as \uXXXX. That is the format the
 * tracked file has always used, so rewriting it leaves the experiment history
 * byte-identical.
 */
export function serializeAutoresearch(data) {
  return JSON.stringify(data, null, 2)
    .replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
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
  // The active experiment's candidate is served to its A/B arm only; it never
  // replaces the control text. Legacy (pre-A/B) experiments aren't restored:
  // the next evaluation closes them as abandoned.
  if (state.active?.design === "ab" && state.active?.modified_text && state.active?.section) {
    setExperimentCandidate({ id: state.active.id, section: state.active.section, text: state.active.modified_text });
    applied.push(`candidate:${state.active.section}`);
    log("autoresearch", `Restored active A/B experiment: ${state.active.id} (${state.active.section})`);
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
  "/autoresearch approve — keep the pending proposal (an A/B winner)",
  "/autoresearch reject — discard the pending proposal",
  "/autoresearch abort — stop the active experiment (candidate discarded)",
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
      `Active experiment: ${state.active
        ? `${state.active.id} (${state.active.section}) — closes control ${state.active.trial?.control ?? 0} / candidate ${state.active.trial?.candidate ?? 0} of ${cfg.autoresearch?.minClosesPerArm ?? 100} per arm`
        : "none"}`,
      `Pending proposal: ${state.pending_proposal
        ? `${state.pending_proposal.experiment_id} (${state.pending_proposal.section}) Δ ${state.pending_proposal.result?.delta_pct} pp, 95% CI ${state.pending_proposal.result?.ci95?.join("..")}`
        : "none"}`,
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

  if (cmd === "approve" || cmd === "reject") {
    const p = state.pending_proposal;
    if (!p) return "No pending proposal.";
    const at = new Date().toISOString();
    const exp = (state.experiments || []).findLast?.((e) => e.id === p.experiment_id);
    if (exp) exp.decision = { action: cmd === "approve" ? "approved" : "rejected", at };
    if (cmd === "approve") {
      if (kept[p.section]) {
        state.reverted_overrides = Array.isArray(state.reverted_overrides) ? state.reverted_overrides : [];
        state.reverted_overrides.push({ section: p.section, text: kept[p.section], meta: state.kept_meta?.[p.section] ?? null, reverted_at: at, replaced_by: p.experiment_id });
      }
      keepOverride(state, p.section, p.text, p.experiment_id, cfg);
    }
    state.pending_proposal = null;
    saveAutoresearch(state);
    return cmd === "approve"
      ? `Approved ${p.experiment_id}: ${p.section} kept. ${enabled ? "Applied now." : "Inactive until autoresearch is enabled."} /autoresearch revert ${p.section} undoes this.`
      : `Rejected ${p.experiment_id}; the current ${p.section} text stays.`;
  }

  if (cmd === "abort") {
    if (!state.active) return "No active experiment.";
    const id = state.active.id;
    finishExperiment(state, "aborted_by_operator", cfg.autoresearch?.cooldownCloses ?? 5);
    return `Aborted ${id}; its candidate is no longer served.`;
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
  const p = state?.pending_proposal;
  return {
    kept: Object.entries(state?.kept_overrides || {}).map(([s, t]) => describe(s, t, state.kept_meta?.[s], "kept")),
    quarantined: Object.entries(state?.quarantined_overrides || {}).map(([s, q]) => describe(s, q.text, q, "quarantined")),
    pending: p ? { ...describe(p.section, p.text, p, "pending"), hypothesis: p.hypothesis, result: p.result, proposed_at: p.proposed_at } : null,
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
  } else if (state.pending_proposal) {
    // One change at a time: wait for the operator to approve or reject.
    log("autoresearch", `Proposal from ${state.pending_proposal.experiment_id} awaits operator review (/autoresearch approve | reject) — not starting a new experiment`);
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
 *
 * manager_logic is not eligible: one manager prompt covers every open
 * position, so it can't be split into concurrent control/candidate arms the
 * way a screener run (one arm per run, tagged on the deploy) can.
 */
export function eligibleSections(cfg = config) {
  const sections = ["screener_criteria"];
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
  // Need at least 15 closes to attribute losses from.
  if (perfData.length < 15) {
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

  // 5. Create the experiment. No baseline window: the control arm runs
  // concurrently (alternate screener runs get control vs candidate text).
  const experiment = {
    id: `exp_${Date.now()}`,
    design: "ab",
    section: worstSection,
    hypothesis: hypothesis || "Targeted modification to reduce losses",
    original_text: currentText,   // control arm
    modified_text: modifiedText,  // candidate arm
    started_at: new Date().toISOString(),
    trial: { control: 0, candidate: 0, excluded: 0 },
    status: "active",
    environment_snapshot: getEnvironmentSnapshot(cfg),
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
  if (fresh.active || fresh.pending_proposal) {
    log("autoresearch", `${fresh.active ? `Experiment ${fresh.active.id} became active` : "A proposal became pending"} while generating — discarding this candidate`);
    return;
  }
  fresh.active = experiment;
  saveAutoresearch(fresh);

  // 6. Serve the candidate to the candidate arm only.
  setExperimentCandidate({ id: experiment.id, section: worstSection, text: modifiedText });

  log("autoresearch", `Experiment ${experiment.id} started (A/B): ${worstSection}`);
  log("autoresearch", `Hypothesis: ${hypothesis}`);
}

// ─── Verdict: concurrent A/B with a bootstrap CI ─────────────

// Positions smaller than this are dust or a failed deploy, not a trial.
const DUST_SOL = 0.01;
const BOOTSTRAP_ITERATIONS = 2000;

/**
 * Split an experiment's tagged closes into arms of { pnl, w }, where pnl is
 * the close's PnL % and w its size in SOL. pnl_unknown closes (recorded as a
 * 0 placeholder) and unsized/dust positions are excluded. Size weighting also
 * means a dust "win" can't count like a real one.
 */
export function splitArms(records, experimentId) {
  const arms = { control: [], candidate: [], excluded: 0 };
  for (const p of records || []) {
    if (p?.experiment_id !== experimentId) continue;
    const arm = p.experiment_arm;
    const pnl = Number(p.pnl_pct);
    const w = Number(p.amount_sol);
    if ((arm !== "control" && arm !== "candidate") || p.pnl_unknown || !Number.isFinite(pnl) || !Number.isFinite(w) || w < DUST_SOL) {
      arms.excluded++;
      continue;
    }
    arms[arm].push({ pnl, w });
  }
  return arms;
}

function weightedMean(xs) {
  let num = 0;
  let den = 0;
  for (const { pnl, w } of xs) { num += pnl * w; den += w; }
  return den > 0 ? num / den : 0;
}

// mulberry32: small seeded PRNG so a verdict is reproducible from its inputs.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFromId(id) {
  return parseInt(hashText(id).slice(0, 8), 16);
}

/**
 * Verdict for candidate vs control. Each arm is an array of { pnl, w }.
 * - "insufficient": fewer than minPerArm closes in an arm, still under the cap
 * - "inconclusive": the time cap passed before both arms reached minPerArm
 * - "pass": bootstrap 95% CI of (candidate − control) size-weighted mean PnL
 *   has lower bound > 0 AND the point estimate is >= minEffectPct
 * - "fail": enough closes, but not a clear, large-enough improvement
 * Evaluated once, when both arms first reach minPerArm (a fixed-sample test:
 * re-checking after every close would inflate false positives).
 */
export function computeVerdict(control, candidate, {
  minPerArm = 100,
  minEffectPct = 1.5,
  maxDays = 14,
  ageDays = 0,
  iterations = BOOTSTRAP_ITERATIONS,
  seed = 1,
} = {}) {
  const base = { n_control: control.length, n_candidate: candidate.length };
  if (Math.min(control.length, candidate.length) < minPerArm) {
    return { ...base, verdict: ageDays >= maxDays ? "inconclusive" : "insufficient" };
  }
  const delta = weightedMean(candidate) - weightedMean(control);
  const rand = seededRandom(seed);
  const resample = (xs) => {
    const out = new Array(xs.length);
    for (let i = 0; i < xs.length; i++) out[i] = xs[Math.floor(rand() * xs.length)];
    return out;
  };
  const diffs = new Array(iterations);
  for (let i = 0; i < iterations; i++) diffs[i] = weightedMean(resample(candidate)) - weightedMean(resample(control));
  diffs.sort((a, b) => a - b);
  const q = (p) => diffs[Math.min(iterations - 1, Math.max(0, Math.floor(p * iterations)))];
  const ci = [q(0.025), q(0.975)];
  const round = (x) => Math.round(x * 1000) / 1000;
  return {
    ...base,
    verdict: ci[0] > 0 && delta >= minEffectPct ? "pass" : "fail",
    delta_pct: round(delta),
    ci95: ci.map(round),
    control_mean_pct: round(weightedMean(control)),
    candidate_mean_pct: round(weightedMean(candidate)),
  };
}

// ─── Evaluate Active Experiment ──────────────────────────────

async function evaluateExperiment(perfData, cfg, state) {
  const experiment = state.active;
  if (!experiment) return;
  const ar = cfg.autoresearch || {};
  const cooldownCloses = ar.cooldownCloses ?? 5;

  if (experiment.design !== "ab") {
    // Started by the pre-A/B loop: it has no arm-tagged closes and never will.
    log("autoresearch", `Experiment ${experiment.id} predates the A/B design — closing it as abandoned`);
    finishExperiment(state, "abandoned_legacy_design", 0);
    return;
  }

  if (environmentChangedSince(experiment.environment_snapshot, cfg)) {
    log("autoresearch", `Threshold values changed during ${experiment.id} — invalidating trial to avoid confounded results`);
    finishExperiment(state, "invalidated_environment_change", 0);
    return;
  }

  const arms = splitArms(perfData, experiment.id);
  const tagged = arms.control.length + arms.candidate.length + arms.excluded;
  if (tagged < (experiment.tagged_seen ?? 0)) {
    // Closes we already counted are gone (clearPerformance or a trim): the
    // evidence can't be rebuilt, so don't leave the experiment hanging.
    log("autoresearch", `Performance history for ${experiment.id} was cleared (${experiment.tagged_seen} → ${tagged} tagged closes) — closing it as abandoned`);
    finishExperiment(state, "abandoned_history_cleared", 0);
    return;
  }
  experiment.tagged_seen = tagged;
  experiment.trial = { control: arms.control.length, candidate: arms.candidate.length, excluded: arms.excluded };

  // Circuit breaker (safety valve, candidate arm only): first 3 candidate closes all losses.
  if (arms.candidate.length >= 3 && arms.candidate.length < 10 && arms.candidate.slice(0, 3).every((x) => x.pnl < 0)) {
    log("autoresearch", `Circuit breaker: first 3 candidate closes all losses — discarding ${experiment.id}`);
    finishExperiment(state, "reverted_circuit_breaker", cooldownCloses);
    return;
  }

  const ageDays = (Date.now() - Date.parse(experiment.started_at)) / 86_400_000;
  const result = computeVerdict(arms.control, arms.candidate, {
    minPerArm: ar.minClosesPerArm ?? 100,
    minEffectPct: ar.minEffectPct ?? 1.5,
    maxDays: ar.maxExperimentDays ?? 14,
    ageDays,
    seed: seedFromId(experiment.id),
  });

  if (result.verdict === "insufficient") {
    saveAutoresearch(state);
    log("autoresearch", `Experiment ${experiment.id}: control ${result.n_control} / candidate ${result.n_candidate} closes (need ${ar.minClosesPerArm ?? 100} per arm, day ${ageDays.toFixed(1)} of ${ar.maxExperimentDays ?? 14})`);
    return;
  }

  experiment.result = result;
  if (result.verdict === "inconclusive") {
    log("autoresearch", `Experiment ${experiment.id} hit the ${ar.maxExperimentDays ?? 14}-day cap before ${ar.minClosesPerArm ?? 100} closes per arm — inconclusive, candidate discarded`);
    finishExperiment(state, "inconclusive_time_cap", cooldownCloses);
    return;
  }

  const summary = `Δ ${result.delta_pct} pp (95% CI ${result.ci95[0]}..${result.ci95[1]}), n=${result.n_control}/${result.n_candidate}`;
  if (result.verdict === "fail") {
    log("autoresearch", `Experiment ${experiment.id}: no clear improvement (${summary}) — candidate discarded, current text stays`);
    finishExperiment(state, "discarded", cooldownCloses);
    return;
  }

  // PASS. Proposal mode by default: a human approves before anything is kept.
  if (ar.autoKeep === true) {
    log("autoresearch", `Experiment ${experiment.id} passed (${summary}) — auto-keeping (autoresearchAutoKeep=true)`);
    keepOverride(state, experiment.section, experiment.modified_text, experiment.id, cfg);
    finishExperiment(state, "kept", cooldownCloses);
    return;
  }
  state.pending_proposal = {
    experiment_id: experiment.id,
    section: experiment.section,
    hypothesis: experiment.hypothesis,
    text: experiment.modified_text,
    result,
    proposed_at: new Date().toISOString(),
    strategy: cfg.strategy?.activeStrategy ?? null,
    default_hash: defaultSectionHash(experiment.section),
  };
  log("autoresearch", `Experiment ${experiment.id} passed (${summary}) — proposed for operator review (/autoresearch approve | reject)`);
  finishExperiment(state, "proposed", cooldownCloses);
}

/** Record `text` as the kept override for `section` and apply it if enabled. */
function keepOverride(state, section, text, experimentId, cfg) {
  state.kept_overrides = { ...(state.kept_overrides || {}), [section]: text };
  state.kept_meta = { ...(state.kept_meta || {}), [section]: {
    experiment_id: experimentId,
    kept_at: new Date().toISOString(),
    strategy: cfg.strategy?.activeStrategy ?? null,
    default_hash: defaultSectionHash(section),
  } };
  if (cfg?.autoresearch?.enabled === true) setPromptSectionOverride(section, text);
}

function finishExperiment(state, status, cooldownCloses) {
  const experiment = state.active;
  if (!experiment) return;

  experiment.status = status;
  experiment.finished_at = new Date().toISOString();
  // The candidate was only ever served to its arm; control text (kept override
  // or default) was never replaced, so there is nothing else to restore.
  clearExperimentCandidate();
  state.experiments.push(experiment);
  state.active = null;
  state.cooldownRemaining = cooldownCloses;
  saveAutoresearch(state);
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

  const systemMsg = `You optimize prompts for an autonomous LP (Liquidity Provider) trading agent on Meteora/Solana DLMM. The agent uses these prompts as behavioral instructions. Your candidate is A/B tested against the current text on live closes, and a human approves any winner before it is kept.

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
