/**
 * Warm-up spike guard in updatePnlAndCheckExits (state.js).
 *
 * state.js reads/writes ./state.json relative to the cwd, so this test chdirs
 * into a temp dir BEFORE importing it — it must never touch the live state file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-pnl-warmup-"));
process.chdir(tmp);
process.env.DRY_RUN = "true";

const { trackPosition, updatePnlAndCheckExits, getTrackedPosition } = await import(
  new URL("../state.js", import.meta.url)
);

const config = {
  management: {
    stopLossPct: -10,
    trailingTakeProfit: true,
    trailingTriggerPct: 5,
    trailingDropPct: 4,
    pnlWarmupMinutes: 15,
    pnlWarmupMaxAbsPct: 25,
  },
};

let n = 0;
function open({ ageMin }) {
  const position = `Pos${++n}${"x".repeat(30)}`;
  trackPosition({
    position,
    pool: "Pool111111111111111111111111111111111111111",
    pool_name: "TEST-SOL",
    strategy: "bid_ask",
    amount_sol: 1.1,
    deployed_at: new Date(Date.now() - ageMin * 60_000).toISOString(),
  });
  return position;
}

test("young position: a lone +48.6% spike does not arm trailing TP or close", () => {
  const p = open({ ageMin: 0.5 });
  assert.equal(updatePnlAndCheckExits(p, 48.6, config), null);
  assert.equal(getTrackedPosition(p).trailing_active ?? false, false);
  // the next, normal reading must not be treated as a drop from a 48.6% peak
  assert.equal(updatePnlAndCheckExits(p, 2.1, config), null);
  assert.equal(getTrackedPosition(p).trailing_active ?? false, false);
});

test("young position: a real crash still stops out one tick later", () => {
  const p = open({ ageMin: 2 });
  assert.equal(updatePnlAndCheckExits(p, -35, config), null); // held as pending
  const action = updatePnlAndCheckExits(p, -38, config); // confirmed
  assert.match(action ?? "", /^STOP_LOSS/);
});

test("young position: ordinary readings are unaffected (stop loss at -12%)", () => {
  const p = open({ ageMin: 1 });
  assert.match(updatePnlAndCheckExits(p, -12, config) ?? "", /^STOP_LOSS/);
});

test("young position: a stale pending spike cannot confirm a later one", () => {
  const p = open({ ageMin: 1 });
  assert.equal(updatePnlAndCheckExits(p, 40, config), null); // pending
  assert.equal(updatePnlAndCheckExits(p, 1, config), null);  // clears pending
  assert.equal(updatePnlAndCheckExits(p, 42, config), null); // new pending, not confirmed
  assert.equal(getTrackedPosition(p).trailing_active ?? false, false);
});

test("mature position: large readings are trusted as before", () => {
  const p = open({ ageMin: 60 });
  assert.equal(updatePnlAndCheckExits(p, 48.6, config), null);
  assert.equal(getTrackedPosition(p).trailing_active, true);
  assert.match(updatePnlAndCheckExits(p, 40, config) ?? "", /^TRAILING_TP/);
});
