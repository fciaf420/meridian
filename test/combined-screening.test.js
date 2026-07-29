import test from "node:test";
import assert from "node:assert/strict";
import { combineCandidateDiscoveries, formatOpportunityNearMisses, getEligibilityActivityRejectReason } from "../tools/screening.js";

test("uses healthy 30m activity for eligibility when 5m activity is zero", () => {
  const pool = {
    fee_active_tvl_ratio: 0,
    volume_window: 0,
    swap_count: 0,
    fee_active_tvl_ratio_30m: 0.09,
    volume_30m: 1_100,
    swap_count_30m: 31,
  };

  assert.equal(getEligibilityActivityRejectReason(pool, {
    timeframe: "30m",
    minFeeActiveTvlRatio: 0.05,
    minVolume: 1_000,
  }), null);
});

test("rejects weak 30m activity even when 5m activity is strong", () => {
  const pool = {
    fee_active_tvl_ratio: 0.5,
    volume_window: 5_000,
    fee_active_tvl_ratio_30m: 0.04,
    volume_30m: 900,
  };

  assert.match(getEligibilityActivityRejectReason(pool, {
    timeframe: "30m",
    minFeeActiveTvlRatio: 0.05,
    minVolume: 1_000,
  }), /30m fee\/active-TVL 0.04 below 0.05/);
});

test("formats at most three opportunity near misses without candidate payloads", () => {
  const summary = formatOpportunityNearMisses([
    { candidate: { name: "ALPHA-SOL", pool: "AlphaPoolAddress" }, score: 39.25 },
    { candidate: { name: "BETA-SOL", pool: "BetaPoolAddress" }, score: 37 },
    { candidate: { name: "GAMMA-SOL", pool: "GammaPoolAddress" }, score: 35.5 },
    { candidate: { name: "DELTA-SOL", pool: "DeltaPoolAddress" }, score: 34 },
  ], 40);

  assert.equal(
    summary,
    "ALPHA-SOL AlphaPoo score=39.3 trigger=40.0 gap=0.8 | " +
      "BETA-SOL BetaPool score=37.0 trigger=40.0 gap=3.0 | " +
      "GAMMA-SOL GammaPoo score=35.5 trigger=40.0 gap=4.5",
  );
  assert.doesNotMatch(summary, /DELTA|DeltaPool/);
});

test("combines unique Meteora and GMGN candidates", () => {
  const combined = combineCandidateDiscoveries(
    { total: 2, pools: [{ pool: "meteora-only", tvl: 10 }, { pool: "shared", tvl: 20 }] },
    { total: 2, pools: [{ pool: "gmgn-only", gmgn: true }, { pool: "shared", gmgn: true }] },
  );

  assert.deepEqual(combined.pools.map((pool) => pool.pool), ["meteora-only", "shared", "gmgn-only"]);
  assert.deepEqual(combined.pools[0].sources, ["meteora"]);
  assert.deepEqual(combined.pools[2].sources, ["gmgn"]);
});

test("deduplicates a shared pool and keeps Meteora live metrics with GMGN enrichment", () => {
  const combined = combineCandidateDiscoveries(
    {
      total: 1,
      pools: [{
        pool: "shared",
        base: { mint: "mint", symbol: "TOKEN", organic: 88 },
        tvl: 50_000,
        active_tvl: 40_000,
        volume_window: 12_000,
        fee_active_tvl_ratio: 0.08,
        volatility: 1.25,
        organic_score: 88,
      }],
      filtered_examples: [{ name: "M", reason: "meteora reject" }],
    },
    {
      total: 1,
      pools: [{
        pool: "shared",
        base: { mint: "mint", symbol: "TOKEN", organic: null },
        tvl: 45_000,
        active_tvl: 35_000,
        volume_window: 9_000,
        fee_active_tvl_ratio: 0.05,
        volatility: 0.75,
        gmgn: true,
        gmgn_score: 321,
        gmgn_smart_wallets: 7,
      }],
      filtered_examples: [{ name: "G", reason: "gmgn reject" }],
      stage_counts: { s1: 4, s5: 1 },
    },
  );

  assert.equal(combined.pools.length, 1);
  assert.deepEqual(combined.pools[0].sources, ["meteora", "gmgn"]);
  assert.equal(combined.pools[0].tvl, 50_000);
  assert.equal(combined.pools[0].active_tvl, 40_000);
  assert.equal(combined.pools[0].volume_window, 12_000);
  assert.equal(combined.pools[0].fee_active_tvl_ratio, 0.08);
  assert.equal(combined.pools[0].volatility, 1.25);
  assert.equal(combined.pools[0].base.organic, 88);
  assert.equal(combined.pools[0].gmgn_score, 321);
  assert.equal(combined.pools[0].gmgn_smart_wallets, 7);
  assert.equal(combined.total, 2);
  assert.equal(combined.filtered_examples.length, 2);
  assert.deepEqual(combined.stage_counts, { ranked: 1, s1: 4, s5: 1 });
});

test("does not deduplicate different pools for the same token mint", () => {
  const combined = combineCandidateDiscoveries(
    { total: 1, pools: [{ pool: "pool-a", base: { mint: "same-mint" } }] },
    { total: 1, pools: [{ pool: "pool-b", base: { mint: "same-mint" }, gmgn: true }] },
  );

  assert.deepEqual(combined.pools.map((pool) => pool.pool), ["pool-a", "pool-b"]);
});

test("keeps addressless candidates separate", () => {
  const combined = combineCandidateDiscoveries(
    { total: 1, pools: [{ name: "meteora-missing-address" }] },
    { total: 1, pools: [{ name: "gmgn-missing-address", gmgn: true }] },
  );

  assert.equal(combined.pools.length, 2);
  assert.deepEqual(combined.pools.map((pool) => pool.sources), [["meteora"], ["gmgn"]]);
});

test("does not label duplicate GMGN records as Meteora sourced", () => {
  const combined = combineCandidateDiscoveries(
    { total: 0, pools: [] },
    {
      total: 2,
      pools: [
        { pool: "shared-gmgn", gmgn: true, gmgn_score: 100 },
        { pool: "shared-gmgn", gmgn: true, gmgn_score: 200 },
      ],
    },
  );

  assert.equal(combined.pools.length, 1);
  assert.deepEqual(combined.pools[0].sources, ["gmgn"]);
  assert.equal(combined.pools[0].gmgn_score, 200);
});
