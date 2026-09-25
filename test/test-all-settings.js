// Telegram "🧾 All settings" editor. Everything is mocked or temp-file backed:
// no Telegram API, no RPC, no LLM, no transaction, no repo config file touched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-allset-"));
const USER_CFG = path.join(TMP, "user-config.json");
const GMGN_CFG = path.join(TMP, "gmgn-config.json");
fs.writeFileSync(USER_CFG, JSON.stringify({ someOtherKey: "keep-me", maxPositions: 2, walletKey: "SECRET-WALLET", rpcUrl: "https://secret.rpc" }, null, 2));
fs.writeFileSync(GMGN_CFG, JSON.stringify({ apiKey: "SECRET-GMGN", minHolders: 1000 }, null, 2));
process.env.MERIDIAN_USER_CONFIG_PATH = USER_CFG;
process.env.MERIDIAN_GMGN_CONFIG_PATH = GMGN_CFG;
process.env.WALLET_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
process.env.RPC_URL = "http://127.0.0.1:9";
process.env.DRY_RUN = "true";
delete process.env.TELEGRAM_BOT_TOKEN;
process.chdir(TMP);
test.after(() => { process.env.DRY_RUN = "true"; fs.rmSync(TMP, { recursive: true, force: true }); });

const cfgMod = await import("../config.js");
const { config } = cfgMod;
const es = await import("../tools/entry-safety.js");
const as = await import("../all-settings.js");
const ui = await import("../telegram-ui.js");
const tg = await import("../telegram.js");
const { CONFIG_KEY_MAP } = await import("../runtime-helpers.js");

const OWNER = "111";
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

function makeService(extra = {}) {
  const schedule = [];
  const svc = as.createAllSettings({
    config,
    lockedKeys: cfgMod.LOCKED_KEYS,
    integerKeys: cfgMod.INTEGER_KEYS,
    persistUserConfig: cfgMod.persistUserConfig,
    persistGmgnConfig: cfgMod.persistGmgnConfig,
    entryFilters: { normalize: es.normalizeEntryFilterValue, isLoosening: es.isLooseningChange },
    dryRunInEnv: false,
    onScheduleChange: (k, v) => schedule.push([k, v]),
    ...extra,
  });
  return { svc, schedule };
}

function makeUI(extra = {}) {
  const calls = [];
  let id = 800;
  const t = {
    sendHTML: async (text, x = {}) => { calls.push({ m: "send", text, extra: x, message_id: ++id }); return { message_id: id, chat: { id: Number(OWNER) } }; },
    editHTML: async (messageId, text, x = {}) => { calls.push({ m: "edit", messageId, text, extra: x }); return true; },
    answerCallback: async (cid, text, alert) => { calls.push({ m: "answer", text, alert }); return true; },
  };
  const logs = [];
  let clock = 9_000_000;
  const { svc, schedule } = makeService(extra.service || {});
  const u = ui.createTelegramUI({
    tg: t, config, usdcModeEnabled: () => false, buildSettingsReport: () => "settings", getStatusInfo: () => ({}),
    setEntryFilter: () => ({ ok: true, text: "x" }),
    allSettings: svc, now: () => clock, log: (c, m) => logs.push([c, m]),
  });
  return { u, calls, logs, svc, schedule, advance: (ms) => { clock += ms; } };
}

const kb = (c) => c?.extra?.reply_markup?.inline_keyboard || [];
const datas = (k) => k.flat().map((b) => b.callback_data).filter(Boolean);
const ctx = (messageId = 42, x = {}) => ({ chatId: OWNER, fromId: OWNER, messageId, callbackId: "cq", ...x });
const idOf = (svc, key, file = "user") => svc.entries.find((e) => e.key === key && e.file === file).id;
const yData = (c) => datas(kb(c)).find((d) => d.startsWith("y:"));
const nData = (c) => datas(kb(c)).find((d) => d.startsWith("n:"));

// ─── Registry ────────────────────────────────────────────────────
test("key list comes from what config.js reads (CONFIG_KEY_MAP keys, gmgn keys, dryRun), grouped", () => {
  const { svc } = makeService();
  const keys = new Set(svc.entries.map((e) => e.key));
  for (const k of Object.keys(CONFIG_KEY_MAP)) assert.ok(keys.has(k), `CONFIG_KEY_MAP key ${k} listed`);
  for (const k of ["dryRun", "llmProvider", "screeningSource", "priorityFeeLevel", "llmReasoningEffort", "evilPandaMinMcap", "darwinianWeights", "autoresearch", "webPort", "gmgnSignalsEnabled"]) assert.ok(keys.has(k), k);
  assert.ok(svc.entries.some((e) => e.key === "requireKol" && e.file === "gmgn"));
  const labels = svc.groups().map((g) => g.label);
  for (const l of ["Capital & sizing", "Exits", "Strategy", "Screening (Meteora)", "Screening (GMGN)", "Schedule", "LLM", "Learning", "USDC mode"]) assert.ok(labels.includes(l), l);
  assert.equal(svc.find("maxPositions").group, "cap");
  assert.equal(svc.find("stopLossPct").group, "exit");
  assert.equal(svc.find("gmgnSignalsEnabled").group, "scrm");

  // A key added to config.js shows up without touching the editor.
  const src = fs.readFileSync(new URL("../config.js", import.meta.url), "utf8")
    .replace("    maxPositions:    u.maxPositions    ?? 3,", "    maxPositions:    u.maxPositions    ?? 3,\n    brandNewKnob:    u.brandNewKnob    ?? 7,");
  const withNew = as.parseConfigKeys(src);
  assert.deepEqual(withNew.find((e) => e.key === "brandNewKnob"), { key: "brandNewKnob", file: "user", path: ["risk", "brandNewKnob"] });
});

test("secrets and LOCKED_KEYS are never listed, shown or editable", async () => {
  const { u, calls, svc } = makeUI();
  const keys = svc.entries.map((e) => e.key);
  for (const k of [...cfgMod.LOCKED_KEYS, "gmgnApiKey", "apiKey", "walletKey", "rpcUrl"]) assert.ok(!keys.includes(k), k);
  for (const k of keys) assert.ok(!as.SECRET_KEY_RE.test(k), k);
  await u.handleCallback("as", ctx());
  for (const d of datas(kb(calls.at(-1))).filter((x) => x.startsWith("ag:"))) {
    const [, g] = d.split(":");
    const pages = Math.ceil(svc.groups().find((x) => x.id === g).entries.length / ui.ALL_SETTINGS_PER_PAGE);
    for (let p = 0; p < pages; p++) await u.handleCallback(`ag:${g}:${p}`, ctx());
  }
  const all = calls.map((c) => c.text || "").join("\n");
  for (const secret of ["SECRET-WALLET", "secret.rpc", "SECRET-GMGN", "walletKey", "rpcUrl", "apiKey"]) assert.ok(!all.includes(secret), secret);
  await u.handleCallback("ak:zzz", ctx());
  assert.equal(calls.at(-1).text, "Unknown setting.");
});

test("callback_data ≤ 64 bytes across groups, pages, key cards and confirms", async () => {
  const { u, calls, svc } = makeUI();
  await u.handleCallback("se:0", ctx());
  assert.ok(datas(kb(calls.at(-1))).includes("as"), "Settings links All settings");
  assert.ok(datas(kb(calls.at(-1))).includes("ef") && datas(kb(calls.at(-1))).includes("ts"), "…and the two preset screens");
  await u.handleCallback("as", ctx());
  for (const g of svc.groups()) for (let p = 0; p * ui.ALL_SETTINGS_PER_PAGE < g.entries.length; p++) await u.handleCallback(`ag:${g.id}:${p}`, ctx());
  for (const e of svc.entries) await u.handleCallback(`ak:${e.id}`, ctx());
  await u.handleCallback(`av:${idOf(svc, "dryRun")}:0`, ctx());
  const all = calls.flatMap((c) => datas(kb(c)));
  assert.ok(all.length > 200);
  for (const d of all) assert.ok(Buffer.byteLength(d, "utf8") <= 64, d);
  for (const c of calls) assert.ok((c.text || "").length < 4096);
  await u.handleCallback(nData(calls.at(-1)), ctx());
});

// ─── Edit flows ──────────────────────────────────────────────────
test("boolean: On/Off buttons persist and apply live; a bad choice is refused", async () => {
  const { u, calls, svc } = makeUI();
  const id = idOf(svc, "darwinianWeights");
  await u.handleCallback(`ak:${id}`, ctx());
  assert.ok(datas(kb(calls.at(-1))).includes(`av:${id}:1`));
  await u.handleCallback(`av:${id}:1`, ctx());
  assert.equal(config.darwin.enabled, true);
  assert.equal(readJson(USER_CFG).darwinianWeights, true);
  assert.match(calls.at(-1).text, /✅ Saved: darwinianWeights: off → on/);
  await u.handleCallback(`av:${id}:7`, ctx());
  assert.equal(calls.filter((c) => c.m === "answer").at(-1).text, "Unknown choice.");
  assert.equal(svc.validate(svc.get(id), "maybe").error, "send on or off");
  await u.handleCallback(`av:${id}:0`, ctx());
  assert.equal(config.darwin.enabled, false);
});

test("enum: buttons for valid values only; typed values outside the enum are rejected", async () => {
  const { u, calls, svc } = makeUI();
  const e = svc.find("screeningSource");
  await u.handleCallback(`ak:${e.id}`, ctx());
  const opts = kb(calls.at(-1)).flat().map((b) => b.text.replace("✅ ", ""));
  for (const v of ["meteora", "gmgn", "both"]) assert.ok(opts.includes(v));
  await u.handleCallback(`av:${e.id}:2`, ctx()); // both
  assert.equal(config.screening.source, "both");
  assert.equal(readJson(USER_CFG).screeningSource, "both");
  assert.match(svc.validate(e, "raydium").error, /must be one of meteora, gmgn, both/);
  assert.match(svc.validate(svc.find("timeframe"), "3m").error, /must be one of/);
  await u.handleCallback(`av:${e.id}:9`, ctx());
  assert.equal(config.screening.source, "both");
  // Nullable enum: "default" clears llmReasoningEffort.
  const re = svc.find("llmReasoningEffort");
  await u.handleCallback(`av:${re.id}:2`, ctx());
  assert.equal(config.llm.reasoningEffort, "medium");
  await u.handleCallback(`av:${re.id}:0`, ctx());
  assert.equal(config.llm.reasoningEffort, null);
  await u.handleCallback(`av:${e.id}:0`, ctx());
});

test("number: next owner message is parsed; type, range and integer errors are rejected with the reason", async () => {
  const { u, calls, svc, schedule } = makeUI();
  const e = svc.find("managementIntervalMin");
  await u.handleCallback(`ai:${e.id}`, ctx());
  assert.match(calls.at(-1).text, /Send the new value/);
  for (const [bad, re] of [["abc", /not a number/], ["0", /between 1 and 1440/], ["2000", /between 1 and 1440/], ["7.5", /whole number/]]) {
    assert.equal(await u.handleMessage(bad, { chatId: OWNER }), true);
    assert.match(calls.at(-1).text, re, bad);
  }
  assert.equal(config.schedule.managementIntervalMin, 10);
  await u.handleMessage("15", { chatId: OWNER });
  assert.equal(config.schedule.managementIntervalMin, 15);
  assert.equal(readJson(USER_CFG).managementIntervalMin, 15);
  assert.deepEqual(schedule, [["managementIntervalMin", 15]], "cycles rescheduled");
  assert.match(calls.at(-1).text, /managementIntervalMin: 10 → 15/);
  // Single use: the next number isn't consumed.
  assert.equal(await u.handleMessage("20", { chatId: OWNER }), true); // candidate-pick reply, not a setting
  assert.equal(config.schedule.managementIntervalMin, 15);

  // Nullable number accepts "off"; a negative for a non-negative key is refused.
  const age = svc.find("minTokenAgeHours");
  assert.deepEqual(svc.validate(age, "off"), { value: null });
  assert.match(svc.validate(svc.find("minTvl"), "-5").error, /negative/);
  assert.match(svc.validate(svc.find("stopLossPct"), "5").error, /negative/);
  assert.match(svc.validate(svc.find("blockTransferFeeAbovePct"), "500").error, /blockTransferFeeAbovePct/);
});

test("string and list: validated and applied; commands pass through while waiting", async () => {
  const { u, calls, svc } = makeUI();
  const e = svc.find("managementModel");
  await u.handleCallback(`ai:${e.id}`, ctx());
  assert.equal(await u.handleMessage("/menu", { chatId: OWNER }), true, "/menu still works");
  assert.match(calls.at(-1).text, /Meridian/);
  await u.handleMessage("gpt-test-model", { chatId: OWNER });
  assert.equal(config.llm.managementModel, "gpt-test-model");
  assert.match(svc.validate(e, "").error, /1–200 characters/);
  assert.match(svc.validate(e, "a\nb").error, /one line/);
  const list = svc.entries.find((x) => x.key === "platforms" && x.file === "gmgn");
  assert.deepEqual(svc.validate(list, "Pump.fun, pool_meteora ,"), { value: ["Pump.fun", "pool_meteora"] });
});

test("pending input expires after 60s and /cancel aborts", async () => {
  const { u, calls, svc, advance } = makeUI();
  const e = svc.find("minTvl");
  const before = config.screening.minTvl;
  await u.handleCallback(`ai:${e.id}`, ctx());
  await u.handleMessage("/cancel", { chatId: OWNER });
  assert.match(calls.at(-1).text, /Cancelled\. Nothing was changed/);
  await u.handleMessage("12345", { chatId: OWNER });
  assert.equal(config.screening.minTvl, before);

  await u.handleCallback(`ai:${e.id}`, ctx());
  advance(ui.CONFIRM_TTL_MS + 1);
  await u.handleMessage("12345", { chatId: OWNER });
  assert.equal(config.screening.minTvl, before, "expired");

  await u.handleCallback(`ai:${e.id}`, ctx());
  await u.handleMessage("12345", { chatId: "999" });
  assert.equal(config.screening.minTvl, before, "another chat can't answer");
  await u.handleCallback("ax", ctx());
  await u.handleMessage("12345", { chatId: OWNER });
  assert.equal(config.screening.minTvl, before);
});

// ─── Safety ──────────────────────────────────────────────────────
test("dryRun: two-tap confirm in both directions with a LIVE/DRY warning; cancel and replay refused", async () => {
  const { u, calls, svc } = makeUI();
  const id = idOf(svc, "dryRun");
  await u.handleCallback(`ak:${id}`, ctx());
  assert.match(calls.at(-1).text, /Now <b>DRY RUN<\/b>/);
  await u.handleCallback(`av:${id}:0`, ctx());
  const card = calls.at(-1);
  assert.match(card.text, /Switch to LIVE trading\?/);
  assert.match(card.text, /REAL transactions/);
  assert.ok(kb(card).flat().some((b) => b.text === "🔴 Confirm LIVE"));
  assert.equal(process.env.DRY_RUN, "true", "nothing changes on the first tap");
  await u.handleCallback(nData(card), ctx());
  await u.handleCallback(yData(card), ctx());
  assert.equal(process.env.DRY_RUN, "true", "cancelled nonce can't confirm");

  await u.handleCallback(`av:${id}:0`, ctx());
  const y = yData(calls.at(-1));
  await u.handleCallback(y, ctx());
  assert.equal(process.env.DRY_RUN, "false");
  assert.equal(readJson(USER_CFG).dryRun, false);
  await u.handleCallback(y, ctx());
  assert.match(calls.filter((c) => c.m === "answer").at(-1).text, /already used/);

  await u.handleCallback(`av:${id}:1`, ctx());
  assert.match(calls.at(-1).text, /Switch to DRY RUN\?/);
  assert.equal(process.env.DRY_RUN, "false", "back to DRY also needs the confirm");
  await u.handleCallback(yData(calls.at(-1)), ctx());
  assert.equal(process.env.DRY_RUN, "true");
  assert.equal(readJson(USER_CFG).dryRun, true);
});

test("risk-raising edits need a confirm; risk-reducing ones apply in one tap", async () => {
  const { u, calls, svc } = makeUI();
  const tapThroughConfirm = async () => u.handleCallback(yData(calls.at(-1)), ctx());

  // More positions → confirm; fewer → one tap.
  const mp = svc.find("maxPositions");
  config.risk.maxPositions = 2;
  await u.handleCallback(`ai:${mp.id}`, ctx());
  await u.handleMessage("4", { chatId: OWNER });
  assert.match(calls.at(-1).text, /Raise risk\?[\s\S]*raises max positions/);
  assert.equal(config.risk.maxPositions, 2);
  const card = calls.at(-1);
  await u.handleCallback(yData(card), ctx(card.message_id));
  assert.equal(config.risk.maxPositions, 4);
  await u.handleCallback(`ai:${mp.id}`, ctx());
  await u.handleMessage("1", { chatId: OWNER });
  assert.equal(config.risk.maxPositions, 1, "one tap");

  // Entry guard off → confirm.
  config.entryFilters.blockTransferHook = true;
  const hook = svc.find("blockTransferHook");
  await u.handleCallback(`av:${hook.id}:0`, ctx());
  assert.match(calls.at(-1).text, /entry-safety guard/);
  assert.equal(config.entryFilters.blockTransferHook, true);
  await tapThroughConfirm();
  assert.equal(config.entryFilters.blockTransferHook, false);
  await u.handleCallback(`av:${hook.id}:1`, ctx());
  assert.equal(config.entryFilters.blockTransferHook, true, "turning a guard on is one tap");

  // Wider stop / trailing off / bigger size / lower gas reserve → confirm.
  config.management.stopLossPct = -10;
  config.management.trailingTakeProfit = true;
  assert.equal(svc.risk(svc.find("stopLossPct"), -20).length, 1);
  assert.equal(svc.risk(svc.find("stopLossPct"), 0).length, 1);
  assert.deepEqual(svc.risk(svc.find("stopLossPct"), -5), []);
  assert.equal(svc.risk(svc.find("trailingTakeProfit"), false).length, 1);
  assert.equal(svc.risk(svc.find("deployAmountSol"), config.management.deployAmountSol + 1).length, 1);
  assert.equal(svc.risk(svc.find("maxDeployAmount"), config.risk.maxDeployAmount + 1).length, 1);
  assert.equal(svc.risk(svc.find("gasReserve"), 0.01).length, 1);
  assert.deepEqual(svc.risk(svc.find("minTvl"), 1), [], "screening thresholds are one tap");
});

test("gmgn-config keys persist to gmgn-config.json (other keys kept), user-config untouched", async () => {
  const { u, calls, svc } = makeUI();
  const e = svc.entries.find((x) => x.key === "minHolders" && x.file === "gmgn");
  const userBefore = fs.readFileSync(USER_CFG, "utf8");
  await u.handleCallback(`ai:${e.id}`, ctx());
  await u.handleMessage("2500", { chatId: OWNER });
  const g = readJson(GMGN_CFG);
  assert.equal(g.minHolders, 2500);
  assert.equal(g.apiKey, "SECRET-GMGN", "API key kept");
  assert.equal(fs.readFileSync(GMGN_CFG, "utf8"), JSON.stringify(g, null, 2));
  assert.equal(config.gmgn.minHolders, 2500, "applied live");
  assert.equal(fs.readFileSync(USER_CFG, "utf8"), userBefore);
  assert.match(calls.at(-1).text, /File: gmgn-config\.json/);

  // A corrupt gmgn-config.json is not overwritten (it holds the API key).
  fs.writeFileSync(GMGN_CFG, "{ not json");
  await u.handleCallback(`ai:${e.id}`, ctx());
  await u.handleMessage("3000", { chatId: OWNER });
  assert.match(calls.at(-1).text, /Not changed: could not save gmgn-config\.json/);
  assert.equal(fs.readFileSync(GMGN_CFG, "utf8"), "{ not json");
  assert.equal(config.gmgn.minHolders, 2500);
  fs.writeFileSync(GMGN_CFG, JSON.stringify(g, null, 2));
});

test("restart-only keys say so and are not applied live", async () => {
  const { u, calls, svc } = makeUI();
  const e = svc.find("llmProvider");
  const envBefore = process.env.LLM_PROVIDER;
  await u.handleCallback(`ak:${e.id}`, ctx());
  assert.match(calls.at(-1).text, /applies after a restart/);
  await u.handleCallback(`av:${e.id}:${e.enum.indexOf("claude")}`, ctx());
  assert.equal(readJson(USER_CFG).llmProvider, "claude");
  assert.equal(process.env.LLM_PROVIDER, envBefore);
  assert.match(calls.at(-1).text, /Applies after a restart/);
  const port = svc.find("webPort");
  const portBefore = config.web.port;
  svc.apply(port, 4000);
  assert.equal(config.web.port, portBefore);
});

test("owner-only: a stranger's All-settings taps or typed values never reach the UI", async () => {
  const apiCalls = [];
  tg.__setTelegramTestHooks({ token: "TEST", owner: OWNER, allowlist: "", fetch: async (url) => { apiCalls.push(String(url)); return { ok: true, json: async () => ({ ok: true, result: {} }) }; } });
  const { u, svc } = makeUI();
  const h = { onCallback: (d, c) => u.handleCallback(d, c), onMessage: (t, c) => u.handleMessage(t, c) };
  const before = fs.readFileSync(USER_CFG, "utf8");
  const id = idOf(svc, "dryRun");
  for (const d of ["as", `av:${id}:0`, `ai:${idOf(svc, "minTvl")}`]) {
    const upd = { update_id: 1, callback_query: { id: "x", data: d, from: { id: 999 }, message: { message_id: 9, chat: { id: 999, type: "private" } } } };
    assert.equal((await tg.processUpdate(upd, h)).handled, false, d);
  }
  const msg = { update_id: 2, message: { message_id: 7, text: "123", chat: { id: 999, type: "private" }, from: { id: 999, is_bot: false } } };
  assert.equal((await tg.processUpdate(msg, h)).handled, false);
  assert.equal(fs.readFileSync(USER_CFG, "utf8"), before);
  assert.equal(process.env.DRY_RUN, "true");
  assert.equal(apiCalls.length, 0);
});

test("candle range-depth keys are listed (ohlcvTiers is structured, so hidden)", () => {
  const { svc } = makeService();
  const mode = svc.find("rangeDepthMode");
  assert.equal(mode.type, "enum");
  assert.deepEqual(mode.enum, ["ohlcv", "volatility"]);
  assert.equal(mode.group, "strat");
  assert.equal(svc.current(mode), "ohlcv");
  assert.equal(svc.find("ohlcvBufferMult").type, "number");
  assert.equal(svc.current(svc.find("ohlcvBufferMult")), 1.3);
  assert.equal(svc.current(svc.find("solanaTrackerDailyCap")), 60);
  assert.ok(svc.validate(svc.find("ohlcvBufferMult"), "5").error, "above the bound");
  assert.equal(svc.find("ohlcvTiers"), null);
});
