import test from "node:test";
import assert from "node:assert/strict";
import { getJupiterReferralParams } from "../tools/wallet.js";

test("Jupiter swaps have no referral fee by default", () => {
  assert.equal(getJupiterReferralParams(), null);
});
