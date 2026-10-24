/**
 * Pure GMGN policy helpers (no I/O): result statuses, command weights, ban-reset
 * parsing, unknown-aware numeric readers, the stat-population test, and the
 * LOG-ONLY risk snapshots built from `token security` + extra `token info` fields.
 *
 * Why this file exists: before it, a missing GMGN field defaulted to 0 and
 * PASSED every hard gate, and a rate-limited call looked identical to "no data".
 * Everything here keeps "unknown" distinct from "zero" and "rate limited" distinct
 * from "unknown".
 */

/** Result statuses of one GMGN call. Only "ok" carries usable data. */
export const GMGN_STATUS = Object.freeze({
  OK: "ok",
  RATE_LIMITED: "rate_limited", // skip / retry later; NOT "no data" and NOT a permanent reject
  FORBIDDEN: "forbidden",       // 403 PLAN_UPGRADE_REQUIRED: non-retryable
  EMPTY: "empty",               // call succeeded but returned nothing
  ERROR: "error",               // spawn / timeout / non-zero exit / parse failure
});

/** Requests per second the GMGN plan refills (docs: Free 5, Plus 20, Pro 50). */
export const PLAN_RATE_PER_SEC = Object.freeze({ free: 5, plus: 20, pro: 50 });

/** Defaults for the settings this fix introduces (read via gmgnSetting). */
export const GMGN_FIX_DEFAULTS = Object.freeze({
  plan: "free",            // conservative: pace for the smallest bucket
  finalistLimit: 5,        // holders/traders (weight 5 each) only for this many tokens
  // Meteora-source GMGN gating mode: "shadow" (default: evaluate + record gmgn_gate_would_drop,
  // never drop), "hard" (drop), or "off". Booleans map true -> "hard", false -> "off".
  gateMeteoraSource: "shadow",
  outageMinCandidates: 3,  // all-unknown (transport-failed) candidates in one cycle that count as an outage
});

/**
 * Separate, looser thresholds for the Meteora-source gate. The GMGN trending pipeline's
 * thresholds (selected for a different candidate population) must NOT be reused here.
 * Override any key via gmgn-config.json `meteoraGate`. `null` disables that gate; a null
 * minTotalFeeSol/minHolders makes the field log-only.
 */
export const METEORA_GATE_DEFAULTS = Object.freeze({
  minHolders: 200,
  minTotalFeeSol: null, // total_fee is not a documented `token info` field: log-only (index.js global_fees gate covers fees)
  maxTop10HolderRate: 0.6,
  maxDevTeamHoldRate: 0.05,
  maxBotDegenRate: 0.6,
  maxFreshWalletRate: 0.5,
  maxRatTraderRate: 0.3,
  maxBundlerRate: 0.6,
});

/** Merge: GMGN-pipeline cfg < METEORA_GATE_DEFAULTS < user `gmgn.meteoraGate` overrides. */
export function meteoraGateThresholds(cfg) {
  return { ...(cfg?.gmgn || {}), ...METEORA_GATE_DEFAULTS, ...(cfg?.gmgn?.meteoraGate || {}) };
}

/** Normalize gateMeteoraSource to "off" | "shadow" | "hard". */
export function meteoraGateMode(cfg) {
  const v = gmgnSetting(cfg, "gateMeteoraSource");
  if (v === true || v === "hard") return "hard";
  if (v === false || v === "off") return "off";
  return "shadow";
}

export function gmgnSetting(cfg, key) {
  return cfg?.gmgn?.[key] ?? GMGN_FIX_DEFAULTS[key];
}

/**
 * GMGN route weights from the skill docs (gmgn-token/market/track/portfolio SKILL.md).
 * Anything not listed costs 1 (token info/security/pool, market signal/search, track kol/smartmoney).
 */
const COMMAND_WEIGHTS = Object.freeze({
  token: { holders: 5, traders: 5, info: 1, security: 1, pool: 1 },
  market: { kline: 2, trending: 3, trenches: 2, "hot-searches": 3, signal: 1, search: 1 },
  track: { "follow-tokens": 3, "follow-token-groups": 1, "follow-wallet": 10, kol: 1, smartmoney: 1 },
  portfolio: { holdings: 2, info: 2, activity: 3, stats: 3, profits: 3, "token-balance": 2, "created-tokens": 2 },
});

export function commandWeight(args = []) {
  return COMMAND_WEIGHTS[args[0]]?.[args[1]] ?? 1;
}

/** Minimum spacing (ms) to leave after a request of `weight` on a plan of `ratePerSec`. */
export function paceGapMs(weight, ratePerSec) {
  const rate = Number(ratePerSec) > 0 ? Number(ratePerSec) : PLAN_RATE_PER_SEC.free;
  return Math.ceil((Math.max(1, weight) / rate) * 1000);
}

export function ratePerSecForPlan(plan) {
  return PLAN_RATE_PER_SEC[String(plan || "").toLowerCase()] ?? PLAN_RATE_PER_SEC.free;
}

/** Tight 429 detection: a bare "429" digits inside a URL/PID must not count. */
export function looksRateLimited(text) {
  if (!text) return false;
  return /RATE_LIMIT|\b429\b|too many requests/i.test(String(text));
}

export function looksForbidden(text) {
  if (!text) return false;
  return /PLAN_UPGRADE_REQUIRED/i.test(String(text));
}

/** Ban-class errors: a request sent inside the window re-extends it, so never probe early. */
export function looksBanned(text) {
  if (!text) return false;
  return /RATE_LIMIT_BANNED|ERROR_RATE_LIMIT_BLOCKED/i.test(String(text));
}

/** 401 / bad API key (distinct from rate limit and plan-upgrade). */
export function looksUnauthorized(text) {
  if (!text) return false;
  return /HTTP 401\b|UNAUTHORI[SZ]ED|INVALID[_ ]API[_ ]KEY|API key.*(invalid|missing)/i.test(String(text));
}

/**
 * Pull the ban-lift instant (epoch ms) out of GMGN error text. The real gmgn-cli
 * (OpenApiClient.buildOpenApiErrorMessage) prints:
 *   "... Rate limit resets at 2026-10-24 11:02:16 GMT-04:00 (~287s remaining). Stop sending ..."
 *   "... Stop ALL requests until 2026-10-24 11:02:16 GMT-04:00 (~287s remaining); ..."
 * It never prints a raw epoch, but a raw JSON `reset_at` / X-RateLimit-Reset is still accepted.
 * Returns null when absent / implausible.
 */
export function parseResetAtMs(text, now = Date.now()) {
  if (!text) return null;
  const t = String(text);
  const rem = t.match(/\(~\s*(\d+)\s*s remaining\)/i);
  if (rem) {
    const v = now + Number(rem[1]) * 1000;
    return v > now + 10 * 60_000 ? null : v;
  }
  const m = t.match(/reset_at["']?\s*[:=]\s*["']?(\d{9,13})/i)
    || t.match(/x-ratelimit-reset["']?\s*[:=]\s*["']?(\d{9,13})/i);
  if (!m) return null;
  let v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  if (v < 1e11) v *= 1000; // seconds -> ms
  // Ignore stale / absurd values (> 10 min ahead is not a GMGN ban window).
  if (v < now - 60_000 || v > now + 10 * 60_000) return null;
  return v;
}

export const BAN_CEILING_MS = 300_000;

/** Escalating cooldown: 30s, 60s, 120s, 240s, then the 5-minute ban ceiling. */
export function escalatingCooldownMs(strikes) {
  const n = Math.max(1, Number(strikes) || 1);
  return Math.min(300_000, 30_000 * 2 ** (n - 1));
}

/**
 * Decide the cooldown for a rate-limit error. A reset time GMGN stated wins (+1s
 * margin, never landing on the boundary since that extends the ban); otherwise
 * escalate. Never shorter than the escalating floor for repeated strikes.
 */
export function cooldownUntilMs({ errorText, strikes, now = Date.now() }) {
  const reset = parseResetAtMs(errorText, now);
  // Ban-class without a parseable reset: assume the full 5-minute ban (probing earlier extends it).
  const floor = looksBanned(errorText) && reset == null
    ? now + BAN_CEILING_MS
    : now + escalatingCooldownMs(strikes);
  if (reset != null) return Math.max(reset + 1000, now + 5000, strikes > 1 ? now + escalatingCooldownMs(strikes) : 0);
  return floor;
}

/* ============================ unknown-aware readers ============================ */

/** Finite number or null. NEVER defaults to 0: null means "unknown". */
export function numOrNull(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The ten `stat.*` fields of gmgn-contract-dd Step 1B test 2: all 0/absent => unpopulated.
 * (dev_team_hold_rate is deliberately NOT in this list; the doc's list is the authority.)
 */
export const STAT_RISK_FIELDS = Object.freeze([
  "creator_hold_rate",
  "top_bundler_trader_percentage",
  "top70_sniper_hold_rate",
  "top_rat_trader_percentage",
  "top_entrapment_trader_percentage",
  "bot_degen_rate",
  "fresh_wallet_rate",
  "private_vault_hold_rate",
  "creator_created_count",
  "top_10_holder_rate",
]);

/**
 * True when `info.stat` is missing or every chain-analysis metric is 0/absent.
 * GMGN often returns the block unpopulated for fresh tokens; reading those zeros
 * as "clean" is exactly the bug this fix removes.
 */
export function isStatUnpopulated(stat, info) {
  if (!stat || typeof stat !== "object") return true;
  // Test 1 (contract-dd 1B): stat.holder_count 0/absent while info.holder_count > 0.
  if (numOrNull(info?.holder_count) > 0 && !(numOrNull(stat.holder_count) > 0)) return true;
  // Test 2: all ten chain-analysis fields 0/absent.
  return STAT_RISK_FIELDS.every((k) => !(numOrNull(stat[k]) > 0));
}

/* ============================ log-only risk snapshots ============================ */

const pctOf = (v) => (numOrNull(v) == null ? null : Number((numOrNull(v) * 100).toFixed(2)));

/**
 * Extra `token info` risk fields, recorded but NEVER gating (no new gates from
 * untagged data). `would_flag` lists the thresholds GMGN's own docs treat as
 * red, so outcomes can later be compared per trade-origin tag before any gate.
 */
export function summarizeInfoRisk(info = {}) {
  const stat = info?.stat || {};
  const poolLiq = numOrNull(info?.pool?.liquidity);
  const poolInit = numOrNull(info?.pool?.initial_liquidity);
  const liqRatio = poolLiq != null && poolInit != null && poolInit > 0 ? Number((poolLiq / poolInit).toFixed(3)) : null;
  const out = {
    creator_hold_pct: pctOf(stat.creator_hold_rate),
    top70_sniper_hold_pct: pctOf(stat.top70_sniper_hold_rate),
    entrapment_trader_pct: numOrNull(stat.top_entrapment_trader_percentage) == null ? null : Number((numOrNull(stat.top_entrapment_trader_percentage) * 100).toFixed(2)),
    private_vault_hold_pct: pctOf(stat.private_vault_hold_rate),
    creator_created_count: numOrNull(stat.creator_created_count),
    creator_token_status: info?.dev?.creator_token_status ?? null,
    pool_liquidity: poolLiq,
    pool_initial_liquidity: poolInit,
    pool_liquidity_ratio: liqRatio,
  };
  const flags = [];
  if (out.creator_hold_pct != null && out.creator_hold_pct > 5) flags.push("creator_hold>5%");
  if (out.top70_sniper_hold_pct != null && out.top70_sniper_hold_pct > 15) flags.push("top70_sniper>15%");
  if (out.entrapment_trader_pct != null && out.entrapment_trader_pct > 20) flags.push("entrapment>20%");
  if (out.private_vault_hold_pct != null && out.private_vault_hold_pct > 5) flags.push("private_vault>5%");
  if (out.creator_created_count != null && out.creator_created_count >= 200) flags.push("serial_launcher>=200");
  if (liqRatio != null && liqRatio < 0.5) flags.push("pool_liquidity<50%_of_initial");
  out.would_flag = flags;
  return out;
}

const boolOrNull = (v) => (v === true || v === false ? v : null);
const taxOrNull = (v) => (v === "" || v == null ? null : numOrNull(v)); // "" = untested, NOT 0

/**
 * `token security` -> log-only snapshot. Missing/"" stays null (unknown), never
 * a pass. Solana only: renounced_mint / renounced_freeze_account.
 */
export function summarizeSecurity(sec) {
  if (!sec || typeof sec !== "object") return null;
  const lock = sec.lock_summary || {};
  const detail = Array.isArray(lock.lock_detail) ? lock.lock_detail : [];
  const burned = String(sec.burn_status || "").toLowerCase() === "burn" || detail.some((d) => d?.is_blackhole === true);
  const out = {
    renounced_mint: boolOrNull(sec.renounced_mint),
    renounced_freeze: boolOrNull(sec.renounced_freeze_account),
    lp_burned: sec.burn_status == null ? null : burned,
    lp_locked: lock.is_locked == null ? null : lock.is_locked === true,
    buy_tax: taxOrNull(sec.buy_tax),
    sell_tax: taxOrNull(sec.sell_tax),
  };
  const flags = [];
  if (out.renounced_mint === false) flags.push("mint_not_renounced");
  if (out.renounced_freeze === false) flags.push("freeze_not_renounced");
  if (out.sell_tax != null && out.sell_tax > 0.1) flags.push("sell_tax>10%");
  if (out.buy_tax != null && out.buy_tax > 0.1) flags.push("buy_tax>10%");
  // DLMM pools have no LP token, so "LP not burned/locked" is advisory only.
  if (out.lp_burned === false && out.lp_locked === false) flags.push("lp_not_burned_or_locked");
  out.unknown = Object.entries(out).filter(([k, v]) => k !== "unknown" && v == null).map(([k]) => k);
  out.would_flag = flags;
  return out;
}

/** Flat, prefix-namespaced fields recorded on the candidate / signal snapshot. */
export function riskSnapshotFields({ infoRisk, security, securityStatus } = {}) {
  const f = {};
  if (infoRisk) {
    f.gmgn_creator_hold_pct = infoRisk.creator_hold_pct;
    f.gmgn_top70_sniper_hold_pct = infoRisk.top70_sniper_hold_pct;
    f.gmgn_entrapment_trader_pct = infoRisk.entrapment_trader_pct;
    f.gmgn_private_vault_hold_pct = infoRisk.private_vault_hold_pct;
    f.gmgn_creator_created_count = infoRisk.creator_created_count;
    f.gmgn_creator_token_status = infoRisk.creator_token_status;
    f.gmgn_pool_liquidity_ratio = infoRisk.pool_liquidity_ratio;
  }
  if (security) {
    f.gmgn_renounced_mint = security.renounced_mint;
    f.gmgn_renounced_freeze = security.renounced_freeze;
    f.gmgn_lp_burned = security.lp_burned;
    f.gmgn_lp_locked = security.lp_locked;
    f.gmgn_buy_tax = security.buy_tax;
    f.gmgn_sell_tax = security.sell_tax;
  }
  f.gmgn_security_status = securityStatus ?? (security ? "ok" : "not_fetched");
  f.gmgn_risk_log_only_flags = [...(infoRisk?.would_flag || []), ...(security?.would_flag || [])];
  return f;
}
