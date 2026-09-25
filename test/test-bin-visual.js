// Bin charts (tools/bin-visual.js) and their Telegram wiring. Fixture:
// test/fixtures/bins.json, two live positions fetched read-only (NPC-SOL,
// BRAIN-SOL). Everything is mocked: no RPC, no Telegram API, no transaction.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

process.env.DRY_RUN = "true";
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const FIXTURE = JSON.parse(fs.readFileSync(new URL("./fixtures/bins.json", import.meta.url), "utf8"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-bins-"));
process.chdir(TMP);
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const bv = await import("../tools/bin-visual.js");
const ui = await import("../telegram-ui.js");

const [NPC, BRAIN] = FIXTURE;
const clone = (p, over = {}) => ({ ...structuredClone(p), ...over });
const Y = "🟦", X = "🟪", E = "⬛";
const cellsOf = (line) => [...line].filter((c) => c === Y || c === X || c === E);
const stripLine = (html) => html.split("\n")[0];

// ─── fmtPx ───────────────────────────────────────────────────────
test("fmtPx: Meteora subscript-zero format, 3 digits", () => {
  assert.equal(bv.fmtPx(0.000015009985), "0.0₄150");
  assert.equal(bv.fmtPx(0.0000085125947), "0.0₅851");
  assert.equal(bv.fmtPx(0.00001), "0.0₄100");
  assert.equal(bv.fmtPx(0.0000189999), "0.0₄189", "truncates like the mock");
  assert.equal(bv.fmtPx(1.2e-12), "0.0₁₁120", "multi-digit subscripts");
  assert.equal(bv.fmtPx(0.005), "0.0₂500");
  assert.equal(bv.fmtPx(0.0123), "0.0123");
  assert.equal(bv.fmtPx(1.5), "1.50");
  assert.equal(bv.fmtPx(150.23), "150");
  assert.equal(bv.fmtPx(12345.6), "12346");
  for (const bad of [0, -1, NaN, null, undefined, "x"]) assert.equal(bv.fmtPx(bad), "?");
});

// ─── bucketing ───────────────────────────────────────────────────
test("bucketBins: 16 columns that conserve the position's SOL value", () => {
  const b = bv.bucketBins(NPC, 16);
  assert.equal(b.cols.length, 16);
  assert.equal(b.ncols, 16);
  const total = b.cols.reduce((a, c) => a + c.v, 0);
  assert.ok(Math.abs(total - bv.binSplit(NPC).totalSol) < 1e-12, "no bin dropped or double counted");
  // NPC is bid-ask below the price: the low columns are all SOL, the high ones all token.
  assert.ok(b.cols[0].y > 0 && b.cols[0].x === 0);
  assert.ok(b.cols[15].x > 0 && b.cols[15].y === 0);
});

test("bucketBins: fewer bins than columns never repeats a bin", () => {
  const p = clone(NPC);
  p.bins = p.bins.slice(0, 5);
  p.upper = p.bins[4].id;
  p.activeBin = p.bins[2].id;
  const b = bv.bucketBins(p, 16);
  assert.equal(b.cols.length, 5);
  assert.equal(cellsOf(stripLine(bv.renderBinStrip(p))).length, 5);
});

test("bucketBins: empty position → no columns, renderers return null", () => {
  const p = clone(NPC, { bins: [] });
  assert.equal(bv.bucketBins(p).cols.length, 0);
  assert.equal(bv.renderBinStrip(p), null);
  assert.equal(bv.renderBinChart(p), null);
  assert.equal(bv.renderBinStrip(null), null);
});

// ─── marker placement ────────────────────────────────────────────
test("in range: one │ between columns, at the active bin, matching the approved mock", () => {
  const strip = bv.renderBinStrip(NPC);
  assert.equal(stripLine(strip), "🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦│🟪🟪🟪🟪🟪");
  assert.equal(stripLine(bv.renderBinStrip(BRAIN)), "🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟪│🟪");
  assert.ok(!strip.includes("◀") && !strip.includes("▶"));
  assert.equal(bv.bucketBins(NPC).linePos, 11);
});

test("in range tall chart: the │ runs through every row; token stacks under SOL", () => {
  const chart = bv.renderBinChart(NPC);
  const lines = chart.split("\n");
  assert.equal(lines[0], "<b>NPC-SOL</b> · 82 bins");
  const rows = lines.slice(1, 5);
  assert.deepEqual(rows, [
    "🟦🟦⬛⬛⬛⬛⬛⬛⬛⬛⬛│⬛⬛⬛⬛⬛",
    "🟦🟦🟦🟦🟦🟦🟦🟦⬛⬛⬛│⬛⬛⬛⬛⬛",
    "🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦⬛│⬛⬛⬛⬛⬛",
    "🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦│🟪🟪🟪🟪🟪",
  ]);
  for (const r of rows) assert.equal([...r].indexOf("│"), 11, "same column in every row");
  assert.equal(bv.renderBinChart(NPC, { header: false }).split("\n").length, 6);
});

test("a mixed column shows 🟪 under 🟦", () => {
  const p = clone(NPC);
  // One bin, half token / half SOL by value.
  p.bins = [{ id: 0, price: 1, px: String(1e6), py: String(1e9) }];
  p.decX = 6; p.lower = 0; p.upper = 0; p.activeBin = 0; p.activePrice = 1;
  const rows = bv.renderBinChart(p, { header: false, cols: 1 }).split("\n").slice(0, 4);
  assert.deepEqual(rows.map((r) => cellsOf(r)[0]), [Y, Y, X, X], "top → bottom");
});

test("below range: ◀ at the left edge, no │, OOR ↓ count", () => {
  const p = clone(NPC, { activeBin: NPC.lower - 12 });
  const strip = bv.renderBinStrip(p);
  assert.ok(stripLine(strip).startsWith("◀"));
  assert.ok(!strip.includes("│") && !strip.includes("▶"));
  assert.match(strip, /OOR ↓ 12 bins/);
  for (const r of bv.renderBinChart(p, { header: false }).split("\n").slice(0, 4)) assert.ok(r.startsWith("◀"));
});

test("above range: ▶ at the right edge, no │, OOR ↑ count", () => {
  const p = clone(NPC, { activeBin: NPC.upper + 9 });
  const strip = bv.renderBinStrip(p);
  assert.ok(stripLine(strip).endsWith("▶"));
  assert.ok(!strip.includes("│") && !strip.includes("◀"));
  assert.match(strip, /OOR ↑ 9 bins/);
  for (const r of bv.renderBinChart(p, { header: false }).split("\n").slice(0, 4)) assert.ok(r.endsWith("▶"));
});

test("range edges: price at the lowest / highest bin puts │ at the edge", () => {
  assert.equal(bv.bucketBins(clone(NPC, { activeBin: NPC.lower })).linePos, 0);
  assert.equal(bv.bucketBins(clone(NPC, { activeBin: NPC.upper })).linePos, 16);
});

// ─── split % and info lines ──────────────────────────────────────
test("split %: SOL / token value shares and bins either side of the price", () => {
  assert.deepEqual(
    (({ solPct, tokPct, where }) => ({ solPct, tokPct, where }))(bv.binSplit(NPC)),
    { solPct: 91, tokPct: 9, where: "57↓ 24↑ bins" },
  );
  const b = bv.binSplit(BRAIN);
  assert.equal(b.solPct, 99);
  assert.equal(b.tokPct, 1);
  assert.equal(b.where, "67↓ 7↑ bins");
  const strip = bv.renderBinStrip(NPC).split("\n");
  assert.equal(strip[1], "<code>min 0.0₅851 · now 0.0₄150 · max 0.0₄190</code>");
  assert.equal(strip[2], "🟦 SOL 91% · 🟪 NPC 9% · 57↓ 24↑ bins");
});

test("pair names are HTML-escaped", () => {
  const strip = bv.renderBinStrip(clone(NPC, { name: "<b>X&Y</b>-SOL" }));
  assert.ok(strip.includes("&lt;b&gt;X&amp;Y&lt;/b&gt;"));
  assert.ok(!strip.includes("<b>X"));
});

// ─── one-line strip ──────────────────────────────────────────────
test("strip: exactly 3 lines, emoji row on one line, never inside <pre>", () => {
  for (const p of [NPC, BRAIN, clone(NPC, { activeBin: NPC.lower - 3 }), clone(NPC, { activeBin: NPC.upper + 3 })]) {
    const s = bv.renderBinStrip(p);
    const lines = s.split("\n");
    assert.equal(lines.length, 3);
    assert.equal(cellsOf(lines[0]).length, 16);
    assert.ok(!s.includes("<pre>"));
    assert.equal([...lines[0]].length, 17, "16 emoji + one marker");
  }
  const chart = bv.renderBinChart(NPC);
  assert.ok(!chart.includes("<pre>"));
  assert.ok(chart.length < 400, "4×16 chart stays small");
});

// ─── fetch + cache + failure fallback ────────────────────────────
function fakePool({ fail = false, calls } = {}) {
  return {
    lbPair: { binStep: NPC.binStep },
    tokenX: { mint: { decimals: NPC.decX } },
    tokenY: { mint: { decimals: 9 } },
    getPosition: async () => {
      calls.n++;
      if (fail) throw new Error("rpc down");
      return {
        positionData: {
          lowerBinId: NPC.lower,
          upperBinId: NPC.upper,
          positionBinData: NPC.bins.map((b) => ({ binId: b.id, pricePerToken: String(b.price), positionXAmount: b.px, positionYAmount: b.py })),
        },
      };
    },
    getActiveBin: async () => ({ binId: NPC.activeBin, pricePerToken: String(NPC.activePrice) }),
  };
}
const POS = { position: NPC.position, pool: NPC.pool, pair: "NPC-SOL", active_bin: -1 };

test("getPositionBins: normalizes SDK output and caches ~60s per position", async () => {
  let clock = 0;
  const calls = { n: 0 };
  bv._setBinVisualDepsForTest({ getPool: async () => fakePool({ calls }), PublicKey: class { constructor(s) { this.s = s; } }, now: () => clock });
  const d = await bv.getPositionBins(POS);
  assert.equal(d.activeBin, NPC.activeBin, "fresh getActiveBin wins over the list's active_bin");
  assert.equal(d.bins.length, 82);
  assert.equal(stripLine(bv.renderBinStrip(d)), stripLine(bv.renderBinStrip(NPC)));
  await bv.getPositionBins(POS);
  assert.equal(calls.n, 1, "cached");
  clock += 61_000;
  await bv.getPositionBins(POS);
  assert.equal(calls.n, 2, "expired after 60s");
  await bv.getPositionBins(POS, { force: true });
  assert.equal(calls.n, 3, "force skips the cache");
  bv._setBinVisualDepsForTest(null);
});

test("getPositionBins: any fetch failure → null, never a throw", async () => {
  const calls = { n: 0 };
  const PublicKey = class {};
  bv._setBinVisualDepsForTest({ getPool: async () => fakePool({ fail: true, calls }), PublicKey });
  assert.equal(await bv.getPositionBins(POS), null);
  bv._setBinVisualDepsForTest({ getPool: async () => { throw new Error("pool load failed"); }, PublicKey });
  assert.equal(await bv.getPositionBins(POS), null);
  assert.equal(await bv.getPositionBins(null), null);
  assert.equal(await bv.getPositionBins({ position: "x" }), null, "no pool → null");
  bv._setBinVisualDepsForTest(null);
});

test("withTimeout: resolves to the fallback on timeout or rejection", async () => {
  assert.equal(await bv.withTimeout(new Promise(() => {}), 10), null);
  assert.equal(await bv.withTimeout(Promise.reject(new Error("x")), 1000), null);
  assert.equal(await bv.withTimeout(Promise.resolve(7), 1000), 7);
  assert.equal(await bv.withTimeout(null, 1000), null);
});

// ─── Telegram wiring ─────────────────────────────────────────────
function makeUI(over = {}) {
  const calls = [];
  const tg = {
    sendHTML: async (text, extra = {}) => { calls.push({ m: "send", text, extra }); return { message_id: 900 }; },
    editHTML: async (messageId, text, extra = {}) => { calls.push({ m: "edit", messageId, text, extra }); return true; },
    answerCallback: async (cid, text, alert) => { calls.push({ m: "answer", text, alert }); return true; },
  };
  const positions = {
    positions: [
      { position: NPC.position, pool: NPC.pool, pair: "NPC-SOL", in_range: true, pnl_pct: 1, pnl_sol: 0.01, total_value_sol: 1, unclaimed_fees_sol: 0, age_minutes: 5, active_bin: NPC.activeBin },
      { position: BRAIN.position, pool: BRAIN.pool, pair: "BRAIN-SOL", in_range: true, pnl_pct: 1, pnl_sol: 0.01, total_value_sol: 1, unclaimed_fees_sol: 0, age_minutes: 5, active_bin: BRAIN.activeBin },
    ],
  };
  const deps = {
    tg,
    config: { management: { pnlUnit: "sol" }, screening: { source: "meteora" }, strategy: {}, usdc: {} },
    getMyPositions: async () => positions,
    getPositionBins: async (p) => FIXTURE.find((f) => f.position === p.position) ?? null,
    binsStripTimeoutMs: 50,
    binsViewTimeoutMs: 50,
    ...over,
  };
  return { u: ui.createTelegramUI(deps), calls };
}
const ctx = (messageId = 42) => ({ chatId: "1", fromId: "1", messageId, callbackId: "c" });
const markup = (call) => call.extra?.reply_markup?.inline_keyboard || [];
const datas = (call) => markup(call).flat().filter((b) => b.callback_data).map((b) => b.callback_data);

test("Positions list: each block gets its strip; 📊 Bins buttons fit in 64 bytes", async () => {
  const { u, calls } = makeUI();
  await u.handleCallback("po:0", ctx());
  const view = calls.filter((c) => c.m === "edit").at(-1);
  assert.ok(view.text.includes(stripLine(bv.renderBinStrip(NPC))));
  assert.ok(view.text.includes(stripLine(bv.renderBinStrip(BRAIN))));
  assert.ok(view.text.length <= ui.PAGE_CHAR_BUDGET);
  const bvs = datas(view).filter((d) => d.startsWith("bv:"));
  assert.equal(bvs.length, 2);
  for (const d of datas(view)) assert.ok(Buffer.byteLength(d) <= 64);
});

test("Positions list: a failing or hanging bin fetch drops only the strip", async () => {
  const { u, calls } = makeUI({
    getPositionBins: async (p) => (p.pair === "NPC-SOL" ? new Promise(() => {}) : Promise.reject(new Error("rpc"))),
  });
  await u.handleCallback("po:0", ctx());
  const view = calls.filter((c) => c.m === "edit").at(-1);
  assert.match(view.text, /NPC-SOL/);
  assert.match(view.text, /BRAIN-SOL/);
  assert.ok(!view.text.includes("🟦"), "no strips");
  const { u: u2, calls: c2 } = makeUI({ getPositionBins: undefined });
  await u2.handleCallback("po:0", ctx());
  const v2 = c2.filter((c) => c.m === "edit").at(-1);
  assert.ok(!datas(v2).some((d) => d.startsWith("bv:")), "no Bins button without the dep");
});

test("📊 Bins: opens the 4-row chart; Refresh edits in place and forces a fetch; Back returns", async () => {
  const forced = [];
  const { u, calls } = makeUI({
    getPositionBins: async (p, o = {}) => { forced.push(!!o.force); return FIXTURE.find((f) => f.position === p.position); },
  });
  await u.handleCallback("po:0", ctx(7));
  const open = datas(calls.filter((c) => c.m === "edit").at(-1)).find((d) => d.startsWith("bv:"));
  await u.handleCallback(open, ctx(7));
  const view = calls.filter((c) => c.m === "edit").at(-1);
  assert.equal(view.messageId, 7);
  assert.match(view.text, /📊 <b>Bins<\/b> · NPC-SOL/);
  assert.ok(view.text.includes("🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦│🟪🟪🟪🟪🟪"));
  assert.equal(view.text.split("\n").filter((l) => l.includes("│")).length, 4);
  const refresh = datas(view).find((d) => d.endsWith(":r"));
  assert.ok(datas(view).includes("po:0"), "Back → Positions");
  forced.length = 0;
  await u.handleCallback(refresh, ctx(7));
  assert.deepEqual(forced, [true]);
  assert.equal(calls.filter((c) => c.m === "edit").at(-1).messageId, 7, "edited in place");
  for (const d of datas(view)) assert.ok(Buffer.byteLength(d) <= 64);
});

test("📊 Bins: fetch failure shows a notice, not an error", async () => {
  const { u, calls } = makeUI();
  await u.handleCallback("po:0", ctx(8));
  const open = datas(calls.filter((c) => c.m === "edit").at(-1)).find((d) => d.startsWith("bv:"));
  const { u: u2, calls: c2 } = makeUI({ getPositionBins: async () => { throw new Error("rpc down"); } });
  // Refs are per-UI instance: reopen in the failing one.
  await u2.handleCallback("po:0", ctx(8));
  const open2 = datas(c2.filter((c) => c.m === "edit").at(-1)).find((d) => d.startsWith("bv:"));
  assert.ok(open && open2);
  await u2.handleCallback(open2, ctx(8));
  const view = c2.filter((c) => c.m === "edit").at(-1);
  assert.match(view.text, /Could not load the bin chart/);
  assert.ok(!c2.some((c) => c.m === "answer" && c.alert), "no error popup");
});

test("close alerts: chart appended when the pre-close snapshot exists; still sent without it", async () => {
  const { u, calls } = makeUI();
  await u.alerts.close({ pair: "NPC-SOL", position: NPC.position, pnlPct: 1.5, pnlSol: 0.01, txs: ["5".repeat(88)], bins: NPC });
  const withChart = calls.filter((c) => c.m === "send").at(-1).text;
  assert.match(withChart, /Closed<\/b> NPC-SOL/);
  assert.ok(withChart.includes("🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦│🟪🟪🟪🟪🟪"));
  await u.alerts.pnl_watcher_close({ pair: "BRAIN-SOL", position: BRAIN.position, reason: "stop loss", pnlPct: -5, bins: BRAIN });
  assert.ok(calls.filter((c) => c.m === "send").at(-1).text.includes("│"));
  await u.alerts.close({ pair: "X-SOL", position: "P2", pnlPct: 1, bins: null });
  const plain = calls.filter((c) => c.m === "send").at(-1).text;
  assert.match(plain, /Closed<\/b> X-SOL/);
  assert.ok(!plain.includes("🟦"));
  await u.alerts.close({ pair: "Y-SOL", position: "P3", pnlPct: 1, bins: { junk: true } });
  assert.match(calls.filter((c) => c.m === "send").at(-1).text, /Closed<\/b> Y-SOL/, "bad snapshot never blocks the alert");
});

test("out-of-range alert is unchanged (no chart)", async () => {
  const { u, calls } = makeUI();
  await u.alerts.out_of_range({ pair: "NPC-SOL", minutesOOR: 12 });
  const text = calls.filter((c) => c.m === "send").at(-1).text;
  assert.equal(text, "⚠️ <b>Out of range</b> NPC-SOL for 12 min");
});
