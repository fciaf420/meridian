import {
  Connection,
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
import { normalizeMint, getWalletBalances } from "./wallet.js";

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

// ─── Pool Cache ────────────────────────────────────────────────
const poolCache = new Map();

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
  // optional pool metadata for learning (passed by agent when available)
  pool_name,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
}) {
  pool_address = normalizeMint(pool_address);
  const activeStrategy = strategy || config.strategy.strategy;

  if (!["bid_ask", "spot"].includes(activeStrategy)) {
    throw new Error("Only 'bid_ask' or 'spot' strategies are allowed.");
  }

  const activeBinsBelow = bins_below ?? config.strategy.binsBelow;
  // For spot: only mirror bins if depositing base token (amount_x > 0), otherwise SOL-only = below only
  const hasBaseToken = (amount_x ?? 0) > 0;
  const activeBinsAbove = bins_above ?? (activeStrategy === "spot" && hasBaseToken ? activeBinsBelow : 0);

  // Safety: reject tiny deploys (wastes gas, barely earns fees)
  const MIN_BINS = 20;
  const totalBins = activeBinsBelow + activeBinsAbove;
  if (totalBins < MIN_BINS) {
    return {
      success: false,
      error: `Rejected: total bins = ${totalBins}, minimum is ${MIN_BINS}. At bin_step ${bin_step || "?"}, ${MIN_BINS} bins ≈ ${bin_step ? (MIN_BINS * (bin_step / 10000) * 100).toFixed(0) : "?"}% range. Use calculate_bins with a target range of 25-50% and pass that bin count to bins_below.`,
    };
  }

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_deploy: {
        pool_address,
        strategy: activeStrategy,
        bins_below: activeBinsBelow,
        bins_above: activeBinsAbove,
        amount_x: amount_x || 0,
        amount_y: amount_y || amount_sol || 0,
        wide_range: (activeBinsBelow + activeBinsAbove) > 69,
      },
      message: "DRY RUN — no transaction sent",
    };
  }

  const { StrategyType } = await getDLMM();
  const wallet = getWallet();
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

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
        const txHash = await sendAndConfirmTransaction(getConnection(), createTxArray[i], signers, { skipPreflight: true });
        txHashes.push(txHash);
        log("deploy", `Create tx ${i + 1}/${createTxArray.length}: ${txHash}`);
      }

      // Phase 2: Add liquidity (may be multiple txs)
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
        const txHash = await sendAndConfirmTransaction(getConnection(), addTxArray[i], [wallet], { skipPreflight: true });
        txHashes.push(txHash);
        log("deploy", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${txHash}`);
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
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet, newPosition], { skipPreflight: true });
      txHashes.push(txHash);
    }

    log("deploy", `SUCCESS — ${txHashes.length} tx(s): ${txHashes[0]}`);

    _positionsCacheAt = 0;
    trackPosition({
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      strategy: activeStrategy,
      bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
      bin_step,
      volatility,
      fee_tvl_ratio,
      organic_score,
      amount_sol: finalAmountY,
      amount_x: finalAmountX,
      active_bin: activeBin.binId,
      initial_value_usd,
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

// ─── Get Position PnL (Meteora API) ─────────────────────────────
export async function getPositionPnl({ pool_address, position_address }) {
  pool_address = normalizeMint(pool_address);
  position_address = normalizeMint(position_address);
  const walletAddress = getWallet().publicKey.toString();
  try {
    const byAddress = await fetchDlmmPnlForPool(pool_address, walletAddress);
    const p = byAddress[position_address];
    if (!p) return { error: "Position not found in PnL API" };

    const unclaimedUsd    = parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0);
    const currentValueUsd = parseFloat(p.unrealizedPnl?.balances || 0);
    const pnlUsdVal       = Math.round((p.pnlUsd ?? 0) * 100) / 100;
    const allTimeFeesUsd  = Math.round(parseFloat(p.allTimeFees?.total?.usd || 0) * 100) / 100;

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
      in_range:    !p.isOutOfRange,
      lower_bin:   p.lowerBinId      ?? null,
      upper_bin:   p.upperBinId      ?? null,
      active_bin:  p.poolActiveBinId ?? null,
      age_minutes: p.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
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

    // Enrich with DLMM PnL API for each unique pool in parallel
    const uniquePools = [...new Set(raw.map((p) => p.pool))];
    const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, walletAddress)));
    const pnlByPool = {};
    uniquePools.forEach((pool, i) => { pnlByPool[pool] = pnlMaps[i]; });

    // SOL price for conversion (one fetch, shared across all positions)
    let solPrice = 0;
    try { solPrice = (await getWalletBalances()).sol_price || 0; } catch { /* best-effort */ }
    const toSol = (usd) => solPrice > 0 ? Math.round((usd / solPrice) * 10000) / 10000 : null;

    const positions = await Promise.all(raw.map(async (r) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;

      const inRange = p ? !p.isOutOfRange : true;
      if (inRange) markInRange(r.position);
      else markOutOfRange(r.position);

      const lowerBin  = p?.lowerBinId      ?? r.lower_bin;
      const upperBin  = p?.upperBinId      ?? r.upper_bin;
      const activeBin = p?.poolActiveBinId ?? null;

      const unclaimedFees = p ? (parseFloat(p.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(p.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) : 0;
      const totalValue    = p ? parseFloat(p.unrealizedPnl?.balances || 0) : 0;
      const collectedFees = p ? parseFloat(p.allTimeFees?.total?.usd || 0) : 0;
      const pnlUsd        = p?.pnlUsd       ?? 0;
      const pnlPct        = (config.management.pnlUnit === "sol" ? p?.pnlSolPctChange : p?.pnlPctChange) ?? 0;

      const tracked = getTrackedPosition(r.position);

      // Auto-adopt untracked positions (manually opened or from external tools)
      if (!tracked && p) {
        try {
          const { getPoolDetail } = await import("./screening.js");
          const poolDetail = await getPoolDetail({ pool_address: r.pool, timeframe: "1h" }).catch(() => null);

          // Infer strategy from on-chain bin liquidity distribution
          let inferredStrategy = "bid_ask"; // safe default
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
            // Fallback: check deposit amounts — no base token deposited = bid_ask
            const depositedX = parseFloat(p.allTimeDeposits?.tokenX?.amount || 0);
            inferredStrategy = depositedX === 0 ? "bid_ask" : "spot";
          }

          const depositSol = parseFloat(p.allTimeDeposits?.tokenY?.amountSol || 0);
          const depositUsd = parseFloat(p.allTimeDeposits?.total?.usd || 0);

          trackPosition({
            position: r.position,
            pool: r.pool,
            pool_name: poolDetail?.name || r.pair || r.pool.slice(0, 8),
            strategy: inferredStrategy,
            bin_range: {
              min: p.lowerBinId,
              max: p.upperBinId,
              bins_below: p.poolActiveBinId - p.lowerBinId,
              bins_above: p.upperBinId - p.poolActiveBinId,
            },
            amount_sol: depositSol,
            amount_x: parseFloat(p.allTimeDeposits?.tokenX?.amount || 0),
            active_bin_at_deploy: p.poolActiveBinId,
            bin_step: poolDetail?.bin_step || null,
            volatility: poolDetail?.volatility || null,
            fee_tvl_ratio: poolDetail?.fee_active_tvl_ratio || null,
            initial_fee_tvl_24h: poolDetail?.fee_active_tvl_ratio || null,
            organic_score: poolDetail?.organic_score || null,
            initial_value_usd: depositUsd,
            deployed_at: p.createdAt ? new Date(p.createdAt * 1000).toISOString() : new Date().toISOString(),
            adopted: true,
          });

          log("adopt", `Auto-adopted position ${r.position.slice(0, 8)} in ${poolDetail?.name || r.pool.slice(0, 8)} (${inferredStrategy}, ${depositSol.toFixed(2)} SOL)`);
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

      return {
        position: r.position,
        pool: r.pool,
        pair: r.pair,
        base_mint: r.base_mint,
        strategy: trackedFinal?.strategy || "bid_ask",
        bin_step: trackedFinal?.bin_step || null,
        volatility: trackedFinal?.volatility || null,
        lower_bin: lowerBin,
        upper_bin: upperBin,
        active_bin: activeBin,
        in_range: inRange,
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
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet], { skipPreflight: true });
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
export async function closePosition({ position_address }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: position_address, message: "DRY RUN — no transaction sent" };
  }

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
    let pnlUsd = 0;
    let pnlPct = 0;
    let finalValueUsd = 0;
    let feesUsd = 0;
    const trackedPre = getTrackedPosition(position_address);
    feesUsd = trackedPre?.total_fees_claimed_usd || 0;
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

    const txHashes = [];

    // ─── Step 1: Claim Fees (to clear account state) ───────────
    try {
      log("close", `Step 1: Claiming fees for ${position_address}`);
      const claimTxs = await pool.claimSwapFee({
        owner: wallet.publicKey,
        position: positionData,
      });
      for (const tx of Array.isArray(claimTxs) ? claimTxs : [claimTxs]) {
        const claimHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet], { skipPreflight: true });
        txHashes.push(claimHash);
      }
      log("close", `Step 1 OK: ${txHashes.join(", ")}`);
    } catch (e) {
      log("close_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
    }

    // ─── Step 2: Remove Liquidity & Close ──────────────────────
    log("close", `Step 2: Removing liquidity and closing account`);
    const closeTx = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: positionPubKey,
      fromBinId: -887272,
      toBinId: 887272,
      bps: new BN(10000),
      shouldClaimAndClose: true,
    });

    for (const tx of Array.isArray(closeTx) ? closeTx : [closeTx]) {
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet], { skipPreflight: true });
      txHashes.push(txHash);
    }
    log("close", `SUCCESS txs: ${txHashes.join(", ")}`);
    recordClose(position_address, "agent decision");

    // Record performance for learning
    const tracked = getTrackedPosition(position_address);
    if (tracked) {
      const deployedAt = new Date(tracked.deployed_at).getTime();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);

      let minutesOOR = 0;
      if (tracked.out_of_range_since) {
        minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
      }

      _positionsCacheAt = 0; // invalidate cache
      const initialUsd = tracked.initial_value_usd || 0;

      await recordPerformance({
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolAddress.slice(0, 8),
        strategy: tracked.strategy,
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
        close_reason: "agent decision",
      });

      // Clean up transient nugget entries
      try {
        const { forgetPositionSnapshot } = await import("../memory.js");
        forgetPositionSnapshot(tracked);
      } catch { /* best-effort */ }

      return { success: true, position: position_address, pool: poolAddress, txs: txHashes, pnl_usd: pnlUsd, pnl_pct: pnlPct };
    }

    return { success: true, position: position_address, pool: poolAddress, txs: txHashes };
  } catch (error) {
    log("close_error", error.message);
    return { success: false, error: error.message };
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

  for (const [lbPairKey, positionData] of Object.entries(allPositions)) {
    for (const pos of positionData.lbPairPositionsData || []) {
      if (pos.publicKey.toString() === position_address) return lbPairKey;
    }
  }

  throw new Error(`Position ${position_address} not found in open positions`);
}
