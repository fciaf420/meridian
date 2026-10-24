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
// Every MERIDIAN_* variable that redirects a path (CONFIG/DATA/DIR/PATH/FILE).
// MERIDIAN_SKIP_INSTANCE_LOCK, MERIDIAN_OHLCV_OFFLINE etc. are flags, not paths.
const OVERRIDE_RE = /^MERIDIAN_.*(CONFIG|DATA|DIR|PATH|FILE)/;
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
const dryRunEnv = (env) => /^(true|1|yes|on)$/i.test(String(env.DRY_RUN ?? "").trim());
/**
 * Pure decision: { paths, overrides, ok, error }. Refuses (unless DRY_RUN is truthy
 * in env, which cannot trade) when:
 *  - user-config.json is missing (override OR default root): schema defaults are LIVE;
 *  - MERIDIAN_DATA_DIR points at a dir with neither state.json nor deploy-attempts.json
 *    (empty data dir: no position state, no deploy checkpoint to reconcile).
 */
export function evaluateBootConfig(env = process.env, exists = (p) => fs.existsSync(p)) {
  const overrides = activeOverrides(env);
  const paths = resolvedPaths(env);
  const dry = dryRunEnv(env);
  const fail = (error) => ({ paths, overrides, ok: false, error });
  if (!dry && !exists(paths.userConfig)) {
    const via = overrides.length ? `${overrides.join(", ")} is set but ` : "";
    return fail(`Refusing to start: ${via}${paths.userConfig} does not exist. Booting would use built-in defaults (live trading). Run \`npm run setup\` or create user-config.json${overrides.length ? ", or unset the override" : ""}. (DRY_RUN=true skips this check.)`);
  }
  const dataDir = dataDirOverride(env);
  if (!dry && dataDir) {
    const state = path.join(dataDir, "state.json");
    const attempts = env.MERIDIAN_DEPLOY_ATTEMPTS_FILE || path.join(dataDir, "deploy-attempts.json");
    if (!exists(state) && !exists(attempts)) {
      return fail(`Refusing to start: MERIDIAN_DATA_DIR=${dataDir} has no state.json and no deploy-attempts.json (empty data dir). Booting would lose position state and the deploy checkpoint. Point it at the real data dir, or copy state.json / deploy-attempts.json there. (DRY_RUN=true skips this check.)`);
    }
  }
  return { paths, overrides, ok: true, error: null };
}
