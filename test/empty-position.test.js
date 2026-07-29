import test from "node:test";
import assert from "node:assert/strict";
import { hasOnChainPositionValue } from "../tools/pnl.js";

test("classifies a zero-balance DLMM position shell as empty", () => {
  assert.equal(hasOnChainPositionValue({ xRaw: 0, yRaw: 0, feeXRaw: 0, feeYRaw: 0 }), false);
});

test("keeps positions with liquidity or unclaimed fees", () => {
  assert.equal(hasOnChainPositionValue({ xRaw: "1", yRaw: 0, feeXRaw: 0, feeYRaw: 0 }), true);
  assert.equal(hasOnChainPositionValue({ xRaw: 0, yRaw: 0, feeXRaw: 0, feeYRaw: "1" }), true);
});
