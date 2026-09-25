// llm-health.js — LLM provider error parsing, classification and outage state.
//
// Kept free of provider/agent imports so it can be unit-tested and used from
// llm-provider.js, agent.js and index.js without import cycles.

import { emit as defaultEmit } from "./notifier.js";
import { log as defaultLog } from "./logger.js";

// ─── Codex CLI output parsing ────────────────────────────────────────────

// Item-level errors Codex reports on every run that say nothing about whether
// the turn worked. They must never be surfaced as "the" error.
const BENIGN_CODEX_ITEM_ERRORS = [
  /code mode is unavailable/i,
  /skill descriptions were shortened/i,
];

// stderr lines that come from the user's own Codex setup (MCP servers etc.),
// not from the model call. rmcp::transport is Codex's MCP client transport.
const CODEX_STDERR_NOISE = [
  /rmcp::transport/i,
];

export function isBenignCodexItemError(message) {
  return BENIGN_CODEX_ITEM_ERRORS.some((re) => re.test(String(message || "")));
}

function eventErrorMessage(event) {
  if (!event || typeof event !== "object") return "";
  const err = event.error;
  if (typeof err === "string") return err;
  if (err && typeof err.message === "string") return err.message;
  if (typeof event.message === "string") return event.message;
  return "";
}

function parseJsonLines(output) {
  const events = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore non-JSON lines.
    }
  }
  return events;
}

/** stderr with known-noise lines (MCP transport chatter) removed. */
export function filterCodexStderr(stderr) {
  return String(stderr || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !CODEX_STDERR_NOISE.some((re) => re.test(line)))
    .join("\n");
}

/**
 * The real error from a Codex `exec --json` run, or "" if the JSON stream holds
 * none. Order: turn.failed, then top-level {"type":"error"}, then a non-benign
 * item error.
 */
export function extractCodexJsonError(stdout) {
  let turnFailed = "";
  let topLevelError = "";
  let itemError = "";
  for (const event of parseJsonLines(stdout)) {
    if (event.type === "turn.failed") {
      const msg = eventErrorMessage(event);
      if (msg) turnFailed = msg;
    } else if (event.type === "error") {
      const msg = eventErrorMessage(event);
      if (msg && !isBenignCodexItemError(msg)) topLevelError = msg;
    } else if (event.type === "item.completed" && event.item?.type === "error") {
      const msg = event.item?.message;
      if (msg && !isBenignCodexItemError(msg)) itemError = msg;
    }
  }
  return turnFailed || topLevelError || itemError || "";
}

/**
 * Error message for a failed Codex run: the JSON stream's error first, then
 * stderr without MCP transport noise, then the exit code.
 */
export function codexFailureMessage({ stdout = "", stderr = "", code = null } = {}) {
  return extractCodexJsonError(stdout)
    || filterCodexStderr(stderr)
    || `Codex CLI exited with code ${code}`;
}

// ─── Error classification ────────────────────────────────────────────────

const QUOTA_RE = /usage limit|hit your (?:usage )?limit|quota|insufficient_quota|rate[\s_-]?limit|too many requests|\b429\b/i;
const AUTH_RE = /\b401\b|authentication fails|invalid api key|api key[^.]*is invalid|unauthorized|incorrect api key/i;

/** Human-readable reset time from a quota message, or null. */
export function extractResetText(message) {
  const msg = String(message || "");
  const tryAgain = msg.match(/try again (at|in)\s+(.+?)(?:\.\s|\.$|$)/im);
  if (tryAgain) return `${tryAgain[1].toLowerCase()} ${tryAgain[2].trim()}`;
  const resets = msg.match(/resets?\s+((?:at|in)\s+)?([^·\n.]+)/i);
  if (resets) return `${(resets[1] || "at ").trim()} ${resets[2].trim()}`.trim();
  return null;
}

/** Epoch ms parsed from a reset text such as "at Sep 26th, 2026 12:41 PM", or null. */
export function parseResetAt(resetText, now = Date.now()) {
  if (!resetText) return null;
  const rel = resetText.match(/^in\s+(\d+)\s*(second|minute|hour|day)s?/i);
  if (rel) {
    const unit = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 }[rel[2].toLowerCase()];
    return now + Number(rel[1]) * unit;
  }
  const abs = resetText.replace(/^at\s+/i, "").replace(/(\d)(st|nd|rd|th)\b/gi, "$1");
  const ts = Date.parse(abs);
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Classify a provider error.
 * kind: "quota" (usage limit / rate limit — retrying cannot help), "auth"
 * (bad key — retrying cannot help), or "transient".
 */
export function classifyLlmError(errOrMessage) {
  const message = typeof errOrMessage === "string" ? errOrMessage : (errOrMessage?.message || "");
  const status = typeof errOrMessage === "object" ? (errOrMessage?.status || errOrMessage?.statusCode) : null;
  if (status === 401 || AUTH_RE.test(message)) {
    return { kind: "auth", nonRetryable: true, resetText: null, resetAt: null, message };
  }
  if (status === 429 || QUOTA_RE.test(message)) {
    const resetText = extractResetText(message);
    return { kind: "quota", nonRetryable: true, resetText, resetAt: parseResetAt(resetText), message };
  }
  return { kind: "transient", nonRetryable: false, resetText: null, resetAt: null, message };
}

/** Thrown by agentLoop when neither the primary provider nor the fallback answered. */
export class LlmUnavailableError extends Error {
  constructor(message, { provider = null, reason = null, resetAt = null, resetText = null } = {}) {
    super(message);
    this.name = "LlmUnavailableError";
    this.llmUnavailable = true;
    this.provider = provider;
    this.reason = reason;
    this.resetAt = resetAt;
    this.resetText = resetText;
  }
}

export function isLlmUnavailableError(err) {
  return Boolean(err?.llmUnavailable);
}

// ─── Outage state + deduped notification ─────────────────────────────────

export const LLM_ALERT_REPEAT_MS = 60 * 60_000; // same outage: at most one alert per hour
export const LLM_PROBE_INTERVAL_MS = 30 * 60_000; // screening re-tries the LLM at most this often

// Collapse the parts of an error that change between identical failures
// (request ids, timestamps) so one outage keeps one signature.
export function llmErrorSignature(message) {
  return String(message || "")
    .toLowerCase()
    .replace(/request_id:\s*[\w-]+/g, "request_id")
    .replace(/\b\d{4}-\d{2}-\d{2}t[\d:.]+z\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * Outage tracker. `reportFailure` emits "llm_unavailable" once per distinct
 * error, and again for the same error only after LLM_ALERT_REPEAT_MS.
 * `reportSuccess` ends the outage, so the next failure alerts again.
 */
export function createLlmHealth({ emit = defaultEmit, log = defaultLog, now = () => Date.now() } = {}) {
  let outage = null; // { since, lastFailureAt, reason, provider, resetAt, resetText }
  let lastAlert = null; // { signature, at }

  function reportFailure({ provider = null, reason = "", resetAt = null, resetText = null } = {}) {
    const t = now();
    outage = {
      since: outage?.since ?? t,
      lastFailureAt: t,
      provider,
      reason,
      resetAt,
      resetText,
    };
    const signature = llmErrorSignature(reason);
    const due = !lastAlert || lastAlert.signature !== signature || t - lastAlert.at >= LLM_ALERT_REPEAT_MS;
    if (!due) return false;
    lastAlert = { signature, at: t };
    log("llm", `LLM unavailable (${provider || "provider"}): ${reason}${resetText ? ` — resets ${resetText}` : ""}`);
    emit("llm_unavailable", { provider, reason, resetAt, resetText, since: new Date(outage.since).toISOString() });
    return true;
  }

  function reportSuccess() {
    if (!outage) return;
    const mins = Math.round((now() - outage.since) / 60_000);
    log("llm", `LLM available again (${outage.provider || "provider"}) after ~${mins}m`);
    outage = null;
    lastAlert = null;
  }

  /**
   * True while a recent failure says the LLM is down: until the provider's
   * reset time when that is sooner, else until LLM_PROBE_INTERVAL_MS after the
   * last failure (then one caller probes again).
   */
  function isUnavailable() {
    if (!outage) return false;
    const t = now();
    const probeAt = outage.lastFailureAt + LLM_PROBE_INTERVAL_MS;
    const until = outage.resetAt && outage.resetAt > outage.lastFailureAt ? Math.min(outage.resetAt, probeAt) : probeAt;
    return t < until;
  }

  function getOutage() {
    return outage ? { ...outage } : null;
  }

  return { reportFailure, reportSuccess, isUnavailable, getOutage };
}

export const llmHealth = createLlmHealth();
