/**
 * Bid-Ask flip.
 *
 * The bot deploys single-sided SOL Bid-Ask liquidity below the active bin
 * (bins_above = 0), so the band top U is the active bin at deploy. As price
 * dumps into the band, every bin in (active, U] has been swapped into token X.
 * A flip withdraws that token from (active, hi] and redeposits it, in ONE
 * atomic `rebalance_liquidity` instruction, as an on-chain Bid-Ask *ask* over
 * [active+1, U]: top-weighted, token only, still inside the original position
 * range. SOL bins at/below active are never touched.
 *
 * Fixed by design (not configurable):
 *  - ask range [active+1, U] with U = the original band top (never above U:
 *    no resize, no new bin-array rent; below U would break the "never sells
 *    lower than hold" property)
 *  - shape = on-chain BidAsk (linear in value, heaviest at the top)
 *  - maxActiveBinSlippage = 0 (a moved active bin aborts; retry next tick)
 *  - no fee/reward claim inside the flip (claims stay in claimFees())
 *  - refuse any flip that needs a bin-array init or positive rent
 *
 * Modes (config.bidAskFlip.mode):
 *  - "off":    nothing runs
 *  - "shadow": compute the plan, build + simulateTransaction it, log; never signs
 *  - "live":   same, then send via the managed sender and verify on-chain
 *
 * Known, intentional deviations from the design doc (both conservative):
 *  - L4: no full re-arm when price trades back above the previous flip point, and
 *    an OOR-down active bin (active < lower) holds rather than flipping [L..U].
 *  - L5: management rule 5 (yield dead) is evaluated after the flip hook in the same
 *    cycle, so a flip can immediately precede a close. It is net-zero value and
 *    costs only the tx fee; moving the hook after rule evaluation would mean
 *    restructuring the management pass for no safety gain.
 *
 * Pure helpers (planBidAskFlip, computeFill, buildFlipParams, ...) take plain
 * data so they are unit-testable without RPC.
 */

import BN from "bn.js";
import { log as defaultLog } from "../logger.js";
import { withWalletLock } from "../wallet-lock.js";
import { isDryRun } from "../env-flags.js";

export const FLIP_MODES = ["off", "shadow", "live"];
export const FLIP_DEFAULTS = Object.freeze({ mode: "shadow", fillPct: 30, reflipStepPct: 20, minTrancheSol: 0.05, timeoutSec: 30 });
// The ask must span at least this many bins above active, otherwise there is
// nowhere meaningfully higher to move the token to.
export const MIN_ASK_BINS = 3;
// Raw-unit haircut per withdrawn bin on the redeposited amount. The program's
// per-bin withdraw rounding can differ from the SDK's estimate by a unit; the
// haircut keeps the instruction a net *withdraw* of X (dust back to the
// wallet) so maxDepositX can be 0 and the flip can never pull wallet tokens.
export const HAIRCUT_RAW_PER_BIN = 200;
// Slippage % passed to rebalancePosition: minWithdraw = net*(1-1%), maxDeposit = 0*(1+1%) = 0.
export const FLIP_SLIPPAGE_PCT = 1;
// Compute budget. Mainnet simulation measured ~9.5-10k CU per bin that is both
// withdrawn and redeposited (42 bins 362k, 53 bins 486k, 82 bins 814k), and a
// 202-bin flip hit the 1.4M CU ceiling (ProgramFailedToComplete). One tx may
// therefore touch at most this many (withdraw bins + deposit bins).
export const MAX_BIN_OPS_PER_TX = 200;
// M3: a flip must be worth at least this many times its estimated tx cost.
export const COST_FLOOR_MULT = 25;
// Per tx: 5,000 base fee + 5,000 Sender tip (lamports); priority fee is capped by
// management.maxPriorityFeeLamports (default 1,000,000, tools/tx-send.js).
export const TX_BASE_PLUS_TIP_LAMPORTS = 10_000;
export const DEFAULT_MAX_PRIORITY_FEE_LAMPORTS = 1_000_000;
// Rent for a missing token-X ATA created by the SDK's pre-instruction
// (165-byte classic account = 2,039,280; Token-2022 accounts are a little
// larger, so use a conservative round figure).
export const ATA_RENT_LAMPORTS = 2_100_000;
const DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
// M2: max tolerated gap (percentage points) between on-chain and API PnL on a flipped position.
export const FLIP_PNL_DIVERGENCE_PP = 2;
const COOLDOWN_MS = 2 * 60_000;
const WSOL = "So11111111111111111111111111111111111111112";

const big = (v) => {
  try { return BigInt(String(v ?? "0").split(".")[0] || "0"); } catch { return 0n; }
};

/** Normalise a flip config block (unknown/invalid values fall back to defaults). */
export function normalizeFlipConfig(c = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);
  return {
    mode: FLIP_MODES.includes(c?.mode) ? c.mode : FLIP_DEFAULTS.mode,
    fillPct: num(c?.fillPct, FLIP_DEFAULTS.fillPct),
    reflipStepPct: num(c?.reflipStepPct, FLIP_DEFAULTS.reflipStepPct),
    minTrancheSol: num(c?.minTrancheSol, FLIP_DEFAULTS.minTrancheSol),
    // M1: overall deadline for one flip pass (and for each locked live flip).
    timeoutSec: Math.max(1, num(c?.timeoutSec, FLIP_DEFAULTS.timeoutSec)),
  };
}

/**
 * Normalise SDK positionBinData into [{ binId, xRaw, yRaw, price }] where
 * price is SOL per whole token (pricePerToken, UI units).
 */
export function normalizeBins(positionBinData = []) {
  return positionBinData.map((b) => ({
    binId: Number(b.binId),
    xRaw: big(b.positionXAmount ?? b.xRaw),
    yRaw: big(b.positionYAmount ?? b.yRaw),
    price: Number(b.pricePerToken ?? b.price),
  }));
}

/**
 * Fill math from the position's own bins.
 *  convertedSol = Σ x_k·P_k over bins k ≥ active (token held is SOL that converted)
 *  depositedSol = tracked amount_sol when known, else Σ (y_k + x_k·P_k) (exact
 *                 for a single-sided SOL deposit, ignoring fees)
 */
export function computeFill({ bins, activeId, decimalsX, decimalsY = 9, depositedSol = null }) {
  const dx = 10 ** decimalsX;
  const dy = 10 ** decimalsY;
  let convertedSol = 0;
  let solLeft = 0;
  for (const b of bins) {
    const xUi = Number(b.xRaw) / dx;
    if (b.binId >= activeId) convertedSol += xUi * b.price;
    solLeft += Number(b.yRaw) / dy;
  }
  const estDeposit = solLeft + convertedSol;
  const dep = Number(depositedSol) > 0 ? Number(depositedSol) : estDeposit;
  return {
    convertedSol,
    solLeft,
    depositedSol: dep,
    depositedSource: Number(depositedSol) > 0 ? "tracked" : "estimated",
    fillPct: dep > 0 ? (convertedSol / dep) * 100 : 0,
  };
}

/**
 * Estimated cost (lamports) of sending `chunks` flip txs: base fee + tip +
 * worst-case priority fee each, plus ATA rent when an ATA will be created.
 */
export function estimateFlipCostLamports({ chunks = 1, maxPriorityFeeLamports = DEFAULT_MAX_PRIORITY_FEE_LAMPORTS, ataCreates = 0 } = {}) {
  const prio = Number.isFinite(Number(maxPriorityFeeLamports)) ? Number(maxPriorityFeeLamports) : DEFAULT_MAX_PRIORITY_FEE_LAMPORTS;
  return chunks * (TX_BASE_PLUS_TIP_LAMPORTS + prio) + ataCreates * ATA_RENT_LAMPORTS;
}

/**
 * H1: strict eligibility. Only positions THIS bot deployed as a single-sided
 * SOL Bid-Ask (or hybrid Bid-Ask + Spot) are flip candidates. Auto-adopted positions (which include the
 * user's manual positions in the same wallet) get strategy "bid_ask" by default
 * and bins_above null, so they must be excluded explicitly. Returns a blocker
 * string, or null when eligible.
 */
export function flipEligibilityBlocker(tracked) {
  if (!tracked) return "not tracked";
  if (tracked.strategy !== "bid_ask" && tracked.strategy !== "hybrid") return `strategy ${tracked.strategy}`;
  // A bot-recorded strategy_type is required, and it must match the strategy: "BidAsk" for
  // bid_ask, "Hybrid" for hybrid (one position, Bid-Ask + Spot layers, both single-sided SOL).
  const wantType = tracked.strategy === "hybrid" ? "Hybrid" : "BidAsk";
  if (tracked.strategy_type !== wantType) return `strategy_type ${tracked.strategy_type ?? "unset"} (not a bot ${wantType} deploy)`;
  if (tracked.adopted === true) return "auto-adopted position (not deployed by the bot)";
  if (Number(tracked.bin_range?.bins_above) !== 0 || tracked.bin_range?.bins_above == null) return "bins_above is not an explicit 0";
  if (!Number.isFinite(Number(tracked.bin_range?.max))) return "band top unknown";
  if (Number(tracked.amount_x) > 0) return "deployed with token X (not single-sided SOL)";
  return null;
}

/**
 * Should this tick's exit rules close the position? A flip never runs on a tick
 * where any close rule fires: the close path wins.
 */
export function exitRuleFiresForFlip(p, tracked, mgmt = {}, { exitAlert = false } = {}) {
  if (exitAlert) return "exit alert (trailing TP / stop loss / strategy exit)";
  if (tracked?.instruction) return "rule 1: instruction";
  // M1: with PnL unknown TP / SL / emergency cannot be evaluated; management
  // treats "pnl unknown" as needing the LLM, so a flip must not proceed either.
  if (p?.pnl_pct == null) return "pnl unknown — cannot evaluate exit rules";
  if (mgmt.takeProfitFeePct != null && p.pnl_pct >= mgmt.takeProfitFeePct) return "rule 3: take profit";
  if (mgmt.stopLossPct != null && p.pnl_pct <= mgmt.stopLossPct) return "stop loss";
  if (mgmt.emergencyPriceDropPct != null && p.pnl_pct <= mgmt.emergencyPriceDropPct) return "rule 6: emergency";
  if (mgmt.outOfRangeWaitMinutes != null && (p.minutes_out_of_range ?? 0) >= mgmt.outOfRangeWaitMinutes) return "rule 4: OOR timeout";
  return null;
}

/**
 * Pure flip planner.
 *
 * input: {
 *   bins (normalized), activeId, lowerBinId, upperBinId (position bounds),
 *   bandTop (U; tracked bin_range.max, clamped to upperBinId),
 *   strategy, binsAbove (tracked bin_range.bins_above), quoteIsSol,
 *   decimalsX, depositedSol, flipState: { flips, last_flip_active_bin, last_flip_at },
 *   cfg, exitReason (string|null), tokenBlocker (string|null), now
 * }
 * returns { action: "flip"|"hold", reason, ...details }
 */
export function planBidAskFlip(input) {
  const cfg = normalizeFlipConfig(input.cfg);
  const { bins = [], activeId, lowerBinId, upperBinId } = input;
  const st = input.flipState || {};
  const flips = Number(st.flips || 0);
  const hold = (reason, extra = {}) => ({ action: "hold", reason, activeId, flips, ...extra });

  if (cfg.mode === "off") return hold("mode off");
  if (input.exitReason) return hold(`exit rule fires this tick (${input.exitReason}) — close path wins`);
  // hybrid (Bid-Ask + Spot layers) is flip-eligible: the planner reads ACTUAL per-bin token amounts
  // and moves token only upward, so nothing here depends on the Bid-Ask SOL distribution.
  if (input.strategy && input.strategy !== "bid_ask" && input.strategy !== "hybrid") return hold(`not a bid_ask/hybrid position (${input.strategy})`);
  // H1: strict — null/undefined bins_above (adopted positions) is NOT single-sided.
  if (input.binsAbove !== 0) return hold(`not single-sided (bins_above ${input.binsAbove ?? "unknown"})`);
  if (input.quoteIsSol === false) return hold("quote token is not SOL");
  if (input.tokenBlocker) return hold(`token blocked: ${input.tokenBlocker}`);
  if (![activeId, lowerBinId, upperBinId].every(Number.isFinite)) return hold("missing bin ids");

  const U = Math.min(Number.isFinite(input.bandTop) ? input.bandTop : upperBinId, upperBinId);
  if (activeId >= U) return hold("active at/above band top — nothing to flip", { bandTop: U });
  if (activeId < lowerBinId) return hold("active below band bottom — fully filled / OOR-down (rule 4 owns it)", { bandTop: U });
  // Any SOL sitting above active would mean this is not a single-sided bid layout.
  if (bins.some((b) => b.binId > activeId && b.yRaw > 0n)) return hold("SOL found above active — not a single-sided bid layout");

  const fill = computeFill({ bins, activeId, decimalsX: input.decimalsX, decimalsY: input.decimalsY ?? 9, depositedSol: input.depositedSol });
  const now = input.now ?? Date.now();
  if (st.last_flip_at && now - Date.parse(st.last_flip_at) < COOLDOWN_MS) return hold("cooldown after last flip", { fill });

  // Fresh tranche = token bins strictly above active up to the previous flip's
  // active bin (or U on the first flip). Bins above the previous flip's active
  // already hold the earlier ask; re-flipping them could move token DOWN.
  const hi = Math.min(U, flips > 0 && Number.isFinite(st.last_flip_active_bin) ? st.last_flip_active_bin : U);
  const lo = activeId + 1;
  const dx = 10 ** input.decimalsX;
  const tranche = bins.filter((b) => b.binId >= lo && b.binId <= hi && b.xRaw > 0n);
  const trancheX = tranche.reduce((s, b) => s + b.xRaw, 0n);
  const trancheSol = tranche.reduce((s, b) => s + (Number(b.xRaw) / dx) * b.price, 0);
  const tranchePct = fill.depositedSol > 0 ? (trancheSol / fill.depositedSol) * 100 : 0;
  const details = { fill, bandTop: U, lo, hi, trancheBins: tranche.length, trancheX, trancheSol, tranchePct };

  if (hi < lo) return hold("price above previous flip point — no fresh tranche", details);
  if (flips === 0 && fill.fillPct < cfg.fillPct) return hold(`fill ${fill.fillPct.toFixed(1)}% < ${cfg.fillPct}%`, details);
  if (flips > 0 && tranchePct < cfg.reflipStepPct) return hold(`fresh tranche ${tranchePct.toFixed(1)}% < re-flip step ${cfg.reflipStepPct}%`, details);
  const maxDelta = U - activeId;
  if (maxDelta < MIN_ASK_BINS) return hold(`ask would span ${maxDelta} bins (< ${MIN_ASK_BINS})`, details);

  const chunks = planFlipChunks({ bins, activeId, lo, hi, U, maxOps: input.maxBinOpsPerTx ?? MAX_BIN_OPS_PER_TX });
  if (!chunks.length) return hold("tranche too small after rounding haircut", details);
  // M3: tranche floor = max(configured min, COST_FLOOR_MULT × estimated tx cost for this chunk count).
  const costMult = Number.isFinite(input.costFloorMult) ? input.costFloorMult : COST_FLOOR_MULT;
  const estCostLamports = estimateFlipCostLamports({ chunks: chunks.length, maxPriorityFeeLamports: input.maxPriorityFeeLamports });
  const costFloorSol = (costMult * estCostLamports) / 1e9;
  const minTranche = Math.max(cfg.minTrancheSol, costFloorSol);
  details.estCostLamports = estCostLamports;
  details.minTrancheSol = minTranche;
  if (trancheSol < minTranche) {
    return hold(`tranche ${trancheSol.toFixed(4)} SOL < min ${minTranche.toFixed(4)} (config ${cfg.minTrancheSol}, ${costMult}× est. cost of ${chunks.length} tx = ${costFloorSol.toFixed(4)})`, details);
  }
  const depositX = chunks.reduce((s, c) => s + c.depositX, 0n);

  return {
    action: "flip",
    reason: flips === 0 ? `fill ${fill.fillPct.toFixed(1)}% ≥ ${cfg.fillPct}%` : `re-flip: fresh tranche ${tranchePct.toFixed(1)}% ≥ ${cfg.reflipStepPct}%`,
    activeId,
    flips,
    ...details,
    layout: chunks.length === 1 && chunks[0].deposit.maxBinId === U ? "global" : "chunked",
    chunks,
    // Convenience aliases for the single-tx (global) case.
    withdraw: chunks[0].withdraw,
    deposit: chunks.length === 1 ? chunks[0].deposit : { minDeltaId: 1, maxDeltaId: hi - activeId, minBinId: lo, maxBinId: hi },
    depositX,
  };
}

/**
 * Split a flip into transactions that each fit the compute budget.
 *
 * global  (withdraw bins + ask bins ≤ maxOps): ONE tx, withdraw (a, hi] and
 *         redeposit the whole tranche as one BidAsk ask over [a+1, U].
 * chunked (wider): k independent txs over contiguous sub-ranges [s, e] of
 *         (a, hi]; each withdraws its own bins and redeposits the same X as a
 *         BidAsk ask over the SAME [s, e]. Every chunk is atomic and net-zero
 *         (no token in the wallet between txs, any subset of chunks landing is a
 *         valid state) and moves token only upward inside its chunk, so the
 *         result still first-order dominates holding.
 */
export function planFlipChunks({ bins, activeId, lo, hi, U, maxOps = MAX_BIN_OPS_PER_TX }) {
  const xOf = new Map(bins.map((b) => [b.binId, b.xRaw]));
  const sumX = (s, e) => { let t = 0n; let n = 0; for (let b = s; b <= e; b++) { const x = xOf.get(b) || 0n; if (x > 0n) { t += x; n++; } } return { x: t, n }; };
  const mk = (s, e, depMax) => {
    const { x, n } = sumX(s, e);
    const haircut = BigInt(HAIRCUT_RAW_PER_BIN * Math.max(1, n));
    if (x <= haircut) return null;
    return {
      withdraw: { minBinId: s, maxBinId: e },
      deposit: { minDeltaId: s - activeId, maxDeltaId: depMax - activeId, minBinId: s, maxBinId: depMax },
      trancheX: x,
      depositX: x - haircut,
      bins: n,
    };
  };
  const wBins = hi - lo + 1;
  const dBins = U - lo + 1;
  if (wBins + dBins <= maxOps) {
    const c = mk(lo, hi, U);
    return c ? [c] : [];
  }
  const per = Math.max(1, Math.floor(maxOps / 2));
  const k = Math.ceil(wBins / per);
  const size = Math.ceil(wBins / k);
  const out = [];
  for (let s = lo; s <= hi; s += size) {
    const e = Math.min(hi, s + size - 1);
    // A local ask over < MIN_ASK_BINS bins moves almost nothing: leave it as is.
    const c = e - s + 1 >= MIN_ASK_BINS ? mk(s, e, e) : null;
    if (c) out.push(c);
  }
  // Top chunk first: its ask reaches U, so the position's top edge holds
  // liquidity before any lower chunk runs. rebalance_liquidity always uses
  // ShrinkBoth, and an empty top edge would otherwise be shrunk away by a
  // lower chunk (seen on mainnet sim: 5 empty top bins → -2,844,800 lamports
  // refund + changed upper bin), after which the top chunk would need a resize.
  return out.reverse();
}

/**
 * Build the SDK rebalance params for a "flip" plan. `sdk` = the
 * @meteora-ag/dlmm module (buildLiquidityStrategyParameters,
 * getLiquidityStrategyParameterBuilder, StrategyType).
 */
export function buildFlipParams(chunk, { binStep, sdk, activeId }) {
  if (!(chunk.deposit.minDeltaId >= 1)) throw new Error("flip deposit must start strictly above the active bin");
  const minD = new BN(chunk.deposit.minDeltaId);
  const maxD = new BN(chunk.deposit.maxDeltaId);
  const p = sdk.buildLiquidityStrategyParameters(
    new BN(chunk.depositX.toString()), new BN(0), minD, maxD, new BN(binStep), false, new BN(activeId),
    sdk.getLiquidityStrategyParameterBuilder(sdk.StrategyType.BidAsk),
  );
  const deposits = [{ minDeltaId: minD, maxDeltaId: maxD, x0: p.x0, y0: p.y0, deltaX: p.deltaX, deltaY: p.deltaY, favorXInActiveBin: false }];
  // Always explicit bin ids: null means "active bin" in the SDK and the program.
  const withdraws = [{ minBinId: new BN(chunk.withdraw.minBinId), maxBinId: new BN(chunk.withdraw.maxBinId), bps: new BN(10_000) }];
  return { deposits, withdraws, strategyParams: p };
}

/** Token-2022 guard. Returns a blocker string or null. */
export async function token2022Blocker(tokenX) {
  try {
    const spl = await import("@solana/spl-token");
    if (!tokenX?.owner || !tokenX.owner.equals?.(spl.TOKEN_2022_PROGRAM_ID)) return null;
    const mint = tokenX.mint;
    if (!mint) return "token-2022 mint not parsed";
    const fee = spl.getTransferFeeConfig(mint);
    if (fee) {
      const bps = Math.max(Number(fee.olderTransferFee?.transferFeeBasisPoints ?? 0), Number(fee.newerTransferFee?.transferFeeBasisPoints ?? 0));
      if (bps > 0) return `token-2022 transfer fee (${bps} bps)`;
    }
    const hook = spl.getTransferHook(mint);
    if (hook && hook.programId && !hook.programId.equals(spl.TOKEN_2022_PROGRAM_ID) && hook.programId.toBase58() !== "11111111111111111111111111111111") {
      return "token-2022 transfer hook";
    }
    return null;
  } catch (e) {
    return `token-2022 check failed (${e.message})`;
  }
}

/**
 * L7: the SDK's getEstimatedComputeUnitUsageWithBuffer console.error's
 * "Transaction simulation failed" on every build before falling back. The CU ix
 * is stripped anyway, so drop just that line instead of spamming bot logs.
 */
let sdkNoiseDepth = 0;
let sdkNoiseOrig = null;
const SDK_SIM_NOISE_RE = /^Transaction simulation failed:/;
export async function quietSdkSimNoise(fn) {
  // N3: console.error is swapped only for the duration of this build (depth-counted
  // so overlapping builds restore correctly), and ONLY the SDK's exact message
  // (an Error/string beginning "Transaction simulation failed:") is dropped.
  // Everything else — including other tasks' logs in the window — passes through.
  if (sdkNoiseDepth++ === 0) {
    sdkNoiseOrig = console.error;
    const orig = sdkNoiseOrig;
    console.error = (...a) => {
      const first = a[0];
      const msg = typeof first === "string" ? first : (first instanceof Error ? first.message : "");
      if (SDK_SIM_NOISE_RE.test(msg)) return;
      orig.apply(console, a);
    };
  }
  try { return await fn(); } finally { if (--sdkNoiseDepth === 0) { console.error = sdkNoiseOrig; sdkNoiseOrig = null; } }
}

const isComputeBudgetIx = (ix) => ix?.programId?.toBase58?.() === "ComputeBudget111111111111111111111111111111";

/**
 * Build the atomic flip instructions for a "flip" plan.
 * Refuses (throws) when the active bin moved since planning, when rent would be
 * charged, or when any bin array / bitmap extension would need initializing.
 * Returns { ixs (no compute-budget ixs), cuIx, resp, rentalCostLamports, binArrayCount }.
 */
export async function buildAtomicFlipIxs({ pool, positionPk, positionData, plan, chunk = plan.chunks[0], rentPayer, sdk, allowBinArrayInit = false }) {
  const { deposits, withdraws } = buildFlipParams(chunk, { binStep: pool.lbPair.binStep, sdk, activeId: plan.activeId });
  const resp = await pool.simulateRebalancePosition(positionPk, positionData, false, false, deposits, withdraws);
  const simActive = Number(resp.rebalancePosition.lbPair.activeId);
  if (simActive !== plan.activeId) throw new Error(`active bin moved ${plan.activeId} → ${simActive} between plan and build`);
  const rent = resp.simulationResult.rentalCostLamports;
  // Exactly zero: positive = resize (rent), negative = ShrinkBoth dropping empty
  // edge bins. Either changes the position's range, which the bot's OOR logic
  // keys on, so the flip never resizes in either direction.
  if (rent && !rent.isZero()) throw new Error(`flip would resize the position (rent delta ${rent.toString()} lamports) — refusing`);
  if (!allowBinArrayInit && Number(resp.binArrayCount || 0) > 0) throw new Error(`flip would init ${resp.binArrayCount} bin array(s) — refusing`);
  if (resp.simulationResult.actualAmountYDeposited?.gtn?.(0) || resp.simulationResult.actualAmountXDeposited?.gtn?.(0)) {
    throw new Error("flip would pull tokens from the wallet (net deposit > 0) — refusing");
  }
  const out = await quietSdkSimNoise(() => pool.rebalancePosition(resp, new BN(0), rentPayer, FLIP_SLIPPAGE_PCT));
  if (!allowBinArrayInit && out.initBinArrayInstructions.length > 0) {
    throw new Error(`flip needs ${out.initBinArrayInstructions.length} bin-array init ix(s) — refusing`);
  }
  const all = out.rebalancePositionInstruction;
  // L3: exactly one DLMM-program instruction (the rebalance_liquidity itself).
  // A bitmap-extension init (or anything else DLMM) pushed into the pre-ixs
  // would otherwise slip past the bin-array guards above.
  const dlmmIxs = all.filter((ix) => ix?.programId?.toBase58?.() === DLMM_PROGRAM_ID);
  if (dlmmIxs.length !== 1) throw new Error(`flip build contains ${dlmmIxs.length} DLMM instructions (expected exactly 1) — refusing`);
  const ixs = all.filter((ix) => !isComputeBudgetIx(ix));
  return {
    // N2: ATA creates whose rent is NOT refunded in-tx. WSOL ATA creates are
    // closed by the SDK's post ix (rent refunded), so they are excluded. Each entry
    // is the ATA address (dedupe key); unknown layouts count conservatively.
    ataCreates: ixs.filter((ix) => ix?.programId?.toBase58?.() === ATA_PROGRAM_ID && ix.keys?.[3]?.pubkey?.toBase58?.() !== WSOL).length,
    ataKeys: ixs.filter((ix) => ix?.programId?.toBase58?.() === ATA_PROGRAM_ID && ix.keys?.[3]?.pubkey?.toBase58?.() !== WSOL)
      .map((ix) => ix.keys?.[1]?.pubkey?.toBase58?.() ?? "unknown"),
    ixs,
    cuIx: all.find(isComputeBudgetIx) || null,
    resp,
    rentalCostLamports: rent ? rent.toString() : "0",
    binArrayCount: Number(resp.binArrayCount || 0),
    sim: resp.simulationResult,
  };
}

/**
 * Two-transaction fallback (comparison only — the live path never uses it):
 * removeLiquidity over [lo, hi] without closing, then addLiquidityByStrategy
 * X-only BidAsk over [active+1, U]. Leaves token in the wallet between txs.
 */
export async function buildFallbackFlipTxs({ pool, positionPk, owner, plan, sdk, slippagePct = 1 }) {
  const removeTxs = await pool.removeLiquidity({
    user: owner, position: positionPk, fromBinId: plan.withdraw.minBinId, toBinId: plan.withdraw.maxBinId,
    bps: new BN(10_000), shouldClaimAndClose: false,
  });
  await pool.refetchStates();
  if (Number(pool.lbPair.activeId) !== plan.activeId) throw new Error("active bin moved during fallback build");
  const addTx = await pool.addLiquidityByStrategy({
    positionPubKey: positionPk, user: owner, totalXAmount: new BN(plan.depositX.toString()), totalYAmount: new BN(0),
    strategy: { minBinId: plan.deposit.minBinId, maxBinId: plan.deposit.maxBinId, strategyType: sdk.StrategyType.BidAsk },
    slippage: slippagePct,
  });
  return { removeTxs, addTx };
}

/**
 * simulateTransaction for a set of instructions (fee payer = owner, unsigned).
 * opts.accounts: { encoding: "base64", addresses: [...] } to read post-state.
 */
export async function simulateFlipIxs(conn, ixs, owner, { accounts = undefined, cuLimit = 1_400_000 } = {}) {
  const { TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = await import("@solana/web3.js");
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }), ...ixs],
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  return conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", ...(accounts && { accounts }) });
}

/** Compact one-line description of a plan for logs. */
export function formatFlipPlan(pair, position, plan, extra = "") {
  const f = plan.fill;
  const head = `${pair ?? "?"} ${String(position ?? "").slice(0, 8)}: active ${plan.activeId}`;
  const fill = f ? ` fill ${f.fillPct.toFixed(1)}% (${f.convertedSol.toFixed(4)}/${f.depositedSol.toFixed(4)} SOL ${f.depositedSource})` : "";
  if (plan.action !== "flip") return `${head}${fill} — HOLD: ${plan.reason}${extra}`;
  const legs = (plan.chunks || []).map((c) => `[${c.withdraw.minBinId}..${c.withdraw.maxBinId}]→ask[${c.deposit.minBinId}..${c.deposit.maxBinId}]`).join(" ");
  return `${head}${fill} — FLIP #${plan.flips + 1} (${plan.layout}): tranche ${plan.trancheBins} bins / ${plan.trancheSol.toFixed(4)} SOL; ${legs} (${plan.reason})${extra}`;
}

/**
 * Management hook: evaluate (and in live mode execute) a flip for each open
 * position. Must be called while the management lock is held. Never throws.
 *
 * deps (all optional, injected in tests): { config, log, getTrackedPosition,
 *   updateTrackedPosition, getPool, isBusy, isCloseInflight, sdk,
 *   getWallet, sendTx, exitAlerts: Set<position> }
 */
export async function runBidAskFlips(positions = [], deps = {}) {
  const log = deps.log || defaultLog;
  const cfg = normalizeFlipConfig(deps.config?.bidAskFlip);
  const results = [];
  if (cfg.mode === "off") return results;
  try {
    const state = deps.getTrackedPosition ? deps : await import("../state.js");
    const dlmm = deps.getPool ? null : await import("./dlmm.js");
    const getPool = deps.getPool || dlmm.getPoolForRead;
    const sdk = deps.sdk || await import("@meteora-ag/dlmm");
    // M1: one deadline for the whole pass. A hung RPC read must never stall the
    // management cycle or hold the wallet lock: on timeout we log, skip, and (live,
    // mid-send only) mark the flip pending so the next cycle re-reads on-chain.
    const deadline = Date.now() + (deps.timeoutMs ?? cfg.timeoutSec * 1000);
    for (const p of positions) {
      const ctl = { aborted: false, sending: false, snapshot: null };
      try {
        if (deadline - Date.now() <= 0) { log("bidask_flip", `flip pass deadline reached; skipping ${p?.pair ?? "?"} until next cycle`); continue; }
        const inner = () => flipOne(p, { ...deps, log, cfg, state, getPool, sdk, dlmm, ctl });
        // D2: the budget is computed after the wallet lock is acquired, so time spent
        // queued behind closes/claims is deducted; a pass whose deadline already
        // elapsed while queued does nothing (it must not sign later with a stale budget).
        const run = () => {
          const left = deadline - Date.now();
          if (left <= 0) { ctl.aborted = true; log("bidask_flip", `flip pass deadline elapsed while waiting for the wallet lock; skipping ${p?.pair ?? "?"} until next cycle`); return null; }
          return raceFlipTimeout(inner(), left, ctl);
        };
        // Live flips sign: serialize with closes/claims/swaps/deploys through the wallet
        // lock (above deploys, below closes). flipOne re-reads tracked state inside the lock,
        // so a position closed while we queued is skipped. Shadow/dry-run never signs.
        const signs = cfg.mode === "live" && !(deps.dryRun ?? isDryRun());
        const r = signs && !deps.noWalletLock ? await withWalletLock(run, 1, "bidask_flip") : await run();
        if (r) results.push(r);
      } catch (e) {
        if (e?.flipTimeout) {
          log("bidask_flip", `${p?.pair ?? "?"} ${String(p?.position ?? "").slice(0, 8)}: flip timed out after ${Math.round(totalBudgetMs(deadline, deps, cfg) / 1000)}s; skipped this cycle${ctl.sending ? " (tx may be in flight: marked pending, next cycle re-reads on-chain)" : ""}`);
          if (ctl.sending && ctl.snapshot) {
            try {
              const prev = state.getTrackedPosition(p.position)?.bid_ask_flip || {};
              state.updateTrackedPosition(p.position, { bid_ask_flip: { ...prev, pending: { at: new Date().toISOString(), ...ctl.snapshot } } }, "bid-ask flip timed out mid-send: pending on-chain re-read");
            } catch (e2) { log("bidask_flip", `could not persist pending flip marker: ${e2.message}`); }
          }
        } else {
          log("bidask_flip", `${p?.pair ?? "?"} ${String(p?.position ?? "").slice(0, 8)}: flip check failed: ${e.message}`);
        }
      }
    }
  } catch (e) {
    log("bidask_flip", `flip pass failed: ${e.message}`);
  }
  return results;
}

// D4: the budget this pass was given (for the log line). The deadline argument is the
// absolute end of the pass; it is the source of truth once it has passed.
function totalBudgetMs(deadline, deps, cfg) { return Math.max(0, deps.timeoutMs ?? cfg.timeoutSec * 1000); }
export function remainingMs(deadline, now = Date.now()) { return Math.max(0, deadline - now); }

/** M1: reject with a tagged error after `ms`; flags ctl.aborted so an abandoned run never sends. */
function raceFlipTimeout(promise, ms, ctl) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => { ctl.aborted = true; const e = new Error("flip timed out"); e.flipTimeout = true; reject(e); }, ms);
  });
  promise.catch(() => {}); // the abandoned run may still reject later
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

const xSig = (bins, activeId) => bins.filter((b) => b.binId > activeId && b.xRaw > 0n).map((b) => `${b.binId}:${b.xRaw}`).join(",");

async function flipOne(p, ctx) {
  const { log, cfg, state, getPool, sdk } = ctx;
  if (!p?.position || !p.pool) return null;
  const tracked = state.getTrackedPosition(p.position);
  if (!tracked || tracked.closed) return null;
  // H1: only positions this bot deployed as single-sided SOL Bid-Ask; silent otherwise.
  if (flipEligibilityBlocker(tracked)) return null;
  if (ctx.isBusy?.() || ctx.isCloseInflight?.(p.position)) return null;

  const exitReason = exitRuleFiresForFlip(p, tracked, ctx.config?.management || {}, { exitAlert: ctx.exitAlerts?.has?.(p.position) });
  // DRY_RUN never signs: live mode degrades to shadow.
  const shadow = cfg.mode === "shadow" || (ctx.dryRun ?? isDryRun());
  const flipState = (shadow ? tracked.bid_ask_flip_shadow : tracked.bid_ask_flip) || {};
  if (exitReason) {
    // Cheap: no RPC when the close path owns this tick.
    return { position: p.position, action: "hold", reason: `exit rule fires (${exitReason})` };
  }

  // M2: once a position has been flipped live, p.pnl_pct is the on-chain figure
  // (tools/dlmm.js applyFlipOnchainPnl). If it still disagrees with the PnL API
  // by more than FLIP_PNL_DIVERGENCE_PP, the API is booking the flip's
  // withdraw+redeposit as flows (or one source is wrong): stop flipping.
  if (!shadow && Number(tracked.bid_ask_flip?.flips) > 0 && Number.isFinite(p.pnl_api_pct) && Number.isFinite(p.pnl_pct)
      && Math.abs(p.pnl_api_pct - p.pnl_pct) > FLIP_PNL_DIVERGENCE_PP) {
    const reason = `PnL sources diverge after flip (on-chain ${p.pnl_pct}% vs API ${p.pnl_api_pct}%) — no further flips`;
    log("bidask_flip", `${p.pair ?? "?"} ${String(p.position).slice(0, 8)}: ${reason}`);
    return { position: p.position, action: "hold", reason };
  }

  // N1: after a live flip the API PnL is untrustworthy (it books the flip's
  // withdraw+redeposit as flows). If the on-chain read failed this tick
  // (pnl_source !== "onchain") the divergence check above is blind, so hold.
  if (!shadow && Number(tracked.bid_ask_flip?.flips) > 0 && p.pnl_source !== "onchain") {
    const reason = `no on-chain PnL after live flip (pnl_source ${p.pnl_source ?? "unset"}) — no further flips`;
    log("bidask_flip", `${p.pair ?? "?"} ${String(p.position).slice(0, 8)}: ${reason}`);
    return { position: p.position, action: "hold", reason };
  }

  // N6 (known, accepted): peak_pnl_pct recorded BEFORE the first live flip comes
  // from the API; afterwards trailing measures peak(API era) - on-chain now. The
  // >2pp mismatch handling in updatePnlAndCheckExits/recordPnlHold bounds this
  // mixed-source error below any sane trailingDropPct, so the peak is not reset.
  // L8: RPC cost — in shadow AND live every eligible open bot bid_ask position
  // costs one refetchStates + getPosition per management tick, plus ~15 RPC calls
  // (build + simulate) per would-be flip.
  const pool = await getPool(p.pool);
  await pool.refetchStates();
  const { PublicKey } = await import("@solana/web3.js");
  const positionPk = new PublicKey(p.position);
  const lbPos = await pool.getPosition(positionPk);
  const pd = lbPos.positionData;
  // M1: a previous live flip timed out mid-send. Re-read on-chain before any re-flip:
  // if the token-X layout above the active bin changed, the flip landed (record it,
  // conservatively, as done); otherwise nothing landed. Either way hold this cycle.
  const pend = !shadow ? tracked.bid_ask_flip?.pending : null;
  if (pend) {
    const landed = xSig(normalizeBins(pd.positionBinData), Number(pend.activeId)) !== pend.xSig;
    const { pending: _drop, ...rest } = tracked.bid_ask_flip;
    state.updateTrackedPosition(p.position, {
      bid_ask_flip: landed
        ? { ...rest, flips: (Number(rest.flips) || 0) + 1, last_flip_active_bin: Number(pend.activeId), last_flip_at: new Date().toISOString(), partial: true, uncertain: true }
        : rest,
    }, `bid-ask flip pending resolved on-chain: ${landed ? "landed" : "not landed"}`);
    log("bidask_flip", `${p.pair ?? "?"} ${String(p.position).slice(0, 8)}: pending flip re-read on-chain: ${landed ? "landed (recorded)" : "not landed (cleared)"}; no new flip this cycle`);
    return { position: p.position, action: "hold", reason: `pending flip resolved (${landed ? "landed" : "not landed"})` };
  }
  const plan = planBidAskFlip({
    bins: normalizeBins(pd.positionBinData),
    activeId: Number(pool.lbPair.activeId),
    lowerBinId: Number(pd.lowerBinId),
    upperBinId: Number(pd.upperBinId),
    bandTop: Number(tracked.bin_range?.max),
    strategy: tracked.strategy,
    binsAbove: tracked.bin_range?.bins_above,
    quoteIsSol: pool.tokenY.publicKey.toBase58() === WSOL,
    decimalsX: pool.tokenX.mint.decimals,
    decimalsY: pool.tokenY.mint.decimals,
    depositedSol: tracked.amount_sol,
    flipState,
    cfg,
    exitReason: null,
    maxPriorityFeeLamports: ctx.config?.management?.maxPriorityFeeLamports,
    tokenBlocker: await token2022Blocker(pool.tokenX),
  });
  if (plan.action !== "flip") {
    // Log holds only once fill is meaningful, to keep the log quiet.
    if ((plan.fill?.fillPct ?? 0) >= Math.min(cfg.fillPct, 10)) log("bidask_flip", `[${cfg.mode}] ${formatFlipPlan(p.pair, p.position, plan)}`);
    return { position: p.position, ...plan };
  }

  const owner = pd.owner;
  const conn = pool.program.provider.connection;
  // Build + simulate every chunk first; nothing is sent unless all of them pass.
  const built = [];
  for (const chunk of plan.chunks) {
    const b = await buildAtomicFlipIxs({ pool, positionPk, positionData: pd, plan, chunk, rentPayer: owner, sdk });
    const sim = await simulateFlipIxs(conn, b.ixs, owner);
    built.push({ chunk, ...b, simErr: sim?.value?.err ?? null, cu: sim?.value?.unitsConsumed ?? null });
  }
  // M3/M5: the SDK pre-ixs can create the owner's token-X ATA (≈0.002 SOL rent,
  // seen on mainnet sim 38KS…). Count it in the cost floor and make it visible.
  // N2: rent for the one-time token-X ATA is paid once (every pre-built chunk carries
  // the idempotent create, but only the first lands it), so dedupe by ATA address.
  // It is not scaled by the 25× multiplier: floor = 25 × tx fees + ATA rent once.
  // WSOL ATA creates are excluded (rent refunded by the in-tx CloseAccount).
  const ataSet = new Set(built.flatMap((b) => b.ataKeys || []));
  const ataCreates = ataSet.size;
  if (ataCreates > 0) {
    const feeSol = estimateFlipCostLamports({ chunks: built.length, maxPriorityFeeLamports: ctx.config?.management?.maxPriorityFeeLamports }) / 1e9;
    const ataSol = (ataCreates * ATA_RENT_LAMPORTS) / 1e9;
    const floorSol = COST_FLOOR_MULT * feeSol + ataSol;
    log("bidask_flip", `${p.pair ?? "?"} ${String(p.position).slice(0, 8)}: flip creates ${ataCreates} token ATA(s) (~${ataSol.toFixed(4)} SOL rent, once); est. total cost ${(feeSol + ataSol).toFixed(4)} SOL`);
    if (plan.trancheSol < floorSol) {
      const reason = `tranche ${plan.trancheSol.toFixed(4)} SOL < ${COST_FLOOR_MULT}× tx fees + ATA rent (${floorSol.toFixed(4)})`;
      log("bidask_flip", `[${cfg.mode}] ${formatFlipPlan(p.pair, p.position, plan)} — HOLD: ${reason}`);
      return { position: p.position, action: "hold", reason, activeId: plan.activeId, flips: plan.flips, fill: plan.fill };
    }
  }
  const simErr = built.find((b) => b.simErr)?.simErr ?? null;
  const cu = built.map((b) => b.cu);
  const extra = ` | ${plan.layout} ${built.length} tx | sim ${simErr ? `ERR ${JSON.stringify(simErr)}` : "ok"} CU ${cu.join("+")}`;

  if (shadow) {
    log("bidask_flip", `[shadow] ${formatFlipPlan(p.pair, p.position, plan, extra)} — shadow only, nothing signed`);
    if (!simErr) {
      state.updateTrackedPosition(p.position, {
        bid_ask_flip_shadow: {
          flips: plan.flips + 1,
          last_flip_active_bin: plan.activeId,
          last_flip_fill_pct: Math.round(plan.fill.fillPct * 10) / 10,
          last_flip_at: new Date().toISOString(),
          last_tranche_sol: Math.round(plan.trancheSol * 1e6) / 1e6,
          last_sim_cu: cu,
          layout: plan.layout,
        },
      });
    }
    return { position: p.position, ...plan, simErr, cu, mode: "shadow" };
  }

  // ── live ──
  if (simErr) {
    log("bidask_flip", `[live] ${formatFlipPlan(p.pair, p.position, plan, extra)} — NOT sent (simulation failed)`);
    return { position: p.position, ...plan, simErr, cu, mode: "live", sent: false };
  }
  const wallet = ctx.getWallet ? ctx.getWallet() : ctx.dlmm.getWalletForFlip();
  if (!wallet.publicKey.equals(owner)) throw new Error("position owner is not the bot wallet");
  const sendTx = ctx.sendTx || ctx.dlmm.sendManagedTransactionForFlip;
  const { Transaction } = await import("@solana/web3.js");
  const sigs = [];
  let sendError = null;
  if (ctx.ctl) { ctx.ctl.snapshot = { activeId: plan.activeId, xSig: xSig(normalizeBins(pd.positionBinData), plan.activeId) }; ctx.ctl.sending = true; }
  for (const [i, b0] of built.entries()) {
    let b = b0;
    try {
      if (ctx.ctl?.aborted) throw new Error("flip pass timed out");
      if (i > 0) {
        // Later chunks are rebuilt from the post-previous-chunk state.
        await pool.refetchStates();
        if (Number(pool.lbPair.activeId) !== plan.activeId) throw new Error("active bin moved between chunks");
        const fresh = (await pool.getPosition(positionPk)).positionData;
        b = await buildAtomicFlipIxs({ pool, positionPk, positionData: fresh, plan, chunk: b0.chunk, rentPayer: owner, sdk });
        const s2 = await simulateFlipIxs(conn, b.ixs, owner);
        if (s2?.value?.err) throw new Error(`chunk ${i + 1} re-simulation failed: ${JSON.stringify(s2.value.err)}`);
      }
      // Each chunk is atomic and net-zero, so stopping after a failed chunk
      // leaves a valid (partially flipped) position — never stranded token.
      // D1: the deadline may have fired during the rebuild awaits above; an abandoned run must never sign.
      if (ctx.ctl?.aborted) throw new Error("flip pass timed out");
      sigs.push(await sendTx(new Transaction().add(...b.ixs), [wallet], `bid-ask flip ${sigs.length + 1}/${built.length}`));
    } catch (e) {
      sendError = e.message;
      break;
    }
  }
  if (!sigs.length) {
    if (ctx.ctl) ctx.ctl.sending = false;
    log("bidask_flip", `[live] ${formatFlipPlan(p.pair, p.position, plan, extra)} — send failed: ${sendError}`);
    return { position: p.position, ...plan, simErr: null, cu, mode: "live", sent: false, sendError };
  }
  // Verify: SOL bins at/below active unchanged; X now sits in the ask bins.
  let verified;
  try {
    await pool.refetchStates();
    const after = normalizeBins((await pool.getPosition(positionPk)).positionData.positionBinData);
    const before = normalizeBins(pd.positionBinData);
    // L2: only bins strictly below the active bin (the active bin's Y is moved by
    // ordinary swaps), plus range unchanged. A mismatch is the only way to see an
    // SDK-vs-program shrink divergence, so it alerts.
    const ySame = before.filter((b) => b.binId < plan.activeId).every((b) => {
      const a = after.find((x) => x.binId === b.binId);
      return a && a.yRaw === b.yRaw;
    });
    const afterPd = (await pool.getPosition(positionPk)).positionData;
    const rangeSame = Number(afterPd.lowerBinId) === Number(pd.lowerBinId) && Number(afterPd.upperBinId) === Number(pd.upperBinId);
    const xAbove = after.filter((b) => b.binId > plan.activeId).reduce((s, b) => s + b.xRaw, 0n);
    verified = { solBinsUntouched: ySame, rangeUnchanged: rangeSame, xAboveActiveRaw: xAbove.toString() };
    if (!ySame || !rangeSame) {
      const msg = `⚠️ Bid-Ask flip verify MISMATCH on ${p.pair ?? "?"} ${String(p.position).slice(0, 8)}: solBinsUntouched=${ySame} rangeUnchanged=${rangeSame}. Check the position manually.`;
      log("bidask_flip", msg);
      try { await (ctx.notify ? ctx.notify(msg) : (await import("../telegram.js")).sendMessage(msg)); } catch { /* alert is best-effort */ }
    }
  } catch (e) {
    verified = { error: e.message };
  }
  // D6: if this run was abandoned (timeout) and the tracked flip state advanced since we
  // read it (pending resolution or a newer flip), do not overwrite it with cycle-start data.
  if (ctx.ctl?.aborted) {
    const cur = state.getTrackedPosition(p.position)?.bid_ask_flip || {};
    const advanced = Number(cur.flips || 0) > Number(plan.flips || 0) || (cur.last_flip_at && cur.last_flip_at !== (tracked.bid_ask_flip || {}).last_flip_at);
    if (advanced) {
      ctx.ctl.sending = false;
      log("bidask_flip", `[live] abandoned flip run landed ${sigs.length}/${built.length} (${sigs.join(",")}) but tracked state already advanced; not overwriting`);
      return { position: p.position, ...plan, simErr: null, cu, mode: "live", sent: true, sigs, sendError, verified, stateSkipped: true };
    }
  }
  const prev = (ctx.ctl?.aborted ? state.getTrackedPosition(p.position)?.bid_ask_flip : null) || tracked.bid_ask_flip || {};
  const pct = Math.round(plan.fill.fillPct * 10) / 10;
  // L1: chunks run top-first. When only some landed, bins between active+1 and
  // the lowest landed chunk are still unflipped, so the next fresh tranche must
  // reach up to just below that chunk instead of being cut at the plan's active bin.
  const landed = built.slice(0, sigs.length);
  const lastFlipActiveBin = sigs.length < built.length
    ? Math.min(...landed.map((b) => b.chunk.withdraw.minBinId)) - 1
    : plan.activeId;
  state.updateTrackedPosition(p.position, {
    bid_ask_flip: {
      flips: plan.flips + 1,
      last_flip_active_bin: lastFlipActiveBin,
      last_flip_fill_pct: pct,
      first_flip_fill_pct: prev.first_flip_fill_pct ?? pct,
      last_flip_at: new Date().toISOString(),
      last_tranche_sol: Math.round(plan.trancheSol * 1e6) / 1e6,
      layout: plan.layout,
      partial: sigs.length < built.length || undefined,
      txs: [...(prev.txs || []), ...sigs].slice(-10),
    },
  }, `bid-ask flip #${plan.flips + 1} at fill ${pct}% (${sigs.length}/${built.length} tx): ${sigs.join(", ")}`);
  if (ctx.ctl) ctx.ctl.sending = false;
  log("bidask_flip", `[live] ${formatFlipPlan(p.pair, p.position, plan, extra)} — SENT ${sigs.length}/${built.length} ${sigs.join(",")}${sendError ? ` (stopped: ${sendError})` : ""} verify=${JSON.stringify(verified)}`);
  return { position: p.position, ...plan, simErr: null, cu, mode: "live", sent: true, sigs, sendError, verified };
}

/** Fields to add to the close/performance record for flipped positions. */
export function flipCloseTags(tracked) {
  const f = tracked?.bid_ask_flip;
  if (!f?.flips && !f?.pending) return {};
  return { flipped: true, flip_count: f.flips ?? 0, flip_fill_pct: f.first_flip_fill_pct ?? f.last_flip_fill_pct ?? null };
}
