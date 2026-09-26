// briefing.js — the daily Telegram briefing (index.js runBriefing, 01:00 UTC,
// and Telegram /briefing).
//
// Every PnL, fee and win-rate figure comes from the bot's own close records
// (lessons.json performance), not from LP Agent's wallet overview: that one
// counts every position the wallet ever held, so it disagrees with what the
// bot did. LP Agent stays as one line, labelled as external.
//
//   PnL (SOL)  the record's on-chain SOL PnL (pnl_sol) when stored; otherwise
//              pnl_pct × amount_sol. Records from ONCHAIN_PNL_SINCE on carry
//              the on-chain % in pnl_pct; older ones hold the PnL API's %.
//   Fees (SOL) fees_sol on the record (claims mid-position + at close), else
//              the tracked position's claimed fees in state.json, else
//              fees_earned_usd at the entry SOL price.
//   Win rate   learning-data.js classifyOutcome: win > +1%, loss < −1%,
//              break-even in between; rate = wins / (wins + losses).
//   Excluded   records learning-data.js marks excluded / corrupt / corrected.
//
// Each briefing sent is logged (tag BRIEFING) and appended to
// logs/briefings.jsonl as { ts, text }; /briefing re-sends the latest one.

import fs from "fs";
import path from "path";
import { log } from "./logger.js";
import { classifyOutcome, exclusionReason, recordPnlPct } from "./learning-data.js";
import { claimedFeesSol } from "./tools/onchain-pnl.js";
import { computePortfolioSol, resolveSolPrice, valueDlmmPositions } from "./portfolio-value.js";

const STATE_FILE = "./state.json";
const LESSONS_FILE = "./lessons.json";
export const BRIEFINGS_FILE = "./logs/briefings.jsonl";

/** Close records from here on store the on-chain PnL % (tools/dlmm.js closePosition). */
export const ONCHAIN_PNL_SINCE = "2026-09-26T00:50:00.000Z";
const ONCHAIN_PNL_SINCE_MS = Date.parse(ONCHAIN_PNL_SINCE);

/** close_reason of an owner close from Telegram (telegram-ui.js). */
export const MANUAL_CLOSE_REASON = "manual (owner, Telegram)";
export const isManualClose = (rec) => /^manual\b/i.test(String(rec?.close_reason || ""));

const DAY_MS = 24 * 60 * 60 * 1000;
const PORTFOLIO_TIMEOUT_MS = 15_000;
const ONCHAIN_TIMEOUT_MS = 8_000;

const finite = (v) => v != null && v !== "" && Number.isFinite(Number(v));

// ─── Per-record figures ─────────────────────────────────────────

/**
 * PnL of a close record in SOL.
 * Returns { pnlSol, pnlPct, source: "onchain" | "api" } or null (PnL unknown).
 */
export function recordPnlSol(rec) {
  const pct = recordPnlPct(rec);
  if (pct == null) return null;
  const recordedMs = Date.parse(rec.recorded_at || "");
  const onchainEra = rec.pnl_source === "onchain"
    || (rec.pnl_source == null && Number.isFinite(recordedMs) && recordedMs >= ONCHAIN_PNL_SINCE_MS);
  if (rec.pnl_source === "onchain" && finite(rec.pnl_sol)) {
    return { pnlSol: Number(rec.pnl_sol), pnlPct: pct, source: "onchain" };
  }
  const amount = Number(rec.amount_sol);
  if (!(amount > 0)) return null;
  return { pnlSol: (pct / 100) * amount, pnlPct: pct, source: onchainEra ? "onchain" : "api" };
}

/**
 * Fees a close earned, in SOL. `statePos` is the state.json record of the
 * position (may be null). Returns { feesSol, source } — source "record",
 * "state", "usd" (converted at the entry SOL price) or null when none known.
 */
export function recordFeesSol(rec, statePos = null) {
  if (finite(rec?.fees_sol) && Number(rec.fees_sol) > 0) return { feesSol: Number(rec.fees_sol), source: "record" };
  const claimed = statePos ? claimedFeesSol(statePos) : 0;
  if (claimed > 0) return { feesSol: claimed, source: "state" };
  const usd = Number(rec?.fees_earned_usd);
  const amount = Number(rec?.amount_sol);
  const initUsd = Number(rec?.initial_value_usd);
  if (usd > 0 && amount > 0 && initUsd > 0) return { feesSol: usd / (initUsd / amount), source: "usd" };
  return { feesSol: 0, source: null };
}

/**
 * Stats over close records. `since` (ms or Date) keeps records recorded at or
 * after it; `positions` is state.json positions (for claimed fees).
 */
export function computeCloseStats(records, { since = null, positions = {} } = {}) {
  const sinceMs = since == null ? null : new Date(since).getTime();
  const inWindow = (records || []).filter((r) => {
    if (sinceMs == null) return true;
    const t = Date.parse(r?.recorded_at || "");
    return Number.isFinite(t) && t >= sinceMs;
  });
  const s = {
    closes: 0, excluded: 0, unknownPnl: 0, apiBased: 0,
    pnlSol: 0, feesSol: 0, feesFromUsd: 0,
    wins: 0, losses: 0, breakeven: 0, winRatePct: null,
    bot: { count: 0, pnlSol: 0 }, manual: { count: 0, pnlSol: 0 },
    best: null, worst: null,
  };
  for (const r of inWindow) {
    if (exclusionReason(r)) { s.excluded++; continue; }
    s.closes++;
    const side = isManualClose(r) ? s.manual : s.bot;
    side.count++;
    const fees = recordFeesSol(r, positions?.[r.position] || null);
    s.feesSol += fees.feesSol;
    if (fees.source === "usd") s.feesFromUsd++;
    const pnl = recordPnlSol(r);
    if (!pnl) { s.unknownPnl++; continue; }
    if (pnl.source === "api") s.apiBased++;
    s.pnlSol += pnl.pnlSol;
    side.pnlSol += pnl.pnlSol;
    const cls = classifyOutcome(pnl.pnlPct);
    if (cls === "win") s.wins++;
    else if (cls === "loss") s.losses++;
    else if (cls === "breakeven") s.breakeven++;
    const entry = { pool_name: r.pool_name || r.pool?.slice?.(0, 8) || "?", pnlSol: pnl.pnlSol, pnlPct: pnl.pnlPct, manual: isManualClose(r) };
    if (!s.best || entry.pnlSol > s.best.pnlSol) s.best = entry;
    if (!s.worst || entry.pnlSol < s.worst.pnlSol) s.worst = entry;
  }
  const decisive = s.wins + s.losses;
  s.winRatePct = decisive > 0 ? Math.round((s.wins / decisive) * 100) : null;
  return s;
}

// ─── Formatting ─────────────────────────────────────────────────

export function escapeHtml(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const signed = (n, d = 4) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(d)}`;
const solAmt = (n, d = 4) => `${signed(n, d)} SOL`;
const pctAmt = (n) => `${signed(n, 2)}%`;

/** HTML lines of one performance section. */
export function formatStatsSection(title, s) {
  const lines = [`<b>${title}</b>`];
  if (s.closes === 0) {
    lines.push("  No closes.");
    if (s.excluded) lines.push(`  Excluded: ${s.excluded} (known-bad / corrected record${s.excluded === 1 ? "" : "s"})`);
    return lines;
  }
  lines.push(`  PnL: ${solAmt(s.pnlSol)}${s.apiBased ? " (API-based before Sep 26)" : ""}`);
  const feeNotes = ["already in PnL", ...(s.feesFromUsd ? [`${s.feesFromUsd} from USD at entry price`] : [])];
  lines.push(`  Fees: ${s.feesSol.toFixed(4)} SOL (${feeNotes.join("; ")})`);
  lines.push(`  Win rate: ${s.winRatePct == null ? "n/a" : `${s.winRatePct}%`} (${s.wins}W / ${s.losses}L, ${s.breakeven} break-even)`);
  lines.push(`  Closes: ${s.closes} — bot ${s.bot.count} (${solAmt(s.bot.pnlSol)}) · manual ${s.manual.count} (${solAmt(s.manual.pnlSol)})`);
  if (s.best) lines.push(`  Best: ${escapeHtml(s.best.pool_name)} ${solAmt(s.best.pnlSol)} (${pctAmt(s.best.pnlPct)})${s.best.manual ? " [manual]" : ""}`);
  if (s.worst && s.closes - s.unknownPnl > 1) lines.push(`  Worst: ${escapeHtml(s.worst.pool_name)} ${solAmt(s.worst.pnlSol)} (${pctAmt(s.worst.pnlPct)})${s.worst.manual ? " [manual]" : ""}`);
  const notes = [];
  if (s.unknownPnl) notes.push(`${s.unknownPnl} with unknown PnL`);
  if (s.excluded) notes.push(`${s.excluded} excluded (known-bad / corrected)`);
  if (notes.length) lines.push(`  <i>${notes.join(" · ")}</i>`);
  return lines;
}

/**
 * Current portfolio lines. `wallet` from getWalletBalances, `positionsResult`
 * from getMyPositions, `onchain` a Map position → getOnchainPnl result.
 */
export function formatPortfolio({ wallet = null, positionsResult = null, onchain = new Map(), walletError = null } = {}) {
  const lines = ["<b>Current Portfolio</b>"];
  const freeSol = !walletError && finite(wallet?.sol) ? Number(wallet.sol) : null;
  lines.push(`  Free SOL: ${freeSol == null ? `unknown${walletError ? ` (${escapeHtml(walletError)})` : ""}` : `${freeSol.toFixed(4)} SOL`}`);
  if (!positionsResult || positionsResult.error) {
    lines.push(`  Open positions: unavailable${positionsResult?.error ? ` (${escapeHtml(positionsResult.error)})` : ""}`);
    return lines;
  }
  const posList = Array.isArray(positionsResult.positions) ? positionsResult.positions : [];
  const price = resolveSolPrice(wallet, posList);
  const valued = valueDlmmPositions(posList, price);
  lines.push(`  Open positions: ${posList.length}`);
  for (const v of valued.positions) {
    const p = v.raw;
    const oc = onchain.get(p.position) || null;
    const valueSol = oc && finite(oc.valueSol)
      ? Number(oc.valueSol) + (Number(oc.feesSol) || 0)
      : v.known && price ? v.totalUsd / price : null;
    const size = valueSol == null ? "? SOL" : `${valueSol.toFixed(4)} SOL`;
    const deposit = oc && finite(oc.depositSol) ? ` (in ${Number(oc.depositSol).toFixed(4)})` : "";
    let pnl;
    if (oc && finite(oc.pnlPct)) pnl = `${pctAmt(Number(oc.pnlPct))} / ${solAmt(Number(oc.pnlSol))} on-chain`;
    else if (!p.pnl_unknown && finite(p.pnl_pct)) pnl = `${pctAmt(Number(p.pnl_pct))}${finite(p.pnl_sol) ? ` / ${solAmt(Number(p.pnl_sol))}` : ""} (API)`;
    else pnl = "PnL unknown";
    const range = p.in_range === false
      ? `OOR${p.minutes_out_of_range != null ? ` ${p.minutes_out_of_range}m` : ""}`
      : p.in_range === true ? "in range" : "range ?";
    lines.push(`  • ${escapeHtml(p.pair || p.position?.slice?.(0, 8) || "?")}: ${size}${deposit} · ${pnl} · ${range}`);
  }
  const total = computePortfolioSol({ walletSol: freeSol, wallet, positionsResult });
  lines.push(total.ok
    ? `  Total: ${total.totalSol.toFixed(4)} SOL (free ${total.walletSol.toFixed(4)} + positions ${total.dlmmSol.toFixed(4)})`
    : `  Total: unknown (${escapeHtml(total.reason)})`);
  return lines;
}

/** The one LP Agent line, marked external; null when the overview is unavailable. */
export function formatLpOverviewLine(o) {
  if (!o || !finite(o.total_pnl_sol)) return null;
  const parts = [`PnL ${solAmt(Number(o.total_pnl_sol))}`];
  if (finite(o.total_fees_sol)) parts.push(`fees ${Number(o.total_fees_sol).toFixed(4)} SOL`);
  if (finite(o.closed_positions)) parts.push(`${o.closed_positions} closes`);
  return `<i>External — LP Agent wallet total (all history): ${parts.join(" · ")}. Counts every position the wallet ever held, not only the bot's.</i>`;
}

// ─── Briefing ───────────────────────────────────────────────────

function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Open positions for the briefing, read-only: getWalletPositions (on-chain
 * accounts + Meteora PnL API) with pair names from state.json. Not
 * getMyPositions, which also updates state.json (range flags, sync of closed
 * positions) as a side effect.
 */
async function readOpenPositions(walletAddress, statePositions = {}) {
  if (!walletAddress) return { error: "wallet address unknown", positions: [] };
  const { getWalletPositions } = await import("./tools/dlmm.js");
  const res = await getWalletPositions({ wallet_address: walletAddress });
  const positions = (res?.positions || []).map((p) => ({ ...p, pair: p.pair ?? statePositions?.[p.position]?.pool_name ?? null }));
  return { ...res, positions };
}

const defaultDeps = {
  getPositions: readOpenPositions,
  getWalletBalances: async () => (await import("./tools/wallet.js")).getWalletBalances(),
  getOnchainPnl: async (p) => (await import("./tools/onchain-pnl.js")).getOnchainPnl(p),
  getLpOverview: async () => (await import("./tools/lp-overview.js")).getLpOverview(),
};

/**
 * Build the briefing HTML. Reads lessons.json and state.json; the portfolio
 * section reads the wallet and positions (read-only). `deps` overrides the
 * data sources (tests).
 */
export async function generateBriefing({ now = new Date(), deps = {} } = {}) {
  const d = { ...defaultDeps, ...deps };
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };
  const nowMs = new Date(now).getTime();
  const last24h = new Date(nowMs - DAY_MS);

  // 1. Activity (state.json)
  const allPositions = Object.values(state.positions || {});
  const openedLast24h = allPositions.filter((p) => new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter((p) => p.closed && new Date(p.closed_at) > last24h);

  // 2. Performance from the bot's own close records
  const perf = lessonsData.performance || [];
  const positions = state.positions || {};
  const day = computeCloseStats(perf, { since: last24h, positions });
  const all = computeCloseStats(perf, { positions });

  // 3. Lessons created in the last 24h, 5 most recent (unparseable dates excluded)
  const recentLessons = (lessonsData.lessons || [])
    .filter((l) => {
      const ts = l.created_at ? new Date(l.created_at) : null;
      return ts && !isNaN(ts.getTime()) && ts > last24h;
    })
    .slice(-5);

  // 4. Portfolio (read-only; each source may fail independently)
  let walletError = null;
  const lpOverviewP = withTimeout(d.getLpOverview(), PORTFOLIO_TIMEOUT_MS, null);
  const wallet = await withTimeout(d.getWalletBalances(), PORTFOLIO_TIMEOUT_MS, null).then((w) => {
    if (!w || w.error) { walletError = w?.error || "unavailable"; return w?.wallet ? { wallet: w.wallet } : null; }
    return w;
  });
  const positionsResult = await withTimeout(d.getPositions(wallet?.wallet ?? null, positions), PORTFOLIO_TIMEOUT_MS, { error: "timed out" });
  const lpOverview = await lpOverviewP;
  const onchain = new Map();
  const openList = Array.isArray(positionsResult?.positions) ? positionsResult.positions : [];
  await Promise.all(openList.map(async (p) => {
    const oc = await withTimeout(d.getOnchainPnl(p), ONCHAIN_TIMEOUT_MS, null);
    if (oc) onchain.set(p.position, oc);
  }));

  const lpLine = formatLpOverviewLine(lpOverview);
  const lines = [
    `<b>Morning Briefing</b> — ${new Date(nowMs).toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    "<b>Activity (last 24h)</b>",
    `  Positions Opened: ${openedLast24h.length}`,
    `  Positions Closed: ${closedLast24h.length}`,
    "",
    ...formatStatsSection("Performance — last 24h (bot records)", day),
    "",
    ...formatStatsSection("Performance — all time (bot records)", all),
    "",
    "<b>Lessons Learned</b>",
    recentLessons.length > 0
      ? recentLessons.map((l) => `  - ${escapeHtml(l.rule)}`).join("\n")
      : "  - No new lessons recorded.",
    "",
    ...formatPortfolio({ wallet, positionsResult, onchain, walletError }),
    ...(lpLine ? ["", lpLine] : []),
  ];
  return lines.join("\n");
}

// ─── Briefing log ───────────────────────────────────────────────

/** Telegram HTML → plain text. */
export function briefingToText(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Record a sent briefing: plain text to the log (tag BRIEFING) and a
 * { ts, text } line appended to logs/briefings.jsonl. Never throws.
 */
export function recordBriefing(html, { file = BRIEFINGS_FILE, now = new Date() } = {}) {
  const entry = { ts: new Date(now).toISOString(), text: briefingToText(html) };
  try {
    log("briefing", `\n${entry.text}`);
  } catch { /* logging is best-effort */ }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch (e) {
    try { log("briefing_error", `Could not append to ${file}: ${e.message}`); } catch { /* ignore */ }
  }
  return entry;
}

/** The latest stored briefing { ts, text }, or null. */
export function latestBriefing({ file = BRIEFINGS_FILE } = {}) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  const lines = raw.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e && typeof e.text === "string") return e;
    } catch { /* skip a torn line */ }
  }
  return null;
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}

