/**
 * Token blacklist — mints the agent should never deploy into.
 */

import fs from "fs";
import { log } from "./logger.js";

const BLACKLIST_FILE = "./token-blacklist.json";

function load() {
  if (!fs.existsSync(BLACKLIST_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(data, null, 2));
}

export function isBlacklisted(mint) {
  if (!mint) return false;
  const db = load();
  return !!db[mint];
}

export function addToBlacklist({ mint, symbol, reason }) {
  if (!mint) return { error: "mint required" };
  const db = load();
  if (db[mint]) {
    return { already_blacklisted: true, mint, symbol: db[mint].symbol, reason: db[mint].reason };
  }
  db[mint] = {
    symbol: symbol || "UNKNOWN",
    reason: reason || "no reason provided",
    added_at: new Date().toISOString(),
    added_by: "agent",
  };
  save(db);
  log("blacklist", `Blacklisted ${symbol || mint}: ${reason}`);
  return { blacklisted: true, mint, symbol, reason };
}

export function removeFromBlacklist({ mint }) {
  if (!mint) return { error: "mint required" };
  const db = load();
  if (!db[mint]) return { error: `Mint ${mint} not found on blacklist` };
  const entry = db[mint];
  delete db[mint];
  save(db);
  log("blacklist", `Removed ${entry.symbol || mint} from blacklist`);
  return { removed: true, mint, was: entry };
}

export function listBlacklist() {
  const db = load();
  const entries = Object.entries(db).map(([mint, info]) => ({ mint, ...info }));
  return { count: entries.length, blacklist: entries };
}
