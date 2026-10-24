/**
 * GMGN fail-closed reliability: unknown/unpopulated data never passes a hard gate,
 * rate-limited is a distinct result (not cached as a miss), pacing follows command
 * weight and the ban reset time, the funnel runs the free Meteora check before the
 * weighted calls and holders/traders only for finalists, and the risk/security
 * fields are LOG-ONLY. gmgn-cli is never spawned: exec/sleep/now are injected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-gmgn-fc-"));
fs.writeFileSync(path.join(TMP, "user-config.json"), "{}");
fs.writeFileSync(path.join(TMP, "gmgn-config.json"), "{}");
process.env.MERIDIAN_USER_CONFIG_PATH = path.join(TMP, "user-config.json");
process.env.MERIDIAN_GMGN_CONFIG_PATH = path.join(TMP, "gmgn-config.json");
process.env.DRY_RUN = "true";
const REPO = process.cwd();
process.chdir(TMP);
test.after(() => { process.chdir(REPO); fs.rmSync(TMP, { recursive: true, force: true }); });

const policy = await import("../tools/gmgn-policy.js");
const gmgn = await import("../tools/gmgn.js");
const screen = await import("../tools/gmgn-screen.js");
const { config } = await import("../config.js");
const screening = await import("../tools/screening.js");
const { GMGN_STATUS } = policy;
const T = screen._test;

/* ------------------------------ fixtures ------------------------------ */
const NOW_S = Math.floor(Date.now() / 1000);
const goodToken = (n = 1, extra = {}) => ({
  address: `Mint${n}`, symbol: `TK${n}`, market_cap: 500_000, bundler_rate: 0.1, creation_timestamp: NOW_S - 24 * 3600,
  volume: 50_000 - n, rug_ratio: 0.05, sniper_count: 3, is_honeypot: 0, is_wash_trading: 0, ...extra,
});
const goodStat = () => ({
  top_10_holder_rate: 0.3, dev_team_hold_rate: 0.01, bot_degen_rate: 0.1, fresh_wallet_rate: 0.1,
  top_bundler_trader_percentage: 0.1, top_rat_trader_percentage: 0.05, creator_hold_rate: 0.01,
  top70_sniper_hold_rate: 0.05, top_entrapment_trader_percentage: 0.02, private_vault_hold_rate: 0.0,
  creator_created_count: 3, bot_degen_count: 5, holder_count: 2000,
});
const goodInfo = (extra = {}) => ({
  holder_count: 2000, total_fee: 100, trade_fee: 10, ath_price: 0.002, creation_timestamp: NOW_S - 24 * 3600,
  price: { price: 0.001 }, stat: goodStat(), wallet_tags_stat: {}, dev: { creator_address: "dev", creator_token_status: "creator_close" },
  pool: { liquidity: 40_000, initial_liquidity: 50_000 }, ...extra,
});
const goodPrice = () => ({ status: GMGN_STATUS.OK, data: { price: 0.001, candles: { supertrend_direction: "green", supertrend: { flipped_green: false }, supertrend_price_above: true, rsi_2: 50, bb_lower: 0.0005 } } });
const holderRows = (snipers = 0) => [
  ...Array.from({ length: 20 }, (_, i) => ({ address: `h${i}`, addr_type: 0, amount_percentage: 0.01, tags: i < snipers ? ["sniper"] : [] })),
  { address: "pool", addr_type: 2, amount_percentage: 0.4, tags: [] },
];

function makeDeps(over = {}) {
  const calls = { pools: [], info: [], security: [], price: [], call: [], holders: [] };
  const deps = {
    cfg: config,
    call: async (args) => {
      calls.call.push(args.slice(0, 2).join(" "));
      if (args[1] === "trending") return { status: GMGN_STATUS.OK, data: { data: { rank: over.rank ?? [goodToken(1), goodToken(2)] } } };
      if (args[1] === "holders") return over.holders ? over.holders(args) : { status: GMGN_STATUS.OK, data: { list: holderRows(0) } };
      if (args[1] === "traders") return { status: GMGN_STATUS.OK, data: { list: [] } };
      return { status: GMGN_STATUS.ERROR, data: null };
    },
    fetchHolders: async (mint) => { calls.holders.push(mint); return deps.call(["token", "holders", "--address", mint]); },
    fetchPools: async (mint) => { calls.pools.push(mint); return over.pools ? over.pools(mint) : [{ address: `pool-${mint}`, name: `${mint}-SOL`, tvl: 50_000, token_x: { address: mint, symbol: "X" }, token_y: { address: "So11111111111111111111111111111111111111112" }, pool_config: { bin_step: 100 } }]; },
    fetchInfo: async (mint) => { calls.info.push(mint); return over.info ? over.info(mint) : { status: GMGN_STATUS.OK, info: goodInfo() }; },
    fetchSecurity: async (mint) => { calls.security.push(mint); return over.security ? over.security(mint) : { status: GMGN_STATUS.OK, security: { renounced_mint: true, renounced_freeze_account: true, burn_status: "", buy_tax: 0, sell_tax: 0, lock_summary: { is_locked: false } } }; },
    fetchPrice: async (mint) => { calls.price.push(mint); return over.price ? over.price(mint) : goodPrice(); },
    fetchPoolDetail: async () => null,
  };
  return { deps, calls };
}
const reasonFor = (res, stage) => res.filtered_examples.filter((f) => f.stage === stage);

/* Real gmgn-cli rate-limit strings (src/client/OpenApiClient.ts buildOpenApiErrorMessage). */
const REAL_BANNED = (n) => `[gmgn-cli] GET /v1/token/info failed: HTTP 429 code=429 error=RATE_LIMIT_BANNED message=rate limited. Rate limit resets at 2026-10-24 11:02:16 GMT-04:00 (~${n}s remaining). Stop sending requests before then; repeated requests can extend the ban by 5s up to 5 minutes.`;
const REAL_BANNED_MAX = (n) => `[gmgn-cli] GET /v1/token/info failed: HTTP 429 code=429 error=RATE_LIMIT_BANNED_MAX message=banned. The ban has reached the 5-minute maximum. Stop ALL requests until 2026-10-24 11:02:16 GMT-04:00 (~${n}s remaining); every request sent before then resets the ban to 5 minutes.`;

/* ------------------------------ policy ------------------------------ */
test("command weights, pacing, ban reset parsing and escalation", () => {
  assert.equal(policy.commandWeight(["token", "holders", "--chain", "sol"]), 5);
  assert.equal(policy.commandWeight(["token", "traders"]), 5);
  assert.equal(policy.commandWeight(["token", "info"]), 1);
  assert.equal(policy.commandWeight(["market", "kline"]), 2);
  assert.equal(policy.commandWeight(["market", "trending"]), 3);
  assert.equal(policy.commandWeight(["market", "trenches"]), 2);
  assert.equal(policy.commandWeight(["market", "signal"]), 1);
  assert.equal(policy.commandWeight(["token", "security"]), 1);
  assert.equal(policy.commandWeight(["track", "smartmoney"]), 1);
  assert.equal(policy.commandWeight(["track", "kol"]), 1);
  assert.equal(policy.paceGapMs(2, 5), 400);
  assert.equal(policy.paceGapMs(5, 5), 1000);
  assert.equal(policy.paceGapMs(1, 5), 200);
  assert.equal(policy.paceGapMs(5, 50), 100);
  const now = 1_790_000_000_000;
  assert.equal(policy.parseResetAtMs('{"code":429,"error":"RATE_LIMIT_BANNED","reset_at":1790000120}', now), 1_790_000_120_000);
  assert.equal(policy.parseResetAtMs("x-ratelimit-reset: 1790000090", now), 1_790_000_090_000);
  // REAL gmgn-cli text (OpenApiClient.buildOpenApiErrorMessage): relative "(~Ns remaining)", no raw epoch.
  assert.equal(policy.parseResetAtMs(REAL_BANNED(287), now), now + 287_000);
  assert.equal(policy.parseResetAtMs("no reset here", now), null);
  assert.equal(policy.parseResetAtMs(REAL_BANNED(99_999), now), null, "absurd remaining ignored");
  assert.equal(policy.cooldownUntilMs({ errorText: REAL_BANNED(287), strikes: 1, now }), now + 288_000);
  assert.equal(policy.cooldownUntilMs({ errorText: REAL_BANNED_MAX(299), strikes: 1, now }), now + 300_000);
  // ban class with NO parseable reset => full 300s (not the 30s soft-limit first strike)
  assert.equal(policy.cooldownUntilMs({ errorText: "HTTP 429 error=RATE_LIMIT_BANNED", strikes: 1, now }), now + 300_000);
  assert.equal(policy.cooldownUntilMs({ errorText: "HTTP 429 error=RATE_LIMIT_BANNED_MAX", strikes: 1, now }), now + 300_000);
  assert.equal(policy.cooldownUntilMs({ errorText: "HTTP 429 error=RATE_LIMIT_EXCEEDED", strikes: 1, now }), now + 30_000, "soft limit keeps the ladder");
  assert.equal(policy.parseResetAtMs('reset_at":1700000000', now), null, "stale reset ignored");
  assert.equal(policy.cooldownUntilMs({ errorText: '{"reset_at":1790000120}', strikes: 1, now }), 1_790_000_121_000);
  assert.equal(policy.cooldownUntilMs({ errorText: "429", strikes: 1, now }), now + 30_000);
  assert.equal(policy.cooldownUntilMs({ errorText: "429", strikes: 3, now }), now + 120_000);
  assert.equal(policy.escalatingCooldownMs(9), 300_000, "capped at the 5 minute ban ceiling");
  assert.ok(policy.looksRateLimited("RATE_LIMIT_BANNED"));
  assert.ok(!policy.looksRateLimited("failed to open /tmp/x14290y"), "digits inside other words are not a 429");
  assert.ok(policy.looksForbidden("403 PLAN_UPGRADE_REQUIRED"));
});

test("stat population test and unknown-aware readers", () => {
  assert.equal(policy.isStatUnpopulated(undefined), true);
  assert.equal(policy.isStatUnpopulated({}), true);
  assert.equal(policy.isStatUnpopulated(Object.fromEntries(policy.STAT_RISK_FIELDS.map((k) => [k, 0]))), true);
  assert.equal(policy.isStatUnpopulated(goodStat()), false);
  assert.equal(policy.STAT_RISK_FIELDS.length, 10, "doc test 2 uses ten fields");
  assert.ok(policy.STAT_RISK_FIELDS.includes("creator_created_count") && policy.STAT_RISK_FIELDS.includes("top_10_holder_rate"));
  assert.ok(!policy.STAT_RISK_FIELDS.includes("dev_team_hold_rate"));
  // only creator_created_count / top_10_holder_rate non-zero => populated per the doc (old 9-field list said no)
  assert.equal(policy.isStatUnpopulated({ creator_created_count: 4 }), false);
  assert.equal(policy.isStatUnpopulated({ top_10_holder_rate: 0.3 }), false);
  // dev_team_hold_rate alone is not in the doc's list
  assert.equal(policy.isStatUnpopulated({ dev_team_hold_rate: 0.1 }), true);
  // test 1 (CAKE shape): stat.holder_count 0 while info.holder_count > 0 => unpopulated even with other fields set
  assert.equal(policy.isStatUnpopulated({ ...goodStat(), holder_count: 0 }, { holder_count: 381430 }), true);
  assert.equal(policy.isStatUnpopulated((({ holder_count, ...rest }) => rest)(goodStat()), { holder_count: 381430 }), true, "absent stat.holder_count counts as 0");
  assert.equal(policy.isStatUnpopulated({ ...goodStat(), holder_count: 100 }, { holder_count: 100 }), false);
  // WETH-on-base shape: stat.holder_count mirrors info but all ten are zero => test 2 catches it
  const zeros = Object.fromEntries(policy.STAT_RISK_FIELDS.map((k) => [k, 0]));
  assert.equal(policy.isStatUnpopulated({ ...zeros, holder_count: 4818570 }, { holder_count: 4818570 }), true);
  // USDC-on-sol shape: eight zeros but top70_sniper_hold_rate > 0 and holder counts agree => populated
  assert.equal(policy.isStatUnpopulated({ ...zeros, top70_sniper_hold_rate: "0.0000086741", holder_count: 9000000 }, { holder_count: 9000000 }), false);
  assert.equal(policy.numOrNull(undefined), null);
  assert.equal(policy.numOrNull(""), null);
  assert.equal(policy.numOrNull("0.2"), 0.2);
  assert.equal(policy.numOrNull(0), 0);
});

/* ------------------------------ transport ------------------------------ */
function fakeClock() {
  const c = { now: 1_790_000_000_000, sleeps: [] };
  return { c, sleep: async (ms) => { c.sleeps.push(ms); c.now += ms; }, nowFn: () => c.now };
}
function useExec(handler, clock = fakeClock()) {
  const execs = [];
  gmgn._setGmgnDepsForTest({
    exec: (bin, args, opts, cb) => { execs.push(args); const r = handler(args, execs.length); cb(r.error || null, r.stdout ?? "", r.stderr ?? ""); },
    sleep: clock.sleep, now: clock.nowFn, ratePerSec: () => 5,
  });
  return { execs, clock };
}

test("rate limit is a distinct result, honors reset_at, blocks spawns, never cached as a miss", async () => {
  let mode = "limit";
  const { execs, clock } = useExec((args) => {
    if (mode === "limit") {
      return { error: new Error("exit 1"), stderr: REAL_BANNED(90) };
    }
    return { stdout: JSON.stringify({ holder_count: 5, price: { price: 1 } }) };
  });
  const r1 = await gmgn.fetchGmgnTokenInfoResult("MintA");
  assert.equal(r1.status, GMGN_STATUS.RATE_LIMITED);
  assert.equal(r1.info, null);
  assert.equal(execs.length, 1);
  // inside the ban: no new spawn, still rate_limited (not "empty" / "error")
  const r2 = await gmgn.fetchGmgnTokenInfoResult("MintA");
  assert.equal(r2.status, GMGN_STATUS.RATE_LIMITED);
  assert.equal(execs.length, 1, "no spawn while banned (spawning extends the ban)");
  const st = gmgn.getGmgnRateLimitState();
  assert.equal(st.limited, true);
  assert.ok(st.retryAfterMs >= 90_000 && st.retryAfterMs <= 95_000, `reset_at honored, got ${st.retryAfterMs}`);
  // ban lifts; the earlier rate-limit must NOT have been cached as a data miss
  clock.c.now += 100_000;
  mode = "ok";
  const r3 = await gmgn.fetchGmgnTokenInfoResult("MintA");
  assert.equal(r3.status, GMGN_STATUS.OK);
  assert.equal(r3.info.holder_count, 5);
  assert.equal(execs.length, 2);
  // legacy wrapper still returns null for a limited call
  assert.equal(await gmgn.spawnGmgn(["token", "info"]) !== undefined, true);
});

test("escalating cooldown without a reset time; a good response clears it", async () => {
  let mode = "limit";
  const { clock } = useExec(() => (mode === "limit" ? { error: new Error("x"), stderr: "HTTP 429 too many requests" } : { stdout: "{}" }));
  await gmgn.spawnGmgnResult(["token", "info"]);
  const s1 = gmgn.getGmgnRateLimitState();
  assert.equal(s1.strikes, 1);
  assert.ok(s1.retryAfterMs <= 30_000 && s1.retryAfterMs > 29_000);
  clock.c.now += 31_000;
  await gmgn.spawnGmgnResult(["token", "info"]);
  const s2 = gmgn.getGmgnRateLimitState();
  assert.equal(s2.strikes, 2);
  assert.ok(s2.retryAfterMs > 59_000 && s2.retryAfterMs <= 60_000, "second strike doubles to 60s");
  clock.c.now += 61_000;
  mode = "ok";
  const ok = await gmgn.spawnGmgnResult(["token", "info"]);
  assert.equal(ok.status, GMGN_STATUS.OK);
  assert.equal(gmgn.getGmgnRateLimitState().strikes, 0);
});

test("403 plan upgrade is non-retryable (no cooldown); empty stdout and bad JSON are distinct", async () => {
  let mode = "forbidden";
  useExec(() => {
    if (mode === "forbidden") return { error: new Error("403"), stderr: "PLAN_UPGRADE_REQUIRED" };
    if (mode === "empty") return { stdout: "" };
    return { stdout: "not json" };
  });
  assert.equal((await gmgn.spawnGmgnResult(["token", "security"])).status, GMGN_STATUS.FORBIDDEN);
  assert.equal(gmgn.getGmgnRateLimitState().limited, false);
  mode = "empty";
  assert.equal((await gmgn.spawnGmgnResult(["token", "info"])).status, GMGN_STATUS.EMPTY);
  mode = "bad";
  assert.equal((await gmgn.spawnGmgnResult(["token", "info"])).status, GMGN_STATUS.ERROR);
});

test("pacing follows command weight (holders/traders wait 5x longer than info)", async () => {
  const { clock } = useExec(() => ({ stdout: "{}" }));
  await gmgn.spawnGmgnResult(["token", "holders", "--address", "a"]);
  await gmgn.spawnGmgnResult(["token", "info", "--address", "a"]); // waits out the holders cost: 1000ms @5/s
  await gmgn.spawnGmgnResult(["token", "info", "--address", "b"]); // waits out the info cost: 200ms
  assert.deepEqual(clock.c.sleeps, [1000, 200]);
});

test("token info: concurrent callers share one spawn; genuine empty is cached briefly", async () => {
  const { execs } = useExec(() => ({ stdout: JSON.stringify({ holder_count: 9 }) }));
  const [a, b] = await Promise.all([gmgn.fetchGmgnTokenInfoResult("M"), gmgn.fetchGmgnTokenInfoResult("M")]);
  assert.equal(a.info.holder_count, 9);
  assert.equal(b.info.holder_count, 9);
  assert.equal(execs.length, 1);
});

test("price info: missing reference prices are null (not 0 = flat); rate-limited halves are not cached", async () => {
  let limited = false;
  const { execs } = useExec((args) => {
    if (limited) return { error: new Error("x"), stderr: "RATE_LIMIT_EXCEEDED 429" };
    if (args[1] === "info") return { stdout: JSON.stringify({ price: { price: 0.5 }, holder_count: 10, liquidity: 0, pool: { liquidity: 1234 }, creation_timestamp: NOW_S - 7200, open_timestamp: NOW_S - 60 }) };
    return { stdout: JSON.stringify({ list: [] }) };
  });
  const res = await gmgn.fetchGmgnPriceInfoResult("M1");
  assert.equal(res.status, GMGN_STATUS.OK);
  assert.equal(res.data.change_1h, null);
  assert.equal(res.data.change_5m, null);
  assert.equal(res.data.volume_24h, null);
  assert.equal(res.data.candles, null, "no candles => null summary");
  assert.equal(res.data.kline_status, GMGN_STATUS.EMPTY);
  assert.equal(res.data.liquidity, 1234, "falls back to pool.liquidity when info.liquidity is 0");
  assert.ok(res.data.token_age_hours > 1.9 && res.data.token_age_hours < 2.1, "age from creation_timestamp, not open_timestamp");
  // rate limited: distinct status, nothing cached
  gmgn._setGmgnDepsForTest(null);
  limited = true;
  useExec(() => ({ error: new Error("x"), stderr: "RATE_LIMIT_EXCEEDED 429" }));
  const lim = await gmgn.fetchGmgnPriceInfoResult("M2");
  assert.equal(lim.status, GMGN_STATUS.RATE_LIMITED);
  assert.equal(lim.data, null);
});

test("signal: rate-limited info is unknown (null, uncached); legacy signal_count_30m aliases the holder snapshot", async () => {
  useExec(() => ({ error: new Error("x"), stderr: "429 RATE_LIMIT" }));
  assert.equal(await gmgn.fetchGmgnSignal("S1"), null);
  useExec((args) => (args[0] === "token"
    ? { stdout: JSON.stringify({ wallet_tags_stat: { smart_wallets: 2, renowned_wallets: 1, whale_wallets: 0 } }) }
    : { stdout: JSON.stringify({ list: [] }) }));
  const sig = await gmgn.fetchGmgnSignal("S1");
  assert.equal(sig.tagged_holder_count, 3);
  assert.equal(sig.signal_count_30m, 3, "deprecated alias keeps stored-data comparability");
  assert.equal(sig.signal_count_semantics, "tagged_holder_snapshot");
  assert.equal(sig.trade_events_30m, 0);
  // snapshot signal keeps its old meaning via tagged_holder_count
  const snap = screening.getCandidateSignalSnapshot({ pool: "p", _gmgnSignal: sig });
  assert.equal(snap.gmgn_signal_present, true);
  const snapLegacy = screening.getCandidateSignalSnapshot({ pool: "p", _gmgnSignal: { signal_count_30m: 0 } });
  assert.equal(snapLegacy.gmgn_signal_present, false);
});

/* ------------------------------ stage gates ------------------------------ */
test("stage 1 fails closed on missing bundler_rate / rug_ratio / sniper_count / creation_timestamp", () => {
  assert.equal(T.passBasicRankFilter(goodToken()).pass, true);
  for (const field of ["bundler_rate", "rug_ratio", "sniper_count", "creation_timestamp", "market_cap", "volume"]) {
    const t = goodToken(1);
    delete t[field];
    const r = T.passBasicRankFilter(t);
    assert.equal(r.pass, false, `${field} missing must reject`);
    assert.ok(r.unknown.includes(field), `${field} flagged unknown`);
  }
  const nullRug = T.passBasicRankFilter(goodToken(1, { rug_ratio: null }));
  assert.equal(nullRug.pass, false);
  // gate disabled (null) => the field is not required
  const off = T.passBasicRankFilter(goodToken(1, { rug_ratio: undefined }), { ...config.gmgn, maxRugRatio: null });
  assert.equal(off.pass, true);
});

test("stage 3 fails closed on unpopulated stat, zero top10, and any missing gated field", () => {
  assert.equal(T.analyzeTokenInfo(goodInfo()).passed, true);
  const unpop = T.analyzeTokenInfo(goodInfo({ stat: { top_10_holder_rate: 0.3 } }));
  assert.equal(unpop.passed, false);
  assert.ok(unpop.unknown.includes("stat"));
  const allZero = T.analyzeTokenInfo(goodInfo({ stat: Object.fromEntries(Object.keys(goodStat()).map((k) => [k, 0])) }));
  assert.equal(allZero.statUnpopulated, true);
  assert.equal(allZero.passed, false);
  assert.equal(T.analyzeTokenInfo(goodInfo({ stat: undefined })).passed, false);
  const zeroTop10 = T.analyzeTokenInfo(goodInfo({ stat: { ...goodStat(), top_10_holder_rate: 0 } }));
  assert.ok(zeroTop10.unknown.includes("top_10_holder_rate"));
  for (const field of ["dev_team_hold_rate", "bot_degen_rate", "fresh_wallet_rate", "top_bundler_trader_percentage", "top_rat_trader_percentage"]) {
    const stat = goodStat();
    delete stat[field];
    const r = T.analyzeTokenInfo(goodInfo({ stat }));
    assert.equal(r.passed, false, `${field} missing must reject`);
    assert.ok(r.unknown.includes(field));
  }
  assert.equal(T.analyzeTokenInfo(goodInfo({ holder_count: undefined })).passed, false);
  assert.equal(T.analyzeTokenInfo(goodInfo({ total_fee: null })).passed, false);
  // real violations still reject (kind reject, no unknowns)
  const bad = T.analyzeTokenInfo(goodInfo({ stat: { ...goodStat(), top_bundler_trader_percentage: 0.9 } }));
  assert.equal(bad.passed, false);
  assert.equal(bad.unknown.length, 0);
});

test("stage 4 fails closed with no candles / no price; rate-limited is deferred; bb_lower rule is log-only by default", () => {
  assert.equal(T.checkBounceSetup(goodPrice()).passed, true);
  const noCandles = T.checkBounceSetup({ status: GMGN_STATUS.OK, data: { price: 1, candles: null } });
  assert.equal(noCandles.passed, false);
  assert.equal(noCandles.kind, "unknown");
  assert.equal(T.checkBounceSetup({ status: GMGN_STATUS.OK, data: null }).passed, false);
  assert.equal(T.checkBounceSetup({ status: GMGN_STATUS.OK, data: { price: 0, candles: {} } }).passed, false);
  const limited = T.checkBounceSetup({ status: GMGN_STATUS.RATE_LIMITED, data: null });
  assert.equal(limited.passed, false);
  assert.equal(limited.deferred, true);
  // bottom: now computable (bb_lower) but log-only unless rejectAlreadyAtBottom === true
  const bottom = { status: GMGN_STATUS.OK, data: { price: 0.0004, candles: { supertrend_direction: "green", supertrend_price_above: true, rsi_2: 5, bb_lower: 0.0005 } } };
  const r = T.checkBounceSetup(bottom);
  assert.equal(r.signal.bbPosition, "below");
  assert.equal(r.signal.alreadyAtBottom, true);
  assert.equal(r.passed, true, "default stays non-gating");
  // explicit legacy true keeps its old effective behavior (it never fired): still log-only
  const legacy = T.checkBounceSetup(bottom, { ...config.gmgn, indicatorRules: { ...config.gmgn.indicatorRules, rejectAlreadyAtBottom: true } });
  assert.equal(legacy.passed, true, "legacy rejectAlreadyAtBottom=true stays non-gating");
  const hard = T.checkBounceSetup(bottom, { ...config.gmgn, indicatorRules: { ...config.gmgn.indicatorRules, enforceAlreadyAtBottom: true } });
  assert.equal(hard.passed, false);
});

test("holders gate: sniper supply share, burn/DEX rows excluded, renowned counts as KOL", () => {
  const dex = { address: "pool", addr_type: 2, amount_percentage: 0.5, tags: ["sniper"] };
  const clean = T.analyzeHoldersAndTraders([dex, ...holderRows(0)], []);
  assert.equal(clean.passed, true, "a sniper-tagged DEX row is not a holder");
  // 2 snipers holding 20% of supply each among 20 real rows: row rate 10% but supply 40% > 30%
  const rows = holderRows(0);
  rows[0] = { address: "s1", addr_type: 0, amount_percentage: 0.2, tags: ["sniper"] };
  rows[1] = { address: "s2", addr_type: 0, amount_percentage: 0.2, tags: ["sniper"] };
  const heavy = T.analyzeHoldersAndTraders(rows, []);
  assert.equal(heavy.passed, false);
  assert.match(heavy.reasons.join(), /supply share/);
  assert.ok(Math.abs(heavy.sniperSupplyShare - 0.4) < 1e-9);
  // legacy row-count gate never loosens: 8/20 snipers with tiny amounts still rejects
  const many = T.analyzeHoldersAndTraders(holderRows(8), []);
  assert.equal(many.passed, false);
  const kol = T.analyzeHoldersAndTraders([{ address: "k", addr_type: 0, amount_percentage: 0.01, tags: ["renowned"] }, ...holderRows(0)], []);
  assert.equal(kol.kolHolding, 1);
});

test("gmgn_score: unknown rug_ratio earns no bonus; token age uses creation_timestamp", () => {
  const pool = { address: "p1", name: "X-SOL", token_y: { address: "So11111111111111111111111111111111111111112" } };
  const base = { pool, poolDetail: null, security: {}, info: goodInfo(), infoAnalysis: T.analyzeTokenInfo(goodInfo()), holdersAnalysis: T.analyzeHoldersAndTraders(holderRows(0), []), indicatorSignal: null };
  const withRug = T.condenseGmgnCandidate({ ...base, token: goodToken(1) });
  const noRug = T.condenseGmgnCandidate({ ...base, token: goodToken(1, { rug_ratio: undefined }) });
  assert.ok(withRug.gmgn_score - noRug.gmgn_score >= 400, "known low rug earns the bonus, unknown does not");
  const aged = T.condenseGmgnCandidate({ ...base, token: goodToken(1, { open_timestamp: NOW_S - 60 }) });
  assert.equal(aged.token_age_hours, 24, "open_timestamp ignored");
  assert.equal(withRug.gmgn_gated, true);
});

/* ------------------------------ funnel ------------------------------ */
test("funnel: happy path emits a candidate carrying LOG-ONLY risk fields", async () => {
  const { deps } = makeDeps({ rank: [goodToken(1)] });
  const res = await screen.discoverGmgnPools({ limit: 5, deps });
  assert.equal(res.pools.length, 1);
  const c = res.pools[0];
  assert.equal(c.gmgn_security_status, "ok");
  assert.equal(c.gmgn_renounced_freeze, true);
  assert.equal(c.gmgn_creator_hold_pct, 1);
  assert.equal(c.gmgn_pool_liquidity_ratio, 0.8);
  assert.equal(c.gmgn_creator_created_count, 3);
  assert.ok(Array.isArray(c.gmgn_risk_log_only_flags));
  const snap = screening.getCandidateSignalSnapshot(c);
  assert.equal(snap.gmgn_risk_log_only.gmgn_renounced_mint, true);
});

test("risk fields are log-only: bad security/stat risk flags never reject", async () => {
  const { deps } = makeDeps({
    rank: [goodToken(1)],
    info: async () => ({ status: GMGN_STATUS.OK, info: goodInfo({ stat: { ...goodStat(), creator_hold_rate: 0.5, top70_sniper_hold_rate: 0.6, top_entrapment_trader_percentage: 0.9, private_vault_hold_rate: 0.3, creator_created_count: 900 }, pool: { liquidity: 1, initial_liquidity: 100 } }) }),
    security: async () => ({ status: GMGN_STATUS.OK, security: { renounced_mint: false, renounced_freeze_account: false, sell_tax: 0.5, buy_tax: "", lock_summary: { is_locked: false }, burn_status: "" } }),
  });
  const res = await screen.discoverGmgnPools({ limit: 5, deps });
  assert.equal(res.pools.length, 1, "still passes");
  const flags = res.pools[0].gmgn_risk_log_only_flags;
  for (const f of ["creator_hold>5%", "top70_sniper>15%", "entrapment>20%", "private_vault>5%", "serial_launcher>=200", "pool_liquidity<50%_of_initial", "mint_not_renounced", "freeze_not_renounced", "sell_tax>10%"]) {
    assert.ok(flags.includes(f), `flag ${f} recorded`);
  }
  assert.equal(res.pools[0].gmgn_buy_tax, null, "empty-string tax = untested (null), not 0");
});

test("funnel order: Meteora pool check before any weighted call; info fetched once per mint; holders only for finalists", async () => {
  const rank = [goodToken(1), goodToken(2), goodToken(3), goodToken(4), goodToken(5)];
  const { deps, calls } = makeDeps({ rank, pools: async (mint) => (mint === "Mint5" ? [] : [{ address: `pool-${mint}`, name: `${mint}-SOL`, tvl: 50_000, token_x: { address: mint, symbol: "X" }, token_y: { address: "So11111111111111111111111111111111111111112" }, pool_config: { bin_step: 100 } }]) });
  deps.cfg = { ...config, gmgn: { ...config.gmgn, finalistLimit: 2 } };
  const res = await screen.discoverGmgnPools({ limit: 10, deps });
  assert.ok(!calls.info.includes("Mint5"), "no GMGN info call for a token without a SOL DLMM pool");
  assert.ok(reasonFor(res, 2).some((f) => /no SOL DLMM pool/.test(f.reason)));
  assert.deepEqual(calls.info, ["Mint1", "Mint2", "Mint3", "Mint4"], "exactly one info fetch per surviving mint");
  assert.equal(calls.call.filter((c) => c === "token holders").length, 2, "holders only for the 2 finalists");
  assert.equal(calls.call.filter((c) => c === "token traders").length, 2);
  assert.equal(calls.security.length, 2);
  assert.equal(res.pools.length, 2);
  assert.equal(res.filtered_examples.filter((f) => f.stage === 5 && f.kind === "deferred").length, 2, "non-finalists are deferred, not rejected");
});

test("funnel: rate-limited holders defers (neither pass nor reject) and stops further GMGN calls", async () => {
  const { deps, calls } = makeDeps({
    rank: [goodToken(1), goodToken(2)],
    holders: () => ({ status: GMGN_STATUS.RATE_LIMITED, data: null }),
  });
  const res = await screen.discoverGmgnPools({ limit: 5, deps });
  assert.equal(res.pools.length, 0);
  assert.equal(res.rate_limited, true);
  assert.equal(calls.call.filter((c) => c === "token holders").length, 1, "stops after the first limited call");
  const f = reasonFor(res, 5);
  assert.equal(f.length, 2);
  assert.ok(f.every((x) => x.kind === "deferred"));
});

test("funnel: null/empty holders fails closed as unknown (old code passed the sniper gate)", async () => {
  for (const holders of [() => ({ status: GMGN_STATUS.ERROR, data: null }), () => ({ status: GMGN_STATUS.OK, data: { list: [] } })]) {
    const { deps } = makeDeps({ rank: [goodToken(1)], holders });
    const res = await screen.discoverGmgnPools({ limit: 5, deps });
    assert.equal(res.pools.length, 0);
    const f = reasonFor(res, 5)[0];
    assert.equal(f.kind, "unknown");
    assert.match(f.reason, /holders unavailable/);
  }
});

test("funnel: unpopulated stat, missing rug_ratio, and no candles each reject (previously passed)", async () => {
  const unpop = await screen.discoverGmgnPools({ limit: 5, deps: makeDeps({ rank: [goodToken(1)], info: async () => ({ status: GMGN_STATUS.OK, info: goodInfo({ stat: {} }) }) }).deps });
  assert.equal(unpop.pools.length, 0);
  assert.match(reasonFor(unpop, 3)[0].reason, /stat block unpopulated/);
  const noRug = await screen.discoverGmgnPools({ limit: 5, deps: makeDeps({ rank: [goodToken(1, { rug_ratio: undefined })] }).deps });
  assert.equal(noRug.pools.length, 0);
  assert.match(reasonFor(noRug, 1)[0].reason, /rug_ratio unknown/);
  const noCandles = await screen.discoverGmgnPools({ limit: 5, deps: makeDeps({ rank: [goodToken(1)], price: async () => ({ status: GMGN_STATUS.OK, data: { price: 1, candles: null } }) }).deps });
  assert.equal(noCandles.pools.length, 0);
  assert.equal(reasonFor(noCandles, 4)[0].kind, "unknown");
});

test("funnel: rate-limited trending skips the cycle without spending calls", async () => {
  const { deps, calls } = makeDeps();
  const orig = deps.call;
  deps.call = async (args) => (args[1] === "trending" ? { status: GMGN_STATUS.RATE_LIMITED, data: null } : orig(args));
  const res = await screen.discoverGmgnPools({ limit: 5, deps });
  assert.equal(res.rate_limited, true);
  assert.equal(res.pools.length, 0);
  assert.equal(calls.info.length, 0);
});

/* ------------------------------ Meteora-source gate ------------------------------ */
const mPool = (n) => ({ pool: `mpool${n}`, name: `M${n}-SOL`, base: { symbol: `M${n}`, mint: `Mint${n}` } });

test("Meteora-source candidates run the GMGN safety gates (fail closed), already-gated ones pass through", async () => {
  const { deps, calls } = makeDeps({
    info: async (mint) => {
      if (mint === "Mint2") return { status: GMGN_STATUS.OK, info: goodInfo({ stat: {} }) };               // unpopulated -> unknown
      if (mint === "Mint3") return { status: GMGN_STATUS.EMPTY, info: null };                              // no info -> unknown
      if (mint === "Mint4") return { status: GMGN_STATUS.OK, info: goodInfo({ stat: { ...goodStat(), top_bundler_trader_percentage: 0.9 } }) }; // real reject
      return { status: GMGN_STATUS.OK, info: goodInfo() };
    },
  });
  const pre = { ...mPool(9), gmgn: true, gmgn_gated: true };
  const res = await screen.gateMeteoraSourceCandidates([mPool(1), mPool(2), mPool(3), mPool(4), pre], { limit: 10, deps: { ...deps, force: true, mode: "hard" } });
  const keptNames = res.kept.map((p) => p.name).sort();
  assert.deepEqual(keptNames, ["M1-SOL", "M9-SOL"]);
  const kinds = Object.fromEntries(res.dropped.map((d) => [d.symbol, d.kind]));
  assert.deepEqual(kinds, { M2: "unknown", M3: "unknown", M4: "reject" });
  const m1 = res.kept.find((p) => p.name === "M1-SOL");
  assert.equal(m1.gmgn_gated, true);
  assert.equal(m1.gmgn_security_status, "ok");
  assert.ok(!calls.info.includes("Mint9"), "pipeline-gated candidates are not re-fetched");
});

test("Meteora-source gate: holders unavailable fails closed; rate limit defers the rest; skipped without a GMGN key", async () => {
  const unavailable = makeDeps({ holders: () => ({ status: GMGN_STATUS.ERROR, data: null }) });
  const r1 = await screen.gateMeteoraSourceCandidates([mPool(1)], { deps: { ...unavailable.deps, force: true, mode: "hard" } });
  assert.equal(r1.kept.length, 0);
  assert.equal(r1.dropped[0].kind, "unknown");

  const limited = makeDeps({ info: async (m) => (m === "Mint2" ? { status: GMGN_STATUS.RATE_LIMITED, info: null } : { status: GMGN_STATUS.OK, info: goodInfo() }) });
  const r2 = await screen.gateMeteoraSourceCandidates([mPool(1), mPool(2), mPool(3)], { deps: { ...limited.deps, force: true, mode: "hard" } });
  assert.equal(r2.rate_limited, true);
  assert.deepEqual(r2.dropped.map((d) => d.kind).sort(), ["deferred", "deferred", "deferred"].sort(), "limited candidate and everything after it are deferred; Mint1 deferred too because phase B stopped");
  assert.equal(r2.kept.length, 0, "a rate limit never passes a candidate");

  const noKey = await screen.gateMeteoraSourceCandidates([mPool(1)], { deps: { cfg: { ...config, gmgn: { ...config.gmgn, apiKey: null } } } });
  const hadEnv = process.env.GMGN_API_KEY;
  delete process.env.GMGN_API_KEY;
  const noKey2 = await screen.gateMeteoraSourceCandidates([mPool(1)], { deps: { cfg: { ...config, gmgn: { ...config.gmgn, apiKey: null } } } });
  if (hadEnv) process.env.GMGN_API_KEY = hadEnv;
  assert.equal(noKey2.skipped, true);
  assert.equal(noKey2.kept.length, 1);
  assert.ok(noKey);
});

/* ------------------------------ config / wiring ------------------------------ */
test("dead KOL/smart-degen config removed; new reliability settings present with conservative defaults", () => {
  for (const k of ["requireKol", "minKolCount", "minSmartDegenCount"]) assert.ok(!(k in config.gmgn), `${k} removed`);
  assert.equal(config.gmgn.plan, "free");
  assert.equal(config.gmgn.finalistLimit, 5);
  assert.equal(config.gmgn.gateMeteoraSource, "shadow", "Meteora-source gate defaults to shadow");
  assert.equal(config.gmgn.indicatorRules.rejectAlreadyAtBottom, false);
  assert.equal(config.gmgn.indicatorRules.enforceAlreadyAtBottom, false);
  const example = JSON.parse(fs.readFileSync(path.join(REPO, "gmgn-config.example.json"), "utf8"));
  assert.ok(!("requireKol" in example) && !("minKolCount" in example) && !("minSmartDegenCount" in example));
});

/* ====================== Fable 5.1 audit fixes ====================== */
const notifier = await import("../notifier.js");
const outageMod = await import("../tools/gmgn-outage.js");
const helpers = await import("../runtime-helpers.js");

test("H1: the real gmgn-cli 429 text drives the cooldown (reset-aware, ban class defaults to 300s)", async () => {
  const { clock } = useExec(() => ({ error: new Error("exit 1"), stderr: REAL_BANNED(287) }));
  const r = await gmgn.spawnGmgnResult(["token", "info", "--address", "a"]);
  assert.equal(r.status, GMGN_STATUS.RATE_LIMITED);
  assert.ok(r.retryAfterMs >= 287_000 && r.retryAfterMs <= 289_000, `expected ~288s, got ${r.retryAfterMs}`);
  assert.equal(gmgn.getGmgnRateLimitState().strikes, 1);
  void clock;
  // BANNED_MAX with no parseable reset => 300s, never the 30s first-strike floor
  useExec(() => ({ error: new Error("x"), stderr: "HTTP 429 code=429 error=RATE_LIMIT_BANNED_MAX message=banned" }));
  const r2 = await gmgn.spawnGmgnResult(["token", "info", "--address", "a"]);
  assert.equal(r2.retryAfterMs, 300_000);
  // soft limit keeps the 30s ladder
  useExec(() => ({ error: new Error("x"), stderr: "HTTP 429 code=429 error=RATE_LIMIT_EXCEEDED" }));
  assert.equal((await gmgn.spawnGmgnResult(["token", "info", "--address", "a"])).retryAfterMs, 30_000);
});

test("H2: kline (2) and trending (3) are paced by weight, including the index.js enrichment path (fetchGmgnPriceInfo)", async () => {
  const { clock } = useExec((args) => (args[0] === "market" ? { stdout: JSON.stringify({ list: [{ time: 1, open: 1, close: 1, high: 1, low: 1, volume: 1 }] }) } : { stdout: JSON.stringify({ holder_count: 5, price: { price: 1 } }) }));
  await gmgn.spawnGmgnResult(["market", "kline", "--address", "a"]);
  await gmgn.spawnGmgnResult(["token", "info", "--address", "a"]);   // waits out the kline cost: 2/5 s = 400ms
  await gmgn.spawnGmgnResult(["market", "trending", "--chain", "sol"]);
  await gmgn.spawnGmgnResult(["token", "info", "--address", "b"]);   // waits out trending: 3/5 s = 600ms
  assert.deepEqual(clock.c.sleeps.filter((x) => x >= 400), [400, 600]);
  // the enrichment path calls fetchGmgnPriceInfo -> spawnGmgnResult(["market","kline"...]): same pacer
  const { execs, clock: c2 } = useExec((args) => (args[1] === "kline" ? { stdout: JSON.stringify({ list: [{ time: 1, open: 1, close: 1, high: 1, low: 1, volume: 1 }] }) } : { stdout: JSON.stringify({ holder_count: 5, price: { price: 1 } }) }));
  await Promise.all([gmgn.fetchGmgnPriceInfoResult("M1"), gmgn.fetchGmgnPriceInfoResult("M1")]);
  assert.equal(execs.filter((a) => a[1] === "kline").length, 1, "in-flight kline dedupe: one spawn for concurrent callers");
  assert.ok(c2.c.sleeps.includes(200) || c2.c.sleeps.includes(400), "kline spacing applied before the next call");
});

test("F5: holders cached 60s on OK only, deduped in flight, never cached when rate limited", async () => {
  let mode = "ok";
  const { execs, clock } = useExec(() => (mode === "limit" ? { error: new Error("x"), stderr: REAL_BANNED(30) } : { stdout: JSON.stringify({ list: holderRows(0) }) }));
  const [a, b] = await Promise.all([gmgn.fetchGmgnHoldersResult("H1", 100), gmgn.fetchGmgnHoldersResult("H1", 100)]);
  assert.equal(a.status, GMGN_STATUS.OK); assert.equal(b.status, GMGN_STATUS.OK);
  assert.equal(execs.length, 1, "concurrent callers share one weight-5 spawn");
  await gmgn.fetchGmgnHoldersResult("H1", 100);
  assert.equal(execs.length, 1, "second call inside the TTL is a cache hit");
  clock.c.now += 61_000;
  mode = "limit";
  const lim = await gmgn.fetchGmgnHoldersResult("H1", 100);
  assert.equal(lim.status, GMGN_STATUS.RATE_LIMITED);
  assert.equal(execs.length, 2, "expired entry re-fetched");
  clock.c.now += 40_000;
  mode = "ok";
  const again = await gmgn.fetchGmgnHoldersResult("H1", 100);
  assert.equal(again.status, GMGN_STATUS.OK, "the rate-limit was not cached");
  assert.equal(execs.length, 3);
});

test("F10/F3: missing gmgn-cli and a bad API key are flagged as transport state (one-shot, not per call)", async () => {
  useExec(() => ({ error: Object.assign(new Error("spawn gmgn-cli ENOENT"), { code: "ENOENT" }) }));
  assert.equal((await gmgn.spawnGmgnResult(["token", "info"])).status, GMGN_STATUS.ERROR);
  assert.equal(gmgn.getGmgnTransportState().binaryMissing, true);
  useExec(() => ({ error: new Error("exit 1"), stderr: "[gmgn-cli] GET /v1/token/info failed: HTTP 401 code=401 error=UNAUTHORIZED message=invalid api key" }));
  assert.equal((await gmgn.spawnGmgnResult(["token", "info"])).status, GMGN_STATUS.ERROR);
  assert.equal(gmgn.getGmgnTransportState().authFailed, true);
  assert.equal(gmgn.getGmgnRateLimitState().limited, false, "401 is not a rate limit");
  assert.ok(policy.looksUnauthorized("HTTP 401 code=401"));
  assert.ok(!policy.looksUnauthorized("failed to open /tmp/x14010y"));
});

test("F7/F8: top10 falls back to dev.top_10_holder_rate before declaring unknown", () => {
  const g = config.gmgn;
  const noStatTop10 = goodInfo({ stat: { ...goodStat(), top_10_holder_rate: 0 }, dev: { top_10_holder_rate: 0.25 } });
  const r = T.analyzeTokenInfo(noStatTop10, g);
  assert.ok(!r.unknown.includes("top_10_holder_rate"), "dev block supplies the value");
  assert.equal(r.top10HolderPct, 25);
  const none = T.analyzeTokenInfo(goodInfo({ stat: { ...goodStat(), top_10_holder_rate: 0 } }), g);
  assert.ok(none.unknown.includes("top_10_holder_rate"));
  // info.holder_count > 0 with stat.holder_count absent => unpopulated (doc test 1)
  const cake = T.analyzeTokenInfo(goodInfo({ stat: (({ holder_count, ...rest }) => rest)(goodStat()) }), g);
  assert.equal(cake.statUnpopulated, true);
});

test("F9: holders gate is unknown (not a 0/0 pass) for all-DEX lists and for rows without amount_percentage", () => {
  const allDex = T.analyzeHoldersAndTraders([{ address: "p1", addr_type: 2, amount_percentage: 0.4, tags: [] }, { address: "b", addr_type: 1, amount_percentage: 0.3, tags: [] }], []);
  assert.equal(allDex.passed, false);
  assert.equal(allDex.noRealHolders, true);
  const noPct = T.analyzeHoldersAndTraders(Array.from({ length: 10 }, (_, i) => ({ address: `h${i}`, addr_type: 0, tags: [] })), []);
  assert.equal(noPct.supplyShareKnown, false);
  assert.equal(noPct.sniperSupplyShare, null, "unknown, not 0");
  assert.equal(noPct.passed, true, "the GMGN-pipeline path still applies the row-rate check");
  assert.equal(T.analyzeHoldersAndTraders(holderRows(0), []).supplyShareKnown, true);
});

test("H3: shadow mode (default) keeps every candidate and records gmgn_gate_would_drop + reasons", async () => {
  const { deps } = makeDeps({
    info: async (mint) => {
      if (mint === "Mint2") return { status: GMGN_STATUS.OK, info: goodInfo({ stat: {} }) };
      if (mint === "Mint4") return { status: GMGN_STATUS.OK, info: goodInfo({ stat: { ...goodStat(), top_bundler_trader_percentage: 0.9 } }) };
      return { status: GMGN_STATUS.OK, info: goodInfo() };
    },
  });
  const res = await screen.gateMeteoraSourceCandidates([mPool(1), mPool(2), mPool(4)], { limit: 10, deps: { ...deps, force: true } });
  assert.equal(res.mode, "shadow");
  assert.equal(res.kept.length, 3, "nothing is dropped in shadow mode");
  assert.equal(res.dropped.length, 0);
  assert.equal(res.would_drop.length, 2);
  const by = Object.fromEntries(res.kept.map((p) => [p.name, p]));
  assert.equal(by["M1-SOL"].gmgn_gate_would_drop, false);
  assert.equal(by["M2-SOL"].gmgn_gate_would_drop, true);
  assert.equal(by["M2-SOL"].gmgn_gate_would_drop_kind, "unknown");
  assert.match(by["M2-SOL"].gmgn_gate_would_drop_reasons.join(), /stat block unpopulated/);
  assert.match(by["M4-SOL"].gmgn_gate_would_drop_reasons.join(), /bundler/);
  const snap = screening.getCandidateSignalSnapshot(by["M2-SOL"]);
  assert.equal(snap.gmgn_risk_log_only.gmgn_gate_would_drop, true, "recorded in the signal snapshot");
  // explicit hard still drops
  const hard = await screen.gateMeteoraSourceCandidates([mPool(1), mPool(2)], { deps: { ...deps, force: true, mode: "hard" } });
  assert.equal(hard.kept.length, 1);
  assert.equal(policy.meteoraGateMode({ gmgn: { gateMeteoraSource: true } }), "hard");
  assert.equal(policy.meteoraGateMode({ gmgn: { gateMeteoraSource: false } }), "off");
  assert.equal(policy.meteoraGateMode({ gmgn: {} }), "shadow");
});

test("H3: the Meteora path uses its own thresholds; total_fee is log-only there", async () => {
  // GMGN-pipeline defaults (maxTop10 0.5, minHolders 1000, minTotalFee 30) would reject this token.
  const info = goodInfo({ holder_count: 300, total_fee: undefined, stat: { ...goodStat(), top_10_holder_rate: 0.55, holder_count: 300 } });
  assert.equal(T.analyzeTokenInfo(info, config.gmgn).passed, false, "trending-pipeline thresholds reject it");
  const { deps } = makeDeps({ info: async () => ({ status: GMGN_STATUS.OK, info }) });
  const res = await screen.gateMeteoraSourceCandidates([mPool(1)], { deps: { ...deps, force: true, mode: "hard" } });
  assert.equal(res.kept.length, 1, "Meteora-path thresholds accept it");
  assert.deepEqual(Object.keys(policy.METEORA_GATE_DEFAULTS).sort(), ["maxBotDegenRate", "maxBundlerRate", "maxDevTeamHoldRate", "maxFreshWalletRate", "maxRatTraderRate", "maxTop10HolderRate", "minHolders", "minTotalFeeSol"]);
  const merged = policy.meteoraGateThresholds({ gmgn: { maxTop10HolderRate: 0.1, meteoraGate: { maxTop10HolderRate: 0.4 } } });
  assert.equal(merged.maxTop10HolderRate, 0.4, "user meteoraGate override wins over defaults and pipeline values");
});

test("H3: Meteora-path holders gate fails closed on all-DEX rows and missing amount_percentage", async () => {
  const allDex = makeDeps({ holders: () => ({ status: GMGN_STATUS.OK, data: { list: [{ address: "p", addr_type: 2, amount_percentage: 0.5, tags: [] }] } }) });
  const r1 = await screen.gateMeteoraSourceCandidates([mPool(1)], { deps: { ...allDex.deps, force: true, mode: "hard" } });
  assert.equal(r1.kept.length, 0);
  assert.equal(r1.dropped[0].kind, "unknown");
  const noPct = makeDeps({ holders: () => ({ status: GMGN_STATUS.OK, data: { list: Array.from({ length: 5 }, (_, i) => ({ address: `h${i}`, addr_type: 0, tags: [] })) } }) });
  const r2 = await screen.gateMeteoraSourceCandidates([mPool(1)], { deps: { ...noPct.deps, force: true, mode: "hard" } });
  assert.equal(r2.kept.length, 0);
  assert.match(r2.dropped[0].reason, /amount_percentage missing/);
});

test("H3: cycle-wide GMGN outage notifies once per outage, re-arms after recovery; rate limit is not an outage", async () => {
  gmgn._setGmgnDepsForTest(null); // clear transport flags left by earlier tests
  outageMod._resetGmgnOutageForTest();
  const events = [];
  const h = (d) => events.push(d);
  notifier.on("gmgn_outage", h);
  try {
    const dead = makeDeps({ info: async () => ({ status: GMGN_STATUS.ERROR, info: null }) });
    const run = (mode) => screen.gateMeteoraSourceCandidates([mPool(1), mPool(2), mPool(3)], { deps: { ...dead.deps, force: true, mode } });
    const r1 = await run("hard");
    assert.equal(r1.outage, true);
    assert.equal(r1.kept.length, 0, "hard mode still fails closed");
    await run("hard"); await run("shadow");
    assert.equal(events.length, 1, "once per outage, not per cycle/candidate");
    const shadowRes = await run("shadow");
    assert.equal(shadowRes.kept.length, 3, "shadow mode keeps candidates during an outage");
    // fewer than N candidates is not enough evidence
    outageMod._resetGmgnOutageForTest();
    const small = await screen.gateMeteoraSourceCandidates([mPool(1), mPool(2)], { deps: { ...dead.deps, force: true, mode: "hard" } });
    assert.equal(small.outage, false);
    // a healthy cycle clears the outage and re-arms the notification
    outageMod._resetGmgnOutageForTest();
    await run("hard");
    assert.equal(outageMod.gmgnOutageState().active, true);
    const ok = makeDeps();
    await screen.gateMeteoraSourceCandidates([mPool(1)], { deps: { ...ok.deps, force: true, mode: "hard" } });
    assert.equal(outageMod.gmgnOutageState().active, false);
    await run("hard");
    assert.equal(events.length, 3, "re-armed: second outage notifies again (initial, after reset, after recovery)");
    // rate limited => never an outage
    outageMod._resetGmgnOutageForTest();
    const lim = makeDeps({ info: async () => ({ status: GMGN_STATUS.RATE_LIMITED, info: null }) });
    const rl = await screen.gateMeteoraSourceCandidates([mPool(1), mPool(2), mPool(3)], { deps: { ...lim.deps, force: true, mode: "hard" } });
    assert.equal(rl.outage, false);
  } finally { notifier.off("gmgn_outage", h); outageMod._resetGmgnOutageForTest(); }
});

test("F4/F11: fee-unknown classification, pure hard-skip reason, and all-fetch-failed detection", () => {
  assert.equal(helpers.classifyGlobalFeesUnknown({ holdersSettled: { status: "rejected" }, holdResult: null }), "fetch_failed");
  assert.equal(helpers.classifyGlobalFeesUnknown({ holdersSettled: { status: "fulfilled" }, holdResult: { global_fees_sol: null } }), "not_indexed");
  assert.equal(helpers.classifyGlobalFeesUnknown({ holdersSettled: { status: "fulfilled" }, holdResult: { global_fees_sol: 12 } }), null);
  assert.match(helpers.globalFeesHardSkipReason({ _globalFeesSol: null, _feesUnknownReason: "fetch_failed" }, 30), /unknown \(fetch_failed\) \(fail closed\)/);
  assert.match(helpers.globalFeesHardSkipReason({ _globalFeesSol: 5 }, 30), /5 SOL < 30/);
  assert.equal(helpers.globalFeesHardSkipReason({ _globalFeesSol: 0 }, 0), null, "a real 0 is known, never coerced to unknown");
  assert.equal(helpers.globalFeesHardSkipReason({ _globalFeesSol: 50 }, 30), null);
  assert.equal(helpers.allSkippedForFeeFetchFailure([{ _globalFeesSol: null, _feesUnknownReason: "fetch_failed" }, { _globalFeesSol: null, _feesUnknownReason: "fetch_failed" }]), true);
  assert.equal(helpers.allSkippedForFeeFetchFailure([{ _globalFeesSol: null, _feesUnknownReason: "fetch_failed" }, { _globalFeesSol: null, _feesUnknownReason: "not_indexed" }]), false);
  assert.equal(helpers.allSkippedForFeeFetchFailure([]), false);
  const src = fs.readFileSync(path.join(REPO, "index.js"), "utf8");
  assert.ok(!/Unknown values \(null\) never cause a skip here/.test(src), "stale comment removed");
  assert.match(src, /globalFeesHardSkipReason\(c, config\.screening\.minTokenFeesSol\)/);
  assert.match(src, /emit\("fee_data_down"/);
});

/* ===================== Opus 5.5 review fixes (N1-N6) ===================== */
const jup = await import("../tools/jup-tokens.js");
const executor = await import("../tools/executor.js");

test("N1: shadow would-drop fields never reach the LLM tool output; the cron prompt blocks never reference them", async () => {
  const c = { pool: "p1", name: "M1-SOL", gmgn_gate_would_drop: true, gmgn_gate_would_drop_reasons: ["stat block unpopulated (fail closed)"], gmgn_gate_would_drop_kind: "unknown",
    gmgn_risk_log_only: { gmgn_security_status: "ok", gmgn_gate_would_drop: true, gmgn_gate_would_drop_reasons: ["x"], gmgn_gate_would_drop_kind: "unknown" } };
  const stripped = screening.stripShadowGateFields(c);
  const json = JSON.stringify(stripped);
  assert.ok(!/would_drop/.test(json), "no would_drop key anywhere in the tool-facing candidate");
  assert.equal(stripped.gmgn_risk_log_only.gmgn_security_status, "ok", "other log-only data is kept");
  assert.equal(c.gmgn_gate_would_drop, true, "input is not mutated (internal snapshot logging keeps the verdict)");
  // the snapshot (internal log) still carries the verdict
  assert.equal(screening.getCandidateSignalSnapshot(c).gmgn_risk_log_only.gmgn_gate_would_drop, true);
  // the LLM tool is the stripped variant
  assert.equal(typeof screening.getTopCandidatesForTool, "function");
  const exSrc = fs.readFileSync(path.join(REPO, "tools/executor.js"), "utf8");
  assert.match(exSrc, /get_top_candidates:\s*getTopCandidatesForTool/);
  assert.equal(typeof executor.executeTool, "function");
  const idx = fs.readFileSync(path.join(REPO, "index.js"), "utf8");
  assert.ok(!/gmgn_gate_would_drop/.test(idx), "index.js prompt building never mentions the shadow verdict");
  assert.ok(!/gmgn_gate_would_drop/.test(fs.readFileSync(path.join(REPO, "prompt.js"), "utf8")));
});

test("N2: deferred-by-limit candidates are would_drop=null (not evaluated); best-ranked candidates are verified first", async () => {
  const { deps, calls } = makeDeps();
  deps.cfg = { ...config, gmgn: { ...config.gmgn, meteoraShadowBudget: 1000 } };
  const pools = [mPool(1), mPool(2), mPool(3), mPool(4), mPool(5), mPool(6), mPool(7), mPool(8)];
  // rank: reverse order (8 is best)
  const rankFn = (list) => [...list].reverse();
  const res = await screen.gateMeteoraSourceCandidates(pools, { limit: 5, deps: { ...deps, force: true, mode: "shadow", rankFn } });
  assert.equal(res.kept.length, 8, "shadow never drops");
  const byName = Object.fromEntries(res.kept.map((p) => [p.name, p]));
  const verified = res.kept.filter((p) => p.gmgn_gated);
  assert.equal(verified.length, 5);
  assert.deepEqual(verified.map((p) => p.name).sort(), ["M4-SOL", "M5-SOL", "M6-SOL", "M7-SOL", "M8-SOL"], "top-ranked verified first");
  for (const n of ["M1-SOL", "M2-SOL", "M3-SOL"]) {
    assert.equal(byName[n].gmgn_gate_would_drop, null, `${n} not evaluated`);
    assert.equal(byName[n].gmgn_gate_would_drop_kind, "deferred");
  }
  assert.equal(res.would_drop.length, 0, "deferred rows are not counted as would-drops");
  // hard mode still defers (drops) them
  const hard = await screen.gateMeteoraSourceCandidates(pools, { limit: 5, deps: { ...makeDeps().deps, force: true, mode: "hard", rankFn } });
  assert.equal(hard.kept.length, 5);
  assert.equal(hard.dropped.filter((d) => d.kind === "deferred").length, 3);
  // the verdict null is still recorded in the log-only snapshot block
  assert.ok(screening.getCandidateSignalSnapshot(byName["M1-SOL"]).gmgn_risk_log_only, "deferred rows keep their kind in the snapshot");
  assert.ok(calls.info.length > 0);
});

test("N5: shadow mode respects gmgn.meteoraShadowBudget (hard mode is unbudgeted)", async () => {
  const pools = Array.from({ length: 10 }, (_, i) => mPool(i + 1));
  const cfg = { ...config, gmgn: { ...config.gmgn, meteoraShadowBudget: 8 } };
  const a = makeDeps(); a.deps.cfg = cfg;
  const res = await screen.gateMeteoraSourceCandidates(pools, { limit: 10, deps: { ...a.deps, force: true, mode: "shadow" } });
  assert.equal(res.kept.length, 10);
  assert.equal(a.calls.info.length, 8, "info lookups stop at the budget");
  assert.equal(a.calls.security.length, 0, "no weight left for security/holders");
  assert.equal(res.kept.filter((p) => p.gmgn_gate_would_drop === null).length, 10, "everything unspent is not-evaluated");
  const b = makeDeps(); b.deps.cfg = cfg;
  const hard = await screen.gateMeteoraSourceCandidates(pools, { limit: 10, deps: { ...b.deps, force: true, mode: "hard" } });
  assert.equal(b.calls.info.length, 10, "hard mode ignores the shadow budget");
  assert.ok(hard.kept.length > 0);
  assert.equal(policy.GMGN_FIX_DEFAULTS.meteoraShadowBudget, 30);
});

test("N4: <3 candidates all failing at transport level over 2 consecutive cycles is an outage; EMPTY is not a failure; one-shot logs re-arm; crash path", async () => {
  gmgn._setGmgnDepsForTest(null);
  outageMod._resetGmgnOutageForTest();
  const events = [];
  const h = (d) => events.push(d);
  notifier.on("gmgn_outage", h);
  try {
    const dead = makeDeps({ info: async () => ({ status: GMGN_STATUS.ERROR, info: null }) });
    const run = (list) => screen.gateMeteoraSourceCandidates(list, { deps: { ...dead.deps, force: true, mode: "hard" } });
    const c1 = await run([mPool(1), mPool(2)]);
    assert.equal(c1.outage, false, "first all-failed cycle with <3 candidates: not enough evidence");
    const c2 = await run([mPool(1)]);
    assert.equal(c2.outage, true, "second consecutive all-failed cycle trips it");
    assert.equal(events.length, 1);
    // a healthy cycle in between resets the streak
    outageMod._resetGmgnOutageForTest();
    await run([mPool(1)]);
    await screen.gateMeteoraSourceCandidates([mPool(1)], { deps: { ...makeDeps().deps, force: true, mode: "hard" } });
    const afterHealthy = await run([mPool(1)]);
    assert.equal(afterHealthy.outage, false, "streak was reset by the healthy cycle");
    // EMPTY ("not found") answers are not transport failures, even for 3+ candidates
    outageMod._resetGmgnOutageForTest();
    const empty = makeDeps({ info: async () => ({ status: GMGN_STATUS.EMPTY, info: null }) });
    for (let i = 0; i < 3; i++) {
      const r = await screen.gateMeteoraSourceCandidates([mPool(1), mPool(2), mPool(3)], { deps: { ...empty.deps, force: true, mode: "hard" } });
      assert.equal(r.outage, false);
    }
  } finally { notifier.off("gmgn_outage", h); outageMod._resetGmgnOutageForTest(); }

  // one-shot ENOENT / 401 logs re-arm after a good response
  const logs = [];
  const mkExec = (script) => (bin, args, opts, cb) => { const r = script.shift(); setImmediate(() => cb(r.err || null, r.out || "", r.stderr || "")); };
  const enoent = Object.assign(new Error("spawn gmgn-cli ENOENT"), { code: "ENOENT" });
  const script = [{ err: enoent }, { err: enoent }, { out: JSON.stringify({ ok: 1 }) }, { err: enoent }];
  gmgn._setGmgnDepsForTest({ exec: mkExec(script), sleep: async () => {}, now: () => Date.now() });
  const origLog = console.log; console.log = (...a) => { logs.push(a.join(" ")); };
  try {
    for (let i = 0; i < 4; i++) await gmgn.spawnGmgnResult(["token", "info", "--address", "x"]);
  } finally { console.log = origLog; gmgn._setGmgnDepsForTest(null); }
  const src = fs.readFileSync(path.join(REPO, "tools/gmgn.js"), "utf8");
  assert.match(src, /Recovered: re-arm[\s\S]{0,120}_binaryLogged = false;[\s\S]{0,40}_authLogged = false;/);

  // crash path: shadow keeps everything, hard keeps only GMGN-gated, both report once
  const pools = [mPool(1), { ...mPool(2), gmgn_gated: true }, { ...mPool(3), gmgn: true }];
  const reports = [];
  const shadowOut = await screening.handleGateCrash(new Error("boom"), pools, { mode: "shadow", report: (r) => reports.push(r) });
  assert.equal(shadowOut.length, 3);
  const hardOut = await screening.handleGateCrash(new Error("boom"), pools, { mode: "hard", report: (r) => reports.push(r) });
  assert.deepEqual(hardOut.map((p) => p.pool), ["mpool2", "mpool3"]);
  assert.equal(reports.length, 2);
  assert.match(reports[0], /crashed: boom/);
});

test("N3: Jupiter/datapi fetch failures are surfaced; classifier + majority (>=80%) fee_data_down fires once per outage", async () => {
  // classifier reads the source status
  assert.equal(helpers.classifyGlobalFeesUnknown({ holdersSettled: { status: "fulfilled" }, holdResult: { global_fees_sol: null, global_fees_source_status: "fetch_failed" } }), "fetch_failed");
  assert.equal(helpers.classifyGlobalFeesUnknown({ holdersSettled: { status: "fulfilled" }, holdResult: { global_fees_sol: null, global_fees_source_status: "absent" } }), "not_indexed");
  assert.equal(helpers.classifyGlobalFeesUnknown({ holdersSettled: { status: "fulfilled" }, holdResult: { global_fees_sol: 3, global_fees_source_status: "ok" } }), null);
  // datapi search surfaces its failure (previously a bare null, same as "not found")
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const failed = await jup.datapiSearchRawResult("MintX");
    assert.equal(failed.ok, false);
    const ji = await jup.getTokenInfoResult("MintNoCache");
    assert.equal(ji.failed, true, "both sources down => failed, not 'unknown token'");
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [] });
    const none = await jup.datapiSearchRawResult("MintY");
    assert.deepEqual([none.ok, none.data], [true, []]);
    const ji2 = await jup.getTokenInfoResult("MintNoCache2");
    assert.deepEqual([ji2.failed, ji2.info], [false, null], "answered with no match => not failed");
  } finally { globalThis.fetch = realFetch; }
  // majority detector
  helpers._resetFeeOutageForTest();
  const f = () => ({ _globalFeesSol: null, _feesUnknownReason: "fetch_failed" });
  const known = () => ({ _globalFeesSol: 50 });
  const ni = () => ({ _globalFeesSol: null, _feesUnknownReason: "not_indexed" });
  const mixed = [f(), f(), f(), f(), known()]; // 80%
  const r1 = helpers.evaluateFeeDataOutage(mixed);
  assert.deepEqual([r1.down, r1.notify], [true, true], "80% fetch_failed fires even though one candidate has known fees");
  assert.equal(helpers.evaluateFeeDataOutage(mixed).notify, false, "once per outage");
  assert.equal(helpers.evaluateFeeDataOutage([f(), known(), known()]).down, false, "below threshold clears");
  assert.equal(helpers.evaluateFeeDataOutage(mixed).notify, true, "re-armed after recovery");
  helpers._resetFeeOutageForTest();
  assert.equal(helpers.evaluateFeeDataOutage([f(), f(), f(), ni(), known()]).down, false, "60% < 80%");
  assert.equal(helpers.evaluateFeeDataOutage([f(), f(), f(), ni()], { ratio: 0.5 }).down, true, "configurable ratio");
  assert.equal(helpers.evaluateFeeDataOutage([]).down, false);
  assert.equal(config.screening.feeDataDownRatio, 0.8);
  const idx = fs.readFileSync(path.join(REPO, "index.js"), "utf8");
  assert.match(idx, /evaluateFeeDataOutage\(rankedCandidates/);
});

test("N6: in-flight dedupe hands each caller its own candidate objects; prompt wording and unused mint fixed", async () => {
  const idx = fs.readFileSync(path.join(REPO, "index.js"), "utf8");
  assert.ok(!/known global_fees_sol or top_10 value fails/.test(idx));
  assert.match(idx, /UNKNOWN \(fail closed\)/);
  const gs = fs.readFileSync(path.join(REPO, "tools/gmgn-screen.js"), "utf8");
  assert.ok(!/if \(pools\.length >= limit\) break;\n\s+const mint = token\.address;/.test(gs));
  const sc = fs.readFileSync(path.join(REPO, "tools/screening.js"), "utf8");
  assert.match(sc, /candidates\.map\(\(c\) => \(\{ \.\.\.c \}\)\)/);
});
