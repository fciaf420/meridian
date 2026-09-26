// session.js — Shared session state
// Extracted from index.js so REPL, Telegram, and WebSocket all share state.

import { emit } from "./notifier.js";

const MAX_HISTORY = 20; // keep last 20 messages (10 exchanges)

// ---------------------------------------------------------------------------
// Conversation history
// ---------------------------------------------------------------------------

export const sessionHistory = [];

export function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

export function getHistory() {
  return sessionHistory;
}

// ---------------------------------------------------------------------------
// Busy flags — setters emit "status" on the notifier when state changes
// ---------------------------------------------------------------------------

let _busy = false;
let _managementBusy = false;
let _screeningBusy = false;

export function isBusy() {
  return _busy;
}

export function setBusy(val) {
  const prev = _busy;
  _busy = Boolean(val);
  if (prev !== _busy) {
    emit("status", { flag: "busy", value: _busy });
  }
}

export function isManagementBusy() {
  return _managementBusy;
}

export function setManagementBusy(val) {
  const prev = _managementBusy;
  _managementBusy = Boolean(val);
  if (prev !== _managementBusy) {
    emit("status", { flag: "managementBusy", value: _managementBusy });
  }
}

export function isScreeningBusy() {
  return _screeningBusy;
}

export function setScreeningBusy(val) {
  const prev = _screeningBusy;
  _screeningBusy = Boolean(val);
  if (prev !== _screeningBusy) {
    emit("status", { flag: "screeningBusy", value: _screeningBusy });
  }
}

// ---------------------------------------------------------------------------
// Shutdown drain — set on SIGINT/SIGTERM. While draining, cron ticks, the PnL
// watcher and fund-moving tools start no new work; in-flight work finishes.
// ---------------------------------------------------------------------------

let _draining = false;

export function isDraining() {
  return _draining;
}

export function setDraining(val) {
  const prev = _draining;
  _draining = Boolean(val);
  if (prev !== _draining) {
    emit("status", { flag: "draining", value: _draining });
  }
}

// ---------------------------------------------------------------------------
// In-flight fund-moving operations (deploys, closes, swaps, claims) started
// through executeTool. The shutdown drain waits for this to empty.
// ---------------------------------------------------------------------------

let _opSeq = 0;
const _inflightOps = new Map(); // id -> { name, startedAt }

/** Track `promise` as an in-flight operation until it settles. Returns it. */
export function trackInflightOp(name, promise) {
  const id = ++_opSeq;
  _inflightOps.set(id, { name, startedAt: Date.now() });
  const done = () => { _inflightOps.delete(id); };
  Promise.resolve(promise).then(done, done);
  return promise;
}

/** Names of the in-flight operations, e.g. ["deploy_position"]. */
export function getInflightOps() {
  return [..._inflightOps.values()].map((o) => o.name);
}

// ---------------------------------------------------------------------------
// Management close reasons: the code pre-check knows which hard rule fired for
// each position ("rule 5: yield dead"); close_position records it instead of a
// generic "agent decision". Set for the duration of one management cycle.
// ---------------------------------------------------------------------------

let _mgmtCloseReasons = new Map();

export function setManagementCloseReasons(entries) {
  _mgmtCloseReasons = new Map(entries || []);
}

export function getManagementCloseReason(positionAddress) {
  return positionAddress ? _mgmtCloseReasons.get(positionAddress) ?? null : null;
}

export function clearManagementCloseReasons() {
  _mgmtCloseReasons = new Map();
}
