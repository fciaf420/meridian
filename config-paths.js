// config-paths.js — single source of truth for where user-editable config lives.
//
// Precedence (per file): specific env var > MERIDIAN_CONFIG_DIR > repo root.
// With nothing set this resolves to the repo root, exactly as before. The
// overrides exist so tests (and sandboxes) never read a real checkout's
// user-config.json / gmgn-config.json / config-state.json.
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
