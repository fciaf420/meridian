import test from "node:test";
import assert from "node:assert/strict";

import {
  CONFIG_KEY_MAP,
  calculateBinsForPriceRange,
  getEffectiveMinSolToOpen,
  normalizeCandidatesPayload,
  getScreeningThresholdSummary,
  getStartupMode,
  splitRangeBins,
} from "../runtime-helpers.js";
import { normalizeCandidateForUi } from "../tools/screening.js";

test("calculateBinsForPriceRange uses the actual bin step", () => {
  assert.equal(calculateBinsForPriceRange(80, 35), 54);
  assert.equal(calculateBinsForPriceRange(125, 35), 34);
});

test("splitRangeBins keeps the full range intact", () => {
  assert.deepEqual(splitRangeBins(56, 80), { binsBelow: 45, binsAbove: 11 });
});

test("effective min SOL to open always covers deploy floor plus reserve", () => {
  assert.equal(
    getEffectiveMinSolToOpen({ minSolToOpen: 0.55, deployAmountSol: 0.5, gasReserve: 0.2 }),
    0.7,
  );
  assert.equal(
    getEffectiveMinSolToOpen({ minSolToOpen: 1.2, deployAmountSol: 0.5, gasReserve: 0.2 }),
    1.2,
  );
});

test("config key map routes minBinStep to screening", () => {
  assert.deepEqual(CONFIG_KEY_MAP.minBinStep, ["screening", "minBinStep"]);
});

test("screening threshold summary exposes the canonical field names", () => {
  const labels = getScreeningThresholdSummary({
    maxVolatility: 8,
    minFeeActiveTvlRatio: 0.05,
    minOrganic: 65,
    minHolders: 500,
    maxPriceChangePct: 300,
    timeframe: "4h",
    minTokenFeesSol: 30,
  }).map(([label]) => label);

  assert.ok(labels.includes("minFeeActiveTvlRatio"));
  assert.ok(!labels.includes("minFeeTvlRatio"));
});

test("startup mode keeps the server enabled in non-TTY runs", () => {
  assert.equal(getStartupMode({ isTTY: false }).startServer, true);
  assert.equal(getStartupMode({ isTTY: false }).runStartupCheck, true);
});

test("candidate normalization preserves the UI contract", () => {
  const current = normalizeCandidateForUi({
    name: "POOL",
    pool: "abc",
    volume: 1234,
    active_pct: 45.6,
  });
  assert.equal(current.volume, 1234);
  assert.equal(current.active_pct, 45.6);

  const legacy = normalizeCandidateForUi({
    name: "POOL",
    pool: "abc",
    volume_window: 4321,
    active_bin_pct: 12.3,
  });
  assert.equal(legacy.volume, 4321);
  assert.equal(legacy.active_pct, 12.3);
});

test("candidate payload normalization keeps only valid UI candidates", () => {
  const normalized = normalizeCandidatesPayload({
    candidates: [
      { pool: "abc", name: "POOL", volume: 1234, active_pct: 45 },
      { pool: "", name: "bad" },
    ],
    total_eligible: 7,
    total_screened: 50,
  });

  assert.deepEqual(normalized, {
    candidates: [
      {
        pool: "abc",
        name: "POOL",
        fee_active_tvl_ratio: null,
        volume: 1234,
        organic_score: null,
        active_pct: 45,
      },
    ],
    total_eligible: 7,
    total_screened: 50,
  });
});
