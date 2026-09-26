#!/usr/bin/env node
/**
 * One-off: stamp the known-bad close records as excluded from learning, and
 * recompute the stored pool-memory aggregates with the shared win/loss
 * classifier (learning-data.js).
 *
 * The code already ignores these records without this script: the learning
 * systems match KNOWN_BAD_RECORDS, `corrupt`, `exclude_from_learning` and
 * `corrected` at read time, and pool memory recomputes its aggregates when
 * read for the prompt. This script only makes the stored JSON say the same,
 * for the readers that take it as is (knowledge graph, dashboard, KB).
 *
 *   lessons.json      performance records in KNOWN_BAD_RECORDS get
 *                     exclude_from_learning: "<reason>"; so does the lesson
 *                     derived from each (same pool, created_at = recorded_at)
 *   pool-memory.json  the known-bad deploys get the same flag, and every pool's
 *                     avg_pnl_pct / win_rate / last_outcome is recomputed:
 *                     win > +1%, loss < −1%, break-even ignored in win_rate
 *                     (null when a pool has no decisive close), excluded and
 *                     corrected deploys not counted
 *
 * Nothing is deleted. Idempotent: a second --apply changes nothing.
 *
 * The bot rewrites these files while it runs, so run this with the bot STOPPED:
 *   node scripts/fix-learning-data-2026-09-26.js            # preview: prints every change, writes nothing
 *   node scripts/fix-learning-data-2026-09-26.js --apply    # writes (a .bak-fix-learning-data copy of each file first)
 * Options: --root <dir> (default: repo root).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { KNOWN_BAD_RECORDS, knownBadMatch, poolAggregates } from "../learning-data.js";

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Every change, computed from the files; writes nothing. */
export function planLearningFix(root) {
  const changes = [];
  const writes = new Map();
  const note = (file, label, before, after) => changes.push({ file: path.relative(root, file) || file, label, before, after });

  // lessons.json
  const lessonsFile = path.join(root, "lessons.json");
  const lessons = readJson(lessonsFile);
  if (lessons) {
    let dirty = false;
    for (const perf of lessons.performance || []) {
      const bad = KNOWN_BAD_RECORDS.find((b) => b.position && perf.position === b.position);
      if (!bad || perf.exclude_from_learning) continue;
      perf.exclude_from_learning = bad.reason;
      note(lessonsFile, `performance ${bad.key} (${perf.pool_name ?? "?"} ${perf.pnl_pct}%)`, null, { exclude_from_learning: bad.reason });
      dirty = true;
    }
    for (const l of lessons.lessons || []) {
      if (l.exclude_from_learning || l.pool == null || l.created_at == null) continue;
      const bad = knownBadMatch({ pool: l.pool, created_at: l.created_at });
      if (!bad) continue;
      l.exclude_from_learning = bad.reason;
      note(lessonsFile, `lesson from ${bad.key}`, String(l.rule || "").slice(0, 140), { exclude_from_learning: bad.reason });
      dirty = true;
    }
    if (dirty) writes.set(lessonsFile, JSON.stringify(lessons, null, 2));
  }

  // pool-memory.json
  const pmFile = path.join(root, "pool-memory.json");
  const pm = readJson(pmFile);
  if (pm) {
    let dirty = false;
    for (const [pool, entry] of Object.entries(pm)) {
      if (!entry || !Array.isArray(entry.deploys)) continue;
      for (const d of entry.deploys) {
        if (d.exclude_from_learning) continue;
        const bad = knownBadMatch(d, pool);
        if (!bad) continue;
        d.exclude_from_learning = bad.reason;
        note(pmFile, `${entry.name ?? pool.slice(0, 8)} deploy ${bad.key} (${d.pnl_pct}%)`, null, { exclude_from_learning: bad.reason });
        dirty = true;
      }
      if (!entry.deploys.length) continue;
      const agg = poolAggregates(entry.deploys, pool);
      const before = { avg_pnl_pct: entry.avg_pnl_pct, win_rate: entry.win_rate, last_outcome: entry.last_outcome };
      const after = { avg_pnl_pct: agg.avg_pnl_pct, win_rate: agg.win_rate, last_outcome: agg.last_outcome ?? "unknown" };
      if (same(before, after)) continue;
      Object.assign(entry, after);
      note(pmFile, `${entry.name ?? pool.slice(0, 8)} aggregates`, before, after);
      dirty = true;
    }
    if (dirty) writes.set(pmFile, JSON.stringify(pm, null, 2));
  }

  return { changes, writes };
}

export function applyLearningFix(root, { apply = false, log = console.log } = {}) {
  const { changes, writes } = planLearningFix(root);
  if (!changes.length) {
    log("Nothing to change: already applied (or the files are not in this directory).");
    return { changes, written: [] };
  }
  for (const ch of changes) {
    log(`\n[${ch.file}] ${ch.label}`);
    if (ch.before != null) log(`  - before: ${typeof ch.before === "string" ? ch.before : JSON.stringify(ch.before)}`);
    log(`  + after:  ${typeof ch.after === "string" ? ch.after : JSON.stringify(ch.after)}`);
  }
  const written = [];
  if (apply) {
    for (const [file, content] of writes) {
      const bak = `${file}.bak-fix-learning-data`;
      if (!fs.existsSync(bak)) fs.copyFileSync(file, bak); // keep the first (pre-fix) copy
      fs.writeFileSync(file, content);
      written.push(file);
    }
    log(`\nWrote ${written.length} file(s) (backups: *.bak-fix-learning-data).`);
  } else {
    log(`\nPreview only: ${writes.size} file(s) would change. Stop the bot, then re-run with --apply.`);
  }
  return { changes, written };
}

function main() {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf("--root");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = rootIdx >= 0 ? path.resolve(args[rootIdx + 1]) : path.resolve(here, "..");
  applyLearningFix(root, { apply: args.includes("--apply") });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (e) { console.error(e); process.exit(1); }
}
