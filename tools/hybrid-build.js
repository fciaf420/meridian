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
// the caller falls back to the chunked path (see buildHybridChunkTxs).

import { Transaction } from "@solana/web3.js";
import { mergeLegInstructions } from "../hybrid-mix.js";
import { legacyTxSize, MAX_TX_BYTES } from "./tx-send.js";

// compute-budget limit + price ixs (≈ 2×~20 B), a possible Sender tip (~70 B)
// and slack are added later by applyPriorityFee; leave room for them.
export const HYBRID_SIZE_HEADROOM = 110;

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
 * One atomic tx: initialize_position + Bid-Ask deposit + Spot deposit.
 * @returns {Promise<{ tx: Transaction|null, size: number, reason?: string, txA: Transaction, txB: Transaction }>}
 *   tx is null (with a reason) when the merged tx would not fit.
 */
export async function buildHybridStandardTx({ pool, StrategyType, BN, positionPubKey, user, minBinId, maxBinId, legs, slippage }) {
  const txA = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey, user, totalXAmount: zero(BN), totalYAmount: legs.bidAsk,
    strategy: { minBinId, maxBinId, strategyType: StrategyType.BidAsk }, slippage,
  });
  const txB = await pool.addLiquidityByStrategy({
    positionPubKey, user, totalXAmount: zero(BN), totalYAmount: legs.spot,
    strategy: { minBinId, maxBinId, strategyType: StrategyType.Spot }, slippage,
  });
  const merged = mergeLegInstructions(txA.instructions, txB.instructions, pool.program.programId.toBase58(), initDiscriminators(pool));
  const tx = new Transaction({ blockhash: txA.recentBlockhash, lastValidBlockHeight: txA.lastValidBlockHeight, feePayer: user }).add(...merged);
  const size = legacyTxSize(tx);
  if (size + HYBRID_SIZE_HEADROOM > MAX_TX_BYTES) {
    return { tx: null, size, reason: `merged hybrid tx is ${size} bytes (+${HYBRID_SIZE_HEADROOM} headroom > ${MAX_TX_BYTES})`, txA, txB };
  }
  return { tx, size, txA, txB };
}

/**
 * Per-chunk hybrid txs for the chunked path (wide ranges). For each bin chunk the
 * SDK's Bid-Ask chunk tx and Spot chunk tx are merged into ONE tx, so a chunk is
 * all-or-nothing and the existing per-chunk reconcile (bins funded on-chain)
 * keeps working unchanged. Position must already exist when these are SENT; it
 * need not exist to build them.
 * @returns {Promise<Transaction[]>}
 * @throws if the two legs chunk differently or a merged chunk would not fit.
 */
export async function buildHybridChunkTxs({ pool, StrategyType, BN, positionPubKey, user, minBinId, maxBinId, legs, slippage }) {
  const build = async (amount, strategyType) => {
    const r = await pool.addLiquidityByStrategyChunkable({
      positionPubKey, user, totalXAmount: zero(BN), totalYAmount: amount,
      strategy: { minBinId, maxBinId, strategyType }, slippage,
    });
    return Array.isArray(r) ? r : [r];
  };
  const a = await build(legs.bidAsk, StrategyType.BidAsk);
  if (legs.spot.isZero()) return a;
  const b = await build(legs.spot, StrategyType.Spot);
  if (a.length !== b.length) throw new Error(`hybrid chunking mismatch: Bid-Ask leg has ${a.length} chunk txs, Spot leg ${b.length}`);
  const pid = pool.program.programId.toBase58();
  const discs = initDiscriminators(pool);
  return a.map((txA, i) => {
    const tx = new Transaction({ blockhash: txA.recentBlockhash, lastValidBlockHeight: txA.lastValidBlockHeight, feePayer: user })
      .add(...mergeLegInstructions(txA.instructions, b[i].instructions, pid, discs));
    const size = legacyTxSize(tx);
    if (size + HYBRID_SIZE_HEADROOM > MAX_TX_BYTES) throw new Error(`merged hybrid chunk ${i + 1}/${a.length} is ${size} bytes — too large to carry both legs`);
    return tx;
  });
}
