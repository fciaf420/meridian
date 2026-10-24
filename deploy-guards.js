/**
 * deploy-guards.js — pure deploy-time safety checks (no I/O except the one
 * injectable pool fetch), so each rule is unit-testable.
 *
 * Ported by hand from yunus-0x/meridian:
 *   - 3427771  re-enforce screening thresholds at deploy time
 *   - exit-rules.js computeBinsBelow(): refuse a deploy when volatility is unknown
 *   - standalone/runtime.js finalRecheck(): max price move between screening and send
 */

import { fitDeployAmount } from "./runtime-helpers.js";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";

const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ─── Volatility must be known ─────────────────────────────────────

/**
 * Unknown (missing / NaN / non-numeric) or negative volatility means the data is
 * broken, so never deploy blind. ZERO IS VALID: Pool Discovery reports
 * volatility 0 whenever every trade in the window stayed inside one bin, which
 * is routine for wide-bin-step pools at the 5m timeframe (audit finding 1).
 * This repo does not size bins from volatility, so 0 is not a sizing hazard.
 * @returns {{pass:true, volatility:number}|{pass:false, reason:string}}
 */
export function checkVolatilityKnown(volatility) {
  const v = num(volatility);
  if (v == null || v < 0) {
    return { pass: false, reason: `Volatility is ${volatility == null || volatility === "" ? "unknown" : `invalid (${volatility})`}; refusing to deploy a range that cannot be sized against real volatility.` };
  }
  return { pass: true, volatility: v };
}

/**
 * Pick the volatility to validate: a fresh positive reading wins over a stale
 * zero (the screener's 0 may predate the fresh one). Order: caller value if
 * positive, else fresh pool value if positive, else whichever is known (0 is a
 * legitimate "no bin crossings"), else the caller value (unknown -> refused).
 */
export function pickVolatility(fromArgs, fromFreshPool) {
  const a = num(fromArgs), p = num(fromFreshPool);
  if (a != null && a > 0) return a;
  if (p != null && p > 0) return p;
  if (a != null) return a;
  if (p != null) return p;
  return fromArgs ?? fromFreshPool;
}

// ─── Refusal counters (visible in Status) ─────────────────────────
const refusals = { recheck: 0, volatility: 0, screen_drift: 0, eligibility: 0, pre_submit: 0, other: 0 };
let lastRefusal = null;
/** Count a deploy refusal by kind; remembers the most recent reason. */
export function recordRefusal(kind, reason = "") {
  const k = Object.hasOwn(refusals, kind) ? kind : "other";
  refusals[k]++;
  lastRefusal = { kind: k, reason: String(reason).slice(0, 200), at: Date.now() };
}
export function getRefusalStats() { return { ...refusals, total: Object.values(refusals).reduce((a, b) => a + b, 0), last: lastRefusal }; }
export function resetRefusalStats() { for (const k of Object.keys(refusals)) refusals[k] = 0; lastRefusal = null; }

// ─── Screening -> deploy price drift ──────────────────────────────
// getTopCandidates() records the price it showed for each candidate here, so the
// screening -> LLM -> deploy gap is guarded in code even if the model omits
// screen_price from deploy_position.
const screened = new Map();
const SCREEN_SNAPSHOT_TTL_MS = 60 * 60_000;
export function noteScreenedPrice(pool, price, now = Date.now()) {
  const p = num(price);
  if (!pool || p == null || p <= 0) return;
  screened.set(String(pool), { price: p, at: now });
  if (screened.size > 500) for (const [k, v] of screened) if (now - v.at > SCREEN_SNAPSHOT_TTL_MS) screened.delete(k);
}
/** The candidate was shown with a price NOT comparable to pool_price (e.g. GMGN USD): never compare, and ignore any model-supplied screen_price. */
export function noteUncomparableScreenPrice(pool, now = Date.now()) {
  if (pool) screened.set(String(pool), { price: null, at: now, uncomparable: true });
}
export function isScreenPriceUncomparable(pool, now = Date.now(), ttlMs = SCREEN_SNAPSHOT_TTL_MS) {
  const v = screened.get(String(pool));
  return !!(v && v.uncomparable && now - v.at <= ttlMs);
}
export function getScreenedPrice(pool, now = Date.now(), ttlMs = SCREEN_SNAPSHOT_TTL_MS) {
  const v = screened.get(String(pool));
  return v && v.price != null && now - v.at <= ttlMs ? v.price : null;
}
export function clearScreenedPrices() { screened.clear(); }

/**
 * Compare the price seen at screening with the fresh pool price. Both numbers
 * must be Pool Discovery `pool_price` (SOL per token); never mix in a GMGN USD
 * price. DROP-ONLY: refuses only when the price fell more than `maxDropPct`.
 * For a single-sided SOL deposit below the active bin a rise is harmless (the
 * range is anchored on the active bin at deploy time), so rises pass; callers
 * log them (`rose: true`). maxDropPct <= 0 disables the check.
 * Returns pass with checked:false when either side is missing.
 */
export function checkScreenPriceDrift({ screenPrice, freshPrice, maxDropPct }) {
  const a = num(screenPrice), b = num(freshPrice), max = num(maxDropPct);
  if (a == null || a <= 0 || b == null || b <= 0) return { pass: true, checked: false };
  const movePct = ((b - a) / a) * 100;
  if (max != null && max > 0 && movePct < -max) {
    return { pass: false, checked: true, movePct, reason: `price dropped ${Math.abs(movePct).toFixed(1)}% between screening (${a}) and deploy (${b}); limit is ${max}%` };
  }
  return { pass: true, checked: true, movePct, rose: movePct > 0 };
}

// ─── Screening thresholds, re-checked at deploy ───────────────────

/**
 * Fetch one pool from the Pool Discovery API (raw record). `fetchImpl` is
 * injectable. Throws on HTTP error; resolves null when the pool is not found.
 */
export const RECHECK_FETCH_TIMEOUT_MS = 8000;
export async function fetchPoolForRecheck(poolAddress, timeframe = "5m", fetchImpl = fetch) {
  const filter = encodeURIComponent(`pool_address=${poolAddress}`);
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${encodeURIComponent(timeframe)}`;
  // L1: bounded (8s) and fail closed: a timeout/abort throws, so the deploy is refused.
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(RECHECK_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const row = (data?.data || [])[0] ?? null;
  // Echo-check: the filter must have matched the pool we asked about.
  if (row && String(row.pool_address) !== String(poolAddress)) return null;
  return row;
}

/**
 * Evaluate a raw Pool Discovery record against config.screening. Mirrors the
 * server-side filter_by used by discoverPools() plus its local post-filters.
 *
 * Pool-level fields (tvl, volume, fee/active-TVL, volatility) fail closed when
 * missing. Token-level fields (holders, mcap, organic) are skipped with a note
 * when the API omits them, because absence there is not evidence of a bad pool.
 *
 * @returns {{pass:true, notes:string[]}|{pass:false, reason:string}}
 */
export function evaluatePoolThresholds(pool, s) {
  if (!pool) return { pass: false, reason: "Pool not found in Pool Discovery; cannot verify screening thresholds." };
  const notes = [];
  const fail = (reason) => ({ pass: false, reason });
  const active = (v) => v != null && v > 0; // a null/0 bound means "no limit"

  if (pool.is_blacklisted === true) return fail("Pool is flagged blacklisted by Meteora.");

  const tvl = num(pool.tvl ?? pool.active_tvl);
  if (tvl == null) return fail("Could not verify pool TVL before deploy.");
  if (active(num(s.minTvl)) && tvl < s.minTvl) return fail(`Pool TVL $${Math.round(tvl)} is below minTvl $${s.minTvl}.`);
  if (active(num(s.maxTvl)) && tvl > s.maxTvl) return fail(`Pool TVL $${Math.round(tvl)} is above maxTvl $${s.maxTvl}.`);

  const volume = num(pool.volume);
  if (active(num(s.minVolume))) {
    if (volume == null) return fail("Could not verify pool volume before deploy.");
    if (volume < s.minVolume) return fail(`Pool ${s.timeframe ?? ""} volume $${Math.round(volume)} is below minVolume $${s.minVolume}.`.replace("  ", " "));
  }

  // Same derivation as condensePool(): API ratio, else fee / active TVL.
  let ratio = num(pool.fee_active_tvl_ratio);
  if (!(ratio > 0)) {
    const at = num(pool.active_tvl), fee = num(pool.fee);
    ratio = at > 0 && fee != null ? (fee / at) * 100 : 0;
  }
  if (active(num(s.minFeeActiveTvlRatio)) && ratio < s.minFeeActiveTvlRatio) {
    return fail(`Pool fee/active-TVL ${ratio.toFixed(4)}% is below minFeeActiveTvlRatio ${s.minFeeActiveTvlRatio}%.`);
  }

  const bs = num(pool.dlmm_params?.bin_step);
  if (bs != null) {
    if (num(s.minBinStep) != null && bs < s.minBinStep) return fail(`Pool bin_step ${bs} is below minBinStep ${s.minBinStep}.`);
    if (num(s.maxBinStep) != null && bs > s.maxBinStep) return fail(`Pool bin_step ${bs} is above maxBinStep ${s.maxBinStep}.`);
  }

  const vol = num(pool.volatility);
  if (vol == null) return fail("Could not verify pool volatility before deploy.");
  if (active(num(s.maxVolatility)) && vol > s.maxVolatility) return fail(`Pool volatility ${vol} is above maxVolatility ${s.maxVolatility}.`);

  const chg = num(pool.pool_price_change_pct);
  if (chg != null && active(num(s.maxPriceChangePct)) && Math.abs(chg) > s.maxPriceChangePct) {
    return fail(`Pool price change ${chg}% exceeds maxPriceChangePct ${s.maxPriceChangePct}%.`);
  }

  const holders = num(pool.base_token_holders);
  if (active(num(s.minHolders))) {
    if (holders == null) notes.push("holders unavailable; not re-checked");
    else if (holders < s.minHolders) return fail(`Token holders ${holders} is below minHolders ${s.minHolders}.`);
  }
  const mcap = num(pool.token_x?.market_cap);
  if (mcap == null) {
    if (active(num(s.minMcap)) || active(num(s.maxMcap))) notes.push("market cap unavailable; not re-checked");
  } else {
    if (active(num(s.minMcap)) && mcap < s.minMcap) return fail(`Token market cap $${Math.round(mcap)} is below minMcap $${s.minMcap}.`);
    if (active(num(s.maxMcap)) && mcap > s.maxMcap) return fail(`Token market cap $${Math.round(mcap)} is above maxMcap $${s.maxMcap}.`);
  }
  const organic = num(pool.token_x?.organic_score);
  if (active(num(s.minOrganic))) {
    if (organic == null) notes.push("organic score unavailable; not re-checked");
    else if (organic < s.minOrganic) return fail(`Token organic score ${Math.round(organic)} is below minOrganic ${s.minOrganic}.`);
  }

  return { pass: true, notes, volatility: vol, binStep: bs, poolPrice: num(pool.pool_price) };
}

// ─── Price move between two active bins ───────────────────────────

/**
 * Price change (%) implied by an active-bin shift. DLMM price(bin) =
 * (1 + binStep/10000)^bin, so a move of d bins is (1+step)^d - 1.
 */
export function priceMovePctBetweenBins(binStep, fromBinId, toBinId) {
  const step = num(binStep);
  if (step == null || step <= 0 || !Number.isFinite(fromBinId) || !Number.isFinite(toBinId)) return null;
  return (Math.pow(1 + step / 10_000, toBinId - fromBinId) - 1) * 100;
}

/**
 * @returns {{pass:boolean, movePct:number|null, reason?:string}}
 */
export function checkEntryPriceMove({ binStep, fromBinId, toBinId, maxMovePct, dropOnly = false }) {
  const movePct = priceMovePctBetweenBins(binStep, fromBinId, toBinId);
  if (movePct == null) return { pass: false, movePct: null, reason: "price unavailable for move check (bin step or active bin unknown)" };
  const max = num(maxMovePct);
  // dropOnly: a rise is harmless when no token X leg is deposited (SOL-only
  // bins sit below the active bin); only a fall past the limit refuses.
  if (max != null && max > 0 && (dropOnly ? movePct < -max : Math.abs(movePct) > max)) {
    return { pass: false, movePct, reason: `price moved ${movePct.toFixed(1)}% (active bin ${fromBinId} → ${toBinId}) since the deploy started; limit is ${max}%` };
  }
  return { pass: true, movePct };
}

// ─── Deposit slippage ─────────────────────────────────────────────

/**
 * Deposit slippage, expressed the way the SDK uses it.
 *
 * @meteora-ag/dlmm 1.9.x turns the `slippage` percentage into an allowed
 * active-bin drift:   maxActiveBinSlippage = ceil(slippage / (binStep / 100))
 * i.e. the tx reverts on-chain if the active bin moved more than that many bins
 * between build and landing. Examples at slippage 5%:
 *   bin step  80 (0.80%/bin) -> ceil(6.25) = 7 bins (~5.6% max drift)
 *   bin step 100 (1.00%/bin) -> 5 bins
 *   bin step 125 (1.25%/bin) -> 4 bins
 * The old hard-coded 10% allowed 13 / 10 / 8 bins respectively.
 * (In the wide-range chunkable path the same percentage also pads the per-chunk
 * max deposit by that much; that is only a ceiling, never extra spend.)
 *
 * `pct` is clamped to [1 bin, 25%]. Non-numeric -> 5.
 * @returns {{slippagePct:number, driftBins:number}}
 */
export function depositSlippage(binStep, pct) {
  const step = num(binStep);
  const stepPct = step != null && step > 0 ? step / 100 : null;
  let p = num(pct);
  if (p == null || p <= 0) p = 5;
  p = Math.min(p, 25);
  if (stepPct == null) return { slippagePct: p, driftBins: null };
  p = Math.max(p, stepPct); // never below one bin of drift
  return { slippagePct: p, driftBins: Math.ceil(p / stepPct) };
}

// ─── Gate immediately before the first deploy tx ──────────────────

/**
 * Last look before any transaction is built or sent: refresh the pool, make
 * sure the price has not run away since the deploy started (and since the range
 * anchor was taken), and that free SOL still covers deposit + rent + reserve.
 * Only gates the FIRST tx of a deploy; once the position exists, finishing the
 * sequence is safer than abandoning a half-built one.
 *
 * Injected so it is unit-testable: refetch() refreshes the pool, getActiveId()
 * reads pool.lbPair.activeId, readFreeSol() returns SOL (not lamports).
 *
 * @returns {Promise<{pass:true, movePct:number, freeSol:number|null}|{pass:false, reason:string}>}
 */
export async function preSubmitGate({
  refetch, getActiveId, readFreeSol,
  binStep, loadBinId, anchorBinId, maxMovePct,
  reserve, amount, totalBins,
  allowShrink = false, minAmount = 0.1, dropOnly = false,
}) {
  try { await refetch(); } catch (e) { return { pass: false, reason: `fresh pool read failed (${e.message})` }; }
  const nowBin = getActiveId();

  let worst = 0;
  for (const from of [loadBinId, anchorBinId]) {
    if (from == null) continue;
    const m = checkEntryPriceMove({ binStep, fromBinId: from, toBinId: nowBin, maxMovePct, dropOnly });
    if (!m.pass) return { pass: false, reason: m.reason };
    if (Math.abs(m.movePct) > Math.abs(worst)) worst = m.movePct;
  }

  let freeSol = null;
  if (num(amount) > 0) {
    try { freeSol = await readFreeSol(); } catch (e) { return { pass: false, reason: `balance read unavailable (${e.message})` }; }
    if (!Number.isFinite(freeSol)) return { pass: false, reason: "balance read unavailable" };
    const fit = fitDeployAmount({ freeSol, reserve, amount, totalBins });
    if (fit.shrunk && allowShrink && fit.amount >= minAmount) {
      // Shrink-to-fit instead of refusing (used after an auto-swap, where a
      // refusal would strand the swapped token): deploy a smaller SOL leg.
      return { pass: true, movePct: worst, freeSol, shrunk: true, amount: fit.amount };
    }
    if (fit.shrunk) {
      return { pass: false, reason: `insufficient spendable SOL: ${freeSol.toFixed(4)} free cannot cover ${amount} SOL + ~${fit.overhead.toFixed(4)} rent/fees and the ${reserve} SOL reserve` };
    }
  }
  return { pass: true, movePct: worst, freeSol, shrunk: false, amount: num(amount) };
}

// ─── Undo an auto-swap when the deploy is refused afterwards ──────

/**
 * Sell the token bought by the two-sided auto-swap back to SOL, so a refusal
 * after the swap never leaves the wallet holding a memecoin with no position.
 * Never throws. `swapFn` is swapToken-compatible.
 * @returns {Promise<{ok:boolean, note:string}>}
 */
export async function swapBackAfterRefusal({ swapFn, baseMint, amount, solMint, log = () => {}, onFail = null }) {
  const res = await swapBackInner({ swapFn, baseMint, amount, solMint, log });
  if (!res.ok) { try { onFail?.(res); } catch { /* alert is best-effort */ } }
  return res;
}

async function swapBackInner({ swapFn, baseMint, amount, solMint, log }) {
  if (!(Number(amount) > 0)) return { ok: false, note: "no swapped token amount recorded; nothing to swap back" };
  try {
    // "close" impact cap (same setting as post-close swap-backs, default 25%): leaving the bag is worse than slippage.
    const r = await swapFn({ input_mint: baseMint, output_mint: solMint, amount }, { impactCap: "close" });
    if (r?.success || r?.dry_run) {
      log(`Swapped ${amount} ${String(baseMint).slice(0, 8)}... back to SOL after refusal`);
      return { ok: true, note: "swapped back to SOL" };
    }
    return { ok: false, note: `swap-back failed (${r?.error ?? "unknown"}); token ${baseMint} remains in the wallet` };
  } catch (e) {
    return { ok: false, note: `swap-back errored (${e.message}); token ${baseMint} remains in the wallet` };
  }
}
