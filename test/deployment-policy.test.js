import test from "node:test";
import assert from "node:assert/strict";
import {
  binsForDownsidePct,
  buildAutonomousDeploymentPlan,
  downsidePctForVolatility,
  validateSingleSidedSolOrientation,
} from "../deployment-policy.js";
import { calculateDownsideEvolution } from "../lessons.js";

const WSOL = "So11111111111111111111111111111111111111112";

test("derives downside bins from actual bin step and clamps to configured bounds", () => {
  assert.equal(binsForDownsidePct(50, 100, { min: 47, max: 90 }), 70);
  assert.equal(binsForDownsidePct(90, 80, { min: 47, max: 90 }), 90);
  assert.equal(binsForDownsidePct(5, 200, { min: 47, max: 90 }), 47);
});

test("adjusts downside percentage from minimum through default to maximum volatility", () => {
  const strategy = {
    minDownsidePct: 50,
    targetDownsidePct: 60,
    maxDownsidePct: 75,
    minDownsideVolatilityPct: 2.5,
    defaultDownsideVolatilityPct: 5,
    maxDownsideVolatilityPct: 12,
  };
  assert.equal(downsidePctForVolatility(1, strategy), 50);
  assert.equal(downsidePctForVolatility(2.5, strategy), 50);
  assert.equal(downsidePctForVolatility(5, strategy), 60);
  assert.equal(downsidePctForVolatility(8.5, strategy), 67.5);
  assert.equal(downsidePctForVolatility(12.86, strategy), 75);
  assert.equal(downsidePctForVolatility(null, strategy), 60);
});

test("autonomous range converts the volatility-adjusted percentage using SDK bin step", () => {
  const result = buildAutonomousDeploymentPlan({
    modelSelection: { pool_address: "pool" },
    candidate: { pool: "pool", name: "CHOO", volatility: 12.8624 },
    authoritative: { tokenXMint: "TokenX", tokenYMint: WSOL, tokenXDecimals: 6, tokenYDecimals: 9, binStep: 125, activeBin: -390 },
    deployAmountSol: 0.82,
    strategyConfig: {
      strategy: "hybrid",
      minDownsidePct: 50,
      targetDownsidePct: 60,
      maxDownsidePct: 75,
      minDownsideVolatilityPct: 2.5,
      defaultDownsideVolatilityPct: 5,
      maxDownsideVolatilityPct: 12,
      minBinsBelow: 35,
      maxBinsBelow: 180,
    },
  });
  assert.equal(result.target_downside_pct, 75);
  assert.equal(result.bins_below, 112);
});

test("auto-evolution widens percentage targets only for downside range losses", () => {
  const config = { strategy: { minDownsidePct: 50, targetDownsidePct: 60, maxDownsidePct: 75 } };
  const result = calculateDownsideEvolution([
    { pnl_pct: -2, close_reason: "dumped far below range", range_efficiency: 30 },
    { pnl_pct: -1, close_reason: "out of range below lower bin", range_efficiency: 40 },
    { pnl_pct: 3, close_reason: "take profit", range_efficiency: 100 },
    { pnl_pct: 2, close_reason: "pumped far above range", range_efficiency: 100 },
    { pnl_pct: 1, close_reason: "trailing profit", range_efficiency: 100 },
  ], config);
  assert.deepEqual(result.changes, { minDownsidePct: 52.5, targetDownsidePct: 62.5 });

  const upsideOnly = calculateDownsideEvolution([
    { pnl_pct: -1, close_reason: "pumped far above range", range_efficiency: 20 },
    { pnl_pct: -2, close_reason: "far above range", range_efficiency: 20 },
  ], config);
  assert.deepEqual(upsideOnly.changes, {});
});

test("auto-evolution tightens percentage targets after five efficient profitable closes", () => {
  const result = calculateDownsideEvolution(
    Array.from({ length: 5 }, () => ({ pnl_pct: 1, close_reason: "take profit", range_efficiency: 90 })),
    { strategy: { minDownsidePct: 50, targetDownsidePct: 60, maxDownsidePct: 75 } },
  );
  assert.deepEqual(result.changes, { minDownsidePct: 47.5, targetDownsidePct: 57.5, maxDownsidePct: 72.5 });
});

test("autonomous deploy args override model strategy amount and range", () => {
  const result = buildAutonomousDeploymentPlan({
    modelSelection: { pool_address: "pool", strategy: "spot", amount_y: 99, bins_below: 500, bins_above: 12 },
    candidate: { pool: "pool", name: "TEST" },
    authoritative: { tokenXMint: "TokenX", tokenYMint: WSOL, tokenXDecimals: 6, tokenYDecimals: 9, binStep: 100, activeBin: 123 },
    deployAmountSol: 1.29,
    strategyConfig: { strategy: "hybrid", targetDownsidePct: 50, minBinsBelow: 47, maxBinsBelow: 90 },
  });
  assert.equal(result.strategy, "hybrid");
  assert.equal(result.amount_y, 1.29);
  assert.equal(result.amount_x, 0);
  assert.equal(result.bins_below, 70);
  assert.equal(result.bins_above, 0);
  assert.equal(result.base_mint, "TokenX");
  assert.equal(result.bin_step, 100);
  assert.equal(result.active_bin, 123);
});

test("single-sided SOL deploy rejects pools whose token Y is not wrapped SOL", () => {
  assert.throws(
    () => validateSingleSidedSolOrientation({ tokenXMint: WSOL, tokenYMint: "OtherToken", tokenYDecimals: 6 }, { amountX: 0, amountY: 1 }),
    /token Y.*wrapped SOL/i,
  );
  assert.doesNotThrow(() => validateSingleSidedSolOrientation({ tokenXMint: "TokenX", tokenYMint: WSOL, tokenYDecimals: 9 }, { amountX: 0, amountY: 1 }));
});

test("autonomous plan cannot be applied to another pool", () => {
  assert.throws(
    () => buildAutonomousDeploymentPlan({
      modelSelection: { pool_address: "other" },
      candidate: { pool: "pool" },
      authoritative: { tokenXMint: "TokenX", tokenYMint: WSOL, tokenXDecimals: 6, tokenYDecimals: 9, binStep: 100, activeBin: 1 },
      deployAmountSol: 1,
      strategyConfig: { strategy: "hybrid", targetDownsidePct: 50, minBinsBelow: 47, maxBinsBelow: 90 },
    }),
    /not an eligible/i,
  );
});

test("autonomous plan refuses a non-hybrid configured strategy", () => {
  assert.throws(
    () => buildAutonomousDeploymentPlan({
      modelSelection: { pool_address: "pool" },
      candidate: { pool: "pool" },
      authoritative: { tokenXMint: "TokenX", tokenYMint: WSOL, tokenXDecimals: 6, tokenYDecimals: 9, binStep: 100, activeBin: 1 },
      deployAmountSol: 1,
      strategyConfig: { strategy: "spot", targetDownsidePct: 50, minBinsBelow: 47, maxBinsBelow: 90 },
    }),
    /requires configured hybrid/i,
  );
});
