// portfolio-value.js — pure valuation of open DLMM positions, shared by the
// Telegram Wallet screen (telegram-ui.js computeWalletTotals) and deploy sizing
// (config.js resolveDeploySizing). No imports, no I/O.
//
// A position's value is total_value_usd (or total_value_sol × SOL price) plus
// its unclaimed fees, counted once: both position sources exclude fees from
// the value. LP Agent `value` reconciles as value + collectedFee +
// unCollectedFee − inputValue = pnl.value, and Meteora's
// UnrealizedPnL.balances is the token X + Y balance with unclaimed fees
// reported separately (dlmm.datapi OpenAPI).
//
// A value that is missing or 0 is UNKNOWN (known: false), never counted as 0.

const finitePos = (v) => { const n = Number(v); return v != null && Number.isFinite(n) && n > 0 ? n : null; };

/** SOL price in USD: the wallet's Helius price first, then any position's. null when unknown. */
export function resolveSolPrice(wallet, posList = []) {
  return finitePos(wallet?.sol_price) ?? finitePos((posList || []).find((p) => finitePos(p?.sol_price))?.sol_price);
}

/**
 * Value each open position. `price` converts total_value_sol when USD is
 * missing. Returns { positions: [{ position, pair, known, valueUsd, feesUsd,
 * totalUsd, raw }], dlmmUsd, unknownCount } — dlmmUsd sums known positions only.
 */
export function valueDlmmPositions(posList, price) {
  const positions = (Array.isArray(posList) ? posList : []).map((p) => {
    const valueUsd = finitePos(p.total_value_usd) ?? (price && finitePos(p.total_value_sol) ? finitePos(p.total_value_sol) * price : null);
    const feesUsd = Number.isFinite(Number(p.unclaimed_fees_usd)) && Number(p.unclaimed_fees_usd) > 0 ? Number(p.unclaimed_fees_usd) : 0;
    return {
      position: p.position,
      pair: p.pair ?? null,
      known: valueUsd != null,
      valueUsd,
      feesUsd,
      totalUsd: valueUsd != null ? valueUsd + feesUsd : null,
      raw: p,
    };
  });
  const dlmmUsd = positions.reduce((a, x) => a + (x.known ? x.totalUsd : 0), 0);
  const unknownCount = positions.filter((x) => !x.known).length;
  return { positions, dlmmUsd, unknownCount };
}

/**
 * Deploy-sizing total: free wallet SOL + the SOL value of every open DLMM
 * position (value + unclaimed fees). Other wallet tokens are not counted.
 *
 * Returns { ok: true, totalSol, walletSol, dlmmSol, positionCount, price } or
 * { ok: false, reason } when the total can't be trusted: the positions
 * weren't loaded or the load failed, a position's value is unknown, or there
 * are positions but no SOL price to convert them. Callers then fall back to
 * the free-wallet basis instead of counting an unknown value as 0.
 */
export function computePortfolioSol({ walletSol, wallet = null, positionsResult = null } = {}) {
  const free = Number(walletSol);
  if (!Number.isFinite(free) || free < 0) return { ok: false, reason: "free wallet SOL unknown" };
  if (!positionsResult) return { ok: false, reason: "positions not loaded" };
  if (positionsResult.error) return { ok: false, reason: `positions unavailable (${positionsResult.error})` };
  const posList = Array.isArray(positionsResult.positions) ? positionsResult.positions : null;
  if (!posList) return { ok: false, reason: "positions not loaded" };
  if (posList.length === 0) return { ok: true, totalSol: free, walletSol: free, dlmmSol: 0, positionCount: 0, price: resolveSolPrice(wallet, posList) };
  const price = resolveSolPrice(wallet, posList);
  if (!price) return { ok: false, reason: "SOL price unknown, can't convert position values" };
  const v = valueDlmmPositions(posList, price);
  if (v.unknownCount > 0) return { ok: false, reason: `${v.unknownCount} position${v.unknownCount === 1 ? "" : "s"} with unknown value` };
  const dlmmSol = v.dlmmUsd / price;
  return { ok: true, totalSol: free + dlmmSol, walletSol: free, dlmmSol, positionCount: posList.length, price };
}
