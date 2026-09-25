/**
 * Strategy Library — persistent store of LP strategies.
 */

import fs from "fs";
import { log } from "./logger.js";

const STRATEGY_FILE = "./strategy-library.json";

function load() {
  if (!fs.existsSync(STRATEGY_FILE)) return { active: null, strategies: {} };
  try {
    return JSON.parse(fs.readFileSync(STRATEGY_FILE, "utf8"));
  } catch {
    return { active: null, strategies: {} };
  }
}

function save(data) {
  fs.writeFileSync(STRATEGY_FILE, JSON.stringify(data, null, 2));
}

export function addStrategy({ id, name, author = "unknown", lp_strategy = "bid_ask", token_criteria = {}, entry = {}, range = {}, exit = {}, best_for = "", raw = "" }) {
  if (!id || !name) return { error: "id and name are required" };
  const db = load();
  const slug = id.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  db.strategies[slug] = { id: slug, name, author, lp_strategy, token_criteria, entry, range, exit, best_for, raw, added_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (!db.active) db.active = slug;
  save(db);
  log("strategy", `Strategy saved: ${name} (${slug})`);
  return { saved: true, id: slug, name, active: db.active === slug };
}

export function listStrategies() {
  const db = load();
  const strategies = Object.values(db.strategies).map((s) => ({ id: s.id, name: s.name, author: s.author, lp_strategy: s.lp_strategy, best_for: s.best_for, active: db.active === s.id, added_at: s.added_at?.slice(0, 10) }));
  return { active: db.active, count: strategies.length, strategies };
}

export function getStrategy({ id }) {
  if (!id) return { error: "id required" };
  const db = load();
  const strategy = db.strategies[id];
  if (!strategy) return { error: `Strategy "${id}" not found`, available: Object.keys(db.strategies) };
  return { ...strategy, is_active: db.active === id };
}

export function setActiveStrategy({ id }) {
  if (!id) return { error: "id required" };
  const db = load();
  if (!db.strategies[id]) return { error: `Strategy "${id}" not found`, available: Object.keys(db.strategies) };
  db.active = id;
  save(db);
  log("strategy", `Active strategy set to: ${db.strategies[id].name}`);
  return { active: id, name: db.strategies[id].name };
}

export function removeStrategy({ id }) {
  if (!id) return { error: "id required" };
  const db = load();
  if (!db.strategies[id]) return { error: `Strategy "${id}" not found` };
  const name = db.strategies[id].name;
  delete db.strategies[id];
  if (db.active === id) db.active = Object.keys(db.strategies)[0] || null;
  save(db);
  log("strategy", `Strategy removed: ${name}`);
  return { removed: true, id, name, new_active: db.active };
}

export function getActiveStrategy() {
  const db = load();
  if (!db.active || !db.strategies[db.active]) return null;
  return db.strategies[db.active];
}
