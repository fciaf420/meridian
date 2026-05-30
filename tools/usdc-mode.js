/**
 * USDC mode orchestration.
 *
 * When config.usdc.enabled is true, the agent treats USDC as its home /
 * accounting currency while still LPing into SOL-quoted Meteora pools:
 *   - ENTRY: swap a fixed USD amount of USDC → SOL, then deploy single-sided
 *            (bid_ask) SOL into the pool.
 *   - EXIT:  after a close, swap all recovered base tokens AND surplus SOL
 *            (everything above the gas reserve) back to USDC.
 *
 * Native SOL is never fully drained — config.usdc.gasReserveSol is kept for
 * transaction fees. Gas handling is warn-only: if SOL is below the reserve we
 * block new deploys and alert rather than auto-topping-up from USDC.
 *
 * All swaps honor DRY_RUN (no transaction is sent; sizing is estimated).
 */
import { config } from "../config.js";
import { log } from "../logger.js";
import { getWalletBalances, swapToken } from "./wallet.js";

const DUST_USD = 0.10; // don't swap holdings worth less than this (not worth gas)

export function usdcModeEnabled() {
  return !!config.usdc.enabled;
}

/** Pure helper: USD → SOL at a given SOL price. */
export function usdToSol(usd, solPrice) {
  if (!solPrice || solPrice <= 0) return 0;
  return usd / solPrice;
}

/**
 * Check the native-SOL gas reserve.
 * @returns {{ ok: boolean, sol: number, reserve: number }}
 */
export async function checkGasReserve(balance = null) {
  const b = balance ?? (await getWalletBalances());
  const reserve = config.usdc.gasReserveSol;
  return { ok: (b.sol ?? 0) >= reserve, sol: b.sol ?? 0, reserve };
}

/**
 * Preflight + fund a USDC-mode entry.
 *
 * Performs all "can we even deploy?" gating BEFORE swapping, so we never
 * convert USDC→SOL and then get blocked (which would leave the user holding
 * unwanted SOL). Only once cleared does it swap USDC→SOL.
 *
 * @param {object} opts
 * @param {number} [opts.amountUsd] - USD to deploy (defaults to config.usdc.deployAmountUsd)
 * @returns {Promise<{ ok: boolean, amount_y?: number, usd_spent?: number,
 *   sol_price?: number, swap_tx?: string, dry_run?: boolean, reason?: string, gas_low?: boolean }>}
 */
export async function prepareUsdcEntry({ amountUsd } = {}) {
  const usd = amountUsd ?? config.usdc.deployAmountUsd;
  const reserve = config.usdc.gasReserveSol;

  // ── USD amount sanity / cap ──────────────────────────────────
  if (!(usd > 0)) {
    return { ok: false, reason: `Deploy USD amount must be positive (got ${usd}).` };
  }
  if (usd > config.usdc.maxDeployUsd) {
    return { ok: false, reason: `Deploy amount $${usd} exceeds the per-position cap of $${config.usdc.maxDeployUsd}.` };
  }

  const bal = await getWalletBalances();
  if (bal.error) {
    return { ok: false, reason: `Could not read wallet balances: ${bal.error}` };
  }

  // ── Gas reserve (warn-only) ──────────────────────────────────
  if ((bal.sol ?? 0) < reserve) {
    return {
      ok: false,
      gas_low: true,
      reason: `SOL balance ${bal.sol} is below the gas reserve of ${reserve} SOL. ` +
              `Top up native SOL to enable USDC-mode deploys (auto top-up is disabled).`,
    };
  }

  // ── USDC funds ───────────────────────────────────────────────
  if ((bal.usdc ?? 0) < usd) {
    return { ok: false, reason: `Insufficient USDC: have $${bal.usdc}, need $${usd}.` };
  }

  const solPrice = bal.sol_price || 0;
  if (!solPrice) {
    return { ok: false, reason: "Could not determine SOL price for USD→SOL sizing." };
  }

  // ── DRY RUN: estimate, no swap ───────────────────────────────
  if (process.env.DRY_RUN === "true") {
    return {
      ok: true,
      dry_run: true,
      amount_y: usdToSol(usd, solPrice),
      usd_spent: usd,
      sol_price: solPrice,
    };
  }

  // ── Swap USDC → SOL ──────────────────────────────────────────
  log("usdc", `Entry: swapping $${usd} USDC → SOL (price $${solPrice})`);
  const swap = await swapToken({
    input_mint: config.tokens.USDC,
    output_mint: config.tokens.SOL,
    amount: usd,
  });
  if (!swap.success) {
    return { ok: false, reason: `USDC→SOL swap failed: ${swap.error}` };
  }

  // Prefer the actual SOL received; fall back to a haircut estimate.
  const solAcquired = swap.out_ui != null ? swap.out_ui : usdToSol(usd, solPrice) * 0.99;
  log("usdc", `Entry: acquired ${solAcquired} SOL (tx ${swap.tx})`);

  return {
    ok: true,
    amount_y: solAcquired,
    usd_spent: usd,
    sol_price: solPrice,
    swap_tx: swap.tx,
  };
}

/**
 * Settle the wallet back to USDC after a position close.
 * Swaps every non-USDC SPL token worth >= $0.10 to USDC, then swaps surplus
 * SOL (everything above the gas reserve) to USDC.
 *
 * @returns {Promise<{ settled: number, results: object[], dry_run?: boolean }>}
 */
export async function settleToUsdc() {
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, settled: 0, results: [] };
  }

  const bal = await getWalletBalances();
  if (bal.error) {
    log("usdc", `Settle skipped — balance read failed: ${bal.error}`);
    return { settled: 0, results: [], error: bal.error };
  }

  const reserve = config.usdc.gasReserveSol;
  const results = [];

  // ── 1. Non-USDC / non-SOL token holdings → USDC ──────────────
  for (const t of bal.tokens || []) {
    if (!t.mint) continue;
    if (t.mint === config.tokens.USDC) continue;
    if (t.mint === config.tokens.SOL) continue; // handled separately below
    if ((t.usd ?? 0) < DUST_USD) continue;
    if (!(t.balance > 0)) continue;
    log("usdc", `Settle: ${t.symbol} ($${t.usd}) → USDC`);
    const r = await swapToken({ input_mint: t.mint, output_mint: config.tokens.USDC, amount: t.balance });
    results.push({ token: t.symbol, mint: t.mint, success: r.success, tx: r.tx, error: r.error });
  }

  // ── 2. Surplus SOL (above gas reserve) → USDC ────────────────
  const surplusSol = (bal.sol ?? 0) - reserve;
  const surplusUsd = surplusSol * (bal.sol_price ?? 0);
  if (surplusSol > 0 && surplusUsd >= DUST_USD) {
    log("usdc", `Settle: ${surplusSol} surplus SOL ($${surplusUsd.toFixed(2)}) → USDC`);
    const r = await swapToken({ input_mint: config.tokens.SOL, output_mint: config.tokens.USDC, amount: surplusSol });
    results.push({ token: "SOL", mint: config.tokens.SOL, success: r.success, tx: r.tx, error: r.error });
  }

  const settled = results.filter((r) => r.success).length;
  log("usdc", `Settle complete — ${settled}/${results.length} swaps to USDC`);
  return { settled, results };
}
