// boot-guard.js — import right after dotenv in index.js. Logs resolved config/data
// paths, warns on MERIDIAN_*CONFIG*/*DATA* overrides, and exits non-zero when an
// override is set but user-config.json is missing (would run live on defaults).
import { evaluateBootConfig } from "./config-paths.js";
import { log } from "./logger.js";

export function runBootGuard(env = process.env, { exit = (c) => process.exit(c), err = (m) => console.error(m) } = {}) {
  const r = evaluateBootConfig(env);
  log("startup", `Config paths: user-config=${r.paths.userConfig} gmgn-config=${r.paths.gmgnConfig} config-state=${r.paths.configState} data=${r.paths.dataDir} logs=${r.paths.logDir}`);
  if (r.overrides.length) log("startup_warn", `Path override(s) active: ${r.overrides.join(", ")}`);
  if (!r.ok) {
    log("startup_error", r.error);
    err(r.error);
    exit(1);
  }
  return r;
}

runBootGuard();
