// deploy_position caps range depth at strategy.maxRangePct (default 80%).
process.env.DRY_RUN = "true";
import test from "node:test";
import assert from "node:assert/strict";

const { config } = await import("../config.js");
const dlmm = await import("../tools/dlmm.js");
const { calculateBinsForPriceRange } = await import("../runtime-helpers.js");

config.strategy.activeStrategy = "classic";
const POOL = "CapPool111111111111111111111111111111111111";
const deploy = (args) => dlmm.deployPosition({ pool_address: POOL, amount_y: 1, strategy: "bid_ask", bin_step: 100, ...args });

test("a range deeper than maxRangePct is capped to it", async () => {
  config.strategy.maxRangePct = 80;
  const r = await deploy({ price_range_pct: 95 });
  assert.equal(r.dry_run, true);
  assert.equal(r.would_deploy.bins_below, calculateBinsForPriceRange(100, 80));
});

test("bins_below deeper than the max is capped too", async () => {
  config.strategy.maxRangePct = 80;
  const r = await deploy({ bins_below: 400 });
  assert.equal(r.would_deploy.bins_below, calculateBinsForPriceRange(100, 80));
});

test("ranges within the max are untouched", async () => {
  config.strategy.maxRangePct = 80;
  const r = await deploy({ price_range_pct: 60 });
  assert.equal(r.would_deploy.bins_below, calculateBinsForPriceRange(100, 60));
  const r80 = await deploy({ price_range_pct: 80 });
  assert.equal(r80.would_deploy.bins_below, calculateBinsForPriceRange(100, 80));
});

test("the max follows the setting", async () => {
  config.strategy.maxRangePct = 70;
  const r = await deploy({ price_range_pct: 90 });
  assert.equal(r.would_deploy.bins_below, calculateBinsForPriceRange(100, 70));
  config.strategy.maxRangePct = 80;
});
