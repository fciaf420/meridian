/**
 * rpc-hosts.js — which RPC endpoints the bot is actually using, safe to print.
 *
 * RPC URLs usually carry the provider key in the path or query
 * (https://x.helius-rpc.com/?api-key=...), so only protocol-less hostnames are
 * ever exposed. Resolved at boot (env is read once into the Connection), so a
 * stale endpoint is visible in Status before a restart.
 */

/** hostname only; never path, query, userinfo or port. "invalid" if unparseable. */
export function maskRpcUrl(url) {
  if (!url) return null;
  try {
    return new URL(String(url)).hostname || "invalid";
  } catch {
    return "invalid";
  }
}

/** [{ role, host }] for each configured endpoint. */
export function activeRpcHosts(env = process.env) {
  const out = [];
  const add = (role, url) => { const host = maskRpcUrl(url); if (host) out.push({ role, host }); };
  add("main", env.RPC_URL);
  add("balances", env.BALANCE_RPC_URL);
  return out;
}

export function formatRpcHosts(hosts = activeRpcHosts()) {
  return hosts.length ? hosts.map((h) => `${h.role}=${h.host}`).join(", ") : "none configured";
}
