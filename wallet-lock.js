// wallet-lock.js — one queue for every wallet-mutating operation, ordered by
// priority: close (10) > claim / swap (5) > deploy (0).
//
// An in-flight operation is never interrupted, but a queued stop-loss close
// always runs before a queued deploy, so an exit never waits behind entries
// that were requested after or alongside it. Ported from
// yunus-0x/meridian@standalone/transactions.js (18 lines) + tools/executor.js
// priorities; FIFO within one priority (upstream's sort was not stable-by-seq).

export const WALLET_PRIORITY = Object.freeze({
  close_position: 10,
  claim_fees: 5,
  swap_token: 5,
  deploy_position: 0,
});

let active = null; // { label, priority, startedAt }
let seq = 0;
const queue = [];

export function priorityForTool(name) {
  return WALLET_PRIORITY[name] ?? 5;
}

/**
 * Run `fn` holding the wallet lock. Resolves/rejects with fn's result.
 * `label` is for diagnostics only.
 */
export function withWalletLock(fn, priority = 0, label = "op") {
  return new Promise((resolve, reject) => {
    queue.push({ fn, priority: Number(priority) || 0, seq: ++seq, label, resolve, reject });
    queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    drain();
  });
}

async function drain() {
  if (active || !queue.length) return;
  const item = queue.shift();
  active = { label: item.label, priority: item.priority, startedAt: Date.now() };
  try {
    item.resolve(await item.fn());
  } catch (e) {
    item.reject(e);
  } finally {
    active = null;
    void drain();
  }
}

/** Diagnostics: what holds the lock and what is waiting. */
export function getWalletLockState() {
  return {
    active: active ? { ...active } : null,
    queued: queue.map((q) => ({ label: q.label, priority: q.priority })),
  };
}
