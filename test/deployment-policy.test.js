import test from "node:test";
import assert from "node:assert/strict";
import {
  binsForDownsidePct,
  buildAutonomousDeploymentPlan,
  validateSingleSidedSolOrientation,
} from "../deployment-policy.js";

const WSOL = "So11111111111111111111111111111111111111112";

test("derives downside bins from actual bin step and clamps to configured bounds", () => {
  assert.equal(binsForDownsidePct(50, 100, { min: 47, max: 90 }), 70);
  assert.equal(binsForDownsidePct(90, 80, { min: 47, max: 90 }), 90);
  assert.equal(binsForDownsidePct(5, 200, { min: 47, max: 90 }), 47);
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
