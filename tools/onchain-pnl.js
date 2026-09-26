// tools/onchain-pnl.js — SOL-denominated PnL of an open DLMM position, read
// straight from chain. Used to confirm PnL-triggered exits: the LP Agent /
// Meteora PnL APIs can report nonsense for the first minutes of a position
// (seen live: +7.4% and +33% on positions that were flat on-chain), and the
// watcher used to close on those readings.
//
// value  = Σ bins (X at the active price + Y) + unclaimed fees X/Y
// deposit = tracked amount_sol + tracked amount_x at the deploy-bin price
// pnlPct = (value + fees claimed earlier − deposit) / deposit
//   fees claimed earlier = total_fees_claimed_sol (recordClaim), plus any
//   USD-only claims converted at the SOL price
//
// Read-only (getPosition + getActiveBin through the shared pool cache), cached
// ~20s per position. Never throws: returns null when the read or the inputs
// are unusable, and the caller decides what "unknown" means for its exit.

import { log } from "../logger.js";

export const ONCHAIN_PNL_CACHE_MS = 20_000;
export const SOL_MINT = "So11111111111111111111111111111111111111112";

let deps = null; // test seam: { getPool, getTrackedPosition, PublicKey, now }
const cache = new Map();
const inflight = new Map();

export function _setOnchainPnlDepsForTest(d) {
  deps = d;
  cache.clear();
  inflight.clear();
}

const nowMs = () => (deps?.now ? deps.now() : Date.now());

async function loadPool(poolAddress) {
  if (deps?.getPool) return deps.getPool(poolAddress);
  const { getPoolForRead } = await import("./dlmm.js");
  return getPoolForRead(poolAddress);
}

async function loadTracked(address) {
  if (deps?.getTrackedPosition) return deps.getTrackedPosition(address);
  const { getTrackedPosition } = await import("../state.js");
  return getTrackedPosition(address);
}

async function loadPublicKey() {
  if (deps?.PublicKey) return deps.PublicKey;
  const { PublicKey } = await import("@solana/web3.js");
  return PublicKey;
}

const num = (v) => {
  const n = Number(String(v ?? 0));
  return Number.isFinite(n) ? n : NaN;
};

/** Price of X in Y (UI units) at a bin id. */
export function binPrice(binId, binStep, decX, decY) {
  return Math.pow(1 + Number(binStep) / 10_000, Number(binId)) * 10 ** (Number(decX) - Number(decY));
}

/**
 * Pure: PnL in SOL from a position read. Returns null when the pool has no
 * SOL side or an input is missing.
 *
 * pool:         { tokenX: { publicKey, mint: { decimals } }, tokenY: {...}, lbPair: { binStep } }
 * positionData: SDK `position.positionData` (positionBinData[], feeX, feeY)
 * activePrice:  price of X in Y (UI units) at the active bin
 * tracked:      state.json record (amount_sol, amount_x, active_bin_at_deploy, …)
 * solPriceUsd:  optional; converts claims recorded only in USD to SOL, and gives pnlPctUsd
 */
export function computeOnchainPnl({ pool, positionData, activePrice, tracked, solPriceUsd = null }) {
  if (!pool || !positionData || !tracked) return null;
  const decX = Number(pool.tokenX?.mint?.decimals ?? pool.tokenX?.decimal);
  const decY = Number(pool.tokenY?.mint?.decimals ?? pool.tokenY?.decimal);
  if (!Number.isInteger(decX) || !Number.isInteger(decY)) return null;
  const mintX = pool.tokenX?.publicKey?.toString?.() ?? null;
  const mintY = pool.tokenY?.publicKey?.toString?.() ?? null;
  // Meridian pairs are TOKEN-SOL (SOL = Y). Handle an inverted SOL-TOKEN pool
  // too; anything without a SOL side has no SOL PnL.
  const solIsX = mintX === SOL_MINT && mintY !== SOL_MINT;
  if (!solIsX && mintY !== SOL_MINT) return null;
  const px = Number(activePrice);
  if (!Number.isFinite(px) || px <= 0) return null;

  const bins = Array.isArray(positionData.positionBinData) ? positionData.positionBinData : [];
  let rawX = 0;
  let rawY = 0;
  if (bins.length) {
    for (const b of bins) {
      rawX += num(b.positionXAmount);
      rawY += num(b.positionYAmount);
    }
  } else {
    rawX = num(positionData.totalXAmount);
    rawY = num(positionData.totalYAmount);
  }
  const feeRawX = num(positionData.feeX);
  const feeRawY = num(positionData.feeY);
  if (![rawX, rawY, feeRawX, feeRawY].every(Number.isFinite)) return null;

  const x = rawX / 10 ** decX;
  const y = rawY / 10 ** decY;
  const fx = feeRawX / 10 ** decX;
  const fy = feeRawY / 10 ** decY;
  // Value in SOL: SOL side as is, the token side at the active price.
  const toSol = solIsX ? (tok, sol) => sol + tok / px : (tok, sol) => sol + tok * px;
  const valueSol = solIsX ? toSol(y, x) : toSol(x, y);
  const feesSol = solIsX ? toSol(fy, fx) : toSol(fx, fy);

  // Deposit: tracked SOL plus the tracked token amount at the deploy-bin price
  // (single-sided SOL deploys: amount_x = 0, so amount_sol is exact).
  const amountSol = Number(tracked.amount_sol);
  const amountX = Number(tracked.amount_x) || 0;
  if (!Number.isFinite(amountSol) || amountSol < 0) return null;
  let depositSol = amountSol;
  if (amountX > 0 && !tracked.adopted) {
    // Adopted positions: amount_sol already holds the whole deposit in SOL (LP Agent initial_value_sol).
    const binStep = Number(pool.lbPair?.binStep ?? tracked.bin_step);
    const deployBin = Number(tracked.active_bin_at_deploy);
    const deployPx = Number.isFinite(deployBin) && Number.isFinite(binStep) && binStep > 0
      ? binPrice(deployBin, binStep, decX, decY)
      : px;
    depositSol += solIsX ? amountX / deployPx : amountX * deployPx;
  }
  if (!(depositSol > 0)) return null;

  // Fees claimed earlier left the position; add them back in SOL.
  const claimedSol = claimedFeesSol(tracked, { solPriceUsd, amountSol, amountX });

  const pnlSol = valueSol + feesSol + claimedSol - depositSol;
  const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
  // USD view (pnlUnit "usd"): today's SOL price against the recorded USD deposit.
  const initialUsd = Number(tracked.initial_value_usd);
  const pnlPctUsd = Number(solPriceUsd) > 0 && initialUsd > 0
    ? round((((valueSol + feesSol + claimedSol) * Number(solPriceUsd)) / initialUsd - 1) * 100, 2)
    : null;
  return {
    pnlPct: round((pnlSol / depositSol) * 100, 2),
    pnlPctUsd,
    pnlSol: round(pnlSol, 6),
    valueSol: round(valueSol, 6),
    depositSol: round(depositSol, 6),
    feesSol: round(feesSol, 6),
    ...(claimedSol > 0 && { claimedFeesSol: round(claimedSol, 6) }),
    tokenAmount: x,
    solAmount: y,
  };
}

/**
 * Fees claimed earlier from a tracked position, in SOL. recordClaim (state.js)
 * keeps the SOL amount of each claim in total_fees_claimed_sol; a claim that
 * only had a USD figure (fees_claimed_usd_unpriced, or every claim of a
 * record from before the SOL figure existed) is converted with the SOL price,
 * falling back to the entry SOL price of a single-sided SOL deposit.
 */
export function claimedFeesSol(tracked, { solPriceUsd = null, amountSol = Number(tracked?.amount_sol), amountX = Number(tracked?.amount_x) || 0 } = {}) {
  if (!tracked) return 0;
  const solField = tracked.total_fees_claimed_sol;
  const hasSolField = solField != null && Number.isFinite(Number(solField));
  const claimedSolRecorded = hasSolField ? Math.max(0, Number(solField)) : 0;
  const unpricedUsd = hasSolField
    ? Number(tracked.fees_claimed_usd_unpriced) || 0
    : Number(tracked.total_fees_claimed_usd) || 0; // legacy record: USD only
  let fromUsd = 0;
  if (unpricedUsd > 0) {
    const entrySolUsd = amountX === 0 && amountSol > 0 && Number(tracked.initial_value_usd) > 0
      ? Number(tracked.initial_value_usd) / amountSol
      : null;
    const solUsd = Number(solPriceUsd) > 0 ? Number(solPriceUsd) : entrySolUsd;
    if (solUsd > 0) fromUsd = unpricedUsd / solUsd;
  }
  return claimedSolRecorded + fromUsd;
}

/**
 * SOL and USD value of a position's unclaimed fees (UI amounts from the SDK
 * positionData feeX/feeY), for recording a claim. Null when the pool has no
 * SOL side or the inputs are unusable. usd is null without a SOL price.
 */
export function feesValue({ pool, positionData, activePrice, solPriceUsd = null }) {
  if (!pool || !positionData) return null;
  const decX = Number(pool.tokenX?.mint?.decimals ?? pool.tokenX?.decimal);
  const decY = Number(pool.tokenY?.mint?.decimals ?? pool.tokenY?.decimal);
  if (!Number.isInteger(decX) || !Number.isInteger(decY)) return null;
  const mintX = pool.tokenX?.publicKey?.toString?.() ?? null;
  const mintY = pool.tokenY?.publicKey?.toString?.() ?? null;
  const solIsX = mintX === SOL_MINT && mintY !== SOL_MINT;
  if (!solIsX && mintY !== SOL_MINT) return null;
  const px = Number(activePrice);
  if (!Number.isFinite(px) || px <= 0) return null;
  const fx = num(positionData.feeX) / 10 ** decX;
  const fy = num(positionData.feeY) / 10 ** decY;
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
  const sol = solIsX ? fx + fy / px : fy + fx * px;
  const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
  const solUsd = Number(solPriceUsd);
  return { sol: round(sol, 9), usd: solUsd > 0 ? round(sol * solUsd, 2) : null, x: fx, y: fy };
}

/**
 * The on-chain PnL % in the unit the thresholds use (config.management.pnlUnit):
 * "sol" (default) → pnlPct, "usd" → pnlPctUsd (null when no SOL price was known).
 */
export function onchainPctForUnit(onchain, unit = "sol") {
  if (!onchain) return null;
  const v = unit === "usd" ? onchain.pnlPctUsd : onchain.pnlPct;
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
}

async function readOnchainPnl(address, poolAddress, solPriceUsd) {
  const tracked = await loadTracked(address);
  if (!tracked) return null;
  const pool = await loadPool(poolAddress || tracked.pool);
  const PublicKey = await loadPublicKey();
  const [pos, active] = await Promise.all([
    pool.getPosition(new PublicKey(address)),
    pool.getActiveBin(),
  ]);
  const pd = pos?.positionData;
  if (!pd) return null;
  const activePrice = active?.pricePerToken != null
    ? Number(active.pricePerToken)
    : binPrice(active?.binId, pool.lbPair?.binStep, pool.tokenX?.mint?.decimals, pool.tokenY?.mint?.decimals);
  const res = computeOnchainPnl({ pool, positionData: pd, activePrice, tracked, solPriceUsd });
  return res ? { ...res, activeBin: active?.binId ?? null, at: new Date(nowMs()).toISOString() } : null;
}

/**
 * On-chain SOL PnL for an open position: `position` is a getMyPositions()
 * entry ({ position, pool }) or a bare address (pool from state.json).
 * Returns { pnlPct, valueSol, depositSol, feesSol, pnlSol, … } or null.
 * Cached ~20s per position; concurrent callers share one read.
 */
export async function getOnchainPnl(position, { force = false } = {}) {
  const address = typeof position === "string" ? position : position?.position;
  const poolAddress = typeof position === "string" ? null : position?.pool ?? null;
  const solPriceUsd = typeof position === "string" ? null : position?.sol_price ?? null;
  if (!address) return null;
  try {
    const hit = cache.get(address);
    if (!force && hit && nowMs() - hit.at < ONCHAIN_PNL_CACHE_MS) return hit.data;
    if (inflight.has(address)) return await inflight.get(address);
    const p = readOnchainPnl(address, poolAddress, solPriceUsd)
      .then((data) => {
        if (data) cache.set(address, { at: nowMs(), data });
        else cache.delete(address);
        if (cache.size > 100) for (const [k, v] of cache) if (nowMs() - v.at >= ONCHAIN_PNL_CACHE_MS) cache.delete(k);
        return data;
      })
      .catch((e) => {
        log("onchain_pnl", `Read failed for ${address.slice(0, 8)}: ${e.message}`);
        return null;
      })
      .finally(() => inflight.delete(address));
    inflight.set(address, p);
    return await p;
  } catch (e) {
    log("onchain_pnl", `Read failed for ${String(address).slice(0, 8)}: ${e.message}`);
    return null;
  }
}
