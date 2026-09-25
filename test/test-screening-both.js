/**
 * screeningSource "both": combined Meteora + GMGN discovery. Both discovery
 * functions and the pool lookup are injected, so there is no network access.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.DRY_RUN = "true";

const { discoverCombinedPools, combineCandidates } = await import("../tools/screening-both.js");
const { normalizeScreeningSource } = await import("../runtime-helpers.js");
const { rankCandidatesByDarwin, formatCandidateSources } = await import("../tools/screening.js");
const { formatGmgnCandidateForPrompt } = await import("../tools/gmgn-screen.js");

const SCREENING = { minBinStep: 80, maxBinStep: 125, maxVolatility: 8, minTvl: 10_000, maxTvl: 150_000 };

function meteora(pool, mint, extra = {}) {
  return {
    pool, name: `${mint}-SOL`, base: { symbol: mint, mint }, quote: { symbol: "SOL" },
    bin_step: 100, tvl: 50_000, active_tvl: 40_000, fee_active_tvl_ratio: 0.1, volatility: 2,
    holders: 1000, mcap: 500_000, organic_score: 70, ...extra,
  };
}

function gmgn(pool, mint, extra = {}) {
  return {
    pool, name: `${mint}-SOL`, base: { symbol: mint, mint }, quote: { symbol: "SOL" },
    bin_step: 100, tvl: 30_000, active_tvl: 30_000, fee_active_tvl_ratio: 0.2, volatility: 3,
    holders: 2000, mcap: 400_000, gmgn: true, gmgn_kol_wallets: 3, gmgn_smart_wallets: 5,
    gmgn_kol_names: ["alice"], indicators: { rsi: 40, supertrendDirection: "bullish" }, ...extra,
  };
}

const noLookup = async () => { throw new Error("lookup should not be called"); };

function deps(overrides = {}) {
  return {
    screening: SCREENING,
    lookupPool: noLookup,
    discoverMeteora: async () => ({ pools: [] }),
    discoverGmgn: async () => ({ pools: [] }),
    ...overrides,
  };
}

test("dedups by pool address and merges provenance", async () => {
  const { pools, stats } = await combineCandidates({
    meteora: [meteora("P1", "AAA")],
    gmgn: [gmgn("P1", "AAA")],
    screening: SCREENING, lookupPool: noLookup,
  });
  assert.equal(pools.length, 1);
  const c = pools[0];
  assert.deepEqual(c.sources, ["meteora", "gmgn"]);
  assert.equal(c.confirmed_by_both, true);
  // Meteora pool metrics win; GMGN token signals are added.
  assert.equal(c.fee_active_tvl_ratio, 0.1);
  assert.equal(c.tvl, 50_000);
  assert.equal(c.holders, 1000);
  assert.equal(c.gmgn_kol_wallets, 3);
  assert.equal(c.gmgn_smart_wallets, 5);
  assert.deepEqual(c.indicators, { rsi: 40, supertrendDirection: "bullish" });
  assert.equal(c.gmgn_pool, undefined);
  assert.equal(stats.pool_overlaps, 1);
});

test("keeps one pool per token: higher fee/active-TVL, then higher TVL", async () => {
  const { pools, dropped } = await combineCandidates({
    meteora: [
      meteora("P1", "AAA", { fee_active_tvl_ratio: 0.1 }),
      meteora("P2", "AAA", { fee_active_tvl_ratio: 0.3 }),
      meteora("P3", "BBB", { fee_active_tvl_ratio: 0.2, tvl: 20_000 }),
      meteora("P4", "BBB", { fee_active_tvl_ratio: 0.2, tvl: 90_000 }),
      // fee/TVL only (no fee/active-TVL) is still comparable
      meteora("P5", "CCC", { fee_active_tvl_ratio: null, fee_tvl_ratio: 0.5 }),
      meteora("P6", "CCC", { fee_active_tvl_ratio: 0.4 }),
    ],
    gmgn: [],
    screening: SCREENING, lookupPool: noLookup,
  });
  const byMint = Object.fromEntries(pools.map((p) => [p.base.mint, p.pool]));
  assert.deepEqual(byMint, { AAA: "P2", BBB: "P4", CCC: "P5" });
  assert.equal(dropped.filter((d) => /same token/.test(d.reason)).length, 3);
});

test("same token in different pools across sources is confirmed_by_both", async () => {
  const { pools, stats } = await combineCandidates({
    meteora: [meteora("PM", "AAA", { fee_active_tvl_ratio: 0.5 })],
    gmgn: [gmgn("PG", "AAA", { fee_active_tvl_ratio: 0.2 })],
    screening: SCREENING, lookupPool: noLookup,
  });
  assert.equal(pools.length, 1);
  assert.equal(pools[0].pool, "PM");
  assert.deepEqual(pools[0].sources, ["meteora", "gmgn"]);
  assert.equal(pools[0].confirmed_by_both, true);
  assert.equal(pools[0].gmgn_kol_wallets, 3);
  assert.equal(pools[0].gmgn_pool, "PG");
  assert.equal(stats.token_overlaps, 1);
});

test("confirmed_by_both sorts first, then fee/active-TVL; limit truncates", async () => {
  const { pools, total_merged } = await combineCandidates({
    meteora: [
      meteora("P1", "AAA", { fee_active_tvl_ratio: 0.9 }),
      meteora("P2", "BBB", { fee_active_tvl_ratio: 0.1 }),
      meteora("P3", "CCC", { fee_active_tvl_ratio: 0.5 }),
      meteora("P4", "DDD", { fee_active_tvl_ratio: 0.3 }),
    ],
    gmgn: [gmgn("P2", "BBB"), gmgn("P5", "EEE", { fee_active_tvl_ratio: 0.7 })],
    limit: 3,
    screening: SCREENING, lookupPool: noLookup,
  });
  assert.equal(total_merged, 5);
  assert.deepEqual(pools.map((p) => p.pool), ["P2", "P1", "P5"]);
  assert.deepEqual(pools.map((p) => p.sources), [["meteora", "gmgn"], ["meteora"], ["gmgn"]]);
});

test("Darwin re-ranking keeps confirmed_by_both first", () => {
  const ranked = rankCandidatesByDarwin([
    meteora("P1", "AAA", { fee_active_tvl_ratio: 5 }),
    { ...meteora("P2", "BBB", { fee_active_tvl_ratio: 0.01 }), confirmed_by_both: true, sources: ["meteora", "gmgn"] },
  ]);
  assert.equal(ranked[0].pool, "P2");
});

test("GMGN failing → Meteora results only", async () => {
  const result = await discoverCombinedPools({
    limit: 5,
    deps: deps({
      discoverMeteora: async () => ({ pools: [meteora("P1", "AAA")] }),
      discoverGmgn: async () => { throw new Error("gmgn-cli exploded"); },
    }),
  });
  assert.deepEqual(result.pools.map((p) => p.pool), ["P1"]);
  assert.deepEqual(result.pools[0].sources, ["meteora"]);
  assert.match(result.errors.gmgn, /exploded/);
  assert.equal(result.errors.meteora, undefined);
});

test("GMGN timing out → Meteora results only", async () => {
  const result = await discoverCombinedPools({
    limit: 5,
    deps: deps({
      discoverMeteora: async () => ({ pools: [meteora("P1", "AAA")] }),
      discoverGmgn: () => new Promise(() => {}), // never settles
      gmgnTimeoutMs: 20,
    }),
  });
  assert.deepEqual(result.pools.map((p) => p.pool), ["P1"]);
  assert.match(result.errors.gmgn, /timed out/);
});

test("Meteora failing → GMGN results only", async () => {
  const result = await discoverCombinedPools({
    limit: 5,
    deps: deps({
      discoverMeteora: async () => { throw new Error("502 Bad Gateway"); },
      discoverGmgn: async () => ({ pools: [gmgn("PG", "AAA")] }),
    }),
  });
  assert.deepEqual(result.pools.map((p) => p.pool), ["PG"]);
  assert.deepEqual(result.pools[0].sources, ["gmgn"]);
  assert.match(result.errors.meteora, /502/);
});

test("both sources failing → empty list, no throw", async () => {
  const result = await discoverCombinedPools({
    deps: deps({
      discoverMeteora: async () => { throw new Error("m"); },
      discoverGmgn: async () => { throw new Error("g"); },
    }),
  });
  assert.deepEqual(result.pools, []);
  assert.deepEqual(Object.keys(result.errors).sort(), ["gmgn", "meteora"]);
});

test("GMGN picks outside bin-step range, TVL range or over max volatility are dropped", async () => {
  const { pools, dropped } = await combineCandidates({
    meteora: [],
    gmgn: [
      gmgn("G1", "LOW", { bin_step: 20 }),
      gmgn("G2", "HIGH", { bin_step: 200 }),
      gmgn("G3", "VOL", { volatility: 12 }),
      gmgn("G4", "TVL", { tvl: 500_000 }),
      gmgn("G5", "OK"),
    ],
    screening: SCREENING, lookupPool: noLookup,
  });
  assert.deepEqual(pools.map((p) => p.pool), ["G5"]);
  const reasons = Object.fromEntries(dropped.map((d) => [d.pool, d.reason]));
  assert.match(reasons.G1, /bin_step 20 < min 80/);
  assert.match(reasons.G2, /bin_step 200 > max 125/);
  assert.match(reasons.G3, /volatility 12 > max 8/);
  assert.match(reasons.G4, /tvl 500000 > max 150000/);
});

test("the filters are not applied to Meteora picks (Meteora filters server-side)", async () => {
  const { pools } = await combineCandidates({
    meteora: [meteora("M1", "AAA", { bin_step: 20 })],
    gmgn: [gmgn("M1", "AAA", { bin_step: 20 })],
    screening: SCREENING, lookupPool: noLookup,
  });
  assert.equal(pools.length, 1);
  assert.equal(pools[0].confirmed_by_both, true);
});

test("unknown bin_step is looked up, then filtered", async () => {
  const looked = [];
  const lookupPool = async (addr) => {
    looked.push(addr);
    return { G1: { bin_step: 100, tvl: 30_000, volatility: 2 }, G2: { bin_step: 250, tvl: 30_000, volatility: 2 } }[addr] ?? null;
  };
  const { pools, dropped, stats } = await combineCandidates({
    meteora: [],
    gmgn: [gmgn("G1", "AAA", { bin_step: null }), gmgn("G2", "BBB", { bin_step: null })],
    screening: SCREENING, lookupPool,
  });
  assert.deepEqual(looked.sort(), ["G1", "G2"]);
  assert.equal(stats.lookups, 2);
  assert.deepEqual(pools.map((p) => [p.pool, p.bin_step]), [["G1", 100]]);
  assert.match(dropped.find((d) => d.pool === "G2").reason, /bin_step 250 > max/);
});

test("unknown bin_step is dropped, not accepted, when the lookup fails or is capped", async () => {
  const { pools, dropped } = await combineCandidates({
    meteora: [],
    gmgn: [
      gmgn("G1", "AAA", { bin_step: null }),
      gmgn("G2", "BBB", { bin_step: null }),
      gmgn("G3", "CCC", { bin_step: undefined }),
    ],
    screening: SCREENING,
    maxLookups: 2,
    lookupPool: async (addr) => { if (addr === "G1") throw new Error("404"); return null; },
  });
  assert.deepEqual(pools, []);
  const reasons = Object.fromEntries(dropped.map((d) => [d.pool, d.reason]));
  assert.match(reasons.G1, /bin_step unknown \(lookup failed\)/);
  assert.match(reasons.G2, /bin_step unknown \(lookup failed\)/);
  assert.match(reasons.G3, /bin_step unknown \(lookup cap 2 reached\)/);
});

test("a filtered GMGN pool cannot beat the Meteora pool of the same token", async () => {
  const { pools } = await combineCandidates({
    meteora: [meteora("PM", "AAA", { fee_active_tvl_ratio: 0.1 })],
    gmgn: [gmgn("PG", "AAA", { fee_active_tvl_ratio: 9, bin_step: 10 })],
    screening: SCREENING, lookupPool: noLookup,
  });
  assert.deepEqual(pools.map((p) => p.pool), ["PM"]);
  // GMGN still found the token, so it counts as confirmed.
  assert.equal(pools[0].confirmed_by_both, true);
});

test("invalid screeningSource falls back to meteora with a warning", () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.equal(normalizeScreeningSource("both", { warn }), "both");
  assert.equal(normalizeScreeningSource(" GMGN ", { warn }), "gmgn");
  assert.equal(normalizeScreeningSource(undefined, { warn }), "meteora");
  assert.equal(warnings.length, 0);
  assert.equal(normalizeScreeningSource("bogus", { warn }), "meteora");
  assert.equal(normalizeScreeningSource(42, { warn }), "meteora");
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /bogus/);
});

test("prompt formatters show the source", () => {
  const merged = { ...meteora("P1", "AAA"), ...gmgn("P1", "AAA"), sources: ["meteora", "gmgn"], confirmed_by_both: true };
  assert.equal(formatCandidateSources(merged), "src: meteora+gmgn (confirmed by both)");
  assert.equal(formatCandidateSources(meteora("P1", "AAA")), "");
  assert.match(formatGmgnCandidateForPrompt(merged), /src=meteora\+gmgn \(confirmed by both\)/);
  assert.doesNotMatch(formatGmgnCandidateForPrompt(gmgn("P1", "AAA")), /src=/);
});
