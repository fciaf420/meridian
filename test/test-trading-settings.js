// Telegram "⚙️ Trading settings": presets, risk-raising confirms, deploy size
// (floor = ceiling + minSolToOpen bump), custom size input, stop-loss Off
// semantics, owner-only, callback_data size and PnL-watcher rescheduling.
// Everything is mocked: no Telegram API, no RPC, no LLM, no transaction. Runs in
// a temp cwd with a temp user-config.json so nothing in the repo is touched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-trading-"));
const USER_CFG = path.join(TMP, "user-config.json");
fs.writeFileSync(USER_CFG, JSON.stringify({ someOtherKey: "keep-me" }, null, 2));
process.env.MERIDIAN_USER_CONFIG_PATH = USER_CFG;
process.env.WALLET_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
process.env.RPC_URL = "http://127.0.0.1:9"; // never reached
process.env.DRY_RUN = "true";
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
delete process.env.TELEGRAM_ALLOWLIST;
process.chdir(TMP);
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ts = await import("../trading-settings.js");
const ui = await import("../telegram-ui.js");
const tg = await import("../telegram.js");

const OWNER = "111";

function mockConfig(over = {}) {
  return {
    management: {
      takeProfitFeePct: 5, stopLossPct: -10, trailingTakeProfit: true, trailingTriggerPct: 3, trailingDropPct: 2,
      outOfRangeWaitMinutes: 30, deployAmountSol: 1.1, minSolToOpen: 1.3, gasReserve: 0.2, pnlUnit: "sol",
      ...(over.management || {}),
    },
    risk: { maxPositions: 2, maxDeployAmount: 1.1, ...(over.risk || {}) },
    schedule: { managementIntervalMin: 10, screeningIntervalMin: 30, pnlWatcherIntervalSec: 30, ...(over.schedule || {}) },
    strategy: { activeStrategy: "evil_panda" },
    screening: { source: "meteora" },
  };
}

function makeUI({ config = mockConfig(), persistThrows = false } = {}) {
  const calls = [];
  let id = 700;
  const t = {
    sendHTML: async (text, extra = {}) => { calls.push({ m: "send", text, extra, message_id: ++id }); return { message_id: id, chat: { id: Number(OWNER) } }; },
    editHTML: async (messageId, text, extra = {}) => { calls.push({ m: "edit", messageId, text, extra }); return true; },
    answerCallback: async (cid, text, alert) => { calls.push({ m: "answer", text, alert }); return true; },
  };
  const persisted = [];
  const restarts = [];
  const logs = [];
  let clock = 5_000_000;
  const log = (cat, msg) => logs.push([cat, msg]);
  const u = ui.createTelegramUI({
    tg: t,
    config,
    usdcModeEnabled: () => false,
    buildSettingsReport: () => "settings",
    getStatusInfo: () => ({}),
    applyTradingSettings: (changes) => ts.applyTradingSettings(changes, {
      config,
      persistUserConfig: (c) => { if (persistThrows) throw new Error("disk full"); persisted.push({ ...c }); },
      restartPnlWatcher: (sec) => { restarts.push(sec); return true; },
      log,
    }),
    now: () => clock,
    log,
  });
  return { u, calls, persisted, restarts, logs, config, advance: (ms) => { clock += ms; } };
}

const kb = (call) => call?.extra?.reply_markup?.inline_keyboard || [];
const datas = (keyboard) => keyboard.flat().map((b) => b.callback_data).filter(Boolean);
const texts = (keyboard) => keyboard.flat().map((b) => b.text);
const ctx = (messageId = 42, extra = {}) => ({ chatId: OWNER, fromId: OWNER, messageId, callbackId: "cq", ...extra });
const confirmData = (call, prefix) => datas(kb(call)).find((d) => d.startsWith(prefix));

// ─── Screen ──────────────────────────────────────────────────────
test("screen: reachable from the main menu and Settings; shows values; ✅ marks the current preset", async () => {
  const { u, calls } = makeUI();
  await u.handleMessage("/menu", { chatId: OWNER });
  assert.ok(datas(kb(calls.at(-1))).includes("ts"), "main menu has Trading settings");
  await u.handleCallback("se:0", ctx());
  assert.ok(datas(kb(calls.at(-1))).includes("ts"), "Settings has Trading settings");
  await u.handleCallback("ts", ctx());
  const view = calls.at(-1);
  assert.equal(view.m, "edit", "edited in place");
  assert.match(view.text, /Take profit: <b>5%<\/b> · Stop loss: <b>-10%<\/b>/);
  assert.match(view.text, /Trailing TP: <b>on<\/b> · trigger 3% · drop 2%/);
  assert.match(view.text, /Deploy size: <b>1\.1 SOL<\/b> \(fixed\) · min SOL to open 1\.3 SOL/);
  assert.match(view.text, /Max positions: <b>2<\/b> · PnL watcher: every <b>30s<\/b>/);
  const t = texts(kb(view));
  for (const s of ["✅ 5%", "✅ -10%", "✅ On", "✅ 3%", "✅ 2%", "✅ 30m", "✅ 1.1", "✅ 2", "✅ 30s"]) assert.ok(t.includes(s), s);
  assert.equal(t.filter((x) => x.startsWith("✅")).length, 9, "exactly one ✅ per preset row");
  for (const d of ["tv:tp:3", "tv:tp:20", "tv:sl:-5", "tv:sl:off", "tv:tt:on", "tv:tt:off", "tv:tg:10", "tv:td:6", "tv:oo:60", "tv:ds:0.5", "tv:ds:2", "tc", "tv:mp:4", "tv:pw:15"]) {
    assert.ok(datas(kb(view)).includes(d), d);
  }
});

test("callback_data: every button across the screen, confirms and custom prompt is ≤ 64 bytes", async () => {
  const { u, calls } = makeUI();
  await u.handleCallback("ts", ctx());
  await u.handleCallback("tv:sl:off", ctx());
  await u.handleCallback("tc", ctx());
  await u.handleMessage("99", { chatId: OWNER });
  const all = calls.flatMap((c) => datas(kb(c)));
  assert.ok(all.length > 40);
  for (const d of all) assert.ok(Buffer.byteLength(d, "utf8") <= 64, d);
});

// ─── Presets apply the right keys ────────────────────────────────
test("presets: one-tap (risk-reducing / neutral) presets write exactly the right keys and values", async () => {
  const { u, persisted, config, calls, logs } = makeUI();
  const cases = [
    ["tv:tp:10", { takeProfitFeePct: 10 }, ["management", "takeProfitFeePct", 10]],
    ["tv:sl:-5", { stopLossPct: -5 }, ["management", "stopLossPct", -5]], // tighter
    ["tv:tg:8", { trailingTriggerPct: 8 }, ["management", "trailingTriggerPct", 8]],
    ["tv:td:4", { trailingDropPct: 4 }, ["management", "trailingDropPct", 4]],
    ["tv:oo:5", { outOfRangeWaitMinutes: 5 }, ["management", "outOfRangeWaitMinutes", 5]],
    ["tv:mp:1", { maxPositions: 1 }, ["risk", "maxPositions", 1]], // fewer
    ["tv:pw:15", { pnlWatcherIntervalSec: 15 }, ["schedule", "pnlWatcherIntervalSec", 15]],
  ];
  for (const [data, expected, [section, field, value]] of cases) {
    await u.handleCallback(data, ctx());
    assert.deepEqual(persisted.at(-1), expected, data);
    assert.equal(config[section][field], value, `${data} applied to the running config`);
    assert.equal(calls.at(-1).m, "edit");
    assert.match(calls.at(-1).text, /✅ Saved: /);
  }
  assert.equal(persisted.length, cases.length, "no confirm needed for any of these");
  assert.match(calls.at(-1).text, /PnL watcher: 30s → 15s/, "old → new shown");
  assert.ok(logs.some(([c, m]) => c === "config" && m === "Trading setting (telegram): Take profit: 5% → 10%"));
  assert.ok(logs.some(([c, m]) => c === "telegram" && /Trading settings changed from Telegram: Stop loss: -10% → -5%/.test(m)));
});

test("presets: re-tapping the current value changes nothing; unknown code or non-preset value is refused", async () => {
  const { u, persisted, calls } = makeUI();
  await u.handleCallback("tv:tp:5", ctx());
  assert.equal(persisted.length, 0);
  assert.equal(calls.find((c) => c.m === "answer").text, "Already set.");
  for (const d of ["tv:tp:6", "tv:zz:1", "tv:sl:5", "tv:ds:9", "tv:tt:maybe", "tv:mp:"]) await u.handleCallback(d, ctx());
  assert.equal(persisted.length, 0);
  assert.ok(calls.filter((c) => c.m === "answer" && c.text === "Unknown preset.").length >= 6);
});

test("presets: a failed save leaves the running config untouched and says so", async () => {
  const { u, config, calls } = makeUI({ persistThrows: true });
  await u.handleCallback("tv:tp:10", ctx());
  assert.equal(config.management.takeProfitFeePct, 5);
  assert.match(calls.at(-1).text, /Not changed: could not save user-config\.json: disk full/);
});

// ─── Risk-increasing confirm flow ────────────────────────────────
test("risk-raising: stop loss Off / wider, bigger deploy, more positions and trailing off each need a confirm", async () => {
  const cases = [
    ["tv:sl:off", { stopLossPct: 0 }, /Stop loss: -10% → Off[\s\S]*turns the stop loss off/],
    ["tv:sl:-20", { stopLossPct: -20 }, /Stop loss: -10% → -20%[\s\S]*widens the stop loss/],
    ["tv:ds:1.5", { deployAmountSol: 1.5, maxDeployAmount: 1.5, minSolToOpen: 1.7 }, /raises the deploy size/],
    ["tv:mp:3", { maxPositions: 3 }, /Max positions: 2 → 3[\s\S]*raises max positions/],
    ["tv:tt:off", { trailingTakeProfit: false }, /Trailing TP: on → off[\s\S]*turns trailing TP off/],
  ];
  for (const [data, expected, re] of cases) {
    const { u, persisted, calls, config } = makeUI();
    const before = JSON.stringify(config);
    await u.handleCallback(data, ctx());
    const card = calls.at(-1);
    assert.match(card.text, /Raise risk\?/, data);
    assert.match(card.text, re, data);
    assert.equal(persisted.length, 0, `${data}: nothing saved on the first tap`);
    assert.equal(JSON.stringify(config), before, `${data}: running config untouched`);
    await u.handleCallback(confirmData(card, "y:"), ctx());
    assert.deepEqual(persisted, [expected], `${data}: applied once with the exact keys`);
    assert.match(calls.at(-1).text, /✅ Saved:/);
  }
});

test("risk-raising: confirm applies exactly once; replay, cancel, expired and wrong-message are refused", async () => {
  // confirm + replay
  let h = makeUI();
  await h.u.handleCallback("tv:mp:4", ctx());
  const y = confirmData(h.calls.at(-1), "y:");
  await h.u.handleCallback(y, ctx());
  await h.u.handleCallback(y, ctx());
  assert.equal(h.persisted.length, 1, "replay refused");
  assert.equal(h.config.risk.maxPositions, 4);
  assert.match(h.calls.filter((c) => c.m === "answer").at(-1).text, /Unknown or already used/);

  // cancel, then the confirm is dead
  h = makeUI();
  await h.u.handleCallback("tv:mp:4", ctx());
  const card = h.calls.at(-1);
  await h.u.handleCallback(confirmData(card, "n:"), ctx());
  assert.match(h.calls.at(-1).text, /Cancelled\. Nothing was done/);
  assert.ok(datas(kb(h.calls.at(-1))).includes("ts"), "Cancel leads back to Trading settings");
  await h.u.handleCallback(confirmData(card, "y:"), ctx());
  assert.equal(h.persisted.length, 0);
  assert.equal(h.config.risk.maxPositions, 2);
  assert.ok(h.logs.some(([, m]) => /Trading settings change cancelled: Max positions: 2 → 4/.test(m)));

  // expired after 60s
  h = makeUI();
  await h.u.handleCallback("tv:sl:off", ctx());
  const y2 = confirmData(h.calls.at(-1), "y:");
  h.advance(ui.CONFIRM_TTL_MS + 1);
  await h.u.handleCallback(y2, ctx());
  assert.equal(h.persisted.length, 0);
  assert.equal(h.config.management.stopLossPct, -10);
  assert.match(h.calls.at(-1).text, /expired/);

  // wrong message / wrong chat
  h = makeUI();
  await h.u.handleCallback("tv:tt:off", ctx(42));
  const y3 = confirmData(h.calls.at(-1), "y:");
  await h.u.handleCallback(y3, ctx(43));
  await h.u.handleCallback(y3, ctx(42, { chatId: "999" }));
  assert.equal(h.persisted.length, 0);
  await h.u.handleCallback(y3, ctx(42));
  assert.deepEqual(h.persisted, [{ trailingTakeProfit: false }], "the owner's own tap still works");
});

test("risk classification: tightening stop loss, re-enabling stop/trailing, smaller deploy and fewer positions are one tap", () => {
  const cur = ts.readTradingSettings(mockConfig({ management: { stopLossPct: 0, trailingTakeProfit: false } }));
  assert.deepEqual(ts.riskIncreases({ stopLossPct: -20 }, cur), [], "Off → on is safer");
  assert.deepEqual(ts.riskIncreases({ trailingTakeProfit: true }, cur), []);
  assert.deepEqual(ts.riskIncreases({ deployAmountSol: 0.5, maxDeployAmount: 0.5 }, cur), []);
  assert.deepEqual(ts.riskIncreases({ maxPositions: 1 }, cur), []);
  const on = ts.readTradingSettings(mockConfig());
  assert.deepEqual(ts.riskIncreases({ stopLossPct: -8 }, on), []);
  assert.equal(ts.riskIncreases({ stopLossPct: -15 }, on).length, 1);
  // A floor below the current ceiling still counts as raising when it lifts the floor.
  const ranged = ts.readTradingSettings(mockConfig({ management: { deployAmountSol: 0.5 }, risk: { maxDeployAmount: 50 } }));
  assert.equal(ts.riskIncreases({ deployAmountSol: 1.1, maxDeployAmount: 1.1 }, ranged).length, 1);
  assert.deepEqual(ts.riskIncreases({ deployAmountSol: 0.5, maxDeployAmount: 0.5 }, ranged), [], "ceiling 50 → 0.5 only lowers");
});

// ─── Deploy size ─────────────────────────────────────────────────
test("deploy size: sets floor AND ceiling, bumps minSolToOpen to size + gasReserve and says so", async () => {
  const { u, persisted, config, calls } = makeUI();
  await u.handleCallback("tv:ds:2", ctx());
  const card = calls.at(-1);
  assert.match(card.text, /Deploy size \(floor\): 1\.1 SOL → 2 SOL/);
  assert.match(card.text, /Deploy ceiling: 1\.1 SOL → 2 SOL/);
  assert.match(card.text, /Min SOL to open raised 1\.3 SOL → 2\.2 SOL \(size 2 \+ gas reserve 0\.2\)/);
  await u.handleCallback(confirmData(card, "y:"), ctx());
  assert.deepEqual(persisted, [{ deployAmountSol: 2, maxDeployAmount: 2, minSolToOpen: 2.2 }]);
  assert.equal(config.management.deployAmountSol, 2);
  assert.equal(config.risk.maxDeployAmount, 2);
  assert.equal(config.management.minSolToOpen, 2.2);
  assert.match(calls.at(-1).text, /Min SOL to open raised/);

  // Lowering: one tap, minSolToOpen already high enough → left alone.
  await u.handleCallback("tv:ds:0.5", ctx());
  assert.deepEqual(persisted.at(-1), { deployAmountSol: 0.5, maxDeployAmount: 0.5 });
  assert.equal(config.management.minSolToOpen, 2.2);

  // computeDeployAmount semantics (floor = ceiling → fixed size).
  const ceil = config.risk.maxDeployAmount;
  const floor = config.management.deployAmountSol;
  for (const wallet of [0.8, 5, 100]) assert.equal(Math.min(ceil, Math.max(floor, (wallet - 0.2) * 0.35)), 0.5);
});

test("custom deploy size: next numeric owner message sets it; range and format are checked", async () => {
  const { u, persisted, calls, config, advance } = makeUI();
  await u.handleCallback("tc", ctx());
  assert.match(calls.at(-1).text, /Send the deploy size in SOL<\/b> \(0\.1–10\)/);
  assert.ok(datas(kb(calls.at(-1))).includes("tq"));

  for (const bad of ["0.05", "12", "10.5"]) {
    assert.equal(await u.handleMessage(bad, { chatId: OWNER }), true, bad);
    assert.match(calls.at(-1).text, /outside 0\.1–10 SOL/);
  }
  assert.equal(persisted.length, 0);
  // Non-numeric text is not consumed (falls through to the normal handlers).
  assert.equal(await u.handleMessage("what is my pnl", { chatId: OWNER }), false);
  // Another chat can't answer it.
  assert.equal(await u.handleMessage("0.8", { chatId: "999" }), false);

  // 0.8 < 1.1: risk-reducing → applies in one go, sent as a new message.
  const sends = calls.filter((c) => c.m === "send").length;
  assert.equal(await u.handleMessage("0,8 sol", { chatId: OWNER }), true);
  assert.deepEqual(persisted, [{ deployAmountSol: 0.8, maxDeployAmount: 0.8 }]);
  assert.equal(calls.filter((c) => c.m === "send").length, sends + 1);
  assert.equal(config.management.deployAmountSol, 0.8);
  // Single use: a later number is a candidate pick again, not a size.
  assert.equal(await u.handleMessage("3", { chatId: OWNER }), true);
  assert.equal(persisted.length, 1);

  // Raising via custom → confirm card; rounding to 2 decimals.
  await u.handleCallback("tc", ctx());
  await u.handleMessage("1.234", { chatId: OWNER });
  const card = calls.at(-1);
  assert.match(card.text, /Raise risk\?[\s\S]*0\.8 SOL → 1\.23 SOL/);
  assert.equal(card.m, "send");
  await u.handleCallback(confirmData(card, "y:"), ctx(card.message_id)); // bound to the sent card
  assert.deepEqual(persisted.at(-1), { deployAmountSol: 1.23, maxDeployAmount: 1.23, minSolToOpen: 1.43 });

  // Cancel and expiry end the custom prompt.
  await u.handleCallback("tc", ctx());
  await u.handleCallback("tq", ctx());
  await u.handleMessage("0.4", { chatId: OWNER });
  assert.notEqual(config.management.deployAmountSol, 0.4);
  await u.handleCallback("tc", ctx());
  advance(ui.CONFIRM_TTL_MS + 1);
  await u.handleMessage("0.4", { chatId: OWNER });
  assert.notEqual(config.management.deployAmountSol, 0.4);

  assert.deepEqual(ts.parseCustomDeploySize("abc"), { error: "not a number" });
  assert.deepEqual(ts.parseCustomDeploySize("10"), { value: 10 });
  assert.deepEqual(ts.parseCustomDeploySize("0.1"), { value: 0.1 });
});

// ─── Validation ──────────────────────────────────────────────────
test("validation: SL ≤ 0 or Off, TP > 0, sane ranges; drop ≥ trigger only warns", async () => {
  assert.deepEqual(ts.validateTradingValue("stopLossPct", 5).error != null, true);
  assert.deepEqual(ts.validateTradingValue("stopLossPct", null), { value: 0 });
  assert.deepEqual(ts.validateTradingValue("stopLossPct", -20), { value: -20 });
  assert.ok(ts.validateTradingValue("takeProfitFeePct", 0).error);
  assert.ok(ts.validateTradingValue("takeProfitFeePct", -3).error);
  assert.ok(ts.validateTradingValue("maxPositions", 0).error);
  assert.ok(ts.validateTradingValue("maxPositions", 1.5).error);
  assert.ok(ts.validateTradingValue("pnlWatcherIntervalSec", 2).error);
  assert.ok(ts.validateTradingValue("outOfRangeWaitMinutes", 0).error);
  assert.ok(ts.validateTradingValue("deployAmountSol", 11).error);
  assert.ok(ts.validateTradingValue("trailingDropPct", 0).error);
  assert.ok(ts.applyTradingSettings({ walletKey: "x" }, { config: mockConfig(), persistUserConfig: () => {} }).error);
  assert.ok(ts.applyTradingSettings({ stopLossPct: 3 }, { config: mockConfig(), persistUserConfig: () => { throw new Error("must not write"); } }).error);

  const { u, persisted, calls } = makeUI();
  await u.handleCallback("tv:td:3", ctx()); // drop 3 ≥ trigger 3 → saved with a warning
  assert.deepEqual(persisted.at(-1), { trailingDropPct: 3 });
  assert.match(calls.at(-1).text, /⚠️ Trailing drop 3% ≥ trigger 3%/);
});

// ─── Stop-loss Off semantics ─────────────────────────────────────
test("stop loss Off is stored as 0: state.js treats it as disabled and config.js keeps it Off on restart", async () => {
  const { config } = await import("../config.js");
  const { trackPosition, updatePnlAndCheckExits } = await import("../state.js");
  const saved = [];
  const apply = (c) => ts.applyTradingSettings(c, { config, persistUserConfig: (x) => saved.push(x) });
  config.management.pnlWarmupMinutes = 0;
  config.management.trailingTakeProfit = false;

  const position = `PosSL${"x".repeat(38)}`;
  trackPosition({ position, pool: "Pool111111111111111111111111111111111111111", pool_name: "T-SOL", strategy: "spot", amount_sol: 1, deployed_at: new Date(Date.now() - 3_600_000).toISOString() });

  assert.equal(apply({ stopLossPct: -5 }).ok, true);
  assert.match(updatePnlAndCheckExits(position, -6, config) ?? "", /^STOP_LOSS/, "the live config the watcher reads has -5 at once");

  assert.equal(apply({ stopLossPct: 0 }).ok, true);
  assert.deepEqual(saved.at(-1), { stopLossPct: 0 });
  assert.equal(config.management.stopLossPct, 0);
  assert.equal(updatePnlAndCheckExits(position, -60, config), null, "0 disables the stop loss");
  // Restart: a fresh config.js load keeps a persisted 0 Off (a null would come back as the -20 default).
  const loadStop = (value) => {
    const file = path.join(TMP, `restart-${String(value)}.json`);
    fs.writeFileSync(file, JSON.stringify({ stopLossPct: value }));
    const out = execFileSync(process.execPath, ["--input-type=module", "-e",
      `const { config } = await import(${JSON.stringify(new URL("../config.js", import.meta.url).href)}); console.log(JSON.stringify(config.management.stopLossPct));`,
    ], { env: { ...process.env, MERIDIAN_USER_CONFIG_PATH: file }, cwd: TMP, encoding: "utf8" });
    return JSON.parse(out.trim().split("\n").at(-1));
  };
  assert.equal(loadStop(0), 0);
  assert.equal(loadStop(null), -20);
  assert.match(ts.fmtTradingValue("stopLossPct", 0), /^Off$/);
});

// ─── PnL watcher reschedule ──────────────────────────────────────
test("PnL watcher: an interval change reschedules it; other changes and an unchanged interval don't", async () => {
  const { u, restarts, calls } = makeUI();
  await u.handleCallback("tv:tp:7", ctx());
  assert.deepEqual(restarts, []);
  await u.handleCallback("tv:pw:60", ctx());
  assert.deepEqual(restarts, [60]);
  assert.match(calls.at(-1).text, /PnL watcher rescheduled to every 60s/);
  await u.handleCallback("tv:pw:60", ctx());
  assert.deepEqual(restarts, [60], "unchanged interval: no reschedule");

  // Cycles not started → the restarter reports false; the value still applies.
  const config = mockConfig();
  const r = ts.applyTradingSettings({ pnlWatcherIntervalSec: 15 }, { config, persistUserConfig: () => {}, restartPnlWatcher: () => false });
  assert.equal(r.ok, true);
  assert.equal(r.rescheduled, false);
  assert.equal(config.schedule.pnlWatcherIntervalSec, 15);
});

// ─── Owner-only ──────────────────────────────────────────────────
test("owner-only: a stranger's preset tap or custom size never reaches the UI; nothing changes", async () => {
  const apiCalls = [];
  tg.__setTelegramTestHooks({ token: "TEST", owner: OWNER, allowlist: "", fetch: async (url) => { apiCalls.push(String(url)); return { ok: true, json: async () => ({ ok: true, result: {} }) }; } });
  const { u, persisted, config } = makeUI();
  const h = { onCallback: (d, c) => u.handleCallback(d, c), onMessage: (t, c) => u.handleMessage(t, c) };
  const cbq = (data) => ({ update_id: 3, callback_query: { id: "cqx", data, from: { id: 999 }, message: { message_id: 9, chat: { id: 999, type: "private" } } } });
  for (const d of ["tv:tp:20", "tv:sl:off", "tc"]) assert.equal((await tg.processUpdate(cbq(d), h)).handled, false, d);
  const msg = { update_id: 4, message: { message_id: 7, text: "5", chat: { id: 999, type: "private" }, from: { id: 999, is_bot: false } } };
  assert.equal((await tg.processUpdate(msg, h)).handled, false);
  assert.equal(persisted.length, 0);
  assert.equal(config.management.takeProfitFeePct, 5);
  assert.equal(apiCalls.length, 0, "no Telegram API call for strangers");
  // Same taps from the owner go through the UI.
  assert.equal((await tg.processUpdate({ update_id: 5, callback_query: { id: "cqo", data: "tv:tp:20", from: { id: Number(OWNER) }, message: { message_id: 9, chat: { id: Number(OWNER), type: "private" } } } }, h)).handled, true);
  assert.equal(config.management.takeProfitFeePct, 20);
});

// ─── The LLM's update_config is unchanged for these keys ─────────
test("update_config: the agent can still move these keys in both directions", async () => {
  const { executeTool } = await import("../tools/executor.js");
  const { config } = await import("../config.js");
  const moves = [
    { stopLossPct: -25 }, { stopLossPct: -5 }, { stopLossPct: 0 },
    { maxPositions: 4 }, { maxPositions: 1 },
    { deployAmountSol: 2, maxDeployAmount: 2 }, { deployAmountSol: 0.5, maxDeployAmount: 0.5 },
    { trailingTakeProfit: false }, { trailingTakeProfit: true },
    { takeProfitFeePct: 20 }, { takeProfitFeePct: 3 },
  ];
  for (const changes of moves) {
    const r = await executeTool("update_config", { changes, reason: "test" });
    assert.equal(r.success, true, JSON.stringify({ changes, r }));
    for (const [k, v] of Object.entries(changes)) {
      const section = k === "maxPositions" || k === "maxDeployAmount" ? "risk" : "management";
      assert.equal(config[section][k], v, k);
    }
  }
  assert.equal(JSON.parse(fs.readFileSync(USER_CFG, "utf8")).someOtherKey, "keep-me");
});
