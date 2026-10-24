// config-state.js — machine bookkeeping that used to live inside user-config.json
// (_lastEvolved, _positionsAtEvolution, _lastAgentTune). user-config.json is now
// hand/Telegram-edited only; the bot writes its own counters here.
//
// Path: MERIDIAN_CONFIG_STATE_PATH, else config-state.json beside user-config.json.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { configStatePath } from "./config-paths.js";
import { writeJsonAtomicSync } from "./atomic-write.js";

export function statePath() {
  return configStatePath();
}

export function readConfigState() {
  try { return JSON.parse(fs.readFileSync(statePath(), "utf8")); } catch { return {}; }
}

export function updateConfigState(patch) {
  const next = { ...readConfigState(), ...patch };
  writeJsonAtomicSync(statePath(), next);
  return next;
}

const LEGACY = { _lastEvolved: "lastEvolved", _positionsAtEvolution: "positionsAtEvolution", _lastAgentTune: "lastAgentTune" };

/**
 * One-time move of the legacy `_last*` keys out of user-config.json. Safe to run
 * on every boot: it does nothing when none are present. Never throws.
 */
export function migrateLegacyBookkeeping(userConfigPath) {
  try {
    if (!fs.existsSync(userConfigPath)) return false;
    const raw = JSON.parse(fs.readFileSync(userConfigPath, "utf8"));
    const found = Object.keys(LEGACY).filter((k) => k in raw);
    if (!found.length) return false;
    const existing = readConfigState();
    const patch = {};
    for (const k of found) if (existing[LEGACY[k]] === undefined) patch[LEGACY[k]] = raw[k];
    if (Object.keys(patch).length) updateConfigState(patch);
    // One-time safety copy of the pre-migration file (sizing + dryRun live here). Never overwrite an existing backup.
    const bak = userConfigPath + ".pre-profiles.bak";
    if (!fs.existsSync(bak)) {
      fs.copyFileSync(userConfigPath, bak, fs.constants.COPYFILE_EXCL);
      try { fs.chmodSync(bak, fs.statSync(userConfigPath).mode & 0o777); } catch { /* best effort */ }
    }
    for (const k of found) delete raw[k];
    writeJsonAtomicSync(userConfigPath, raw);
    return true;
  } catch { return false; }
}
