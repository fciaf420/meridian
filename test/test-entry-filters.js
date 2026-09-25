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
    // The first call after the entry checks: stop the deploy here with a sentinel.
    getActiveBin: async () => { calls.push("getActiveBin"); throw new Error("PAST_ENTRY_CHECKS"); },
    getOracle: async () => { calls.push("getOracle"); return over.oracle ?? null; },
    initializePositionAndAddLiquidityByStrategy: async () => { calls.push("tx"); throw new Error("must not build a tx"); },
    initializeMultiplePositionAndAddLiquidityByStrategy: async () => { calls.push("tx"); throw new Error("must not build a tx"); },
  };
  return pool;
}

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
  assert.deepEqual(okPool.calls, ["getActiveBin"]);
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
