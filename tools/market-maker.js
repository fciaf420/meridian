// ═══════════════════════════════════════════════════════════════
// Market Maker — Meteora DLMM Limit Orders
//
// Maintains a two-sided ladder of DLMM limit orders around the active bin:
//   • bids  (buy base X with quote Y) at bins below the active bin
//   • asks  (sell base X for quote Y) at bins above the active bin
// As orders fill or price drifts past the ladder, the stale side is cancelled
// (harvesting filled proceeds + unfilled deposits) and re-quoted recentered on
// the new active bin — capturing the bid/ask spread plus the limit-order fee
// share, while inventory caps and a volatility pause limit adverse selection.
//
// Profit model: net P&L = spread captured + fee share − adverse-selection − gas.
//
// The pure functions (computeLadder, decideRequote) carry the decision logic and
// are unit-tested without any chain access. runMarketMaker is the I/O loop.
// ═══════════════════════════════════════════════════════════════

import { config } from "../config.js";
import { log } from "../logger.js";
import {
  poolSupportsLimitOrder,
  placeMmLimitOrder,
  cancelMmLimitOrder,
  getMmLimitOrder,
  listMmLimitOrders,
  getActiveBin,
} from "./dlmm.js";
import { getWalletBalances } from "./wallet.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const ABSOLUTE_MAX_BINS = 50; // on-chain MAX_BIN_PER_LIMIT_ORDER

// ─── Pure: build one side's ladder of { id, amount } bins ──────
// side: "bid" → bins below active (activeBin - spreadBins - i*stepBins)
//       "ask" → bins above active (activeBin + spreadBins + i*stepBins)
// orderSizeUi is split evenly across `levels` bins.
export function computeLadder({ activeBin, levels = 1, spreadBins = 1, stepBins = 1, orderSizeUi = 0, side = "bid" }) {
  if (!Number.isInteger(activeBin)) throw new Error("computeLadder: activeBin must be an integer bin id");
  if (!(levels >= 1)) throw new Error("computeLadder: levels must be >= 1");
  if (side !== "bid" && side !== "ask") throw new Error('computeLadder: side must be "bid" or "ask"');
  if (levels > 1 && !(stepBins >= 1)) throw new Error("computeLadder: stepBins must be >= 1 when levels > 1 (else bins collide)");
  if (!(spreadBins >= 0)) throw new Error("computeLadder: spreadBins must be >= 0");

  const n = Math.min(Math.floor(levels), ABSOLUTE_MAX_BINS);
  const sign = side === "ask" ? 1 : -1;
  const per = orderSizeUi / n;
  const bins = [];
  for (let i = 0; i < n; i++) {
    bins.push({ id: activeBin + sign * (spreadBins + i * stepBins), amount: per });
  }
  return { side, center: activeBin, bins, binIds: bins.map((b) => b.id) };
}

// ─── Pure: decide which side(s) to requote this tick ───────────
// bid/ask state: { live: bool, filledPct: number, center: number|null, lastRequoteAt: number|null }
// Returns { requoteBid, requoteAsk, reasons:{bid,ask} }.
export function decideRequote({
  now,
  mode = "two_sided",
  bid = {},
  ask = {},
  activeBin,
  driftBins = 2,
  requoteFillPct = 50,
  minRequoteIntervalMs = 30_000,
  inventory = {},
  maxInventory = {},
} = {}) {
  const sideEnabled = (side) =>
    mode === "two_sided" || (mode === "bid_only" && side === "bid") || (mode === "ask_only" && side === "ask");

  const evalSide = (side, s) => {
    if (!sideEnabled(side)) return { requote: false, reason: "mode_disabled" };
    if (s.lastRequoteAt != null && now - s.lastRequoteAt < minRequoteIntervalMs) {
      return { requote: false, reason: "throttled" };
    }
    // Inventory caps: bids buy base (cap on base held); asks sell base into quote (cap on quote held).
    if (side === "bid" && maxInventory.base != null && inventory.base != null && inventory.base >= maxInventory.base) {
      return { requote: false, reason: "inventory_cap_base" };
    }
    if (side === "ask" && maxInventory.quote != null && inventory.quote != null && inventory.quote >= maxInventory.quote) {
      return { requote: false, reason: "inventory_cap_quote" };
    }
    if (!s.live) return { requote: true, reason: "no_live_order" };
    if ((s.filledPct ?? 0) >= requoteFillPct) return { requote: true, reason: "filled" };
    if (s.center != null && Number.isFinite(activeBin) && Math.abs(activeBin - s.center) > driftBins) {
      return { requote: true, reason: "drift" };
    }
    return { requote: false, reason: "in_range" };
  };

  const b = evalSide("bid", bid);
  const a = evalSide("ask", ask);
  return { requoteBid: b.requote, requoteAsk: a.requote, reasons: { bid: b.reason, ask: a.reason } };
}

// ─── Resolve the runnable MM config (config.marketMaker + overrides) ──
export function loadMarketMakerConfig(overrides = {}) {
  const base = config.marketMaker || {};
  const mm = { ...base, ...clean(overrides) };

  const validModes = ["two_sided", "bid_only", "ask_only"];
  if (!validModes.includes(mm.mode)) {
    throw new Error(`Invalid mode "${mm.mode}". Use one of: ${validModes.join(", ")}`);
  }
  mm.levels = int(mm.levels, 1);
  mm.spreadBins = int(mm.spreadBins, 1);
  mm.stepBins = int(mm.stepBins, 1);
  mm.driftBins = int(mm.driftBins, 2);
  mm.tickIntervalSec = num(mm.tickIntervalSec, 15);
  mm.minRequoteIntervalSec = num(mm.minRequoteIntervalSec, 30);
  mm.requoteFillPct = num(mm.requoteFillPct, 50);
  mm.maxActiveBinSlippage = int(mm.maxActiveBinSlippage, 3);

  if (mm.levels < 1) throw new Error("levels must be >= 1");
  if (mm.levels > 1 && mm.stepBins < 1) throw new Error("stepBins must be >= 1 when levels > 1");
  const span = mm.spreadBins + (mm.levels - 1) * mm.stepBins + 1;
  if (span > ABSOLUTE_MAX_BINS) {
    throw new Error(`Ladder spans ${span} bins per side; max ${ABSOLUTE_MAX_BINS}. Reduce levels/spreadBins/stepBins.`);
  }
  return mm;
}

function clean(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined) out[k] = v;
  return out;
}
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function int(v, d) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : d; }

// ─── Inventory read (best-effort; caps ignored if it fails) ────
async function readInventory(support) {
  try {
    const bals = await getWalletBalances();
    const baseMint = support.token_x;
    const quoteMint = support.token_y;
    const base = bals.tokens?.find((t) => t.mint === baseMint)?.balance ?? 0;
    const quote = quoteMint === SOL_MINT
      ? (bals.sol ?? 0)
      : (bals.tokens?.find((t) => t.mint === quoteMint)?.balance ?? 0);
    return { base, quote, quoteIsSol: quoteMint === SOL_MINT };
  } catch {
    return {};
  }
}

// filled fraction (0–100) from an order's deposit-side unfilled vs deposit.
function filledPctOf(order, isAsk) {
  if (!order || order.error) return 0;
  const dep = Number(isAsk ? order.total_deposit_x : order.total_deposit_y) || 0;
  const unf = Number(isAsk ? order.total_unfilled_x : order.total_unfilled_y) || 0;
  if (dep <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - unf / dep) * 100));
}

// ─── The control loop ──────────────────────────────────────────
// Runs until `signal` aborts (CLI wires SIGINT → abort). On stop, cancels and
// closes all live orders so funds are never stranded.
export async function runMarketMaker({ poolAddress, config: mmIn, signal } = {}) {
  const mm = mmIn && mmIn.__resolved ? mmIn : loadMarketMakerConfig(mmIn || {});
  poolAddress = (poolAddress || "").trim();
  if (!poolAddress) throw new Error("poolAddress is required");
  const dry = process.env.DRY_RUN === "true";

  const support = await poolSupportsLimitOrder({ pool_address: poolAddress });
  if (!support.supported) {
    throw new Error(
      `Pool ${poolAddress} does not support DLMM limit orders${support.error ? ` (${support.error})` : ""}. ` +
      `Target a limit-order-enabled pool.`,
    );
  }
  log("mm", `Pool ${poolAddress.slice(0, 8)} supports limit orders (bin_step=${support.bin_step}). ` +
    `mode=${mm.mode} levels=${mm.levels} spread=${mm.spreadBins} step=${mm.stepBins} tick=${mm.tickIntervalSec}s${dry ? " [DRY_RUN]" : ""}`);

  const state = {
    bid: null, // { limit_order, center, sizeUi, lastRequoteAt, sim }
    ask: null,
    requotes: 0,
    startedAt: Date.now(),
    lastActive: null,
  };
  let stopped = false;
  const stop = () => { stopped = true; };
  if (signal) {
    if (signal.aborted) stopped = true;
    else signal.addEventListener("abort", stop, { once: true });
  }

  const minRequoteMs = mm.minRequoteIntervalSec * 1000;

  // Resolve per-side order size (UI). Explicit config wins; else a fraction of
  // available balance. Ask needs base inventory; bid needs quote.
  async function resolveSizes(inv) {
    const reserve = config.usdc?.gasReserveSol ?? config.management?.gasReserve ?? 0.2;
    let quoteSize = mm.orderSizeQuote;
    let baseSize = mm.orderSizeBase;
    if (quoteSize == null) {
      const availQuote = inv.quoteIsSol ? Math.max(0, (inv.quote ?? 0) - reserve) : (inv.quote ?? 0);
      quoteSize = availQuote * 0.25;
    }
    if (baseSize == null) baseSize = (inv.base ?? 0) * 0.25;
    return { quoteSize, baseSize };
  }

  async function quoteSide(side, activeBin, inv) {
    const isAsk = side === "ask";
    const { quoteSize, baseSize } = await resolveSizes(inv);
    const orderSizeUi = isAsk ? baseSize : quoteSize;
    if (!(orderSizeUi > 0)) {
      log("mm", `Skip ${side}: resolved order size is 0 (need ${isAsk ? "base (X)" : "quote (Y)"} inventory).`);
      return null;
    }
    const ladder = computeLadder({
      activeBin, levels: mm.levels, spreadBins: mm.spreadBins, stepBins: mm.stepBins,
      orderSizeUi, side,
    });
    const res = await placeMmLimitOrder({
      pool_address: poolAddress,
      is_ask_side: isAsk,
      bins: ladder.bins,
      max_active_bin_slippage: mm.maxActiveBinSlippage,
      label: `mm ${side}`,
    });
    if (dry) {
      log("mm", `[DRY] would place ${side.toUpperCase()} @ active ${activeBin}: bins ${JSON.stringify(ladder.binIds)} (${orderSizeUi} ${isAsk ? "base" : "quote"} total)`);
      // Simulate a live order so requote/drift logic exercises.
      return { limit_order: `dry-${side}`, center: activeBin, sizeUi: orderSizeUi, lastRequoteAt: Date.now(), sim: { binIds: ladder.binIds } };
    }
    if (!res.success) {
      log("mm", `${side} place failed: ${res.error}`);
      return null;
    }
    return { limit_order: res.limit_order, center: activeBin, sizeUi: orderSizeUi, lastRequoteAt: Date.now() };
  }

  async function cancelSide(side) {
    const s = state[side];
    if (!s) return;
    if (!dry) {
      const res = await cancelMmLimitOrder({ pool_address: poolAddress, limit_order: s.limit_order, label: `mm ${side}` });
      if (!res.success) log("mm", `${side} cancel warning: ${res.error}`);
    } else {
      log("mm", `[DRY] would cancel ${side} order ${s.limit_order}`);
    }
    state[side] = null;
  }

  async function requoteSide(side, activeBin, inv) {
    await cancelSide(side);
    const placed = await quoteSide(side, activeBin, inv);
    if (placed) { state[side] = placed; state.requotes++; }
  }

  async function readActiveBin() {
    const ab = await getActiveBin({ pool_address: poolAddress });
    return ab.binId;
  }

  async function sideStatus(side) {
    const s = state[side];
    if (!s) return { live: false, filledPct: 0, center: null, lastRequoteAt: null };
    if (dry) return { live: true, filledPct: 0, center: s.center, lastRequoteAt: s.lastRequoteAt };
    const order = await getMmLimitOrder({ pool_address: poolAddress, limit_order: s.limit_order });
    return { live: true, filledPct: filledPctOf(order, side === "ask"), center: s.center, lastRequoteAt: s.lastRequoteAt };
  }

  // ── Initial quote ──
  let inv = await readInventory(support);
  const startBin = await readActiveBin();
  state.lastActive = startBin;
  if (mm.mode !== "ask_only") await requoteSide("bid", startBin, inv);
  if (mm.mode !== "bid_only") await requoteSide("ask", startBin, inv);

  // ── Tick loop ──
  await new Promise((resolve) => {
    const tick = async () => {
      if (stopped) return resolve();
      try {
        const activeBin = await readActiveBin();
        inv = await readInventory(support);

        // Volatility pause: if active bin jumped more than the configured bins in one
        // tick, cancel both sides and wait for the next tick (avoid adverse selection).
        if (mm.volatilityPauseBins != null && state.lastActive != null &&
            Math.abs(activeBin - state.lastActive) > mm.volatilityPauseBins) {
          log("mm", `Volatility pause: active bin moved ${activeBin - state.lastActive} (> ${mm.volatilityPauseBins}). Pulling quotes.`);
          await cancelSide("bid");
          await cancelSide("ask");
          state.lastActive = activeBin;
          if (!stopped) setTimeout(tick, mm.tickIntervalSec * 1000);
          return;
        }
        state.lastActive = activeBin;

        const bidS = await sideStatus("bid");
        const askS = await sideStatus("ask");
        const decision = decideRequote({
          now: Date.now(), mode: mm.mode, bid: bidS, ask: askS, activeBin,
          driftBins: mm.driftBins, requoteFillPct: mm.requoteFillPct, minRequoteIntervalMs: minRequoteMs,
          inventory: { base: inv.base, quote: inv.quote },
          maxInventory: { base: mm.maxInventoryBase ?? null, quote: mm.maxInventoryQuote ?? null },
        });

        if (decision.requoteBid) {
          log("mm", `Requote BID (${decision.reasons.bid}) @ active ${activeBin}`);
          await requoteSide("bid", activeBin, inv);
        }
        if (decision.requoteAsk) {
          log("mm", `Requote ASK (${decision.reasons.ask}) @ active ${activeBin}`);
          await requoteSide("ask", activeBin, inv);
        }
      } catch (e) {
        log("mm_tick_error", e.message);
      }
      if (stopped) return resolve();
      setTimeout(tick, mm.tickIntervalSec * 1000);
    };
    setTimeout(tick, mm.tickIntervalSec * 1000);
  });

  // ── Shutdown: pull all quotes ──
  log("mm", `Stopping — cancelling all open orders (${state.requotes} requotes this session).`);
  await cancelSide("bid");
  await cancelSide("ask");
  // Belt-and-suspenders: cancel any stragglers the SDK still lists for us.
  if (!dry) {
    try {
      const open = await listMmLimitOrders({ pool_address: poolAddress });
      for (const o of open.orders || []) {
        await cancelMmLimitOrder({ pool_address: poolAddress, limit_order: o.limit_order, label: "mm shutdown sweep" });
      }
    } catch (e) {
      log("mm", `Shutdown sweep warning: ${e.message}`);
    }
  }
  log("mm", "Market maker stopped.");
  return { requotes: state.requotes, ranForMs: Date.now() - state.startedAt };
}
