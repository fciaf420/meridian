// Token-age window (config.screening.minTokenAgeHours / maxTokenAgeHours) for
// every screening source and every deploy strategy, plus the Telegram confirm
// card. Age data is mocked: no Meteora API, no gmgn-cli, no RPC, no transaction
// (DRY_RUN is forced; the refusals under test happen before any pool load).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-age-"));
const USER_CFG = path.join(TMP, "user-config.json");
fs.writeFileSync(USER_CFG, JSON.stringify({ minTokenAgeHours: 2, maxTokenAgeHours: 72 }, null, 2));
process.env.MERIDIAN_USER_CONFIG_PATH = USER_CFG;
process.env.WALLET_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
process.env.RPC_URL = "http://127.0.0.1:9"; // never reached
process.env.DRY_RUN = "true";
delete process.env.HELIUS_API_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;
process.chdir(TMP);
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const age = await import("../tools/token-age.js");
const es = await import("../tools/entry-safety.js");
const { config } = await import("../config.js");
const dlmm = await import("../tools/dlmm.js");
const { condensePool } = await import("../tools/screening.js");

const NOW = Date.now();
const H = 3_600_000;
const WSOL = "So11111111111111111111111111111111111111112";
const OTC_MINT = "MukLDtJ8Cx9DxLbeyLRSWPSposTMWuwHANbuaudpump";
const OTC_POOL = "Ekm4LYkihEdQgZx2UReDMJ3eCDDjExPQLG94WfWmfyWr";
const WINDOW = { min: 2, max: 72 };

/** A Meteora pool-discovery row, condensed exactly as discoverPools() does. */
function meteoraCandidate(name, mint, ageHours) {
  return condensePool({
    pool_address: `Pool${name}`.padEnd(44, "1"),
    name: `${name}-SOL`,
    token_x: {
      symbol: name, address: mint, organic_score: 80, market_cap: 2e6,
      token_program: es.TOKEN_PROGRAM_ID, has_freeze_authority: false, has_mint_authority: false,
      created_at: ageHours == null ? undefined : NOW - ageHours * H,
    },
    token_y: { symbol: "SOL", address: WSOL },
    pool_type: "dlmm",
    dlmm_params: { bin_step: 100, collect_fee_mode: "quote" },
    tvl: 20_000, active_tvl: 20_000, volume: 5e4, fee: 100, fee_active_tvl_ratio: 0.5, volatility: 3,
  });
}

const noMints = async () => new Map();
const logs = [];
const origLog = console.log;
function captureLogs(fn) {
  logs.length = 0;
  console.log = (...a) => { logs.push(a.join(" ")); };
  return Promise.resolve().then(fn).finally(() => { console.log = origLog; });
}

// ─── Pure helpers ────────────────────────────────────────────────
test("window evaluation: too young, too old, inside, unknown, no window", () => {
  assert.equal(age.evaluateTokenAgeWindow(96, WINDOW).reason, "token age 96h > 72h max");
  assert.equal(age.evaluateTokenAgeWindow(1.5, WINDOW).reason, "token age 1.5h < 2h min");
  assert.equal(age.evaluateTokenAgeWindow(10, WINDOW).pass, true);
  const unk = age.evaluateTokenAgeWindow(null, WINDOW);
  assert.equal(unk.pass, null);
  assert.equal(unk.unknown, true);
  assert.equal(age.evaluateTokenAgeWindow(9999, null).pass, true, "no window configured = no filter");
  assert.deepEqual(age.tokenAgeWindow({ minTokenAgeHours: null, maxTokenAgeHours: null }), null);
  assert.equal(age.toEpochMs(1787923888), 1787923888000, "epoch seconds → ms");
  assert.equal(age.toEpochMs(1787923888000), 1787923888000);
});

test("condensePool carries token_x.created_at (token creation, not pool_created_at)", () => {
  const c = condensePool({ pool_address: "P", token_x: { address: "M", created_at: 111 }, pool_created_at: 999, token_y: {} });
  assert.equal(c.base.created_at, 111);
});

// ─── Screening (the filter getTopCandidates runs on every source) ─
test("screening: a too-old Meteora candidate is dropped with the entry-filter log line", async () => {
  age._setTokenAgeDepsForTest({ fetchPoolRow: async () => { throw new Error("must not fetch"); }, fetchGmgnTokenInfo: async () => { throw new Error("must not fetch"); } });
  const pools = [meteoraCandidate("OLD", "MintOld1111111111111111111111111111111111", 96)];
  const r = await captureLogs(() => es.screenEntryCandidates(pools, { filters: es.ENTRY_FILTER_DEFAULTS, readMints: noMints, tokenAge: { window: WINDOW } }));
  assert.equal(r.kept.length, 0);
  assert.deepEqual(r.dropped[0].reasons, ["token age 96h > 72h max"]);
  assert.ok(logs.some((l) => /Entry filter dropped OLD-SOL: token age 96h > 72h max/.test(l)), logs.join("\n"));
});

test("screening: a too-young Meteora candidate is dropped", async () => {
  const pools = [meteoraCandidate("NEW", "MintNew1111111111111111111111111111111111", 1)];
  const r = await captureLogs(() => es.screenEntryCandidates(pools, { filters: es.ENTRY_FILTER_DEFAULTS, readMints: noMints, tokenAge: { window: WINDOW } }));
  assert.equal(r.kept.length, 0);
  assert.deepEqual(r.dropped[0].reasons, ["token age 1h < 2h min"]);
  assert.ok(logs.some((l) => /Entry filter dropped NEW-SOL: token age 1h < 2h min/.test(l)));
});

test("screening: an in-window candidate passes, tagged with its age and source", async () => {
  const pools = [meteoraCandidate("MID", "MintMid1111111111111111111111111111111111", 10)];
  const r = await es.screenEntryCandidates(pools, { filters: es.ENTRY_FILTER_DEFAULTS, readMints: noMints, tokenAge: { window: WINDOW } });
  assert.equal(r.kept.length, 1);
  assert.equal(r.dropped.length, 0);
  assert.ok(Math.abs(r.kept[0].token_age_hours - 10) < 0.05);
  assert.equal(r.kept[0].token_age_source, "meteora");
  assert.equal(r.kept[0].token_age_unknown, false);
});

test("screening: unknown age (no created_at, lookup finds nothing) is kept and marked unknown", async () => {
  const looked = [];
  const pools = [meteoraCandidate("UNK", "MintUnk1111111111111111111111111111111111", null)];
  const r = await es.screenEntryCandidates(pools, {
    filters: es.ENTRY_FILTER_DEFAULTS, readMints: noMints,
    tokenAge: { window: WINDOW, lookup: async (mint) => { looked.push(mint); return { hours: null, source: null }; } },
  });
  assert.deepEqual(looked, ["MintUnk1111111111111111111111111111111111"], "one lookup for the row with no age");
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].token_age_unknown, true);
  assert.equal(r.kept[0].token_age_hours, null);
});

test("screening: a row without created_at uses the looked-up age (GMGN) and is filtered by it", async () => {
  const pools = [meteoraCandidate("LKP", "MintLkp1111111111111111111111111111111111", null)];
  const r = await es.screenEntryCandidates(pools, {
    filters: es.ENTRY_FILTER_DEFAULTS, readMints: noMints,
    tokenAge: { window: WINDOW, lookup: async () => ({ hours: 200, source: "gmgn" }) },
  });
  assert.equal(r.kept.length, 0);
  assert.match(r.dropped[0].reasons[0], /token age 200h > 72h max/);
});

test("screening: GMGN-source and merged (both) candidates use the same window", async () => {
  const gmgnOnly = { pool: "PoolG", name: "GGG-SOL", base: { mint: "MintG", token_program: es.TOKEN_PROGRAM_ID, has_freeze_authority: false, has_mint_authority: false }, token_age_hours: 100, gmgn: true, sources: ["gmgn"] };
  // Merged row: Meteora base.created_at (5h) wins over the grafted GMGN token_age_hours.
  const merged = { ...meteoraCandidate("BTH", "MintB", 5), token_age_hours: 500, sources: ["meteora", "gmgn"], confirmed_by_both: true };
  const r = await es.screenEntryCandidates([gmgnOnly, merged], { filters: es.ENTRY_FILTER_DEFAULTS, readMints: noMints, tokenAge: { window: WINDOW } });
  assert.deepEqual(r.kept.map((p) => p.name), ["BTH-SOL"]);
  assert.match(r.dropped[0].reasons[0], /token age 100h > 72h max/);
});

test("screening: the default window comes from config.screening (user-config min/maxTokenAgeHours)", async () => {
  assert.equal(config.screening.minTokenAgeHours, 2);
  assert.equal(config.screening.maxTokenAgeHours, 72);
  const r = await es.screenEntryCandidates([meteoraCandidate("CFG", "MintCfg", 96)], { filters: es.ENTRY_FILTER_DEFAULTS, readMints: noMints });
  assert.equal(r.kept.length, 0);
});

// ─── Lookup sources and cache ────────────────────────────────────
test("getTokenAgeInfo: Meteora token_x.created_at first, GMGN creation_timestamp fallback, cached", async () => {
  let gmgnCalls = 0;
  age._setTokenAgeDepsForTest({
    now: () => NOW,
    fetchPoolRow: async (pool) => (pool === OTC_POOL ? { token_x: { address: OTC_MINT, created_at: NOW - 682 * H } } : null),
    fetchGmgnTokenInfo: async () => { gmgnCalls++; return { creation_timestamp: Math.floor((NOW - 30 * H) / 1000), open_timestamp: Math.floor((NOW - 29 * H) / 1000) }; },
  });
  const otc = await age.getTokenAgeInfo(OTC_MINT, { pool: OTC_POOL });
  assert.equal(otc.hours, 682);
  assert.equal(otc.source, "meteora");
  assert.equal(gmgnCalls, 0);
  const g = await age.getTokenAgeInfo("MintGmgnOnly");
  assert.equal(g.hours, 30, "creation_timestamp preferred over open_timestamp");
  assert.equal(g.source, "gmgn");
  await age.getTokenAgeInfo("MintGmgnOnly");
  assert.equal(gmgnCalls, 1, "second read is served from the cache");
  age._setTokenAgeDepsForTest({ fetchPoolRow: async () => null, fetchGmgnTokenInfo: async () => null });
  assert.equal((await age.getTokenAgeInfo("MintNothing", { pool: "PoolX" })).hours, null);
});

// ─── Deploy (every strategy) ─────────────────────────────────────
function mockAgeSource(hours) {
  age._setTokenAgeDepsForTest({
    fetchPoolRow: async () => (hours == null ? null : { token_x: { address: OTC_MINT, created_at: NOW - hours * H } }),
    fetchGmgnTokenInfo: async () => null,
  });
}
const deploy = (args = {}) => dlmm.deployPosition({ pool_address: OTC_POOL, base_mint: OTC_MINT, amount_y: 0.5, strategy: "bid_ask", price_range_pct: 50, bin_step: 100, ...args });

test("deploy: classic bid_ask refuses a token older than maxTokenAgeHours (the OTC case)", async () => {
  config.strategy.activeStrategy = "classic";
  mockAgeSource(682);
  const r = await deploy();
  assert.equal(r.success, false);
  assert.equal(r.blocked_by, "token_age");
  assert.match(r.error, /^Token age: token age 682h > 72h max \(window 2h–72h.*source meteora\); refusing to deploy\.$/);
  assert.equal(r.dry_run, undefined, "refused before the dry-run plan");
});

test("deploy: classic spot refuses a token younger than minTokenAgeHours", async () => {
  config.strategy.activeStrategy = "classic";
  mockAgeSource(1);
  const r = await deploy({ strategy: "spot" });
  assert.equal(r.blocked_by, "token_age");
  assert.match(r.error, /token age 1h < 2h min/);
});

test("deploy: an in-window token and an unknown age both proceed (unknown logs a warning)", async () => {
  config.strategy.activeStrategy = "classic";
  mockAgeSource(10);
  const ok = await deploy();
  assert.equal(ok.dry_run, true);
  mockAgeSource(null);
  const unk = await captureLogs(() => deploy());
  assert.equal(unk.dry_run, true);
  assert.ok(logs.some((l) => /Token age unknown for MukLDtJ8/.test(l)), logs.join("\n"));
});

test("deploy: no window configured means no lookup at all", async () => {
  const saved = { min: config.screening.minTokenAgeHours, max: config.screening.maxTokenAgeHours };
  config.screening.minTokenAgeHours = null;
  config.screening.maxTokenAgeHours = null;
  age._setTokenAgeDepsForTest({ fetchPoolRow: async () => { throw new Error("must not fetch"); }, fetchGmgnTokenInfo: async () => { throw new Error("must not fetch"); } });
  try {
    assert.equal((await deploy()).dry_run, true);
  } finally {
    config.screening.minTokenAgeHours = saved.min;
    config.screening.maxTokenAgeHours = saved.max;
  }
});

test("deploy: Evil Panda is refused by the same age check, before its GMGN gate", async () => {
  config.strategy.activeStrategy = "evil_panda";
  mockAgeSource(682);
  try {
    const r = await deploy({ strategy: "spot" });
    assert.equal(r.blocked_by, "token_age");
    assert.match(r.error, /token age 682h > 72h max/);
  } finally {
    config.strategy.activeStrategy = "classic";
  }
});

// ─── Telegram confirm card ───────────────────────────────────────
const ui = await import("../telegram-ui.js");

function makeUI(over = {}) {
  const edits = [];
  let id = 500;
  const tg = {
    sendHTML: async (text, extra = {}) => { edits.push({ text, extra }); return { message_id: ++id, chat: { id: 111 } }; },
    editHTML: async (messageId, text, extra = {}) => { edits.push({ messageId, text, extra }); return true; },
    answerCallback: async () => true,
  };
  const candidate = { pool: OTC_POOL, name: "OTC-SOL", bin_step: 100, volatility: 3.5, fee_active_tvl_ratio: 0.1, base: { mint: OTC_MINT, created_at: NOW - 682 * H }, token_age_hours: 682, token_age_source: "meteora" };
  const u = ui.createTelegramUI({
    tg,
    config: {
      management: { gasReserve: 0.2 }, risk: { maxDeployAmount: 5 },
      screening: { source: "both", minTokenAgeHours: 2, maxTokenAgeHours: 72 },
      strategy: { activeStrategy: "evil_panda", strategy: "bid_ask", evilPanda: { priceRangePct: 80 } },
      usdc: { enabled: false }, schedule: {},
    },
    computeDeployAmount: () => 1,
    usdcModeEnabled: () => false,
    getWalletBalances: async () => ({ sol: 4 }),
    getMyPositions: async () => ({ positions: [] }),
    getTopCandidates: async () => ({ candidates: [over.candidate ?? candidate] }),
    executeTool: async () => { throw new Error("must not execute"); },
    tokenAge: async (c) => age.candidateTokenAge(c) ?? { hours: null, source: null },
    now: () => 1_000_000,
    ...over.deps,
  });
  return { u, edits };
}

async function openDeploy(u, edits) {
  const ctx = { chatId: "111", fromId: "111", messageId: 50, callbackId: "cb" };
  await u.handleCallback("ca:0", ctx);
  const dp = edits.at(-1).extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data).find((d) => d?.startsWith("dp:"));
  await u.handleCallback(dp, ctx);
  return edits.at(-1);
}

test("telegram: an out-of-window token is a manual override — warning shown, Confirm kept", async () => {
  const { u, edits } = makeUI();
  const card = await openDeploy(u, edits);
  assert.match(edits[0].text, /age 682h/);
  assert.match(card.text, /Deploy into this pool\?/);
  assert.match(card.text, /⚠️ Token age: 682h — outside your 2h–72h window \(manual deploy, not blocked · meteora\)/);
  const data = card.extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.some((d) => d?.startsWith("y:")), "confirm button kept");
});

test("telegram: in-window and unknown ages reach the confirm card with the age line", async () => {
  const young = makeUI({ candidate: { pool: OTC_POOL, name: "OK-SOL", bin_step: 100, base: { mint: OTC_MINT, created_at: NOW - 10 * H } } });
  const card = await openDeploy(young.u, young.edits);
  assert.match(card.text, /Deploy into this pool\?/);
  assert.match(card.text, /✅ Token age: 10h \(window 2h–72h · meteora\)/);

  const unk = makeUI({ candidate: { pool: OTC_POOL, name: "UNK-SOL", bin_step: 100, base: { mint: OTC_MINT } } });
  const c2 = await openDeploy(unk.u, unk.edits);
  assert.match(c2.text, /Deploy into this pool\?/);
  assert.match(c2.text, /❔ Token age: unknown .* deploy_position allows it/);
});

test("telegram: /token lookup's age check says a manual deploy is allowed", () => {
  const lines = ui.failedFilterLines({ checks: { token: [{ key: "age", pass: false, text: "age 682h (2h–72h)" }], pool: [] } });
  assert.deepEqual(lines, ["❌ age 682h (2h–72h) (outside your age window — the bot skips it, but a manual deploy is allowed)"]);
});

test("executeTool honours _manual only for owner-initiated deploys", async () => {
  const src = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(src, /export async function executeTool\(name, args, \{ manual = false \} = \{\}\)/);
  assert.match(src, /args = manual \? \{ \.\.\.rest, _manual: true \} : rest;/);
  const ui = fs.readFileSync(new URL("../telegram-ui.js", import.meta.url), "utf8");
  assert.match(ui, /executeTool\("deploy_position", \{ \.\.\.params\.args \}, \{ manual: true \}\)/);
});
