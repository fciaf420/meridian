import {
  Connection,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { log } from "../logger.js";
import {
  trackPosition,
  markOutOfRange,
  markInRange,
  recordClaim,
  recordClose,
  getTrackedPosition,
  minutesOutOfRange,
  syncOpenPositions,
} from "../state.js";
import { recordPerformance } from "../lessons.js";
import { getAndClearStagedSignals } from "../signal-tracker.js";
import { normalizeMint, getWalletBalances, swapToken } from "./wallet.js";
import { calculateBinsForPriceRange, splitRangeBins } from "../runtime-helpers.js";

// ─── Lazy SDK loader ───────────────────────────────────────────
// @meteora-ag/dlmm → @coral-xyz/anchor uses CJS directory imports
// that break in ESM on Node 24. Dynamic import defers loading until
// an actual on-chain call is needed (never triggered in dry-run).
let _DLMM = null;
let _StrategyType = null;

async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _StrategyType = mod.StrategyType;
  }
  return { DLMM: _DLMM, StrategyType: _StrategyType };
}

// ─── Lazy wallet/connection init ──────────────────────────────
// Avoids crashing on import when WALLET_PRIVATE_KEY is not yet set
// (e.g. during screening-only tests).
let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) {
    _connection = new Connection(process.env.RPC_URL, "confirmed");
  }
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) {
      throw new Error("WALLET_PRIVATE_KEY not set");
    }
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    log("init", `Wallet: ${_wallet.publicKey.toString()}`);
  }
  return _wallet;
}

function getHeliusPriorityFeeRpcUrl() {
  const heliusKey = process.env.HELIUS_API_KEY;
  if (!heliusKey) return null;
  return `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
}

async function estimatePriorityFeeMicroLamports(tx, feePayer, label = "tx") {
  const heliusUrl = getHeliusPriorityFeeRpcUrl();
  if (!heliusUrl || !tx?.instructions?.length) return null;

  try {
    tx.feePayer ??= feePayer;
    if (!tx.recentBlockhash) {
      const { blockhash } = await getConnection().getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
    }

    const serializedTx = bs58.encode(tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }));

    const res = await fetch(heliusUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "getPriorityFeeEstimate",
        params: [{
          transaction: serializedTx,
          options: {
            priorityLevel: config.management.priorityFeeLevel || "Medium",
            recommended: true,
          },
        }],
      }),
    });

    if (!res.ok) {
      throw new Error(`Helius fee estimate failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const estimate = Math.ceil(Number(data?.result?.priorityFeeEstimate || 0));
    if (!Number.isFinite(estimate) || estimate <= 0) return null;
    log("priority_fee", `${label}: estimated ${estimate} microlamports/CU (${config.management.priorityFeeLevel})`);
    return estimate;
  } catch (error) {
    log("priority_fee_warn", `${label}: ${error.message}`);
    return null;
  }
}

async function applyPriorityFee(tx, feePayer, label) {
  if (!tx?.instructions?.length) return tx;

  const microLamports = await estimatePriorityFeeMicroLamports(tx, feePayer, label);
  if (!microLamports) return tx;

  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports })
  );

  const { blockhash } = await getConnection().getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = feePayer;
  return tx;
}

async function sendManagedTransaction(tx, signers, label) {
  const feePayer = signers?.[0]?.publicKey;
  await applyPriorityFee(tx, feePayer, label);
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) {
        const { blockhash } = await getConnection().getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer ??= feePayer;
      }

      return await sendAndConfirmTransaction(getConnection(), tx, signers, {
        skipPreflight: true,
        preflightCommitment: "confirmed",
        commitment: "confirmed",
        maxRetries: 3,
      });
    } catch (error) {
      lastError = error;
      const message = error?.message || String(error);
      const retryableExpiry =
        /block height exceeded/i.test(message) ||
        /blockhash not found/i.test(message) ||
        /transaction expired/i.test(message);

      if (!retryableExpiry || attempt === 2) {
        throw error;
      }

      log("tx_retry", `${label}: ${message}; refreshing blockhash and retrying (${attempt + 2}/3)`);
    }
  }

  throw lastError;
}

// ─── Pool Cache ────────────────────────────────────────────────
const poolCache = new Map();
const closeInflight = new Map();

async function getPool(poolAddress) {
  const key = poolAddress.toString();
  if (!poolCache.has(key)) {
    const { DLMM } = await getDLMM();
    const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
    poolCache.set(key, pool);
  }
  return poolCache.get(key);
}

setInterval(() => poolCache.clear(), 5 * 60 * 1000);

// ─── Get Active Bin ────────────────────────────────────────────
export async function getActiveBin({ pool_address }) {
  pool_address = normalizeMint(pool_address);
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  return {
    binId: activeBin.binId,
    price: pool.fromPricePerLamport(Number(activeBin.price)),
    pricePerLamport: activeBin.price.toString(),
  };
}

// ─── Deploy Position ───────────────────────────────────────────
export async function deployPosition({
  pool_address,
  amount_sol, // legacy: will be used as amount_y if amount_y is not provided
  amount_x,
  amount_y,
  strategy,
  bins_below,
  bins_above,
  price_range_pct, // pass target % range and bins are calculated automatically
  sol_split_pct,   // for two-sided spot: SOL side % of total range (e.g. 80 = 80% below, 20% above). Default 50.
  // optional pool metadata for learning (passed by agent when available)
  pool_name,
  base_mint,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  study_avg_hold_hours,
}) {
  pool_address = normalizeMint(pool_address);
  const activeStrategy = strategy || config.strategy.strategy;
  let resolvedBinStep = bin_step;
  let totalSolAmount = amount_y ?? amount_sol ?? 0;

  // ─── Hard guard: enforce minimum deploy amount from computeDeployAmount ───
  // Models sometimes ignore the prompt and pass tiny amounts (0.1, 0.2 SOL).
  // Override with the computed amount based on wallet balance + positionSizePct.
  try {
    const { computeDeployAmount } = await import("../config.js");
    const { getWalletBalances } = await import("./wallet.js");
    const bal = await getWalletBalances();
    if (bal?.sol > 0) {
      const computed = computeDeployAmount(bal.sol);
      if (totalSolAmount < computed * 0.5) {
        log("deploy", `Amount ${totalSolAmount} SOL overridden to ${computed} SOL (model passed too little, computed from ${bal.sol} SOL wallet)`);
        totalSolAmount = computed;
      }
    }
  } catch { /* best-effort — use what the model passed */ }

  if (!["bid_ask", "spot"].includes(activeStrategy)) {
    throw new Error("Only 'bid_ask' or 'spot' strategies are allowed.");
  }

  // ─── Hard guard: two-sided spot requires ALL 4 conditions ──────
  const isTwoSidedSpot = activeStrategy === "spot" && sol_split_pct != null && sol_split_pct < 100;
  if (isTwoSidedSpot) {
    const failures = [];

    // Condition 1: Smart wallets must be present on this pool
    let hasSmartWallets = false;
    try {
      const { checkSmartWalletsOnPool } = await import("../smart-wallets.js");
      const swResult = await checkSmartWalletsOnPool({ pool_address });
      hasSmartWallets = swResult?.found?.length > 0;
    } catch { /* default to false */ }
    if (!hasSmartWallets) failures.push("no smart wallets on pool");

    // Condition 2: Top LPers >= 80% win rate using spot
    let studyPasses = false;
    try {
      const studyResult = await studyTopLPers({ pool_address, limit: 4 });
      const credible = (studyResult?.lpers || []).filter(lp => lp.total_lp >= 3 && lp.win_rate >= 0.6 && lp.total_inflow >= 1000);
      const avgWR = credible.length > 0 ? credible.reduce((s, lp) => s + lp.win_rate, 0) / credible.length : 0;
      studyPasses = avgWR >= 0.80;
    } catch { /* default to false */ }
    if (!studyPasses) failures.push("top LPers < 80% win rate");

    // Condition 3: Price must be stabilizing (not pumping >10% in 1h)
    let priceStable = false;
    try {
      const { fetchGmgnPriceInfo } = await import("../tools/gmgn.js");
      const resolvedMint = base_mint || (await (async () => {
        const pool = await getPool(pool_address);
        return pool.lbPair.tokenXMint.toBase58();
      })());
      const gmgn = await fetchGmgnPriceInfo(resolvedMint);
      priceStable = gmgn && Math.abs(gmgn.change_1h || 0) <= 10;
    } catch { priceStable = true; /* if GMGN unavailable, don't block on this alone */ }
    if (!priceStable) failures.push("price pumping >10% in 1h");

    // Condition 4: Pool memory shows prior spot profits
    let memoryPasses = false;
    try {
      const { getPoolMemory } = await import("../pool-memory.js");
      const mem = getPoolMemory(pool_address);
      if (mem && mem.deploys?.length > 0) {
        const spotDeploys = mem.deploys.filter(d => d.strategy === "spot");
        const spotWins = spotDeploys.filter(d => (d.pnl_pct || 0) > 0);
        memoryPasses = spotDeploys.length > 0 && spotWins.length / spotDeploys.length > 0.5;
      }
    } catch { /* default to false */ }
    if (!memoryPasses) failures.push("no prior profitable spot deploys in pool memory");

    if (failures.length > 0) {
      log("deploy", `BLOCKED two-sided spot: ${failures.join(", ")}`);
      return {
        success: false,
        error: `Two-sided spot blocked — failed ${failures.length}/4 hard conditions: ${failures.join("; ")}. Use bid_ask instead.`,
      };
    }
    log("deploy", `Two-sided spot approved: all 4 conditions met (smart wallets, study WR >= 80%, price stable, pool memory positive)`);
  }

  // ─── Hard guard: no duplicate pool/token deployments ────────────
  {
    const { getTrackedPositions } = await import("../state.js");
    const openPositions = getTrackedPositions(true);

    // Block deploying to a pool we already have a position in
    const poolMatch = openPositions.find(p => p.pool === pool_address);
    if (poolMatch) {
      return {
        success: false,
        error: `Already have an open position in this pool (${poolMatch.pool_name || pool_address.slice(0, 8)}). Close it first.`,
      };
    }

    // Block deploying to a token we already have exposure to (different pool, same base mint)
    if (base_mint) {
      const mintMatch = openPositions.find(p => p.base_mint === base_mint && p.pool !== pool_address);
      if (mintMatch) {
        return {
          success: false,
          error: `Already have exposure to this token via ${mintMatch.pool_name || mintMatch.pool?.slice(0, 8)}. Close that position first or pick a different token.`,
        };
      }
    }

    // Check blacklist
    try {
      const { isBlacklisted } = await import("../token-blacklist.js");
      if (base_mint && isBlacklisted(base_mint)) {
        return {
          success: false,
          error: `Token ${base_mint.slice(0, 8)} is blacklisted. Cannot deploy.`,
        };
      }
    } catch { /* blacklist module may not exist */ }
  }

  if (price_range_pct > 0 && !resolvedBinStep) {
    try {
      const { getPoolDetail } = await import("./screening.js");
      const poolDetail = await getPoolDetail({ pool_address });
      resolvedBinStep = poolDetail?.bin_step || null;
    } catch (error) {
      log("deploy", `Unable to resolve bin_step before range calculation: ${error.message}`);
    }
  }

  // Auto-calculate bins from price_range_pct if provided (no need for separate calculate_bins call)
  if (price_range_pct > 0 && !bins_below && resolvedBinStep) {
    bins_below = calculateBinsForPriceRange(resolvedBinStep, price_range_pct);
    log("deploy", `Auto-calculated bins_below=${bins_below} from price_range_pct=${price_range_pct}% at bin_step=${resolvedBinStep}`);
  }

  // ─── Hard guard: validate actual range % when bins passed directly ───
  // Models sometimes pass raw bin counts from a different bin_step pool.
  // At bin_step 25, 96 bins = 21% range (model probably thought bin_step 80 = 53%).
  // Recalculate from the volatility table minimum (40% for moderate).
  if (bins_below > 0 && !price_range_pct && resolvedBinStep) {
    const stepPct = resolvedBinStep / 10000;
    const actualRangePct = (1 - Math.pow(1 + stepPct, -bins_below)) * 100;
    const MIN_RANGE_PCT = 35; // absolute floor — no position should be narrower
    if (actualRangePct < MIN_RANGE_PCT) {
      const correctedBins = calculateBinsForPriceRange(resolvedBinStep, MIN_RANGE_PCT);
      log("deploy", `Range too narrow: ${bins_below} bins at bs${resolvedBinStep} = ${actualRangePct.toFixed(1)}% (min ${MIN_RANGE_PCT}%). Correcting to ${correctedBins} bins`);
      bins_below = correctedBins;
    }
  }

  // ─── Detect auto-swap need ────────────────────────────────────
  // When the model wants two-sided spot but only has SOL:
  //   sol_split_pct is provided AND < 100, strategy is "spot", and no amount_x given.
  // We'll swap some SOL → base token automatically after fetching the pool.
  const needsAutoSwap = sol_split_pct != null && sol_split_pct < 100
    && activeStrategy === "spot"
    && !((amount_x ?? 0) > 0);

  let hasBaseToken = (amount_x ?? 0) > 0;
  const hasSol = totalSolAmount > 0;

  if (activeStrategy === "spot" && bins_below && !bins_above) {
    const totalRangeBins = bins_below;

    if (needsAutoSwap || (hasBaseToken && hasSol)) {
      // TWO-SIDED: split bins between SOL (below) and token (above)
      const splitPct = sol_split_pct ?? 50;
      const split = splitRangeBins(totalRangeBins, splitPct);
      bins_below = split.binsBelow;
      bins_above = split.binsAbove;
      log("deploy", `Two-sided spot: ${splitPct}% SOL / ${100 - splitPct}% token → bins_below=${bins_below}, bins_above=${bins_above} (total ${totalRangeBins})`);
    } else if (hasBaseToken && !hasSol) {
      // TOKEN-ONLY: all bins above active bin
      bins_below = 0;
      bins_above = totalRangeBins;
      log("deploy", `Token-only spot: all ${totalRangeBins} bins above active bin`);
    } else {
      // SOL-ONLY: all bins below active bin
      bins_above = 0;
      log("deploy", `SOL-only spot: all ${totalRangeBins} bins below active bin`);
    }
  }

  if (bins_above == null) bins_above = 0;

  let activeBinsBelow = bins_below ?? config.strategy.binsBelow;
  let activeBinsAbove = bins_above ?? 0;

  // Safety: reject tiny deploys (wastes gas, barely earns fees)
  const MIN_BINS = 20;
  let totalBins = activeBinsBelow + activeBinsAbove;
  if (totalBins < MIN_BINS) {
    return {
      success: false,
      error: `Rejected: total bins = ${totalBins}, minimum is ${MIN_BINS}. At bin_step ${resolvedBinStep || "?"}, ${MIN_BINS} bins ≈ ${resolvedBinStep ? (MIN_BINS * (resolvedBinStep / 10000) * 100).toFixed(0) : "?"}% range. Use calculate_bins with a target range of 25-50% and pass that bin count to bins_below.`,
    };
  }

  if (process.env.DRY_RUN === "true") {
    const dryRunResult = {
      dry_run: true,
      would_deploy: {
        pool_address,
        strategy: activeStrategy,
        bins_below: activeBinsBelow,
        bins_above: activeBinsAbove,
        amount_x: amount_x || 0,
        amount_y: totalSolAmount,
        wide_range: (activeBinsBelow + activeBinsAbove) > 69,
      },
      message: "DRY RUN — no transaction sent",
    };
    if (needsAutoSwap) {
      const tokenSolAmount = totalSolAmount * (1 - sol_split_pct / 100);
      dryRunResult.would_deploy.auto_swap = {
        swap_sol_amount: Math.round(tokenSolAmount * 1e6) / 1e6,
        remaining_sol: Math.round((totalSolAmount - tokenSolAmount) * 1e6) / 1e6,
        description: `Would auto-swap ${tokenSolAmount.toFixed(4)} SOL → base token, then deploy ${(totalSolAmount - tokenSolAmount).toFixed(4)} SOL + received tokens`,
      };
    }
    return dryRunResult;
  }

  const { StrategyType } = await getDLMM();
  const wallet = getWallet();
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();
  resolvedBinStep ||= pool.lbPair?.binStep ?? pool.lbPair?.bin_step ?? null;

  // ─── Auto-swap SOL → base token for two-sided spot ────────────
  if (needsAutoSwap) {
    const tokenSolAmount = totalSolAmount * (1 - sol_split_pct / 100);
    const baseMint = pool.lbPair.tokenXMint.toBase58();

    log("deploy", `Auto-swap: swapping ${tokenSolAmount.toFixed(4)} SOL → ${baseMint.slice(0, 8)}... for two-sided spot`);

    try {
      const swapResult = await swapToken({
        input_mint: "So11111111111111111111111111111111111111112",
        output_mint: baseMint,
        amount: tokenSolAmount,
      });

      if (swapResult.success) {
        // Read actual wallet token balance after swap — more reliable than
        // swapResult.amount_out which can differ from what's actually available
        // due to fees, rounding, or existing token dust in the wallet.
        const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(baseMint));
        const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
        const swapReceived = Number(swapResult.amount_out) / Math.pow(10, decimals);

        // Query actual on-chain balance to use for deploy
        let actualBalance = swapReceived;
        try {
          const walletBals = await getWalletBalances();
          const tokenBal = walletBals.tokens?.find(t => t.mint === baseMint);
          if (tokenBal && tokenBal.balance > 0) {
            actualBalance = tokenBal.balance;
            if (Math.abs(actualBalance - swapReceived) > 0.01) {
              log("deploy", `Token balance ${actualBalance} differs from swap output ${swapReceived} — using actual balance`);
            }
          }
        } catch { /* use swap output as fallback */ }

        // Apply 2% buffer so SDK simulation doesn't fail on rounding
        amount_x = actualBalance * 0.98;
        amount_y = totalSolAmount - tokenSolAmount;
        hasBaseToken = true;

        log("deploy", `Auto-swapped ${tokenSolAmount.toFixed(4)} SOL → ${swapReceived} tokens (${decimals} decimals). Deploying ${amount_y.toFixed(4)} SOL + ${amount_x.toFixed(6)} X (2% buffer applied)`);
      } else {
        log("deploy", `WARNING: Auto-swap failed (${swapResult.error}), falling back to SOL-only deployment`);
        // Fall back: keep original amounts, revert to the full SOL-only range.
        activeBinsAbove = 0;
        activeBinsBelow = totalRangeBins ?? bins_below ?? config.strategy.binsBelow;
        totalBins = activeBinsBelow + activeBinsAbove;
        if (totalBins < MIN_BINS) {
          return {
            success: false,
            error: `Rejected after swap fallback: total bins = ${totalBins}, minimum is ${MIN_BINS}.`,
          };
        }
      }
    } catch (swapErr) {
      log("deploy", `WARNING: Auto-swap error (${swapErr.message}), falling back to SOL-only deployment`);
      // Fall back: keep original amounts, revert to the full SOL-only range.
      activeBinsAbove = 0;
      activeBinsBelow = totalRangeBins ?? bins_below ?? config.strategy.binsBelow;
      totalBins = activeBinsBelow + activeBinsAbove;
      if (totalBins < MIN_BINS) {
        return {
          success: false,
          error: `Rejected after swap fallback: total bins = ${totalBins}, minimum is ${MIN_BINS}.`,
        };
      }
    }
  }

  // Range calculation
  const minBinId = activeBin.binId - activeBinsBelow;
  const maxBinId = activeBin.binId + activeBinsAbove;

  const strategyMap = {
    spot: StrategyType.Spot,
    curve: StrategyType.Curve,
    bid_ask: StrategyType.BidAsk,
  };

  const strategyType = strategyMap[activeStrategy];
  if (strategyType === undefined) {
    throw new Error(`Invalid strategy: ${activeStrategy}. Use spot, curve, or bid_ask.`);
  }

  // Calculate amounts
  // If amount_y is not provided but amount_sol is, use amount_sol (for backward compatibility)
  const finalAmountY = amount_y ?? amount_sol ?? 0;
  const finalAmountX = amount_x ?? 0;

  const totalYLamports = new BN(Math.floor(finalAmountY * 1e9));
  // For X, we assume it's also 9 decimals for now, or we'd need to fetch mint decimals.
  // Most Meteora pools base tokens are 6 or 9. To be safe, we should fetch.
  let totalXLamports = new BN(0);
  if (finalAmountX > 0) {
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    totalXLamports = new BN(Math.floor(finalAmountX * Math.pow(10, decimals)));
  }

  const isWideRange = totalBins > 69;
  const newPosition = Keypair.generate();

  log("deploy", `Pool: ${pool_address}`);
  log("deploy", `Strategy: ${activeStrategy}, Bins: ${minBinId} to ${maxBinId} (${totalBins} bins${isWideRange ? " — WIDE RANGE" : ""})`);
  log("deploy", `Amount: ${finalAmountX} X, ${finalAmountY} Y`);
  log("deploy", `Position: ${newPosition.publicKey.toString()}`);

  try {
    const txHashes = [];

    if (isWideRange) {
      // ── Wide Range Path (>69 bins) ─────────────────────────────────
      // Solana limits inner instruction realloc to 10240 bytes, so we can't create
      // a large position in a single initializePosition ix.
      // Solution: createExtendedEmptyPosition then addLiquidityByStrategyChunkable.

      // Phase 1: Create empty position (may be multiple txs)
      const createTxs = await pool.createExtendedEmptyPosition(
        minBinId,
        maxBinId,
        newPosition.publicKey,
        wallet.publicKey,
      );
      const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
      for (let i = 0; i < createTxArray.length; i++) {
        const signers = i === 0 ? [wallet, newPosition] : [wallet];
        const txHash = await sendManagedTransaction(createTxArray[i], signers, `deploy create ${i + 1}/${createTxArray.length}`);
        txHashes.push(txHash);
        log("deploy", `Create tx ${i + 1}/${createTxArray.length}: ${txHash}`);
      }

      // Track position IMMEDIATELY after on-chain creation so auto-adopt
      // never picks it up as "unknown". If Phase 2 fails, the position
      // is still tracked (with 0 liquidity) and can be cleaned up properly.
      const posAddr = newPosition.publicKey.toString();
      trackPosition({
        position: posAddr,
        pool: pool_address,
        pool_name,
        base_mint: pool.lbPair.tokenXMint.toBase58(),
        strategy: activeStrategy,
        strategy_type: activeStrategy === "bid_ask" ? "BidAsk" : (sol_split_pct === 100 ? "SpotOneSide" : "SpotTwoSide"),
        sol_split_pct: sol_split_pct ?? (activeStrategy === "bid_ask" ? 100 : null),
        bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
        bin_step: resolvedBinStep,
        volatility,
        fee_tvl_ratio,
        organic_score,
        amount_sol: 0, // will update after liquidity is added
        amount_x: 0,
        active_bin: activeBin.binId,
        initial_value_usd: 0,
        study_avg_hold_hours,
      });
      log("deploy", `Pre-tracked position ${posAddr.slice(0, 8)} (wide-range: liquidity pending)`);

      // Phase 2: Add liquidity (may be multiple txs)
      try {
        const addTxs = await pool.addLiquidityByStrategyChunkable({
          positionPubKey: newPosition.publicKey,
          user: wallet.publicKey,
          totalXAmount: totalXLamports,
          totalYAmount: totalYLamports,
          strategy: { minBinId, maxBinId, strategyType },
          slippage: 10, // 10%
        });
        const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
        for (let i = 0; i < addTxArray.length; i++) {
          const txHash = await sendManagedTransaction(addTxArray[i], [wallet], `deploy add-liquidity ${i + 1}/${addTxArray.length}`);
          txHashes.push(txHash);
          log("deploy", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${txHash}`);
        }
      } catch (liqErr) {
        // Liquidity add failed — position exists on-chain but is empty.
        // Mark it as closed so it doesn't count toward maxPositions or get managed.
        log("deploy_error", `Phase 2 (add liquidity) failed for ${posAddr.slice(0, 8)}: ${liqErr.message}`);
        recordClose(posAddr, "deploy failed (liquidity add error)");
        return {
          success: false,
          error: `Position created on-chain but liquidity add failed: ${liqErr.message}. Empty position ${posAddr.slice(0, 8)} marked closed.`,
          position: posAddr,
          txs: txHashes,
        };
      }
    } else {
      // ── Standard Path (<=69 bins) ─────────────────────────────────
      const tx = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { maxBinId, minBinId, strategyType },
        slippage: 1000, // 10% in bps
      });
      const txHash = await sendManagedTransaction(tx, [wallet, newPosition], "deploy standard");
      txHashes.push(txHash);
    }

    log("deploy", `SUCCESS — ${txHashes.length} tx(s): ${txHashes[0]}`);

    _positionsCacheAt = 0;
    const signal_snapshot = getAndClearStagedSignals(pool_address);
    trackPosition({
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      base_mint: pool.lbPair.tokenXMint.toBase58(),
      strategy: activeStrategy,
      strategy_type: activeStrategy === "bid_ask" ? "BidAsk" : (sol_split_pct === 100 ? "SpotOneSide" : "SpotTwoSide"),
      sol_split_pct: sol_split_pct ?? (activeStrategy === "bid_ask" ? 100 : null),
      bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
      bin_step: resolvedBinStep,
      volatility,
      fee_tvl_ratio,
      organic_score,
      amount_sol: finalAmountY,
      amount_x: finalAmountX,
      active_bin: activeBin.binId,
      initial_value_usd,
      study_avg_hold_hours,
      signal_snapshot,
    });

    return {
      success: true,
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
      strategy: activeStrategy,
      wide_range: isWideRange,
      amount_x: finalAmountX,
      amount_y: finalAmountY,
      txs: txHashes,
    };
  } catch (error) {
    log("deploy_error", error.message);
    return { success: false, error: error.message };
  }
}

const POSITIONS_CACHE_TTL = 5 * 60_000; // 5 minutes

let _positionsCache = null;
let _positionsCacheAt = 0;
let _positionsInflight = null; // deduplicates concurrent calls

// ─── Fetch DLMM PnL API for all positions in a pool ────────────
async function fetchDlmmPnlForPool(poolAddress, walletAddress) {
  const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("pnl_api", `HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}: ${body.slice(0, 120)}`);
      return {};
    }
    const data = await res.json();
    const positions = data.positions || data.data || [];
    if (positions.length === 0) {
      log("pnl_api", `No positions returned for pool ${poolAddress.slice(0, 8)} — keys: ${Object.keys(data).join(", ")}`);
    }
    const byAddress = {};
    for (const p of positions) {
      const addr = p.positionAddress || p.address || p.position;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("pnl_api", `Fetch error for pool ${poolAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

// ─── LP Agent PnL API (primary PnL source) ─────────────────────
import { getKey as getLpaKey } from "../lpagent-keys.js";
const LPAGENT_API = "https://api.lpagent.io/open-api/v1";

// Short-lived cache: single LP Agent call serves getMyPositions + getPositionPnl
let _lpaCache = null;     // Map<positionAddress, lpAgentData>
let _lpaCacheAt = 0;
const LPA_CACHE_TTL = 10_000; // 10 seconds

/**
 * Fetch ALL open positions from LP Agent for the given wallet.
 * Returns a Map keyed by position address → raw LP Agent position object.
 * Returns null on 429, fetch error, or no API keys configured (triggers Meteora fallback).
 */
async function fetchLpAgentOpenPositions(walletAddress) {
  // Return cached result if fresh
  if (_lpaCache && Date.now() - _lpaCacheAt < LPA_CACHE_TTL) {
    return _lpaCache;
  }

  const apiKey = await getLpaKey();
  if (!apiKey) return null;

  try {
    const res = await fetch(
      `${LPAGENT_API}/lp-positions/opening?owner=${walletAddress}`,
      { headers: { "x-api-key": apiKey } }
    );

    if (res.status === 429) {
      log("lpa_pnl", "LP Agent 429 rate limited — falling back to Meteora");
      return null;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("lpa_pnl", `LP Agent HTTP ${res.status}: ${body.slice(0, 120)}`);
      return null;
    }

    const json = await res.json();
    if (json.status !== "success" || !Array.isArray(json.data)) {
      log("lpa_pnl", `LP Agent unexpected response: status=${json.status}, keys=${Object.keys(json).join(",")}`);
      return null;
    }

    const map = new Map();
    for (const pos of json.data) {
      if (pos.position) map.set(pos.position, pos);
    }

    _lpaCache = map;
    _lpaCacheAt = Date.now();
    return map;
  } catch (e) {
    log("lpa_pnl", `LP Agent fetch error: ${e.message}`);
    return null;
  }
}

/** Map LP Agent strategy names → our internal terms */
function mapLpaStrategy(lpaType) {
  if (!lpaType) return null;
  const t = lpaType.toLowerCase();
  if (t.includes("bidask")) return "bid_ask";
  if (t.includes("spot")) return "spot";
  if (t.includes("curve")) return "curve";
  return lpaType; // pass through unknown types
}

/**
 * Normalize LP Agent position data → Meteora-compatible field names
 * so downstream enrichment code works identically regardless of source.
 */
function normalizeLpAgentPosition(lpa) {
  if (!lpa) return null;
  return {
    lowerBinId: lpa.tickLower,
    upperBinId: lpa.tickUpper,
    poolActiveBinId: null, // LP Agent doesn't provide active bin
    isOutOfRange: lpa.inRange === false,
    pnlUsd: lpa.pnl?.value ?? 0,
    pnlPctChange: lpa.pnl?.percent ?? 0,
    pnlSolPctChange: lpa.pnl?.percentNative ?? 0,
    createdAt: lpa.createdAt
      ? (typeof lpa.createdAt === "number" ? lpa.createdAt : new Date(lpa.createdAt).getTime() / 1000)
      : null,
    unrealizedPnl: {
      // LP Agent returns token amounts, not USD — convert using prices
      unclaimedFeeTokenX: { usd: parseFloat(lpa.unCollectedFee0 || 0) * (lpa.price0 || 0) },
      unclaimedFeeTokenY: { usd: parseFloat(lpa.unCollectedFee1 || 0) * (lpa.price1 || 0) },
      balances: lpa.currentValue ?? lpa.value ?? 0,
    },
    allTimeFees: {
      total: { usd: lpa.collectedFee ?? 0 },
    },
    allTimeDeposits: {
      total: { usd: lpa.inputValue ?? 0 },
      tokenX: { amount: lpa.current?.amount0 ?? 0 },
      tokenY: { amountSol: lpa.inputNative ?? 0 },
    },
    // Extra fields from LP Agent not in Meteora
    _lpa_inRange: lpa.inRange,
    _lpa_dpr: lpa.dpr,
    _lpa_ageHour: lpa.ageHour,
    _lpa_strategy: mapLpaStrategy(lpa.strategyType),
    _lpa_pairName: lpa.pairName,
    _lpa_source: "lpagent",
  };
}

// ─── Get Position PnL (LP Agent primary, Meteora fallback) ──────
export async function getPositionPnl({ pool_address, position_address }) {
  pool_address = normalizeMint(pool_address);
  position_address = normalizeMint(position_address);
  const walletAddress = getWallet().publicKey.toString();
  try {
    // LP Agent primary — uses cached result if recent (10s TTL)
    let p = null;
    let source = "meteora";
    try {
      const lpAgentPositions = await fetchLpAgentOpenPositions(walletAddress);
      const lpaRaw = lpAgentPositions?.get(position_address) || null;
      if (lpaRaw) {
        p = normalizeLpAgentPosition(lpaRaw);
        source = "lpagent";
      }
    } catch { /* fallback to Meteora */ }

    // Meteora fallback — per-pool call
    if (!p) {
      const byAddress = await fetchDlmmPnlForPool(pool_address, walletAddress);
      p = byAddress[position_address] || null;
      source = "meteora";
    }

    if (!p) return { error: "Position not found in PnL API" };

    const unclaimedUsd    = parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0);
    const currentValueUsd = parseFloat(p.unrealizedPnl?.balances || 0);
    const pnlUsdVal       = Math.round((p.pnlUsd ?? 0) * 100) / 100;
    const allTimeFeesUsd  = Math.round(parseFloat(p.allTimeFees?.total?.usd || 0) * 100) / 100;

    // Get accurate active bin from Meteora (LP Agent doesn't provide it)
    let activeBin = p.poolActiveBinId ?? null;
    if (activeBin == null) {
      try {
        const meteoraData = await fetchDlmmPnlForPool(pool_address, walletAddress);
        const anyPos = Object.values(meteoraData)[0];
        if (anyPos?.poolActiveBinId != null) activeBin = anyPos.poolActiveBinId;
      } catch { /* best-effort */ }
    }

    // Compute in-range from active bin (authoritative) rather than LP Agent's stale flag
    const lowerBin = p.lowerBinId ?? null;
    const upperBin = p.upperBinId ?? null;
    let inRange;
    if (activeBin != null && lowerBin != null && upperBin != null) {
      inRange = activeBin >= lowerBin && activeBin <= upperBin;
    } else {
      inRange = !p.isOutOfRange;
    }

    // SOL conversion
    let solPrice = 0;
    try { solPrice = (await getWalletBalances()).sol_price || 0; } catch { /* best-effort */ }
    const toSol = (usd) => solPrice > 0 ? Math.round((usd / solPrice) * 10000) / 10000 : null;

    return {
      pnl_usd:           pnlUsdVal,
      pnl_sol:           toSol(pnlUsdVal),
      pnl_pct:           Math.round(((config.management.pnlUnit === "sol" ? p.pnlSolPctChange : p.pnlPctChange) ?? 0) * 100) / 100,
      current_value_usd: Math.round(currentValueUsd * 100) / 100,
      current_value_sol: toSol(currentValueUsd),
      unclaimed_fee_usd: Math.round(unclaimedUsd * 100) / 100,
      unclaimed_fee_sol: toSol(unclaimedUsd),
      all_time_fees_usd: allTimeFeesUsd,
      all_time_fees_sol: toSol(allTimeFeesUsd),
      sol_price:   solPrice,
      pnl_unit:    config.management.pnlUnit,
      in_range:    inRange,
      lower_bin:   lowerBin,
      upper_bin:   upperBin,
      active_bin:  activeBin,
      age_minutes: p.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
      _source:     source,
    };
  } catch (error) {
    log("pnl_error", error.message);
    return { error: error.message };
  }
}

// ─── Get My Positions ──────────────────────────────────────────
export async function getMyPositions({ force = false } = {}) {
  if (!force && _positionsCache && Date.now() - _positionsCacheAt < POSITIONS_CACHE_TTL) {
    return _positionsCache;
  }
  // If a scan is already in progress, wait for it instead of starting another
  if (_positionsInflight) return _positionsInflight;

  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  _positionsInflight = (async () => { try {
    log("positions", "Scanning positions via getProgramAccounts...");
    const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
    const walletPubkey = new PublicKey(walletAddress);

    // Owner field sits at offset 40 (8 discriminator + 32 lb_pair)
    const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 40, bytes: walletPubkey.toBase58() } }],
    });

    log("positions", `Found ${accounts.length} position account(s)`);

    // Collect raw (pool, position) pairs
    const raw = [];
    for (const acc of accounts) {
      const positionAddress = acc.pubkey.toBase58();
      const lbPairKey = new PublicKey(acc.account.data.slice(8, 40)).toBase58();
      // Pair name: use tracked state pool_name if available
      const tracked = getTrackedPosition(positionAddress);
      const pair = tracked?.pool_name || lbPairKey.slice(0, 8);
      raw.push({
        position: positionAddress,
        pool: lbPairKey,
        pair,
        base_mint: null, // enriched from PnL API below
        lower_bin: null,
        upper_bin: null,
      });
    }

    // Enrich with PnL data — LP Agent primary, Meteora fallback
    const uniquePools = [...new Set(raw.map((p) => p.pool))];
    // Check if any positions are untracked (will need LP Agent data for auto-adopt)
    const hasUntracked = raw.some((r) => !getTrackedPosition(r.position));

    // Try LP Agent first (single call for all positions)
    let lpAgentPositions = null;
    try {
      lpAgentPositions = await fetchLpAgentOpenPositions(walletAddress);
    } catch { /* fallback to Meteora */ }

    // Fallback: if LP Agent failed, use Meteora PnL API per pool
    let pnlByPool = {};
    if (!lpAgentPositions) {
      const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, walletAddress)));
      uniquePools.forEach((pool, i) => { pnlByPool[pool] = pnlMaps[i]; });
    }

    // Fire remaining independent network calls in parallel:
    // - SOL price
    // - LP Agent historical (only if untracked positions exist)
    const [walletBalResult, lpAgentHistMap] = await Promise.all([
      getWalletBalances().catch(() => ({ sol_price: 0 })),
      hasUntracked
        ? import("./lp-overview.js").then((m) => m.fetchHistoricalPositionMap()).catch(() => new Map())
        : Promise.resolve(new Map()),
    ]);

    log("positions", lpAgentPositions ? `LP Agent: ${lpAgentPositions.size} positions` : "LP Agent unavailable, using Meteora fallback");

    // When using LP Agent, fetch Meteora PnL API just for OOR/active bin data.
    // LP Agent's inRange can be stale and it doesn't provide poolActiveBinId.
    // Meteora datapi has no rate limit and returns accurate on-chain state.
    let meteoraOorData = {};
    let meteoraActiveBinByPool = {};  // pool → activeBinId (same for all positions in a pool)
    if (lpAgentPositions) {
      const oorMaps = await Promise.all(uniquePools.map(pool => fetchDlmmPnlForPool(pool, walletAddress)));
      uniquePools.forEach((pool, i) => {
        meteoraOorData[pool] = oorMaps[i];
        // Extract poolActiveBinId from ANY position in this pool — it's pool-level, not position-level
        const anyPos = Object.values(oorMaps[i] || {})[0];
        if (anyPos?.poolActiveBinId != null) {
          meteoraActiveBinByPool[pool] = anyPos.poolActiveBinId;
        }
      });
    }

    // SOL price for conversion (one fetch, shared across all positions)
    const solPrice = walletBalResult.sol_price || 0;
    const toSol = (usd) => solPrice > 0 ? Math.round((usd / solPrice) * 10000) / 10000 : null;

    const positions = await Promise.all(raw.map(async (r) => {
      // LP Agent primary, Meteora fallback per position
      const p_lpa = lpAgentPositions?.get(r.position) || null;
      // If LP Agent has this position, use it; otherwise fall back to Meteora for this specific position
      const p_met = !p_lpa ? (pnlByPool[r.pool]?.[r.position] || null) : null;
      // If LP Agent was available but doesn't have this position, try Meteora for just this pool
      let p_met_fallback = null;
      if (lpAgentPositions && !p_lpa && !p_met) {
        try {
          const poolPnl = await fetchDlmmPnlForPool(r.pool, walletAddress);
          p_met_fallback = poolPnl[r.position] || null;
        } catch { /* no PnL data available */ }
      }
      const p = p_lpa ? normalizeLpAgentPosition(p_lpa) : (p_met || p_met_fallback);

      const lowerBin  = p?.lowerBinId      ?? r.lower_bin;
      const upperBin  = p?.upperBinId      ?? r.upper_bin;
      // Use Meteora active bin (accurate, no rate limit) over LP Agent's stale data.
      // First try exact position match, then fall back to pool-level active bin
      // (Meteora sometimes indexes positions under a different address).
      const meteoraPos = meteoraOorData[r.pool]?.[r.position];
      const activeBin = meteoraPos?.poolActiveBinId
        ?? meteoraActiveBinByPool[r.pool]
        ?? p?.poolActiveBinId
        ?? null;

      // Compute in-range from active bin vs position bin range (authoritative)
      let inRange;
      if (activeBin != null && lowerBin != null && upperBin != null) {
        inRange = activeBin >= lowerBin && activeBin <= upperBin;
      } else if (meteoraPos) {
        inRange = !meteoraPos.isOutOfRange;
      } else {
        inRange = p ? !p.isOutOfRange : true;
      }
      // Compute OOR direction: upside = price pumped above range, downside = price dropped below
      let oorDirection = null;
      if (!inRange && activeBin != null && upperBin != null && lowerBin != null) {
        oorDirection = activeBin > upperBin ? "upside" : "downside";
      }
      if (inRange) markInRange(r.position);
      else markOutOfRange(r.position, oorDirection);

      const unclaimedFees = p ? (parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) : 0;
      const totalValue    = p ? parseFloat(p.unrealizedPnl?.balances || 0) : 0;
      const collectedFees = p ? parseFloat(p.allTimeFees?.total?.usd || 0) : 0;
      const pnlUsd        = p?.pnlUsd       ?? 0;
      const pnlPct        = (config.management.pnlUnit === "sol" ? p?.pnlSolPctChange : p?.pnlPctChange) ?? 0;

      const tracked = getTrackedPosition(r.position);

      // Auto-adopt untracked positions (manually opened or from external tools)
      // Skip empty position accounts (0 value) — these are ghost accounts from
      // failed deploys or the gap between createPosition and addLiquidity in wide-range deploys
      const positionValue = parseFloat(p?.unrealizedPnl?.balances || 0)
        + parseFloat(p?.allTimeDeposits?.total?.usd || 0);
      if (!tracked && p && positionValue > 0.10) {
        try {
          const { getPoolDetail } = await import("./screening.js");
          const poolDetail = await getPoolDetail({ pool_address: r.pool, timeframe: "1h" }).catch(() => null);

          // Use pre-fetched LP Agent data (single API call shared across all positions)
          const lpAgentData = lpAgentHistMap.get(r.position) || null;

          // Strategy: LP Agent PnL > LP Agent historical > bin distribution inference > deposit-based guess
          let inferredStrategy = p._lpa_strategy || lpAgentData?.strategy || "bid_ask";
          if (!p._lpa_strategy && !lpAgentData?.strategy) {
            try {
              const pool = await getPool(r.pool);
              const posData = await pool.getPosition(new PublicKey(r.position));
              const binData = posData.positionData?.positionBinData || [];
              const yAmounts = binData.map(b => Number(b.positionYAmount || 0)).filter(a => a > 0);
              if (yAmounts.length > 1) {
                const ratio = Math.max(...yAmounts) / (Math.min(...yAmounts) || 1);
                inferredStrategy = ratio < 2 ? "spot" : "bid_ask";
              }
            } catch {
              const depositedX = parseFloat(p.allTimeDeposits?.tokenX?.amount || 0);
              inferredStrategy = depositedX === 0 ? "bid_ask" : "spot";
            }
          }

          // Initial value: LP Agent > Meteora PnL API
          const depositSol = lpAgentData?.initial_value_sol || parseFloat(p.allTimeDeposits?.tokenY?.amountSol || 0);
          const depositUsd = lpAgentData?.initial_value_usd || parseFloat(p.allTimeDeposits?.total?.usd || 0);

          trackPosition({
            position: r.position,
            pool: r.pool,
            pool_name: poolDetail?.name || r.pair || r.pool.slice(0, 8),
            base_mint: r.base_mint || poolDetail?.base?.mint || null,
            strategy: inferredStrategy,
            bin_range: {
              min: p.lowerBinId,
              max: p.upperBinId,
              bins_below: p.poolActiveBinId != null ? p.poolActiveBinId - p.lowerBinId : null,
              bins_above: p.poolActiveBinId != null ? p.upperBinId - p.poolActiveBinId : null,
            },
            amount_sol: depositSol,
            amount_x: parseFloat(p.allTimeDeposits?.tokenX?.amount || 0),
            active_bin_at_deploy: p.poolActiveBinId ?? null,
            bin_step: poolDetail?.bin_step || null,
            volatility: poolDetail?.volatility || null,
            fee_tvl_ratio: poolDetail?.fee_active_tvl_ratio || null,
            initial_fee_tvl_24h: poolDetail?.fee_active_tvl_ratio || null,
            organic_score: poolDetail?.organic_score || null,
            initial_value_usd: depositUsd,
            deployed_at: p.createdAt ? new Date(p.createdAt * 1000).toISOString() : new Date().toISOString(),
            adopted: true,
          });

          const source = p._lpa_strategy ? "LP Agent PnL" : lpAgentData?.strategy ? "LP Agent hist" : "inferred";
          log("adopt", `Auto-adopted position ${r.position.slice(0, 8)} in ${poolDetail?.name || r.pool.slice(0, 8)} (${inferredStrategy} via ${source}, ${depositSol.toFixed(2)} SOL, $${depositUsd.toFixed(2)})`);
        } catch (e) {
          log("adopt_warn", `Failed to auto-adopt ${r.position.slice(0, 8)}: ${e.message}`);
        }
      }

      // Re-read tracked state (may have just been created by auto-adoption)
      const trackedFinal = tracked || getTrackedPosition(r.position);

      const ageFromPnlApi = p?.createdAt
        ? Math.floor((Date.now() - p.createdAt * 1000) / 60000)
        : null;
      const ageFromState = trackedFinal?.deployed_at
        ? Math.floor((Date.now() - new Date(trackedFinal.deployed_at).getTime()) / 60000)
        : null;
      const ageMinutes = Math.max(ageFromPnlApi ?? 0, ageFromState ?? 0) || null;

      const pnlUsdRounded = Math.round(pnlUsd * 100) / 100;
      const unclaimedRounded = Math.round(unclaimedFees * 100) / 100;
      const totalValRounded = Math.round(totalValue * 100) / 100;
      const collectedRounded = Math.round(collectedFees * 100) / 100;

      // Composition: current token vs SOL amounts and USD split from LP Agent
      let composition = null;
      const lpaRaw = lpAgentPositions?.get(r.position);
      if (lpaRaw?.current) {
        const tokenAmt = lpaRaw.current.amount0Adjusted ?? 0;
        const solAmt = lpaRaw.current.amount1Adjusted ?? 0;
        const tokenUsd = tokenAmt * (lpaRaw.price0 || 0);
        const solUsd = solAmt * (lpaRaw.price1 || 0);
        const totalUsd = tokenUsd + solUsd;
        const solPct = totalUsd > 0 ? Math.round((solUsd / totalUsd) * 100) : 100;
        composition = {
          token_amount: Math.round(tokenAmt * 100) / 100,
          sol_amount: Math.round(solAmt * 10000) / 10000,
          token_usd: Math.round(tokenUsd * 100) / 100,
          sol_usd: Math.round(solUsd * 100) / 100,
          sol_pct: solPct,
          token_pct: 100 - solPct,
        };
      }

      return {
        position: r.position,
        pool: r.pool,
        pair: r.pair,
        base_mint: r.base_mint,
        strategy: trackedFinal?.strategy || p?._lpa_strategy || "bid_ask",
        strategy_type: p?._lpa_strategy || trackedFinal?.strategy_type || null,
        sol_split_pct: trackedFinal?.sol_split_pct ?? composition?.sol_pct ?? null,
        bin_step: trackedFinal?.bin_step || null,
        volatility: trackedFinal?.volatility || null,
        lower_bin: lowerBin,
        upper_bin: upperBin,
        active_bin: activeBin,
        in_range: inRange,
        oor_direction: oorDirection,
        composition,
        unclaimed_fees_usd: unclaimedRounded,
        unclaimed_fees_sol: toSol(unclaimedRounded),
        total_value_usd: totalValRounded,
        total_value_sol: toSol(totalValRounded),
        collected_fees_usd: collectedRounded,
        collected_fees_sol: toSol(collectedRounded),
        pnl_usd: pnlUsdRounded,
        pnl_sol: toSol(pnlUsdRounded),
        pnl_pct: Math.round(pnlPct * 100) / 100,
        sol_price: solPrice,
        pnl_unit: config.management.pnlUnit,
        age_minutes: ageMinutes,
        minutes_out_of_range: minutesOutOfRange(r.position),
        study_avg_hold_hours: trackedFinal?.study_avg_hold_hours || null,
      };
    }));

    const result = { wallet: walletAddress, total_positions: positions.length, positions };
    await syncOpenPositions(positions.map((p) => p.position));
    _positionsCache = result;
    _positionsCacheAt = Date.now();
    return result;
  } catch (error) {
    log("positions_error", `SDK scan failed: ${error.stack || error.message}`);
    return { wallet: walletAddress, total_positions: 0, positions: [], error: error.message };
  } finally {
    _positionsInflight = null;
  }
  })();
  return _positionsInflight;
}

// ─── Get Positions for Any Wallet ─────────────────────────────
export async function getWalletPositions({ wallet_address }) {
  try {
    const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

    const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 40, bytes: new PublicKey(wallet_address).toBase58() } }],
    });

    if (accounts.length === 0) {
      return { wallet: wallet_address, total_positions: 0, positions: [] };
    }

    const raw = accounts.map((acc) => ({
      position: acc.pubkey.toBase58(),
      pool: new PublicKey(acc.account.data.slice(8, 40)).toBase58(),
    }));

    // Enrich with PnL API
    const uniquePools = [...new Set(raw.map((r) => r.pool))];
    const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, wallet_address)));
    const pnlByPool = {};
    uniquePools.forEach((pool, i) => { pnlByPool[pool] = pnlMaps[i]; });

    const positions = raw.map((r) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;

      return {
        position:           r.position,
        pool:               r.pool,
        lower_bin:          p?.lowerBinId      ?? null,
        upper_bin:          p?.upperBinId      ?? null,
        active_bin:         p?.poolActiveBinId ?? null,
        in_range:           p ? !p.isOutOfRange : null,
        unclaimed_fees_usd: Math.round((p ? (parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) : 0) * 100) / 100,
        total_value_usd:    Math.round((p ? parseFloat(p.unrealizedPnl?.balances || 0) : 0) * 100) / 100,
        pnl_usd:            Math.round((p?.pnlUsd ?? 0) * 100) / 100,
        pnl_pct:            Math.round(((config.management.pnlUnit === "sol" ? p?.pnlSolPctChange : p?.pnlPctChange) ?? 0) * 100) / 100,
        age_minutes:        p?.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
      };
    });

    return { wallet: wallet_address, total_positions: positions.length, positions };
  } catch (error) {
    log("wallet_positions_error", error.message);
    return { wallet: wallet_address, total_positions: 0, positions: [], error: error.message };
  }
}

// ─── Search Pools by Query ─────────────────────────────────────
export async function searchPools({ query, limit = 10 }) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool search API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const pools = (Array.isArray(data) ? data : data.data || []).slice(0, limit);
  return {
    query,
    total: pools.length,
    pools: pools.map((p) => ({
      pool: p.address || p.pool_address,
      name: p.name,
      bin_step: p.bin_step ?? p.dlmm_params?.bin_step,
      fee_pct: p.base_fee_percentage ?? p.fee_pct,
      tvl: p.liquidity,
      volume_24h: p.trade_volume_24h,
      token_x: { symbol: p.mint_x_symbol ?? p.token_x?.symbol, mint: p.mint_x ?? p.token_x?.address },
      token_y: { symbol: p.mint_y_symbol ?? p.token_y?.symbol, mint: p.mint_y ?? p.token_y?.address },
    })),
  };
}

// ─── Claim Fees ────────────────────────────────────────────────
export async function claimFees({ position_address }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_claim: position_address, message: "DRY RUN — no transaction sent" };
  }

  try {
    log("claim", `Claiming fees for position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionPubKey = new PublicKey(position_address);
    const positionData = await pool.getPosition(positionPubKey);

    const txs = await pool.claimSwapFee({
      owner: wallet.publicKey,
      position: positionData,
    });

    const txArr = Array.isArray(txs) ? txs : [txs];
    const txHashes = [];
    for (const tx of txArr) {
      const txHash = await sendManagedTransaction(tx, [wallet], "claim fees");
      txHashes.push(txHash);
    }
    const txHash = txHashes[0];
    log("claim", `SUCCESS tx: ${txHash}`);
    _positionsCacheAt = 0; // invalidate cache after claim
    recordClaim(position_address);

    return { success: true, position: position_address, tx: txHash };
  } catch (error) {
    log("claim_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Close Position ────────────────────────────────────────────
export async function closePosition({ position_address, _pnlOverride = null }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: position_address, message: "DRY RUN — no transaction sent" };
  }

  if (closeInflight.has(position_address)) {
    return closeInflight.get(position_address);
  }

  const closePromise = (async () => {
    try {
    log("close", `Closing position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionPubKey = new PublicKey(position_address);
    const positionData = await pool.getPosition(positionPubKey);

    // ─── Snapshot PnL BEFORE closing (position is still on-chain) ───
    // If PnL watcher provided an override (the value that triggered the close), trust it
    // over the cache which may have been refreshed with stale/wrong API data
    let pnlUsd = _pnlOverride?.pnl_usd ?? 0;
    let pnlPct = _pnlOverride?.pnl_pct ?? 0;
    let finalValueUsd = _pnlOverride?.total_value_usd ?? 0;
    let feesUsd = 0;
    const trackedPre = getTrackedPosition(position_address);
    feesUsd = trackedPre?.total_fees_claimed_usd || 0;

    if (_pnlOverride) {
      // PnL watcher already gave us accurate numbers at the moment it decided to close
      feesUsd = (_pnlOverride.collected_fees_usd || 0) + (_pnlOverride.unclaimed_fees_usd || 0) || feesUsd;
      log("close", `Using PnL override from watcher: ${pnlPct}% ($${pnlUsd})`);
    } else {
      // No override — snapshot from cache or fresh API
      const cachedPos = _positionsCache?.positions?.find(p => p.position === position_address);
      if (cachedPos) {
        pnlUsd        = cachedPos.pnl_usd   ?? 0;
        pnlPct        = cachedPos.pnl_pct   ?? 0;
        finalValueUsd = cachedPos.total_value_usd ?? 0;
        feesUsd       = (cachedPos.collected_fees_usd || 0) + (cachedPos.unclaimed_fees_usd || 0);
      } else {
      // No cache — fetch fresh from API while position is still open
      try {
        const freshPnl = await getPositionPnl({ pool_address: poolAddress, position_address });
        if (freshPnl && !freshPnl.error) {
          pnlUsd        = freshPnl.pnl_usd   ?? 0;
          pnlPct        = freshPnl.pnl_pct   ?? 0;
          finalValueUsd = freshPnl.current_value_usd ?? 0;
          feesUsd       = (freshPnl.all_time_fees_usd || 0) + (freshPnl.unclaimed_fee_usd || 0);
        }
      } catch (e) {
        log("close_warn", `Could not snapshot PnL before close: ${e.message}`);
      }
    }
    } // end of !_pnlOverride

    const txHashes = [];

    // ─── Step 1: Claim Fees (to clear account state) ───────────
    try {
      log("close", `Step 1: Claiming fees for ${position_address}`);
      const claimTxs = await pool.claimSwapFee({
        owner: wallet.publicKey,
        position: positionData,
      });
      for (const tx of Array.isArray(claimTxs) ? claimTxs : [claimTxs]) {
        const claimHash = await sendManagedTransaction(tx, [wallet], "close claim fees");
        txHashes.push(claimHash);
      }
      log("close", `Step 1 OK: ${txHashes.join(", ")}`);
    } catch (e) {
      log("close_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
    }

    // ─── Step 2: Remove Liquidity & Close ──────────────────────
    log("close", `Step 2: Removing liquidity and closing account`);
    try {
      const closeTx = await pool.removeLiquidity({
        user: wallet.publicKey,
        position: positionPubKey,
        fromBinId: -887272,
        toBinId: 887272,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });

      for (const tx of Array.isArray(closeTx) ? closeTx : [closeTx]) {
        const txHash = await sendManagedTransaction(tx, [wallet], "close remove liquidity");
        txHashes.push(txHash);
      }
    } catch (removeErr) {
      // Zombie position: liquidity was already removed in a previous attempt
      // but the account wasn't closed. The SDK crashes reading binId from
      // empty bin arrays. Fall back to closing the empty account directly.
      const isBinIdErr = removeErr.message?.includes("reading 'binId'")
        || removeErr.message?.includes("Cannot read properties of undefined");
      if (!isBinIdErr) throw removeErr;

      log("close", `Position appears empty (zombie) — falling back to closePositionIfEmpty`);
      const closeTx = await pool.closePositionIfEmpty({
        owner: wallet.publicKey,
        position: positionData,
      });
      const txHash = await sendManagedTransaction(closeTx, [wallet], "close zombie position");
      txHashes.push(txHash);
    }
    log("close", `SUCCESS txs: ${txHashes.join(", ")}`);

    // Record performance for learning
    const tracked = getTrackedPosition(position_address);
    const oorDir = tracked?.oor_direction || null;
    const closeReason = oorDir ? `agent decision (OOR ${oorDir})` : "agent decision";
    recordClose(position_address, closeReason);
    if (tracked) {
      const deployedAt = new Date(tracked.deployed_at).getTime();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);

      let minutesOOR = 0;
      if (tracked.out_of_range_since) {
        minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
      }

      _positionsCacheAt = 0; // invalidate cache
      // Use tracked initial value; if missing (legacy positions), estimate from
      // final value so pnl_pct isn't forced to 0
      let initialUsd = tracked.initial_value_usd || 0;
      if (!initialUsd && tracked.amount_sol > 0 && finalValueUsd > 0) {
        initialUsd = finalValueUsd;
        log("close", `initial_value_usd missing for ${position_address}, using finalValueUsd ($${finalValueUsd}) as fallback`);
      }

      await recordPerformance({
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolAddress.slice(0, 8),
        strategy: tracked.strategy,
        strategy_type: tracked.strategy_type || null,
        sol_split_pct: tracked.sol_split_pct ?? null,
        bin_range: tracked.bin_range,
        bin_step: tracked.bin_step || null,
        volatility: tracked.volatility || null,
        fee_tvl_ratio: tracked.fee_tvl_ratio || null,
        organic_score: tracked.organic_score || null,
        amount_sol: tracked.amount_sol,
        fees_earned_usd: feesUsd,
        final_value_usd: finalValueUsd,
        initial_value_usd: initialUsd,
        actual_pnl_usd: pnlUsd,
        actual_pnl_pct: pnlPct,
        minutes_in_range: minutesHeld - minutesOOR,
        minutes_held: minutesHeld,
        close_reason: closeReason,
        deployed_at: tracked.deployed_at,
        signal_snapshot: tracked.signal_snapshot || null,
      });

      // Clean up transient nugget entries
      try {
        const { forgetPositionSnapshot } = await import("../memory.js");
        forgetPositionSnapshot(tracked);
      } catch { /* best-effort */ }

      // ─── Hard rule: always swap base token back to SOL after close ───
      try {
        const baseMint = tracked.base_mint;
        const SOL = "So11111111111111111111111111111111111111112";
        if (baseMint && baseMint !== SOL) {
          const walletBals = await getWalletBalances();
          const baseToken = walletBals.tokens?.find((t) => t.mint === baseMint);
          if (baseToken && baseToken.balance > 0 && (baseToken.usd ?? 0) >= 0.10) {
            log("close", `Auto-swapping ${baseToken.balance} ${baseToken.symbol || baseMint.slice(0, 8)} -> SOL (worth $${baseToken.usd})`);
            const swapResult = await swapToken({
              input_mint: baseMint,
              output_mint: SOL,
              amount: baseToken.balance,
            });
            if (swapResult?.success) {
              log("close", `Post-close swap OK: tx ${swapResult.tx}`);
              txHashes.push(swapResult.tx);
            } else {
              log("close_warn", `Post-close swap failed: ${swapResult?.error || "unknown"}`);
            }
          }
        }
      } catch (swapErr) {
        log("close_warn", `Post-close swap error: ${swapErr.message}`);
      }

      return { success: true, position: position_address, pool: poolAddress, txs: txHashes, pnl_usd: pnlUsd, pnl_pct: pnlPct };
    }

    return { success: true, position: position_address, pool: poolAddress, txs: txHashes };
    } catch (error) {
      log("close_error", error.message);
      return { success: false, error: error.message };
    } finally {
      closeInflight.delete(position_address);
    }
  })();

  closeInflight.set(position_address, closePromise);
  return closePromise;
}

// ─── Helpers ──────────────────────────────────────────────────
async function lookupPoolForPosition(position_address, walletAddress) {
  // Check state registry first (fast path)
  const tracked = getTrackedPosition(position_address);
  if (tracked?.pool) return tracked.pool;

  // Check in-memory positions cache
  const cached = _positionsCache?.positions?.find((p) => p.position === position_address);
  if (cached?.pool) return cached.pool;

  // SDK scan (last resort)
  const { DLMM } = await getDLMM();
  const allPositions = await DLMM.getAllLbPairPositionsByUser(
    getConnection(),
    new PublicKey(walletAddress)
  );

  for (const [lbPairKey, positionData] of Object.entries(allPositions)) {
    for (const pos of positionData.lbPairPositionsData || []) {
      if (pos.publicKey.toString() === position_address) return lbPairKey;
    }
  }

  throw new Error(`Position ${position_address} not found in open positions`);
}
