/**
 * Post-close swap-back: sell the base token a close withdrew, and only that,
 * back to SOL.
 *
 * Balances are read on-chain (getOnchainTokenBalance, `confirmed`), not from
 * the Helius indexed balances API. That API lags behind txs that have just
 * confirmed, so right after a close it returned the pre-close balance (delta 0,
 * swap silently skipped) or a partly indexed one (only the first remove chunk
 * sold). All amounts here are raw integer units (bigint); they are converted to
 * a UI decimal string only for the swapToken call.
 *
 * Rules:
 * - Sell only this close's delta (post - pre), never the whole balance.
 * - Unknown pre-close balance: skip and flag exposure.
 * - When the expected withdrawal is known (position X + claimable fee X), sell
 *   at most expected + EXPECTED_TOLERANCE_BPS; anything above that is not
 *   attributable to this close and is left alone.
 * - Expected > 0 but no delta after polling: close_warn + exposure, never a
 *   silent skip.
 * - Dust gate only applies when a price is known; unpriced tokens still get a
 *   swap attempt.
 * - An ambiguous swap (may still land) is never retried here, since a retry
 *   could sell twice.
 */
import { log as defaultLog } from "../logger.js";
import { getOnchainTokenBalance, getTokenUsdPrice, swapToken } from "./wallet.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

export const DUST_USD = 0.10;
export const EXPECTED_TOLERANCE_BPS = 200n; // 2% above expected
export const MAX_ATTEMPTS = 3;
/** Delays before each post-close read on the first attempt: ~15s total. */
export const POLL_DELAYS_MS = [0, 500, 1000, 1500, 2000, 2500, 3000, 4500];
/** Delay before the balance re-read of attempt N (index 0 is the poll above). */
export const RETRY_BACKOFF_MS = [0, 1500, 3000];

// A price-impact refusal (wallet.js maxSwapPriceImpactPct) is terminal too: an
// immediate retry would quote the same thin route.
const TERMINAL_SWAP_ERROR = /no route|route not found|unsupported|invalid mint|mint not found|price impact/i;

/** Integer part of a BN / integer string / decimal string as a bigint, else null. */
export function toRawBigInt(v) {
  if (v == null) return null;
  const s = String(typeof v === "object" && typeof v.toString === "function" ? v.toString() : v).trim();
  const m = s.match(/^(\d+)(?:\.\d*)?$/);
  return m ? BigInt(m[1]) : null;
}

/** Exact raw → UI decimal string (no float rounding). */
export function rawToUiString(raw, decimals) {
  const dec = Number(decimals);
  if (!Number.isInteger(dec) || dec < 0) throw new Error(`Invalid decimals: ${decimals}`);
  const s = BigInt(raw).toString();
  if (dec === 0) return s;
  const padded = s.padStart(dec + 1, "0");
  const intPart = padded.slice(0, padded.length - dec);
  const frac = padded.slice(padded.length - dec).replace(/0+$/, "");
  return frac ? `${intPart}.${frac}` : intPart;
}

/**
 * Base-token amount (raw) the close is expected to withdraw: the position's
 * token X liquidity plus its claimable X fees, net of Token-2022 transfer fees
 * where the SDK reports them. Returns null when it can't be determined (base
 * token isn't pool token X, or the position data is missing).
 */
export function expectedBaseWithdrawRaw(pool, positionData, baseMint) {
  try {
    const xMint = pool?.lbPair?.tokenXMint?.toBase58?.() ?? pool?.lbPair?.tokenXMint?.toString?.();
    if (!baseMint || xMint !== baseMint) return null;
    const pd = positionData?.positionData;
    if (!pd) return null;
    const liq = toRawBigInt(pd.totalXAmountExcludeTransferFee) ?? toRawBigInt(pd.totalXAmount);
    const fee = toRawBigInt(pd.feeXExcludeTransferFee) ?? toRawBigInt(pd.feeX);
    if (liq == null || fee == null) return null;
    return liq + fee;
  } catch {
    return null;
  }
}

/**
 * @param {object} p
 * @param {string} p.baseMint
 * @param {string} [p.symbol]
 * @param {bigint|null} p.preRaw  pre-close on-chain balance (null = unknown)
 * @param {bigint|null} [p.expectedRaw] expected withdrawal (null = unknown)
 * @param {object} [deps] Test seam: { readBalance, getPrice, swap, sleep, log,
 *   pollDelaysMs, retryBackoffMs }.
 * @returns {Promise<{ swapOutcome: object|null, exposureFlag: boolean, txs: string[] }>}
 */
export async function swapBackWithdrawnBase({ baseMint, symbol = null, preRaw, expectedRaw = null }, deps = {}) {
  const readBalance = deps.readBalance ?? getOnchainTokenBalance;
  const getPrice = deps.getPrice ?? getTokenUsdPrice;
  const swap = deps.swap ?? swapToken;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log ?? defaultLog;
  const pollDelays = deps.pollDelaysMs ?? POLL_DELAYS_MS;
  const retryBackoff = deps.retryBackoffMs ?? RETRY_BACKOFF_MS;
  const label = symbol || baseMint.slice(0, 8);
  const txs = [];

  if (typeof preRaw !== "bigint") {
    log("close_warn", `Post-close swap skipped: pre-close balance for ${baseMint} unknown — leftover base token exposure, swap manually.`);
    return {
      exposureFlag: true,
      txs,
      // Nothing is attributable without a pre-close balance: the agent may not sell any of it.
      exposure: { mint: baseMint, decimals: null, pre_raw: null, unsold_raw: "0", ambiguous: false },
      swapOutcome: {
        success: false,
        mint: baseMint,
        attempts: 0,
        error: "pre-close base balance unknown; auto-swap skipped to avoid selling whole wallet balance",
      },
    };
  }

  const expectedKnown = typeof expectedRaw === "bigint" && expectedRaw >= 0n;
  const tol = expectedKnown ? (expectedRaw * EXPECTED_TOLERANCE_BPS) / 10000n : 0n;
  const capRaw = expectedKnown ? expectedRaw + tol : null;
  // Poll target, in total withdrawn seen (unsold delta + already sold).
  let targetRaw = 1n;
  if (expectedKnown) targetRaw = expectedRaw === 0n ? 0n : (expectedRaw - tol > 0n ? expectedRaw - tol : 1n);

  // Price is only for the dust gate; fetch it alongside the balance poll.
  const pricePromise = Promise.resolve().then(() => getPrice(baseMint)).catch(() => null);

  let soldRaw = 0n;
  let decimals = null;
  let lastDelta = null;
  let unsoldOverExpectedRaw = 0n;

  const readDelta = async (delays) => {
    let last = null;
    let err = null;
    for (const d of delays) {
      if (d) await sleep(d);
      try {
        const bal = await readBalance(baseMint);
        const delta = bal.raw > preRaw ? bal.raw - preRaw : 0n;
        last = { delta, decimals: bal.decimals };
        if (delta + soldRaw >= targetRaw) return last;
      } catch (e) {
        err = e;
      }
    }
    return last ?? { error: err?.message || "balance read failed" };
  };

  const ui = (raw) => (decimals == null ? `${raw} raw` : rawToUiString(raw, decimals));

  let attempts = 0;
  let swapCalls = 0;
  let lastError = null;
  let succeeded = false;
  let noDelta = false;
  let dustSkipped = false;
  let ambiguous = false;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const r = await readDelta(i === 0 ? pollDelays : [retryBackoff[i] ?? 3000]);
    if (r.error) {
      attempts = i + 1;
      lastError = `balance read failed: ${r.error}`;
      log("close_warn", `Post-close swap attempt ${i + 1}: ${lastError}`);
      continue;
    }
    if (r.decimals != null) decimals = r.decimals;
    lastDelta = r.delta;

    // Clamp to what this close can have withdrawn.
    let sellRaw = r.delta;
    if (capRaw != null) {
      const remainingCap = capRaw > soldRaw ? capRaw - soldRaw : 0n;
      if (sellRaw > remainingCap) {
        unsoldOverExpectedRaw = sellRaw - remainingCap;
        sellRaw = remainingCap;
        log("close_warn", `Post-close ${label} delta ${ui(r.delta)} exceeds the expected withdrawal ${ui(expectedRaw)} (+${EXPECTED_TOLERANCE_BPS / 100n}%); selling at most ${ui(sellRaw)} and leaving ${ui(unsoldOverExpectedRaw)} that is not attributable to this close.`);
      }
    }

    if (sellRaw <= 0n) {
      if (soldRaw > 0n || swapCalls > 0) {
        // Sold already, or a prior swap landed even though it reported failure.
        if (soldRaw > 0n && expectedKnown && soldRaw < targetRaw) {
          log("close_warn", `Post-close swap sold ${ui(soldRaw)} ${label}, less than the ~${ui(expectedRaw)} expected; the rest never showed in the wallet.`);
        }
        succeeded = true;
        break;
      }
      if (expectedKnown && expectedRaw > 0n) {
        noDelta = true;
        log("close_warn", `Post-close swap: expected ~${ui(expectedRaw)} ${label} withdrawn but no balance increase showed on-chain after polling — leftover base token exposure, check the wallet.`);
      } else if (!expectedKnown) {
        log("close_warn", `Post-close swap: no ${label} balance increase showed on-chain after polling and the expected withdrawal is unknown — nothing sold, check the wallet.`);
      } else if (r.delta === 0n) {
        log("close", `Post-close swap: nothing to sell, the close withdrew no ${label}.`);
      }
      break;
    }

    if (decimals == null) {
      attempts = i + 1;
      lastError = "token decimals unknown";
      log("close_warn", `Post-close swap attempt ${i + 1}: ${lastError}`);
      break;
    }

    const sellUi = rawToUiString(sellRaw, decimals);
    const price = await pricePromise;
    const sellUsd = price != null ? Number(sellUi) * price : null;
    if (sellUsd != null && sellUsd < DUST_USD) {
      dustSkipped = true;
      if (soldRaw > 0n) succeeded = true;
      log("close", `Post-close swap: leaving ${sellUi} ${label} (~$${sellUsd.toFixed(4)}), under the $${DUST_USD.toFixed(2)} dust gate.`);
      break;
    }

    attempts = i + 1;
    swapCalls++;
    log("close", `Auto-swapping ${sellUi} ${label} -> SOL (withdrawn delta, ${sellUsd != null ? `worth ~$${sellUsd.toFixed(2)}` : "unpriced"}) [attempt ${attempts}/${MAX_ATTEMPTS}]`);

    let res;
    try {
      res = await swap({ input_mint: baseMint, output_mint: SOL_MINT, amount: sellUi });
    } catch (e) {
      succeeded = false;
      lastError = e.message;
      log("close_warn", `Post-close swap attempt ${attempts} threw: ${lastError}`);
      continue;
    }

    if (res?.success) {
      log("close", `Post-close swap OK on attempt ${attempts}: tx ${res.tx}`);
      if (res.tx) txs.push(res.tx);
      soldRaw += sellRaw;
      succeeded = true;
      if (expectedKnown && soldRaw >= targetRaw) break;
      if (i === MAX_ATTEMPTS - 1) break;
      // Expected not reached yet (or unknown): re-read once more so a remove
      // chunk that showed up late is sold too.
      log("close", `Post-close swap sold ${ui(soldRaw)}${expectedKnown ? ` of ~${ui(expectedRaw)} expected` : ""} ${label}; re-reading for any remainder.`);
      continue;
    }

    succeeded = false;
    lastError = res?.error || "unknown";
    log("close_warn", `Post-close swap attempt ${attempts} failed: ${lastError}`);
    if (res?.ambiguous) {
      ambiguous = true;
      log("close_warn", `Post-close swap outcome unknown (tx may still land); not retrying, a retry could sell twice.`);
      break;
    }
    if (TERMINAL_SWAP_ERROR.test(lastError)) {
      log("close_warn", `Post-close swap terminal error, not retrying: ${lastError}`);
      break;
    }
  }

  const extra = {
    ...(soldRaw > 0n && decimals != null && { sold_ui: rawToUiString(soldRaw, decimals) }),
    ...(expectedKnown && decimals != null && { expected_ui: rawToUiString(expectedRaw, decimals) }),
    ...(unsoldOverExpectedRaw > 0n && decimals != null && { unsold_over_expected_ui: rawToUiString(unsoldOverExpectedRaw, decimals) }),
  };

  // What a later agent swap_token may sell for this close (tools/swap-guard.js):
  // the unsold withdrawn delta, clamped to the expected withdrawal minus what
  // was already sold. Zero when nothing is attributable.
  const exposureOf = (unsoldRaw) => ({
    mint: baseMint,
    decimals,
    pre_raw: preRaw.toString(),
    unsold_raw: (unsoldRaw > 0n ? unsoldRaw : 0n).toString(),
    ambiguous,
  });

  if (noDelta) {
    return {
      exposureFlag: true,
      txs,
      // The withdrawal never showed on-chain, so any balance of this mint is not attributable.
      exposure: exposureOf(0n),
      swapOutcome: {
        success: false,
        mint: baseMint,
        attempts: 0,
        error: "expected withdrawal never showed in the on-chain balance; nothing sold",
        ...extra,
      },
    };
  }

  if (attempts === 0) {
    const swapOutcome = dustSkipped
      ? { success: true, mint: baseMint, attempts: 0, skipped: "dust", ...extra }
      : null;
    return { exposureFlag: false, txs, swapOutcome };
  }

  if (succeeded) {
    return { exposureFlag: false, txs, swapOutcome: { success: true, mint: baseMint, attempts, ...extra } };
  }

  log("close_warn", `Post-close swap failed after ${attempts} attempt(s); withdrawn base token remains in wallet: ${baseMint}`);
  let attributableRaw = lastDelta != null && lastDelta > 0n && decimals != null ? lastDelta : 0n;
  if (capRaw != null) {
    const remainingCap = capRaw > soldRaw ? capRaw - soldRaw : 0n;
    if (attributableRaw > remainingCap) attributableRaw = remainingCap;
  }
  return {
    exposureFlag: true,
    txs,
    exposure: exposureOf(attributableRaw),
    swapOutcome: {
      success: false,
      mint: baseMint,
      attempts,
      error: lastError,
      ...(ambiguous && { ambiguous: true }),
      ...(lastDelta != null && lastDelta > 0n && decimals != null && { unsold_ui: rawToUiString(lastDelta, decimals) }),
      // The most a follow-up swap_token may sell for this close (0 = none).
      ...(decimals != null && { exposure_ui: rawToUiString(attributableRaw, decimals) }),
      ...extra,
    },
  };
}
