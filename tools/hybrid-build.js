// tools/hybrid-build.js — builds the transactions for a "hybrid" deploy:
// ONE position, single-sided SOL, a Bid-Ask layer + a Spot layer over the SAME
// bin range. Builders only (nothing is signed or sent here); tools/dlmm.js owns
// the checkpoint / price gate / priority fee / send path and calls these.
//
// WHY INSTRUCTION-MERGING (design choice "(a')"): in @meteora-ag/dlmm 1.9.14
//   - initializePositionAndAddLiquidityByStrategy and addLiquidityByStrategy
//     do NOT read the position account at build time (they only need its
//     pubkey), so BOTH can be built before the position exists;
//   - the program lets a second add_liquidity_by_strategy2 run in the same
//     transaction right after initialize_position.
// So the two legs ride in ONE atomic transaction: no partial-leg state, one
// fee, one confirmation. A separate rebalance_liquidity with two `adds`
// (option c) cannot create the position, so it would still need a second tx.
// If the merged tx would not fit in 1232 bytes (e.g. Token-2022 hook accounts)
// the caller falls back to the chunked path. There the two layers are NOT merged:
// measured on mainnet, one merged chunk tx needs ~1.37M CU (the SDK's chunk path
// uses rebalance_liquidity, ~680k CU per layer per 70 bins) and ~1.15 KB, too
// close to the 1.4M CU / 1232 B ceilings, so tools/dlmm.js sends the Bid-Ask
// layer's chunk txs, reconciles them on-chain, then the Spot layer's.

import { Transaction } from "@solana/web3.js";
import { mergeLegInstructions } from "../hybrid-mix.js";
import { legacyTxSize, MAX_TX_BYTES } from "./tx-send.js";

// applyPriorityFee later adds the compute-budget program key + limit ix + price ix
// (32 + 8 + 12 = 52 B). A Sender tip (~70 B) is NOT reserved: when it would not fit
// applyPriorityFee drops it and sends via RPC only (logged), so a tx that fits
// without the tip is good enough. 60 B = those 52 + slack.
export const HYBRID_SIZE_HEADROOM = 60;

/** hex discriminators of the bin-array / bitmap initialisers (dropped from leg B). */
export function initDiscriminators(pool) {
  const out = new Set();
  for (const ix of pool.program?.idl?.instructions ?? []) {
    if (ix.name === "initializeBinArray" || ix.name === "initializeBinArrayBitmapExtension") {
      if (Array.isArray(ix.discriminator)) out.add(Buffer.from(ix.discriminator).toString("hex"));
    }
  }
  return out;
}

const zero = (BN) => new BN(0);

/**
 * The SDK sizes every tx it builds by simulating it. For leg B (the Spot add) the position
 * does not exist yet, so that internal simulation fails and the SDK logs
 * "Error::getEstimatedComputeUnitUsageWithBuffer" before falling back to a 1.4M CU limit.
 * That limit is discarded here anyway (applyPriorityFee re-measures the MERGED tx), so the
 * log line is noise; swallow exactly that line and nothing else.
 */
export async function quietSdkEstimator(fn) {
  const orig = console.error;
  console.error = (...a) => { if (typeof a[0] === "string" && a[0].startsWith("Error::getEstimatedComputeUnitUsageWithBuffer")) return; orig.apply(console, a); };
  try { return await fn(); } finally { console.error = orig; }
}

/**
 * One atomic tx: initialize_position + Bid-Ask deposit + Spot deposit.
 * @returns {Promise<{ tx: Transaction|null, size: number, reason?: string, txA: Transaction, txB: Transaction }>}
 *   tx is null (with a reason) when the merged tx would not fit.
 */
export async function buildHybridStandardTx({ pool, StrategyType, BN, positionPubKey, user, minBinId, maxBinId, legs, slippage }) {
  const txA = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey, user, totalXAmount: zero(BN), totalYAmount: legs.bidAsk,
    strategy: { minBinId, maxBinId, strategyType: StrategyType.BidAsk }, slippage,
  });
  const txB = await quietSdkEstimator(() => pool.addLiquidityByStrategy({
    positionPubKey, user, totalXAmount: zero(BN), totalYAmount: legs.spot,
    strategy: { minBinId, maxBinId, strategyType: StrategyType.Spot }, slippage,
  }));
  const merged = mergeLegInstructions(txA.instructions, txB.instructions, pool.program.programId.toBase58(), initDiscriminators(pool));
  const tx = new Transaction({ blockhash: txA.recentBlockhash, lastValidBlockHeight: txA.lastValidBlockHeight, feePayer: user }).add(...merged);
  const size = legacyTxSize(tx);
  if (size + HYBRID_SIZE_HEADROOM > MAX_TX_BYTES) {
    return { tx: null, size, reason: `merged hybrid tx is ${size} bytes (+${HYBRID_SIZE_HEADROOM} headroom > ${MAX_TX_BYTES})`, txA, txB };
  }
  return { tx, size, txA, txB };
}
