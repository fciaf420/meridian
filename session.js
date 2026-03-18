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
