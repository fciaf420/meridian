/**
 * getWalletBalances / getSolPrice without the Helius Wallet API: stub RPC
 * connections and a mocked fetch (Jupiter Price v3 + Tokens v2). No network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";

process.env.JUPITER_API_KEY = "test-key";
delete process.env.USE_HELIUS_WALLET_API;
delete process.env.BALANCE_RPC_URL;

const wallet = await import("../tools/wallet.js");
const { getWalletBalances, getSolPrice, invalidateWalletBalances, _setWalletTestDeps } = wallet;
const { walletCacheState } = await import("../tools/wallet-cache.js");
const { sendAndConfirmSigned } = await import("../tools/tx-send.js");
const rpcStats = await import("../tools/rpc-stats.js");

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_A = "A1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const UNPRICED = "Unp1111111111111111111111111111111111111111";
const ZERO = "Zer0000000000000000000000000000000000000000";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const OWNER = Keypair.generate().publicKey.toBase58();

const acct = (mint, amount, decimals) => ({
  pubkey: Keypair.generate().publicKey,
  account: { data: { parsed: { info: { mint, tokenAmount: { amount: String(amount), decimals } } } } },
});

/** Stub Connection recording calls per method. */
function stubConnection({ lamports = 2_500_000_000, fail = null, hang = false } = {}) {
  const calls = { getBalance: 0, getParsedTokenAccountsByOwner: [] };
  const byProgram = {
    [TOKEN_PROGRAM]: [
      acct(USDC, 10_000_000, 6),
      acct(USDC, 2_500_000, 6), // second USDC account: summed per mint
      acct(UNPRICED, 5_000_000_000, 9),
      acct(ZERO, 0, 6), // empty account: skipped
    ],
    [TOKEN_2022]: [acct(TOKEN_A, 1_000_000_000, 6)],
  };
  const gate = () => {
    if (hang) return new Promise(() => {});
    if (fail) return Promise.reject(new Error(fail));
    return null;
  };
  return {
    calls,
    async getBalance() {
      calls.getBalance++;
      return (await gate()) ?? lamports;
    },
    async getParsedTokenAccountsByOwner(_owner, filter) {
      const pid = filter.programId.toBase58();
      calls.getParsedTokenAccountsByOwner.push(pid);
      await gate();
      return { context: { slot: 1 }, value: byProgram[pid] ?? [] };
    },
  };
}

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const realFetch = globalThis.fetch;
function mockFetch({ solPrice = 150, priceStatus = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("api.jup.ag/price/v3")) {
      if (priceStatus !== 200) return jsonResponse({ error: "down" }, priceStatus);
      const body = {};
      const ids = new URL(u).searchParams.get("ids").split(",");
      const prices = { [SOL]: solPrice, [USDC]: 1, [TOKEN_A]: 0.02 };
      for (const id of ids) if (prices[id] != null) body[id] = { usdPrice: prices[id] };
      return jsonResponse(body);
    }
    if (u.includes("api.jup.ag/tokens/v2/search")) {
      return jsonResponse([{ id: USDC, symbol: "USDC" }, { id: TOKEN_A, symbol: "TKA" }]);
    }
    if (u.includes("api.helius.xyz/v1/wallet")) {
      return jsonResponse({ balances: [{ mint: SOL, symbol: "SOL", balance: 1, pricePerToken: 99, usdValue: 99 }], totalUsdValue: 99 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return calls;
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.USE_HELIUS_WALLET_API;
  _setWalletTestDeps(null);
});

test("getWalletBalances: same shape as before, built from RPC + Jupiter", async () => {
  const conn = stubConnection();
  _setWalletTestDeps({ connection: conn, owner: OWNER });
  const fetches = mockFetch();

  const b = await getWalletBalances();
  assert.equal(b.error, undefined);
  assert.equal(b.wallet, OWNER);
  assert.equal(b.sol, 2.5);
  assert.equal(b.sol_price, 150);
  assert.equal(b.sol_usd, 375);
  assert.equal(b.usdc, 12.5);
  // 375 SOL + 12.5 USDC + 1000 × 0.02 TKA; the unpriced token adds nothing.
  assert.equal(b.total_usd, 407.5);
  assert.deepEqual(b.tokens, [
    { mint: SOL, symbol: "SOL", balance: 2.5, usd: 375 },
    { mint: USDC, symbol: "USDC", balance: 12.5, usd: 12.5 },
    { mint: UNPRICED, symbol: UNPRICED.slice(0, 8), balance: 5, usd: null },
    { mint: TOKEN_A, symbol: "TKA", balance: 1000, usd: 20 },
  ]);
  assert.equal(conn.calls.getBalance, 1);
  assert.deepEqual(conn.calls.getParsedTokenAccountsByOwner.sort(), [TOKEN_PROGRAM, TOKEN_2022].sort());
  // One batched price call for SOL + every held mint.
  const priceCalls = fetches.filter((u) => u.includes("/price/v3"));
  assert.equal(priceCalls.length, 1);
  const ids = new URL(priceCalls[0]).searchParams.get("ids").split(",");
  assert.deepEqual(ids.sort(), [SOL, USDC, UNPRICED, TOKEN_A].sort());
  assert.ok(!fetches.some((u) => u.includes("api.helius.xyz")));
});

test("getWalletBalances: RPC failure keeps the { error } shape and is not cached", async () => {
  const conn = stubConnection({ fail: "rpc down" });
  _setWalletTestDeps({ connection: conn, owner: OWNER });
  mockFetch();
  const b = await getWalletBalances();
  assert.deepEqual(b, { wallet: OWNER, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "rpc down" });
  await getWalletBalances();
  assert.equal(conn.calls.getBalance, 2, "errors must not be cached");
});

test("getWalletBalances: missing prices degrade to usd null, balances still returned", async () => {
  const conn = stubConnection();
  _setWalletTestDeps({ connection: conn, owner: OWNER });
  mockFetch({ priceStatus: 500 });
  const b = await getWalletBalances();
  assert.equal(b.error, undefined);
  assert.equal(b.sol, 2.5);
  assert.equal(b.sol_price, 0);
  assert.equal(b.usdc, 12.5);
  assert.ok(b.tokens.every((t) => t.usd === null));
});

test("getWalletBalances: cached ~20s, shared by concurrent callers, invalidated by sends", async () => {
  const conn = stubConnection();
  _setWalletTestDeps({ connection: conn, owner: OWNER });
  mockFetch();

  const [a, b] = await Promise.all([getWalletBalances(), getWalletBalances()]);
  assert.equal(conn.calls.getBalance, 1, "concurrent callers share one read");
  assert.deepEqual(a, b);
  a.tokens.length = 0; // callers get copies: mutating one can't corrupt the cache
  const c = await getWalletBalances();
  assert.equal(conn.calls.getBalance, 1, "served from cache");
  assert.equal(c.tokens.length, 4);

  await getWalletBalances({ fresh: true });
  assert.equal(conn.calls.getBalance, 2, "fresh bypasses the cache");

  invalidateWalletBalances();
  await getWalletBalances();
  assert.equal(conn.calls.getBalance, 3, "invalidate forces a new read");

  // The shared send path (deploy / close / claim / swap v1) invalidates too.
  const sendConn = {
    sendRawTransaction: async () => "sig",
    confirmTransaction: async () => ({ value: { err: null } }),
  };
  await sendAndConfirmSigned(sendConn, {
    wire: Buffer.from([1]), signature: "sig", blockhash: "bh", lastValidBlockHeight: 1, label: "test", sender: false,
  });
  await getWalletBalances();
  assert.equal(conn.calls.getBalance, 4, "a send invalidates the cache");

  // TTL expiry.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 21_000;
    await getWalletBalances();
    assert.equal(conn.calls.getBalance, 5, "expired after 20s");
  } finally {
    Date.now = realNow;
  }
});

test("getWalletBalances: a read that raced a send is not written to the cache", async () => {
  let release;
  const conn = stubConnection();
  const origGetBalance = conn.getBalance;
  conn.getBalance = async (...a) => { await new Promise((r) => { release = r; }); return origGetBalance(...a); };
  _setWalletTestDeps({ connection: conn, owner: OWNER });
  mockFetch();

  const pending = getWalletBalances();
  await new Promise((r) => setImmediate(r));
  invalidateWalletBalances(); // a send lands while the read is in flight
  release();
  await pending;
  assert.equal(walletCacheState().entry, null);
});

test("getWalletBalances: swapToken invalidates the cache (live path)", async () => {
  const conn = stubConnection();
  _setWalletTestDeps({ connection: conn, owner: OWNER });
  mockFetch();
  await getWalletBalances();
  const gen = walletCacheState().generation;
  const prevDry = process.env.DRY_RUN;
  process.env.DRY_RUN = "false";
  try {
    // Wallet not configured → swapToken fails early, but its finally still invalidates.
    const r = await wallet.swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, {
      wallet: Keypair.generate(),
      connection: { getParsedAccountInfo: async () => { throw new Error("stop here"); } },
    });
    assert.equal(r.success, false);
  } finally {
    if (prevDry == null) delete process.env.DRY_RUN; else process.env.DRY_RUN = prevDry;
  }
  assert.ok(walletCacheState().generation > gen);
  assert.equal(walletCacheState().entry, null);
});

test("no fetch to the Helius Wallet API by default; opt-in env restores it", async () => {
  const conn = stubConnection();
  _setWalletTestDeps({ connection: conn, owner: OWNER });
  const fetches = mockFetch();
  await getWalletBalances();
  await getWalletBalances({ fresh: true });
  await getSolPrice();
  assert.equal(fetches.filter((u) => u.includes("api.helius.xyz/v1/wallet")).length, 0);

  process.env.USE_HELIUS_WALLET_API = "true";
  process.env.HELIUS_API_KEY = "k";
  try {
    const b = await getWalletBalances({ fresh: true });
    assert.equal(fetches.filter((u) => u.includes("api.helius.xyz/v1/wallet")).length, 1);
    assert.equal(b.sol_price, 99);
  } finally {
    delete process.env.HELIUS_API_KEY;
  }
});

test("getSolPrice: Jupiter Price v3, cached 60s, last known price on failure", async () => {
  _setWalletTestDeps({ connection: stubConnection(), owner: OWNER });
  const fetches = mockFetch({ solPrice: 151.5 });
  const [p1, p2] = await Promise.all([getSolPrice(), getSolPrice()]);
  assert.equal(p1, 151.5);
  assert.equal(p2, 151.5);
  assert.equal(await getSolPrice(), 151.5);
  assert.equal(fetches.length, 1, "one request for concurrent + cached calls");
  assert.match(fetches[0], /api\.jup\.ag\/price\/v3\?ids=So11111111111111111111111111111111111111112$/);

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 61_000;
    mockFetch({ priceStatus: 503 });
    assert.equal(await getSolPrice(), 151.5, "stale price beats 0 when Jupiter is down");
    const f2 = mockFetch({ solPrice: 160 });
    assert.equal(await getSolPrice(), 160);
    assert.equal(f2.length, 1);
  } finally {
    Date.now = realNow;
  }

  _setWalletTestDeps({ connection: stubConnection(), owner: OWNER });
  mockFetch({ priceStatus: 503 });
  assert.equal(await getSolPrice(), 0, "no price ever seen → 0");
});

test("getWalletBalances seeds the getSolPrice cache", async () => {
  _setWalletTestDeps({ connection: stubConnection(), owner: OWNER });
  const fetches = mockFetch({ solPrice: 140 });
  await getWalletBalances();
  const n = fetches.length;
  assert.equal(await getSolPrice(), 140);
  assert.equal(fetches.length, n);
});

test("BALANCE_RPC_URL routing: balance reads use the balance connection only", async () => {
  const main = stubConnection();
  const balance = stubConnection({ lamports: 1_000_000_000 });
  _setWalletTestDeps({ connection: main, balanceConnection: balance, owner: OWNER });
  mockFetch();
  const b = await getWalletBalances();
  assert.equal(b.sol, 1);
  assert.equal(balance.calls.getBalance, 1);
  assert.equal(balance.calls.getParsedTokenAccountsByOwner.length, 2);
  assert.equal(main.calls.getBalance, 0);
  assert.equal(main.calls.getParsedTokenAccountsByOwner.length, 0);
});

test("BALANCE_RPC_URL fallback: error or timeout retries once on the main RPC", async () => {
  for (const opts of [{ fail: "Indexed requests require a personal token" }, { hang: true }]) {
    const main = stubConnection({ lamports: 3_000_000_000 });
    const balance = stubConnection(opts);
    _setWalletTestDeps({ connection: main, balanceConnection: balance, owner: OWNER, balanceRpcTimeoutMs: 50 });
    mockFetch();
    const b = await getWalletBalances();
    assert.equal(b.error, undefined, JSON.stringify(opts));
    assert.equal(b.sol, 3);
    assert.equal(balance.calls.getBalance, 1);
    assert.equal(main.calls.getBalance, 1);
  }
});

test("BALANCE_RPC_URL fallback: both failing returns the { error } shape", async () => {
  _setWalletTestDeps({
    connection: stubConnection({ fail: "main down" }),
    balanceConnection: stubConnection({ fail: "balance down" }),
    owner: OWNER,
  });
  mockFetch();
  const b = await getWalletBalances();
  assert.equal(b.error, "main down");
  assert.deepEqual(b.tokens, []);
});

test("rpc-stats: instrumentConnection counts calls per method", async () => {
  rpcStats._resetRpcStatsForTest();
  const conn = {
    _rpcRequest: async (method) => ({ result: method }),
    _rpcBatchRequest: async (reqs) => reqs.map(() => ({ result: null })),
  };
  rpcStats.instrumentConnection(conn);
  rpcStats.instrumentConnection(conn); // idempotent
  await conn._rpcRequest("getBalance", []);
  await conn._rpcRequest("getBalance", []);
  await conn._rpcRequest("getTokenAccountsByOwner", []);
  await conn._rpcBatchRequest([{ methodName: "getAccountInfo", args: [] }]);
  rpcStats.countRpc("getPriorityFeeEstimate");
  const s = rpcStats.getRpcStats();
  assert.equal(s.total, 5);
  assert.deepEqual(s.methods[0], ["getBalance", 2]);
  const line = rpcStats.formatRpcStatsLine(s, { now: s.since + 7_200_000 });
  assert.match(line, /^RPC calls since start \(2\.0h\): 5 — getBalance 2, /);
  assert.match(line, /getPriorityFeeEstimate 1/);
  rpcStats._resetRpcStatsForTest();
  assert.equal(rpcStats.formatRpcStatsLine(), "RPC calls since start (0.0h): 0");
});

test("rpc-stats: a real web3.js Connection is counted by method name", async () => {
  const { Connection } = await import("@solana/web3.js");
  rpcStats._resetRpcStatsForTest();
  const conn = rpcStats.instrumentConnection(new Connection("http://127.0.0.1:9", "confirmed"));
  const inner = conn._rpcRequest;
  assert.equal(typeof inner, "function");
  // Swap the wrapped transport for a stub: the wrapper still counts.
  conn.__rpcCounted = false;
  conn._rpcRequest = async () => ({ jsonrpc: "2.0", id: "1", result: { context: { slot: 1 }, value: 42 } });
  rpcStats.instrumentConnection(conn);
  assert.equal(await conn.getBalance(Keypair.generate().publicKey), 42);
  assert.deepEqual(rpcStats.getRpcStats().methods, [["getBalance", 1]]);
});
