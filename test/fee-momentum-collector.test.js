import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildPoolFeeSnapshot,
  buildTokenFeeSnapshot,
  recordFeeMomentumSnapshots,
} from "../fee-momentum-collector.js";

test("captures token fee data before the minimum-fee gate", () => {
  const snapshot = buildTokenFeeSnapshot({
    token: {
      address: "mint-before-gate",
      symbol: "HOT",
      market_cap: 200_000,
      volume: 12_000,
      open_timestamp: 1_000,
    },
    info: { total_fee: 7.5, trade_fee: 2.25, price: 0.01, holder_count: 600 },
    infoCheck: { passed: false, reasons: ["total fee 7.5 SOL < 10 SOL"], totalFeeSol: 7.5, tradeFeeSol: 2.25 },
    now: 7_200_000,
  });

  assert.equal(snapshot.total_fee_sol, 7.5);
  assert.equal(snapshot.stage2_passed, false);
  assert.deepEqual(snapshot.stage2_reasons, ["total fee 7.5 SOL < 10 SOL"]);
});

test("captures Stage-5 DLMM economics and throttles each token/pool stream", () => {
  const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fee-momentum-")), "snapshots.jsonl");
  const snapshot = buildPoolFeeSnapshot({
    pool: "pool-1",
    name: "HOT-SOL",
    base: { mint: "mint-stage5", symbol: "HOT" },
    gmgn_total_fee_sol: 12,
    gmgn_trade_fee_sol: 3,
    price: 0,
    mcap: 250_000,
    volume: 15_000,
    holders: 700,
    tvl: 25_000,
    active_tvl: 20_000,
    fee_active_tvl_ratio: 0.08,
    volatility: 6,
    bin_step: 125,
  }, { now: 1_000_000 });

  assert.equal(recordFeeMomentumSnapshots([snapshot], { now: 1_000_000, outputPath, intervalMs: 300_000 }), 1);
  assert.equal(recordFeeMomentumSnapshots([snapshot], { now: 1_060_000, outputPath, intervalMs: 300_000 }), 0);
  assert.equal(recordFeeMomentumSnapshots([snapshot], { now: 1_300_000, outputPath, intervalMs: 300_000 }), 1);

  const records = fs.readFileSync(outputPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(records.length, 2);
  assert.equal(records[0].stage, "stage5_dlmm");
  assert.equal(records[0].total_fee_sol, 12);
  assert.equal(records[0].price, null);
  assert.equal(records[0].fee_active_tvl_ratio, 0.08);
});
