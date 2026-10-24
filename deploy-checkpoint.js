/**
 * deploy-checkpoint.js — crash checkpoint for the deploy path.
 *
 * deployPosition() writes `status: "submitting"` (with the new position's
 * pubkey) BEFORE it builds or sends any transaction. If the process dies
 * between that write and the confirmation, the next boot finds the attempt
 * still `submitting` and reconciles it against the chain instead of silently
 * risking a duplicate entry or an unnoticed orphan position.
 *
 * Ported from yunus-0x/meridian standalone/runtime.js (attempts[mint].status =
 * "submitting"), adapted to a small standalone file so it does not touch
 * state.json (owned by the exit/tick-confirmation work).
 *
 * Statuses
 *   submitting            written before any tx; unresolved
 *   uncertain             a tx was sent then the deploy errored and the chain read failed; unresolved
 *   entered               deploy confirmed
 *   aborted               pre-submit gate refused; no tx was sent
 *   failed                errored; chain confirms the position account does not exist
 *   landed_unconfirmed    errored but the position account EXISTS on-chain (needs management/adoption)
 *   reconciled_landed     boot: position account exists on-chain
 *   reconciled_absent     boot/periodic: no position account; nothing was created
 *   cleared_manual        operator cleared it after checking the chain themselves
 *
 * A corrupt (unparsable) file is moved aside to deploy-attempts.json.corrupt-<ts>
 * and the checkpoint continues empty, like state.js; an I/O error (EACCES, EIO,
 * EISDIR...) still fails closed. See setCorruptionHandler().
 */

import { dataPath } from "./config-paths.js";
import fs from "fs";
import path from "path";
import { writeJsonAtomicSync } from "./atomic-write.js";
import { log as defaultLog } from "./logger.js";

const UNRESOLVED = new Set(["submitting", "uncertain"]);
const KEEP_RESOLVED = 50;

function filePath() {
  return process.env.MERIDIAN_DEPLOY_ATTEMPTS_FILE || path.resolve(dataPath("deploy-attempts.json"));
}

let onCorrupt = null;
/** fn({ file, backup, error }) is called (sync, best-effort) when a corrupt file was moved aside. */
export function setCorruptionHandler(fn) { onCorrupt = typeof fn === "function" ? fn : null; }

function healCorrupt(file, why) {
  const backup = `${file}.corrupt-${Date.now()}`;
  try { fs.renameSync(file, backup); } catch (e) {
    // Cannot even move it aside: stay fail-closed rather than overwrite evidence.
    throw new Error(`deploy-attempts file corrupt (${why}) and could not be moved aside: ${e.message}`, { cause: e });
  }
  defaultLog("deploy_warn", `deploy-attempts.json was corrupt (${why}); moved to ${path.basename(backup)} and continuing with an empty checkpoint. Any in-flight deploy recorded there is NOT tracked: check your wallet positions.`);
  try { onCorrupt?.({ file, backup, error: why }); } catch { /* alert is best-effort */ }
  return { attempts: {} };
}

function load() {
  const file = filePath();
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { attempts: {} };
    // Unreadable file (permissions, I/O): do not pretend there is no history.
    throw new Error(`deploy-attempts file unreadable: ${e.message}`, { cause: e });
  }
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return healCorrupt(file, e.message); }
  if (!raw || typeof raw !== "object" || !raw.attempts || typeof raw.attempts !== "object" || Array.isArray(raw.attempts)) {
    return healCorrupt(file, "unexpected structure");
  }
  return raw;
}

function save(db) {
  const resolved = Object.values(db.attempts).filter((a) => !UNRESOLVED.has(a.status))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  for (const old of resolved.slice(KEEP_RESOLVED)) delete db.attempts[old.id];
  writeJsonAtomicSync(filePath(), db);
}

/** Write the `submitting` checkpoint. Throws if it cannot be persisted (caller must NOT deploy then). */
export function beginAttempt({ pool, mint = null, position, amountSol = null, now = Date.now() }) {
  const db = load();
  const id = `${now}-${String(position).slice(0, 8)}`;
  db.attempts[id] = {
    id, pool, mint, position, amountSol,
    status: "submitting", txs: [],
    startedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  };
  save(db);
  return id;
}

// Attempts being driven by THIS process right now. Periodic/manual reconcile and
// /reconcile clear must never touch them: the deploy that owns the attempt is
// about to write its own terminal status (review finding A/G).
const inFlight = new Set();
export function trackInFlightAttempt(id) { if (id) inFlight.add(id); }
export function releaseInFlightAttempt(id) { inFlight.delete(id); }
export function isAttemptInFlight(id) { return inFlight.has(id); }

export function markAttempt(id, status, extra = {}) {
  try {
    const db = load();
    const a = db.attempts[id];
    if (!a) return;
    Object.assign(a, extra, { status, updatedAt: new Date().toISOString() });
    save(db);
  } catch (e) {
    defaultLog("deploy_warn", `Could not update deploy attempt ${id}: ${e.message}`);
  }
}

/**
 * Compare-and-set: change the status only if it still equals `expected` (i.e.
 * unchanged since the caller read it). Load -> check -> save is synchronous, so
 * a deploy's own write can never be overwritten by a stale reconcile read.
 * Returns true when the transition happened.
 */
export function markAttemptIf(id, expected, status, extra = {}) {
  try {
    const db = load();
    const a = db.attempts[id];
    if (!a || a.status !== expected) return false;
    Object.assign(a, extra, { status, updatedAt: new Date().toISOString() });
    save(db);
    return true;
  } catch (e) {
    defaultLog("deploy_warn", `Could not update deploy attempt ${id}: ${e.message}`);
    return false;
  }
}

/**
 * Operator override: mark an unresolved attempt resolved after checking the chain
 * themselves. Returns the attempt or null when the id is not an unresolved one,
 * or when the attempt is in flight in this process (even with force).
 */
export function clearAttempt(id, note = "cleared by operator") {
  if (inFlight.has(id)) return null;
  const db = load();
  const a = db.attempts[id];
  if (!a || !UNRESOLVED.has(a.status)) return null;
  Object.assign(a, { status: "cleared_manual", note, updatedAt: new Date().toISOString() });
  save(db);
  return a;
}

export function getUnresolvedAttempts() {
  return Object.values(load().attempts).filter((a) => UNRESOLVED.has(a.status));
}

/** The unresolved attempt blocking this pool / token, if any. */
export function findBlockingAttempt({ pool, mint }) {
  try {
    return getUnresolvedAttempts().find((a) => (pool && a.pool === pool) || (mint && a.mint && a.mint === mint)) ?? null;
  } catch (e) {
    // Cannot read the checkpoint file: fail closed.
    return { id: "unreadable", pool, status: "unreadable", error: e.message };
  }
}

/**
 * Boot reconciliation. `positionExists(pubkey)` -> true | false | null (unknown).
 * Returns [{ attempt, outcome }] for every previously unresolved attempt.
 */
export async function reconcileAttempts({ positionExists, log = defaultLog, notify = null, minAgeMs = 0, now = Date.now() } = {}) {
  const results = [];
  for (const a of getUnresolvedAttempts()) {
    // Never reconcile a deploy that is running in this process, nor (periodic
    // callers pass minAgeMs) one too young to have been abandoned.
    if (inFlight.has(a.id)) continue;
    if (minAgeMs > 0 && now - Date.parse(a.startedAt) < minAgeMs) continue;
    const readStatus = a.status;
    let exists = null;
    try { exists = await positionExists(a.position); } catch (e) { log("deploy_warn", `Reconcile read failed for ${String(a.position).slice(0, 8)}: ${e.message}`); }
    if (exists === true) {
      if (!markAttemptIf(a.id, readStatus, "reconciled_landed")) { log("deploy", `Deploy attempt ${a.id} changed while reconciling; left as is.`); continue; }
      log("deploy_warn", `Deploy attempt ${a.id} (pool ${String(a.pool).slice(0, 8)}) was interrupted but position ${String(a.position).slice(0, 8)} EXISTS on-chain; it will be managed/adopted. Check it.`);
      results.push({ attempt: a, outcome: "landed" });
    } else if (exists === false) {
      if (!markAttemptIf(a.id, readStatus, "reconciled_absent")) { log("deploy", `Deploy attempt ${a.id} changed while reconciling; left as is.`); continue; }
      log("deploy", `Deploy attempt ${a.id} (pool ${String(a.pool).slice(0, 8)}) was interrupted; no position account on-chain. Nothing created.`);
      results.push({ attempt: a, outcome: "absent" });
    } else {
      log("deploy_warn", `Deploy attempt ${a.id} (pool ${String(a.pool).slice(0, 8)}) could not be verified; re-entry into that pool/token stays blocked until it is.`);
      results.push({ attempt: a, outcome: "unverified" });
    }
  }
  if (results.length && notify) {
    try { await notify(results); } catch { /* best-effort */ }
  }
  return results;
}
