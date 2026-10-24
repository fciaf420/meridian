// Telegram settings console + profile switching + auto-tune opt-in. Temp files and mocks only.
import "./_bootstrap.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-console-"));
const USER_CFG = path.join(TMP, "user-config.json");
const GMGN_CFG = path.join(TMP, "gmgn-config.json");
fs.writeFileSync(USER_CFG, JSON.stringify({ stopLossPct: -15, takeProfitFeePct: 12, maxPositions: 3, dryRun: true, walletKey: "SECRET-WALLET", _lastEvolved: "x" }, null, 2));
fs.writeFileSync(GMGN_CFG, "{}");
process.env.MERIDIAN_USER_CONFIG_PATH = USER_CFG;
process.env.MERIDIAN_GMGN_CONFIG_PATH = GMGN_CFG;
process.env.WALLET_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
process.env.RPC_URL = "http://127.0.0.1:9";
delete process.env.TELEGRAM_BOT_TOKEN;
process.chdir(TMP);
process.env.MERIDIAN_DATA_DIR = TMP; // this file works in its own cwd
delete process.env.MERIDIAN_LOG_DIR;
test.after(() => { process.env.DRY_RUN = "true"; fs.rmSync(TMP, { recursive: true, force: true }); });

const cfgMod = await import("../config.js");
const { config } = cfgMod;
const es = await import("../tools/entry-safety.js");
const as = await import("../all-settings.js");
const ui = await import("../telegram-ui.js");
const sc = await import("../settings-console.js");

const OWNER = "111";
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const kb = (c) => c?.extra?.reply_markup?.inline_keyboard || [];
const datas = (k) => k.flat().map((b) => b.callback_data).filter(Boolean);
const ctx = (messageId = 42) => ({ chatId: OWNER, fromId: OWNER, messageId, callbackId: "cq" });

function makeUI() {
  const calls = [];
  let id = 800;
  const t = {
    sendHTML: async (text, x = {}) => { calls.push({ m: "send", text, extra: x }); return { message_id: ++id, chat: { id: Number(OWNER) } }; },
    editHTML: async (messageId, text, x = {}) => { calls.push({ m: "edit", messageId, text, extra: x }); return true; },
    answerCallback: async () => true,
  };
  const scheduled = [];
  const svc = as.createAllSettings({
    config, lockedKeys: cfgMod.LOCKED_KEYS, integerKeys: cfgMod.INTEGER_KEYS,
    persistUserConfig: cfgMod.persistUserConfig, persistGmgnConfig: cfgMod.persistGmgnConfig,
    entryFilters: { normalize: es.normalizeEntryFilterValue, isLoosening: es.isLooseningChange },
  });
  const profiles = sc.createProfileService({ config, switchProfile: cfgMod.switchProfile, currentGovernedValues: cfgMod.currentGovernedValues, onScheduleChange: (k, v) => scheduled.push([k, v]) });
  const u = ui.createTelegramUI({
    tg: t, config, usdcModeEnabled: () => false, buildSettingsReport: () => "report", getStatusInfo: () => ({}),
    setEntryFilter: () => ({ ok: true, text: "x" }), allSettings: svc, profiles, settingSource: cfgMod.settingSource, now: () => 9_000_000, log: () => {},
  });
  return { u, calls, svc, scheduled };
}

test("console: one message, Basics first, tuning/advanced collapsed, secrets never shown", async () => {
  const { u, calls } = makeUI();
  await u.handleCallback("k0", ctx());
  const c = calls.at(-1);
  assert.equal(c.m, "edit", "edited in place, not a new message");
  assert.match(c.text, /Settings console/);
  assert.ok(c.text.indexOf("Basics") < c.text.indexOf("Tuning") && c.text.indexOf("Tuning") < c.text.indexOf("Advanced"));
  assert.match(c.text, /Mode: <b>DRY RUN<\/b> · Profile: <b>custom<\/b>/);
  assert.match(c.text, /LLM provider.*⟳/, "restart-required flag shown");
  assert.match(c.text, /\.env only/);
  const d = datas(kb(c));
  for (const want of ["kp", "kt", "as", "se:0", "m"]) assert.ok(d.includes(want), want);
  assert.ok(!/SECRET-WALLET/.test(c.text));
  for (const x of d) assert.ok(Buffer.byteLength(x) <= 64, x);
});

test("tuning index and every section render within limits and list only governed keys", async () => {
  const { u, calls } = makeUI();
  await u.handleCallback("kt", ctx());
  const idx = calls.at(-1);
  const secs = datas(kb(idx)).filter((x) => x.startsWith("kt:"));
  assert.equal(secs.length, sc.TUNING_SECTIONS.length);
  let total = 0;
  for (const s of secs) {
    await u.handleCallback(s, ctx());
    const v = calls.at(-1);
    assert.ok(v.text.length < 4096);
    total += datas(kb(v)).filter((x) => x.startsWith("ak:")).length;
  }
  // governed minus the two that live in Basics (maxPositions, positionSizePct)
  assert.equal(total, (await import("../settings-schema.js")).GOVERNED_KEYS.length - 2);
});

test("profile switch: diff + confirm first; confirm persists, drops overrides, applies live", async () => {
  const { u, calls } = makeUI();
  await u.handleCallback("kp", ctx());
  assert.match(calls.at(-1).text, /untested starting point/);
  await u.handleCallback("kq:degen", ctx());
  const card = calls.at(-1);
  assert.match(card.text, /Switch profile: custom → degen/);
  assert.match(card.text, /untested starting point/);
  assert.match(card.text, /stopLossPct/);
  assert.equal(config.profile, "custom", "nothing changes on the first tap");
  assert.equal(readJson(USER_CFG).profile, undefined);
  const y = datas(kb(card)).find((x) => x.startsWith("y:"));
  await u.handleCallback(y, ctx());
  assert.equal(config.profile, "degen");
  assert.equal(config.management.stopLossPct, -25);
  assert.equal(config.risk.maxPositions, 4);
  const file = readJson(USER_CFG);
  assert.equal(file.profile, "degen");
  assert.ok(!("stopLossPct" in file) && !("maxPositions" in file), "governed overrides dropped");
  assert.equal(file.dryRun, true, "non-governed keys untouched");
  assert.match(calls.at(-1).text, /Profile is now <b>degen<\/b>/);
  // replayed nonce can't switch again
  await u.handleCallback(y, ctx());
  assert.equal(config.profile, "degen");
});

test("profile switch to custom pins current effective values (no behavior change)", async () => {
  const { u, calls } = makeUI();
  const before = cfgMod.currentGovernedValues();
  await u.handleCallback("kq:custom", ctx());
  const y = datas(kb(calls.at(-1))).find((x) => x.startsWith("y:"));
  await u.handleCallback(y, ctx());
  assert.equal(config.profile, "custom");
  assert.deepEqual(cfgMod.currentGovernedValues(), before);
  const file = readJson(USER_CFG);
  assert.equal(file.profile, "custom");
  assert.equal(file.stopLossPct, -25);
  assert.equal(cfgMod.settingSource("stopLossPct"), "user");
});

test("a manual change under a profile is an override (✎) and survives reload; cancel leaves the profile alone", async () => {
  const { u, calls, svc } = makeUI();
  cfgMod.switchProfile("balanced");
  const e = svc.find("takeProfitFeePct");
  await u.handleCallback(`av:${e.id}:0`, ctx()).catch(() => {});
  cfgMod.persistUserConfig({ takeProfitFeePct: 9 });
  cfgMod.reloadScreeningThresholds();
  assert.equal(config.management.takeProfitFeePct, 9);
  assert.equal(cfgMod.settingSource("takeProfitFeePct"), "user");
  assert.equal(cfgMod.settingSource("stopLossPct"), "profile");
  await u.handleCallback("kt:exit", ctx());
  assert.match(calls.at(-1).text, /takeProfitFeePct<\/code> = <b>9%<\/b> ✎/);
  await u.handleCallback("kq:conservative", ctx());
  const n = datas(kb(calls.at(-1))).find((x) => x.startsWith("n:"));
  await u.handleCallback(n, ctx());
  assert.equal(config.profile, "balanced");
});

test("unknown profile tap is refused", async () => {
  const { u, calls } = makeUI();
  const n = calls.length;
  await u.handleCallback("kq:yolo", ctx());
  assert.equal(calls.length, n);
  assert.equal(config.profile === "yolo", false);
});

test("a private key typed into the chat is refused, never stored, never forwarded", async () => {
  const { u, calls, svc } = makeUI();
  const e = svc.find("category");
  await u.handleCallback(`ai:${e.id}`, ctx());
  const key = bs58.encode(Keypair.generate().secretKey);
  const handled = await u.handleMessage(key, { chatId: OWNER });
  assert.equal(handled, true);
  assert.match(calls.at(-1).text, /private key/);
  assert.ok(!calls.at(-1).text.includes(key));
  assert.notEqual(config.screening.category, key);
  assert.ok(!fs.readFileSync(USER_CFG, "utf8").includes(key));
  const A = { awaiting: true };
  assert.equal(sc.looksLikeSecret("[" + Array.from({ length: 64 }, (_, i) => i).join(",") + "]", A), true);
  assert.equal(sc.looksLikeSecret(key, A), true);
  assert.equal(sc.looksLikeSecret("0.5", A), false);
  assert.equal(sc.looksLikeSecret("So11111111111111111111111111111111111111112", A), false);
  // review PR131 #1: high-confidence key shapes are refused even in free chat; a tx signature never is
  assert.equal(sc.looksLikeSecret(key), true);
  assert.equal(sc.looksLikeSecret("["+Array.from({ length: 64 }, (_, i) => i).join(",")+"]"), true);
  assert.equal(sc.looksLikeSecret("ab".repeat(64)), true);
  assert.equal(sc.looksLikeSecret("ab".repeat(32)), false);
  const sig = bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256));
  assert.ok(sig.length >= 86 && sig.length <= 88);
  assert.equal(sc.looksLikeSecret(sig, A), false);
  assert.equal(sc.looksLikeSecret(sig), false);
});

test("LLM provider is the only Basics key flagged restart; secrets never in the registry", async () => {
  const { svc } = makeUI();
  const restartBasics = sc.BASIC_KEYS.map((k) => svc.find(k)).filter((e) => e?.restart).map((e) => e.key);
  assert.deepEqual(restartBasics, ["llmProvider"]);
  for (const e of svc.entries) assert.ok(!as.SECRET_KEY_RE.test(e.key), e.key);
  assert.equal(svc.find("profile"), null, "profile is switched only through the diff+confirm flow");
});

// ─── auto-tune opt-in ───────────────────────────────────────────
test("lessons: evolution only proposes (and logs) unless autoTune is on; explicit calls still apply", async () => {
  const lessons = await import("../lessons.js");
  const st = await import("../config-state.js");
  // The "AMERICA" shape from test-trailing-evolution: five non-winners, two peaked in [2.5, 5) => trailingTriggerPct rule fires.
  let n = 0;
  const rec = (pnl_pct, peak_pnl_pct) => ({ position: `p${++n}`, pool: `pool${n}`, pnl_pct, peak_pnl_pct, trailing_trigger_pct: 5, trailing_drop_pct: 4, trailing_armed_pct: null, trailing_exit: false, in_range_at_close: true, fees_earned_usd: 1, close_reason: "agent decision" });
  const perf = [rec(-3.76, 2.67), rec(-2.1, 3.4), rec(-5, 0.4), rec(0.3, 0.8), rec(-1.5, 0.2), rec(4, 6.5)];
  const mk = () => ({ screening: {}, management: { trailingTakeProfit: true, trailingTriggerPct: 5, trailingDropPct: 4, takeProfitFeePct: 15, stopLossPct: -40 }, strategy: {} });
  fs.writeFileSync(USER_CFG, JSON.stringify({ profile: "custom", minOrganic: 60 }, null, 2));
  const before = fs.readFileSync(USER_CFG, "utf8");
  const off = lessons.evolveThresholds(perf, mk(), { apply: false });
  assert.equal(fs.readFileSync(USER_CFG, "utf8"), before, "user-config.json untouched when propose-only");
  assert.ok(off, "the analysis ran");
  assert.deepEqual(off.changes, {});
  assert.ok(off.proposed && Object.keys(off.proposed).length > 0, "a rule fired, so there is something to propose");
  assert.ok(st.readConfigState().lastProposal, "proposal recorded in config-state.json");
  assert.equal(st.readConfigState().positionsAtEvolution, perf.length, "counter lives in config-state.json");
  assert.ok(!("_positionsAtEvolution" in readJson(USER_CFG)));
  // An explicit owner command (default apply) still writes the same changes.
  const on = lessons.evolveThresholds(perf, mk(), {});
  assert.deepEqual(Object.keys(on.changes).sort(), Object.keys(off.proposed).sort());
  for (const [k, v] of Object.entries(on.changes)) assert.equal(readJson(USER_CFG)[k], v);
});

test("nit3: a tx signature in normal chat is not refused (no pending input)", async () => {
  const { u, calls } = makeUI();
  const sig = bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 53 + 7) % 256));
  const n = calls.length;
  await u.handleMessage(sig, { chatId: OWNER }).catch(() => {});
  assert.ok(!calls.slice(n).some((c) => /private key/.test(c.text || "")));
});

test("nit5: turning autoTune ON needs the risk confirm; turning it off is one tap", () => {
  const { svc } = makeUI();
  const e = svc.find("autoTune");
  assert.ok(e);
  assert.ok(svc.risk(e, true).length > 0);
  assert.equal(svc.risk(e, false).length, 0);
});

test("review PR131 #1: a real private key in normal chat is refused and never reaches the LLM", async () => {
  const { u, calls } = makeUI();
  const key = bs58.encode(Keypair.generate().secretKey);
  const n = calls.length;
  const handled = await u.handleMessage(key, { chatId: OWNER });
  assert.equal(handled, true);
  assert.ok(calls.slice(n).some((c) => /private key/.test(c.text || "")));
  assert.ok(!calls.slice(n).some((c) => (c.text || "").includes(key)));
});

test("final review nit: switching bidAskFlip mode to live needs the risk confirm; off/shadow are one tap", () => {
  const { svc } = makeUI();
  const e = svc.find("bidAskFlipMode");
  assert.ok(e);
  assert.ok(svc.risk(e, "live").length > 0);
  assert.equal(svc.risk(e, "shadow").length, 0);
  assert.equal(svc.risk(e, "off").length, 0);
});
