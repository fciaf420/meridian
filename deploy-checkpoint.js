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
 *   reconciled_absent     boot: no position account; nothing was created
 */

import fs from "fs";
import path from "path";
import { writeJsonAtomicSync } from "./atomic-write.js";
import { log as defaultLog } from "./logger.js";

const UNRESOLVED = new Set(["submitting", "uncertain"]);
const KEEP_RESOLVED = 50;

function filePath() {
  return process.env.MERIDIAN_DEPLOY_ATTEMPTS_FILE || path.resolve("deploy-attempts.json");
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), "utf8"));
    return raw && typeof raw === "object" && raw.attempts ? raw : { attempts: {} };
  } catch (e) {
    if (e.code === "ENOENT") return { attempts: {} };
    // Unreadable file: do not pretend there is no history.
    throw new Error(`deploy-attempts file unreadable: ${e.message}`, { cause: e });
  }
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
export async function reconcileAttempts({ positionExists, log = defaultLog, notify = null } = {}) {
  const results = [];
  for (const a of getUnresolvedAttempts()) {
    let exists = null;
    try { exists = await positionExists(a.position); } catch (e) { log("deploy_warn", `Reconcile read failed for ${String(a.position).slice(0, 8)}: ${e.message}`); }
    if (exists === true) {
      markAttempt(a.id, "reconciled_landed");
      log("deploy_warn", `Deploy attempt ${a.id} (pool ${String(a.pool).slice(0, 8)}) was interrupted but position ${String(a.position).slice(0, 8)} EXISTS on-chain; it will be managed/adopted. Check it.`);
      results.push({ attempt: a, outcome: "landed" });
    } else if (exists === false) {
      markAttempt(a.id, "reconciled_absent");
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
