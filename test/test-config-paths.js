// config-paths: env overrides redirect config reads; with none set, production paths are the repo root.
import "./_bootstrap.js";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDir, userConfigPath, gmgnConfigPath, configStatePath } from "../config-paths.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("no env: every path resolves to the repo root (production behaviour unchanged)", () => {
  assert.equal(configDir({}), ROOT);
  assert.equal(userConfigPath({}), path.join(ROOT, "user-config.json"));
  assert.equal(gmgnConfigPath({}), path.join(ROOT, "gmgn-config.json"));
  assert.equal(configStatePath({}), path.join(ROOT, "config-state.json"));
});

test("MERIDIAN_CONFIG_DIR redirects all three files", () => {
  const env = { MERIDIAN_CONFIG_DIR: "/x/y" };
  assert.equal(userConfigPath(env), "/x/y/user-config.json");
  assert.equal(gmgnConfigPath(env), "/x/y/gmgn-config.json");
  assert.equal(configStatePath(env), "/x/y/config-state.json");
});

test("specific vars beat the dir; state follows user-config's dir (legacy)", () => {
  const env = { MERIDIAN_CONFIG_DIR: "/x", MERIDIAN_USER_CONFIG_PATH: "/u/user.json", MERIDIAN_GMGN_CONFIG_PATH: "/g/g.json" };
  assert.equal(userConfigPath(env), "/u/user.json");
  assert.equal(gmgnConfigPath(env), "/g/g.json");
  assert.equal(configStatePath(env), "/u/config-state.json");
  assert.equal(configStatePath({ ...env, MERIDIAN_CONFIG_STATE_PATH: "/s.json" }), "/s.json");
});

test("test:runtime pins MERIDIAN_CONFIG_DIR to a temp dir", { skip: process.env.npm_lifecycle_event !== "test:runtime" }, () => {
  assert.ok(process.env.MERIDIAN_CONFIG_DIR && path.resolve(process.env.MERIDIAN_CONFIG_DIR) !== ROOT, "suite must not read the real checkout config");
});
