import test from "node:test";
import assert from "node:assert/strict";
import { getRpcWalletBalanceFallback } from "../tools/wallet.js";

test("uses RPC SOL balance when Helius wallet balances are unavailable", async () => {
  const connection = {
    getBalance: async () => 1_047_960_130,
  };

  const result = await getRpcWalletBalanceFallback(
    "11111111111111111111111111111111",
    "Helius API error: 429 Too Many Requests",
    connection,
  );

  assert.equal(result.sol, 1.04796);
  assert.equal(result.wallet, "11111111111111111111111111111111");
  assert.equal(result.error, "Helius API error: 429 Too Many Requests; RPC SOL fallback active");
  assert.deepEqual(result.tokens, []);
});
