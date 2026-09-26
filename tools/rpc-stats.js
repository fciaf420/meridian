/**
 * Per-method RPC call counter (in-process, since start). Helius bills per call,
 * so this makes the credit spend visible in the daily briefing.
 *
 * instrumentConnection() wraps a web3.js Connection's internal JSON-RPC entry
 * points (_rpcRequest / _rpcBatchRequest), which every Connection method and the
 * Meteora SDK go through, so each call is counted by its RPC method name. HTTP
 * APIs outside the Connection (Helius Wallet API, priority-fee estimate) are
 * counted at the call site with countRpc().
 */

const _counts = new Map();
let _since = Date.now();

export function countRpc(method, n = 1) {
  const key = String(method || "unknown");
  _counts.set(key, (_counts.get(key) || 0) + n);
}

/** Count every JSON-RPC call made through `conn`. Idempotent; returns conn. */
export function instrumentConnection(conn) {
  if (!conn || conn.__rpcCounted) return conn;
  const req = conn._rpcRequest;
  if (typeof req === "function") {
    conn._rpcRequest = (method, args) => {
      countRpc(method);
      return req.call(conn, method, args);
    };
  }
  const batch = conn._rpcBatchRequest;
  if (typeof batch === "function") {
    conn._rpcBatchRequest = (requests) => {
      for (const r of requests || []) countRpc(r?.methodName);
      return batch.call(conn, requests);
    };
  }
  conn.__rpcCounted = true;
  return conn;
}

/** { since, total, methods: [[method, count], …] sorted by count desc }. */
export function getRpcStats() {
  const methods = [..._counts.entries()].sort((a, b) => b[1] - a[1]);
  return { since: _since, total: methods.reduce((a, [, c]) => a + c, 0), methods };
}

/** One briefing line: calls per method since start (top `top` methods). */
export function formatRpcStatsLine(stats = getRpcStats(), { now = Date.now(), top = 8 } = {}) {
  const hours = Math.max(0, (now - stats.since) / 3_600_000);
  const head = `RPC calls since start (${hours.toFixed(1)}h): ${stats.total}`;
  if (!stats.total) return head;
  const shown = stats.methods.slice(0, top).map(([m, c]) => `${m} ${c}`);
  const rest = stats.methods.length - shown.length;
  return `${head} — ${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`;
}

/** Test hook. */
export function _resetRpcStatsForTest() {
  _counts.clear();
  _since = Date.now();
}
