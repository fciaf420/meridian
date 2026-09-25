/**
 * Shared LP Agent API key rotation and per-key rate limiter.
 * Both tools/study.js and tools/dlmm.js import from here so that
 * rate-limit state is shared across modules (no double-spending keys).
 */

// Support multiple API keys (comma-separated) for rate limit rotation.
//
// WARNING: LPAgent's Terms of Service §7 prohibits creating multiple accounts
// to circumvent restrictions (https://docs.lpagent.io/terms-of-service.md).
// Rotating keys from several accounts to beat the per-key rate limit falls
// under that clause and risks account termination (which silently degrades
// PnL to the Meteora fallback). Recommended: one key, and upgrade the plan
// (Premium 10 RPM, Enterprise 20 RPM) with LPAGENT_RPM set to match.
// Multi-key support is kept for keys that legitimately belong to one account.
const LPAGENT_KEYS = (process.env.LPAGENT_API_KEY || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Per-key rate limiter ───────────────────────────────────
// Requests per minute per key. Plan limits (docs.lpagent.io api-key-dashboard):
// Basic 5, Premium 10, Enterprise 20. Configure with LPAGENT_RPM (default 5).
const DEFAULT_RPM = 5;
function rateLimitPerKey() {
  const n = Number.parseInt(process.env.LPAGENT_RPM ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RPM;
}
const RATE_WINDOW_MS = 60_000;
const _keyCallTimes = new Map(); // key → [timestamps]

/**
 * Pick the key with the most remaining capacity.
 * If all keys are exhausted, returns { key, waitMs } so caller can sleep.
 */
function acquireKey() {
  if (LPAGENT_KEYS.length === 0) return { key: null, waitMs: 0 };

  const now = Date.now();
  const limit = rateLimitPerKey();
  let bestKey = null;
  let bestRemaining = -1;
  let shortestWait = Infinity;

  for (const key of LPAGENT_KEYS) {
    const calls = _keyCallTimes.get(key) || [];
    // Prune calls older than the window
    const recent = calls.filter(t => now - t < RATE_WINDOW_MS);
    _keyCallTimes.set(key, recent);

    const remaining = limit - recent.length;
    if (remaining > bestRemaining) {
      bestRemaining = remaining;
      bestKey = key;
    }
    if (remaining <= 0 && recent.length > 0) {
      // How long until the oldest call in this key's window expires
      const wait = RATE_WINDOW_MS - (now - recent[0]);
      if (wait < shortestWait) shortestWait = wait;
    }
  }

  if (bestRemaining > 0) {
    // Record the call
    const calls = _keyCallTimes.get(bestKey) || [];
    calls.push(now);
    _keyCallTimes.set(bestKey, calls);
    return { key: bestKey, waitMs: 0 };
  }

  // All keys exhausted — return the shortest wait
  return { key: bestKey, waitMs: Math.max(shortestWait, 1000) };
}

// Minimum gap between ANY LP Agent request (anti-burst)
const MIN_REQUEST_GAP_MS = 2000;
let _lastRequestAt = 0;

/**
 * Get a key, waiting if all keys are rate-limited.
 * Also enforces a minimum gap between requests to avoid burst 429s.
 * Returns the API key string, or null if no keys configured.
 *
 * With { wait: false } it never waits for the per-minute budget: it returns
 * null when every key is exhausted, so time-sensitive callers (the PnL
 * watcher, the close path) fall back to Meteora immediately instead of
 * sleeping for up to 60s. The anti-burst gap (at most 2s) still applies.
 */
async function getKey({ wait = true } = {}) {
  const { key, waitMs } = acquireKey();
  if (!key) return null;
  if (waitMs > 0) {
    if (!wait) return null;
    await sleep(waitMs);
    // After waiting, record the call for the key we'll use
    const now = Date.now();
    const calls = (_keyCallTimes.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
    calls.push(now);
    _keyCallTimes.set(key, calls);
  }
  // Enforce minimum gap between any two requests
  const elapsed = Date.now() - _lastRequestAt;
  if (elapsed < MIN_REQUEST_GAP_MS) {
    await sleep(MIN_REQUEST_GAP_MS - elapsed);
  }
  _lastRequestAt = Date.now();
  return key;
}

/**
 * Fetch with automatic 429 retry. Waits and retries up to 2 times.
 */
async function fetchWithRetry(url, opts, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, opts);
    if (res.status !== 429) return res;
    if (attempt < maxRetries) {
      const waitSec = 15 * (attempt + 1); // 15s, 30s
      await sleep(waitSec * 1000);
      // Swap to a fresh key for the retry
      const freshKey = await getKey();
      if (freshKey) opts.headers["x-api-key"] = freshKey;
    }
  }
  // Final attempt was also 429
  const err = new Error("Rate limit exceeded after retries. All API keys exhausted.");
  err.status = 429;
  throw err;
}

export { getKey, fetchWithRetry, LPAGENT_KEYS };
