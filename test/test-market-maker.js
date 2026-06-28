import test from "node:test";
import assert from "node:assert/strict";

import {
  computeLadder,
  decideRequote,
  loadMarketMakerConfig,
} from "../tools/market-maker.js";

// ─── computeLadder ─────────────────────────────────────────────
test("computeLadder bid places bins below the active bin", () => {
  const { bins, binIds } = computeLadder({ activeBin: 100, levels: 3, spreadBins: 1, stepBins: 1, orderSizeUi: 3, side: "bid" });
  assert.deepEqual(binIds, [99, 98, 97]);
  assert.deepEqual(bins.map((b) => b.amount), [1, 1, 1]);
});

test("computeLadder ask places bins above the active bin", () => {
  const { binIds } = computeLadder({ activeBin: 100, levels: 3, spreadBins: 1, stepBins: 1, orderSizeUi: 3, side: "ask" });
  assert.deepEqual(binIds, [101, 102, 103]);
});

test("computeLadder honours spread and step", () => {
  const { binIds } = computeLadder({ activeBin: 100, levels: 3, spreadBins: 2, stepBins: 2, orderSizeUi: 9, side: "bid" });
  assert.deepEqual(binIds, [98, 96, 94]);
});

test("computeLadder splits the order size evenly", () => {
  const { bins } = computeLadder({ activeBin: 0, levels: 4, spreadBins: 1, stepBins: 1, orderSizeUi: 10, side: "ask" });
  assert.equal(bins.length, 4);
  for (const b of bins) assert.equal(b.amount, 2.5);
});

test("computeLadder caps bins at 50", () => {
  const { bins } = computeLadder({ activeBin: 0, levels: 60, spreadBins: 1, stepBins: 1, orderSizeUi: 60, side: "bid" });
  assert.equal(bins.length, 50);
});

test("computeLadder rejects colliding bins (levels>1, stepBins<1)", () => {
  assert.throws(() => computeLadder({ activeBin: 100, levels: 3, spreadBins: 1, stepBins: 0, orderSizeUi: 3, side: "bid" }));
});

test("computeLadder rejects a non-integer active bin", () => {
  assert.throws(() => computeLadder({ activeBin: 1.5, levels: 1, spreadBins: 1, stepBins: 1, orderSizeUi: 1, side: "bid" }));
});

// ─── decideRequote ─────────────────────────────────────────────
const baseArgs = {
  now: 1_000_000,
  mode: "two_sided",
  activeBin: 100,
  driftBins: 2,
  requoteFillPct: 50,
  minRequoteIntervalMs: 30_000,
};

test("decideRequote requotes a side with no live order", () => {
  const d = decideRequote({ ...baseArgs, bid: { live: false }, ask: { live: false } });
  assert.equal(d.requoteBid, true);
  assert.equal(d.requoteAsk, true);
  assert.equal(d.reasons.bid, "no_live_order");
});

test("decideRequote throttles a recent requote", () => {
  const d = decideRequote({
    ...baseArgs,
    bid: { live: true, filledPct: 90, center: 100, lastRequoteAt: baseArgs.now - 5_000 },
    ask: { live: true, filledPct: 0, center: 100, lastRequoteAt: baseArgs.now - 5_000 },
  });
  assert.equal(d.requoteBid, false);
  assert.equal(d.reasons.bid, "throttled");
});

test("decideRequote requotes a filled side", () => {
  const d = decideRequote({
    ...baseArgs,
    bid: { live: true, filledPct: 75, center: 100, lastRequoteAt: baseArgs.now - 60_000 },
    ask: { live: true, filledPct: 10, center: 100, lastRequoteAt: baseArgs.now - 60_000 },
  });
  assert.equal(d.requoteBid, true);
  assert.equal(d.reasons.bid, "filled");
  assert.equal(d.requoteAsk, false);
  assert.equal(d.reasons.ask, "in_range");
});

test("decideRequote requotes on drift past driftBins", () => {
  const d = decideRequote({
    ...baseArgs,
    activeBin: 104, // center 100, drift 4 > 2
    bid: { live: true, filledPct: 0, center: 100, lastRequoteAt: baseArgs.now - 60_000 },
    ask: { live: true, filledPct: 0, center: 100, lastRequoteAt: baseArgs.now - 60_000 },
  });
  assert.equal(d.requoteBid, true);
  assert.equal(d.reasons.bid, "drift");
});

test("decideRequote disables the off-mode side", () => {
  const d = decideRequote({ ...baseArgs, mode: "bid_only", bid: { live: false }, ask: { live: false } });
  assert.equal(d.requoteBid, true);
  assert.equal(d.requoteAsk, false);
  assert.equal(d.reasons.ask, "mode_disabled");
});

test("decideRequote respects the base inventory cap (pauses bids)", () => {
  const d = decideRequote({
    ...baseArgs,
    bid: { live: false },
    ask: { live: false },
    inventory: { base: 100, quote: 0 },
    maxInventory: { base: 100, quote: null },
  });
  assert.equal(d.requoteBid, false);
  assert.equal(d.reasons.bid, "inventory_cap_base");
  assert.equal(d.requoteAsk, true); // ask still allowed
});

test("decideRequote respects the quote inventory cap (pauses asks)", () => {
  const d = decideRequote({
    ...baseArgs,
    bid: { live: false },
    ask: { live: false },
    inventory: { base: 0, quote: 500 },
    maxInventory: { base: null, quote: 500 },
  });
  assert.equal(d.requoteAsk, false);
  assert.equal(d.reasons.ask, "inventory_cap_quote");
});

// ─── loadMarketMakerConfig ─────────────────────────────────────
test("loadMarketMakerConfig applies defaults and overrides", () => {
  const mm = loadMarketMakerConfig({ levels: 5, spreadBins: 2, stepBins: 3 });
  assert.equal(mm.mode, "two_sided");
  assert.equal(mm.levels, 5);
  assert.equal(mm.spreadBins, 2);
  assert.equal(mm.stepBins, 3);
});

test("loadMarketMakerConfig rejects an invalid mode", () => {
  assert.throws(() => loadMarketMakerConfig({ mode: "sideways" }));
});

test("loadMarketMakerConfig rejects a ladder span over 50 bins", () => {
  assert.throws(() => loadMarketMakerConfig({ levels: 50, spreadBins: 1, stepBins: 5 }));
});
