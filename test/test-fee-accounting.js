/**
 * Fees claimed mid-position count in on-chain PnL.
 *
 * claimFees used to call recordClaim(position) with no amount, so
 * total_fees_claimed_usd stayed short and getOnchainPnl left the claim out:
 * AMERICA-SOL (7.13 SOL) claimed 0.129 SOL at 05:50 and its close was
 * recorded at −3.76% instead of ≈ −1.9% (≈ −0.14 SOL).
 *
 * state.js reads/writes ./state.json relative to the cwd, so this test chdirs
 * into a temp dir BEFORE importing anything. Every chain read is mocked.
 */
process.env.DRY_RUN = "true";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-fee-accounting-"));
process.chdir(tmp);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { trackPosition, getTrackedPosition, recordClaim } = await import("../state.js");
const { computeOnchainPnl, getOnchainPnl, claimedFeesSol, feesValue, _setOnchainPnlDepsForTest, SOL_MINT } = await import("../tools/onchain-pnl.js");

const TOKEN = "AmericaTok1111111111111111111111111111111111";
const pool = {
  tokenX: { publicKey: { toString: () => TOKEN }, mint: { decimals: 6 } },
  tokenY: { publicKey: { toString: () => SOL_MINT }, mint: { decimals: 9 } },
  lbPair: { binStep: 100, activeId: -500 },
};

// AMERICA-like: 7.13 SOL single-sided in. At close the position holds
// 6.861912 SOL of value (liquidity + unclaimed fees) = −3.76% on its own.
const DEPOSIT = 7.13;
const CLAIMED_SOL = 0.129;
const SOL_USD = 122.02; // entry price: $870 / 7.13 SOL
const valueAtClose = { positionBinData: [{ positionXAmount: "0", positionYAmount: "6851912000" }], feeX: "0", feeY: "10000000" }; // 6.851912 + 0.01 SOL fees

test("AMERICA fixture: without the claim −3.76%; with 0.129 SOL claimed ≈ −1.95% (≈ −0.139 SOL)", () => {
  const without = computeOnchainPnl({ pool, positionData: valueAtClose, activePrice: 1e-5, tracked: { amount_sol: DEPOSIT, amount_x: 0, initial_value_usd: 870 } });
  assert.equal(without.pnlPct, -3.76, "what was recorded");

  const withClaim = computeOnchainPnl({
    pool, positionData: valueAtClose, activePrice: 1e-5,
    tracked: { amount_sol: DEPOSIT, amount_x: 0, initial_value_usd: 870, total_fees_claimed_sol: CLAIMED_SOL, total_fees_claimed_usd: 15.74 },
  });
  assert.equal(withClaim.pnlPct, -1.95);
  assert.ok(Math.abs(withClaim.pnlSol - -0.139088) < 1e-6, `pnlSol ${withClaim.pnlSol}`);
  assert.equal(withClaim.claimedFeesSol, CLAIMED_SOL);
});

test("recordClaim stores the claim in USD and SOL; getOnchainPnl adds the SOL back", async () => {
  const position = "AmericaPos1111111111111111111111111111111111";
  trackPosition({ position, pool: "Dvi4B9Rj4m4DKVL5R2txZ4aB5teNndhyZ8fqtSjZRqHW", pool_name: "AMERICA-SOL", strategy: "bid_ask", amount_sol: DEPOSIT, initial_value_usd: 870, deployed_at: new Date().toISOString() });
  recordClaim(position, 15.74, CLAIMED_SOL);
  const t = getTrackedPosition(position);
  assert.equal(t.total_fees_claimed_sol, CLAIMED_SOL);
  assert.equal(t.total_fees_claimed_usd, 15.74);
  assert.equal(t.fees_claimed_usd_unpriced, undefined);
  assert.match(t.notes.at(-1), /^Claimed 0\.129000 SOL \/ ~15\.74 USD fees/);

  _setOnchainPnlDepsForTest({
    PublicKey: class { constructor(k) { this.k = k; } },
    getTrackedPosition,
    getPool: async () => ({
      ...pool,
      getPosition: async () => ({ positionData: valueAtClose }),
      getActiveBin: async () => ({ binId: -500, pricePerToken: "0.00001" }),
    }),
  });
  try {
    const oc = await getOnchainPnl({ position, pool: "Dvi4B9Rj4m4DKVL5R2txZ4aB5teNndhyZ8fqtSjZRqHW" }, { force: true });
    assert.equal(oc.pnlPct, -1.95, "the 05:50 claim is back in the PnL");
    assert.equal(oc.claimedFeesSol, CLAIMED_SOL);
  } finally {
    _setOnchainPnlDepsForTest(null);
  }
});

test("claims without a SOL amount are converted at the SOL price; legacy USD totals migrate once", () => {
  const position = "LegacyPos11111111111111111111111111111111111";
  trackPosition({ position, pool: "p", pool_name: "L-SOL", amount_sol: DEPOSIT, initial_value_usd: 870, deployed_at: new Date().toISOString() });
  recordClaim(position, 12.2); // USD only
  let t = getTrackedPosition(position);
  assert.equal(t.total_fees_claimed_sol, 0);
  assert.equal(t.fees_claimed_usd_unpriced, 12.2);
  assert.ok(Math.abs(claimedFeesSol(t, { solPriceUsd: 122 }) - 0.1) < 1e-9);
  assert.ok(Math.abs(claimedFeesSol(t) - 12.2 / SOL_USD) < 1e-6, "falls back to the entry SOL price");

  // A record from before total_fees_claimed_sol existed: all its USD is unpriced.
  const legacy = { amount_sol: DEPOSIT, amount_x: 0, initial_value_usd: 870, total_fees_claimed_usd: 24.4 };
  assert.ok(Math.abs(claimedFeesSol(legacy, { solPriceUsd: 122 }) - 0.2) < 1e-9);
  // …and a SOL-priced claim on it keeps the earlier USD (moved to unpriced), adding the SOL.
  const position2 = "LegacyPos22222222222222222222222222222222222";
  trackPosition({ position: position2, pool: "p", pool_name: "L-SOL", amount_sol: DEPOSIT, initial_value_usd: 870, deployed_at: new Date().toISOString() });
  const state = JSON.parse(fs.readFileSync("state.json", "utf8"));
  delete state.positions[position2].total_fees_claimed_sol;
  state.positions[position2].total_fees_claimed_usd = 24.4;
  fs.writeFileSync("state.json", JSON.stringify(state));
  recordClaim(position2, 12.2, 0.1);
  t = getTrackedPosition(position2);
  assert.deepEqual([t.total_fees_claimed_sol, t.fees_claimed_usd_unpriced, t.total_fees_claimed_usd], [0.1, 24.4, 36.6]);
  assert.ok(Math.abs(claimedFeesSol(t, { solPriceUsd: 122 }) - 0.3) < 1e-9);
});

test("feesValue: what a claim takes out, in SOL (token fees at the active price) and USD", () => {
  const v = feesValue({ pool, positionData: { feeX: "2000000", feeY: "109000000" }, activePrice: 0.01, solPriceUsd: 122.02 });
  // 2 tokens × 0.01 + 0.109 SOL = 0.129 SOL
  assert.equal(v.sol, 0.129);
  assert.equal(v.usd, 15.74);
  assert.equal(feesValue({ pool, positionData: { feeX: "0", feeY: "0" }, activePrice: 0.01 }).usd, null, "no SOL price → no USD");
  const noSol = { ...pool, tokenY: { publicKey: { toString: () => "USDC" }, mint: { decimals: 6 } } };
  assert.equal(feesValue({ pool: noSol, positionData: { feeX: "1", feeY: "1" }, activePrice: 1 }), null);
});
