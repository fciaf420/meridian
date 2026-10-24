// config-state.js — machine bookkeeping that used to live inside user-config.json
// (_lastEvolved, _positionsAtEvolution, _lastAgentTune). user-config.json is now
// hand/Telegram-edited only; the bot writes its own counters here.
//
// Path: MERIDIAN_CONFIG_STATE_PATH, else config-state.json beside user-config.json.
import fs from "fs";
import path from "path";
import { writeJsonAtomicSync } from "./atomic-write.js";

export function statePath() {
  if (process.env.MERIDIAN_CONFIG_STATE_PATH) return process.env.MERIDIAN_CONFIG_STATE_PATH;
  const userPath = process.env.MERIDIAN_USER_CONFIG_PATH;
  const dir = userPath ? path.dirname(userPath) : path.dirname(new URL(import.meta.url).pathname);
  return path.join(dir, "config-state.json");
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
    for (const k of found) delete raw[k];
    writeJsonAtomicSync(userConfigPath, raw);
    return true;
  } catch { return false; }
}
