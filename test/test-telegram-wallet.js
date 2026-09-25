// Telegram 💰 Wallet "true total": wallet balances + DLMM positions. Read-only,
// everything mocked (no Helius, no RPC, no Telegram API).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

process.env.DRY_RUN = "true";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-wallet-"));
process.chdir(TMP);
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ui = await import("../telegram-ui.js");
const tg = await import("../telegram.js");
const OWNER = "111";
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const wallet = (over = {}) => ({
  wallet: "WalletAddr11111111111111111111111111111111",
  sol: 2, sol_price: 200, sol_usd: 400, usdc: 50, total_usd: 470,
  tokens: [
    { mint: SOL, symbol: "SOL", balance: 2, usd: 400 },
    { mint: USDC, symbol: "USDC", balance: 50, usd: 50 },
    { mint: "Bonk1111111111111111111111111111111111111111", symbol: "BONK", balance: 1_000_000, usd: 20 },
    { mint: "Dust1111111111111111111111111111111111111111", symbol: "DUST", balance: 3, usd: 0.05 },
    { mint: "Dust2111111111111111111111111111111111111111", symbol: "DUST2", balance: 3, usd: 0.04 },
    { mint: "NoPx1111111111111111111111111111111111111111", symbol: "NOPX", balance: 9, usd: null },
  ],
  ...over,
});

const positions = () => ({
  total_positions: 3,
  positions: [
    { position: "PosA", pair: "AAA-SOL", total_value_usd: 100, total_value_sol: 0.5, unclaimed_fees_usd: 2, sol_price: 200,
      composition: { sol_amount: 0.3, sol_usd: 60, token_amount: 1234, token_usd: 40 } },
    { position: "PosB", pair: "BBB-SOL", total_value_usd: 60, unclaimed_fees_usd: 0, sol_price: 200 }, // Meteora path: no composition
    { position: "PosC", pair: "CCC-SOL", total_value_usd: 0, total_value_sol: 0, unclaimed_fees_usd: 1.5, pnl_unknown: true }, // value unknown
  ],
});

function makeUI(over = {}) {
  const calls = [];
  const posCalls = [];
  const t = {
    sendHTML: async (text, extra = {}) => { calls.push({ m: "send", text, extra }); return { message_id: 900 }; },
    editHTML: async (messageId, text, extra = {}) => { calls.push({ m: "edit", messageId, text, extra }); return true; },
    answerCallback: async (cid, text) => { calls.push({ m: "answer", text }); return true; },
  };
  const u = ui.createTelegramUI({
    tg: t,
    config: { management: { gasReserve: 0.2, pnlUnit: "sol" }, usdc: { gasReserveSol: 0.05 } },
    usdcModeEnabled: () => false,
    getWalletBalances: async () => wallet(),
    getMyPositions: async (opts) => { posCalls.push(opts); return positions(); },
    ...over,
  });
  return { u, calls, posCalls };
}
const ctx = { chatId: OWNER, fromId: OWNER, messageId: 42, callbackId: "cq" };

test("totals add up: wallet (SOL + USDC + tokens > $0.10 + dust) + DLMM (value + unclaimed fees)", () => {
  const t = ui.computeWalletTotals(wallet(), positions());
  assert.equal(t.price, 200);
  // 400 SOL + 50 USDC + 20 BONK + 0.09 dust
  assert.equal(Math.round(t.walletUsd * 100) / 100, 470.09);
  assert.deepEqual(t.walletItems.map((x) => x.symbol), ["SOL", "USDC", "BONK"]);
  assert.equal(t.dustCount, 2);
  assert.equal(t.unpriced, 1);
  // PosA 100 + 2 fees, PosB 60, PosC unknown → excluded
  assert.equal(t.dlmmUsd, 162);
  assert.equal(t.unknownCount, 1);
  assert.equal(Math.round(t.totalUsd * 100) / 100, 632.09);
  // USD → SOL at the wallet's SOL price
  assert.equal(Math.round(t.totalSol * 10000) / 10000, 3.1604);
  assert.equal(t.dlmmSol, 0.81);
  const a = t.positions[0];
  assert.equal(a.tokenSide.sol, 0.2); // $40 / $200
  assert.equal(a.solSide.sol, 0.3);
});

test("render: total line, SOL price used, unknown position excluded with a note, never shown as 0", async () => {
  const { u, calls } = makeUI();
  await u.handleCallback("wa", ctx);
  const v = calls.at(-1);
  assert.equal(v.m, "edit", "edited in place");
  assert.match(v.text, /<b>Total: 3\.1604 SOL \(\$632\.09\)<\/b>/);
  assert.match(v.text, /= wallet \$470\.09 \+ DLMM \$162\.00 · SOL price used: \$200/);
  assert.match(v.text, /⚠️ 1 position with unknown value not included\./);
  assert.match(v.text, /CCC-SOL<\/b>: value unknown \(not counted\)/);
  assert.doesNotMatch(v.text, /CCC-SOL<\/b>: 0/);
  assert.match(v.text, /AAA-SOL<\/b>: 0\.51 SOL \(\$102\.00\) · SOL side 0\.3 SOL · token side 0\.2 SOL \(\$40\.00\) · fees 0\.01 SOL \(\$2\.00\)/);
  assert.match(v.text, /BBB-SOL<\/b>: 0\.3 SOL \(\$60\.00\) · fees/);
  assert.match(v.text, /SOL: <b>2<\/b> \(\$400\.00\)/);
  assert.match(v.text, /USDC: <b>\$50<\/b>/);
  assert.match(v.text, /BONK: 1,000,000 \(\$20\.00\)/);
  assert.match(v.text, /\+ 2 balances under \$0\.10 \(\$0\.09\)/);
  assert.match(v.text, /Excludes position rent \(refunded on close\)/);
  const data = v.extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data).filter(Boolean);
  assert.ok(data.includes("wa:r"), "Refresh button");
});

test("refresh forces a fresh position scan; first open uses the cache", async () => {
  const { u, posCalls } = makeUI();
  await u.handleCallback("wa", ctx);
  await u.handleCallback("wa:r", ctx);
  assert.deepEqual(posCalls, [{}, { force: true }]);
});

test("positions failing or SOL price unknown: wallet still renders with a clear note", async () => {
  const { u, calls } = makeUI({ getMyPositions: async () => { throw new Error("rpc down"); } });
  await u.handleCallback("wa", ctx);
  assert.match(calls.at(-1).text, /DLMM positions not included: rpc down/);
  assert.match(calls.at(-1).text, /Total: \d/);
  const t = ui.computeWalletTotals(wallet({ sol_price: 0, sol_usd: 0 }), { positions: [] });
  assert.equal(t.price, null);
  assert.equal(t.totalSol, null);
  const r = ui.renderWallet(wallet({ sol_price: 0, sol_usd: 0 }), { config: { management: {} }, positions: { positions: [] } });
  assert.match(r.text, /SOL price unknown/);
});

test("message stays under 4096 chars with many tokens and positions", () => {
  const many = wallet({ tokens: Array.from({ length: 200 }, (_, i) => ({ mint: `M${i}`.padEnd(44, "x"), symbol: `TOKEN_WITH_LONG_NAME_${i}`, balance: 123456789, usd: 5 + i })) });
  const pos = { positions: Array.from({ length: 80 }, (_, i) => ({ position: `P${i}`, pair: `<b>PAIR&${i}</b>-SOL-LONG-NAME`, total_value_usd: 10 + i, unclaimed_fees_usd: 1, composition: { sol_amount: 1, sol_usd: 200, token_amount: 5, token_usd: 3 } })) };
  const r = ui.renderWallet(many, { config: { management: { gasReserve: 0.2 } }, positions: pos });
  assert.ok(r.text.length < 4096, String(r.text.length));
  assert.match(r.text, /^💰/);
  assert.match(r.text, /<b>Total: /, "the total survives");
  assert.match(r.text, /\+ \d+ more tokens/);
  assert.match(r.text, /\+ 65 more positions/);
  assert.doesNotMatch(r.text, /<b>PAIR/, "pair names are escaped");
});

test("owner-only: a stranger's wallet tap never reaches the UI", async () => {
  const apiCalls = [];
  tg.__setTelegramTestHooks({ token: "TEST", owner: OWNER, allowlist: "", fetch: async (url) => { apiCalls.push(String(url)); return { ok: true, json: async () => ({ ok: true, result: {} }) }; } });
  let reads = 0;
  const { u } = makeUI({ getWalletBalances: async () => { reads++; return wallet(); } });
  const upd = { update_id: 1, callback_query: { id: "x", data: "wa:r", from: { id: 999 }, message: { message_id: 9, chat: { id: 999, type: "private" } } } };
  assert.equal((await tg.processUpdate(upd, { onCallback: (d, c) => u.handleCallback(d, c) })).handled, false);
  assert.equal(reads, 0);
  assert.equal(apiCalls.length, 0);
});
