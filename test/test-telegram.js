// Telegram menu UI + owner-only transport. Everything is mocked: no Telegram API
// call, no RPC, no LLM, no transaction. Runs in a temp cwd so state.json and
// logs/ written by the modules under test never touch the repo.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";

process.env.DRY_RUN = "true";
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
delete process.env.TELEGRAM_ALLOWLIST;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-tg-"));
process.chdir(TMP);
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const tg = await import("../telegram.js");
const ui = await import("../telegram-ui.js");
const stateMod = await import("../state.js");
const { screeningCronGate } = await import("../runtime-helpers.js");

const OWNER = "111";
const POS_A = "PosAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const POS_B = "PosBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";
const POOL_A = "PoolAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";

// ─── Mocks ───────────────────────────────────────────────────────
function mockTransport() {
  let id = 500;
  const calls = [];
  return {
    calls,
    sends: () => calls.filter((c) => c.m === "send"),
    edits: () => calls.filter((c) => c.m === "edit"),
    answers: () => calls.filter((c) => c.m === "answer"),
    sendHTML: async (text, extra = {}) => { calls.push({ m: "send", text, extra }); return { message_id: ++id, chat: { id: Number(OWNER) } }; },
    editHTML: async (messageId, text, extra = {}) => { calls.push({ m: "edit", messageId, text, extra }); return true; },
    answerCallback: async (cid, text, alert) => { calls.push({ m: "answer", cid, text, alert }); return true; },
  };
}

function baseConfig(over = {}) {
  return {
    management: { pnlUnit: "sol", gasReserve: 0.2, deployAmountSol: 0.5 },
    risk: { maxDeployAmount: 5 },
    screening: { source: "both" },
    strategy: { activeStrategy: "evil_panda", strategy: "spot", evilPanda: { priceRangePct: 80 } },
    usdc: { enabled: false, deployAmountUsd: 50, gasReserveSol: 0.05 },
    schedule: { managementIntervalMin: 10, screeningIntervalMin: 30, pnlWatcherIntervalSec: 30 },
    ...over,
  };
}

const positions = () => ({
  total_positions: 2,
  positions: [
    { position: POS_A, pool: POOL_A, pair: "BONK-SOL", in_range: true, pnl_pct: 3.21, pnl_sol: 0.0123, pnl_usd: 2.1, total_value_sol: 1.5, total_value_usd: 250, unclaimed_fees_sol: 0.01, unclaimed_fees_usd: 1.7, age_minutes: 135 },
    { position: POS_B, pool: "PoolB", pair: "<b>EVIL&CO</b>", in_range: false, oor_direction: "below", minutes_out_of_range: 12, pnl_pct: null, pnl_sol: null, pnl_usd: null, pnl_unknown: true, total_value_sol: 0.4, unclaimed_fees_sol: 0, age_minutes: 20 },
  ],
});

const candidates = () => ({
  total_eligible: 3,
  total_screened: 40,
  candidates: [
    { pool: "CandPool1111111111111111111111111111111111111", name: "AAA-SOL", bin_step: 100, volatility: 3.2, fee_active_tvl_ratio: 1.2, volume: 120000, organic_score: 80, darwin_score: 71, sources: ["meteora", "gmgn"], confirmed_by_both: true, base_mint: "MintA" },
    { pool: "CandPool2222222222222222222222222222222222222", name: "BBB-SOL", bin_step: 80, volatility: 9, fee_active_tvl_ratio: 0.8, volume: 50000, organic_score: 75, darwin_score: 60, sources: ["gmgn"], base_mint: "MintB" },
    { pool: "CandPool3333333333333333333333333333333333333", name: "CCC-SOL", bin_step: 125, volatility: 1, fee_active_tvl_ratio: 0.3, volume: 900, organic_score: 70, sources: ["meteora"] },
  ],
});

function makeUI(over = {}) {
  const t = mockTransport();
  let clock = 1_000_000;
  let paused = false;
  const exec = [];
  const deps = {
    tg: t,
    config: baseConfig(),
    computeDeployAmount: (sol) => Math.round((sol - 0.2) * 0.35 * 100) / 100,
    usdcModeEnabled: () => false,
    getMyPositions: async () => positions(),
    getWalletBalances: async () => ({ wallet: "WalletAddr11111111111111111111111111111111", sol: 4.2, sol_usd: 700, sol_price: 166, usdc: 12.5, total_usd: 712.5 }),
    getTopCandidates: async () => candidates(),
    executeTool: async (name, args) => { exec.push({ name, args }); return { success: true, position: args.position_address ?? "NewPos", txs: ["5".repeat(88)] }; },
    runExclusive: async (fn) => ({ busy: false, value: await fn() }),
    autoDeploy: async () => { exec.push({ name: "auto" }); return "deployed into AAA"; },
    afterDeploy: () => { exec.push({ name: "afterDeploy" }); },
    runScreeningNow: () => { exec.push({ name: "screen" }); return { started: true, done: Promise.resolve("report") }; },
    isScreeningPaused: () => paused,
    setScreeningPaused: (v) => { paused = v; },
    getStatusInfo: () => ({ activeStrategy: "evil_panda", managementModel: "m1", screeningModel: "s1", managementIntervalMin: 10, screeningIntervalMin: 30, nextManagement: "3m", nextScreening: "20m", cronStarted: true }),
    buildSettingsReport: () => "setting = value\n".repeat(10),
    handleAutoresearchCommand: (a) => (a === "status" ? "Autoresearch: enabled\nPending proposal: exp1 (range) Δ 2 pp\n\n/autoresearch help" : `ran ${a}`),
    readRecentErrors: () => ({ file: "x.log", lines: ["[t] [CRON_ERROR] boom <x>"] }),
    now: () => clock,
    ...over,
  };
  const u = ui.createTelegramUI(deps);
  return { u, t, exec, deps, advance: (ms) => { clock += ms; }, isPaused: () => paused };
}

const allCallbackData = (keyboard) => keyboard.flat().filter((b) => b.callback_data).map((b) => b.callback_data);
const lastMarkup = (call) => call.extra?.reply_markup?.inline_keyboard || [];
const findData = (keyboard, prefix) => allCallbackData(keyboard).find((d) => d.startsWith(prefix));
const ctxFor = (messageId, extra = {}) => ({ chatId: OWNER, fromId: OWNER, messageId, callbackId: `cb${messageId}`, ...extra });

// ─── Transport: owner-only enforcement ───────────────────────────
function mockFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  fn.calls = calls;
  return fn;
}

const msgUpdate = (chatId, fromId, text, type = "private", isBot = false) => ({
  update_id: 1,
  message: { message_id: 7, text, chat: { id: Number(chatId), type }, from: { id: Number(fromId), is_bot: isBot } },
});
const cbUpdate = (chatId, fromId, data) => ({
  update_id: 2,
  callback_query: { id: "cq1", data, from: { id: Number(fromId) }, message: { message_id: 9, chat: { id: Number(chatId), type: "private" } } },
});

test("owner-only: messages from other chats and senders are dropped without a reply", async () => {
  const f = mockFetch();
  tg.__setTelegramTestHooks({ token: "TEST", fetch: f, owner: OWNER, allowlist: "", saveOwner: () => { throw new Error("must not register"); } });
  const seen = [];
  const h = { onMessage: async (t) => seen.push(t), onCallback: async (d) => seen.push(d) };

  assert.equal((await tg.processUpdate(msgUpdate("222", "222", "/status"), h)).handled, false);
  assert.equal((await tg.processUpdate(msgUpdate(OWNER, "999", "/status", "group"), h)).handled, false, "right chat, wrong sender");
  assert.equal((await tg.processUpdate(msgUpdate(OWNER, OWNER, "/status", "private", true), h)).handled, false, "bots are refused");
  assert.deepEqual(seen, []);
  assert.equal(f.calls.length, 0, "no API call — nothing is answered to strangers");

  assert.equal((await tg.processUpdate(msgUpdate(OWNER, OWNER, "/status"), h)).handled, true);
  assert.deepEqual(seen, ["/status"]);

  tg.__setTelegramTestHooks({ allowlist: "999" });
  assert.equal((await tg.processUpdate(msgUpdate(OWNER, "999", "/menu", "group"), h)).handled, true, "TELEGRAM_ALLOWLIST sender in the owner chat");
  tg.__setTelegramTestHooks({ allowlist: "" });
});

test("owner-only: callbacks validate chat id AND from.id; strangers get no answerCallbackQuery", async () => {
  const f = mockFetch();
  tg.__setTelegramTestHooks({ token: "TEST", fetch: f, owner: OWNER });
  const seen = [];
  const h = { onCallback: async (d, ctx) => seen.push([d, ctx]) };
  assert.equal((await tg.processUpdate(cbUpdate("222", "222", "y:abc"), h)).handled, false);
  assert.equal((await tg.processUpdate(cbUpdate(OWNER, "333", "y:abc"), h)).handled, false);
  assert.equal(f.calls.length, 0);
  assert.equal(seen.length, 0);
  assert.equal((await tg.processUpdate(cbUpdate(OWNER, OWNER, "st"), h)).handled, true);
  assert.equal(seen[0][0], "st");
  assert.equal(seen[0][1].messageId, 9);
  assert.equal(seen[0][1].callbackId, "cq1");
});

test("no owner configured: one-time registration of the first private chat only", async () => {
  const f = mockFetch();
  const saved = [];
  tg.__setTelegramTestHooks({ token: "TEST", fetch: f, owner: null, saveOwner: (id) => saved.push(id) });
  const seen = [];
  const h = { onMessage: async (t) => seen.push(t), onCallback: async (d) => seen.push(d) };

  assert.equal((await tg.processUpdate(cbUpdate("444", "444", "st"), h)).handled, false, "callbacks never register");
  assert.equal((await tg.processUpdate(msgUpdate("-100", "444", "hi", "group"), h)).handled, false, "groups never register");
  assert.equal(saved.length, 0);

  assert.equal((await tg.processUpdate(msgUpdate("444", "444", "/start"), h)).handled, true);
  assert.deepEqual(saved, ["444"]);
  assert.equal(tg.getOwnerChatId(), "444");
  assert.equal((await tg.processUpdate(msgUpdate("555", "555", "/start"), h)).handled, false, "second chat is refused");
  assert.deepEqual(saved, ["444"]);
  assert.deepEqual(seen, ["/start"]);
  tg.__setTelegramTestHooks({ owner: OWNER, saveOwner: () => {} });
});

test("transport sends HTML to the owner chat and clips to 4096 chars", async () => {
  const f = mockFetch();
  tg.__setTelegramTestHooks({ token: "TEST", fetch: f, owner: OWNER });
  await tg.sendHTML("x".repeat(10_000));
  await tg.editHTML(5, "<b>hi</b>");
  assert.equal(f.calls[0].body.chat_id, OWNER);
  assert.equal(f.calls[0].body.parse_mode, "HTML");
  assert.ok(f.calls[0].body.text.length <= 4096);
  assert.match(f.calls[1].url, /editMessageText$/);
  assert.equal(f.calls[1].body.message_id, 5);
  const ok = await tg.setMyCommands(ui.BOT_COMMANDS);
  assert.equal(ok, true);
  assert.match(f.calls[2].url, /setMyCommands$/);
});

// ─── Menu navigation ─────────────────────────────────────────────
test("menu: /menu sends the main menu; buttons edit the same message in place", async () => {
  const { u, t } = makeUI();
  assert.equal(await u.handleMessage("/menu", { chatId: OWNER }), true);
  const menu = t.sends().at(-1);
  const data = allCallbackData(lastMarkup(menu));
  for (const d of ["st", "po:0", "ca:0", "wa", "se:0", "bc"]) assert.ok(data.includes(d), `menu has ${d}`);

  assert.equal(await u.handleMessage(ui.MENU_BUTTON_TEXT, { chatId: OWNER }), true, "reply-keyboard Menu button");
  const before = t.sends().length;
  for (const d of ["st", "po:0", "wa", "ca:0", "se:0", "bc", "ar", "er", "m"]) {
    await u.handleCallback(d, ctxFor(42));
  }
  assert.equal(t.sends().length, before, "navigation never sends new messages");
  assert.ok(t.edits().every((e) => e.messageId === 42));
  assert.equal(t.answers().length, 9, "every callback is answered exactly once");

  const status = t.edits()[0].text;
  assert.match(status, /Mode: <b>DRY RUN<\/b>/);
  assert.match(status, /Strategy: evil_panda/);
  const posView = t.edits()[1];
  assert.match(posView.text, /PnL: unknown/);
  assert.match(posView.text, /\+0\.0123 SOL \(\+3\.21%\)/);
  assert.match(posView.text, /&lt;b&gt;EVIL&amp;CO&lt;\/b&gt;/, "pair names are escaped");
  const urls = lastMarkup(posView).flat().filter((b) => b.url).map((b) => b.url);
  assert.ok(urls.includes(`https://app.meteora.ag/dlmm/${POOL_A}`));
  assert.ok(urls.includes(`https://solscan.io/account/${POS_A}`));
  const wallet = t.edits()[2].text;
  assert.match(wallet, /SOL: <b>4\.2<\/b>/);
  assert.match(wallet, /USDC: <b>\$12\.5<\/b>/);
  assert.match(wallet, /Gas reserve: 0\.2 SOL/);
  const cands = t.edits()[3].text;
  assert.match(cands, /AAA-SOL<\/b> \[both\]/);
  assert.match(cands, /BBB-SOL<\/b> \[gmgn\]/);
  assert.match(cands, /CCC-SOL<\/b> \[meteora\]/);
  assert.ok(findData(lastMarkup(t.edits()[3]), "cs"), "Screen now button");
});

test("menu: /start installs the persistent reply keyboard", async () => {
  const { u, t } = makeUI();
  await u.handleMessage("/start", { chatId: OWNER });
  const kb = t.sends()[0].extra.reply_markup;
  assert.equal(kb.keyboard[0][0].text, ui.MENU_BUTTON_TEXT);
  assert.equal(kb.is_persistent, true);
  assert.ok(t.sends()[1].extra.reply_markup.inline_keyboard.length > 0);
});

// ─── Close confirmation ──────────────────────────────────────────
async function openCloseCard(u, t, messageId = 42) {
  await u.handleCallback("po:0", ctxFor(messageId));
  const pc = findData(lastMarkup(t.edits().at(-1)), "pc:");
  await u.handleCallback(pc, ctxFor(messageId));
  const card = t.edits().at(-1);
  return { card, yes: findData(lastMarkup(card), "y:"), no: findData(lastMarkup(card), "n:") };
}

test("close: card shows the exact position; confirm executes exactly once with the right params", async () => {
  const { u, t, exec } = makeUI();
  const { card, yes } = await openCloseCard(u, t);
  assert.match(card.text, /Close position\?/);
  assert.ok(card.text.includes(POS_A));
  assert.match(card.text, /PnL: \+0\.0123 SOL/);
  assert.equal(exec.length, 0, "first tap never executes");

  await Promise.all([u.handleCallback(yes, ctxFor(42)), u.handleCallback(yes, ctxFor(42))]);
  await u.handleCallback(yes, ctxFor(42)); // replay
  const closes = exec.filter((e) => e.name === "close_position");
  assert.equal(closes.length, 1, "double tap + replay execute once");
  assert.deepEqual(closes[0].args, { position_address: POS_A });
  assert.ok(t.edits().some((e) => /Closed<\/b> BONK-SOL/.test(e.text) && /solscan\.io\/tx\//.test(e.text)), "result with tx link edited into the card");
  assert.ok(t.answers().some((a) => a.alert && /already used/i.test(a.text)));
});

test("close: cancel, expired nonce, wrong chat and wrong message all refuse", async () => {
  const { u, t, exec, advance } = makeUI();
  const c1 = await openCloseCard(u, t);
  await u.handleCallback(c1.no, ctxFor(42));
  await u.handleCallback(c1.yes, ctxFor(42));
  assert.match(t.edits().find((e) => /Cancelled/.test(e.text)).text, /Nothing was done/);

  const c2 = await openCloseCard(u, t);
  advance(ui.CONFIRM_TTL_MS + 1);
  await u.handleCallback(c2.yes, ctxFor(42));
  assert.ok(t.edits().some((e) => /expired/.test(e.text)));

  const c3 = await openCloseCard(u, t);
  await u.handleCallback(c3.yes, ctxFor(42, { chatId: "222" }));
  await u.handleCallback(c3.yes, ctxFor(77));
  assert.equal(exec.length, 0, "nothing executed");

  // Full path: a stranger's callback never reaches the UI at all.
  tg.__setTelegramTestHooks({ token: "TEST", fetch: mockFetch(), owner: OWNER });
  const res = await tg.processUpdate(cbUpdate("222", "222", c3.yes), { onCallback: (d, ctx) => u.handleCallback(d, ctx) });
  assert.equal(res.handled, false);
  assert.equal(exec.length, 0);

  // The owner's own tap still works afterwards (nonce was not consumed by refusals).
  await u.handleCallback(c3.yes, ctxFor(42));
  assert.equal(exec.filter((e) => e.name === "close_position").length, 1);
});

test("close: a busy agent refuses and the nonce is not reusable", async () => {
  const { u, t, exec } = makeUI({ runExclusive: async () => ({ busy: true }) });
  const { yes } = await openCloseCard(u, t);
  await u.handleCallback(yes, ctxFor(42));
  assert.ok(t.edits().some((e) => /busy — nothing was closed/.test(e.text)));
  assert.equal(exec.length, 0);
});

// ─── Deploy confirmation ─────────────────────────────────────────
test("deploy: card shows pool, computeDeployAmount amount and strategy; confirm deploys once", async () => {
  const { u, t, exec } = makeUI();
  await u.handleCallback("ca:0", ctxFor(50));
  const dp = findData(lastMarkup(t.edits().at(-1)), "dp:");
  await u.handleCallback(dp, ctxFor(50));
  const card = t.edits().at(-1);
  assert.match(card.text, /Deploy into this pool\?/);
  assert.ok(card.text.includes("CandPool1111111111111111111111111111111111111"));
  assert.match(card.text, /Amount: <b>1\.40 SOL|Amount: <b>1\.4 SOL/);
  assert.match(card.text, /Evil Panda/);
  const yes = findData(lastMarkup(card), "y:");
  await u.handleCallback(yes, ctxFor(50));
  await u.handleCallback(yes, ctxFor(50));
  const deploys = exec.filter((e) => e.name === "deploy_position");
  assert.equal(deploys.length, 1);
  assert.deepEqual(deploys[0].args, {
    pool_address: "CandPool1111111111111111111111111111111111111",
    pool_name: "AAA-SOL",
    base_mint: "MintA",
    bin_step: 100,
    volatility: 3.2,
    fee_tvl_ratio: 1.2,
    organic_score: 80,
    strategy: "spot",
    price_range_pct: 80,
    bins_above: 0,
    amount_y: 1.4,
  });
  assert.ok(exec.some((e) => e.name === "afterDeploy"));
});

test("deploy plan: USDC mode uses amount_usd; unreadable wallet refuses; volatility sets the range", () => {
  const cfg = baseConfig({ strategy: { activeStrategy: "custom", strategy: "bid_ask" } });
  const c = candidates().candidates[1];
  const usdc = ui.buildDeployPlan(c, { wallet: null, config: cfg, computeDeployAmount: () => 1, usdcMode: true });
  assert.equal(usdc.args.amount_usd, 50);
  assert.equal(usdc.args.amount_y, undefined);
  assert.equal(usdc.args.strategy, "bid_ask");
  assert.equal(usdc.args.price_range_pct, 75, "volatility 9 → widest bid_ask band");
  assert.match(ui.buildDeployPlan(c, { wallet: { error: "rpc down" }, config: cfg, computeDeployAmount: () => 1 }).error, /wallet/);
  assert.equal(ui.rangeForVolatility(1, "bid_ask"), 45);
  assert.equal(ui.rangeForVolatility(null, "spot"), 85);
});

test("legacy number reply goes through the same confirmation", async () => {
  const { u, t, exec } = makeUI();
  assert.equal(await u.handleMessage("2", { chatId: OWNER }), true);
  assert.match(t.sends().at(-1).text, /No pool #2/);
  await u.handleMessage("/candidates", { chatId: OWNER });
  await u.handleMessage("2", { chatId: OWNER });
  assert.equal(exec.length, 0, "number reply alone never deploys");
  const cardMsg = t.sends().at(-1);
  assert.match(cardMsg.text, /BBB-SOL/);
  const cardId = 500 + t.sends().length; // mock message ids are sequential
  const yes = findData(lastMarkup(cardMsg), "y:");
  await u.handleCallback(yes, ctxFor(cardId + 1)); // tap on a different message: refused
  assert.equal(exec.length, 0);
  await u.handleCallback(yes, ctxFor(cardId));
  const deploys = exec.filter((e) => e.name === "deploy_position");
  assert.equal(deploys.length, 1);
  assert.equal(deploys[0].args.pool_address, "CandPool2222222222222222222222222222222222222");
  assert.equal(await u.handleMessage("9", { chatId: OWNER }), true);
  assert.match(t.sends().at(-1).text, /No pool #9/);
});

test("legacy 'auto' asks for confirmation before the agent deploys", async () => {
  const { u, t, exec } = makeUI();
  await u.handleMessage("auto", { chatId: OWNER });
  assert.equal(exec.length, 0);
  const msg = t.sends().at(-1);
  const yes = findData(lastMarkup(msg), "y:");
  await u.handleCallback(yes, ctxFor(501));
  assert.deepEqual(exec.map((e) => e.name), ["auto", "afterDeploy"]);
});

test("run screening now needs confirmation and reports a refused start", async () => {
  const { u, t, exec } = makeUI();
  await u.handleCallback("sn", ctxFor(60));
  assert.equal(exec.length, 0);
  await u.handleCallback(findData(lastMarkup(t.edits().at(-1)), "y:"), ctxFor(60));
  assert.deepEqual(exec.map((e) => e.name), ["screen"]);

  const busy = makeUI({ runScreeningNow: () => ({ started: false, reason: "a screening cycle is already running", done: Promise.resolve(null) }) });
  await busy.u.handleCallback("sn", ctxFor(61));
  await busy.u.handleCallback(findData(lastMarkup(busy.t.edits().at(-1)), "y:"), ctxFor(61));
  assert.ok(busy.t.edits().some((e) => /not started: a screening cycle is already running/.test(e.text)));
});

test("autoresearch approve needs confirmation and reuses the /autoresearch handler", async () => {
  const calls = [];
  const { u, t } = makeUI({ handleAutoresearchCommand: (a) => { calls.push(a); return a === "status" ? "Pending proposal: exp1 (range)" : `Approved exp1`; } });
  await u.handleCallback("aa", ctxFor(70));
  assert.deepEqual(calls, ["status"]);
  await u.handleCallback(findData(lastMarkup(t.edits().at(-1)), "y:"), ctxFor(70));
  assert.deepEqual(calls, ["status", "approve"]);
});

// ─── Pause / resume ──────────────────────────────────────────────
test("pause flag persists in state.json and the screening gate honors it", async () => {
  assert.equal(stateMod.isScreeningPaused(), false);
  stateMod.setScreeningPaused(true, "test");
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, "state.json"), "utf8"));
  assert.equal(onDisk._screeningPaused.paused, true);
  const reloaded = await import(`../state.js?restart=${Date.now()}`); // simulated restart
  assert.equal(reloaded.isScreeningPaused(), true);

  assert.equal(screeningCronGate({ paused: true }).run, false);
  assert.match(screeningCronGate({ paused: true }).reason, /paused/);
  assert.equal(screeningCronGate({ paused: true, manual: true }).run, true, "manual run still allowed");
  assert.equal(screeningCronGate({ paused: true, manual: true, screeningBusy: true }).run, false, "never overlaps");
  assert.equal(screeningCronGate({ managementBusy: true }).run, false);
  assert.equal(screeningCronGate({}).run, true);

  stateMod.setScreeningPaused(false, "test");
  assert.equal(reloaded.isScreeningPaused(), false);
});

test("pause/resume buttons toggle the flag and Status shows it", async () => {
  const { u, t, isPaused } = makeUI();
  await u.handleCallback("sp:1", ctxFor(80));
  assert.equal(isPaused(), true);
  assert.ok(findData(lastMarkup(t.edits().at(-1)), "sp:0"), "Resume button shown");
  await u.handleCallback("st", ctxFor(80));
  assert.match(t.edits().at(-1).text, /PAUSED/);
  await u.handleCallback("sp:0", ctxFor(80));
  assert.equal(isPaused(), false);
});

// ─── Escaping, length limits, pagination ─────────────────────────
test("escapeHtml and clipText", () => {
  assert.equal(tg.escapeHtml(`<a href="x">&</a>`), `&lt;a href="x"&gt;&amp;&lt;/a&gt;`);
  const clipped = tg.clipText("a".repeat(4090) + "&amp;&amp;&amp;");
  assert.ok(clipped.length <= 4096);
  assert.ok(!/&[a-z]*…$/.test(clipped), "never cuts an entity in half");
});

test("positions and candidates paginate under the 4096-char cap", async () => {
  const many = Array.from({ length: 23 }, (_, i) => ({ ...positions().positions[0], position: `Pos${String(i).padStart(41, "x")}`, pair: `<T${i}>-SOL`.repeat(8) }));
  const { u, t } = makeUI({
    getMyPositions: async () => ({ total_positions: many.length, positions: many }),
    getTopCandidates: async () => ({ candidates: Array.from({ length: 12 }, (_, i) => ({ ...candidates().candidates[0], pool: `Cand${i}`.padEnd(44, "z"), name: `N${i}` })) }),
    buildSettingsReport: () => "a <b> line & more\n".repeat(2000),
  });
  await u.handleCallback("po:0", ctxFor(1));
  const first = t.edits().at(-1);
  const pager = lastMarkup(first).find((row) => row.some((b) => /\/\d+$/.test(b.text)));
  assert.ok(pager, "pager row present");
  assert.equal(pager.find((b) => /\//.test(b.text)).text, `1/${Math.ceil(23 / ui.POSITIONS_PER_PAGE)}`);
  await u.handleCallback("po:4", ctxFor(1));
  assert.match(t.edits().at(-1).text, /21\. /);
  await u.handleCallback("ca:2", ctxFor(1));
  assert.match(t.edits().at(-1).text, /11\. N10/);
  await u.handleCallback("se:3", ctxFor(1));
  assert.match(t.edits().at(-1).text, /&lt;b&gt; line &amp; more/);
  for (const e of t.edits()) assert.ok(e.text.length <= 4096, `message ${e.text.length} chars`);
});

test("paginate/paginateText respect item and char budgets", () => {
  const pages = ui.paginate(["x".repeat(2000), "y".repeat(2000), "z"], { perPage: 5, budget: 3500 });
  assert.deepEqual(pages, [[0], [1, 2]]);
  const tp = ui.paginateText("line\n".repeat(3000), 1000);
  assert.ok(tp.every((p) => p.length <= 1000));
  assert.equal(tp.join("\n").split("\n").filter(Boolean).length, 3000);
});

// ─── callback_data ≤ 64 bytes ────────────────────────────────────
test("every callback_data produced by any view is ≤ 64 bytes; cb() refuses longer", async () => {
  const { u, t } = makeUI();
  await u.handleMessage("/menu", { chatId: OWNER });
  for (const d of ["st", "po:0", "wa", "ca:0", "se:0", "bc", "ar", "al:0", "er", "sn", "aa"]) await u.handleCallback(d, ctxFor(3));
  await u.handleCallback(findData(lastMarkup(t.edits().find((e) => e.text.includes("Positions"))), "pc:"), ctxFor(3));
  await u.handleCallback(findData(lastMarkup(t.edits().find((e) => e.text.includes("Candidates"))), "dp:"), ctxFor(3));
  const all = t.calls.flatMap((c) => allCallbackData(lastMarkup(c)));
  assert.ok(all.length > 30);
  for (const d of all) assert.ok(Buffer.byteLength(d, "utf8") <= 64, d);
  assert.throws(() => ui.cb("pc", "x".repeat(70)), /callback_data too long/);
});

// ─── Alerts ──────────────────────────────────────────────────────
test("alerts: fund events carry buttons; out-of-range and gas alerts are rate-limited", async () => {
  const { u, t, advance } = makeUI();
  const hub = new EventEmitter();
  u.attachAlerts((ev, fn) => hub.on(ev, fn));
  const flush = () => new Promise((r) => setImmediate(r));

  hub.emit("deploy", { pair: "AAA<SOL>", pool: POOL_A, position: POS_A, amountSol: 1.4, txs: ["4".repeat(88)] });
  hub.emit("close", { pair: "AAA", position: POS_A, pnlPct: null, txs: ["3".repeat(88)] });
  hub.emit("pnl_watcher_close", { pair: "AAA", position: POS_A, reason: "STOP_LOSS: -12%", pnlPct: -12, pnlSol: -0.2 });
  await flush();
  const [dep, clo, sl] = t.sends();
  assert.match(dep.text, /Deployed<\/b> AAA&lt;SOL&gt;/);
  assert.match(dep.text, /solscan\.io\/tx\/4{88}/);
  assert.ok(findData(lastMarkup(dep), "po:0"), "View positions button");
  assert.ok(findData(lastMarkup(dep), "pc:"), "Close (with confirmation) button");
  assert.match(clo.text, /PnL: unknown/);
  assert.match(sl.text, /Stop-loss hit/);

  const n = t.sends().length;
  hub.emit("out_of_range", { pair: "AAA", minutesOOR: 30 });
  hub.emit("out_of_range", { pair: "AAA", minutesOOR: 31 });
  hub.emit("gas_low", { sol: 0.01, reserve: 0.05 });
  hub.emit("gas_low", { sol: 0.01, reserve: 0.05 });
  await flush();
  assert.equal(t.sends().length, n + 2, "one OOR + one gas alert");
  advance(60 * 60_000);
  hub.emit("out_of_range", { pair: "AAA", minutesOOR: 90 });
  await flush();
  assert.equal(t.sends().length, n + 2, "still inside the per-pair OOR cooldown");
  advance(6 * 60 * 60_000);
  hub.emit("out_of_range", { pair: "AAA", minutesOOR: 450 });
  await flush();
  assert.equal(t.sends().length, n + 3, "cooldown expired");

  // "View position" from an alert opens a NEW message instead of overwriting it.
  const before = t.sends().length;
  await u.handleCallback(findData(lastMarkup(dep), "po:0"), ctxFor(dep.messageId ?? 999));
  assert.equal(t.sends().length, before + 1);
});

test("alerts: routine cycle reports are not sent but still show under Status", async () => {
  const { u, t } = makeUI();
  const hub = new EventEmitter();
  u.attachAlerts((ev, fn) => hub.on(ev, fn));
  const flush = () => new Promise((r) => setImmediate(r));

  hub.emit("cycle:management", { report: "Management cycle failed: rpc", routine: false }); // cycle_error covers it
  hub.emit("cycle:management", { report: "Management: 2 position(s) checked in code, no close rule triggered — HOLD.", routine: true });
  hub.emit("cycle:screening", { report: "Screening: no candidate worth deploying", routine: true });
  await flush();
  assert.equal(t.sends().length, 0, "nothing happened → no message");

  await u.handleCallback("st", ctxFor(90));
  const status = t.edits().at(-1).text;
  assert.match(status, /no close rule triggered — HOLD/);
  assert.match(status, /no candidate worth deploying/);

  hub.emit("cycle:management", { report: "Closed <AAA>: rule 4 OOR", routine: false });
  hub.emit("cycle:screening", { report: "Deployed into BBB", routine: false });
  await flush();
  assert.equal(t.sends().length, 2);
  assert.match(t.sends()[0].text, /Closed &lt;AAA&gt;: rule 4/);
});

// ─── Recent errors ───────────────────────────────────────────────
test("recent errors: only ERROR/WARN lines, redacted", () => {
  fs.mkdirSync(path.join(TMP, "logs"), { recursive: true });
  const logFile = path.join(TMP, "logs", "live-test.log");
  fs.writeFileSync(path.join(TMP, "logs", "bot.logpath"), "logs/live-test.log\n");
  fs.writeFileSync(logFile, [
    "[t] [CRON] fine",
    "[t] [WALLET_ERROR] GET https://api.helius.xyz/v1/wallet/x?api-key=abcd1234secret failed",
    "[t] [TELEGRAM_ERROR] https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ/sendMessage",
    "[t] [SWAP_ERROR] sig 3mmAyxwudjVWtEBp52tMrPnWBpr4kUCTgL2SiiaFSh7Yc3MVPvHET537Po5vHvk5bBKfigDrFUXqLZiXypuXYmbo",
    "[t] [SCREENING_WARN] key [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33]",
  ].join("\n"));
  const { file, lines } = ui.readRecentErrors({ repoDir: TMP });
  assert.equal(file, "live-test.log");
  assert.equal(lines.length, 4);
  const joined = lines.join("\n");
  assert.ok(!joined.includes("abcd1234secret"));
  assert.ok(!joined.includes("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ"));
  assert.ok(!joined.includes("3mmAyxwudjVWtEBp52tMrPnWBpr4kUCTgL2SiiaFSh7Yc3MVPvHET537Po5vHvk5bBKfigDrFUXqLZiXypuXYmbo"));
  assert.match(joined, /3mmA…Ymbo/);
  assert.match(joined, /\[redacted-bytes\]/);
});

test("nonce store: TTL, single use, unknown ids", () => {
  let now = 0;
  const s = ui.createNonceStore({ ttlMs: 1000, now: () => now });
  const id = s.put("close", { position_address: "P" });
  assert.ok(id.length <= 12);
  assert.equal(s.take(id).entry.params.position_address, "P");
  assert.equal(s.take(id).error, "unknown");
  const id2 = s.put("close", {});
  now = 1000;
  assert.equal(s.take(id2).error, "expired");
  assert.equal(s.take("nope").error, "unknown");
});
