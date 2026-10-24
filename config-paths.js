// config-paths.js — single source of truth for where user-editable config lives.
//
// Precedence (per file): specific env var > MERIDIAN_CONFIG_DIR > repo root.
// With nothing set this resolves to the repo root, exactly as before. The
// overrides exist so tests (and sandboxes) never read a real checkout's
// user-config.json / gmgn-config.json / config-state.json.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export function configDir(env = process.env) {
  return env.MERIDIAN_CONFIG_DIR || ROOT;
}
export function userConfigPath(env = process.env) {
  return env.MERIDIAN_USER_CONFIG_PATH || path.join(configDir(env), "user-config.json");
}
export function gmgnConfigPath(env = process.env) {
  return env.MERIDIAN_GMGN_CONFIG_PATH || path.join(configDir(env), "gmgn-config.json");
}
export function configStatePath(env = process.env) {
  if (env.MERIDIAN_CONFIG_STATE_PATH) return env.MERIDIAN_CONFIG_STATE_PATH;
  // Historical: beside user-config.json when only that var is set.
  const dir = env.MERIDIAN_USER_CONFIG_PATH ? path.dirname(env.MERIDIAN_USER_CONFIG_PATH) : configDir(env);
  return path.join(dir, "config-state.json");
}

// ── Data paths (runtime state, logs, knowledge base) ───────────────────────
// MERIDIAN_DATA_DIR redirects EVERY file the bot or the test suite writes
// (state, lessons, pool memory, signal weights, logs, knowledge/, deploy
// attempts, strategy library, blacklist, smart wallets, autoresearch...).
// Unset -> the historical locations (cwd-relative for ./state.json style files,
// repo-root-relative for the files that used __dirname), so production is unchanged.
export function dataDirOverride(env = process.env) {
  return env.MERIDIAN_DATA_DIR || null;
}
/** Historical cwd-relative file ("./state.json"), or inside MERIDIAN_DATA_DIR. */
export function dataPath(name, env = process.env) {
  const d = dataDirOverride(env);
  return d ? path.join(d, name) : "./" + name;
}
/** Historical repo-root file (smart-wallets.json, knowledge/...), or inside MERIDIAN_DATA_DIR. */
export function rootDataPath(name, env = process.env) {
  const d = dataDirOverride(env);
  return path.join(d || ROOT, name);
}
export function logDir(env = process.env) {
  return env.MERIDIAN_LOG_DIR || dataPath("logs", env);
}
export function repoRoot() { return ROOT; }

// ── Boot guard (F1) ────────────────────────────────────────────────────────
const OVERRIDE_RE = /^MERIDIAN_.*(CONFIG|DATA)/;
export function activeOverrides(env = process.env) {
  return Object.keys(env).filter((k) => OVERRIDE_RE.test(k) && env[k]).sort();
}
export function resolvedPaths(env = process.env) {
  return {
    userConfig: userConfigPath(env),
    gmgnConfig: gmgnConfigPath(env),
    configState: configStatePath(env),
    dataDir: dataDirOverride(env) || "(default: cwd / repo root)",
    logDir: logDir(env),
  };
}
/**
 * Pure decision: { paths, overrides, ok, error }. An override that points at a
 * directory with no user-config.json would boot on schema defaults (dryRun
 * default is false = LIVE), so that case refuses to start.
 */
export function evaluateBootConfig(env = process.env, exists = (p) => fs.existsSync(p)) {
  const overrides = activeOverrides(env);
  const paths = resolvedPaths(env);
  if (overrides.length && !exists(paths.userConfig)) {
    return {
      paths, overrides, ok: false,
      error: `Refusing to start: ${overrides.join(", ")} is set but ${paths.userConfig} does not exist. Booting would use built-in defaults (live trading). Unset the override, or create that user-config.json.`,
    };
  }
  return { paths, overrides, ok: true, error: null };
}
