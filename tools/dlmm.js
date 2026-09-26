import {
  Connection,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SendTransactionError,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { log } from "../logger.js";
import { emit } from "../notifier.js";
import {
  trackPosition,
  markOutOfRange,
  markInRange,
  recordActiveBin,
  depthUseAtClose,
  recordClaim,
  recordClose,
  updateTrackedPosition,
  getTrackedPosition,
  getTrackedPositions,
  minutesOutOfRange,
  syncOpenPositions,
} from "../state.js";
import { recordPerformance } from "../lessons.js";
import { getAndClearStagedSignals } from "../signal-tracker.js";
import { getExperimentTag } from "../prompt.js";
import { normalizeMint, getWalletBalances, swapToken, getOnchainTokenBalance } from "./wallet.js";
import { swapBackWithdrawnBase, expectedBaseWithdrawRaw } from "./close-swap.js";
import { computeOnchainPnl, binPrice, onchainPctForUnit, feesValue } from "./onchain-pnl.js";
import { calculateBinsForPriceRange, splitRangeBins, lpaCurrentValueUsd, MIN_RANGE_PCT, MIN_BINS, fitDeployAmount } from "../runtime-helpers.js";
import { fetchGmgnPriceInfo } from "./gmgn.js";
import { getDepthForDeploy } from "./ohlcv.js";
import {
  heliusSenderEnabled,
  buildSenderTipIx,
  isSenderTipIx,
  sendAndConfirmSigned,
  basePriorityPrice,
  cappedPriorityPrice,
  legacyTxSize,
  MAX_TX_BYTES,
  MAX_CU_LIMIT,
  MIN_CU_LIMIT,
} from "./tx-send.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
import { fetchTopLpersStats, evaluateTopLpersGate } from "./study.js";

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
          // Helius rejects `recommended` combined with `priorityLevel`
          // ("recommended cannot be used with priority_level") — send the level only.
          options: {
            priorityLevel: config.management.priorityFeeLevel || "Medium",
          },
        }],
      }),
    });

    if (!res.ok) {
      throw new Error(`Helius fee estimate failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    // JSON-RPC errors come back with HTTP 200 — surface them instead of silently
    // falling back to the default price.
    if (data?.error) {
      throw new Error(`Helius fee estimate error: ${data.error.message || JSON.stringify(data.error)}`);
    }
    const estimate = Math.ceil(Number(data?.result?.priorityFeeEstimate || 0));
    if (!Number.isFinite(estimate) || estimate <= 0) {
      log("priority_fee_warn", `${label}: no usable estimate in Helius response`);
      return null;
    }
    log("priority_fee", `${label}: estimated ${estimate} microlamports/CU (${config.management.priorityFeeLevel})`);
    return estimate;
  } catch (error) {
    log("priority_fee_warn", `${label}: ${error.message}`);
    return null;
  }
}

/**
 * Which bin arrays covering [minBinId, maxBinId] are already initialized?
 * Returns { missing: number[], min, max } where [min, max] is the contiguous
 * initialized window around the active bin, clipped to the requested range
 * (min/max are null if the active bin's own array is missing). Read-only.
 * A bin array past the default bitmap also needs the bitmap extension account
 * (more rent), so it counts as missing when the pool has no extension yet.
 */
async function initializedBinArrayWindow(pool, minBinId, maxBinId, activeBinId) {
  const m = await import("@meteora-ag/dlmm");
  const idxOf = (binId) => m.binIdToBinArrayIndex(new BN(binId)).toNumber();
  const lo = idxOf(minBinId);
  const hi = idxOf(maxBinId);
  const indexes = [];
  for (let i = lo; i <= hi; i++) indexes.push(i);
  const keys = indexes.map((i) => m.deriveBinArray(pool.pubkey, new BN(i), pool.program.programId)[0]);
  const infos = await getConnection().getMultipleAccountsInfo(keys);
  const exists = new Map(indexes.map((i, k) => [
    i,
    !!infos[k] && !(m.isOverflowDefaultBinArrayBitmap(new BN(i)) && !pool.binArrayBitmapExtension),
  ]));
  const missing = indexes.filter((i) => !exists.get(i));
  if (missing.length === 0) return { missing, min: minBinId, max: maxBinId };

  const act = Math.min(Math.max(idxOf(activeBinId), lo), hi);
  if (!exists.get(act)) return { missing, min: null, max: null };
  let a = act;
  let b = act;
  while (a - 1 >= lo && exists.get(a - 1)) a--;
  while (b + 1 <= hi && exists.get(b + 1)) b++;
  const [aLow] = m.getBinArrayLowerUpperBinId(new BN(a));
  const [, bHigh] = m.getBinArrayLowerUpperBinId(new BN(b));
  return {
    missing,
    min: Math.max(minBinId, aLow.toNumber()),
    max: Math.min(maxBinId, bHigh.toNumber()),
  };
}

const isCuLimitIx = (ix) => ix?.programId?.equals?.(ComputeBudgetProgram.programId) && ix.data?.[0] === 2;
const isCuPriceIx = (ix) => ix?.programId?.equals?.(ComputeBudgetProgram.programId) && ix.data?.[0] === 3;

// Per-tx fee state set by applyPriorityFee: { cuLimit, baseMicroLamports,
// microLamports, sender }. Its presence makes applyPriorityFee idempotent.
const feeState = new WeakMap();

/**
 * Prepare a legacy tx for sending: Sender tip, CU limit, CU price, fresh
 * blockhash, and a size check. Idempotent: calling it again on the same tx
 * object never adds a second tip or compute-budget instruction.
 *
 * Size guard: the tip (+49 bytes) is only needed for Helius Sender. If the tx
 * would exceed 1232 bytes with it, the tip is dropped and the tx goes out via
 * the RPC only; if it is still too large, this throws before anything is signed.
 */
async function applyPriorityFee(tx, feePayer, label) {
  if (!tx?.instructions?.length) return tx;
  if (feeState.has(tx)) return tx; // already prepared: never add a second tip / CU ix

  const connection = getConnection();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = feePayer;

  // Sender tip, once (a tip already present is reused, never duplicated).
  let tipped = tx.instructions.some(isSenderTipIx);
  if (heliusSenderEnabled() && !tipped) {
    tx.instructions.push(buildSenderTipIx(feePayer));
    tipped = true;
  }

  // Put the compute-budget instructions in place now (their values don't
  // change the size), so the size check below sees the final shape. Never a
  // second one: an existing limit / price instruction is updated in place.
  const maxCu = config.management.computeUnitLimit || MAX_CU_LIMIT;
  const sdkLimitIx = tx.instructions.find(isCuLimitIx);
  const sdkLimit = sdkLimitIx ? sdkLimitIx.data.readUInt32LE(1) : null;
  if (!sdkLimitIx) tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: maxCu }));
  if (!tx.instructions.some(isCuPriceIx)) tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }));

  // ─── Size guard ───
  let size = legacyTxSize(tx);
  if (size > MAX_TX_BYTES && tipped) {
    const withTip = size;
    tx.instructions = tx.instructions.filter((ix) => !isSenderTipIx(ix));
    tipped = false;
    size = legacyTxSize(tx);
    log("tx_size", `${label}: ${withTip} bytes with the Sender tip exceeds ${MAX_TX_BYTES} — dropped the tip, sending via RPC only (${size} bytes)`);
  }
  if (size > MAX_TX_BYTES) {
    throw new Error(`${label}: transaction is ${size} bytes, over the ${MAX_TX_BYTES}-byte limit even without the Sender tip — not signed or sent`);
  }

  const estimated = await estimatePriorityFeeMicroLamports(tx, feePayer, label);
  // Fall back to a sane default rather than sending with no priority fee, and
  // floor the price (see basePriorityPrice).
  const baseMicroLamports = basePriorityPrice(estimated);

  // Compute-unit limit. Each InitializeBinArray costs ~200k CU, so the old 400k
  // default could run out mid-tx; a blanket 1.4M fixed that but hurt landing
  // (a tx reserving 1.4M CU is hard to pack next to a busy pool's per-account CU
  // budget — live txs used ~29k of 1.4M and add-liquidity chunks kept expiring).
  // ALWAYS simulate at the max to measure, then request 1.2× what it used,
  // clamped to [50k, 1.4M]. When the SDK already set a limit, keep the lower
  // of the two: createExtendedEmptyPosition reserves 30k × bins (1.4M for a
  // wide range, ~29k used) and the SDK's own estimator falls back to 1.4M when
  // its simulation throws, while e.g. removeLiquidity's sim+30% may be lower.
  setComputeBudgetIx(tx, isCuLimitIx, ComputeBudgetProgram.setComputeUnitLimit({ units: maxCu }));
  const measured = await simulateComputeUnits(tx, label);
  let cuLimit = sdkLimit ?? maxCu;
  if (measured) {
    const sized = Math.min(maxCu, Math.max(MIN_CU_LIMIT, Math.ceil(measured * 1.2)));
    cuLimit = sdkLimit != null ? Math.min(sdkLimit, sized) : sized;
    log("priority_fee", `${label}: simulated ${measured} CU → limit ${cuLimit}${sdkLimit != null ? ` (SDK set ${sdkLimit}${cuLimit < sdkLimit ? ", replaced" : ", kept"})` : ""}`);
  }
  setComputeBudgetIx(tx, isCuLimitIx, ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));

  // Cap the total priority fee per tx (price × CU limit) so an estimate spike
  // can't make one tx expensive.
  const priced = cappedPriorityPrice({ microLamports: baseMicroLamports, cuLimit });
  if (priced.capped) {
    log("priority_fee", `${label}: price ${baseMicroLamports} µL/CU capped to ${priced.maxMicroLamports} (max ${config.management.maxPriorityFeeLamports ?? 1_000_000} lamports/tx)`);
  }
  setComputeBudgetIx(tx, isCuPriceIx, ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priced.microLamports }));

  feeState.set(tx, { cuLimit, baseMicroLamports, microLamports: priced.microLamports, sender: tipped });
  return tx;
}

/**
 * Expiry retry N (1-based) pays base × priorityFeeRetryMultiplier^N µL/CU
 * (×2 per retry by default), still capped so price × CU limit stays within
 * maxPriorityFeeLamports. The price instruction is replaced in place (same
 * size). No-op for a tx applyPriorityFee didn't prepare.
 */
function escalatePriorityFee(tx, attempt, label) {
  const st = feeState.get(tx);
  if (!st || attempt <= 0) return;
  const factor = config.management.priorityFeeRetryMultiplier ?? 2;
  const wanted = Math.ceil(st.baseMicroLamports * Math.pow(factor, attempt));
  const priced = cappedPriorityPrice({ microLamports: wanted, cuLimit: st.cuLimit });
  if (priced.microLamports === st.microLamports) {
    if (priced.capped) log("tx_retry", `${label}: CU price stays ${st.microLamports} µL/CU (at the ${config.management.maxPriorityFeeLamports ?? 1_000_000}-lamport cap)`);
    return;
  }
  log("tx_retry", `${label}: CU price ${st.microLamports} → ${priced.microLamports} µL/CU for retry ${attempt + 1}/3${priced.capped ? " (capped)" : ""}`);
  setComputeBudgetIx(tx, isCuPriceIx, ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priced.microLamports }));
  st.microLamports = priced.microLamports;
}

/** Replace the (single) compute-budget instruction matching `match` in place. */
function setComputeBudgetIx(tx, match, ix) {
  const i = tx.instructions.findIndex(match);
  if (i >= 0) tx.instructions[i] = ix;
  else tx.instructions.unshift(ix);
}

/**
 * Simulate a (not yet signed) legacy tx and return the compute units it used,
 * or null if simulation isn't possible — callers then keep the max limit.
 * A simulation error (e.g. a program failure) also returns null: sizing is
 * only an optimisation and must never block or alter what gets sent.
 */
async function simulateComputeUnits(tx, label) {
  try {
    const sim = await getConnection().simulateTransaction(tx);
    const used = sim?.value?.unitsConsumed;
    if (sim?.value?.err) {
      log("priority_fee_warn", `${label}: simulation error ${JSON.stringify(sim.value.err)} — keeping max CU limit`);
      return null;
    }
    return Number.isFinite(used) && used > 0 ? used : null;
  } catch (error) {
    log("priority_fee_warn", `${label}: simulation failed (${error.message}) — keeping max CU limit`);
    return null;
  }
}

/**
 * @param {object} [opts]
 * @param {() => Promise<boolean>} [opts.beforeResend] Called before any
 *   re-sign/resend after an expiry, once the prior signature is known not to
 *   have landed. Return true only when resending is verified safe (e.g. the
 *   chunk's bins are still empty on-chain); anything else aborts the resend.
 */
async function sendManagedTransaction(tx, signers, label, { beforeResend } = {}) {
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
          // No signature was captured for the prior attempt (it failed before
          // signing), so we cannot confirm whether it landed. Add a short delay
          // before resubmit to reduce (not eliminate) the double-submit window.
          // LIMITATION: a silently-landed prior tx could still be resubmitted here.
          await new Promise((r) => setTimeout(r, 1500));
        }

        if (beforeResend) {
          let safe = false;
          try { safe = (await beforeResend()) === true; } catch (checkErr) {
            log("tx_retry", `${label}: resend check failed (${checkErr?.message || checkErr})`);
          }
          if (!safe) {
            const abort = new Error(`${label}: not resending after expiry — could not verify on-chain that it is safe to resend (prior error: ${lastError?.message || "expired"})`);
            abort.noRetry = true;
            throw abort;
          }
        }

        lastSig = null;
      }

      // Sign ONCE here and send the exact signed bytes. Do NOT use
      // sendAndConfirmTransaction / connection.sendTransaction(tx, signers):
      // for legacy txs web3.js overwrites recentBlockhash with its own cached
      // blockhash and re-signs, so the signature that goes on the wire differs
      // from one derived beforehand — and the double-submit guard above would
      // check the wrong signature.
      const connection = getConnection();
      if (attempt > 0) escalatePriorityFee(tx, attempt, label);
      if (attempt > 0 || !tx.recentBlockhash || tx.lastValidBlockHeight == null) {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
      }
      tx.feePayer ??= feePayer;
      tx.sign(...signers);
      if (!tx.signature) throw new Error(`${label}: transaction has no fee-payer signature after signing`);
      const signature = bs58.encode(tx.signature);
      lastSig = signature;

      // Broadcast, then rebroadcast the SAME signed bytes every 2s until
      // confirmed or expired (a single send is often dropped under load).
      const wire = tx.serialize();
      const status = await sendAndConfirmSigned(connection, {
        wire,
        signature,
        blockhash: tx.recentBlockhash,
        lastValidBlockHeight: tx.lastValidBlockHeight,
        label,
        // No tip (dropped by the size guard, or Sender disabled) → RPC only.
        sender: feeState.get(tx)?.sender ?? false,
      });
      if (status?.err) {
        throw new SendTransactionError({
          action: "send",
          signature,
          transactionMessage: `Status: (${JSON.stringify(status)})`,
        });
      }
      return signature;
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

      if (error?.noRetry || !retryableExpiry || attempt === 2) {
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

setInterval(() => poolCache.clear(), 5 * 60 * 1000).unref?.(); // unref: never keeps a process (or test) alive on its own

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

/**
 * Re-read a position's token amounts on-chain. Returns
 * { rawX, rawY, empty } (raw base-unit strings), or null when the read fails
 * (caller must treat null as "possibly funded").
 */
async function readPositionAmounts(pool, positionPubKey) {
  try {
    try { await pool.refetchStates(); } catch { /* best-effort */ }
    const pd = (await pool.getPosition(positionPubKey))?.positionData;
    if (!pd) return null;
    const big = (v) => { try { return BigInt(String(v ?? "0").split(".")[0] || "0"); } catch { return null; } };
    const rawX = big(pd.totalXAmount);
    const rawY = big(pd.totalYAmount);
    if (rawX == null || rawY == null) return null;
    const binLiquidity = (pd.positionBinData || []).some(
      (b) => Number(b.positionXAmount || 0) > 0 || Number(b.positionYAmount || 0) > 0,
    );
    return { rawX: rawX.toString(), rawY: rawY.toString(), empty: rawX === 0n && rawY === 0n && !binLiquidity };
  } catch (e) {
    log("deploy_warn", `Could not read position ${positionPubKey.toString().slice(0, 8)} on-chain: ${e.message}`);
    return null;
  }
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
  _manual = false, // set only by executeTool for owner-initiated Telegram deploys (never from the LLM)
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
  let sizingSkip = null;
  try {
    const { resolveDeploySizing } = await import("../config.js");
    const { getWalletBalances } = await import("./wallet.js");
    const bal = await getWalletBalances();
    if (!callerProvidedAmount && bal?.sol > 0) {
      // Amount missing entirely — default it from positionSizePct × the portfolio
      // total (or free wallet SOL, per positionSizeBase), capped by free SOL.
      const sizing = await resolveDeploySizing({ wallet: bal });
      if (sizing.skip) {
        sizingSkip = sizing.reason;
      } else {
        log("deploy", `Amount not provided; defaulting to ${sizing.amount} SOL (${sizing.label})`);
        totalSolAmount = sizing.amount;
        amount_y = sizing.amount;
      }
    }
  } catch { /* best-effort — use what the model passed */ }
  if (sizingSkip) return { success: false, error: `Deploy skipped — ${sizingSkip}` };

  // Hard floor: reject (do not silently raise) explicit amounts below 0.1 SOL.
  if (callerProvidedAmount && totalSolAmount > 0 && totalSolAmount < 0.1) {
    throw new Error(`Deploy amount ${totalSolAmount} SOL is below the 0.1 SOL minimum. Pass at least 0.1 SOL or omit the amount to use the wallet-scaled default.`);
  }

  if (!["bid_ask", "spot"].includes(activeStrategy)) {
    throw new Error("Only 'bid_ask' or 'spot' strategies are allowed.");
  }

  // ─── Hard guard: token-age window (every strategy) ─────────────
  // config.screening.minTokenAgeHours / maxTokenAgeHours; null = no bound.
  // Age is the base token's creation time (Meteora token_x.created_at, else
  // GMGN creation/open timestamp), never the pool's. A known age outside the
  // window refuses; an unknown age is allowed with a warning (tools/token-age.js).
  if (_manual) {
    log("deploy", "Manual (owner) deploy — token-age window not applied");
  } else {
    const { checkDeployTokenAge, fmtAgeHours } = await import("./token-age.js");
    const age = await checkDeployTokenAge({
      mint: base_mint || null,
      pool_address,
      resolveMint: async () => (await getPool(pool_address)).lbPair.tokenXMint.toBase58(),
    });
    if (!age.pass) {
      log("deploy", `Refusing deploy into ${pool_address}: ${age.reason}`);
      return { success: false, blocked_by: "token_age", error: age.reason, token_age_hours: age.hours, token_age_source: age.source };
    }
    if (age.unknown) {
      log("deploy_warn", `Token age unknown for ${age.mint ? age.mint.slice(0, 8) : pool_address.slice(0, 8)} (no Meteora created_at, no GMGN creation time); allowing the deploy without the age window`);
    } else if (!age.skipped) {
      log("deploy", `Token age ${fmtAgeHours(age.hours)} (${age.source}) is inside the window`);
    }
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
    const indicators = gmgn?.candles || null;
    const supertrendOk = !!indicators?.evil_panda_entry_ok;

    const failures = [];
    if (tokenVolume24h < (ep.minTokenVolume24h ?? 750_000)) {
      failures.push(`token volume24H $${Math.round(tokenVolume24h)} < $${ep.minTokenVolume24h ?? 750_000}`);
    }
    if (tokenMcap < (ep.minMcap ?? 200_000)) {
      failures.push(`token mcap $${Math.round(tokenMcap)} < $${ep.minMcap ?? 200_000}`);
    }
    // Token-age window: checked above for every strategy (tools/token-age.js).
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
      // checkSmartWalletsOnPool returns `in_pool`; a degraded result (some
      // wallet lookups failed) is not a confirmed signal, so it fails.
      hasSmartWallets = (swResult?.in_pool?.length ?? 0) > 0 && !swResult?.degraded;
    } catch { /* default to false */ }
    if (!hasSmartWallets) failures.push("no smart wallets on pool");

    // Condition 2: Top LPers >= 80% win rate (LPAgent top-lpers, Premium key).
    // fetchTopLpersStats returns [] without a key / on 401 / on error → fails closed.
    let studyPasses = false;
    try {
      const lpers = await fetchTopLpersStats({ pool_address, limit: 20 });
      studyPasses = evaluateTopLpersGate(lpers).passes;
    } catch (e) { log("deploy", `top-lpers gate error: ${e.message}`); }
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

  let ohlcvDepthPct = null; // candle depth seen below (recorded on the position for buffer evolution)
  // ─── Hard guard: validate actual range % — always check, even when price_range_pct is set ───
  // Models sometimes pass bins_below AND price_range_pct but the bins don't match the %.
  // Always verify the actual range and correct if too narrow.
  if (bins_below > 0 && resolvedBinStep) {
    const stepPct = resolvedBinStep / 10000;
    const actualRangePct = (1 - Math.pow(1 + stepPct, -bins_below)) * 100;
    // MIN_RANGE_PCT (runtime-helpers.js): absolute floor — no position should be narrower

    // If price_range_pct was also provided, use the larger of the two
    if (price_range_pct > 0) {
      const binsFromPct = calculateBinsForPriceRange(resolvedBinStep, price_range_pct);
      if (binsFromPct > bins_below) {
        log("deploy", `bins_below=${bins_below} (${actualRangePct.toFixed(1)}%) doesn't match price_range_pct=${price_range_pct}%. Using ${binsFromPct} bins instead`);
        bins_below = binsFromPct;
      }
    }

    // Candle-based depth floor (strategy.rangeDepthMode "ohlcv", tools/ohlcv.js):
    // widen a range shallower than the pool's recent drawdown-based depth. Never
    // above maxRangePct (capped below) and never below MIN_RANGE_PCT.
    if (config.strategy?.rangeDepthMode === "ohlcv") {
      const currentPct = (1 - Math.pow(1 + stepPct, -bins_below)) * 100;
      const od = await getDepthForDeploy({ pool: pool_address, mint: base_mint || null }).catch(() => null);
      ohlcvDepthPct = od?.depthPct > 0 ? od.depthPct : null;
      if (od?.depthPct > 0) {
        const maxPctCap = Number(config.strategy?.maxRangePct) || 80;
        const targetPct = Math.max(MIN_RANGE_PCT, Math.min(od.depthPct, maxPctCap, 99));
        if (currentPct + 0.5 < targetPct) {
          const widenedBins = calculateBinsForPriceRange(resolvedBinStep, targetPct);
          log("deploy", `OHLCV depth: widening ${bins_below} bins (${currentPct.toFixed(1)}%) to ${widenedBins} bins (${targetPct}%) — ${od.reason}`);
          bins_below = widenedBins;
        } else {
          log("deploy", `OHLCV depth ${od.depthPct}% ≤ requested ${currentPct.toFixed(1)}% — keeping it (${od.reason})`);
        }
      } else {
        log("deploy", "OHLCV depth unavailable — keeping the requested range (volatility table)");
      }
    }

    // Enforce absolute minimum
    const finalRangePct = (1 - Math.pow(1 + stepPct, -bins_below)) * 100;
    if (finalRangePct < MIN_RANGE_PCT) {
      const correctedBins = calculateBinsForPriceRange(resolvedBinStep, MIN_RANGE_PCT);
      log("deploy", `Range too narrow: ${bins_below} bins at bs${resolvedBinStep} = ${finalRangePct.toFixed(1)}% (min ${MIN_RANGE_PCT}%). Correcting to ${correctedBins} bins`);
      bins_below = correctedBins;
    }

    // Enforce the configured maximum depth (strategy.maxRangePct, default 80%).
    const maxPct = Number(config.strategy?.maxRangePct) || 80;
    const deepRangePct = (1 - Math.pow(1 + stepPct, -bins_below)) * 100;
    if (maxPct > MIN_RANGE_PCT && maxPct < 100 && deepRangePct > maxPct + 0.5) {
      const cappedBins = calculateBinsForPriceRange(resolvedBinStep, maxPct);
      log("deploy", `Range too deep: ${bins_below} bins at bs${resolvedBinStep} = ${deepRangePct.toFixed(1)}% (max ${maxPct}%). Capping to ${cappedBins} bins`);
      bins_below = cappedBins;
    }
  }

  // Range-depth context stored on the tracked position (ohlcvBufferMult evolution).
  const depthTrackFields = () => ({
    range_depth_mode: config.strategy?.rangeDepthMode ?? null,
    ohlcv_buffer_mult: config.strategy?.rangeDepthMode === "ohlcv" ? (config.strategy?.ohlcvBufferMult ?? null) : null,
    ohlcv_depth_pct: ohlcvDepthPct,
  });

  // ─── Detect auto-swap need ────────────────────────────────────
  // When the model wants two-sided spot but only has SOL:
  //   sol_split_pct is provided AND < 100, strategy is "spot", and no amount_x given.
  // We'll swap some SOL → base token automatically after fetching the pool.
  const needsAutoSwap = sol_split_pct != null && sol_split_pct < 100
    && activeStrategy === "spot"
    && !((amount_x ?? 0) > 0);

  let hasBaseToken = (amount_x ?? 0) > 0;
  const hasSol = totalSolAmount > 0;

  // Hoisted: the auto-swap fallback below reverts to this full SOL-only range.
  let totalRangeBins;
  if (activeStrategy === "spot" && bins_below && !bins_above) {
    totalRangeBins = bins_below;

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
  // MIN_BINS (runtime-helpers.js)
  let totalBins = activeBinsBelow + activeBinsAbove;
  if (totalBins < MIN_BINS) {
    return {
      success: false,
      error: `Rejected: total bins = ${totalBins}, minimum is ${MIN_BINS}. At bin_step ${resolvedBinStep || "?"}, ${MIN_BINS} bins ≈ ${resolvedBinStep ? (MIN_BINS * (resolvedBinStep / 10000) * 100).toFixed(0) : "?"}% range. Pass price_range_pct (for example 25-50) instead of a bin count; bins are computed from the pool's bin_step.`,
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

  const { DLMM, StrategyType } = await getDLMM();
  const wallet = getWallet();
  // A private, freshly loaded instance rather than the shared poolCache entry:
  // the SDK builds the deposit from pool.lbPair.activeId, and a cached instance
  // is up to 5 min stale — and could be refetched by another flow between our
  // range computation and the build.
  const pool = _poolOverridesForTest.get(String(pool_address))
    ?? await DLMM.create(getConnection(), new PublicKey(pool_address));
  const activeIdAtLoad = pool.lbPair.activeId;
  // Deploys fund the Y side with SOL (both SOL and USDC mode swap to SOL first),
  // so a pool whose token Y isn't wrapped SOL would be funded with the wrong token.
  const tokenYMint = pool.lbPair?.tokenYMint?.toBase58?.() ?? String(pool.lbPair?.tokenYMint ?? "");
  if (tokenYMint !== WSOL_MINT) {
    log("deploy", `Refusing deploy into ${pool_address}: token Y is ${tokenYMint}, not SOL`);
    return { success: false, error: `Pool ${pool_address} is not SOL-quoted (token Y ${tokenYMint}); only SOL pools are supported.` };
  }

  // ─── Rent guard: deposit + position rent + fees must leave the gas reserve ───
  // A wide position's account rent grows with its bins (~0.095 SOL at 162 bins)
  // and comes out of free SOL on top of the deposit. With the exact bin count
  // known, shrink a SOL-only deposit that would dip into gasReserve.
  if (totalSolAmount > 0 && !((amount_x ?? 0) > 0) && !needsAutoSwap) {
    try {
      const freeSol = (await getConnection().getBalance(wallet.publicKey, "confirmed")) / 1e9;
      const reserve = Number(config.management.gasReserve ?? 0.2);
      const fit = fitDeployAmount({ freeSol, reserve, amount: totalSolAmount, totalBins });
      if (fit.shrunk) {
        if (fit.amount < 0.1) {
          return { success: false, error: `Deploy skipped — ${freeSol.toFixed(4)} SOL free can't cover ${totalSolAmount} SOL + ~${fit.overhead.toFixed(4)} SOL position rent/fees and keep the ${reserve} SOL gas reserve.` };
        }
        log("deploy", `Rent guard: ${totalSolAmount} SOL + ~${fit.overhead.toFixed(4)} rent/fees (${totalBins} bins) would dip into the ${reserve} SOL gas reserve (free ${freeSol.toFixed(4)}); deploying ${fit.amount} SOL instead`);
        totalSolAmount = fit.amount;
        amount_y = fit.amount;
      }
    } catch (e) {
      log("deploy_warn", `Rent guard skipped (balance read failed: ${e.message}); sizing already reserved worst-case rent`);
    }
  }
  // ─── Entry-safety hard checks (config.entryFilters) ───────────
  // Before any swap or tx is built, on every deploy path (screener, agent,
  // manual Telegram deploys). Token facts come from the pool's own TokenReserve
  // (the SDK read the mint at DLMM.create), so this adds no mint RPC.
  {
    const { runDeployEntryChecks } = await import("./entry-safety.js");
    const entry = await runDeployEntryChecks({ pool, pool_address, strategy: activeStrategy, wallet: wallet.publicKey });
    if (!entry.pass) {
      log("deploy", `Refusing deploy into ${pool_address}: ${entry.reason}`);
      return { success: false, blocked_by: "entry_filter", error: entry.reason };
    }
    for (const note of entry.notes || []) log("deploy", `Entry check: ${note}`);
  }
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

  // ─── Fresh active bin, one snapshot for range AND build ────────
  // initializePositionAndAddLiquidityByStrategy (≤69 bins) anchors the deposit
  // and its bin-slippage check to this.lbPair.activeId, which getActiveBin()
  // does NOT refresh. Refetch right before computing the range (this is also
  // after any auto-swap, which can move this very pool) and derive the range
  // from pool.lbPair.activeId, so the range and the SDK build share one state.
  await pool.refetchStates();
  const activeBin = { binId: pool.lbPair.activeId };
  if (activeBin.binId !== activeIdAtLoad) {
    log("deploy", `Active bin moved ${activeIdAtLoad} → ${activeBin.binId} since pool load${needsAutoSwap ? " (after auto-swap)" : ""}; using the fresh bin`);
  }

  // Range calculation
  let minBinId = activeBin.binId - activeBinsBelow;
  let maxBinId = activeBin.binId + activeBinsAbove;

  // ─── Never pay for new bin arrays ─────────────────────────────
  // Initializing a bin array costs ~0.0714 SOL of rent that is never refunded
  // (there is no close path), i.e. ~6.5% of a 1.1 SOL position. Only deploy
  // into already-initialized bin arrays: trim the range to the contiguous
  // initialized window around the active bin, or refuse if that window no
  // longer meets MIN_BINS / MIN_RANGE_PCT. Runs before any deploy tx is built.
  // (The two-sided auto-swap above only runs for two-sided spot, which is gated.)
  if (!(config.management.allowBinArrayInit ?? false)) {
    const w = await initializedBinArrayWindow(pool, minBinId, maxBinId, activeBin.binId);
    if (w.missing.length > 0) {
      if (w.min == null) {
        log("deploy", `Refusing deploy into ${pool_address}: range needs uninitialized bin arrays ${w.missing.join(",")} (rent is non-refundable)`);
        return { success: false, error: `Range needs new bin arrays (${w.missing.length} × ~0.0714 SOL non-refundable rent) and no initialized window exists around the active bin. Not deployed.` };
      }
      const newBelow = Math.max(0, activeBin.binId - w.min);
      const newAbove = Math.max(0, w.max - activeBin.binId);
      const newTotal = newBelow + newAbove;
      const stepPct = (resolvedBinStep || 0) / 10_000;
      const newRangePct = stepPct > 0 ? (1 - Math.pow(1 + stepPct, -Math.max(newBelow, newAbove))) * 100 : 0;
      if (newTotal < MIN_BINS || (stepPct > 0 && newRangePct < MIN_RANGE_PCT)) {
        log("deploy", `Refusing deploy into ${pool_address}: only ${newTotal} bins (${newRangePct.toFixed(1)}%) are in initialized bin arrays; minimum is ${MIN_BINS} bins / ${MIN_RANGE_PCT}%`);
        return { success: false, error: `Only ${newTotal} bins (${newRangePct.toFixed(1)}% range) fall in already-initialized bin arrays — below the ${MIN_BINS}-bin / ${MIN_RANGE_PCT}% minimum. Not deployed (won't pay non-refundable bin-array rent).` };
      }
      log("deploy", `Trimmed range to initialized bin arrays: ${minBinId}..${maxBinId} → ${w.min}..${w.max} (${totalBins} → ${newTotal} bins, ~${newRangePct.toFixed(1)}%); avoided ${w.missing.length} new bin array(s)`);
      minBinId = w.min;
      maxBinId = w.max;
      activeBinsBelow = newBelow;
      activeBinsAbove = newAbove;
      totalBins = newTotal;
    }
  }

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
  // USD value at deploy, for PnL history. The screener passes it; manual Telegram
  // deploys don't, which left it 0 and made the close fall back to the final
  // value (PnL 0%). Estimate it from the SOL committed (before any auto-swap).
  if (!(Number(initial_value_usd) > 0)) {
    const solCommitted = totalSolAmount > 0 ? totalSolAmount : finalAmountY;
    try {
      const solPrice = (await getWalletBalances()).sol_price || 0;
      if (solPrice > 0 && solCommitted > 0) {
        initial_value_usd = Math.round(solCommitted * solPrice * 100) / 100;
        log("deploy", `initial_value_usd not provided — estimated $${initial_value_usd} (${solCommitted} SOL × $${solPrice})`);
      }
    } catch { /* best-effort; the close path still has a fallback */ }
  }
  const finalAmountX = amount_x ?? 0;

  // Decimal-safe UI -> raw integer BN (string-based; avoids JS float precision
  // loss that Math.floor(amount * 10**decimals) suffers for some token amounts).
  const uiToRawBN = (amount, decimals) => {
    if (amount == null || !Number.isFinite(Number(amount))) return new BN(0);
    let s = typeof amount === "string" ? amount.trim() : Number(amount).toFixed(decimals);
    if (/[eE]/.test(s)) s = Number(s).toFixed(decimals); // expand scientific notation
    if (s.startsWith("-")) return new BN(0);
    const [whole = "0", frac = ""] = s.split(".");
    const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
    const raw = ((whole || "0") + fracPadded).replace(/^0+(?=\d)/, "");
    return new BN(raw === "" ? "0" : raw);
  };

  // Resolve decimals from the mints — do NOT assume token Y is 9-decimal SOL.
  // Correct for BOTH SOL mode and USDC mode: the agent deploys into SOL-quoted
  // pools in both, but we read the actual mint decimals so sizing is right for
  // any quote/base token (SOL=9, USDC=6, etc.).
  const getMintDecimals = async (mint) => {
    const info = await getConnection().getParsedAccountInfo(new PublicKey(mint));
    return info.value?.data?.parsed?.info?.decimals ?? null;
  };

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
        ...depthTrackFields(),
        ...getExperimentTag(),
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
        const { chunkBinRange } = await import("@meteora-ag/dlmm");
        const chunkRanges = chunkBinRange(minBinId, maxBinId);
        if (chunkRanges.length !== addTxArray.length) {
          // Unexpected SDK chunking: can't map txs to bins for reconcile, so
          // keep the old one-at-a-time behaviour.
          log("deploy_warn", `SDK returned ${addTxArray.length} add txs for ${chunkRanges.length} bin chunks — sending sequentially`);
          for (let i = 0; i < addTxArray.length; i++) {
            const txHash = await sendManagedTransaction(addTxArray[i], [wallet], `deploy add-liquidity ${i + 1}/${addTxArray.length}`);
            txHashes.push(txHash);
            log("deploy", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${txHash}`);
          }
        } else {
          // The chunkable builder makes self-contained txs for parallel use
          // (NoShrink modes, own ATA/wrap, own bin-array inits). Read-only
          // simulation confirmed they don't conflict: initialize_bin_array and
          // the bitmap-extension init both succeed on an already-initialized
          // account, and each chunk is valid in any order. So send them all at
          // once (each signed once, with its own rebroadcast + confirm): one
          // confirmation window instead of N, and every chunk is priced off
          // the same activeId.
          const readFunded = () => readChunkFunding(pool, newPosition.publicKey, chunkRanges);
          const results = await Promise.allSettled(addTxArray.map((tx, i) =>
            sendManagedTransaction(tx, [wallet], `deploy add-liquidity ${i + 1}/${addTxArray.length}`, {
              // Resend only if this chunk's bins are verified still empty.
              beforeResend: async () => (await readFunded())?.[i] === false,
            })));
          // Reconcile against the position on-chain, never against send
          // results alone: a "failed" chunk may have landed.
          const funded = await readFunded();
          const rec = reconcileChunkResults(results, funded);
          for (const i of rec.landed) {
            const r = results[i];
            if (r.status === "fulfilled") txHashes.push(r.value);
            log("deploy", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${r.status === "fulfilled" ? r.value : "confirm failed but its bins are funded on-chain"}`);
          }
          if (rec.failed.length || rec.unknown.length) {
            const why = [...rec.failed, ...rec.unknown].sort((a, b) => a - b)
              .map((i) => `chunk ${i + 1}/${addTxArray.length} (bins ${chunkRanges[i].lowerBinId}..${chunkRanges[i].upperBinId}) ${rec.failed.includes(i) ? "empty on-chain" : "unverified"}: ${results[i].reason?.message || results[i].reason}`);
            throw new Error(`${rec.failed.length + rec.unknown.length}/${addTxArray.length} add-liquidity chunk(s) did not land — ${why.join("; ")}`);
          }
        }
      } catch (liqErr) {
        // Liquidity add failed partway. Earlier chunks may already have landed
        // real liquidity, so re-read the position on-chain before deciding.
        // Only a VERIFIED-empty position is marked closed; a funded or
        // unverifiable one stays tracked as open so management / close logic
        // picks it up (a closed tracked entry is never auto-adopted, which
        // would orphan the funds). No retry here: resending chunks could
        // double-deploy.
        log("deploy_error", `Phase 2 (add liquidity) failed for ${posAddr.slice(0, 8)}: ${liqErr.message}`);
        const onchain = await readPositionAmounts(pool, newPosition.publicKey);

        if (onchain && onchain.empty) {
          // Reclaim the position account's rent (~0.06-0.1 SOL for wide ranges);
          // otherwise every failed deploy leaks it. closePositionIfEmpty is
          // enforced on-chain, so it can't close a position holding liquidity.
          try {
            const emptyPosition = await pool.getPosition(newPosition.publicKey);
            const closeTx = await pool.closePositionIfEmpty({ owner: wallet.publicKey, position: emptyPosition });
            const closeHash = await sendManagedTransaction(closeTx, [wallet], "close empty position after failed deploy");
            txHashes.push(closeHash);
            log("deploy", `Closed empty position ${posAddr.slice(0, 8)} to reclaim rent: ${closeHash}`);
          } catch (closeErr) {
            log("deploy_warn", `Could not close empty position ${posAddr.slice(0, 8)} (rent stays locked until closed): ${closeErr.message}`);
          }
          recordClose(posAddr, "deploy failed (liquidity add error, verified empty on-chain)");
          return {
            success: false,
            error: `Position created on-chain but liquidity add failed: ${liqErr.message}. Position ${posAddr.slice(0, 8)} verified empty on-chain and marked closed.`,
            position: posAddr,
            txs: txHashes,
          };
        }

        // Funded (partial) or unknown → keep it open with whatever landed.
        let partialX = null;
        let partialY = null;
        if (onchain) {
          try {
            const [xDec, yDec] = await Promise.all([
              getMintDecimals(pool.lbPair.tokenXMint),
              getMintDecimals(pool.lbPair.tokenYMint),
            ]);
            if (xDec != null) partialX = Number(onchain.rawX) / 10 ** xDec;
            if (yDec != null) partialY = Number(onchain.rawY) / 10 ** yDec;
          } catch { /* amounts stay null — still keep the position open */ }
        }
        // Pro-rate the planned USD value by the share of the planned deposit that landed.
        let partialUsd = null;
        if (onchain && initial_value_usd > 0) {
          const plannedY = Number(totalYLamports.toString());
          const plannedX = Number(totalXLamports.toString());
          const frac = plannedY > 0 ? Number(onchain.rawY) / plannedY
            : plannedX > 0 ? Number(onchain.rawX) / plannedX : null;
          if (frac != null && Number.isFinite(frac)) partialUsd = Math.round(initial_value_usd * Math.min(frac, 1) * 100) / 100;
        }
        const status = onchain ? "PARTIALLY FUNDED" : "UNVERIFIED (on-chain read failed)";
        const note = `Deploy liquidity add failed after ${txHashes.length} tx(s): ${liqErr.message}. On-chain: ${status}` +
          (onchain ? ` (X=${partialX ?? onchain.rawX}, Y=${partialY ?? onchain.rawY})` : "") +
          ". Left OPEN for management/close.";
        updateTrackedPosition(posAddr, {
          ...(partialY != null && { amount_sol: partialY }),
          ...(partialX != null && { amount_x: partialX }),
          ...(partialUsd != null && { initial_value_usd: partialUsd }),
          partial_deploy: true,
        }, note);
        _positionsCacheAt = 0;
        log("deploy_warn", `Position ${posAddr.slice(0, 8)} is ${status} — kept open for management/close. ${note}`);
        emit("deploy_partial", { pair: pool_name || pool_address.slice(0, 8), position: posAddr, status, amountX: partialX, amountY: partialY, error: liqErr.message });
        return {
          success: false,
          partial: true,
          error: `Position created on-chain but liquidity add failed partway: ${liqErr.message}. Position ${posAddr.slice(0, 8)} is ${status} and has been kept OPEN — manage or close it; do NOT redeploy to "retry".`,
          position: posAddr,
          amount_x: partialX,
          amount_y: partialY,
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
      ...depthTrackFields(),
      ...getExperimentTag(), // autoresearch A/B arm, when deployed inside one
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
const RECENT_DEPLOY_MS = 5 * 60_000;   // a deploy this recent may not be on the RPC scan yet
const SHORT_CACHE_MS = 10_000;         // cache an incomplete scan only this long

let _positionsCache = null;
let _positionsCacheAt = 0;
let _positionsInflight = null; // deduplicates concurrent calls

// ─── Fetch DLMM PnL API for all positions in a pool ────────────
async function fetchDlmmPnlForPool(poolAddress, walletAddress) {
  const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&page_size=100&page=1`; // snake_case: `pageSize` is ignored (API default 20)
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("pnl_api", `HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}: ${body.slice(0, 120)}`);
      return {};
    }
    const data = await res.json();
    const positions = data.positions || data.data || [];
    if (data.hasNext) {
      log("pnl_api", `Pool ${poolAddress.slice(0, 8)} has more than ${positions.length} open positions for this wallet — only the first page was read`);
    }
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
 * Returns null on 429, fetch error, no API keys configured, or an exhausted
 * per-minute key budget (triggers Meteora fallback).
 */
async function fetchLpAgentOpenPositions(walletAddress) {
  // Return cached result if fresh
  if (_lpaCache && Date.now() - _lpaCacheAt < LPA_CACHE_TTL) {
    return _lpaCache;
  }

  // Non-blocking: when the LPAgent per-minute budget is spent, return null so
  // the caller (PnL watcher, close snapshot) uses Meteora instead of sleeping.
  const apiKey = await getLpaKey({ wait: false });
  if (!apiKey) return null;

  try {
    const res = await fetch(
      `${LPAGENT_API}/lp-positions/opening?owner=${walletAddress}&platform=meteora`,
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
    pnlPctChange: lpa.pnl?.percent ?? null,
    pnlSolPctChange: lpa.pnl?.percentNative ?? null,
    createdAt: lpa.createdAt
      ? (typeof lpa.createdAt === "number" ? lpa.createdAt : new Date(lpa.createdAt).getTime() / 1000)
      : null,
    unrealizedPnl: {
      // LP Agent returns token amounts, not USD — convert using prices
      unclaimedFeeTokenX: { usd: parseFloat(lpa.unCollectedFee0 || 0) * (lpa.price0 || 0) },
      unclaimedFeeTokenY: { usd: parseFloat(lpa.unCollectedFee1 || 0) * (lpa.price1 || 0) },
      // `value` (number) is the live position value in USD and reconciles with
      // pnl.value; `currentValue` (string) does not. Fall back to it only.
      balances: lpaCurrentValueUsd(lpa),
    },
    allTimeFees: {
      total: { usd: lpa.collectedFee ?? 0 },
    },
    allTimeDeposits: {
      total: { usd: lpa.inputValue ?? 0 },
      // current.amount0 is a RAW base-unit string; amount0Adjusted is UI units,
      // matching the Meteora path. Note it is the current X holding, not the
      // original deposit (LPAgent only exposes that via /lp-positions/position).
      tokenX: { amount: lpa.current?.amount0Adjusted ?? 0 },
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

/**
 * PnL % from a PnL record (Meteora or normalized LP Agent), or null when it is
 * unknown (no record, missing or non-numeric field). NEVER coerce missing data
 * to 0: a fake 0% can fire a trailing TP on an API hiccup and hides stop-loss.
 */
function readPnlPct(p) {
  if (!p) return null;
  const raw = config.management.pnlUnit === "sol" ? p.pnlSolPctChange : p.pnlPctChange;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
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
    const pnlPct          = readPnlPct(p);
    const pnlUnknown      = pnlPct == null;
    const pnlUsdVal       = pnlUnknown ? null : Math.round(Number(p.pnlUsd ?? 0) * 100) / 100;
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
      pnl_sol:           pnlUnknown ? null : toSol(pnlUsdVal),
      pnl_pct:           pnlPct,
      ...(pnlUnknown && { pnl_unknown: true, pnl_error: "PnL % missing from PnL API response" }),
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

// ─── Position account discovery ────────────────────────────────
// The PnL watcher refreshes positions every 30s. A full getProgramAccounts
// on the DLMM program (no discriminator filter, full ~8 KB+ PositionV2 data)
// every tick was the bot's most expensive RPC call. Now each refresh is one
// getMultipleAccountsInfo over the positions we already know (tracked open +
// last scan), sliced to the 72-byte header, and the filtered scan that finds
// untracked positions runs at most every 5 minutes.
const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
// Anchor discriminator of the PositionV2 account (IDL). LimitOrder accounts
// share the lb_pair@8 / owner@40 layout but have a different discriminator.
const POSITION_V2_DISCRIMINATOR = Buffer.from("75b0d4c7f5b485b6", "hex");
const POSITION_HEAD_LEN = 72; // discriminator(8) + lb_pair(32) + owner(32)
const POSITION_DISCOVERY_INTERVAL_MS = 5 * 60_000;
let _knownPositionAccounts = new Map(); // position → lb_pair, from the last discovery scan
let _lastPositionDiscoveryAt = 0;

function positionAccountFilters(owner) {
  return [
    { memcmp: { offset: 0, bytes: bs58.encode(POSITION_V2_DISCRIMINATOR) } },
    { memcmp: { offset: 40, bytes: owner.toBase58() } },
  ];
}

/** lb_pair of a PositionV2 account owned by `owner`, or null (closed / not a position / not ours). */
function positionHeadPool(info, owner) {
  if (!info?.data || !info.owner?.equals?.(DLMM_PROGRAM_ID)) return null;
  const d = Buffer.from(info.data);
  if (d.length < POSITION_HEAD_LEN) return null;
  if (!d.subarray(0, 8).equals(POSITION_V2_DISCRIMINATOR)) return null;
  if (!d.subarray(40, 72).equals(owner.toBuffer())) return null;
  return new PublicKey(d.subarray(8, 40)).toBase58();
}

/**
 * The wallet's open DLMM position accounts → [{ position, pool }].
 * @param {PublicKey} owner
 * @param {object} [opts]
 * @param {boolean} [opts.discover] force the filtered getProgramAccounts scan
 * @param {string[]} [opts.trackedOpen] tracked open positions (default: state.json)
 * @param {number} [opts.now]
 */
async function listPositionAccounts(owner, { discover = false, trackedOpen = null, now = Date.now() } = {}) {
  const connection = getConnection();
  if (discover || now - _lastPositionDiscoveryAt >= POSITION_DISCOVERY_INTERVAL_MS) {
    const accs = await connection.getProgramAccounts(DLMM_PROGRAM_ID, {
      filters: positionAccountFilters(owner),
      dataSlice: { offset: 0, length: POSITION_HEAD_LEN },
    });
    const found = new Map();
    for (const a of accs) {
      const pool = positionHeadPool({ owner: DLMM_PROGRAM_ID, data: a.account.data }, owner);
      if (pool) found.set(a.pubkey.toBase58(), pool);
    }
    _knownPositionAccounts = found;
    _lastPositionDiscoveryAt = now;
    return [...found].map(([position, pool]) => ({ position, pool }));
  }

  const tracked = trackedOpen ?? getTrackedPositions(true).map((p) => p.position);
  const keys = [...new Set([...tracked, ..._knownPositionAccounts.keys()])];
  if (keys.length === 0) return [];
  const infos = [];
  for (let i = 0; i < keys.length; i += 100) { // getMultipleAccounts takes ≤100 keys
    const batch = keys.slice(i, i + 100).map((k) => new PublicKey(k));
    infos.push(...await connection.getMultipleAccountsInfo(batch, { dataSlice: { offset: 0, length: POSITION_HEAD_LEN } }));
  }
  const out = [];
  keys.forEach((position, i) => {
    const pool = positionHeadPool(infos[i], owner);
    if (pool) {
      out.push({ position, pool });
      _knownPositionAccounts.set(position, pool);
    } else {
      _knownPositionAccounts.delete(position); // closed, or not a position of ours
    }
  });
  return out;
}

/** Test seam: forget discovery state so the next call scans (or not, with `at`). */
export function _resetPositionDiscoveryForTest({ at = 0, known = [] } = {}) {
  _lastPositionDiscoveryAt = at;
  _knownPositionAccounts = new Map(known);
}
export { listPositionAccounts as _listPositionAccountsForTest };

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
    const walletPubkey = new PublicKey(walletAddress);
    const accounts = await listPositionAccounts(walletPubkey);
    log("positions", `Found ${accounts.length} position account(s)`);

    // Collect raw (pool, position) pairs
    const raw = [];
    for (const { position: positionAddress, pool: lbPairKey } of accounts) {
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
        ? import("./lp-overview.js").then((m) => m.fetchHistoricalPositionMap({ wait: false })).catch(() => new Map())
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
      if (activeBin != null) recordActiveBin(r.position, activeBin);

      const unclaimedFees = p ? (parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) : 0;
      const totalValue    = p ? parseFloat(p.unrealizedPnl?.balances || 0) : 0;
      const collectedFees = p ? parseFloat(p.allTimeFees?.total?.usd || 0) : 0;
      // null = unknown (PnL APIs failed / not indexed yet). Consumers must take
      // no PnL-based exit action on a null tick.
      const pnlPct        = readPnlPct(p);
      const pnlUnknown    = pnlPct == null;
      const pnlUsd        = pnlUnknown ? null : Number(p?.pnlUsd ?? 0);
      if (pnlUnknown) {
        log("pnl_api", `PnL unknown for ${r.position.slice(0, 8)} (${p ? "no pnl % in response" : "no PnL data from LP Agent or Meteora"}) — reporting pnl_pct=null`);
      }

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

      const pnlUsdRounded = pnlUnknown ? null : Math.round(pnlUsd * 100) / 100;
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
        pnl_sol: pnlUnknown ? null : toSol(pnlUsdRounded),
        pnl_pct: pnlPct,
        ...(pnlUnknown && { pnl_unknown: true, pnl_error: p ? "PnL % missing from PnL API response" : "PnL data unavailable (LP Agent + Meteora PnL API)" }),
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
    // A position deployed in the last few minutes can be missing from the RPC
    // scan (it lags the confirmed tx). Don't pin that incomplete result for the
    // full TTL: expire it in ~10s so the next read picks the new position up.
    const seen = new Set(positions.map((p) => p.position));
    const lagging = getTrackedPositions(true).filter((t) =>
      t?.position && !seen.has(t.position) && Date.now() - Date.parse(t.deployed_at || 0) < RECENT_DEPLOY_MS);
    if (lagging.length) {
      _positionsCacheAt = Date.now() - POSITIONS_CACHE_TTL + SHORT_CACHE_MS;
      log("positions", `${lagging.length} just-deployed position(s) not visible on RPC yet (${lagging.map((t) => t.position.slice(0, 8)).join(", ")}) — rescanning in ${SHORT_CACHE_MS / 1000}s`);
    }
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
      filters: positionAccountFilters(new PublicKey(wallet_address)),
      dataSlice: { offset: 0, length: POSITION_HEAD_LEN },
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
        pnl_usd:            readPnlPct(p) == null ? null : Math.round(Number(p.pnlUsd ?? 0) * 100) / 100,
        pnl_pct:            readPnlPct(p),
        ...(readPnlPct(p) == null && { pnl_unknown: true }),
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
  const pageSize = Math.min(Math.max(1, Math.floor(Number(limit) || 10)), 1000);
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(query)}&page_size=${pageSize}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool search API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const pools = (Array.isArray(data) ? data : data.data || []).slice(0, pageSize);
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  // Field names per the Data API PoolResponse schema (dlmm.datapi.meteora.ag
  // OpenAPI): pool_config.{bin_step,base_fee_pct}, tvl, volume["24h"], and
  // token_x/token_y objects. The legacy names (bin_step, liquidity,
  // trade_volume_24h, mint_x...) no longer exist and came back null.
  return {
    query,
    total: data.total ?? pools.length,
    pools: pools.map((p) => ({
      pool: p.address,
      name: p.name,
      bin_step: num(p.pool_config?.bin_step),
      fee_pct: num(p.pool_config?.base_fee_pct),
      tvl: num(p.tvl),
      volume_24h: num(p.volume?.["24h"]),
      fee_tvl_ratio_24h: num(p.fee_tvl_ratio?.["24h"]), // % of TVL, already net of protocol fee
      token_x: { symbol: p.token_x?.symbol ?? null, mint: p.token_x?.address ?? null },
      token_y: { symbol: p.token_y?.symbol ?? null, mint: p.token_y?.address ?? null },
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
    // What this claim takes out, valued now (before the tx) so on-chain PnL can
    // add it back: getOnchainPnl reads total_fees_claimed_sol.
    const claimed = claimedFeesValue(pool, positionData, position_address);

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
    recordClaim(position_address, claimed?.usd ?? undefined, claimed?.sol ?? undefined);
    if (claimed) log("claim", `Claimed ≈ ${claimed.sol} SOL${claimed.usd != null ? ` (~$${claimed.usd})` : ""} of fees`);

    return {
      success: true,
      position: position_address,
      tx: txHash,
      ...(claimed && { claimed_fees: { sol: claimed.sol, usd: claimed.usd } }),
    };
  } catch (error) {
    log("claim_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Close Position ────────────────────────────────────────────
/** True while a close for this position is running (any caller). */
export function isCloseInflight(position_address) {
  return closeInflight.has(normalizeMint(position_address));
}

// _close_reason: internal override for the recorded close reason (code-driven
// closes such as the OOR fallback); the LLM-facing tool schema does not expose it.
export async function closePosition({ position_address, _pnlOverride = null, _close_reason = null }) {
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
    // Read on-chain (raw units, `confirmed`), not from the Helius indexed
    // balances API: that one lags, and on error returns tokens: [], which read
    // as a zero balance.
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const baseMintPre = getTrackedPosition(position_address)?.base_mint || null;
    let preCloseBaseRaw = null; // bigint; null => unknown (do NOT swap whole balance)
    let expectedBaseRaw = null; // bigint; null => unknown
    if (baseMintPre && baseMintPre !== SOL_MINT) {
      try {
        preCloseBaseRaw = (await getOnchainTokenBalance(baseMintPre)).raw;
      } catch (preErr) {
        log("close_warn", `Could not snapshot pre-close base balance for ${baseMintPre}: ${preErr.message}`);
        preCloseBaseRaw = null;
      }
      // Position X liquidity + claimable X fees: what the remove txs should return.
      expectedBaseRaw = expectedBaseWithdrawRaw(pool, positionData, baseMintPre);
    }

    // ─── Snapshot PnL BEFORE closing (position is still on-chain) ───
    // If PnL watcher provided an override (the value that triggered the close), trust it
    // over the cache which may have been refreshed with stale/wrong API data
    // pnlPct/pnlUsd stay null when PnL is unknown — never record a fake 0%.
    let pnlUsd = _pnlOverride?.pnl_usd ?? null;
    let pnlPct = _pnlOverride?.pnl_pct ?? null;
    let finalValueUsd = _pnlOverride?.total_value_usd ?? 0;
    let feesUsd = 0;
    let unclaimedFeesUsd = null; // USD value of the fees the remove txs will claim (null = unknown)
    const trackedPre = getTrackedPosition(position_address);
    feesUsd = trackedPre?.total_fees_claimed_usd || 0;

    if (_pnlOverride) {
      // PnL watcher already gave us accurate numbers at the moment it decided to close
      feesUsd = (_pnlOverride.collected_fees_usd || 0) + (_pnlOverride.unclaimed_fees_usd || 0) || feesUsd;
      unclaimedFeesUsd = _pnlOverride.unclaimed_fees_usd ?? null;
      log("close", `Using PnL override from watcher: ${pnlPct}% ($${pnlUsd})`);
    } else {
      // No override — snapshot from cache or fresh API
      const cachedPos = _positionsCache?.positions?.find(p => p.position === position_address);
      if (cachedPos) {
        pnlUsd        = cachedPos.pnl_usd   ?? null;
        pnlPct        = cachedPos.pnl_pct   ?? null;
        finalValueUsd = cachedPos.total_value_usd ?? 0;
        feesUsd       = (cachedPos.collected_fees_usd || 0) + (cachedPos.unclaimed_fees_usd || 0);
        unclaimedFeesUsd = cachedPos.unclaimed_fees_usd ?? null;
      }
      if (pnlPct == null) {
      // No cache, or cached PnL was unknown — fetch fresh from API while position is still open
      try {
        const freshPnl = await getPositionPnl({ pool_address: poolAddress, position_address });
        if (freshPnl && !freshPnl.error && freshPnl.pnl_pct != null) {
          pnlUsd        = freshPnl.pnl_usd   ?? null;
          pnlPct        = freshPnl.pnl_pct;
          finalValueUsd = freshPnl.current_value_usd ?? 0;
          feesUsd       = (freshPnl.all_time_fees_usd || 0) + (freshPnl.unclaimed_fee_usd || 0);
          unclaimedFeesUsd = freshPnl.unclaimed_fee_usd ?? null;
        }
      } catch (e) {
        log("close_warn", `Could not snapshot PnL before close: ${e.message}`);
      }
    }
    } // end of !_pnlOverride

    // ─── On-chain PnL wins over the PnL API when it can be read ───
    // The APIs misreport young positions (e/acc-SOL recorded +7.4% on a flat
    // close). positionData and the freshly loaded pool are already in hand, so
    // this costs no extra RPC. The watcher's override is already on-chain based
    // when it carries pnl_source "onchain".
    if (_pnlOverride?.pnl_source !== "onchain" && trackedPre) {
      try {
        const cachedSolPrice = _positionsCache?.positions?.find((p) => p.position === position_address)?.sol_price;
        const activeId = Number(pool.lbPair?.activeId);
        const oc = Number.isFinite(activeId)
          ? computeOnchainPnl({
            pool,
            positionData: positionData?.positionData,
            activePrice: binPrice(activeId, pool.lbPair?.binStep, pool.tokenX?.mint?.decimals, pool.tokenY?.mint?.decimals),
            tracked: trackedPre,
            solPriceUsd: cachedSolPrice,
          })
          : null;
        const ocPct = oc ? onchainPctForUnit(oc, config.management.pnlUnit) : null;
        if (ocPct != null) {
          const initialUsd = Number(trackedPre.initial_value_usd) || 0;
          log("close", `On-chain PnL ${ocPct}% (value ${oc.valueSol} + fees ${oc.feesSol} SOL vs deposit ${oc.depositSol} SOL) replaces API ${pnlPct ?? "unknown"}%`);
          pnlPct = ocPct;
          if (initialUsd > 0) {
            pnlUsd = Math.round(initialUsd * ocPct) / 100;
            finalValueUsd = Math.round((initialUsd + pnlUsd) * 100) / 100;
          } else if (Number(cachedSolPrice) > 0) {
            pnlUsd = Math.round(oc.pnlSol * Number(cachedSolPrice) * 100) / 100;
          }
        }
      } catch (e) {
        log("close_warn", `On-chain PnL snapshot failed, keeping API PnL: ${e.message}`);
      }
    }

    const txHashes = [];

    // ─── Unclaimed fees, read BEFORE removal ───────────────────
    // There is no separate claim pass: removeLiquidity({ shouldClaimAndClose })
    // puts claimFee2 (+ claimReward2 per farm reward) and closePositionIfEmpty
    // in every chunk, so a claim tx first only duplicated work (one extra tx
    // per 70 bins, each paying fees and able to expire). The amounts the remove
    // txs claim are read from the position data now, while it still holds them.
    // PnL / fees_earned_usd come from the snapshot above (taken before any tx)
    // and the post-close swap uses the pre-close balance delta, which includes
    // the claimed X fees, so neither depended on the old claim pass.
    const claimedAtClose = readUnclaimedFees(pool, positionData);
    if (claimedAtClose) {
      log("close", `Unclaimed fees claimed by the remove txs: X=${claimedAtClose.x} Y=${claimedAtClose.y}${unclaimedFeesUsd != null ? ` (~$${Number(unclaimedFeesUsd).toFixed(2)})` : ""}`);
    }

    // ─── Remove Liquidity, claim fees & rewards, close ─────────
    log("close", `Removing liquidity, claiming fees and closing account`);
    try {
      const closeTx = await pool.removeLiquidity({
        user: wallet.publicKey,
        position: positionPubKey,
        fromBinId: -887272,
        toBinId: 887272,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });

      // Remove chunks cover disjoint bin ranges and each ends with
      // closePositionIfEmpty (a no-op until the position is empty), so the
      // last one to land closes the account. Simulation confirmed each is
      // valid in any order, so send them concurrently. The account-gone check
      // below still decides success.
      const removeTxs = Array.isArray(closeTx) ? closeTx : [closeTx];
      const results = await Promise.allSettled(removeTxs.map((tx, i) =>
        sendManagedTransaction(tx, [wallet], `close remove liquidity ${i + 1}/${removeTxs.length}`)));
      for (const r of results) if (r.status === "fulfilled") txHashes.push(r.value);
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length) {
        const gone = (await getConnection().getAccountInfo(positionPubKey).catch(() => undefined)) === null;
        if (!gone) {
          // Not closed: fail this attempt (no blind resend). The next close
          // rebuilds from on-chain state, so it only removes what is left.
          throw new Error(`${failed.length}/${removeTxs.length} remove-liquidity tx(s) failed: ${failed.map((r) => r.reason?.message || r.reason).join("; ")}`);
        }
        log("close_warn", `${failed.length}/${removeTxs.length} remove tx(s) reported failure but the position account is closed`);
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
      let feesOnly = false;     // no liquidity left, but unclaimed fees/rewards remain
      let freshPositionData = positionData;
      const readZombieState = async () => {
        try { await pool.refetchStates(); } catch { /* best-effort */ }
        freshPositionData = await pool.getPosition(positionPubKey);
        const pd = freshPositionData?.positionData || {};
        const binData = pd.positionBinData || [];
        const num = (v) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
        const liquidity = num(pd.totalXAmount) > 0 || num(pd.totalYAmount) > 0 ||
          binData.some((b) => num(b.positionXAmount) > 0 || num(b.positionYAmount) > 0);
        const feesOrRewards = num(pd.feeX) > 0 || num(pd.feeY) > 0 || num(pd.rewardOne) > 0 || num(pd.rewardTwo) > 0;
        return { liquidity, feesOrRewards };
      };
      try {
        const st = await readZombieState();
        verifiedEmpty = !st.liquidity && !st.feesOrRewards;
        feesOnly = !st.liquidity && st.feesOrRewards;
      } catch (verifyErr) {
        verifiedEmpty = null; // verification unavailable — keep prior behavior
        log("close_warn", `Zombie-empty verification could not run: ${verifyErr.message}`);
      }

      if (feesOnly) {
        // No liquidity left but fees/rewards still owed: closePositionIfEmpty
        // would be a no-op. Claim them (the only case that still needs a
        // separate claim), then re-verify before closing.
        log("close", `Zombie position has no liquidity but unclaimed fees/rewards — claiming before close`);
        const claimTxs = await pool.claimAllRewardsByPosition({ owner: wallet.publicKey, position: freshPositionData });
        for (const tx of Array.isArray(claimTxs) ? claimTxs : [claimTxs]) {
          txHashes.push(await sendManagedTransaction(tx, [wallet], "close zombie claim"));
        }
        const st = await readZombieState();
        verifiedEmpty = !st.liquidity && !st.feesOrRewards;
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
    const closeReason = typeof _close_reason === "string" && _close_reason.trim()
      ? _close_reason.trim().slice(0, 120)
      : oorDir ? `agent decision (OOR ${oorDir})` : "agent decision";
    if (claimedAtClose) {
      const v = claimedFeesValue(pool, positionData, position_address);
      recordClaim(position_address, unclaimedFeesUsd ?? v?.usd ?? undefined, v?.sol ?? undefined);
    }
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

      // Unknown PnL: let recordPerformance derive it from final vs initial value
      // when we have a real final value; otherwise record 0 but flag it, so the
      // record isn't mistaken for a measured break-even (and never -100%).
      const pnlUnknownAtClose = pnlPct == null;
      const canDerivePnl = pnlUnknownAtClose && finalValueUsd > 0 && initialUsd > 0;
      if (pnlUnknownAtClose) {
        log("close_warn", `PnL unknown at close for ${position_address.slice(0, 8)} — ${canDerivePnl ? "deriving from final/initial value" : "recording 0 with pnl_unknown flag"}`);
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
        actual_pnl_usd: pnlUnknownAtClose ? (canDerivePnl ? null : 0) : (pnlUsd ?? 0),
        actual_pnl_pct: pnlUnknownAtClose ? (canDerivePnl ? null : 0) : pnlPct,
        ...(pnlUnknownAtClose && { pnl_unknown: true }),
        minutes_in_range: minutesHeld - minutesOOR,
        minutes_held: minutesHeld,
        close_reason: closeReason,
        ...depthUseAtClose(tracked, closeReason),
        deployed_at: tracked.deployed_at,
        signal_snapshot: tracked.signal_snapshot || null,
        ...(tracked.experiment_id && { experiment_id: tracked.experiment_id, experiment_arm: tracked.experiment_arm }),
      });

      // ─── Hard rule: swap ONLY the withdrawn base token back to SOL ───
      // Sells only the delta this close added (on-chain post - pre, polled
      // until it shows up), clamped to the expected withdrawal when known.
      // Rules and retries live in tools/close-swap.js.
      const baseMint = tracked.base_mint;
      let swapOutcome = null;     // { success, mint, attempts, error? } when a swap was attempted
      let exposureFlag = false;   // true when withdrawn base token may remain unsold

      if (baseMint && baseMint !== SOL_MINT) {
        const sb = await swapBackWithdrawnBase({
          baseMint,
          symbol: tracked.pool_name?.split("-")[0] || null,
          preRaw: preCloseBaseRaw,
          expectedRaw: expectedBaseRaw,
        });
        txHashes.push(...sb.txs);
        swapOutcome = sb.swapOutcome;
        exposureFlag = sb.exposureFlag;
      }

      return {
        success: true,
        ...(exposureFlag && { status: "success_with_exposure" }),
        position: position_address,
        pool: poolAddress,
        txs: txHashes,
        pnl_usd: pnlUsd,
        pnl_pct: pnlPct,
        ...(claimedAtClose && { claimed_fees: { ...claimedAtClose, usd: unclaimedFeesUsd } }),
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

// ─── Helpers ──────────────────────────────────────────────────
/**
 * Per-chunk funding of a position, read on-chain in one call: for each
 * { lowerBinId, upperBinId } range, true if any of its bins holds liquidity,
 * false if all are empty. Returns null when the read fails (unknown).
 */
async function readChunkFunding(pool, positionPubKey, ranges) {
  try {
    const pd = (await pool.getPosition(positionPubKey))?.positionData;
    if (!pd) return null;
    const bins = pd.positionBinData || [];
    const has = (b) => Number(b.positionXAmount || 0) > 0 || Number(b.positionYAmount || 0) > 0;
    return ranges.map(({ lowerBinId, upperBinId }) =>
      bins.some((b) => b.binId >= lowerBinId && b.binId <= upperBinId && has(b)));
  } catch (e) {
    log("deploy_warn", `Could not read chunk funding for ${positionPubKey.toString().slice(0, 8)}: ${e.message}`);
    return null;
  }
}

/**
 * Reconcile concurrently sent chunks with the on-chain read.
 * @param {PromiseSettledResult[]} results  one per chunk
 * @param {boolean[]|null} funded  per chunk from readChunkFunding (null = read failed)
 * @returns {{ landed: number[], failed: number[], unknown: number[] }}
 *   landed  — confirmed, or rejected but its bins are funded (landed anyway);
 *   failed  — rejected AND its bins verified empty (safe to report as not deployed);
 *   unknown — rejected and the read failed (treat as possibly funded).
 */
export function reconcileChunkResults(results, funded) {
  const out = { landed: [], failed: [], unknown: [] };
  results.forEach((r, i) => {
    if (r.status === "fulfilled") out.landed.push(i);
    else if (funded?.[i] === true) out.landed.push(i);
    else if (funded?.[i] === false) out.failed.push(i);
    else out.unknown.push(i);
  });
  return out;
}

/**
 * SOL / USD value of a position's unclaimed fees (what a claim, or the remove
 * txs at close, will take out). Price: the pool's active bin; SOL price from
 * the positions cache. Null when it can't be valued. Never throws.
 */
function claimedFeesValue(pool, position, position_address) {
  try {
    const activeId = Number(pool?.lbPair?.activeId);
    if (!Number.isFinite(activeId)) return null;
    const v = feesValue({
      pool,
      positionData: position?.positionData,
      activePrice: binPrice(activeId, pool.lbPair?.binStep, pool.tokenX?.mint?.decimals, pool.tokenY?.mint?.decimals),
      solPriceUsd: _positionsCache?.positions?.find((p) => p.position === position_address)?.sol_price ?? null,
    });
    return v && v.sol > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Unclaimed fees (UI units) and raw LM rewards held by a position, from the
 * SDK's LbPosition data. Returns null when there is nothing to claim or the
 * amounts can't be read.
 */
function readUnclaimedFees(pool, position) {
  try {
    const pd = position?.positionData;
    if (!pd) return null;
    const ui = (v, dec) => {
      const n = Number(String(v ?? 0));
      return Number.isFinite(n) && Number.isInteger(dec) ? n / 10 ** dec : null;
    };
    const x = ui(pd.feeX, pool?.tokenX?.mint?.decimals);
    const y = ui(pd.feeY, pool?.tokenY?.mint?.decimals);
    if (x == null || y == null) return null;
    const r1 = String(pd.rewardOne ?? 0);
    const r2 = String(pd.rewardTwo ?? 0);
    const hasRewards = r1 !== "0" || r2 !== "0";
    if (x === 0 && y === 0 && !hasRewards) return null;
    return { x, y, ...(hasRewards && { reward_one_raw: r1, reward_two_raw: r2 }) };
  } catch {
    return null;
  }
}

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

// Exposed for read-only verification scripts/tests (never sends anything).
export { applyPriorityFee as _applyPriorityFeeForTest };
export { sendManagedTransaction as _sendManagedTransactionForTest };
export { initializedBinArrayWindow as _initializedBinArrayWindowForTest };
// Read-only access for the re-center shadow log (tools/recenter-shadow.js).
export { getPool as getPoolForRead, initializedBinArrayWindow };

/** Test hook: seed the pool cache with a mock DLMM instance. */
const _poolOverridesForTest = new Map(); // test seam only; production never populates it
export function _setPoolForTest(poolAddress, pool) {
  if (pool == null) { poolCache.delete(String(poolAddress)); _poolOverridesForTest.delete(String(poolAddress)); }
  else { poolCache.set(String(poolAddress), pool); _poolOverridesForTest.set(String(poolAddress), pool); }
}

export { readChunkFunding as _readChunkFundingForTest };

/**
 * Test seam only: swap in a mock connection / wallet (pass null to restore the
 * lazy defaults). Production code never calls this.
 */
export function _setDlmmTestDeps({ connection, wallet } = {}) {
  if (connection !== undefined) _connection = connection;
  if (wallet !== undefined) _wallet = wallet;
}
