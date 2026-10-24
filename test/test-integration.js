// Cross-branch integration checks (release/review-hardening).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeResolver, BY_KEY } from "../settings-schema.js";
import { config } from "../config.js";

test("integrate: bidAskFlip nested user-config object resolves through the schema; flat key wins", () => {
  const r = makeResolver({ bidAskFlip: { mode: "live", fillPct: 40 } });
  assert.equal(r.get("bidAskFlipMode"), "live");
  assert.equal(r.get("bidAskFlipFillPct"), 40);
  assert.equal(r.get("bidAskFlipReflipStepPct"), 20);
  const flat = makeResolver({ bidAskFlipMode: "off", bidAskFlip: { mode: "live" } });
  assert.equal(flat.get("bidAskFlipMode"), "off");
  assert.equal(makeResolver({}).get("bidAskFlipMode"), "shadow", "default stays shadow");
});

test("integrate: every safety/exits/gmgn-fail-closed config leaf has a schema row with the config.js default", () => {
  for (const k of ["recheckScreeningAtDeploy", "requireKnownVolatility", "maxEntryPriceMovePct", "maxScreenToDeployDropPct", "depositSlippagePct",
    "exitConfirmTicks", "peakConfirmTicks", "stopLossCooldownMinutes", "oorCooldownMinutes", "feeDataDownRatio", "bidAskFlipMode"]) {
    assert.ok(BY_KEY.get(k), `schema row ${k}`);
  }
  assert.equal(config.safety.maxScreenToDeployDropPct, 12);
  assert.equal(config.exits.confirmTicks, 2);
  assert.equal(config.exits.peakConfirmTicks, 2);
  assert.equal(config.bidAskFlip.mode, "shadow");
});

test("integrate: the flip runs after the code-fired closes and live flips take the wallet lock", () => {
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.ok(idx.indexOf("runManagementCodeRules(precheckedPositions") < idx.indexOf("m.runBidAskFlips("), "flip after code rules");
  const flip = fs.readFileSync(new URL("../tools/bidask-flip.js", import.meta.url), "utf8");
  assert.match(flip, /withWalletLock\(run, 1, "bidask_flip"\)/);
  assert.doesNotMatch(flip, /process\.env\.DRY_RUN/);
});
