import "./_bootstrap.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import {
  evaluateBootConfig, activeOverrides, dataPath, rootDataPath, logDir, dataDirOverride, repoRoot,
  userConfigPath, gmgnConfigPath, configStatePath,
} from "../config-paths.js";
import { snapshotTree, diffSnapshots } from "../scripts/test-runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inside = (p, dir) => { const r = path.relative(path.resolve(dir), path.resolve(p)); return r && !r.startsWith("..") && !path.isAbsolute(r); };

// ── F3: every resolved path stays out of the checkout when the env is pinned ──
test("with the test env pinned, every resolved data/config/log path is outside the checkout", () => {
  for (const v of ["MERIDIAN_CONFIG_DIR", "MERIDIAN_DATA_DIR", "MERIDIAN_LOG_DIR"]) {
    assert.ok(process.env[v], `${v} must be set`);
    assert.ok(!inside(process.env[v], ROOT) && path.resolve(process.env[v]) !== ROOT, `${v} must not be the checkout`);
  }
  const paths = [
    userConfigPath(), gmgnConfigPath(), configStatePath(), logDir(),
    rootDataPath("knowledge"), rootDataPath("lessons.json"), rootDataPath("pool-memory.json"), rootDataPath("smart-wallets.json"),
    rootDataPath("autoresearch.json"), rootDataPath("solanatracker-usage.json"),
    ...["state.json", "lessons.json", "pool-memory.json", "signal-weights.json", "strategy-library.json", "token-blacklist.json", "deploy-attempts.json", "logs"].map((n) => dataPath(n)),
  ];
  for (const p of paths) assert.ok(path.isAbsolute(p) && !inside(p, ROOT), `${p} resolves inside the checkout`);
});

test("data helpers: unset -> historical locations; set -> inside MERIDIAN_DATA_DIR", () => {
  assert.equal(dataPath("state.json", {}), "./state.json");
  assert.equal(rootDataPath("knowledge", {}), path.join(repoRoot(), "knowledge"));
  assert.equal(logDir({}), "./logs");
  const env = { MERIDIAN_DATA_DIR: "/d" };
  assert.equal(dataDirOverride(env), "/d");
  assert.equal(dataPath("state.json", env), "/d/state.json");
  assert.equal(rootDataPath("knowledge", env), "/d/knowledge");
  assert.equal(logDir(env), "/d/logs");
  assert.equal(logDir({ ...env, MERIDIAN_LOG_DIR: "/l" }), "/l");
});

test("source guard: no module hard-codes a checkout-relative data file outside config-paths.js", () => {
  const files = [...fs.readdirSync(ROOT).filter((f) => f.endsWith(".js")), ...fs.readdirSync(path.join(ROOT, "tools")).filter((f) => f.endsWith(".js")).map((f) => "tools/" + f)];
  const bad = [];
  for (const f of files) {
    if (f === "config-paths.js") continue;
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    src.split("\n").forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || /knowledgeBase/.test(line)) return; // knowledgeBase.dir is resolved under MERIDIAN_DATA_DIR
      if (/["'`]\.\/[\w.-]+\.(json|jsonl)["'`]/.test(line) || /["'`]\.\/(logs|knowledge)["'`/]/.test(line)
        || /path\.join\(__dirname,\s*["'`][\w.-]+\.json/.test(line) || /path\.resolve\(["'`][\w.-]+\.json/.test(line)) bad.push(`${f}:${i + 1}: ${t}`);
    });
  }
  assert.deepEqual(bad, []);
});

test("snapshot diff helper detects create / modify / delete", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-snap-"));
  fs.writeFileSync(path.join(d, "a"), "1"); fs.writeFileSync(path.join(d, "b"), "1");
  const s1 = snapshotTree(d);
  fs.writeFileSync(path.join(d, "a"), "2"); fs.rmSync(path.join(d, "b")); fs.writeFileSync(path.join(d, "c"), "x");
  assert.deepEqual(diffSnapshots(s1, snapshotTree(d)).sort(), ["created  c", "deleted  b", "modified a"]);
  fs.rmSync(d, { recursive: true, force: true });
});

// ── F1: boot guard ────────────────────────────────────────────────────────────
test("evaluateBootConfig: no overrides + missing default-root user-config -> refuse (npm run setup), unless DRY_RUN", () => {
  const r = evaluateBootConfig({}, () => false);
  assert.equal(r.ok, false);
  assert.match(r.error, /npm run setup/);
  assert.deepEqual(r.overrides, []);
  assert.equal(evaluateBootConfig({ DRY_RUN: "true" }, () => false).ok, true);
  assert.equal(evaluateBootConfig({ DRY_RUN: "false" }, () => false).ok, false);
  assert.equal(evaluateBootConfig({}, () => true).ok, true);
});

test("evaluateBootConfig: MERIDIAN_DATA_DIR with no state.json and no deploy-attempts.json -> refuse unless DRY_RUN", () => {
  const has = (set) => (p) => set.some((x) => p.endsWith(x));
  const env = { MERIDIAN_DATA_DIR: "/d" };
  const r = evaluateBootConfig(env, has(["user-config.json"]));
  assert.equal(r.ok, false);
  assert.match(r.error, /empty data dir/);
  assert.equal(evaluateBootConfig(env, has(["user-config.json", "state.json"])).ok, true);
  assert.equal(evaluateBootConfig(env, has(["user-config.json", "deploy-attempts.json"])).ok, true);
  assert.equal(evaluateBootConfig({ ...env, DRY_RUN: "1" }, has(["user-config.json"])).ok, true);
});

test("index.js: boot-guard is the second import, right after dotenv; nothing else precedes it", () => {
  const imports = fs.readFileSync(path.join(ROOT, "index.js"), "utf8").split("\n").filter((l) => /^import\s/.test(l));
  assert.equal(imports[0], 'import "dotenv/config";');
  assert.equal(imports[1], 'import "./boot-guard.js";');
});

test("evaluateBootConfig: override + missing user-config -> refuse, message names var and path", () => {
  for (const k of ["MERIDIAN_CONFIG_DIR", "MERIDIAN_USER_CONFIG_PATH", "MERIDIAN_DATA_DIR", "MERIDIAN_GMGN_CONFIG_PATH", "MERIDIAN_CONFIG_STATE_PATH"]) {
    const env = { [k]: "/nope/x" };
    const r = evaluateBootConfig(env, () => false);
    assert.equal(r.ok, false, k);
    assert.match(r.error, new RegExp(k));
    assert.match(r.error, /user-config\.json/);
    assert.match(r.error, /Refusing to start/);
  }
});

test("evaluateBootConfig: override + user-config present -> ok but overrides listed; empty string ignored", () => {
  assert.equal(evaluateBootConfig({ MERIDIAN_CONFIG_DIR: "/c" }, () => true).ok, true);
  assert.deepEqual(activeOverrides({ MERIDIAN_CONFIG_DIR: "/c", MERIDIAN_DATA_DIR: "/d", MERIDIAN_LOG_DIR: "/l", MERIDIAN_SKIP_INSTANCE_LOCK: "1" }), ["MERIDIAN_CONFIG_DIR", "MERIDIAN_DATA_DIR", "MERIDIAN_LOG_DIR"]);
  assert.deepEqual(activeOverrides({ MERIDIAN_DEPLOY_ATTEMPTS_FILE: "/a", MERIDIAN_AUTORESEARCH_FILE: "/b", MERIDIAN_ST_USAGE_PATH: "/c", MERIDIAN_OHLCV_OFFLINE: "1" }), ["MERIDIAN_AUTORESEARCH_FILE", "MERIDIAN_DEPLOY_ATTEMPTS_FILE", "MERIDIAN_ST_USAGE_PATH"]);
  assert.deepEqual(activeOverrides({ MERIDIAN_CONFIG_DIR: "" }), []);
});

function runGuard(env, { live = false } = {}) {
  const log = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-guard-log-"));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("MERIDIAN_")));
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", 'await import("./boot-guard.js"); console.log("BOOTED");'], {
    cwd: ROOT, encoding: "utf8", env: { ...clean, ...(live ? {} : { DRY_RUN: "true" }), MERIDIAN_LOG_DIR: log, ...env },
  });
  const logs = fs.readdirSync(log).filter((f) => f.startsWith("agent-")).map((f) => fs.readFileSync(path.join(log, f), "utf8")).join("\n");
  fs.rmSync(log, { recursive: true, force: true });
  return { ...r, logs };
}

test("boot-guard process: override + missing user-config exits non-zero before booting", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-guard-cfg-"));
  const r = runGuard({ MERIDIAN_CONFIG_DIR: empty }, { live: true });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /BOOTED/);
  assert.match(r.stderr, /Refusing to start/);
  assert.match(r.logs, /Config paths:/);
  assert.match(r.logs, /Path override\(s\) active: MERIDIAN_CONFIG_DIR/);
  fs.rmSync(empty, { recursive: true, force: true });
});

test("boot-guard process: override + user-config present boots, logging paths and a warning", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-guard-cfg-"));
  fs.writeFileSync(path.join(dir, "user-config.json"), "{}");
  const r = runGuard({ MERIDIAN_CONFIG_DIR: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BOOTED/);
  assert.match(r.logs, new RegExp(`user-config=${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(r.logs, /startup_warn|Path override/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("boot-guard process: no overrides boots without a warning", () => {
  const r = runGuard({});
  assert.equal(r.status, 0, r.stderr);
  // the harness itself pins MERIDIAN_LOG_DIR (now a reported override); nothing else may be listed
  assert.doesNotMatch(r.logs, /Path override\(s\) active: .*(CONFIG|DATA)/);
  assert.match(r.logs, /Path override\(s\) active: MERIDIAN_LOG_DIR\n/);
});

function runLive(env) {
  const log = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-guard-log-"));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("MERIDIAN_") && k !== "DRY_RUN"));
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", 'await import("./boot-guard.js"); console.log("BOOTED");'], {
    cwd: ROOT, encoding: "utf8", env: { ...clean, MERIDIAN_LOG_DIR: log, ...env },
  });
  fs.rmSync(log, { recursive: true, force: true });
  return r;
}

test("boot-guard process: live (no DRY_RUN) with missing user-config refuses; DRY_RUN boots", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-guard-cfg-"));
  const r = runLive({ MERIDIAN_CONFIG_DIR: empty });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /BOOTED/);
  assert.match(r.stderr, /npm run setup/);
  const d = runLive({ MERIDIAN_CONFIG_DIR: empty, DRY_RUN: "true" });
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /BOOTED/);
  fs.rmSync(empty, { recursive: true, force: true });
});

test("boot-guard process: empty MERIDIAN_DATA_DIR refuses live, boots with state.json or DRY_RUN", () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-guard-cfg-"));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-guard-data-"));
  fs.writeFileSync(path.join(cfg, "user-config.json"), "{}");
  const env = { MERIDIAN_CONFIG_DIR: cfg, MERIDIAN_DATA_DIR: data };
  const r = runLive(env);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /empty data dir/);
  assert.equal(runLive({ ...env, DRY_RUN: "true" }).status, 0);
  fs.writeFileSync(path.join(data, "state.json"), "{}");
  assert.equal(runLive(env).status, 0);
  fs.rmSync(cfg, { recursive: true, force: true }); fs.rmSync(data, { recursive: true, force: true });
});
