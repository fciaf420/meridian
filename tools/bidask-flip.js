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
 * Pure helpers (planBidAskFlip, computeFill, buildFlipParams, ...) take plain
 * data so they are unit-testable without RPC.
 */

import BN from "bn.js";
import { log as defaultLog } from "../logger.js";

export const FLIP_MODES = ["off", "shadow", "live"];
export const FLIP_DEFAULTS = Object.freeze({ mode: "shadow", fillPct: 30, reflipStepPct: 20, minTrancheSol: 0.05 });
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
 * Should this tick's exit rules close the position? A flip never runs on a tick
 * where any close rule fires: the close path wins.
 */
export function exitRuleFiresForFlip(p, tracked, mgmt = {}, { exitAlert = false } = {}) {
  if (exitAlert) return "exit alert (trailing TP / stop loss / strategy exit)";
  if (tracked?.instruction) return "rule 1: instruction";
  if (p?.pnl_pct == null) return null;
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
  if (input.strategy && input.strategy !== "bid_ask") return hold(`not a bid_ask position (${input.strategy})`);
  if (Number(input.binsAbove || 0) > 0) return hold("not single-sided (bins_above > 0)");
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
  if (trancheSol < cfg.minTrancheSol) return hold(`tranche ${trancheSol.toFixed(4)} SOL < min ${cfg.minTrancheSol}`, details);
  const maxDelta = U - activeId;
  if (maxDelta < MIN_ASK_BINS) return hold(`ask would span ${maxDelta} bins (< ${MIN_ASK_BINS})`, details);

  const chunks = planFlipChunks({ bins, activeId, lo, hi, U, maxOps: input.maxBinOpsPerTx ?? MAX_BIN_OPS_PER_TX });
  if (!chunks.length) return hold("tranche too small after rounding haircut", details);
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
  const out = await pool.rebalancePosition(resp, new BN(0), rentPayer, FLIP_SLIPPAGE_PCT);
  if (!allowBinArrayInit && out.initBinArrayInstructions.length > 0) {
    throw new Error(`flip needs ${out.initBinArrayInstructions.length} bin-array init ix(s) — refusing`);
  }
  const all = out.rebalancePositionInstruction;
  return {
    ixs: all.filter((ix) => !isComputeBudgetIx(ix)),
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
    for (const p of positions) {
      try {
        const r = await flipOne(p, { ...deps, log, cfg, state, getPool, sdk, dlmm });
        if (r) results.push(r);
      } catch (e) {
        log("bidask_flip", `${p?.pair ?? "?"} ${String(p?.position ?? "").slice(0, 8)}: flip check failed: ${e.message}`);
      }
    }
  } catch (e) {
    log("bidask_flip", `flip pass failed: ${e.message}`);
  }
  return results;
}

async function flipOne(p, ctx) {
  const { log, cfg, state, getPool, sdk } = ctx;
  if (!p?.position || !p.pool) return null;
  const tracked = state.getTrackedPosition(p.position);
  if (!tracked || tracked.closed) return null;
  if (tracked.strategy !== "bid_ask" || Number(tracked.bin_range?.bins_above || 0) > 0) return null; // silent: never applicable
  if (ctx.isBusy?.() || ctx.isCloseInflight?.(p.position)) return null;

  const exitReason = exitRuleFiresForFlip(p, tracked, ctx.config?.management || {}, { exitAlert: ctx.exitAlerts?.has?.(p.position) });
  // DRY_RUN never signs: live mode degrades to shadow.
  const shadow = cfg.mode === "shadow" || (ctx.dryRun ?? process.env.DRY_RUN === "true");
  const flipState = (shadow ? tracked.bid_ask_flip_shadow : tracked.bid_ask_flip) || {};
  if (exitReason) {
    // Cheap: no RPC when the close path owns this tick.
    return { position: p.position, action: "hold", reason: `exit rule fires (${exitReason})` };
  }

  const pool = await getPool(p.pool);
  await pool.refetchStates();
  const { PublicKey } = await import("@solana/web3.js");
  const positionPk = new PublicKey(p.position);
  const lbPos = await pool.getPosition(positionPk);
  const pd = lbPos.positionData;
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
  const wallet = ctx.getWallet ? ctx.getWallet() : ctx.dlmm._getWalletForFlip();
  if (!wallet.publicKey.equals(owner)) throw new Error("position owner is not the bot wallet");
  const sendTx = ctx.sendTx || ctx.dlmm._sendManagedTransactionForTest;
  const { Transaction } = await import("@solana/web3.js");
  const sigs = [];
  let sendError = null;
  for (const [i, b0] of built.entries()) {
    let b = b0;
    try {
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
      sigs.push(await sendTx(new Transaction().add(...b.ixs), [wallet], `bid-ask flip ${sigs.length + 1}/${built.length}`));
    } catch (e) {
      sendError = e.message;
      break;
    }
  }
  if (!sigs.length) {
    log("bidask_flip", `[live] ${formatFlipPlan(p.pair, p.position, plan, extra)} — send failed: ${sendError}`);
    return { position: p.position, ...plan, simErr: null, cu, mode: "live", sent: false, sendError };
  }
  // Verify: SOL bins at/below active unchanged; X now sits in the ask bins.
  let verified;
  try {
    await pool.refetchStates();
    const after = normalizeBins((await pool.getPosition(positionPk)).positionData.positionBinData);
    const before = normalizeBins(pd.positionBinData);
    const ySame = before.filter((b) => b.binId <= plan.activeId).every((b) => {
      const a = after.find((x) => x.binId === b.binId);
      return a && a.yRaw === b.yRaw;
    });
    const xAbove = after.filter((b) => b.binId > plan.activeId).reduce((s, b) => s + b.xRaw, 0n);
    verified = { solBinsUntouched: ySame, xAboveActiveRaw: xAbove.toString() };
  } catch (e) {
    verified = { error: e.message };
  }
  const prev = tracked.bid_ask_flip || {};
  const pct = Math.round(plan.fill.fillPct * 10) / 10;
  state.updateTrackedPosition(p.position, {
    bid_ask_flip: {
      flips: plan.flips + 1,
      last_flip_active_bin: plan.activeId,
      last_flip_fill_pct: pct,
      first_flip_fill_pct: prev.first_flip_fill_pct ?? pct,
      last_flip_at: new Date().toISOString(),
      last_tranche_sol: Math.round(plan.trancheSol * 1e6) / 1e6,
      layout: plan.layout,
      partial: sigs.length < built.length || undefined,
      txs: [...(prev.txs || []), ...sigs].slice(-10),
    },
  }, `bid-ask flip #${plan.flips + 1} at fill ${pct}% (${sigs.length}/${built.length} tx): ${sigs.join(", ")}`);
  log("bidask_flip", `[live] ${formatFlipPlan(p.pair, p.position, plan, extra)} — SENT ${sigs.length}/${built.length} ${sigs.join(",")}${sendError ? ` (stopped: ${sendError})` : ""} verify=${JSON.stringify(verified)}`);
  return { position: p.position, ...plan, simErr: null, cu, mode: "live", sent: true, sigs, sendError, verified };
}

/** Fields to add to the close/performance record for flipped positions. */
export function flipCloseTags(tracked) {
  const f = tracked?.bid_ask_flip;
  if (!f?.flips) return {};
  return { flipped: true, flip_count: f.flips, flip_fill_pct: f.first_flip_fill_pct ?? f.last_flip_fill_pct ?? null };
}
