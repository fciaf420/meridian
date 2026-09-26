// Entry-safety filters: token guards, pool status, SOL-fee-only, TWAP spike,
// deploy hard checks, Telegram toggles and the LLM can't-loosen rule.
// Everything is mocked: no RPC, no Telegram API, no transaction. Runs in a temp
// cwd with a temp user-config.json so nothing in the repo is touched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import BN from "bn.js";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-entry-"));
const USER_CFG = path.join(TMP, "user-config.json");
fs.writeFileSync(USER_CFG, JSON.stringify({ maxPositions: 2, someOtherKey: "keep-me" }, null, 2));
process.env.MERIDIAN_USER_CONFIG_PATH = USER_CFG;
process.env.WALLET_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
process.env.RPC_URL = "http://127.0.0.1:9"; // never reached: every read is mocked
delete process.env.HELIUS_API_KEY;
delete process.env.DRY_RUN;
delete process.env.TELEGRAM_BOT_TOKEN;
process.chdir(TMP);
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const es = await import("../tools/entry-safety.js");
es._setJupiterLookupForTest(async () => new Map()); // hermetic: no Jupiter Tokens API calls
const { config } = await import("../config.js");
const dlmm = await import("../tools/dlmm.js");
config.strategy.activeStrategy = "classic"; // Evil Panda's GMGN gate would run first
config.management.allowBinArrayInit = false;

const WSOL = "So11111111111111111111111111111111111111112";
const MINT = "Mint1111111111111111111111111111111111111111";
const KEY_A = Keypair.generate().publicKey;

// ─── Token-2022 TLV builders ──────────────────────────────────────
function tlvEntry(type, value) {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(value.length, 2);
  return Buffer.concat([head, value]);
}
function transferFeeTlv(olderBps, newerBps = olderBps, newerEpoch = 900) {
  const v = Buffer.alloc(108);
  v.writeUInt16LE(olderBps, 88);
  v.writeBigUInt64LE(BigInt(newerEpoch), 90);
  v.writeUInt16LE(newerBps, 106);
  return tlvEntry(es.EXT.TransferFeeConfig, v);
}
const hookTlv = (programId = KEY_A) => tlvEntry(es.EXT.TransferHook, Buffer.concat([Buffer.alloc(32), programId.toBuffer()]));
const delegateTlv = () => tlvEntry(es.EXT.PermanentDelegate, KEY_A.toBuffer());
const frozenDefaultTlv = () => tlvEntry(es.EXT.DefaultAccountState, Buffer.from([2]));
const pausableTlv = (paused = false) => tlvEntry(es.EXT.PausableConfig, Buffer.concat([KEY_A.toBuffer(), Buffer.from([paused ? 1 : 0])]));
const nonTransferableTlv = () => tlvEntry(es.EXT.NonTransferable, Buffer.alloc(0));
const metadataPointerTlv = () => tlvEntry(es.EXT.MetadataPointer, Buffer.alloc(64));

const pk = (s) => ({ toBase58: () => s, toString: () => s, equals: (o) => String(o) === s });

function reserve({ program = es.TOKEN_2022_PROGRAM_ID, tlv = [], freeze = null, mintAuth = null } = {}) {
  return {
    publicKey: pk(MINT),
    owner: pk(program),
    mint: { address: pk(MINT), decimals: 6, mintAuthority: mintAuth, freezeAuthority: freeze, tlvData: Buffer.concat(tlv) },
  };
}

const ALL_ON = { ...es.ENTRY_FILTER_DEFAULTS, blockMintAuthority: true };
const ALL_OFF = Object.fromEntries(Object.keys(es.ENTRY_FILTER_DEFAULTS).map((k) => [k, k === "blockTransferFeeAbovePct" ? null : false]));

// ─── 1. Token guards ──────────────────────────────────────────────
const GUARD_CASES = [
  ["blockTransferHook", () => reserve({ tlv: [hookTlv()] }), /transfer hook/i],
  ["blockPermanentDelegate", () => reserve({ tlv: [delegateTlv()] }), /permanent delegate/i],
  ["blockFreezeAuthority", () => reserve({ freeze: KEY_A }), /freeze authority/i],
  ["blockFreezeAuthority", () => reserve({ tlv: [frozenDefaultTlv()] }), /default account state is FROZEN/i],
  ["blockMintAuthority", () => reserve({ mintAuth: KEY_A }), /mint authority is not renounced/i],
  ["blockPausable", () => reserve({ tlv: [pausableTlv()] }), /pausable/i],
  ["blockNonTransferable", () => reserve({ tlv: [nonTransferableTlv()] }), /non-transferable/i],
];

test("token guards: each guard blocks when on and allows when off, naming the reason", () => {
  for (const [key, mk, re] of GUARD_CASES) {
    const facts = es.mintFactsFromSdkReserve(mk());
    const on = es.evaluateTokenGuards(facts, { ...ALL_OFF, [key]: true });
    assert.equal(on.pass, false, `${key} on should block`);
    assert.match(on.reasons.join(" "), re);
    assert.match(on.reasons.join(" "), new RegExp(key));
    const off = es.evaluateTokenGuards(facts, { ...ALL_OFF, [key]: false });
    assert.equal(off.pass, true, `${key} off should allow`);
    const line = off.checks.find((c) => c.off && c.pass === null);
    assert.ok(line, `${key} off still shows the finding as a neutral line`);
  }
});

test("token guards: a clean Token-2022 mint (metadata only) and a legacy SPL mint pass everything", () => {
  const t22 = es.evaluateTokenGuards(es.mintFactsFromSdkReserve(reserve({ tlv: [metadataPointerTlv()] })), ALL_ON);
  assert.equal(t22.pass, true, t22.reasons.join());
  assert.match(t22.checks[0].text, /token-2022 \(metadataPointer\)/);
  const spl = es.evaluateTokenGuards(es.mintFactsFromSdkReserve(reserve({ program: es.TOKEN_PROGRAM_ID })), ALL_ON);
  assert.equal(spl.pass, true);
  assert.ok(spl.checks.every((c) => c.pass === true));
});

test("transfer fee threshold: blocks above, allows at/below, null disables; shows the actual fee", () => {
  const f = (older, newer) => es.mintFactsFromSdkReserve(reserve({ tlv: [transferFeeTlv(older, newer)] }));
  assert.equal(es.evaluateTokenGuards(f(100, 100), { ...ALL_ON, blockTransferFeeAbovePct: 1 }).pass, true); // 1% == limit
  const hi = es.evaluateTokenGuards(f(150, 150), { ...ALL_ON, blockTransferFeeAbovePct: 1 });
  assert.equal(hi.pass, false);
  assert.match(hi.reasons[0], /transfer fee 1\.5% is above the 1% limit \(blockTransferFeeAbovePct\)/);
  assert.match(hi.checks.find((c) => c.key === "transfer_fee").text, /Transfer fee: 1\.5%/);
  // A scheduled (newer) fee counts: 0.5% now → 3% at a later epoch.
  const sched = es.evaluateTokenGuards(f(50, 300), { ...ALL_ON, blockTransferFeeAbovePct: 2 });
  assert.equal(sched.pass, false);
  assert.match(sched.checks.find((c) => c.key === "transfer_fee").text, /0\.5% → 3% from epoch 900/);
  assert.equal(es.evaluateTokenGuards(f(5000, 5000), { ...ALL_ON, blockTransferFeeAbovePct: null }).pass, true);
});

test("jsonParsed mint facts (RPC fallback) map every extension the guards need", () => {
  const value = {
    owner: es.TOKEN_2022_PROGRAM_ID,
    data: {
      program: "spl-token-2022",
      parsed: {
        type: "mint",
        info: {
          decimals: 6, mintAuthority: null, freezeAuthority: null,
          extensions: [
            { extension: "transferFeeConfig", state: { olderTransferFee: { transferFeeBasisPoints: 250, epoch: 1 }, newerTransferFee: { transferFeeBasisPoints: 250, epoch: 2 } } },
            { extension: "transferHook", state: { authority: null, programId: KEY_A.toBase58() } },
            { extension: "permanentDelegate", state: { delegate: KEY_A.toBase58() } },
            { extension: "defaultAccountState", state: { accountState: "frozen" } },
            { extension: "nonTransferable" },
            { extension: "pausableConfig", state: { authority: KEY_A.toBase58(), paused: false } },
          ],
        },
      },
    },
  };
  const facts = es.mintFactsFromParsed(value, MINT);
  assert.equal(facts.program, "token-2022");
  assert.equal(facts.transferFee.pct, 2.5);
  const r = es.evaluateTokenGuards(facts, ALL_ON);
  assert.deepEqual(r.checks.filter((c) => c.pass === false).map((c) => c.key).sort(),
    ["freeze_authority", "non_transferable", "pausable", "permanent_delegate", "transfer_fee", "transfer_hook"]);
});

test("screening: API fields decide legacy SPL mints with no RPC; Token-2022 mints are read in one batch", async () => {
  const pools = [
    { pool: "P1", name: "SPL-OK", base: { mint: "M1", token_program: es.TOKEN_PROGRAM_ID, has_freeze_authority: false, has_mint_authority: false } },
    { pool: "P2", name: "SPL-FREEZE", base: { mint: "M2", token_program: es.TOKEN_PROGRAM_ID, has_freeze_authority: true, has_mint_authority: false } },
    { pool: "P3", name: "T22-HOOK", base: { mint: "M3", token_program: es.TOKEN_2022_PROGRAM_ID, has_freeze_authority: false, has_mint_authority: false } },
    { pool: "P4", name: "T22-OK", base: { mint: "M4", token_program: es.TOKEN_2022_PROGRAM_ID, has_freeze_authority: false, has_mint_authority: false } },
    { pool: "P5", name: "GMGN-ONLY", base: { mint: "M5" } },
  ];
  const reads = [];
  const readMints = async (mints) => {
    reads.push(mints);
    return new Map([
      ["M3", es.mintFactsFromSdkReserve(reserve({ tlv: [hookTlv()] }))],
      ["M4", es.mintFactsFromSdkReserve(reserve({ tlv: [metadataPointerTlv()] }))],
      ["M5", es.mintFactsFromSdkReserve(reserve({ program: es.TOKEN_PROGRAM_ID }))],
    ]);
  };
  const { kept, dropped } = await es.screenTokenGuards(pools, { filters: es.ENTRY_FILTER_DEFAULTS, readMints });
  assert.deepEqual(reads, [["M3", "M4", "M5"]], "one batched read, only for mints the API can't decide");
  assert.deepEqual(kept.map((p) => p.name), ["SPL-OK", "T22-OK", "GMGN-ONLY"]);
  assert.deepEqual(dropped.map((d) => d.name), ["SPL-FREEZE", "T22-HOOK"]);
  assert.match(dropped[0].reasons[0], /freeze authority/);
});

test("screening: a failed mint read keeps the candidate tagged unknown (deploy re-checks)", async () => {
  const { kept } = await es.screenTokenGuards(
    [{ pool: "P", name: "X", base: { mint: "M", token_program: es.TOKEN_2022_PROGRAM_ID, has_freeze_authority: false } }],
    { readMints: async () => { throw new Error("rpc down"); } },
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].token_safety.unknown, true);
});

// ─── Deploy hard checks ──────────────────────────────────────────
function mockPool(over = {}) {
  const calls = [];
  const now = Math.floor(Date.now() / 1000);
  const pool = {
    calls,
    pubkey: pk("PoolMock11111111111111111111111111111111111"),
    lbPair: {
      tokenYMint: pk(WSOL),
      tokenXMint: pk(MINT),
      status: 0,
      pairType: 3,
      activationType: 1,
      activationPoint: new BN(0),
      binStep: 100,
      activeId: 1000,
      parameters: { collectFeeMode: 1 },
      ...(over.lbPair || {}),
    },
    clock: { slot: new BN(5_000), unixTimestamp: new BN(now) },
    tokenX: over.tokenX || reserve({ tlv: [metadataPointerTlv()] }),
    tokenY: { mint: { decimals: 9 } },
    isSwapDisabled: () => false,
    // The first call after the entry checks (the fresh-bin refetch before the
    // range is computed): stop the deploy here with a sentinel.
    refetchStates: async () => { calls.push("refetchStates"); throw new Error("PAST_ENTRY_CHECKS"); },
    getActiveBin: async () => { calls.push("getActiveBin"); throw new Error("PAST_ENTRY_CHECKS"); },
    getOracle: async () => { calls.push("getOracle"); return over.oracle ?? null; },
    initializePositionAndAddLiquidityByStrategy: async () => { calls.push("tx"); throw new Error("must not build a tx"); },
    initializeMultiplePositionAndAddLiquidityByStrategy: async () => { calls.push("tx"); throw new Error("must not build a tx"); },
  };
  return pool;
}

es._setApiRowFetcherForTest(async () => ({ is_blacklisted: false }));

async function deployInto(pool, args = {}) {
  const addr = `Pool${Math.random().toString(36).slice(2, 10)}`;
  dlmm._setPoolForTest(addr, pool);
  try {
    return await dlmm.deployPosition({ pool_address: addr, amount_y: 0.5, strategy: "bid_ask", price_range_pct: 50, bin_step: 100, ...args });
  } finally {
    dlmm._setPoolForTest(addr, null);
  }
}

test("deploy: token guards refuse before any tx, swap or active-bin read; the reason is exact", async () => {
  config.entryFilters = { ...es.ENTRY_FILTER_DEFAULTS };
  const pool = mockPool({ tokenX: reserve({ tlv: [delegateTlv()] }) });
  const r = await deployInto(pool);
  assert.equal(r.success, false);
  assert.equal(r.blocked_by, "entry_filter");
  assert.match(r.error, /^Token safety: Token-2022 permanent delegate .* \(blockPermanentDelegate\)$/);
  assert.deepEqual(pool.calls, [], "no getActiveBin, no tx builder");

  const fee = await deployInto(mockPool({ tokenX: reserve({ tlv: [transferFeeTlv(500)] }) }));
  assert.match(fee.error, /transfer fee 5% is above the 1% limit/);

  // Guard off → the same mint passes the token stage (and reaches the pool).
  config.entryFilters = { ...es.ENTRY_FILTER_DEFAULTS, blockPermanentDelegate: false };
  const okPool = mockPool({ tokenX: reserve({ tlv: [delegateTlv()] }) });
  await assert.rejects(deployInto(okPool), /PAST_ENTRY_CHECKS/);
  assert.deepEqual(okPool.calls, ["getOracle", "refetchStates"]);
  config.entryFilters = { ...es.ENTRY_FILTER_DEFAULTS };
});

test("deploy: an unidentifiable token program or missing mint data fails closed", async () => {
  const r = await deployInto(mockPool({ tokenX: { owner: pk("SomeOtherProgram111111111111111111111111111"), mint: { decimals: 6, tlvData: Buffer.alloc(0) } } }));
  assert.equal(r.blocked_by, "entry_filter");
  assert.match(r.error, /could not identify the base token's program/);
});

// ─── Token lookup card ───────────────────────────────────────────
const lookupMod = await import("../tools/token-lookup.js");
const ui = await import("../telegram-ui.js");
const LOOKUP_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const LOOKUP_POOL = "PoolLookup1111111111111111111111111111111111";
function lookupDeps(over = {}) {
  return {
    searchPools: async () => [{ address: LOOKUP_POOL, name: "TOK-SOL", token_x: { symbol: "TOK", address: LOOKUP_MINT }, token_y: { symbol: "SOL", address: WSOL }, pool_config: { bin_step: 100 }, tvl: 20_000 }],
    poolDetail: async () => ({
      pool_address: LOOKUP_POOL, name: "TOK-SOL", pool_type: "dlmm", is_blacklisted: false,
      token_x: { symbol: "TOK", address: LOOKUP_MINT, organic_score: 80, market_cap: 2e6, token_program: es.TOKEN_2022_PROGRAM_ID, has_freeze_authority: false, has_mint_authority: false },
      token_y: { symbol: "SOL", address: WSOL },
      dlmm_params: { bin_step: 100, collect_fee_mode: "quote" }, tvl: 20_000, active_tvl: 20_000, volume: 5e4, fee: 100, fee_active_tvl_ratio: 0.5, volatility: 3, base_token_holders: 900,
    }),
    gmgnPriceInfo: async () => null,
    gmgnSignal: async () => null,
    isBlacklisted: () => false,
    readMint: async () => es.mintFactsFromSdkReserve(reserve({ tlv: [hookTlv(), transferFeeTlv(30)] })),
    poolEntryState: async () => null,
    ...over,
  };
}

test("token lookup: shows each token guard as ✅/❌/➖ with the actual fee; ❌ lines reach the confirm card", async () => {
  const r = await lookupMod.lookupToken(LOOKUP_MINT, { deps: lookupDeps(), entryFilters: es.ENTRY_FILTER_DEFAULTS });
  assert.equal(r.token_safety.pass, false);
  const card = ui.renderTokenCard(r, { tokenRef: "t1", poolRefs: ["p1"] }).text;
  assert.match(card, /<b>Entry filters<\/b> \(token\) — ⛔ deploy_position will refuse/);
  assert.match(card, /❌ Transfer hook: program/);
  assert.match(card, /✅ Transfer fee: 0\.3% \(limit 1%\)/);
  assert.match(card, /✅ Freeze authority: none/);
  assert.match(card, /➖ Mint authority: renounced — guard off/);
  assert.ok(ui.failedFilterLines(r.pools[0]).some((l) => /Transfer hook/.test(l)));
});

test("token lookup: a failed mint read falls back to the API's token_program/authority flags", async () => {
  const r = await lookupMod.lookupToken(LOOKUP_MINT, { deps: lookupDeps({ readMint: async () => { throw new Error("rpc down"); } }), entryFilters: es.ENTRY_FILTER_DEFAULTS });
  assert.equal(r.token_safety.unknown, true);
  const card = ui.renderTokenCard(r, { tokenRef: "t1" }).text;
  assert.match(card, /✅ Freeze authority: none/);
  assert.match(card, /❔ Transfer hook: unknown \(mint not read\)/);
});

// ─── 2. Pool status guard (always on) ────────────────────────────
test("pool status: disabled, future activation (timestamp and slot), blacklist refuse; unknown blacklist allows with a note", () => {
  const now = 1_800_000_000;
  const base = { status: 0, pairType: 3, activationType: 1, activationPoint: new BN(0) };
  const clock = { slot: new BN(5_000), unixTimestamp: new BN(now - 30) };
  assert.equal(es.evaluatePoolStatus({ lbPair: base, clock, nowSec: now, apiBlacklisted: false }).pass, true);
  const dis = es.evaluatePoolStatus({ lbPair: { ...base, status: 1 }, clock, nowSec: now, apiBlacklisted: false });
  assert.equal(dis.pass, false);
  assert.match(dis.reasons[0], /pair status is Disabled/);
  // PermissionlessV2 with a future timestamp activation: the SDK's isSwapDisabled would say false.
  const fut = es.evaluatePoolStatus({ lbPair: { ...base, activationPoint: new BN(now + 600) }, clock, nowSec: now, apiBlacklisted: false });
  assert.equal(fut.pass, false);
  assert.match(fut.reasons[0], /activation time .* is in the future \(in 10 min\)/);
  assert.equal(es.evaluatePoolStatus({ lbPair: { ...base, activationPoint: new BN(now - 600) }, clock, nowSec: now, apiBlacklisted: false }).pass, true);
  const slot = es.evaluatePoolStatus({ lbPair: { ...base, activationType: 0, activationPoint: new BN(6_000) }, clock, nowSec: now, apiBlacklisted: false });
  assert.match(slot.reasons[0], /activation slot 6000 is in the future \(current slot 5000\)/);
  const bl = es.evaluatePoolStatus({ lbPair: base, clock, nowSec: now, apiBlacklisted: true });
  assert.match(bl.reasons[0], /blacklisted/);
  const unk = es.evaluatePoolStatus({ lbPair: base, clock, nowSec: now, apiBlacklisted: null });
  assert.equal(unk.pass, true);
  assert.match(unk.notes[0], /blacklist flag unknown/);
  assert.equal(es.evaluatePoolStatus({ lbPair: null }).pass, false, "no pool state fails closed");
});

test("deploy: pool status refuses before any tx (disabled, future activation, API blacklist)", async () => {
  const now = Math.floor(Date.now() / 1000);
  const dis = mockPool({ lbPair: { status: 1 } });
  const r1 = await deployInto(dis);
  assert.equal(r1.blocked_by, "entry_filter");
  assert.match(r1.error, /^Pool status: pair status is Disabled/);
  assert.deepEqual(dis.calls, []);
  const fut = mockPool({ lbPair: { activationPoint: new BN(now + 3600) } });
  const r2 = await deployInto(fut);
  assert.match(r2.error, /^Pool status: activation time .* in the future/);
  assert.deepEqual(fut.calls, []);
  es._setApiRowFetcherForTest(async () => ({ is_blacklisted: true }));
  const r3 = await deployInto(mockPool());
  assert.match(r3.error, /Meteora API flags the pool as blacklisted/);
  es._setApiRowFetcherForTest(async () => null); // API down → allowed (on-chain checks still ran)
  await assert.rejects(deployInto(mockPool()), /PAST_ENTRY_CHECKS/);
  es._setApiRowFetcherForTest(async () => ({ is_blacklisted: false }));
});

test("screening: API-blacklisted pools are dropped; lookup card shows the pool status line", async () => {
  const { kept, dropped } = await es.screenEntryCandidates(
    [{ pool: "A", name: "A", is_blacklisted: true, base: { mint: "M", token_program: es.TOKEN_PROGRAM_ID } },
      { pool: "B", name: "B", is_blacklisted: false, base: { mint: "N", token_program: es.TOKEN_PROGRAM_ID } }],
    { filters: es.ENTRY_FILTER_DEFAULTS, readMints: async () => new Map() },
  );
  assert.deepEqual(kept.map((p) => p.pool), ["B"]);
  assert.match(dropped[0].reasons[0], /blacklisted/);

  const now = Math.floor(Date.now() / 1000);
  const r = await lookupMod.lookupToken(LOOKUP_MINT, {
    deps: lookupDeps({ poolEntryState: async (_p, opts) => es.describePoolEntryState(mockPool({ lbPair: { activationPoint: new BN(now + 1200) } }), opts) }),
    entryFilters: es.ENTRY_FILTER_DEFAULTS,
  });
  const card = ui.renderTokenCard(r, { tokenRef: "t1" }).text;
  assert.match(card, /⛔ Pool status: activation time .* in the future \(in 20 min\)/);
  const ok = await lookupMod.lookupToken(LOOKUP_MINT, {
    deps: lookupDeps({ poolEntryState: async (_p, opts) => es.describePoolEntryState(mockPool(), opts) }),
    entryFilters: es.ENTRY_FILTER_DEFAULTS,
  });
  assert.match(ui.renderTokenCard(ok, { tokenRef: "t1" }).text, /✅ Pool status: enabled · active · not blacklisted/);
});

// ─── 3. SOL-fee-only pools ───────────────────────────────────────
test("fee mode: on-chain CollectFeeMode and the API string map to the same modes", () => {
  assert.deepEqual(es.feeModeFromLbPair({ parameters: { collectFeeMode: 1 }, tokenYMint: pk(WSOL) }).solFees, true);
  assert.equal(es.feeModeFromLbPair({ parameters: { collectFeeMode: 1 }, tokenYMint: pk("UsdcMint") }).solFees, false, "OnlyY but Y isn't SOL");
  assert.equal(es.feeModeFromLbPair({ parameters: { collectFeeMode: 0 }, tokenYMint: pk(WSOL) }).mode, "InputOnly");
  assert.equal(es.feeModeFromLbPair({ parameters: {} }).mode, "unknown");
  assert.equal(es.feeModeFromApi("quote").solFees, true);
  assert.equal(es.feeModeFromApi("both").mode, "InputOnly");
  assert.equal(es.feeModeFromApi(null).mode, "unknown");
});

test("screening: solFeePoolsOnly drops InputOnly pools, keeps OnlyY and unknown (tagged); off keeps all", async () => {
  const pools = [
    { pool: "Q", name: "QUOTE", collect_fee_mode: "quote", base: { mint: "M1", token_program: es.TOKEN_PROGRAM_ID } },
    { pool: "B", name: "BOTH", collect_fee_mode: "both", base: { mint: "M2", token_program: es.TOKEN_PROGRAM_ID } },
    { pool: "U", name: "UNKNOWN", base: { mint: "M3", token_program: es.TOKEN_PROGRAM_ID } },
  ];
  const on = await es.screenEntryCandidates(pools, { filters: { ...es.ENTRY_FILTER_DEFAULTS, solFeePoolsOnly: true }, readMints: async () => new Map() });
  assert.deepEqual(on.kept.map((p) => p.name), ["QUOTE", "UNKNOWN"]);
  assert.match(on.dropped[0].reasons[0], /CollectFeeMode InputOnly\) \(solFeePoolsOnly\)/);
  assert.equal(on.kept[1].fee_mode.mode, "unknown");
  const off = await es.screenEntryCandidates(pools, { filters: es.ENTRY_FILTER_DEFAULTS, readMints: async () => new Map() });
  assert.equal(off.kept.length, 3);
  assert.equal(off.kept[1].fee_mode.mode, "InputOnly", "tagged even when the filter is off");
});

test("deploy: solFeePoolsOnly refuses an InputOnly pool before any tx; OnlyY passes; off allows InputOnly", async () => {
  config.entryFilters = { ...es.ENTRY_FILTER_DEFAULTS, solFeePoolsOnly: true };
  const inputOnly = mockPool({ lbPair: { parameters: { collectFeeMode: 0 } } });
  const r = await deployInto(inputOnly);
  assert.equal(r.blocked_by, "entry_filter");
  assert.match(r.error, /^Fee mode: pool pays LP fees in the input token \(CollectFeeMode InputOnly\), not SOL \(solFeePoolsOnly\)$/);
  assert.deepEqual(inputOnly.calls, []);
  await assert.rejects(deployInto(mockPool({ lbPair: { parameters: { collectFeeMode: 1 } } })), /PAST_ENTRY_CHECKS/);
  config.entryFilters = { ...es.ENTRY_FILTER_DEFAULTS, solFeePoolsOnly: false };
  await assert.rejects(deployInto(mockPool({ lbPair: { parameters: { collectFeeMode: 0 } } })), /PAST_ENTRY_CHECKS/);
  config.entryFilters = { ...es.ENTRY_FILTER_DEFAULTS };
});

test("cards: fee mode on candidate, lookup and confirm cards", async () => {
  const cands = ui.renderCandidates([
    { pool: "CandPool1111111111111111111111111111111111111", name: "AAA-SOL", bin_step: 100, collect_fee_mode: "quote" },
    { pool: "CandPool2222222222222222222222222222222222222", name: "BBB-SOL", bin_step: 100, fee_mode: { mode: "InputOnly", solFees: false } },
  ], { refs: ui.createRefMap() }).text;
  assert.match(cands, /AAA-SOL.*\n.*fees SOL/);
  assert.match(cands, /BBB-SOL.*\n.*fees token/);

  const r = await lookupMod.lookupToken(LOOKUP_MINT, { deps: lookupDeps(), entryFilters: es.ENTRY_FILTER_DEFAULTS });
  assert.match(ui.renderTokenCard(r, { tokenRef: "t" }).text, /💸 Fee mode: LP fees paid in SOL \(OnlyY\)/);

  const c = { pool: "CandPool2222222222222222222222222222222222222", name: "BBB-SOL", bin_step: 100 };
  const plan = { args: { strategy: "bid_ask" }, range: ui.rangeInfo(50, 100), amountLabel: "0.5 SOL" };
  const card = ui.renderDeployConfirm(c, plan, "n1", {
    entryState: await es.describePoolEntryState(mockPool({ lbPair: { parameters: { collectFeeMode: 0 } } }), { apiBlacklisted: false }),
    entryFilters: { solFeePoolsOnly: true },
  });
  const text = card.text;
  assert.match(text, /✅ Pool status: enabled/);
  assert.match(text, /💸 Fee mode: LP fees paid in the input token \(InputOnly\).*⛔ solFeePoolsOnly is on/);
});

// ─── 4. TWAP spike guard ─────────────────────────────────────────
function mockOracle({ twapBin = 1000, active = 1000, coveredSec = 7200 } = {}) {
  return {
    currentActiveBinId: new BN(active),
    getMaxDuration: () => new BN(coveredSec),
    getActiveIdByTime: (t0, t1) => (t1.sub(t0).toNumber() > coveredSec ? null : { value: new BN(twapBin), duration: t1.sub(t0) }),
  };
}

test("TWAP: deviation is geometric in bins; above the limit blocks bid_ask only; null disables", async () => {
  const tw = await es.computeTwapDeviation({ oracle: mockOracle({ twapBin: 980, active: 1000 }), binStep: 100, windowMinutes: 60 });
  assert.equal(tw.known, true);
  assert.equal(tw.devBins, 20);
  assert.equal(tw.devPct, Math.round((Math.pow(1.01, 20) - 1) * 10000) / 100); // ≈ +22.02%
  const g = es.evaluateTwapGuard(tw, { maxPct: 15, strategy: "bid_ask" });
  assert.equal(g.pass, false);
  assert.match(g.reason, /price is \+22\.0% vs the 60-min on-chain TWAP \(\+20 bins\), above the 15% limit \(twapSpikeMaxPct\)/);
  assert.equal(es.evaluateTwapGuard(tw, { maxPct: 25, strategy: "bid_ask" }).pass, true);
  assert.equal(es.evaluateTwapGuard(tw, { maxPct: 15, strategy: "spot" }).pass, true, "spot is not gated");
  assert.equal(es.evaluateTwapGuard(tw, { maxPct: null, strategy: "bid_ask" }).pass, true);
  const below = await es.computeTwapDeviation({ oracle: mockOracle({ twapBin: 1030, active: 1000 }), binStep: 100 });
  assert.ok(below.devPct < 0);
  assert.equal(es.evaluateTwapGuard(below, { maxPct: 15 }).pass, true, "price below TWAP never blocks");
});

test("TWAP: an oracle that can't cover the window is unknown → allowed with a note (never blocks)", async () => {
  const tw = await es.computeTwapDeviation({ oracle: mockOracle({ twapBin: 900, active: 1000, coveredSec: 1800 }), binStep: 100, windowMinutes: 60 });
  assert.equal(tw.known, false);
  assert.match(tw.note, /oracle covers 30 min of the 60-min window/);
  const g = es.evaluateTwapGuard(tw, { maxPct: 15, strategy: "bid_ask" });
  assert.equal(g.pass, true);
  assert.equal(g.unknown, true);
  assert.match(g.note, /TWAP unknown .* — allowed/);
  const failed = await es.readTwap({ getOracle: async () => { throw new Error("rpc down"); }, lbPair: { binStep: 100 } });
  assert.equal(failed.known, false);
  assert.equal(es.evaluateTwapGuard(failed, { maxPct: 15 }).pass, true);
});

test("deploy: TWAP spike refuses bid_ask before any tx; spot and unknown TWAP pass", async () => {
  const spike = mockPool({ oracle: mockOracle({ twapBin: 975, active: 1000 }) });
  const r = await deployInto(spike);
  assert.equal(r.blocked_by, "entry_filter");
  assert.match(r.error, /^TWAP spike: price is \+28\.2% vs the 60-min on-chain TWAP/);
  assert.deepEqual(spike.calls, ["getOracle"], "no active-bin read, no tx");
  await assert.rejects(deployInto(mockPool({ oracle: mockOracle({ twapBin: 900, coveredSec: 600 }) })), /PAST_ENTRY_CHECKS/);
  const spot = mockPool({ oracle: mockOracle({ twapBin: 975, active: 1000 }) });
  await assert.rejects(deployInto(spot, { strategy: "spot" }), /PAST_ENTRY_CHECKS/);
  assert.ok(!spot.calls.includes("getOracle"), "spot skips the oracle read");
});

test("cards: TWAP line on lookup and confirm cards (known, blocked and unknown)", async () => {
  const filters = { ...es.ENTRY_FILTER_DEFAULTS };
  const st = await es.describePoolEntryState(mockPool({ oracle: mockOracle({ twapBin: 975, active: 1000 }) }), { apiBlacklisted: false, filters });
  const lines = ui.entryStateLines({ pool: "P", entry_state: st }, filters).join("\n");
  assert.match(lines, /⛔ TWAP: price \+28\.2% vs 60-min on-chain TWAP \(\+25 bins\) — ⛔ above the 15% limit for bid_ask/);
  const unk = await es.describePoolEntryState(mockPool({ oracle: mockOracle({ coveredSec: 600 }) }), { apiBlacklisted: false, filters });
  assert.match(ui.entryStateLines({ pool: "P", entry_state: unk }, filters).join("\n"), /❔ TWAP: unknown \(oracle covers 10 min of the 60-min window\) — allowed/);
  const card = ui.renderDeployConfirm({ pool: "P", name: "X", bin_step: 100 }, { args: { strategy: "bid_ask" }, range: ui.rangeInfo(50, 100), amountLabel: "1 SOL" }, "n", { entryState: st, entryFilters: filters }).text;
  assert.match(card, /TWAP: price \+28\.2%/);
});

// ─── 5. Re-center shadow log ─────────────────────────────────────
const shadow = await import("../tools/recenter-shadow.js");

test("re-center shadow: logs the new range, txs, bin arrays and TWAP gate for upside OOR only; no writes", async () => {
  const logs = [];
  const pool = mockPool({ oracle: mockOracle({ twapBin: 1040, active: 1050 }) });
  const deps = {
    getPool: async () => pool,
    binArrayWindow: async (_pool, min, max) => ({ missing: max > 1060 ? [15] : [], min, max }),
    filters: es.ENTRY_FILTER_DEFAULTS,
    log: (cat, msg) => logs.push([cat, msg]),
  };
  const pos = { position: "PosX1111", pair: "X-SOL", pool: "P", in_range: false, oor_direction: "upside", lower_bin: 900, upper_bin: 969, active_bin: 1050, minutes_out_of_range: 12, composition: { token_pct: 0 } };
  const plan = await shadow.logRecenterShadow(pos, deps);
  assert.deepEqual(plan.to, [981, 1050]);
  assert.equal(plan.width, 70);
  assert.equal(plan.bin_arrays.all_exist, true);
  assert.equal(plan.twap_gate, "allow"); // +10.5% < 15%
  assert.equal(plan.would_recenter, true);
  assert.equal(logs[0][0], "recenter_shadow");
  assert.match(logs[0][1], /would re-center 900\.\.969 → 981\.\.1050 \(70 bins\); est\. txs: 1 rebalance_liquidity tx vs close \+ redeploy/);
  assert.match(logs[0][1], /bin arrays: all exist; TWAP gate: allow/);
  assert.match(logs[0][1], /Shadow only — no action taken/);
  assert.ok(!pool.calls.includes("tx"));

  // TWAP spike → the gate denies; token-heavy → would not re-center.
  const spiky = mockPool({ oracle: mockOracle({ twapBin: 1000, active: 1050 }) });
  const denied = await shadow.buildRecenterShadow(pos, { ...deps, getPool: async () => spiky });
  assert.equal(denied.twap_gate, "deny");
  assert.equal(denied.would_recenter, false);
  const heavy = await shadow.buildRecenterShadow({ ...pos, composition: { token_pct: 40 } }, deps);
  assert.equal(heavy.would_recenter, false);
  assert.match(heavy.blockers[0], /average down/);

  // Missing arrays are reported; downside OOR and in-range positions are ignored.
  const hi = await shadow.buildRecenterShadow({ ...pos, active_bin: 1100 }, { ...deps, getPool: async () => mockPool({ oracle: mockOracle({ twapBin: 1100, active: 1100 }) }) });
  assert.equal(hi.bin_arrays.missing, 1);
  assert.match(shadow.formatRecenterShadow(hi), /1 bin-array init \(~0\.0714 SOL non-refundable\)/);
  assert.equal(await shadow.buildRecenterShadow({ ...pos, oor_direction: "downside", active_bin: 800 }, deps), null);
  assert.equal(await shadow.buildRecenterShadow({ ...pos, in_range: true }, deps), null);
});

// ─── 6. Telegram toggles + the LLM can't loosen ──────────────────
const tg = await import("../telegram.js");
const OWNER = "111";

function entryUI() {
  const calls = [];
  const t = {
    sendHTML: async (text, extra = {}) => { calls.push({ m: "send", text, extra }); return { message_id: 900, chat: { id: Number(OWNER) } }; },
    editHTML: async (messageId, text, extra = {}) => { calls.push({ m: "edit", messageId, text, extra }); return true; },
    answerCallback: async (cid, text, alert) => { calls.push({ m: "answer", text, alert }); return true; },
  };
  const logs = [];
  const u = ui.createTelegramUI({
    tg: t,
    config,
    setEntryFilter: (key, value) => es.applyEntryFilterChange(key, value, { source: "telegram" }),
    buildSettingsReport: () => "settings",
    getStatusInfo: () => ({}),
    log: (cat, msg) => logs.push([cat, msg]),
  });
  return { u, calls, logs };
}
const readCfg = () => JSON.parse(fs.readFileSync(USER_CFG, "utf8"));
const kb = (call) => call.extra?.reply_markup?.inline_keyboard || [];
const datas = (keyboard) => keyboard.flat().map((b) => b.callback_data).filter(Boolean);
const ctx = { chatId: OWNER, fromId: OWNER, messageId: 42, callbackId: "cq" };

test("telegram: Settings → 🛡 Entry filters shows ✅/❌ toggles and presets; every callback_data ≤ 64 bytes", async () => {
  config.entryFilters = { ...es.ENTRY_FILTER_DEFAULTS };
  const { u, calls } = entryUI();
  await u.handleCallback("se:0", ctx);
  assert.ok(datas(kb(calls.at(-1))).includes("ef"), "Settings has the Entry filters button");
  await u.handleCallback("ef", ctx);
  const view = calls.at(-1);
  assert.equal(view.m, "edit", "edited in place");
  const texts = kb(view).flat().map((b) => b.text);
  assert.ok(texts.includes("✅ Transfer hook"));
  assert.ok(texts.includes("❌ Mint authority"));
  assert.ok(texts.includes("❌ SOL-fee pools only"));
  assert.ok(texts.includes("● 1%") && texts.includes("● 15%"), "current presets marked");
  for (const code of ["off", "0.5", "1", "2", "5"]) assert.ok(datas(kb(view)).includes(`ev:tf:${code}`));
  for (const code of ["off", "10", "15", "25"]) assert.ok(datas(kb(view)).includes(`ev:tw:${code}`));
  for (const d of datas(kb(view))) assert.ok(Buffer.byteLength(d) <= 64, d);
  assert.throws(() => ui.cb("x".repeat(65)));
});

test("telegram: toggles and presets persist to user-config.json (other keys kept), apply immediately, are logged", async () => {
  config.entryFilters = { ...es.ENTRY_FILTER_DEFAULTS };
  const { u, calls, logs } = entryUI();
  await u.handleCallback("et:fh", ctx); // transfer hook: block → allow (the user may loosen)
  assert.equal(config.entryFilters.blockTransferHook, false, "running config updated");
  let saved = readCfg();
  assert.equal(saved.blockTransferHook, false);
  assert.equal(saved.someOtherKey, "keep-me");
  assert.equal(saved.maxPositions, 2);
  assert.equal(fs.readFileSync(USER_CFG, "utf8"), JSON.stringify(saved, null, 2), "same 2-space JSON format as update_config");
  const answer = calls.find((c) => c.m === "answer");
  assert.match(answer.text, /^Saved: blockTransferHook: block → allow$/);
  assert.match(calls.at(-1).text, /✅ Saved: blockTransferHook: block → allow \(loosened\)/);
  assert.ok(logs.some(([, m]) => /Entry filter changed from Telegram/.test(m)));
  assert.ok(fs.readFileSync(path.join(TMP, "logs", fs.readdirSync(path.join(TMP, "logs"))[0]), "utf8").includes("Entry filter blockTransferHook: true → false (telegram, loosened by user)"));

  await u.handleCallback("ev:tf:off", ctx);
  await u.handleCallback("ev:tw:25", ctx);
  await u.handleCallback("et:fs", ctx);
  saved = readCfg();
  assert.equal(saved.blockTransferFeeAbovePct, null);
  assert.equal(saved.twapSpikeMaxPct, 25);
  assert.equal(saved.solFeePoolsOnly, true);
  assert.equal(config.entryFilters.twapSpikeMaxPct, 25);

  // The next deploy check uses the new value at once: 5% fee is now allowed.
  const facts = es.mintFactsFromSdkReserve(reserve({ tlv: [transferFeeTlv(500)] }));
  assert.equal(es.evaluateTokenGuards(facts).pass, true);

  // Unknown code / non-preset value is refused without a change.
  const before = fs.readFileSync(USER_CFG, "utf8");
  await u.handleCallback("ev:tf:7", ctx);
  await u.handleCallback("et:zz", ctx);
  assert.equal(fs.readFileSync(USER_CFG, "utf8"), before);
  config.entryFilters = { ...es.ENTRY_FILTER_DEFAULTS };
});

test("telegram: owner-only — a stranger's toggle callback is dropped by the transport, nothing changes", async () => {
  config.entryFilters = { ...es.ENTRY_FILTER_DEFAULTS };
  const apiCalls = [];
  tg.__setTelegramTestHooks({ token: "TEST", owner: OWNER, allowlist: "", fetch: async (url) => { apiCalls.push(String(url)); return { ok: true, json: async () => ({ ok: true, result: {} }) }; } });
  const { u } = entryUI();
  const before = fs.readFileSync(USER_CFG, "utf8");
  const h = { onCallback: (d, c) => u.handleCallback(d, c) };
  const stranger = { update_id: 3, callback_query: { id: "cqx", data: "et:fz", from: { id: 999 }, message: { message_id: 9, chat: { id: 999, type: "private" } } } };
  assert.equal((await tg.processUpdate(stranger, h)).handled, false);
  assert.equal(config.entryFilters.blockFreezeAuthority, true);
  assert.equal(fs.readFileSync(USER_CFG, "utf8"), before);
  assert.equal(apiCalls.length, 0, "no Telegram API call for strangers");
});

test("LLM update_config: tightening is applied; disabling a guard or raising a limit is refused", async () => {
  const { executeTool } = await import("../tools/executor.js");
  config.entryFilters = { ...es.ENTRY_FILTER_DEFAULTS, blockMintAuthority: false };

  const loosen = [
    { setting: "blockTransferHook", value: false },
    { setting: "blockFreezeAuthority", value: "false" },
    { setting: "blockTransferFeeAbovePct", value: 5 },
    { setting: "blockTransferFeeAbovePct", value: null },
    { setting: "twapSpikeMaxPct", value: "off" },
    { setting: "twapSpikeMaxPct", value: 30 },
    { setting: "twapWindowMinutes", value: 15 },
    { changes: { blockPausable: false, maxPositions: 3 } },
  ];
  const before = fs.readFileSync(USER_CFG, "utf8");
  for (const args of loosen) {
    const r = await executeTool("update_config", { ...args, reason: "test" });
    assert.equal(r.blocked, true, JSON.stringify(args));
    assert.match(r.reason, /would loosen an entry-safety guard\. Only the user can loosen/);
  }
  assert.equal(fs.readFileSync(USER_CFG, "utf8"), before, "nothing persisted");
  assert.deepEqual(config.entryFilters, { ...es.ENTRY_FILTER_DEFAULTS, blockMintAuthority: false });

  // Direct tool call (bypassing runSafetyChecks) is refused too.
  const { checkAgentEntryFilterChange } = es;
  assert.equal(checkAgentEntryFilterChange("blockNonTransferable", false).ok, false);

  const tighten = await executeTool("update_config", { changes: { blockMintAuthority: true, blockTransferFeeAbovePct: 0.5, twapSpikeMaxPct: 10, solFeePoolsOnly: true }, reason: "test tighten" });
  assert.equal(tighten.success, true, JSON.stringify(tighten));
  assert.equal(config.entryFilters.blockMintAuthority, true);
  assert.equal(config.entryFilters.twapSpikeMaxPct, 10);
  const saved = readCfg();
  assert.equal(saved.blockTransferFeeAbovePct, 0.5);
  assert.equal(saved.solFeePoolsOnly, true);
  assert.equal(saved.someOtherKey, "keep-me");
  // Turning an off limit back on is tightening.
  config.entryFilters.twapSpikeMaxPct = null;
  assert.equal(checkAgentEntryFilterChange("twapSpikeMaxPct", 20).ok, true);
  config.entryFilters = { ...es.ENTRY_FILTER_DEFAULTS };
});

// ─── Jupiter scam flag (blockJupiterSuspicious) ──────────────────
const jupMap = (info) => async (mints) => new Map(mints.map((m) => [m, { mint: m, ...info }]));
const splPool = () => mockPool({ tokenX: reserve({ program: es.TOKEN_PROGRAM_ID }) });

test("deploy: Jupiter audit.isSus / banned blocks before any tx; absent passes", async () => {
  config.entryFilters = { ...es.ENTRY_FILTER_DEFAULTS };
  assert.equal(es.ENTRY_FILTER_DEFAULTS.blockJupiterSuspicious, true);
  try {
    es._setJupiterLookupForTest(jupMap({ is_sus: true, banned: false, organic_score: 12, is_verified: false }));
    const pool = splPool();
    const r = await deployInto(pool);
    assert.equal(r.blocked_by, "entry_filter");
    assert.match(r.error, /Jupiter flags the token as suspicious \(audit\.isSus\) \(blockJupiterSuspicious\)/);
    assert.deepEqual(pool.calls, []);

    es._setJupiterLookupForTest(jupMap({ is_sus: false, banned: true }));
    const banned = await deployInto(splPool());
    assert.match(banned.error, /banned/);

    es._setJupiterLookupForTest(jupMap({ is_sus: false, banned: false, organic_score: 90, is_verified: true }));
    await assert.rejects(deployInto(splPool()), /PAST_ENTRY_CHECKS/);
  } finally {
    es._setJupiterLookupForTest(async () => new Map());
  }
});

test("deploy: a Jupiter lookup failure or unknown token allows the deploy (never block on an outage)", async () => {
  config.entryFilters = { ...es.ENTRY_FILTER_DEFAULTS };
  try {
    es._setJupiterLookupForTest(async () => null); // API down
    await assert.rejects(deployInto(splPool()), /PAST_ENTRY_CHECKS/);
    es._setJupiterLookupForTest(async () => { throw new Error("boom"); });
    await assert.rejects(deployInto(splPool()), /PAST_ENTRY_CHECKS/);
    es._setJupiterLookupForTest(async () => new Map()); // unknown to Jupiter
    const r = await es.runDeployEntryChecks({ pool: splPool(), apiRow: null, strategy: "spot" });
    assert.equal(r.pass, true);
    assert.ok(r.notes.some((n) => /token unknown to Jupiter — allowed/.test(n)));
    const down = await es.runDeployEntryChecks({ pool: splPool(), apiRow: null, strategy: "spot", jupiterLookup: async () => null });
    assert.equal(down.pass, true);
    assert.ok(down.notes.some((n) => /lookup failed — allowed/.test(n)));
    // Guard off: the lookup is skipped entirely.
    config.entryFilters = { ...es.ENTRY_FILTER_DEFAULTS, blockJupiterSuspicious: false };
    let called = false;
    const off = await es.runDeployEntryChecks({ pool: splPool(), apiRow: null, strategy: "spot", jupiterLookup: async () => { called = true; return null; } });
    assert.equal(off.pass, true);
    assert.equal(called, false);
  } finally {
    config.entryFilters = { ...es.ENTRY_FILTER_DEFAULTS };
    es._setJupiterLookupForTest(async () => new Map());
  }
});

test("screening: Jupiter-flagged tokens are dropped; others carry organic/verified; lookup failure keeps all", async () => {
  const pools = [
    { pool: "S", name: "SUS", base: { mint: "MS", token_program: es.TOKEN_PROGRAM_ID } },
    { pool: "G", name: "GOOD", base: { mint: "MG", token_program: es.TOKEN_PROGRAM_ID } },
    { pool: "U", name: "UNKNOWN", base: { mint: "MU", token_program: es.TOKEN_PROGRAM_ID } },
  ];
  const lookup = async () => new Map([
    ["MS", { mint: "MS", is_sus: true, banned: false, organic_score: 3, is_verified: null }],
    ["MG", { mint: "MG", is_sus: false, banned: false, organic_score: 87.345, is_verified: true }],
  ]);
  const base = { filters: es.ENTRY_FILTER_DEFAULTS, readMints: async () => new Map(), jupiterLookup: lookup };
  const r = await es.screenEntryCandidates(pools, base);
  assert.deepEqual(r.kept.map((p) => p.pool), ["G", "U"]);
  assert.match(r.dropped.find((d) => d.pool === "S").reasons[0], /suspicious \(audit\.isSus\)/);
  assert.deepEqual(r.kept[0].jupiter, { organic_score: 87.3, verified: true, sus: false, banned: false });
  assert.equal(r.kept[1].jupiter, null);

  const off = await es.screenEntryCandidates(pools, { ...base, filters: { ...es.ENTRY_FILTER_DEFAULTS, blockJupiterSuspicious: false } });
  assert.equal(off.kept.length, 3);
  assert.equal(off.kept[0].jupiter.sus, true);

  const down = await es.screenEntryCandidates(pools, { ...base, jupiterLookup: async () => null });
  assert.equal(down.kept.length, 3);
});

test("blockJupiterSuspicious: user toggle normalizes; turning it off is a loosening the agent can't make", () => {
  assert.deepEqual(es.normalizeEntryFilterValue("blockJupiterSuspicious", "false"), { value: false });
  assert.equal(es.isLooseningChange("blockJupiterSuspicious", true, false), true);
  config.entryFilters = { ...es.ENTRY_FILTER_DEFAULTS };
  assert.equal(es.checkAgentEntryFilterChange("blockJupiterSuspicious", false).ok, false);
  assert.equal(es.fmtFilterValue("blockJupiterSuspicious", true), "block");
});
