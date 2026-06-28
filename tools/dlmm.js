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
import { fetchGmgnPriceInfo } from "./gmgn.js";

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

// ─── Decimal-safe amount helpers (module scope; shared by deploy + MM) ──
// Decimal-safe UI -> raw integer BN (string-based; avoids JS float precision
// loss that Math.floor(amount * 10**decimals) suffers for some token amounts).
function uiToRawBN(amount, decimals) {
  if (amount == null || !Number.isFinite(Number(amount))) return new BN(0);
  let s = typeof amount === "string" ? amount.trim() : Number(amount).toFixed(decimals);
  if (/[eE]/.test(s)) s = Number(s).toFixed(decimals); // expand scientific notation
  if (s.startsWith("-")) return new BN(0);
  const [whole = "0", frac = ""] = s.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const raw = ((whole || "0") + fracPadded).replace(/^0+(?=\d)/, "");
  return new BN(raw === "" ? "0" : raw);
}

// Resolve on-chain mint decimals (returns null if unreadable so callers can refuse to size).
async function getMintDecimals(mint) {
  const info = await getConnection().getParsedAccountInfo(new PublicKey(mint));
  return info.value?.data?.parsed?.info?.decimals ?? null;
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

  const estimated = await estimatePriorityFeeMicroLamports(tx, feePayer, label);
  // Fall back to a sane default rather than sending with no priority fee.
  const microLamports = estimated || (config.management.fallbackPriorityFeeMicroLamports || 50_000);

  // Raise the compute-unit limit: position/bin-array init and extended
  // add-liquidity are compute-heavy and exceed the 200k default, failing AFTER
  // fees are paid. Skip if the SDK tx already set its own CU limit (discriminator 2).
  const hasCuLimit = tx.instructions.some(
    (ix) => ix.programId?.equals?.(ComputeBudgetProgram.programId) && ix.data?.[0] === 2,
  );
  if (!hasCuLimit) {
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({ units: config.management.computeUnitLimit || 400_000 })
    );
  }
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
  let lastSig = null; // signature of the most recent submit attempt, if obtainable

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) {
        // Before resubmitting on a prior expiry error, check whether the previous
        // submission actually landed. Resubmitting a non-idempotent tx that already
        // confirmed would double-execute it (e.g. double remove/claim).
        if (lastSig) {
          try {
            const { value } = await getConnection().getSignatureStatuses([lastSig]);
            const status = value?.[0];
            if (status && !status.err &&
                (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
              log("tx_retry", `${label}: prior tx ${lastSig} already landed (${status.confirmationStatus}); not resubmitting`);
              return lastSig;
            }
          } catch (statusErr) {
            // If we can't read the status, fall through to resubmit (prior behavior).
            log("tx_retry", `${label}: could not verify prior tx status (${statusErr?.message || statusErr}); resubmitting`);
          }
        } else {
          // sendAndConfirmTransaction did not surface a signature on throw, so we
          // cannot confirm whether the prior tx landed. Add a short delay before
          // resubmit to reduce (not eliminate) the double-submit window.
          // LIMITATION: a silently-landed prior tx could still be resubmitted here.
          await new Promise((r) => setTimeout(r, 1500));
        }

        const { blockhash } = await getConnection().getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer ??= feePayer;
        lastSig = null;
      }

      // Capture the signature for this attempt so a later expiry retry can check
      // whether it landed before resubmitting. signTransaction is idempotent and
      // does not broadcast; it just lets us derive the signature up-front.
      try {
        tx.partialSign?.(...signers);
        const sig = tx.signature ? bs58.encode(tx.signature) : null;
        if (sig) lastSig = sig;
      } catch { /* best-effort sig capture; not fatal */ }

      return await sendAndConfirmTransaction(getConnection(), tx, signers, {
        skipPreflight: true,
        preflightCommitment: "confirmed",
        commitment: "confirmed",
        maxRetries: 3,
      });
    } catch (error) {
      lastError = error;
      const message = error?.message || String(error);
      // Some errors carry the signature of the submitted tx; capture it if present.
      if (!lastSig && typeof error?.signature === "string") lastSig = error.signature;
      const sigMatch = !lastSig && /signature\s+([1-9A-HJ-NP-Za-km-z]{32,})/i.exec(message);
      if (sigMatch) lastSig = sigMatch[1];
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

// .unref() so this housekeeping timer never keeps the process (or a test run)
// alive on its own — it only fires while other work holds the event loop open.
setInterval(() => poolCache.clear(), 5 * 60 * 1000).unref();

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
  let activeStrategy = strategy || config.strategy.strategy;
  let resolvedBinStep = bin_step;
  let totalSolAmount = amount_y ?? amount_sol ?? 0;

  // ─── Deploy amount handling ───
  // Real-funds safety: do NOT silently bump an explicitly-provided amount up to
  // the wallet-scaled amount. Only DEFAULT the amount when the caller omitted it
  // (amount_y, amount_sol, and amount_x all missing/null). When the caller did
  // pass an explicit amount, respect it exactly; the only enforced floor is the
  // existing 0.1 SOL hard minimum, which we apply by REJECTING (never raising).
  const callerProvidedAmount = (amount_y != null) || (amount_sol != null) || (amount_x != null);
  try {
    const { computeDeployAmount } = await import("../config.js");
    const { getWalletBalances } = await import("./wallet.js");
    const bal = await getWalletBalances();
    if (!callerProvidedAmount && bal?.sol > 0) {
      // Amount missing entirely — default it from wallet balance + positionSizePct.
      const computed = computeDeployAmount(bal.sol);
      log("deploy", `Amount not provided; defaulting to ${computed} SOL (computed from ${bal.sol} SOL wallet)`);
      totalSolAmount = computed;
      amount_y = computed;
    }
  } catch { /* best-effort — use what the model passed */ }

  // Hard floor: reject (do not silently raise) explicit amounts below 0.1 SOL.
  if (callerProvidedAmount && totalSolAmount > 0 && totalSolAmount < 0.1) {
    throw new Error(`Deploy amount ${totalSolAmount} SOL is below the 0.1 SOL minimum. Pass at least 0.1 SOL or omit the amount to use the wallet-scaled default.`);
  }

  if (!["bid_ask", "spot"].includes(activeStrategy)) {
    throw new Error("Only 'bid_ask' or 'spot' strategies are allowed.");
  }

  // Evil Panda is a named policy mapped onto the executor's supported
  // single-sided SOL spot primitive. Enforce its entry criteria here so the
  // model cannot accidentally bypass the strategy with a weaker prompt-only check.
  if (config.strategy.activeStrategy === "evil_panda") {
    const ep = config.strategy.evilPanda || {};
    activeStrategy = "spot";
    price_range_pct = Math.max(price_range_pct || 0, ep.priceRangePct || 80);
    bins_above = 0;

    if ((amount_x ?? 0) > 0) {
      return { success: false, error: "Evil Panda requires single-sided SOL spot: do not pass amount_x." };
    }
    if (sol_split_pct != null && sol_split_pct < 100) {
      return { success: false, error: "Evil Panda requires single-sided SOL spot: omit sol_split_pct or use 100." };
    }

    let resolvedMint = base_mint;
    if (!resolvedMint) {
      try {
        const pool = await getPool(pool_address);
        resolvedMint = pool.lbPair.tokenXMint.toBase58();
      } catch {
        resolvedMint = null;
      }
    }
    if (!resolvedMint) {
      return { success: false, error: "Evil Panda entry blocked: base_mint is required to verify token-level GMGN data." };
    }

    const gmgn = await fetchGmgnPriceInfo(resolvedMint);
    const tokenVolume24h = gmgn?.volume_24h ?? 0;
    const tokenMcap = gmgn?.market_cap ?? 0;
    const tokenAgeHours = gmgn?.token_age_hours ?? null;
    const indicators = gmgn?.candles || null;
    const supertrendOk = !!indicators?.evil_panda_entry_ok;

    const failures = [];
    if (tokenVolume24h < (ep.minTokenVolume24h ?? 750_000)) {
      failures.push(`token volume24H $${Math.round(tokenVolume24h)} < $${ep.minTokenVolume24h ?? 750_000}`);
    }
    if (tokenMcap < (ep.minMcap ?? 200_000)) {
      failures.push(`token mcap $${Math.round(tokenMcap)} < $${ep.minMcap ?? 200_000}`);
    }
    // Token-age window (config.screening.minTokenAgeHours / maxTokenAgeHours; null = no bound)
    const minAge = config.screening.minTokenAgeHours;
    const maxAge = config.screening.maxTokenAgeHours;
    if (minAge != null && tokenAgeHours != null && tokenAgeHours < minAge) {
      failures.push(`token age ${tokenAgeHours}h < ${minAge}h min`);
    }
    if (maxAge != null && tokenAgeHours != null && tokenAgeHours > maxAge) {
      failures.push(`token age ${tokenAgeHours}h > ${maxAge}h max`);
    }
    if (!supertrendOk) {
      failures.push(`5m Supertrend not green/above price (direction=${indicators?.supertrend_direction ?? "unknown"})`);
    }

    if (failures.length > 0) {
      return {
        success: false,
        error: `Evil Panda entry blocked: ${failures.join("; ")}.`,
        gmgn: {
          token_volume_24h: tokenVolume24h,
          token_mcap: tokenMcap,
          supertrend: indicators?.supertrend || null,
          rsi_2: indicators?.rsi_2 ?? null,
        },
      };
    }
    log("deploy", `Evil Panda entry approved: spot single-sided, range=${price_range_pct}%, volume24H=$${Math.round(tokenVolume24h)}, mcap=$${Math.round(tokenMcap)}, supertrend=${indicators.supertrend_direction}`);
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

  // ─── Hard guard: validate actual range % — always check, even when price_range_pct is set ───
  // Models sometimes pass bins_below AND price_range_pct but the bins don't match the %.
  // Always verify the actual range and correct if too narrow.
  if (bins_below > 0 && resolvedBinStep) {
    const stepPct = resolvedBinStep / 10000;
    const actualRangePct = (1 - Math.pow(1 + stepPct, -bins_below)) * 100;
    const MIN_RANGE_PCT = 35; // absolute floor — no position should be narrower

    // If price_range_pct was also provided, use the larger of the two
    if (price_range_pct > 0) {
      const binsFromPct = calculateBinsForPriceRange(resolvedBinStep, price_range_pct);
      if (binsFromPct > bins_below) {
        log("deploy", `bins_below=${bins_below} (${actualRangePct.toFixed(1)}%) doesn't match price_range_pct=${price_range_pct}%. Using ${binsFromPct} bins instead`);
        bins_below = binsFromPct;
      }
    }

    // Enforce absolute minimum
    const finalRangePct = (1 - Math.pow(1 + stepPct, -bins_below)) * 100;
    if (finalRangePct < MIN_RANGE_PCT) {
      const correctedBins = calculateBinsForPriceRange(resolvedBinStep, MIN_RANGE_PCT);
      log("deploy", `Range too narrow: ${bins_below} bins at bs${resolvedBinStep} = ${finalRangePct.toFixed(1)}% (min ${MIN_RANGE_PCT}%). Correcting to ${correctedBins} bins`);
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

  // Resolve decimals from the mints — do NOT assume token Y is 9-decimal SOL.
  // Correct for BOTH SOL mode and USDC mode: the agent deploys into SOL-quoted
  // pools in both, but we read the actual mint decimals so sizing is right for
  // any quote/base token (SOL=9, USDC=6, etc.). uiToRawBN/getMintDecimals are
  // module-scope helpers (shared with the market-maker primitives below).
  let totalYLamports = new BN(0);
  if (finalAmountY > 0) {
    const yDecimals = await getMintDecimals(pool.lbPair.tokenYMint);
    if (yDecimals == null) {
      throw new Error(`Could not resolve token Y decimals for ${pool.lbPair.tokenYMint.toBase58()}; refusing to size deposit.`);
    }
    totalYLamports = uiToRawBN(finalAmountY, yDecimals);
  }
  let totalXLamports = new BN(0);
  if (finalAmountX > 0) {
    const xDecimals = await getMintDecimals(pool.lbPair.tokenXMint);
    if (xDecimals == null) {
      throw new Error(`Could not resolve token X decimals for ${pool.lbPair.tokenXMint.toBase58()}; refusing to size deposit.`);
    }
    totalXLamports = uiToRawBN(finalAmountX, xDecimals);
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
        strategy_profile: config.strategy.activeStrategy || null,
        strategy_type: activeStrategy === "bid_ask" ? "BidAsk" : (sol_split_pct == null || sol_split_pct >= 100 ? "SpotOneSide" : "SpotTwoSide"),
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

      // Phase 2: Add liquidity (may be multiple txs).
      // Refresh pool state after the create txs so the strategy/slippage math
      // uses a fresh activeId rather than the stale pre-create snapshot.
      await pool.refetchStates();
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
        slippage: 10, // 10% (SDK liquidity slippage is a percentage, NOT bps)
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
      strategy_profile: config.strategy.activeStrategy || null,
      strategy_type: activeStrategy === "bid_ask" ? "BidAsk" : (sol_split_pct == null || sol_split_pct >= 100 ? "SpotOneSide" : "SpotTwoSide"),
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
        base_mint: trackedFinal?.base_mint || r.base_mint,
        strategy: trackedFinal?.strategy || p?._lpa_strategy || "bid_ask",
        strategy_profile: trackedFinal?.strategy_profile || null,
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

      const lower = p?.lowerBinId ?? null;
      const upper = p?.upperBinId ?? null;
      const active = p?.poolActiveBinId ?? null;
      // Prefer an authoritative active-bin-vs-bounds check when all three are
      // available; fall back to the API's isOutOfRange flag only when bounds are
      // missing (and to null when there is no position data at all).
      const inRange = (active != null && lower != null && upper != null)
        ? (active >= lower && active <= upper)
        : (p ? !p.isOutOfRange : null);

      return {
        position:           r.position,
        pool:               r.pool,
        lower_bin:          lower,
        upper_bin:          upper,
        active_bin:         active,
        in_range:           inRange,
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

    // ─── Snapshot wallet base-token balance BEFORE close/withdraw ───
    // The post-close auto-swap must sell ONLY what this close withdraws, not the
    // entire wallet balance of the base token (which may include unrelated holdings
    // or other open positions' tokens). Capture the pre-close balance so we can
    // compute the positive delta after close. If we cannot determine it, we will
    // skip the auto-swap rather than risk dumping the whole balance.
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const baseMintPre = getTrackedPosition(position_address)?.base_mint || null;
    let preCloseBaseBalance = null; // null => unknown (do NOT swap whole balance)
    if (baseMintPre && baseMintPre !== SOL_MINT) {
      try {
        const preBals = await getWalletBalances();
        const preTok = preBals.tokens?.find((t) => t.mint === baseMintPre);
        preCloseBaseBalance = preTok?.balance ?? 0;
      } catch (preErr) {
        log("close_warn", `Could not snapshot pre-close base balance for ${baseMintPre}: ${preErr.message}`);
        preCloseBaseBalance = null;
      }
    }

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

    // Refresh pool state after the claim txs so removeLiquidity (Step 2) operates
    // on fresh on-chain state rather than the pre-claim snapshot.
    try { await pool.refetchStates(); } catch { /* best-effort */ }

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

      // The SDK error text alone is not proof the position is empty. Before
      // force-closing, re-fetch the position and confirm it actually holds zero
      // liquidity / fees / rewards. Only then is closePositionIfEmpty safe — closing
      // a still-funded account would strand or burn the funds. Best-effort: if the
      // verification itself cannot run, fall back to the prior (error-text) behavior.
      let verifiedEmpty = null; // null => could not verify
      let freshPositionData = positionData;
      try {
        try { await pool.refetchStates(); } catch { /* best-effort */ }
        freshPositionData = await pool.getPosition(positionPubKey);
        const pd = freshPositionData?.positionData || {};
        const binData = pd.positionBinData || [];
        const num = (v) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
        const totalX = num(pd.totalXAmount);
        const totalY = num(pd.totalYAmount);
        const feeX = num(pd.feeX);
        const feeY = num(pd.feeY);
        const rwd1 = num(pd.rewardOne);
        const rwd2 = num(pd.rewardTwo);
        const binLiquidity = binData.some(
          (b) => num(b.positionXAmount) > 0 || num(b.positionYAmount) > 0,
        );
        verifiedEmpty =
          totalX === 0 && totalY === 0 &&
          feeX === 0 && feeY === 0 &&
          rwd1 === 0 && rwd2 === 0 &&
          !binLiquidity;
      } catch (verifyErr) {
        verifiedEmpty = null; // verification unavailable — keep prior behavior
        log("close_warn", `Zombie-empty verification could not run: ${verifyErr.message}`);
      }

      if (verifiedEmpty === false) {
        // Position still holds liquidity/fees — do NOT force-close. Surface the
        // original error so the caller retries the real remove rather than burning
        // the account.
        log("close_warn", `closePositionIfEmpty skipped: position still has liquidity/fees — surfacing original error`);
        throw removeErr;
      }

      if (verifiedEmpty === null) {
        log("close", `Position appears empty (zombie, unverified) — falling back to closePositionIfEmpty`);
      } else {
        log("close", `Position verified empty (zombie) — closing via closePositionIfEmpty`);
      }
      const closeTx = await pool.closePositionIfEmpty({
        owner: wallet.publicKey,
        position: freshPositionData,
      });
      const txHash = await sendManagedTransaction(closeTx, [wallet], "close zombie position");
      txHashes.push(txHash);
    }
    log("close", `Close txs sent: ${txHashes.join(", ")}`);

    // ─── Verify the position account is actually gone on-chain ───
    // The remove/close txs returning success only proves they confirmed, not that
    // the position account was actually closed (a partial remove, a not-yet-empty
    // account, or an unconfirmed close can all leave the account alive). Refetch
    // pool state and read the account directly before recording a clean win.
    try { await pool.refetchStates(); } catch { /* best-effort */ }
    const info = await getConnection().getAccountInfo(positionPubKey);
    const actuallyClosed = info === null;
    if (!actuallyClosed) {
      log("close_warn", `Close txs confirmed but position account ${position_address} still exists — not recording as closed`);
      return {
        success: false,
        status: "close_unconfirmed",
        position: position_address,
        pool: poolAddress,
        txs: txHashes,
        error: "Close txs sent but position account still exists — verify/retry",
      };
    }
    log("close", `SUCCESS (account closed) txs: ${txHashes.join(", ")}`);

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

      // ─── Hard rule: swap ONLY the withdrawn base token back to SOL ───
      // Sell only the DELTA this close added to the wallet (post - pre), never
      // the entire base-token balance. Retries up to MAX_ATTEMPTS with backoff;
      // re-fetches wallet balance between attempts so a silently-landed first tx
      // doesn't cause a false insufficient-funds failure on retry. On each
      // attempt the swap amount is re-clamped to (current - pre) so retries can't
      // eat into a pre-existing balance.
      const SOL = SOL_MINT;
      const baseMint = tracked.base_mint;
      let swapOutcome = null;     // { success, mint, attempts, error? } when a swap was attempted
      let exposureFlag = false;   // true when we skipped the swap to avoid dumping whole balance

      if (baseMint && baseMint !== SOL) {
        if (preCloseBaseBalance == null) {
          // Pre-balance unknown — do NOT swap the whole balance. Flag leftover exposure.
          exposureFlag = true;
          swapOutcome = {
            success: false,
            mint: baseMint,
            attempts: 0,
            error: "pre-close base balance unknown; auto-swap skipped to avoid selling whole wallet balance",
          };
          log("close_warn", `Post-close swap skipped: pre-close balance for ${baseMint} unknown — leftover base token exposure, swap manually.`);
        } else {
          const MAX_ATTEMPTS = 3;
          const BACKOFF_MS = [0, 1500, 3000]; // delay BEFORE attempt N
          let lastError = null;
          let attempts = 0;
          let succeeded = false;

          for (let i = 0; i < MAX_ATTEMPTS; i++) {
            if (BACKOFF_MS[i]) await new Promise((r) => setTimeout(r, BACKOFF_MS[i]));

            let baseToken;
            try {
              const walletBals = await getWalletBalances();
              baseToken = walletBals.tokens?.find((t) => t.mint === baseMint);
            } catch (balErr) {
              lastError = `balance fetch failed: ${balErr.message}`;
              log("close_warn", `Post-close swap attempt ${i + 1}: ${lastError}`);
              attempts = i + 1;
              continue;
            }

            // Only the amount withdrawn by THIS close: current - pre (clamped >= 0).
            const currentBal = baseToken?.balance ?? 0;
            const swapAmount = Math.max(0, currentBal - preCloseBaseBalance);

            // Per-unit USD value to gate dust on the delta (not the whole balance).
            const unitUsd = (baseToken && currentBal > 0) ? (baseToken.usd ?? 0) / currentBal : 0;
            const deltaUsd = unitUsd * swapAmount;

            // Nothing meaningful to swap — fully swapped by a prior attempt, or dust delta.
            if (swapAmount <= 0 || deltaUsd < 0.10) {
              if (attempts > 0) succeeded = true; // prior attempt effectively cleared it
              break;
            }

            attempts = i + 1;
            log("close", `Auto-swapping ${swapAmount} ${baseToken.symbol || baseMint.slice(0, 8)} -> SOL (withdrawn delta, worth ~$${deltaUsd.toFixed(2)}) [attempt ${attempts}/${MAX_ATTEMPTS}]`);

            let swapResult;
            try {
              swapResult = await swapToken({
                input_mint: baseMint,
                output_mint: SOL,
                amount: swapAmount,
              });
            } catch (swapErr) {
              lastError = swapErr.message;
              log("close_warn", `Post-close swap attempt ${attempts} threw: ${lastError}`);
              continue;
            }

            if (swapResult?.success) {
              log("close", `Post-close swap OK on attempt ${attempts}: tx ${swapResult.tx}`);
              txHashes.push(swapResult.tx);
              succeeded = true;
              break;
            }

            lastError = swapResult?.error || "unknown";
            log("close_warn", `Post-close swap attempt ${attempts} failed: ${lastError}`);

            // Terminal errors — no point retrying
            const terminal = /no route|route not found|unsupported|invalid mint|mint not found/i.test(lastError);
            if (terminal) {
              log("close_warn", `Post-close swap terminal error, not retrying: ${lastError}`);
              break;
            }
          }

          if (attempts > 0) {
            swapOutcome = succeeded
              ? { success: true, mint: baseMint, attempts }
              : { success: false, mint: baseMint, attempts, error: lastError };
            if (!succeeded) {
              exposureFlag = true;
              log("close_warn", `Post-close swap failed after ${attempts} attempt(s); withdrawn base token remains in wallet: ${baseMint}`);
            }
          }
        }
      }

      return {
        success: true,
        ...(exposureFlag && { status: "success_with_exposure" }),
        position: position_address,
        pool: poolAddress,
        txs: txHashes,
        pnl_usd: pnlUsd,
        pnl_pct: pnlPct,
        ...(swapOutcome && { swap: swapOutcome }),
      };
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

// ═══════════════════════════════════════════════════════════════
// Market Maker primitives — Meteora DLMM Limit Orders
//
// A DLMM limit order places token liquidity at chosen bins so it behaves
// like an on-chain buy (bid, token Y at/below active bin) or sell (ask,
// token X at/above active bin) order, filled when swap flow crosses the bin.
// These wrap the SDK's native placeLimitOrder/cancelLimitOrder/getLimitOrder
// and reuse the same connection/wallet/priority-fee/retry plumbing as the LP
// tools above. They are intentionally self-contained: they do NOT call
// trackPosition, so the autonomous LP agent never manages MM orders.
// ═══════════════════════════════════════════════════════════════

let _LimitOrderHelpers = null;
async function getLimitOrderHelpers() {
  if (!_LimitOrderHelpers) {
    const mod = await import("@meteora-ag/dlmm");
    _LimitOrderHelpers = {
      isSupportLimitOrder: mod.isSupportLimitOrder,
      MAX_BIN_PER_LIMIT_ORDER: mod.MAX_BIN_PER_LIMIT_ORDER,
      LIMIT_ORDER_FEE_SHARE: mod.LIMIT_ORDER_FEE_SHARE,
      MAX_ACTIVE_BIN_SLIPPAGE: mod.MAX_ACTIVE_BIN_SLIPPAGE,
      LimitOrderStatus: mod.LimitOrderStatus,
    };
  }
  return _LimitOrderHelpers;
}

/** The on-chain cap on bins per limit-order account (50). */
export async function maxBinsPerLimitOrder() {
  const { MAX_BIN_PER_LIMIT_ORDER } = await getLimitOrderHelpers();
  return MAX_BIN_PER_LIMIT_ORDER ? Number(MAX_BIN_PER_LIMIT_ORDER.toString()) : 50;
}

// ─── Does this pool support limit orders? ──────────────────────
// Limit orders only work on DLMM pools whose function mode is LimitOrder
// (a pool is either liquidity-mining OR limit-order, never both).
export async function poolSupportsLimitOrder({ pool_address }) {
  pool_address = normalizeMint(pool_address);
  try {
    const { isSupportLimitOrder } = await getLimitOrderHelpers();
    const pool = await getPool(pool_address);
    const supported = !!isSupportLimitOrder(pool.lbPair);
    return {
      supported,
      pool: pool_address,
      bin_step: pool.lbPair?.binStep ?? null,
      token_x: pool.lbPair?.tokenXMint?.toBase58?.() ?? null,
      token_y: pool.lbPair?.tokenYMint?.toBase58?.() ?? null,
    };
  } catch (error) {
    return { supported: false, pool: pool_address, error: error.message };
  }
}

// ─── Place a limit order ───────────────────────────────────────
// bins: [{ id: <absolute binId>, amount: <UI amount> }]
//   - is_ask_side=true  → deposit token X (base), sell X for Y at bins >= active
//   - is_ask_side=false → deposit token Y (quote), buy X with Y at bins <= active
// relativeBin carries the observed active bin + max slippage so the order is
// rejected on-chain if price has already jumped past max_active_bin_slippage.
export async function placeMmLimitOrder({
  pool_address,
  is_ask_side,
  bins,
  max_active_bin_slippage = 3,
  label = "mm place limit order",
}) {
  pool_address = normalizeMint(pool_address);
  if (!Array.isArray(bins) || bins.length === 0) {
    return { success: false, error: "bins must be a non-empty array of { id, amount }" };
  }
  const maxBins = await maxBinsPerLimitOrder();
  if (bins.length > maxBins) {
    return { success: false, error: `Too many bins (${bins.length}); max ${maxBins} per limit order.` };
  }

  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  // ask deposits base (X); bid deposits quote (Y)
  const depositMint = is_ask_side ? pool.lbPair.tokenXMint : pool.lbPair.tokenYMint;
  const decimals = await getMintDecimals(depositMint);
  if (decimals == null) {
    return { success: false, error: `Could not resolve decimals for ${depositMint.toBase58?.() ?? depositMint}` };
  }

  const binAmounts = bins.map((b) => ({ id: b.id, amount: uiToRawBN(b.amount, decimals) }));

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_place: {
        pool: pool_address,
        is_ask_side: !!is_ask_side,
        active_bin: activeBin.binId,
        deposit_mint: depositMint.toBase58?.() ?? String(depositMint),
        bins: bins.map((b) => ({ id: b.id, amount: b.amount })),
      },
      message: "DRY RUN — no transaction sent",
    };
  }

  const wallet = getWallet();
  const limitOrder = Keypair.generate();
  try {
    const tx = await pool.placeLimitOrder({
      owner: wallet.publicKey,
      payer: wallet.publicKey,
      sender: wallet.publicKey,
      limitOrder: limitOrder.publicKey,
      params: {
        isAskSide: !!is_ask_side,
        relativeBin: { activeId: activeBin.binId, maxActiveBinSlippage: max_active_bin_slippage },
        bins: binAmounts,
      },
    });

    const txArr = Array.isArray(tx) ? tx : [tx];
    const txHashes = [];
    for (let i = 0; i < txArr.length; i++) {
      // limitOrder is a fresh signer account — sign it on the first tx only.
      const signers = i === 0 ? [wallet, limitOrder] : [wallet];
      txHashes.push(await sendManagedTransaction(txArr[i], signers, `${label} ${i + 1}/${txArr.length}`));
    }

    log("mm_place", `${is_ask_side ? "ASK" : "BID"} order ${limitOrder.publicKey.toString().slice(0, 8)} on ${pool_address.slice(0, 8)}: ${bins.length} bin(s) around active ${activeBin.binId}`);
    return {
      success: true,
      limit_order: limitOrder.publicKey.toString(),
      is_ask_side: !!is_ask_side,
      active_bin: activeBin.binId,
      bins,
      txs: txHashes,
    };
  } catch (error) {
    log("mm_place_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Read a limit order's fill status (flattened) ──────────────
export async function getMmLimitOrder({ pool_address, limit_order }) {
  pool_address = normalizeMint(pool_address);
  limit_order = normalizeMint(limit_order);
  try {
    const pool = await getPool(pool_address);
    const parsed = await pool.getLimitOrder(new PublicKey(limit_order));
    const d = parsed?.limitOrderData || {};
    const binData = (d.limitOrderBinData || []).map((b) => ({
      bin_id: b.binId,
      status: b.status,
      is_ask_side: b.isAskSide,
      empty: b.empty,
      filled_x: b.filledAmountX,
      filled_y: b.filledAmountY,
      unfilled_x: b.unfilledAmountX,
      unfilled_y: b.unfilledAmountY,
      fee_x: b.feeAmountX,
      fee_y: b.feeAmountY,
    }));
    return {
      limit_order,
      pool: pool_address,
      total_deposit_x: d.totalDepositAmountX,
      total_deposit_y: d.totalDepositAmountY,
      total_filled_x: d.totalFilledAmountX,
      total_filled_y: d.totalFilledAmountY,
      total_unfilled_x: d.totalUnfilledAmountX,
      total_unfilled_y: d.totalUnfilledAmountY,
      total_fee_x: d.totalFeeAmountX,
      total_fee_y: d.totalFeeAmountY,
      withdrawable_x: d.transferFeeExcludedWithdrawableAmountX,
      withdrawable_y: d.transferFeeExcludedWithdrawableAmountY,
      bins: binData,
    };
  } catch (error) {
    return { limit_order, pool: pool_address, error: error.message };
  }
}

// ─── List all of the wallet's limit orders on a pool ───────────
export async function listMmLimitOrders({ pool_address }) {
  pool_address = normalizeMint(pool_address);
  try {
    const wallet = getWallet();
    const pool = await getPool(pool_address);
    const orders = await pool.getLimitOrderByUserAndLbPair(wallet.publicKey);
    return {
      pool: pool_address,
      count: orders.length,
      orders: orders.map((o) => ({
        limit_order: o.publicKey.toString(),
        total_unfilled_x: o.limitOrderData?.totalUnfilledAmountX,
        total_unfilled_y: o.limitOrderData?.totalUnfilledAmountY,
        total_filled_x: o.limitOrderData?.totalFilledAmountX,
        total_filled_y: o.limitOrderData?.totalFilledAmountY,
      })),
    };
  } catch (error) {
    return { pool: pool_address, count: 0, orders: [], error: error.message };
  }
}

// ─── Cancel a limit order (harvest filled + unfilled funds) ────
// Cancels the given bins (defaults to ALL bins on the order), which withdraws
// both filled proceeds and unfilled deposits to the wallet, then closes the
// account to reclaim rent. Returns withdrawn amounts via balance deltas.
export async function cancelMmLimitOrder({ pool_address, limit_order, bin_ids = null, label = "mm cancel limit order" }) {
  pool_address = normalizeMint(pool_address);
  limit_order = normalizeMint(limit_order);

  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_cancel: { pool: pool_address, limit_order, bin_ids }, message: "DRY RUN — no transaction sent" };
  }

  try {
    const wallet = getWallet();
    const pool = await getPool(pool_address);

    // Resolve bins to cancel if not provided.
    let binIds = bin_ids;
    if (!Array.isArray(binIds) || binIds.length === 0) {
      const parsed = await pool.getLimitOrder(new PublicKey(limit_order));
      binIds = (parsed?.limitOrderData?.limitOrderBinData || [])
        .filter((b) => !b.empty)
        .map((b) => b.binId);
    }
    if (!binIds || binIds.length === 0) {
      // Nothing left to cancel — just try to close the empty account.
      const closeTx = await pool.closeLimitOrderIfEmpty({
        limitOrder: new PublicKey(limit_order),
        owner: wallet.publicKey,
        rentReceiver: wallet.publicKey,
      });
      const closeHash = await sendManagedTransaction(closeTx, [wallet], `${label} close-empty`);
      return { success: true, limit_order, pool: pool_address, cancelled_bins: [], txs: [closeHash] };
    }

    const txHashes = [];
    const cancelTx = await pool.cancelLimitOrder({
      limitOrderPubkey: new PublicKey(limit_order),
      owner: wallet.publicKey,
      rentReceiver: wallet.publicKey,
      binIds,
    });
    for (const tx of Array.isArray(cancelTx) ? cancelTx : [cancelTx]) {
      txHashes.push(await sendManagedTransaction(tx, [wallet], `${label} cancel`));
    }

    // Best-effort: close the now-empty account to reclaim rent.
    try {
      const closeTx = await pool.closeLimitOrderIfEmpty({
        limitOrder: new PublicKey(limit_order),
        owner: wallet.publicKey,
        rentReceiver: wallet.publicKey,
      });
      txHashes.push(await sendManagedTransaction(closeTx, [wallet], `${label} close`));
    } catch (closeErr) {
      log("mm_cancel_warn", `close-after-cancel skipped: ${closeErr.message}`);
    }

    log("mm_cancel", `Cancelled order ${limit_order.slice(0, 8)} (${binIds.length} bin(s)) on ${pool_address.slice(0, 8)}`);
    return { success: true, limit_order, pool: pool_address, cancelled_bins: binIds, txs: txHashes };
  } catch (error) {
    log("mm_cancel_error", error.message);
    return { success: false, limit_order, pool: pool_address, error: error.message };
  }
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

  // getAllLbPairPositionsByUser returns a Map<string, PositionInfo>, not a plain
  // object — Object.entries() would always be empty. Iterate the Map directly.
  for (const [lbPairKey, positionData] of allPositions.entries()) {
    for (const pos of positionData.lbPairPositionsData || []) {
      if (pos.publicKey.toString() === position_address) return lbPairKey;
    }
  }

  throw new Error(`Position ${position_address} not found in open positions`);
}
