// Jupiter Tokens API V2 (tools/jup-tokens.js): normalization, datapi fallback,
// cache, the token.js call sites, and the Telegram lines (entry-filter toggle,
// candidate + lookup card). fetch is mocked: no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-jup-"));
fs.writeFileSync(path.join(TMP, "user-config.json"), "{}");
process.env.MERIDIAN_USER_CONFIG_PATH = path.join(TMP, "user-config.json");
process.env.RPC_URL = "http://127.0.0.1:9";
process.env.JUPITER_API_KEY = "test-key";
delete process.env.DRY_RUN;
delete process.env.TELEGRAM_BOT_TOKEN;
process.chdir(TMP);
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const jt = await import("../tools/jup-tokens.js");
const token = await import("../tools/token.js");
const es = await import("../tools/entry-safety.js");
const ui = await import("../telegram-ui.js");
const lookupMod = await import("../tools/token-lookup.js");

const MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const SUS_MINT = "HpceMmjNUKNWwPUob9GdcuhvP45K7hD2DfybV7rw1SVv";

// Shapes taken from a live Tokens V2 /search response (2026-09).
const OFFICIAL = {
  id: MINT, name: "Jupiter", symbol: "JUP", decimals: 6, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  circSupply: 3243891294.88, totalSupply: 6863982654.38, holderCount: 838834, fdv: 2.3e9, mcap: 1154454046.57,
  usdPrice: 0.3477, liquidity: 5688332.3, organicScore: 99.0165, organicScoreLabel: "high", isVerified: true,
  tags: ["verified", "strict"],
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 15.459, devMints: 1 },
  stats5m: { priceChange: 0.1, numTraders: 40 }, stats1h: { priceChange: -1.234, buyVolume: 12345.6, sellVolume: 999, numOrganicBuyers: 50, numNetBuyers: 3 },
  stats6h: { priceChange: 2 }, stats24h: { priceChange: 5.5, buyVolume: 1e6, sellVolume: 9e5, numOrganicBuyers: 900, numNetBuyers: 10 },
};
const SUS = { id: SUS_MINT, name: "", symbol: "USBD", organicScore: 0, organicScoreLabel: "low", isVerified: null, tags: ["unknown"], audit: { isSus: true, devMints: 2902 } };
const DATAPI = { ...OFFICIAL, fees: 1927.32, audit: { ...OFFICIAL.audit, botHoldersPercentage: 0.0017 } };

function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: opts.headers || {} });
    for (const [re, handler] of routes) {
      if (re.test(u)) {
        const r = await handler(u);
        if (r instanceof Error) throw r;
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
      }
    }
    throw new Error(`unmocked ${u}`);
  };
  return calls;
}
const OFFICIAL_RE = /^https:\/\/api\.jup\.ag\/tokens\/v2\/search\?query=/;
const DATAPI_RE = /^https:\/\/datapi\.jup\.ag\/v1\/assets\/search\?query=/;

test("normalizeJupToken: official fields → snake_case; isSus checked by presence; raw organic score", () => {
  const n = jt.normalizeJupToken(OFFICIAL);
  assert.equal(n.mint, MINT);
  assert.equal(n.is_verified, true);
  assert.equal(n.organic_score, 99.0165);
  assert.equal(n.organic_score_label, "high");
  assert.equal(n.is_sus, false);
  assert.equal(n.banned, false);
  assert.equal(n.holder_count, 838834);
  assert.equal(n.mcap, 1154454046.57);
  assert.equal(n.liquidity, 5688332.3);
  assert.equal(n.total_supply, 6863982654.38);
  assert.equal(n.audit.top_holders_pct, 15.459);
  assert.equal(n.stats_1h.price_change, -1.234);
  assert.equal(n.stats_5m.num_traders, 40);
  assert.equal(n.stats_6h.price_change, 2);
  assert.equal(n.global_fees_sol, null); // not in the official API
  assert.equal(n.source, "tokens_v2");

  assert.equal(jt.normalizeJupToken(SUS).is_sus, true);
  // Presence, not value: a present isSus:false still counts as flagged.
  assert.equal(jt.normalizeJupToken({ id: "X", audit: { isSus: false } }).is_sus, true);
  assert.equal(jt.normalizeJupToken({ id: "X", tags: ["Banned"] }).banned, true);
  assert.equal(jt.normalizeJupToken({ id: "X", isVerified: false }).banned, false);
  assert.equal(jt.normalizeJupToken({ id: "X", organicScore: "12.5" }).organic_score, 12.5);
  assert.equal(jt.normalizeJupToken(null), null);
  assert.equal(jt.normalizeJupToken({ name: "no id" }), null);
});

test("searchTokens: official endpoint with the x-api-key header; results cached per mint", async () => {
  jt._resetJupTokensCacheForTest();
  const calls = mockFetch([[OFFICIAL_RE, () => ({ status: 200, body: [OFFICIAL] })]]);
  const list = await jt.searchTokens(MINT);
  assert.equal(list.length, 1);
  assert.equal(list[0].source, "tokens_v2");
  assert.equal(calls[0].url, `https://api.jup.ag/tokens/v2/search?query=${MINT}`);
  assert.equal(calls[0].headers["x-api-key"], "test-key");
  const again = await jt.getTokenInfo(MINT);
  assert.equal(again.mint, MINT);
  assert.equal(calls.length, 1); // served from cache
});

test("searchTokens: falls back to datapi when the official call fails; null when both fail", async () => {
  jt._resetJupTokensCacheForTest();
  let calls = mockFetch([
    [OFFICIAL_RE, () => ({ status: 503, body: { error: "down" } })],
    [DATAPI_RE, () => ({ status: 200, body: [DATAPI] })],
  ]);
  const info = await jt.getTokenInfo(MINT);
  assert.equal(info.source, "datapi");
  assert.equal(info.global_fees_sol, 1927.32);
  assert.equal(info.audit.bot_holders_pct, 0.0017);
  assert.deepEqual(calls.map((c) => new URL(c.url).host), ["api.jup.ag", "datapi.jup.ag"]);

  jt._resetJupTokensCacheForTest();
  mockFetch([[OFFICIAL_RE, () => new Error("ECONNRESET")], [DATAPI_RE, () => ({ status: 200, body: [DATAPI] })]]);
  assert.equal((await jt.getTokenInfo(MINT)).source, "datapi");

  jt._resetJupTokensCacheForTest();
  mockFetch([[OFFICIAL_RE, () => ({ status: 200, body: { unexpected: true } })], [DATAPI_RE, () => new Error("down")]]);
  assert.equal(await jt.searchTokens(MINT), null);
  assert.equal(await jt.getTokenInfo(MINT), null);
  assert.equal(await jt.getTokensInfo([MINT]), null);

  jt._resetJupTokensCacheForTest();
  calls = mockFetch([[OFFICIAL_RE, () => ({ status: 200, body: [] })]]);
  assert.deepEqual(await jt.searchTokens("nothing"), []);
  assert.equal(calls.length, 1); // an empty result is an answer, not a failure
});

test("getTokensInfo: one comma-joined query; unknown mints absent; flags", async () => {
  jt._resetJupTokensCacheForTest();
  const calls = mockFetch([[OFFICIAL_RE, () => ({ status: 200, body: [OFFICIAL, SUS] })]]);
  const map = await jt.getTokensInfo([MINT, SUS_MINT, "Unknown1111", MINT]);
  assert.equal(calls.length, 1);
  assert.equal(decodeURIComponent(calls[0].url.split("query=")[1]), `${MINT},${SUS_MINT},Unknown1111`);
  assert.equal(map.get(SUS_MINT).is_sus, true);
  assert.equal(map.has("Unknown1111"), false);
  assert.deepEqual(jt.jupiterFlagReasons(map.get(SUS_MINT)), ["Jupiter flags the token as suspicious (audit.isSus)"]);
  assert.deepEqual(jt.jupiterFlagReasons(map.get(MINT)), []);
});

test("evaluateJupiterGuard: isSus present blocks, absent passes, unknown allows, guard off allows", () => {
  const on = es.ENTRY_FILTER_DEFAULTS;
  assert.equal(es.evaluateJupiterGuard(jt.normalizeJupToken(SUS), on).pass, false);
  assert.equal(es.evaluateJupiterGuard(jt.normalizeJupToken(OFFICIAL), on).pass, true);
  const unk = es.evaluateJupiterGuard(null, on);
  assert.equal(unk.pass, true);
  assert.equal(unk.unknown, true);
  const off = es.evaluateJupiterGuard(jt.normalizeJupToken(SUS), { ...on, blockJupiterSuspicious: false });
  assert.equal(off.pass, true);
  assert.match(off.check.text, /guard off/);
});

test("token.js getTokenInfo: Tokens API fields + datapi-only global fees; verified/organic exposed", async () => {
  jt._resetJupTokensCacheForTest();
  mockFetch([
    [OFFICIAL_RE, () => ({ status: 200, body: [OFFICIAL] })],
    [DATAPI_RE, () => ({ status: 200, body: [DATAPI] })],
  ]);
  const r = await token.getTokenInfo({ query: MINT });
  assert.equal(r.found, true);
  const t = r.results[0];
  assert.equal(t.mint, MINT);
  assert.equal(t.organic_score, 99.0165);
  assert.equal(t.jup_verified, true);
  assert.equal(t.jup_suspicious, undefined);
  assert.equal(t.holders, 838834);
  assert.equal(t.global_fees_sol, 1927.32);
  assert.equal(t.audit.bot_holders_pct, "0.00");
  assert.equal(t.stats_1h.price_change, "-1.23");
  assert.equal(t.source, "tokens_v2");

  jt._resetJupTokensCacheForTest();
  mockFetch([[OFFICIAL_RE, () => new Error("down")], [DATAPI_RE, () => new Error("down")]]);
  const fail = await token.getTokenInfo({ query: MINT });
  assert.equal(fail.found, false);
  assert.match(fail.error, /unavailable/);
});

test("token.js getTokenNarrative: tolerant of a removed/404 endpoint", async () => {
  mockFetch([[/chaininsight\/narrative/, () => ({ status: 404, body: {} })]]);
  assert.deepEqual(await token.getTokenNarrative({ mint: MINT }), { mint: MINT, narrative: null, status: "unavailable" });
  mockFetch([[/chaininsight\/narrative/, () => new Error("gone")]]);
  assert.equal((await token.getTokenNarrative({ mint: MINT })).narrative, null);
});

test("Telegram: Entry filters screen has the Jupiter scam-flag toggle", () => {
  const t = ui.ENTRY_TOGGLES.find(([, key]) => key === "blockJupiterSuspicious");
  assert.ok(t);
  const on = ui.renderEntryFilters({ ...es.ENTRY_FILTER_DEFAULTS });
  const btns = on.keyboard.flat();
  const b = btns.find((x) => /Jupiter scam flag/.test(x.text));
  assert.equal(b.text, "✅ Jupiter scam flag");
  assert.match(b.callback_data, new RegExp(`et:${t[0]}$`));
  const off = ui.renderEntryFilters({ ...es.ENTRY_FILTER_DEFAULTS, blockJupiterSuspicious: false });
  assert.ok(off.keyboard.flat().some((x) => x.text === "❌ Jupiter scam flag"));
});

test("Telegram: candidate card and token lookup card show Jupiter organic score + verified", async () => {
  const refs = { put: () => "r1" };
  const cands = ui.renderCandidates([
    { pool: "P1", name: "JUP-SOL", darwin_score: 70, bin_step: 100, jupiter: { organic_score: 99, verified: true, sus: false, banned: false } },
    { pool: "P2", name: "X-SOL", darwin_score: 50, bin_step: 100, jupiter: null },
  ], { refs });
  assert.match(cands.text, /jup organic 99 · verified/);
  assert.equal((cands.text.match(/jup organic/g) || []).length, 1);

  const deps = {
    searchPools: async () => [],
    gmgnPriceInfo: async () => null,
    gmgnSignal: async () => null,
    isBlacklisted: () => false,
    readMint: async () => null,
    poolEntryState: async () => null,
    compare: () => 0,
    score: async (c) => c,
  };
  jt._resetJupTokensCacheForTest();
  const sus = await lookupMod.lookupToken(SUS_MINT, {
    deps: { ...deps, jupiterInfo: async (m) => new Map([[m, jt.normalizeJupToken(SUS)]]) },
    entryFilters: es.ENTRY_FILTER_DEFAULTS,
  });
  assert.equal(sus.token_safety.pass, false);
  assert.deepEqual(sus.jupiter, { organic_score: 0, verified: null, sus: true, banned: false });
  const card = ui.renderTokenCard(sus, { tokenRef: "t1" });
  assert.match(card.text, /Jupiter: organic 0 · verified \? · ⚠️ SUS/);
  assert.match(card.text, /❌ Jupiter scam flag: suspicious \(audit\.isSus\)/);
  assert.match(card.text, /deploy_position will refuse/);

  const good = await lookupMod.lookupToken(MINT, {
    deps: { ...deps, jupiterInfo: async (m) => new Map([[m, jt.normalizeJupToken(OFFICIAL)]]) },
    entryFilters: es.ENTRY_FILTER_DEFAULTS,
  });
  const gcard = ui.renderTokenCard(good, { tokenRef: "t2" });
  assert.match(gcard.text, /Jupiter: organic 99 · verified/);
  assert.match(gcard.text, /✅ Jupiter scam flag: none/);

  const down = await lookupMod.lookupToken(MINT, { deps: { ...deps, jupiterInfo: async () => null }, entryFilters: es.ENTRY_FILTER_DEFAULTS });
  assert.notEqual(down.token_safety.reasons.some((r) => /Jupiter/.test(r)), true);
  assert.match(ui.renderTokenCard(down, { tokenRef: "t3" }).text, /Jupiter data unavailable/);
});
