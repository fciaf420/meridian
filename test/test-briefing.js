/**
 * Daily briefing (briefing.js): PnL / fees / win rate from the bot's own close
 * records (on-chain and API-based mixed), exclusions, the manual/bot split,
 * the portfolio and LP Agent lines, the briefings.jsonl log, the Telegram
 * /briefing command, and the lessons.js reporting helpers' win rate.
 *
 * Everything runs in a scratch cwd with fixture lessons.json / state.json;
 * every wallet, RPC and API read is injected. No network, no transaction.
 */
process.env.DRY_RUN = "true";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-briefing-"));
process.chdir(TMP);
process.env.MERIDIAN_USER_CONFIG_PATH = path.join(TMP, "user-config.json");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const b = await import("../briefing.js");
const ld = await import("../learning-data.js");
const ui = await import("../telegram-ui.js");
const lessons = await import("../lessons.js");

const NOW = new Date("2026-09-26T15:00:00.000Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const COLLECT = ld.KNOWN_BAD_RECORDS.find((k) => k.key === "COLLECT-false-stop-loss");

// Entry SOL price $120 for every fixture: initial_value_usd = amount_sol × 120.
const rec = (o) => ({
  pool: `Pool${o.position}`, pool_name: `${o.position}-SOL`, amount_sol: 5, initial_value_usd: 600,
  fees_earned_usd: 0, close_reason: "agent decision", ...o,
});

// A: API-era (2 days ago), +2% on 5 SOL → +0.1 SOL, win; fees $12 → 0.1 SOL from USD
// B: API-era, −3% on 4 SOL → −0.12 SOL, loss; state shows 0.05 SOL claimed
// C: on-chain era (last 24h), pnl_sol stored +0.3 (pct 5), win; fees_sol 0.2 on the record
// D: on-chain era, no pnl_sol, +0.5% on 6 SOL → +0.03 SOL, break-even; manual close
// E: on-chain era, −2% on 5 SOL → −0.1 SOL, loss
// X1: flagged exclude_from_learning (huge loss, must not count)
// X2: corrected (must not count)
// X3: the known-bad COLLECT record (must not count)
// U: PnL unknown (counts as a close, not in PnL/win rate)
const records = () => [
  rec({ position: "A", pnl_pct: 2, fees_earned_usd: 12, recorded_at: hoursAgo(48) }),
  rec({ position: "B", pnl_pct: -3, amount_sol: 4, initial_value_usd: 480, recorded_at: hoursAgo(40) }),
  rec({ position: "C", pnl_pct: 5, pnl_sol: 0.3, pnl_source: "onchain", fees_sol: 0.2, fees_earned_usd: 99, recorded_at: hoursAgo(10) }),
  rec({ position: "D", pnl_pct: 0.5, amount_sol: 6, initial_value_usd: 720, close_reason: b.MANUAL_CLOSE_REASON, recorded_at: hoursAgo(5) }),
  rec({ position: "E", pnl_pct: -2, recorded_at: hoursAgo(2) }),
  rec({ position: "X1", pnl_pct: -50, exclude_from_learning: "test junk", recorded_at: hoursAgo(3) }),
  rec({ position: "X2", pnl_pct: 40, corrected: "false TP", recorded_at: hoursAgo(4) }),
  rec({ position: COLLECT.position, pool: COLLECT.pool, pnl_pct: -66.44, recorded_at: COLLECT.recorded_at }),
  rec({ position: "U", pnl_pct: 0, pnl_unknown: true, recorded_at: hoursAgo(1) }),
];
const statePositions = () => ({
  B: { position: "B", closed: true, closed_at: hoursAgo(40), deployed_at: hoursAgo(42), amount_sol: 4, total_fees_claimed_sol: 0.05 },
  E: { position: "E", closed: true, closed_at: hoursAgo(2), deployed_at: hoursAgo(20), amount_sol: 5 },
  OPEN1: { position: "OPEN1", deployed_at: hoursAgo(3), amount_sol: 2 },
});

const close = (a, e, msg) => assert.ok(Math.abs(a - e) < 1e-9, `${msg ?? ""} expected ${e}, got ${a}`);

test("recordPnlSol: stored on-chain SOL, on-chain-era %, API-era %, unknown", () => {
  const [A, , C, D] = records();
  assert.deepEqual(b.recordPnlSol(C), { pnlSol: 0.3, pnlPct: 5, source: "onchain" });
  const d = b.recordPnlSol(D);
  close(d.pnlSol, 0.03); assert.equal(d.source, "onchain");
  const a = b.recordPnlSol(A);
  close(a.pnlSol, 0.1); assert.equal(a.source, "api");
  // A new record that says api stays api even after the cutoff.
  assert.equal(b.recordPnlSol(rec({ position: "N", pnl_pct: 1, pnl_source: "api", recorded_at: hoursAgo(1) })).source, "api");
  assert.equal(b.recordPnlSol(rec({ position: "U", pnl_pct: 0, pnl_unknown: true })), null);
});

test("recordFeesSol: record fees_sol, then state claims, then USD at entry price", () => {
  const [A, B, C] = records();
  assert.deepEqual(b.recordFeesSol(C), { feesSol: 0.2, source: "record" });
  assert.deepEqual(b.recordFeesSol(B, statePositions().B), { feesSol: 0.05, source: "state" });
  const a = b.recordFeesSol(A);
  close(a.feesSol, 0.1); assert.equal(a.source, "usd");
  assert.deepEqual(b.recordFeesSol(rec({ position: "Z" })), { feesSol: 0, source: null });
});

test("computeCloseStats all-time: mixed sources, exclusions, win rate, manual/bot split, best/worst", () => {
  const s = b.computeCloseStats(records(), { positions: statePositions() });
  assert.equal(s.excluded, 3, "exclude_from_learning, corrected and the known-bad COLLECT record");
  assert.equal(s.closes, 6);
  assert.equal(s.unknownPnl, 1);
  close(s.pnlSol, 0.1 - 0.12 + 0.3 + 0.03 - 0.1, "PnL");
  close(s.feesSol, 0.1 + 0.05 + 0.2, "fees");
  assert.equal(s.feesFromUsd, 1);
  assert.equal(s.apiBased, 2);
  assert.deepEqual([s.wins, s.losses, s.breakeven], [2, 2, 1]);
  assert.equal(s.winRatePct, 50, "wins / (wins + losses), break-even left out");
  assert.equal(s.manual.count, 1); close(s.manual.pnlSol, 0.03);
  assert.equal(s.bot.count, 5); close(s.bot.pnlSol, 0.1 - 0.12 + 0.3 - 0.1);
  assert.equal(s.best.pool_name, "C-SOL");
  assert.equal(s.worst.pool_name, "B-SOL");
});

test("computeCloseStats last 24h: only on-chain-era records, no API note", () => {
  const s = b.computeCloseStats(records(), { since: NOW.getTime() - 24 * 3600_000, positions: statePositions() });
  assert.equal(s.closes, 4); // C, D, E, U
  assert.equal(s.excluded, 2); // X1, X2 (COLLECT is from 2026-09-25)
  assert.equal(s.apiBased, 0);
  close(s.pnlSol, 0.3 + 0.03 - 0.1);
  assert.equal(s.winRatePct, 50);
  const html = b.formatStatsSection("24h", s).join("\n");
  assert.doesNotMatch(html, /API-based/);
  assert.match(html, /PnL: \+0\.2300 SOL/);
  assert.match(html, /Win rate: 50% \(1W \/ 1L, 1 break-even\)/);
  assert.match(html, /bot 3 \(\+0\.2000 SOL\) · manual 1 \(\+0\.0300 SOL\)/);
  assert.match(html, /2 excluded/);
});

test("formatStatsSection marks API-based PnL and handles no closes", () => {
  const all = b.formatStatsSection("All", b.computeCloseStats(records(), { positions: statePositions() })).join("\n");
  assert.match(all, /PnL: \+0\.2100 SOL \(API-based before Sep 26\)/);
  assert.match(all, /Fees: 0\.3500 SOL/);
  assert.match(all, /Best: C-SOL \+0\.3000 SOL \(\+5\.00%\)/);
  assert.match(all, /Worst: B-SOL −0\.1200 SOL \(−3\.00%\)/);
  const none = b.formatStatsSection("Empty", b.computeCloseStats([])).join("\n");
  assert.match(none, /No closes/);
});

test("briefing log: plain text to the log and { ts, text } appended to logs/briefings.jsonl", () => {
  const file = path.join(TMP, "logs", "briefings-test.jsonl");
  assert.equal(b.latestBriefing({ file }), null);
  const e1 = b.recordBriefing("<b>One</b>\nPnL &lt;1 &amp; more", { file, now: new Date("2026-09-25T01:00:00Z") });
  assert.deepEqual(e1, { ts: "2026-09-25T01:00:00.000Z", text: "One\nPnL <1 & more" });
  b.recordBriefing("<b>Two</b>", { file, now: new Date("2026-09-26T01:00:00Z") });
  fs.appendFileSync(file, "{torn"); // a torn last line is skipped
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 3);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])), ["ts", "text"]);
  assert.deepEqual(b.latestBriefing({ file }), { ts: "2026-09-26T01:00:00.000Z", text: "Two" });
  const today = new Date().toISOString().slice(0, 10);
  const log = fs.readFileSync(path.join(TMP, "logs", `agent-${today}.log`), "utf8");
  assert.match(log, /\[BRIEFING\]/);
  assert.match(log, /PnL <1 & more/);
});

test("generateBriefing: bot-record numbers, portfolio, labelled LP Agent line", async () => {
  fs.writeFileSync("lessons.json", JSON.stringify({
    performance: records(),
    lessons: [{ rule: "AVOID pools with vol < 2", created_at: hoursAgo(1) }, { rule: "old", created_at: hoursAgo(80) }],
  }));
  fs.writeFileSync("state.json", JSON.stringify({ positions: statePositions() }));
  const seen = [];
  const html = await b.generateBriefing({
    now: NOW,
    deps: {
      getWalletBalances: async () => ({ wallet: "W1", sol: 3, sol_price: 120 }),
      getPositions: async (w, statePos) => { seen.push(`wallet:${w}`, `state:${Object.keys(statePos).join(",")}`); return {
        positions: [
          { position: "OPEN1", pool: "P1", pair: "AAA-SOL", in_range: true, total_value_usd: 240, unclaimed_fees_usd: 12, pnl_pct: 9, pnl_sol: 0.2 },
          { position: "OPEN2", pool: "P2", pair: "B<B>-SOL", in_range: false, minutes_out_of_range: 14, total_value_usd: 120, unclaimed_fees_usd: 0, pnl_pct: -1.5, pnl_sol: -0.02 },
        ],
      }; },
      getOnchainPnl: async (p) => { seen.push(p.position); return p.position === "OPEN1" ? { pnlPct: 4.2, pnlSol: 0.084, valueSol: 2.0, feesSol: 0.1, depositSol: 2 } : null; },
      getLpOverview: async () => ({ total_pnl_sol: -0.057, total_fees_sol: 7.69, closed_positions: 107 }),
    },
  });
  assert.deepEqual(seen.sort(), ["OPEN1", "OPEN2", "state:B,E,OPEN1", "wallet:W1"]);
  assert.match(html, /Performance — last 24h \(bot records\)<\/b>\n {2}PnL: \+0\.2300 SOL\n/);
  assert.match(html, /Performance — all time \(bot records\)<\/b>\n {2}PnL: \+0\.2100 SOL \(API-based before Sep 26\)/);
  assert.match(html, /AVOID pools with vol &lt; 2/);
  assert.doesNotMatch(html, /- old/);
  assert.match(html, /Free SOL: 3\.0000 SOL/);
  assert.match(html, /AAA-SOL: 2\.1000 SOL \(in 2\.0000\) · \+4\.20% \/ \+0\.0840 SOL on-chain · in range/);
  assert.match(html, /B&lt;B&gt;-SOL: 1\.0000 SOL · −1\.50% \/ −0\.0200 SOL \(API\) · OOR 14m/);
  assert.match(html, /Total: 6\.1000 SOL \(free 3\.0000 \+ positions 3\.1000\)/);
  assert.match(html, /External — LP Agent wallet total \(all history\): PnL −0\.0570 SOL · fees 7\.6900 SOL · 107 closes/);
  assert.doesNotMatch(html, /Total PnL/);
});

test("generateBriefing: LP Agent line dropped and portfolio degrades when sources fail", async () => {
  const html = await b.generateBriefing({
    now: NOW,
    deps: {
      getWalletBalances: async () => { throw new Error("rpc down"); },
      getPositions: async () => ({ error: "rpc down", positions: [] }),
      getOnchainPnl: async () => null,
      getLpOverview: async () => null,
    },
  });
  assert.match(html, /Free SOL: unknown/);
  assert.match(html, /Open positions: unavailable \(rpc down\)/);
  assert.doesNotMatch(html, /LP Agent/);
});

// ─── Telegram /briefing ─────────────────────────────────────────
function makeUI({ stored = null, fresh = "<b>Fresh</b>\nPnL: +0.1 SOL" } = {}) {
  const sends = [];
  const calls = { generate: 0, record: [] };
  const deps = {
    tg: { sendHTML: async (text) => { sends.push(text); return { message_id: 1 }; }, editHTML: async () => true, answerCallback: async () => true },
    config: { management: { pnlUnit: "sol" }, screening: { source: "meteora" }, strategy: {}, usdc: {}, schedule: {} },
    latestBriefing: () => stored,
    generateBriefing: async () => { calls.generate++; return fresh; },
    recordBriefing: (html) => calls.record.push(html),
    now: () => 1_000_000,
  };
  return { u: ui.createTelegramUI(deps), sends, calls };
}

test("/briefing sends the latest stored briefing without generating one", async () => {
  const { u, sends, calls } = makeUI({ stored: { ts: "2026-09-26T01:00:03.000Z", text: "Morning Briefing\nPnL: +0.6 SOL <ok>" } });
  assert.equal(await u.handleMessage("/briefing", { chatId: "1" }), true);
  assert.equal(calls.generate, 0);
  assert.equal(sends.length, 1);
  assert.match(sends[0], /Latest briefing<\/b> \(sent 2026-09-26 01:00 UTC\)/);
  assert.match(sends[0], /PnL: \+0\.6 SOL &lt;ok&gt;/);
});

test("/briefing with nothing stored points at /briefing now", async () => {
  const { u, sends } = makeUI();
  assert.equal(await u.handleMessage("/briefing", { chatId: "1" }), true);
  assert.match(sends[0], /No briefing stored yet/);
});

test("/briefing now builds a fresh briefing, logs it, and never touches lastBriefingDate", async () => {
  fs.writeFileSync("state.json", JSON.stringify({ positions: {}, _lastBriefingDate: "2026-09-25" }));
  const { u, sends, calls } = makeUI();
  assert.equal(await u.handleMessage("/briefing now", { chatId: "1" }), true);
  assert.equal(calls.generate, 1);
  assert.deepEqual(calls.record, ["<b>Fresh</b>\nPnL: +0.1 SOL"]);
  assert.equal(sends.at(-1), "<b>Fresh</b>\nPnL: +0.1 SOL");
  assert.equal(JSON.parse(fs.readFileSync("state.json", "utf8"))._lastBriefingDate, "2026-09-25");
  assert.equal(await u.handleMessage("/briefing@MeridianBot NOW", { chatId: "1" }), true);
  assert.equal(calls.generate, 2);
  assert.equal(await u.handleMessage("/briefing later", { chatId: "1" }), true);
  assert.match(sends.at(-1), /Usage/);
  assert.equal(calls.generate, 2);
});

test("/briefing is in the bot command list", () => {
  assert.ok(ui.BOT_COMMANDS.some((c) => c.command === "briefing" && /now/.test(c.description)));
});

// ─── lessons.js reporting helpers ───────────────────────────────
test("getPerformanceSummary / getPerformanceHistory: win rate by classifyOutcome, excluded left out", () => {
  const recent = (h) => new Date(Date.now() - h * 3600_000).toISOString();
  const perf = [
    { position: "w1", pnl_pct: 3, pnl_usd: 3, range_efficiency: 50, recorded_at: recent(1) },
    { position: "w2", pnl_pct: 1.5, pnl_usd: 1, range_efficiency: 50, recorded_at: recent(2) },
    { position: "be", pnl_pct: 0.4, pnl_usd: 0.2, range_efficiency: 50, recorded_at: recent(3) }, // was a "win" under pnl > 0
    { position: "l1", pnl_pct: -4, pnl_usd: -4, range_efficiency: 50, recorded_at: recent(4) },
    { position: "x", pnl_pct: -70, pnl_usd: -70, range_efficiency: 50, exclude_from_learning: "junk", recorded_at: recent(5) },
  ];
  fs.writeFileSync("lessons.json", JSON.stringify({ performance: perf, lessons: [] }));
  const s = lessons.getPerformanceSummary();
  assert.deepEqual([s.wins, s.losses, s.breakeven, s.win_rate_pct], [2, 1, 1, 67]);
  const h = lessons.getPerformanceHistory({ hours: 24 });
  assert.deepEqual([h.wins, h.losses, h.breakeven, h.win_rate_pct], [2, 1, 1, 67]);
  assert.equal(h.count, 5);
});
