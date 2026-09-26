#!/usr/bin/env node
/**
 * One-off history correction: the e/acc-SOL false take profits of 2026-09-26.
 *
 * Both positions in pool 3vDyCqa4… were closed by the PnL watcher's FIXED_TP
 * on PnL API warm-up readings while flat on-chain:
 *   GDYiuQ9Z…  00:07  recorded +7.39%  / +$55.55   on-chain +0.01% (+$0.11)
 *   Guie7uix…  00:23  recorded +33.03% / +$249.74  on-chain  0.00% (−$0.01)
 * (Guie7uix went through the FIXED_TP branch while the warm-up guard was
 * "waiting for confirmation".)
 *
 * This rewrites each record everywhere a close lands:
 *   lessons.json     performance entries (pnl_pct, pnl_usd, …); the "WORKED: e/acc-SOL"
 *                    lesson from GDYiuQ9Z is removed; the "PREFER: e/acc-SOL … +33.03%"
 *                    lesson Guie7uix refreshed is annotated and demoted to neutral (its
 *                    earlier content was overwritten by the dedup merge and can't be restored)
 *   pool-memory.json the pool's deploy entries + recomputed avg_pnl_pct / win_rate / last_outcome
 *   state.json       the positions' notes and their recentAutoCloses entries
 *   knowledge/**.md  the pool article, the concept articles and LOG.md lines for those closes
 *
 * Real PnL comes from the pool reserve deltas of each position's deposit and
 * close txs (rent and tx fees are not LP PnL). Token withdrawn at close is
 * valued at what it actually fetched: the post-close swap proceeds (Guie7uix)
 * or the close's dust-gate valuation when it was left unsold (GDYiuQ9Z).
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

export const POOL = "3vDyCqa4q3G3u9iQCXYPfLeDQpknj9L5AXy3jd2NjgsK";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_MINT = "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU"; // e/acc

// solToPool / tokenToPool: change of the pool's SOL reserve (5ho1aD…) and
// e/acc reserve (CENEBR…) in each tx, read from the tx balances.
export const CORRECTIONS = [
  {
    key: "GDYiuQ9Z",
    position: "GDYiuQ9ZHMBr9j7SP716c9WYa9dxmPQL36p1ZkSKc9o8",
    deployedAt: "2026-09-26T00:03:02.006Z",
    kbStamp: "2026-09-26T00:07",
    apiPctText: "7.4%",
    apiPnlText: "7.39% ($55.55)",
    corrected: "false TP 7.4% (PnL API warm-up); on-chain ≈0%",
    amountSol: 6.16,
    initialValueUsd: 754.97,
    // 49.805765 e/acc of fees, left unsold under the $0.10 dust gate, valued at ~$0.0698 (logs 00:07:21).
    tokenValue: { usd: 0.0698 },
    txs: {
      create: { sig: "36w8tV7RLpJdWHY6xhJ5V3zgNDUTmaEBGdy2fJGaUmVTRy5FGuMxL1QjD8kiF4TicdByDx6K6ZgvzxMyxiegn5cq", solToPool: 0, tokenToPool: 0 },
      add1: { sig: "hATYPivgK1dQcWWVv4AoFn5T3No9wSwRQLCeV1r8zzNYcMwGGwq2eTpgUwo45HXeFqXrt4cwUydzLwA6CRjk3mi", solToPool: 4.81272134, tokenToPool: 0 },
      add2: { sig: "3ZPmBqkZ6PNmGNiNgFZeNnUHRAT1CAfVaWGEFnEEvC8bQxgY76TK32cZUZGBC8SunPUxYozmeTywo1FRMaHF14x8", solToPool: 1.347276988, tokenToPool: 0 },
      close1: { sig: "2V6oKvs9fiVUNwo2XQY39StjBKUruraK6vBG6Ywk18qwgfQN8qQuRf8nTNGHZed96qSrKdRHJCqKfphPsA8Rx91p", solToPool: -4.81272134, tokenToPool: 0 },
      close2: { sig: "3PNjTVwSPmZt6eFezuMQoEzpEd24Jg134kpq3KVizEE8k3eQXQtdcspjosqeJHSimV3V12DNmE9MMBR7LxMnma5L", solToPool: -1.347630818, tokenToPool: -49.805765 },
    },
    // Lesson derived from this close: not a win → removed.
    lesson: { createdAt: "2026-09-26T00:07:10.332Z", rulePrefix: "WORKED: e/acc-SOL", action: "remove" },
  },
  {
    key: "Guie7uix",
    position: "Guie7uixqYg9T4twsUsAYMdBufWXW2ZEvGeB7HTpBYZm",
    deployedAt: "2026-09-26T00:21:04.569Z",
    kbStamp: "2026-09-26T00:23",
    apiPctText: "33.0%",
    apiPnlText: "33.03% ($249.74)",
    corrected: "false TP 33.03% (PnL API warm-up, FIXED_TP bypassed the warm-up guard); on-chain ≈0%",
    amountSol: 6.17,
    initialValueUsd: 752,
    // 170.409362 e/acc withdrawn (10.507091 of it fees) and swapped to SOL by
    // KWwz3S8M… at 00:23:17 for 0.002122075 SOL (wallet +0.002109239 + 0.000012836 tx fee).
    tokenValue: { sol: 0.002122075, swapSig: "KWwz3S8MZwL6EFDDGuLZ2rULAt1H8XNRcm8S2T8dXM9c6f4vyLUbWMovAP1Kbqv1LuSMRk9eq1rkaadyXZDJjKV" },
    txs: {
      create: { sig: "29nNcsk4w5qGe91XuSohirU9RR2jGqyHa8UE9W2edMJ58pu7nQX8DqapiMrbuENvb8FcRMA9eppLFvD3MZFaYXAb", solToPool: 0, tokenToPool: 0 },
      add1: { sig: "2eEe9KkH6MeqhiBkNhPmt26JTVN9vmNnMM8sa3Xfxcc2dXfQWii6dEjhnercBXwPf98EFSuNMf9N8cf7KyyXAaco", solToPool: 4.82053012, tokenToPool: 0 },
      add2: { sig: "5HiR3sXexWsiRyAyDzmqWaY5GjVYHWKtZac2SrmKfA8M3NCKzMDe4LURTKFstNds2mUiWCrQC6d1MzmL5o2jWFu5", solToPool: 1.349462984, tokenToPool: 0 },
      close1: { sig: "57afShh5dB1bP2QRGDJbmDosgpABW91aXysJTaAprN6GEyeww12fQoWPKxnbf3RteGnSM2Eg4TzVi9wBCCWo91Gh", solToPool: -4.820530061, tokenToPool: 0 },
      close2: { sig: "4bkSxLDJ5XEMSyV8GxntXvNexeCxqo34KPscoy8qRPFNewhsk2KdH8HxKmEeiNA73y4474YESHQ6G5d4XyfpERJV", solToPool: -1.347259386, tokenToPool: -170.409362 },
    },
    // The dedup merge folded this close into an existing "PREFER … bid_ask efficient" lesson
    // (update_count 3), overwriting its text. Its earlier content is gone: annotate + demote.
    lesson: { createdAt: "2026-09-26T00:23:09.243Z", rulePrefix: "PREFER: e/acc-SOL", action: "annotate" },
  },
];

// Back-compat single-position exports (GDYiuQ9Z).
export const POSITION = CORRECTIONS[0].position;
export const DEPLOYED_AT = CORRECTIONS[0].deployedAt;
export const CORRECTED = CORRECTIONS[0].corrected;

const r2 = (n) => { const v = Math.round(n * 100) / 100; return Object.is(v, -0) ? 0 : v; };
const r9 = (n) => Math.round(n * 1e9) / 1e9;

export function computeCorrection(c = CORRECTIONS[0]) {
  const all = Object.values(c.txs);
  const depositSol = all.filter((t) => t.solToPool > 0).reduce((s, t) => s + t.solToPool, 0);
  const withdrawnSol = -all.filter((t) => t.solToPool < 0).reduce((s, t) => s + t.solToPool, 0);
  const tokenOut = -all.reduce((s, t) => s + t.tokenToPool, 0);
  const solUsd = c.initialValueUsd / c.amountSol; // entry SOL price
  const tokenSol = tokenOut > 0 ? (c.tokenValue.sol ?? c.tokenValue.usd / solUsd) : 0;
  const pnlSol = withdrawnSol - depositSol + tokenSol;
  const pnlUsd = r2(pnlSol * solUsd);
  return {
    depositSol: r9(depositSol),
    withdrawnSol: r9(withdrawnSol),
    tokenOut,
    tokenSol: r9(tokenSol),
    pnlSol: r9(pnlSol),
    pnlPct: r2((pnlSol / depositSol) * 100),
    pnlUsd,
    finalValueUsd: r2(c.initialValueUsd + pnlUsd),
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
 * Compute every change. Returns { changes: [{ file, key, label, before, after }], writes: Map(file → content) }.
 * Reads only; nothing is written here.
 */
export function planCorrections(root, corrections = CORRECTIONS) {
  const changes = [];
  const writes = new Map();
  const fixes = corrections.map((c) => ({ c, fix: computeCorrection(c) }));
  const note = (file, key, label, before, after) => changes.push({ file: path.relative(root, file) || file, key, label, before, after });

  // lessons.json
  const lessonsFile = path.join(root, "lessons.json");
  const lessons = readJson(lessonsFile);
  if (lessons) {
    let dirty = false;
    for (const { c, fix } of fixes) {
      for (const perf of lessons.performance || []) {
        if (perf.position !== c.position || perf.corrected) continue;
        const before = { pnl_pct: perf.pnl_pct, pnl_usd: perf.pnl_usd, actual_pnl_pct: perf.actual_pnl_pct, actual_pnl_usd: perf.actual_pnl_usd, final_value_usd: perf.final_value_usd, fees_earned_usd: perf.fees_earned_usd };
        perf.original = before;
        perf.pnl_pct = fix.pnlPct;
        perf.actual_pnl_pct = fix.pnlPct;
        perf.pnl_usd = fix.pnlUsd;
        perf.actual_pnl_usd = fix.pnlUsd;
        perf.final_value_usd = fix.finalValueUsd;
        perf.pnl_source = "onchain";
        perf.corrected = c.corrected;
        note(lessonsFile, c.key, "performance record", before, { pnl_pct: perf.pnl_pct, pnl_usd: perf.pnl_usd, final_value_usd: perf.final_value_usd, corrected: perf.corrected });
        dirty = true;
      }
      const list = lessons.lessons || [];
      const idx = list.findIndex((l) => l.created_at === c.lesson.createdAt && String(l.rule || "").startsWith(c.lesson.rulePrefix) && !l.corrected);
      if (idx >= 0) {
        const l = list[idx];
        if (c.lesson.action === "remove") {
          list.splice(idx, 1);
          note(lessonsFile, c.key, "lesson removed (not a win)", l.rule, null);
        } else {
          const before = { rule: l.rule, outcome: l.outcome, pnl_pct: l.pnl_pct };
          l.original = before;
          l.rule = `[CORRECTED — not a win] e/acc-SOL bid_ask: the +${l.pnl_pct}% behind this PREFER lesson was a ${c.corrected}; the close made ${fix.pnlPct}%. Do not prefer this pool type on its account. (Earlier updates of this lesson were overwritten and can't be restored.)`;
          l.outcome = "neutral";
          l.pnl_pct = fix.pnlPct;
          l.tags = [...new Set([...(l.tags || []), "corrected"])];
          l.corrected = c.corrected;
          note(lessonsFile, c.key, "lesson annotated + demoted to neutral", before, { rule: l.rule, outcome: l.outcome, pnl_pct: l.pnl_pct });
        }
        dirty = true;
      }
    }
    if (dirty) writes.set(lessonsFile, JSON.stringify(lessons, null, 2));
  }

  // pool-memory.json
  const pmFile = path.join(root, "pool-memory.json");
  const pm = readJson(pmFile);
  const entry = pm?.[POOL];
  if (entry) {
    const before = { avg_pnl_pct: entry.avg_pnl_pct, win_rate: entry.win_rate, last_outcome: entry.last_outcome };
    let dirty = false;
    for (const { c, fix } of fixes) {
      const dep = (entry.deploys || []).find((d) => d.deployed_at === c.deployedAt);
      if (!dep || dep.corrected) continue;
      const depBefore = { pnl_pct: dep.pnl_pct, pnl_usd: dep.pnl_usd };
      dep.original = depBefore;
      dep.pnl_pct = fix.pnlPct;
      dep.pnl_usd = fix.pnlUsd;
      dep.corrected = c.corrected;
      note(pmFile, c.key, "pool deploy", depBefore, { pnl_pct: dep.pnl_pct, pnl_usd: dep.pnl_usd });
      dirty = true;
    }
    if (dirty) {
      // Same aggregation as pool-memory.js recordPoolDeploy.
      const withPnl = entry.deploys.filter((d) => d.pnl_pct != null);
      if (withPnl.length) {
        entry.avg_pnl_pct = r2(withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length);
        entry.win_rate = r2(withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length);
      }
      const last = entry.deploys[entry.deploys.length - 1];
      entry.last_outcome = last.pnl_pct == null ? "unknown" : last.pnl_pct >= 0 ? "profit" : "loss";
      note(pmFile, "pool", "pool aggregates", before, { avg_pnl_pct: entry.avg_pnl_pct, win_rate: entry.win_rate, last_outcome: entry.last_outcome });
      writes.set(pmFile, JSON.stringify(pm, null, 2));
    }
  }

  // state.json
  const stateFile = path.join(root, "state.json");
  const state = readJson(stateFile);
  if (state) {
    let dirty = false;
    for (const { c, fix } of fixes) {
      const pos = state.positions?.[c.position];
      const stateNote = `Corrected: ${c.corrected} — closed at ${fix.pnlPct}% ($${fix.pnlUsd}) on-chain, not ${c.apiPnlText}`;
      if (pos && !(pos.notes || []).some((n) => String(n).startsWith("Corrected:"))) {
        pos.notes = [...(pos.notes || []), stateNote];
        pos.corrected = c.corrected;
        note(stateFile, c.key, "position notes", null, stateNote);
        dirty = true;
      }
      for (const ac of state.recentAutoCloses || []) {
        if (ac.position !== c.position || ac.corrected) continue;
        const before = { pnl_pct: ac.pnl_pct };
        ac.api_pnl_pct = ac.pnl_pct;
        ac.pnl_pct = fix.pnlPct;
        ac.corrected = c.corrected;
        note(stateFile, c.key, "recentAutoCloses", before, { pnl_pct: ac.pnl_pct, corrected: ac.corrected });
        dirty = true;
      }
    }
    if (dirty) writes.set(stateFile, JSON.stringify(state, null, 2));
  }

  // knowledge/**.md — the lines filed for these closes (pool article, concept articles, LOG.md)
  for (const file of listMd(path.join(root, "knowledge"))) {
    const text = fs.readFileSync(file, "utf8");
    // The pool article's history lines don't repeat the pool name.
    const isPoolArticle = path.basename(file) === "e-acc-sol.md";
    let dirty = false;
    const lines = text.split("\n").map((line) => {
      if (line.includes("[corrected:")) return line;
      if (!isPoolArticle && !line.includes("e/acc-SOL")) return line;
      const hit = fixes.find(({ c }) => line.includes(c.kbStamp) && line.includes(c.apiPctText));
      if (!hit) return line;
      const { c, fix } = hit;
      const outcomeFixed = fix.pnlPct < 0 ? line.replace(/\bWIN\b/, "LOSS") : line;
      const fixed = `${outcomeFixed.replace(c.apiPctText, `${fix.pnlPct.toFixed(1)}%`)} [corrected: ${c.corrected}]`;
      note(file, c.key, "kb line", line, fixed);
      dirty = true;
      return fixed;
    });
    if (dirty) writes.set(file, lines.join("\n"));
  }

  return { changes, writes };
}

export function applyCorrections(root, { apply = false, log = console.log, corrections = CORRECTIONS } = {}) {
  for (const c of corrections) {
    const fix = computeCorrection(c);
    log(`${c.key}: on-chain deposited ${fix.depositSol} SOL, withdrew ${fix.withdrawnSol} SOL + ${fix.tokenOut} e/acc (≈${fix.tokenSol} SOL) → PnL ${fix.pnlSol} SOL = ${fix.pnlPct}% ($${fix.pnlUsd}); recorded ${c.apiPnlText}`);
  }
  const { changes, writes } = planCorrections(root, corrections);
  if (!changes.length) {
    log("Nothing to change: already corrected (or the records are not in this directory).");
    return { changes, written: [] };
  }
  for (const ch of changes) {
    log(`\n[${ch.file}] ${ch.key}: ${ch.label}`);
    log(`  - before: ${typeof ch.before === "string" ? ch.before : JSON.stringify(ch.before)}`);
    log(`  + after:  ${typeof ch.after === "string" ? ch.after : JSON.stringify(ch.after)}`);
  }
  const written = [];
  if (apply) {
    for (const [file, content] of writes) {
      const bak = `${file}.bak-fix-false-tp`;
      if (!fs.existsSync(bak)) fs.copyFileSync(file, bak); // keep the first (pre-correction) copy
      fs.writeFileSync(file, content);
      written.push(file);
    }
    log(`\nWrote ${written.length} file(s) (backups: *.bak-fix-false-tp).`);
  } else {
    log(`\nPreview only: ${writes.size} file(s) would change. Stop the bot, then re-run with --apply.`);
  }
  return { changes, written };
}

async function getTx(rpcUrl, sig) {
  // Public RPCs rate-limit bursts: retry a few times before calling it missing.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }] }),
    }).then((r) => r.json()).catch(() => null);
    if (res?.result) return res.result;
  }
  return null;
}

/** Re-read the txs (read-only getTransaction) and compare the pool reserve deltas. */
export async function verifyTxs(rpcUrl, log = console.log, corrections = CORRECTIONS) {
  let ok = true;
  for (const c of corrections) {
    for (const [name, t] of Object.entries(c.txs)) {
      const meta = (await getTx(rpcUrl, t.sig))?.meta;
      if (!meta) { log(`${c.key} ${name}: tx not found`); ok = false; continue; }
      const delta = (mint) => {
        const bal = (arr) => (arr || []).filter((b) => b.mint === mint && b.owner === POOL).reduce((s, b) => s + Number(b.uiTokenAmount.uiAmount || 0), 0);
        return bal(meta.postTokenBalances) - bal(meta.preTokenBalances);
      };
      const sol = delta(SOL_MINT);
      const tok = delta(TOKEN_MINT);
      const match = Math.abs(sol - t.solToPool) < 1e-6 && Math.abs(tok - t.tokenToPool) < 1e-5 && meta.err == null;
      if (!match) ok = false;
      log(`${c.key} ${name}: pool SOL Δ ${sol.toFixed(9)} (expected ${t.solToPool}), e/acc Δ ${tok} (expected ${t.tokenToPool}) ${match ? "OK" : "MISMATCH"}`);
    }
    if (c.tokenValue.swapSig) {
      const tx = await getTx(rpcUrl, c.tokenValue.swapSig);
      const m = tx?.meta;
      const got = m ? (m.postBalances[0] - m.preBalances[0] + m.fee) / 1e9 : NaN;
      const match = Math.abs(got - c.tokenValue.sol) < 1e-8;
      if (!match) ok = false;
      log(`${c.key} swap: SOL received ${got} (expected ${c.tokenValue.sol}) ${match ? "OK" : "MISMATCH"}`);
    }
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
