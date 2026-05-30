/**
 * USDC-mode unit tests — no wallet, no network, DRY_RUN-safe.
 * Run: node test/test-usdc-mode.js
 *
 * Covers the pure sizing math and the config wiring. The on-chain swap paths
 * (prepareUsdcEntry / settleToUsdc live swaps) require a funded wallet and are
 * exercised manually in DRY_RUN against a real RPC.
 */
process.env.DRY_RUN = "true";

import assert from "node:assert";
import { config } from "../config.js";
import { usdToSol, usdcModeEnabled } from "../tools/usdc-mode.js";

let passed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log("=== USDC mode: sizing math ===");
check("usdToSol converts at price", () => {
  assert.strictEqual(usdToSol(150, 150), 1);
  assert.strictEqual(usdToSol(75, 150), 0.5);
});
check("usdToSol is safe at zero/invalid price", () => {
  assert.strictEqual(usdToSol(100, 0), 0);
  assert.strictEqual(usdToSol(100, undefined), 0);
  assert.strictEqual(usdToSol(100, -5), 0);
});

console.log("\n=== USDC mode: config wiring ===");
check("usdc config section exists with sane defaults", () => {
  assert.ok(config.usdc, "config.usdc missing");
  assert.strictEqual(typeof config.usdc.enabled, "boolean");
  assert.ok(config.usdc.deployAmountUsd > 0, "deployAmountUsd should be > 0");
  assert.ok(config.usdc.maxDeployUsd >= config.usdc.deployAmountUsd, "maxDeployUsd >= deployAmountUsd");
  assert.ok(config.usdc.gasReserveSol > 0, "gasReserveSol should be > 0");
});
check("usdcModeEnabled reflects config.usdc.enabled", () => {
  config.usdc.enabled = true;
  assert.strictEqual(usdcModeEnabled(), true);
  config.usdc.enabled = false;
  assert.strictEqual(usdcModeEnabled(), false);
});
check("USDC mint is configured", () => {
  assert.strictEqual(config.tokens.USDC, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
});

console.log(`\n${passed} checks passed.`);
