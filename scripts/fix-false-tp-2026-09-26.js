#!/usr/bin/env node
/**
 * One-off history correction: the e/acc-SOL false take profit of 2026-09-26.
 *
 * Position GDYiuQ9ZHMBr9j7SP716c9WYa9dxmPQL36p1ZkSKc9o8 (pool 3vDyCqa4…) was
 * closed at 00:07:09 UTC by the PnL watcher on "FIXED_TP: PnL 7.4%" from the
 * PnL API's warm-up reading. On-chain it was flat: 6.16 SOL in, 6.16 SOL plus
 * ~$0.11 of fees out. That close was recorded as +7.39% / +$55.55, and a
 * "WORKED: e/acc-SOL" lesson was derived from it.
 *
 * This rewrites the record everywhere a close lands:
 *   lessons.json     performance entry (pnl_pct, pnl_usd, …) + removes the WORKED lesson
 *   pool-memory.json the pool's deploy entry + recomputed avg_pnl_pct / win_rate / last_outcome
 *   state.json       the position's notes and its recentAutoCloses entry
 *   knowledge/**.md  the pool article, the concept articles and LOG.md lines for that close
 *
 * Idempotent: records already carrying `corrected` / "[corrected:" are left alone.
 *
 * The bot rewrites these files while it runs, so run this with the bot STOPPED:
 *   node scripts/fix-false-tp-2026-09-26.js            # preview: prints the before/after diff, writes nothing
 *   node scripts/fix-false-tp-2026-09-26.js --apply    # writes (a .bak-fix-false-tp copy of each file first)
 *   node scripts/fix-false-tp-2026-09-26.js --verify-txs   # also re-reads the txs (read-only RPC) and checks the numbers
 * Options: --root <dir> (default: repo root).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

export const POSITION = "GDYiuQ9ZHMBr9j7SP716c9WYa9dxmPQL36p1ZkSKc9o8";
export const POOL = "3vDyCqa4q3G3u9iQCXYPfLeDQpknj9L5AXy3jd2NjgsK";
export const DEPLOYED_AT = "2026-09-26T00:03:02.006Z";
export const CORRECTED = "false TP 7.4% (PnL API warm-up); on-chain ≈0%";
const LESSON_CREATED_AT = "2026-09-26T00:07:10.332Z";
const KB_STAMP = "2026-09-26T00:07";

// ─── On-chain numbers (pool reserve deltas, read from the txs) ───
// SOL reserve = token account 5ho1aD… owned by the pool; e/acc reserve CENEBR….
// Rent (0.0766064 SOL into the position account, refunded at close) and tx
// fees are not LP PnL and are left out.
export const TXS = {
  create: { sig: "36w8tV7RLpJdWHY6xhJ5V3zgNDUTmaEBGdy2fJGaUmVTRy5FGuMxL1QjD8kiF4TicdByDx6K6ZgvzxMyxiegn5cq", solToPool: 0, tokenToPool: 0 },
  add1: { sig: "hATYPivgK1dQcWWVv4AoFn5T3No9wSwRQLCeV1r8zzNYcMwGGwq2eTpgUwo45HXeFqXrt4cwUydzLwA6CRjk3mi", solToPool: 4.81272134, tokenToPool: 0 },
  add2: { sig: "3ZPmBqkZ6PNmGNiNgFZeNnUHRAT1CAfVaWGEFnEEvC8bQxgY76TK32cZUZGBC8SunPUxYozmeTywo1FRMaHF14x8", solToPool: 1.347276988, tokenToPool: 0 },
  close1: { sig: "2V6oKvs9fiVUNwo2XQY39StjBKUruraK6vBG6Ywk18qwgfQN8qQuRf8nTNGHZed96qSrKdRHJCqKfphPsA8Rx91p", solToPool: -4.81272134, tokenToPool: 0 },
  close2: { sig: "3PNjTVwSPmZt6eFezuMQoEzpEd24Jg134kpq3KVizEE8k3eQXQtdcspjosqeJHSimV3V12DNmE9MMBR7LxMnma5L", solToPool: -1.347630818, tokenToPool: -49.805765 },
};
const SOL_RESERVE_OWNER = POOL;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_MINT = "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU";
// The 49.805765 e/acc fee was valued at ~$0.0698 by the close's dust gate
// (logs 00:07:21). Entry SOL price = initial_value_usd / amount_sol.
const TOKEN_FEE_USD = 0.0698;
const INITIAL_VALUE_USD = 754.97;

export function computeCorrection(txs = TXS) {
  const all = Object.values(txs);
  const depositSol = all.filter((t) => t.solToPool > 0).reduce((s, t) => s + t.solToPool, 0);
  const withdrawnSol = -all.filter((t) => t.solToPool < 0).reduce((s, t) => s + t.solToPool, 0);
  const tokenFees = -all.reduce((s, t) => s + t.tokenToPool, 0);
  const solUsd = INITIAL_VALUE_USD / 6.16;
  const tokenFeeSol = tokenFees > 0 ? TOKEN_FEE_USD / solUsd : 0;
  const pnlSol = withdrawnSol - depositSol + tokenFeeSol;
  const pnlPct = Math.round((pnlSol / depositSol) * 100 * 100) / 100;
  const pnlUsd = Math.round(pnlSol * solUsd * 100) / 100;
  return {
    depositSol: Math.round(depositSol * 1e9) / 1e9,
    withdrawnSol: Math.round(withdrawnSol * 1e9) / 1e9,
    tokenFees,
    pnlSol: Math.round(pnlSol * 1e9) / 1e9,
    pnlPct,
    pnlUsd,
    finalValueUsd: Math.round((INITIAL_VALUE_USD + pnlUsd) * 100) / 100,
  };
}

// ─── File helpers ───
function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function listMd(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listMd(full));
    else if (e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/**
 * Compute every change. Returns { changes: [{ file, label, before, after }], writes: Map(file → content) }.
 * Pure with respect to the filesystem (reads only).
 */
export function planCorrections(root, fix = computeCorrection()) {
  const changes = [];
  const writes = new Map();
  const note = (file, label, before, after) => changes.push({ file: path.relative(root, file) || file, label, before, after });

  // lessons.json
  const lessonsFile = path.join(root, "lessons.json");
  const lessons = readJson(lessonsFile);
  if (lessons) {
    let dirty = false;
    for (const perf of lessons.performance || []) {
      if (perf.position !== POSITION || perf.corrected) continue;
      const before = { pnl_pct: perf.pnl_pct, pnl_usd: perf.pnl_usd, actual_pnl_pct: perf.actual_pnl_pct, actual_pnl_usd: perf.actual_pnl_usd, final_value_usd: perf.final_value_usd, fees_earned_usd: perf.fees_earned_usd };
      perf.original = before;
      perf.pnl_pct = fix.pnlPct;
      perf.actual_pnl_pct = fix.pnlPct;
      perf.pnl_usd = fix.pnlUsd;
      perf.actual_pnl_usd = fix.pnlUsd;
      perf.fees_earned_usd = fix.pnlUsd;
      perf.final_value_usd = fix.finalValueUsd;
      perf.pnl_source = "onchain";
      perf.corrected = CORRECTED;
      note(lessonsFile, "performance record", before, { pnl_pct: perf.pnl_pct, pnl_usd: perf.pnl_usd, final_value_usd: perf.final_value_usd, corrected: perf.corrected });
      dirty = true;
    }
    const idx = (lessons.lessons || []).findIndex((l) =>
      l.created_at === LESSON_CREATED_AT && String(l.rule || "").startsWith("WORKED: e/acc-SOL"));
    if (idx >= 0) {
      const [removed] = lessons.lessons.splice(idx, 1);
      note(lessonsFile, "lesson removed (not a win)", removed.rule, null);
      dirty = true;
    }
    if (dirty) writes.set(lessonsFile, JSON.stringify(lessons, null, 2));
  }

  // pool-memory.json
  const pmFile = path.join(root, "pool-memory.json");
  const pm = readJson(pmFile);
  const entry = pm?.[POOL];
  if (entry) {
    const dep = (entry.deploys || []).find((d) => d.deployed_at === DEPLOYED_AT);
    if (dep && !dep.corrected) {
      const before = { pnl_pct: dep.pnl_pct, pnl_usd: dep.pnl_usd, avg_pnl_pct: entry.avg_pnl_pct, win_rate: entry.win_rate, last_outcome: entry.last_outcome };
      dep.original = { pnl_pct: dep.pnl_pct, pnl_usd: dep.pnl_usd };
      dep.pnl_pct = fix.pnlPct;
      dep.pnl_usd = fix.pnlUsd;
      dep.corrected = CORRECTED;
      // Same aggregation as pool-memory.js recordPoolDeploy.
      const withPnl = entry.deploys.filter((d) => d.pnl_pct != null);
      if (withPnl.length) {
        entry.avg_pnl_pct = Math.round((withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100) / 100;
        entry.win_rate = Math.round((withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length) * 100) / 100;
      }
      const last = entry.deploys[entry.deploys.length - 1];
      entry.last_outcome = last.pnl_pct == null ? "unknown" : last.pnl_pct >= 0 ? "profit" : "loss";
      note(pmFile, "pool deploy", before, { pnl_pct: dep.pnl_pct, pnl_usd: dep.pnl_usd, avg_pnl_pct: entry.avg_pnl_pct, win_rate: entry.win_rate, last_outcome: entry.last_outcome });
      writes.set(pmFile, JSON.stringify(pm, null, 2));
    }
  }

  // state.json
  const stateFile = path.join(root, "state.json");
  const state = readJson(stateFile);
  if (state) {
    let dirty = false;
    const pos = state.positions?.[POSITION];
    const stateNote = `Corrected: ${CORRECTED} — closed at ${fix.pnlPct}% ($${fix.pnlUsd}) on-chain, not 7.39% ($55.55)`;
    if (pos && !(pos.notes || []).some((n) => String(n).startsWith("Corrected:"))) {
      pos.notes = [...(pos.notes || []), stateNote];
      pos.corrected = CORRECTED;
      note(stateFile, "position notes", null, stateNote);
      dirty = true;
    }
    for (const ac of state.recentAutoCloses || []) {
      if (ac.position !== POSITION || ac.corrected) continue;
      const before = { pnl_pct: ac.pnl_pct };
      ac.api_pnl_pct = ac.pnl_pct;
      ac.pnl_pct = fix.pnlPct;
      ac.corrected = CORRECTED;
      note(stateFile, "recentAutoCloses", before, { pnl_pct: ac.pnl_pct, corrected: ac.corrected });
      dirty = true;
    }
    if (dirty) writes.set(stateFile, JSON.stringify(state, null, 2));
  }

  // knowledge/**.md — the lines filed for this close (pool article, concept articles, LOG.md)
  const pct = `${fix.pnlPct.toFixed(1)}%`;
  for (const file of listMd(path.join(root, "knowledge"))) {
    const text = fs.readFileSync(file, "utf8");
    // The pool article's history lines don't repeat the pool name.
    const isPoolArticle = path.basename(file) === "e-acc-sol.md";
    let dirty = false;
    const lines = text.split("\n").map((line) => {
      if (!line.includes(KB_STAMP) || !line.includes("7.4%") || line.includes("[corrected:")) return line;
      if (!isPoolArticle && !line.includes("e/acc-SOL")) return line;
      const outcomeFixed = fix.pnlPct < 0 ? line.replace(/\bWIN\b/, "LOSS") : line;
      const fixed = `${outcomeFixed.replace("7.4%", pct)} [corrected: ${CORRECTED}]`;
      note(file, "kb line", line, fixed);
      dirty = true;
      return fixed;
    });
    if (dirty) writes.set(file, lines.join("\n"));
  }

  return { changes, writes };
}

export function applyCorrections(root, { apply = false, log = console.log } = {}) {
  const fix = computeCorrection();
  const { changes, writes } = planCorrections(root, fix);
  log(`On-chain: deposited ${fix.depositSol} SOL, withdrew ${fix.withdrawnSol} SOL + ${fix.tokenFees} e/acc fees → PnL ${fix.pnlSol} SOL = ${fix.pnlPct}% ($${fix.pnlUsd})`);
  if (!changes.length) {
    log("Nothing to change: already corrected (or the records are not in this directory).");
    return { changes, written: [] };
  }
  for (const c of changes) {
    log(`\n[${c.file}] ${c.label}`);
    log(`  - before: ${typeof c.before === "string" ? c.before : JSON.stringify(c.before)}`);
    log(`  + after:  ${typeof c.after === "string" ? c.after : JSON.stringify(c.after)}`);
  }
  const written = [];
  if (apply) {
    for (const [file, content] of writes) {
      fs.copyFileSync(file, `${file}.bak-fix-false-tp`);
      fs.writeFileSync(file, content);
      written.push(file);
    }
    log(`\nWrote ${written.length} file(s) (backups: *.bak-fix-false-tp).`);
  } else {
    log(`\nPreview only: ${writes.size} file(s) would change. Stop the bot, then re-run with --apply.`);
  }
  return { changes, written };
}

/** Re-read the txs (read-only getTransaction) and compare the pool reserve deltas. */
export async function verifyTxs(rpcUrl, log = console.log) {
  let ok = true;
  for (const [name, t] of Object.entries(TXS)) {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [t.sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }] }),
    }).then((r) => r.json());
    const meta = res?.result?.meta;
    if (!meta) { log(`${name}: tx not found`); ok = false; continue; }
    const delta = (mint) => {
      const bal = (arr) => (arr || []).filter((b) => b.mint === mint && b.owner === SOL_RESERVE_OWNER).reduce((s, b) => s + Number(b.uiTokenAmount.uiAmount || 0), 0);
      return bal(meta.postTokenBalances) - bal(meta.preTokenBalances);
    };
    const sol = delta(SOL_MINT);
    const tok = delta(TOKEN_MINT);
    const match = Math.abs(sol - t.solToPool) < 1e-6 && Math.abs(tok - t.tokenToPool) < 1e-5 && meta.err == null;
    if (!match) ok = false;
    log(`${name}: pool SOL Δ ${sol.toFixed(9)} (expected ${t.solToPool}), e/acc Δ ${tok} (expected ${t.tokenToPool}) ${match ? "OK" : "MISMATCH"}`);
  }
  return ok;
}

async function main() {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf("--root");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = rootIdx >= 0 ? path.resolve(args[rootIdx + 1]) : path.resolve(here, "..");
  if (args.includes("--verify-txs")) {
    const rpc = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
    const ok = await verifyTxs(rpc);
    if (!ok) { console.error("Tx check failed — not applying."); process.exit(1); }
  }
  applyCorrections(root, { apply: args.includes("--apply") });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
