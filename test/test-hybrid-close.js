/**
 * Hybrid positions: the REAL closePosition() forwards strategy_mix + per-leg SOL into
 * the performance record (lessons / KB / pool-memory read it). Mock connection, wallet
 * and pool; nothing is signed or sent.
 */
import "./_bootstrap.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

process.env.DRY_RUN = "false";
delete process.env.HELIUS_API_KEY;

const { Keypair, Transaction, TransactionInstruction } = await import("@solana/web3.js");
const dlmm = await import("../tools/dlmm.js");
const state = await import("../state.js");

const wallet = Keypair.generate();
const POOL = Keypair.generate().publicKey.toBase58();
const POS = Keypair.generate().publicKey.toBase58();
const sent = [];
const connection = {
  getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 10_000 }),
  simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 100_000 } }),
  sendRawTransaction: async (w) => { sent.push(w); return "mock-sig"; },
  confirmTransaction: async () => ({ value: { err: null } }),
  getSignatureStatuses: async () => ({ value: [null] }),
  getAccountInfo: async () => null, // the position account is gone => closed
  getBalance: async () => 1_000_000_000,
  getMultipleAccountsInfo: async (keys) => keys.map(() => null),
};
dlmm._setDlmmTestDeps({ connection, wallet });

const memo = () => new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([1]) });
const pool = {
  lbPair: { activeId: 100, binStep: 100, tokenXMint: Keypair.generate().publicKey, tokenYMint: Keypair.generate().publicKey },
  tokenX: { mint: { decimals: 6 } }, tokenY: { mint: { decimals: 9 } },
  getPosition: async () => ({ positionData: { positionBinData: [], totalXAmount: "0", totalYAmount: "0", feeX: "0", feeY: "0" } }),
  removeLiquidity: async () => new Transaction().add(memo()),
  refetchStates: async () => {},
};
dlmm._setPoolForTest(POOL, pool);

test("closePosition (real path) records strategy_mix + per-leg SOL for a hybrid position", async () => {
  state.trackPosition({
    position: POS, pool: POOL, pool_name: "HYB-SOL", strategy: "hybrid", strategy_type: "Hybrid",
    strategy_mix: { bid_ask_pct: 60, spot_pct: 40 }, legs: { bid_ask_sol: 0.6, spot_sol: 0.4 }, sol_split_pct: 100,
    bin_range: { min: 30, max: 100, bins_below: 70, bins_above: 0 }, bin_step: 100, amount_sol: 1, amount_x: 0, initial_value_usd: 150,
    deployed_at: new Date(Date.now() - 3_600_000).toISOString(),
  });
  const res = await dlmm.closePosition({ position_address: POS, _pnlOverride: { pnl_pct: 2, pnl_usd: 3, total_value_usd: 153, pnl_source: "api" }, _close_reason: "test" });
  assert.equal(res.success, true, JSON.stringify(res));
  assert.ok(sent.length >= 1, "mock connection received the (unsigned-by-network) remove tx");
  const lessonsFile = path.join(process.env.MERIDIAN_DATA_DIR, "lessons.json");
  const rec = JSON.parse(fs.readFileSync(lessonsFile, "utf8")).performance.find((p) => p.position === POS);
  assert.ok(rec, "performance record written by the real close path");
  assert.equal(rec.strategy, "hybrid");
  assert.deepEqual(rec.strategy_mix, { bid_ask_pct: 60, spot_pct: 40 });
  assert.deepEqual(rec.legs, { bid_ask_sol: 0.6, spot_sol: 0.4 });
});
