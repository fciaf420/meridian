// hybrid-mix.js — the "hybrid" liquidity shape: ONE position, single-sided SOL,
// holding a Bid-Ask layer AND a Spot layer over the same bin range.
//
// Pure helpers (no I/O) so config, the deploy path, tracking and tests share one
// definition of the mix. The Spot share is always DERIVED (100 - Bid-Ask share):
// there is no second number to get out of sync, and the two lamport legs are
// split so they sum EXACTLY to the deposit.

import BN from "bn.js";

export const HYBRID = "hybrid";
export const DEFAULT_HYBRID_BID_ASK_PCT = 60;

/** Shapes that deposit single-sided SOL below the active bin (price drop fills them). */
export const isSolBidShape = (strategy) => strategy === "bid_ask" || strategy === HYBRID;

/** Human label for a recorded strategy. */
export function strategyLabel(strategy) {
  if (strategy === HYBRID) return "Hybrid (Bid-Ask + Spot)";
  if (strategy === "bid_ask") return "Bid-Ask";
  if (strategy === "spot") return "Spot";
  return strategy ? String(strategy) : "unknown";
}

/**
 * Validate the configured Bid-Ask share and derive the Spot share.
 * Bid-Ask must be > 0 and <= 100 (100 = no Spot layer). Throws on anything else
 * so a bad setting refuses the deploy before any transaction is built.
 * @returns {{ bidAskPct: number, spotPct: number }}
 */
export function normalizeHybridMix(bidAskPct = DEFAULT_HYBRID_BID_ASK_PCT) {
  const n = Number(bidAskPct);
  if (bidAskPct == null || bidAskPct === "" || !Number.isFinite(n)) {
    throw new Error(`hybridBidAskPct must be a number between 1 and 100 (got ${JSON.stringify(bidAskPct)})`);
  }
  if (n <= 0 || n > 100) throw new Error(`hybridBidAskPct must be > 0 and <= 100 (got ${n})`);
  const bid = Math.round(n * 100) / 100;
  return { bidAskPct: bid, spotPct: Math.round((100 - bid) * 100) / 100 };
}

/**
 * Split a raw deposit (BN) into the Bid-Ask and Spot legs. Bid-Ask gets
 * floor(total * bidAskPct); Spot gets the remainder, so bidAsk + spot === total.
 * Percentages are handled in basis points (0.01% resolution).
 * @returns {{ bidAsk: BN, spot: BN, mix: {bidAskPct:number, spotPct:number} }}
 */
export function splitHybridLamports(total, bidAskPct) {
  const mix = normalizeHybridMix(bidAskPct);
  const t = BN.isBN(total) ? total : new BN(String(total));
  if (t.isNeg()) throw new Error("hybrid deposit cannot be negative");
  const bps = new BN(Math.round(mix.bidAskPct * 100));
  const bidAsk = t.mul(bps).divn(10_000);
  const spot = t.sub(bidAsk);
  return { bidAsk, spot, mix };
}

/** The `strategy_mix` / leg-amount fields stored on a tracked hybrid position. */
export function hybridTrackFields(mix, legs = {}) {
  return {
    strategy_mix: { bid_ask_pct: mix.bidAskPct, spot_pct: mix.spotPct },
    ...(legs && Object.keys(legs).length ? { legs } : {}),
  };
}

// ── Instruction merging (one atomic transaction for both legs) ──────────────
// The SDK builds each deposit as a self-contained transaction (compute-budget
// ix, ATA creates, SOL wrap, [bin-array inits], the DLMM deposit ix, SOL
// unwrap). To put BOTH legs in one transaction we keep leg A whole, minus its
// trailing unwrap, and append from leg B ONLY what is new: its SOL wrap and its
// DLMM deposit instruction(s). Leg B's compute-budget, ATA-create, bin-array /
// bitmap init and unwrap instructions are dropped (A already carries them).
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const CLOSE_ACCOUNT = 9;
const SYNC_NATIVE = 17;

const isUnwrap = (ix) => TOKEN_PROGRAMS.has(ix.programId.toBase58()) && ix.data?.length >= 1 && ix.data[0] === CLOSE_ACCOUNT;
const isWrapPart = (ix) =>
  ix.programId.toBase58() === SYSTEM_PROGRAM ||
  (TOKEN_PROGRAMS.has(ix.programId.toBase58()) && ix.data?.length >= 1 && ix.data[0] === SYNC_NATIVE);

/**
 * @param {import("@solana/web3.js").TransactionInstruction[]} a leg A instructions (CU ix already stripped or not)
 * @param {import("@solana/web3.js").TransactionInstruction[]} b leg B instructions
 * @param {string} dlmmProgramId  DLMM program id (base58)
 * @param {Set<string>} [initDiscriminators] hex discriminators of bin-array / bitmap init ixs to drop from B
 * @returns {TransactionInstruction[]} merged instructions, WITHOUT any compute-budget ix
 */
export function mergeLegInstructions(a, b, dlmmProgramId, initDiscriminators = new Set()) {
  const aCore = a.filter((ix) => ix.programId.toBase58() !== COMPUTE_BUDGET);
  const tail = aCore.length && isUnwrap(aCore[aCore.length - 1]) ? [aCore.pop()] : [];
  const bKept = [];
  for (const ix of b) {
    const pid = ix.programId.toBase58();
    if (pid === COMPUTE_BUDGET || pid === ATA_PROGRAM || isUnwrap(ix)) continue;
    if (pid === dlmmProgramId) {
      if (initDiscriminators.has(Buffer.from(ix.data.subarray(0, 8)).toString("hex"))) continue;
      bKept.push(ix);
    } else if (isWrapPart(ix)) bKept.push(ix);
    else throw new Error(`mergeLegInstructions: unexpected instruction from program ${pid} in leg B`);
  }
  if (!bKept.some((ix) => ix.programId.toBase58() === dlmmProgramId)) throw new Error("mergeLegInstructions: leg B has no DLMM deposit instruction");
  return [...aCore, ...bKept, ...tail];
}
