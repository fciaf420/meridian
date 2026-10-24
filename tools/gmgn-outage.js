/**
 * GMGN transport-outage reporting: one notification per outage (not per cycle, not per
 * candidate). An "outage" is gmgn-cli missing/broken, a bad API key, or a cycle where every
 * evaluated candidate came back all-unknown from a transport failure (status error/empty).
 * While an outage is active the Meteora-source gate fails closed (hard mode) or records
 * would-drop (shadow mode); the operator hears about it exactly once until it recovers.
 */
import { emit as defaultEmit } from "../notifier.js";
import { log } from "../logger.js";

let _active = false;
let _since = 0;

export function reportGmgnOutage(reason, { emitFn = defaultEmit, now = Date.now(), detail = {} } = {}) {
  if (_active) return false;
  _active = true;
  _since = now;
  log("gmgn_gate", `GMGN OUTAGE: ${reason}`);
  try { emitFn("gmgn_outage", { reason, since: now, ...detail }); } catch { /* notification is best-effort */ }
  return true;
}

/** Call after a cycle with at least one healthy GMGN response; re-arms the one-shot. */
export function clearGmgnOutage() {
  if (!_active) return false;
  _active = false;
  log("gmgn_gate", "GMGN outage cleared");
  return true;
}

export function gmgnOutageState() {
  return { active: _active, since: _since };
}

export function _resetGmgnOutageForTest() { _active = false; _since = 0; }
