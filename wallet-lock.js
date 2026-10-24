// wallet-lock.js — one queue for every wallet-mutating operation, ordered by
// priority: close (10) > claim / swap (5) > deploy (0).
//
// An in-flight operation is never interrupted, but a queued stop-loss close
// always runs before a queued deploy, so an exit never waits behind entries
// that were requested after or alongside it. Ported from
// yunus-0x/meridian@standalone/transactions.js (18 lines) + tools/executor.js
// priorities; FIFO within one priority (upstream's sort was not stable-by-seq).
//
// Safety nets (Fable audit M1):
//  - re-entrancy guard: calling withWalletLock from inside a locked fn would
//    deadlock forever, so it throws instead (AsyncLocalStorage);
//  - stale-holder alert: a holder older than warnMs raises an alert (once per hold);
//  - hard timeout: a holder older than hardMs is abandoned — the lock is
//    released so exits are not wedged behind a hung RPC call, and the abandoned
//    caller's promise rejects with a timeout error. The abandoned operation may
//    still land on chain; callers must treat that rejection as "unknown", and
//    closePosition's own in-flight dedupe prevents a duplicate close.

import { AsyncLocalStorage } from "node:async_hooks";

export const WALLET_PRIORITY = Object.freeze({
  close_position: 10,
  claim_fees: 5,
  swap_token: 5,
  deploy_position: 0,
});

let active = null; // { label, priority, startedAt }
let seq = 0;
const queue = [];
const als = new AsyncLocalStorage();

const options = { warnMs: 5 * 60_000, hardMs: 15 * 60_000, onAlert: null };

/** Configure timeouts (ms; hardMs 0 disables the hard release) and the alert sink. */
export function setWalletLockOptions({ warnMs, hardMs, onAlert } = {}) {
  if (warnMs != null && Number.isFinite(Number(warnMs))) options.warnMs = Math.max(0, Number(warnMs));
  if (hardMs != null && Number.isFinite(Number(hardMs))) options.hardMs = Math.max(0, Number(hardMs));
  if (onAlert !== undefined) options.onAlert = typeof onAlert === "function" ? onAlert : null;
}

function alertStale(kind, info) {
  try { options.onAlert?.({ kind, ...info }); } catch { /* alerts are best-effort */ }
}

export function priorityForTool(name) {
  return WALLET_PRIORITY[name] ?? 5;
}

/**
 * Run `fn` holding the wallet lock. Resolves/rejects with fn's result.
 * `label` is for diagnostics only. Throws if called from inside a locked fn.
 */
export function withWalletLock(fn, priority = 0, label = "op") {
  const holder = als.getStore();
  // Only a holder that is still running can deadlock; a timer created inside a
  // locked op inherits the store forever, so `live` is cleared when the op ends (C1).
  if (holder?.live) {
    return Promise.reject(new Error(`withWalletLock re-entered from inside "${holder.label}" (would deadlock) — label "${label}"`));
  }
  if (tainted.size && (Number(priority) || 0) < CLOSE_PRIORITY) {
    return Promise.reject(new Error(`wallet lock tainted: an abandoned operation ("${[...tainted][0].label}") may still land on chain; only closes are admitted until it settles — refusing "${label}"`));
  }
  return new Promise((resolve, reject) => {
    queue.push({ fn, priority: Number(priority) || 0, seq: ++seq, label, resolve, reject });
    queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    drain();
  });
}

const ABANDONED = Symbol("abandoned");

// Abandoned (force-released) ops that have not settled yet (N1). While any
// exist, only closes may take the lock.
const tainted = new Set();
const CLOSE_PRIORITY = WALLET_PRIORITY.close_position;

/** Run `fn` outside any wallet-lock ALS context (use for timers/cron/watchers) (C1). */
export function outsideWalletLock(fn) {
  return als.exit(fn);
}

/** True when an abandoned op is still unsettled (only closes are admitted). */
export function isWalletLockTainted() {
  return tainted.size > 0;
}

async function drain() {
  if (active || !queue.length) return;
  let idx = 0;
  if (tainted.size) {
    idx = queue.findIndex((q) => q.priority >= CLOSE_PRIORITY);
    if (idx < 0) return; // deploys/claims/swaps wait until the abandoned op settles
  }
  const item = queue.splice(idx, 1)[0];
  const mine = { label: item.label, priority: item.priority, startedAt: Date.now() };
  active = mine;
  let warnTimer = null;
  let hardTimer = null;
  try {
    if (options.warnMs > 0) {
      warnTimer = setTimeout(() => {
        alertStale("stale", { label: item.label, heldMs: Date.now() - mine.startedAt, queued: queue.length });
      }, options.warnMs);
      warnTimer.unref?.();
    }
    const abandon = new Promise((res) => {
      if (options.hardMs > 0) {
        hardTimer = setTimeout(() => res(ABANDONED), options.hardMs);
        hardTimer.unref?.();
      }
    });
    const store = { label: item.label, live: true };
    const run = (async () => als.run(store, item.fn))();
    const clearLive = () => { store.live = false; };
    run.then(clearLive, clearLive);
    run.catch(() => {}); // an abandoned op's late rejection must not be unhandled
    const r = await Promise.race([run, abandon]);
    if (r === ABANDONED) {
      tainted.add(item);
      const untaint = () => { tainted.delete(item); void drain(); };
      run.then(untaint, untaint);
      alertStale("tainted", { label: item.label, queued: queue.length, note: "only closes admitted until the abandoned op settles" });
      console.warn(`[wallet-lock] "${item.label}" abandoned; only closes admitted until it settles`);
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].priority < CLOSE_PRIORITY) {
          const [q] = queue.splice(i, 1);
          q.reject(new Error(`wallet lock tainted: "${item.label}" was abandoned and may still land on chain; refusing queued "${q.label}"`));
        }
      }
      alertStale("abandoned", { label: item.label, heldMs: Date.now() - mine.startedAt, queued: queue.length });
      item.reject(new Error(`wallet lock timeout: "${item.label}" held the lock for ${Math.round((Date.now() - mine.startedAt) / 1000)}s; released (the operation may still land on chain)`));
    } else {
      item.resolve(r);
    }
  } catch (e) {
    item.reject(e);
  } finally {
    clearTimeout(warnTimer);
    clearTimeout(hardTimer);
    if (active === mine) active = null;
    void drain();
  }
}

/** Diagnostics: what holds the lock and what is waiting. */
export function getWalletLockState() {
  return {
    active: active ? { ...active, heldMs: Date.now() - active.startedAt } : null,
    tainted: [...tainted].map((t) => t.label),
    queued: queue.map((q) => ({ label: q.label, priority: q.priority })),
  };
}
