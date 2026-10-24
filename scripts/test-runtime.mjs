/* global process, console */
// scripts/test-runtime.mjs — runs the runtime suite with every data/config/log
// path pinned to fresh temp dirs, then FAILS if anything in the checkout root
// changed (create / modify / delete) while it ran. Usage: node scripts/test-runtime.mjs <test files...>
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", ".git"]);

export function snapshotTree(root) {
  const out = new Map();
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name) || (dir !== root && e.name === "node_modules")) continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p);
      if (e.isDirectory()) { out.set(rel + "/", "dir"); walk(p); }
      else if (e.isFile()) out.set(rel, crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"));
      else out.set(rel, "other");
    }
  })(root);
  return out;
}
export function diffSnapshots(a, b) {
  const d = [];
  for (const [k, v] of b) { if (!a.has(k)) d.push(`created  ${k}`); else if (a.get(k) !== v) d.push(`modified ${k}`); }
  for (const k of a.keys()) if (!b.has(k)) d.push(`deleted  ${k}`);
  return d;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  const mk = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `meridian-runtime-${n}-`));
  const env = { ...process.env, MERIDIAN_CONFIG_DIR: mk("config"), MERIDIAN_DATA_DIR: mk("data"), MERIDIAN_LOG_DIR: mk("logs"), MERIDIAN_RUNTIME_GUARD: "1" };
  const before = snapshotTree(ROOT);
  const r = spawnSync(process.execPath, ["--test", ...files], { cwd: ROOT, env, stdio: "inherit" });
  const diff = diffSnapshots(before, snapshotTree(ROOT));
  if (diff.length) {
    console.error("\nCHECKOUT-WRITE GUARD FAILED: the suite changed files in the repo root:\n  " + diff.join("\n  "));
    process.exit(1);
  }
  console.log("\nCheckout-write guard: repo root unchanged.");
  process.exit(r.status ?? 1);
}
