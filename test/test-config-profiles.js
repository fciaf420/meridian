// Config schema / profiles / migration. Everything runs against temp files and child
// processes; no network, no RPC, no live config is read or written.
import "./_bootstrap.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const FIX = path.join(HERE, "fixtures");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-profiles-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const readFix = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));

function load(which, userCfg, gmgnCfg = {}, env = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, "run-"));
  const u = path.join(dir, "user-config.json");
  const g = path.join(dir, "gmgn-config.json");
  if (userCfg !== null) fs.writeFileSync(u, JSON.stringify(userCfg, null, 2));
  fs.writeFileSync(g, JSON.stringify(gmgnCfg, null, 2));
  const cleanEnv = { ...process.env };
  for (const k of ["DRY_RUN", "USDC_MODE", "LLM_PROVIDER", "LLM_MODEL", "WEB_PORT", "GMGN_API_KEY", "RPC_URL", "WALLET_PRIVATE_KEY"]) delete cleanEnv[k];
  const r = spawnSync(process.execPath, [path.join(FIX, "dump-config.mjs"), which === "legacy" ? "test/fixtures/legacy-config.js" : "config.js"], {
    cwd: ROOT, encoding: "utf8",
    env: { ...cleanEnv, MERIDIAN_USER_CONFIG_PATH: u, MERIDIAN_GMGN_CONFIG_PATH: g, MERIDIAN_LOG_DIR: dir, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return { ...JSON.parse(r.stdout), stderr: r.stderr, userPath: u };
}

// Keys deleted on purpose (nothing read them); everything else must be identical.
function stripRemoved(c) {
  const o = structuredClone(c);
  for (const k of ["minClaimAmount", "outOfRangeBinsToClose", "minVolumeToRebalance"]) delete o.management[k];
  delete o.schedule.healthCheckIntervalMin;
  for (const k of ["requireKol", "minKolCount", "minSmartDegenCount"]) delete o.gmgn[k];
  return o;
}
function stripAdded(c) {
  const o = structuredClone(c);
  delete o.profile; delete o.learning;
  delete o.strategy.hybridBidAskPct; delete o.strategy.hybridSpotPct; // hybrid shape settings (added; defaults inert for non-hybrid configs)
  return o;
}

test("migration: the live user-config (no `profile` key) loads as custom with an IDENTICAL effective config", () => {
  const u = readFix("live-user-config.json");
  const g = readFix("live-gmgn-config.json");
  const oldL = load("legacy", u, g);
  const newL = load("new", u, g);
  assert.equal(newL.config.profile, "custom");
  assert.deepEqual(stripAdded(newL.config), stripRemoved(oldL.config));
  assert.deepEqual(newL.env, oldL.env);
});

test("migration: an explicit profile:'custom' and the other legacy shapes are identical too", () => {
  const u = readFix("live-user-config.json");
  const g = readFix("live-gmgn-config.json");
  for (const [name, userCfg, gm] of [
    ["explicit custom", { ...u, profile: "custom" }, g],
    ["empty file", {}, {}],
    ["no file", null, {}],
    ["legacy gmgn* keys", { gmgnMinMcap: 123456, gmgnRequireKol: false, minTvl: 4242 }, {}],
    ["nullable keys explicitly null", { blockTransferFeeAbovePct: null, twapSpikeMaxPct: null, minTokenAgeHours: null }, {}],
    ["usdc mode on", { usdcMode: true, deployAmountUsd: 75 }, {}],
  ]) {
    const oldL = load("legacy", userCfg, gm);
    const newL = load("new", userCfg, gm);
    assert.deepEqual(stripAdded(newL.config), stripRemoved(oldL.config), name);
  }
});

test("migration: `_last*` bookkeeping leaves user-config.json for config-state.json, values kept", () => {
  const u = readFix("live-user-config.json");
  assert.ok(u._lastEvolved && u._positionsAtEvolution && u._lastAgentTune, "fixture has the legacy keys");
  const r = load("new", u, readFix("live-gmgn-config.json"));
  const after = JSON.parse(fs.readFileSync(r.userPath, "utf8"));
  for (const k of ["_lastEvolved", "_positionsAtEvolution", "_lastAgentTune"]) assert.ok(!(k in after), k);
  const state = JSON.parse(fs.readFileSync(path.join(path.dirname(r.userPath), "config-state.json"), "utf8"));
  assert.equal(state.positionsAtEvolution, u._positionsAtEvolution);
  assert.equal(state.lastEvolved, u._lastEvolved);
  assert.equal(state.lastAgentTune, u._lastAgentTune);
  // every other key untouched
  const { _lastEvolved, _positionsAtEvolution, _lastAgentTune, ...rest } = u; // eslint-disable-line no-unused-vars
  assert.deepEqual(after, rest);
});

test("precedence: user-config wins over a stale non-secret env value (and warns)", () => {
  const r = load("new", { dryRun: true, usdcMode: false, llmProvider: "codex", llmModel: "m-user" }, {}, { DRY_RUN: "false", USDC_MODE: "true", LLM_PROVIDER: "claude", LLM_MODEL: "m-env" });
  assert.deepEqual(r.env, { DRY_RUN: "true", USDC_MODE: "false", LLM_PROVIDER: "codex", LLM_MODEL: "m-user" });
  assert.equal(r.config.usdc.enabled, false);
  assert.match(r.stderr, /DRY_RUN=false in \.env is ignored/);
  assert.match(r.stderr, /USDC_MODE=true in \.env is ignored/);
});

test("safety: DRY_RUN=true in the environment (npm run dev) still forces dry run over a live user-config; DRY_RUN=false never forces live", () => {
  const forced = load("new", { dryRun: false }, {}, { DRY_RUN: "true" });
  assert.equal(forced.env.DRY_RUN, "true");
  assert.match(forced.stderr, /forces DRY RUN for this run/);
  const stay = load("new", { dryRun: true }, {}, { DRY_RUN: "false" });
  assert.equal(stay.env.DRY_RUN, "true");
});

test("precedence: with no user-config value the old env name still works for one release, with a deprecation warning", () => {
  const r = load("new", {}, {}, { DRY_RUN: "true", USDC_MODE: "true", LLM_PROVIDER: "deepseek" });
  assert.equal(r.env.DRY_RUN, "true");
  assert.equal(r.config.usdc.enabled, true);
  assert.equal(r.env.LLM_PROVIDER, "deepseek");
  assert.match(r.stderr, /DRY_RUN in \.env is deprecated/);
});

test("precedence: usdcMode no longer has the inverted order (user-config false beats env true; before it was split)", () => {
  const oldL = load("legacy", { usdcMode: false }, {}, { USDC_MODE: "true" });
  const newL = load("new", { usdcMode: false }, {}, { USDC_MODE: "true" });
  assert.equal(newL.config.usdc.enabled, false);
  assert.equal(newL.env.USDC_MODE, "false"); // process.env agrees with config (old loader left it "true")
  assert.equal(oldL.env.USDC_MODE, "true");
});

test("secrets: .env wins; the old user-config copies still work with a deprecation warning", () => {
  const a = load("new", { rpcUrl: "http://fallback.invalid", walletKey: "x" }, {}, { RPC_URL: "http://env.invalid" });
  assert.match(a.stderr, /walletKey in user-config\.json is deprecated/);
  assert.doesNotMatch(a.stderr, /rpcUrl in user-config\.json is deprecated/); // env present → no warning
  assert.doesNotMatch(a.stderr, /http:\/\/(env|fallback)\.invalid/); // values are never printed
  const b = load("new", { rpcUrl: "http://fallback.invalid" }, {});
  assert.match(b.stderr, /rpcUrl in user-config\.json is deprecated/);
});

test("profiles: presets apply to governed keys; explicit user values still win; balanced == live values", () => {
  const live = readFix("live-user-config.json");
  const bal = load("new", { profile: "balanced" }, {});
  const custom = load("new", live, readFix("live-gmgn-config.json"));
  for (const [sec, k] of [["management", "stopLossPct"], ["management", "takeProfitFeePct"], ["management", "trailingTriggerPct"], ["management", "trailingDropPct"], ["management", "outOfRangeWaitMinutes"], ["management", "deployAmountSol"], ["management", "gasReserve"], ["management", "positionSizePct"], ["risk", "maxPositions"], ["schedule", "managementIntervalMin"], ["schedule", "screeningIntervalMin"], ["screening", "minFeeActiveTvlRatio"], ["screening", "minTvl"], ["screening", "minVolume"], ["screening", "minOrganic"], ["screening", "minMcap"], ["screening", "timeframe"], ["screening", "minTokenFeesSol"], ["screening", "maxVolatility"], ["screening", "minTokenAgeHours"], ["screening", "maxTokenAgeHours"], ["screening", "maxBinStep"], ["entryFilters", "blockTransferFeeAbovePct"], ["entryFilters", "twapSpikeMaxPct"]]) {
    assert.deepEqual(bal.config[sec][k], custom.config[sec][k], `${sec}.${k}`);
  }
  const over = load("new", { profile: "degen", stopLossPct: -12 }, {});
  assert.equal(over.config.management.stopLossPct, -12);
  assert.equal(over.config.management.takeProfitFeePct, 15);
  const cons = load("new", { profile: "conservative" }, {});
  assert.equal(cons.config.risk.maxPositions, 2);
  assert.equal(cons.config.entryFilters.blockJupiterSuspicious, true);
  const bogus = load("new", { profile: "yolo" }, {});
  assert.equal(bogus.config.profile, "custom");
  assert.match(bogus.stderr, /unknown profile "yolo"/);
});

test("autoTune defaults off", () => {
  assert.equal(load("new", {}, {}).config.learning.autoTune, false);
  assert.equal(load("new", { autoTune: true }, {}).config.learning.autoTune, true);
});

test("nit1: DRY_RUN=1/yes/ON/TRUE are normalized to dry run (not silently LIVE) and written back as exact true/false", () => {
  for (const v of ["1", "yes", "ON", "TRUE", "True"]) {
    assert.equal(load("new", { dryRun: false }, {}, { DRY_RUN: v }).env.DRY_RUN, "true", v);
    assert.equal(load("new", {}, {}, { DRY_RUN: v }).env.DRY_RUN, "true", v);
  }
  assert.equal(load("new", {}, {}, { DRY_RUN: "no" }).env.DRY_RUN, "false");
  assert.equal(load("new", {}, {}, { DRY_RUN: "0" }).env.DRY_RUN, "false");
});

test("nit2: one-time user-config.json.pre-profiles.bak is written before the rewrite and never overwritten", () => {
  const u = readFix("live-user-config.json");
  const r = load("new", u, readFix("live-gmgn-config.json"));
  const bak = r.userPath + ".pre-profiles.bak";
  assert.deepEqual(JSON.parse(fs.readFileSync(bak, "utf8")), u);
  const again = { ...JSON.parse(fs.readFileSync(r.userPath, "utf8")), _lastEvolved: "newer" };
  fs.writeFileSync(r.userPath, JSON.stringify(again));
  const dir = path.dirname(r.userPath);
  spawnSync(process.execPath, [path.join(FIX, "dump-config.mjs"), "config.js"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, MERIDIAN_USER_CONFIG_PATH: r.userPath, MERIDIAN_GMGN_CONFIG_PATH: path.join(dir, "gmgn-config.json"), MERIDIAN_LOG_DIR: dir } });
  assert.ok(!("_lastEvolved" in JSON.parse(fs.readFileSync(r.userPath, "utf8"))), "second migration ran");
  assert.deepEqual(JSON.parse(fs.readFileSync(bak, "utf8")), u, "backup untouched");
});

test("nit6: statePath decodes the module URL (checkout path with a space)", () => {
  const dir = fs.mkdtempSync(path.join(TMP, "dir with space "));
  for (const f of ["config-state.js", "config-paths.js", "atomic-write.js"]) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  const env = { ...process.env }; delete env.MERIDIAN_USER_CONFIG_PATH; delete env.MERIDIAN_CONFIG_STATE_PATH; delete env.MERIDIAN_CONFIG_DIR;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { statePath, updateConfigState } from ${JSON.stringify(path.join(dir, "config-state.js"))}; updateConfigState({ a: 1 }); console.log(statePath());`], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), path.join(dir, "config-state.json"));
  assert.ok(fs.existsSync(path.join(dir, "config-state.json")));
});

test("nit4: gmgn-config.example.json has none of the removed keys", () => {
  const ex = fs.readFileSync(path.join(ROOT, "gmgn-config.example.json"), "utf8");
  for (const k of ["minSmartDegenCount", "requireKol", "minKolCount"]) assert.ok(!ex.includes(k), k);
});
