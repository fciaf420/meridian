/**
 * Jupiter Swap v2 swapToken tests: mocked fetch and a stub connection. No
 * network, no RPC. The throwaway wallet is never funded; the transactions it
 * signs only ever reach the mocks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

process.env.DRY_RUN = "false";
process.env.JUPITER_API_KEY = "test-key";

const { swapToken, parsePriceImpactPercent, classifyExecuteResponse } = await import("../tools/wallet.js");

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";

const wallet = Keypair.generate();

/** Unsigned v0 tx (1-lamport self-transfer) paid by the test wallet, base64. */
function unsignedTxBase64() {
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wallet.publicKey, lamports: 1 })],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const realFetch = globalThis.fetch;
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts);
  };
  return calls;
}
test.afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.DRY_RUN = "false";
});

/**
 * Stub connection recording every call. `statuses` feeds getSignatureStatuses;
 * `confirm` is the swap/v1 confirmTransaction behaviour (a status value, or a
 * function that may throw).
 */
function stubConnection({ statuses = [null], confirm = { err: null } } = {}) {
  const calls = { getSignatureStatuses: [], sendRawTransaction: 0, other: [], confirmed: [] };
  let i = 0;
  return {
    calls,
    getBalance: async () => { calls.other.push("getBalance"); return 10e9; },
    getParsedAccountInfo: async () => {
      calls.other.push("getParsedAccountInfo");
      return { value: { data: { parsed: { info: { decimals: 6 } } } } };
    },
    getSignatureStatuses: async (sigs) => {
      calls.getSignatureStatuses.push(sigs[0]);
      const st = statuses[Math.min(i++, statuses.length - 1)];
      return { value: [st] };
    },
    sendRawTransaction: async () => { calls.sendRawTransaction++; return "v1FallbackSig"; },
    getLatestBlockhash: async () => { calls.other.push("getLatestBlockhash"); return { blockhash: "x", lastValidBlockHeight: 1000 }; },
    confirmTransaction: async (strategy) => {
      calls.confirmed.push(strategy);
      return { value: typeof confirm === "function" ? confirm() : confirm };
    },
  };
}

const deps = (connection) => ({ connection, wallet, statusPollMs: 1, statusPollAttempts: 3 });

const orderOk = () => ({
  transaction: unsignedTxBase64(),
  requestId: "req-1",
  router: "metis",
  mode: "ultra",
  priceImpact: -0.12,
  priceImpactPct: "-0.0012",
});

/** Route v2 /order, v2 /execute and the v1 fallback endpoints to handlers. */
function routes({ order = () => jsonResponse(orderOk()), execute, quote, swap } = {}) {
  return mockFetch((url, opts) => {
    if (url.includes("/swap/v2/order")) return order(url, opts);
    if (url.includes("/swap/v2/execute")) return execute(url, opts);
    if (url.includes("/swap/v1/quote")) return (quote ?? (() => jsonResponse({ inAmount: "1000000", outAmount: "5000000" })))(url, opts);
    if (url.includes("/swap/v1/swap")) return (swap ?? (() => jsonResponse({ swapTransaction: unsignedTxBase64(), lastValidBlockHeight: 12345 })))(url, opts);
    throw new Error(`unexpected fetch ${url}`);
  });
}
const v1Calls = (calls) => calls.filter((c) => c.url.includes("/swap/v1/"));
const execCalls = (calls) => calls.filter((c) => c.url.includes("/swap/v2/execute"));

// ─── Pure helpers ──────────────────────────────────────────────

test("parsePriceImpactPercent prefers priceImpact (percent), falls back to priceImpactPct x100", () => {
  assert.equal(parsePriceImpactPercent({ priceImpact: -0.12, priceImpactPct: "-0.5" }), -0.12);
  assert.equal(parsePriceImpactPercent({ priceImpact: 0 }), 0);
  assert.ok(Math.abs(parsePriceImpactPercent({ priceImpactPct: "-0.0012" }) - -0.12) < 1e-12);
  assert.ok(Math.abs(parsePriceImpactPercent({ priceImpact: "", priceImpactPct: "0.03" }) - 3) < 1e-12);
  assert.equal(parsePriceImpactPercent({ priceImpact: "abc" }), null);
  assert.equal(parsePriceImpactPercent({}), null);
  assert.equal(parsePriceImpactPercent(null), null);
});

test("classifyExecuteResponse maps documented outcomes", () => {
  const c = (httpStatus, body, transportError) => classifyExecuteResponse({ httpStatus, body, transportError }).kind;
  assert.equal(c(200, { status: "Success", signature: "S", code: 0 }), "success");
  // HTTP 500 is ambiguous with or without a signature.
  assert.equal(c(500, { status: "Failed", signature: "S", code: -1000 }), "ambiguous");
  assert.equal(c(500, null), "ambiguous");
  // A signature without status Success is ambiguous, even with a pre-send code.
  assert.equal(c(200, { status: "Failed", signature: "S", code: -1004 }), "ambiguous");
  // Success without a signature: cannot trust, check on-chain.
  assert.equal(c(200, { status: "Success", code: 0 }), "ambiguous");
  assert.equal(c(undefined, null, new Error("aborted")), "ambiguous");
  // Pre-send rejections with no signature: safe to fall back.
  for (const code of [-1, -2, -3, -1002, -1003, -1004, -2002, -2003, -2004]) {
    assert.equal(c(200, { status: "Failed", code }), "pre_landing", `code ${code}`);
  }
  // Codes meaning the tx may have been sent: ambiguous even without a signature.
  for (const code of [-1000, -1001, -2000, -2001, -9999]) {
    assert.equal(c(200, { status: "Failed", code }), "ambiguous", `code ${code}`);
  }
  assert.equal(c(400, { error: "bad request" }), "failed");
});

// ─── swapToken flows ───────────────────────────────────────────

test("DRY_RUN short-circuits before any fetch, RPC call or signing", async () => {
  process.env.DRY_RUN = "true";
  const calls = mockFetch(() => { throw new Error("fetch must not be called in DRY_RUN"); });
  const connection = stubConnection();
  const signingWallet = new Proxy({}, { get() { throw new Error("wallet must not be touched in DRY_RUN"); } });
  const r = await swapToken({ input_mint: USDC, output_mint: "SOL", amount: 1 }, { connection, wallet: signingWallet });
  assert.equal(r.dry_run, true);
  assert.deepEqual(r.would_swap, { input_mint: USDC, output_mint: SOL, amount: 1 });
  assert.equal(calls.length, 0);
  assert.deepEqual(connection.calls, { getSignatureStatuses: [], sendRawTransaction: 0, other: [], confirmed: [] });
});

test("happy path: v2 order without slippageBps, signed execute, Success", async () => {
  let execBody;
  const calls = routes({
    execute: (_u, opts) => {
      execBody = JSON.parse(opts.body);
      return jsonResponse({ status: "Success", signature: "SIG_OK", code: 0, inputAmountResult: "1000000", outputAmountResult: "5000000000" });
    },
  });
  const connection = stubConnection();
  const r = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, deps(connection));

  assert.equal(r.success, true);
  assert.equal(r.tx, "SIG_OK");
  assert.equal(r.in_ui, 1);
  assert.equal(r.out_ui, 5);
  const orderUrl = calls[0].url;
  assert.ok(orderUrl.startsWith("https://api.jup.ag/swap/v2/order?"));
  assert.ok(!orderUrl.includes("slippageBps"), "must not send slippageBps (RTSE stays on)");
  assert.ok(orderUrl.includes(`taker=${wallet.publicKey.toBase58()}`));
  assert.equal(calls[0].opts.headers["x-api-key"], "test-key");
  assert.equal(execBody.requestId, "req-1");
  const signed = VersionedTransaction.deserialize(Buffer.from(execBody.signedTransaction, "base64"));
  assert.ok(signed.signatures[0].some((b) => b !== 0), "execute must receive a signed tx");
  assert.equal(v1Calls(calls).length, 0);
  assert.equal(connection.calls.getSignatureStatuses.length, 0);
});

test("order with empty transaction + errorCode falls back to swap/v1 (slippageBps=300) before signing", async () => {
  const calls = routes({
    order: () => jsonResponse({ transaction: "", requestId: "r", router: "metis", errorCode: 1, errorMessage: "Insufficient funds" }),
    execute: () => { throw new Error("execute must not be called"); },
  });
  const connection = stubConnection();
  const r = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, deps(connection));
  assert.equal(r.success, true);
  assert.equal(r.tx, connection.calls.confirmed[0].signature);
  assert.equal(connection.calls.confirmed[0].lastValidBlockHeight, 12345);
  assert.equal(execCalls(calls).length, 0);
  assert.ok(v1Calls(calls)[0].url.includes("slippageBps=300"));
  assert.equal(connection.calls.sendRawTransaction, 1);
});

test("order with null transaction falls back to swap/v1", async () => {
  const calls = routes({
    order: () => jsonResponse({ transaction: null, requestId: "r" }),
    execute: () => { throw new Error("execute must not be called"); },
  });
  const r = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, deps(stubConnection()));
  assert.equal(r.success, true);
  assert.equal(v1Calls(calls).length, 2);
});

test("execute HTTP 500 with signature is ambiguous: checks chain, never falls back", async () => {
  const calls = routes({
    execute: () => jsonResponse({ status: "Failed", signature: "SIG_500", code: -1000 }, 500),
  });
  const connection = stubConnection({ statuses: [null, { confirmationStatus: "confirmed", err: null }] });
  const r = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, deps(connection));
  assert.equal(r.success, true);
  assert.equal(r.tx, "SIG_500");
  assert.equal(r.confirmed_via, "rpc");
  assert.deepEqual(connection.calls.getSignatureStatuses, ["SIG_500", "SIG_500"]);
  assert.equal(v1Calls(calls).length, 0, "must not fall back to v1");
  assert.equal(connection.calls.sendRawTransaction, 0);
});

test("execute Failed with signature that never confirms stays ambiguous with no fallback", async () => {
  const calls = routes({
    execute: () => jsonResponse({ status: "Failed", signature: "SIG_PENDING", code: -1000 }),
  });
  const connection = stubConnection({ statuses: [null] });
  const r = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, deps(connection));
  assert.equal(r.success, false);
  assert.equal(r.ambiguous, true);
  assert.equal(r.tx, "SIG_PENDING");
  assert.match(r.error, /do not retry/);
  assert.equal(connection.calls.getSignatureStatuses.length, 3);
  assert.equal(v1Calls(calls).length, 0);
  assert.equal(connection.calls.sendRawTransaction, 0);
});

test("execute transport error checks the locally known signature, no fallback", async () => {
  const calls = routes({ execute: () => { throw new TypeError("fetch failed"); } });
  const connection = stubConnection({ statuses: [{ confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } }] });
  const r = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, deps(connection));
  assert.equal(r.success, false);
  assert.notEqual(r.ambiguous, true, "a landed-but-failed tx is definitive");
  assert.match(r.error, /failed on-chain/);
  // The checked signature is the base58 signature of the tx we signed.
  const sig = connection.calls.getSignatureStatuses[0];
  assert.equal(bs58.decode(sig).length, 64);
  assert.equal(execCalls(calls).length, 3, "jupiterFetch resends the same signed tx on network errors");
  assert.equal(v1Calls(calls).length, 0);
});

test("execute failed-to-land code without signature is ambiguous, no fallback", async () => {
  const calls = routes({ execute: () => jsonResponse({ status: "Failed", code: -1000 }) });
  const connection = stubConnection({ statuses: [null] });
  const r = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, deps(connection));
  assert.equal(r.success, false);
  assert.equal(r.ambiguous, true);
  assert.equal(connection.calls.getSignatureStatuses.length, 3);
  assert.equal(v1Calls(calls).length, 0);
});

test("execute pre-send rejection without signature falls back to swap/v1", async () => {
  const calls = routes({ execute: () => jsonResponse({ status: "Failed", code: -2004 }) });
  const connection = stubConnection();
  const r = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, deps(connection));
  assert.equal(r.success, true);
  assert.equal(r.tx, connection.calls.confirmed[0].signature);
  assert.equal(connection.calls.getSignatureStatuses.length, 0);
  assert.equal(v1Calls(calls).length, 2);
});

test("execute plain 4xx without code or signature fails without fallback", async () => {
  const calls = routes({ execute: () => jsonResponse({ error: "bad request" }, 400) });
  const connection = stubConnection();
  const r = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, deps(connection));
  assert.equal(r.success, false);
  assert.match(r.error, /Swap v2 execute failed/);
  assert.equal(v1Calls(calls).length, 0);
  assert.equal(connection.calls.getSignatureStatuses.length, 0);
});

// ─── swap/v1 fallback: on-chain result, priority fee, confirm errors ──────

const v1FallbackRoutes = (extra = {}) => routes({
  order: () => jsonResponse({ transaction: "", requestId: "r", errorCode: 1, errorMessage: "no tx" }),
  execute: () => { throw new Error("execute must not be called"); },
  ...extra,
});

test("swap/v1 fallback: tx landed but FAILED on-chain → success:false (not a false SUCCESS)", async () => {
  v1FallbackRoutes();
  const connection = stubConnection({ confirm: { err: { InstructionError: [3, { Custom: 6001 }] } } });
  const r = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, deps(connection));
  assert.equal(r.success, false);
  assert.match(r.error, /failed on-chain/);
  assert.match(r.error, /6001/);
  assert.equal(r.tx, connection.calls.confirmed[0].signature);
});

test("swap/v1 fallback: /swap body asks for dynamic CU limit and the floor CU price", async () => {
  const calls = v1FallbackRoutes();
  const r = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, deps(stubConnection()));
  assert.equal(r.success, true);
  const body = JSON.parse(calls.find((c) => c.url.includes("/swap/v1/swap")).opts.body);
  assert.equal(body.dynamicComputeUnitLimit, true);
  assert.ok(body.computeUnitPriceMicroLamports >= 50_000, `price ${body.computeUnitPriceMicroLamports}`);
  // price × 1.4M CU must stay within maxPriorityFeeLamports (default 0.001 SOL)
  assert.ok(body.computeUnitPriceMicroLamports * 1.4 <= 1_000_000);
});

test("swap/v1 fallback: expiry with no landing → failure; expiry but landed OK → success", async () => {
  v1FallbackRoutes();
  const expire = () => { throw new Error("block height exceeded"); };
  const notLanded = stubConnection({ confirm: expire, statuses: [null] });
  const r1 = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, deps(notLanded));
  assert.equal(r1.success, false);
  assert.match(r1.error, /did not confirm/);

  v1FallbackRoutes();
  const landed = stubConnection({ confirm: expire, statuses: [{ err: null, confirmationStatus: "confirmed" }] });
  const r2 = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, deps(landed));
  assert.equal(r2.success, true);

  v1FallbackRoutes();
  const landedFailed = stubConnection({ confirm: expire, statuses: [{ err: { InstructionError: [0, "x"] }, confirmationStatus: "confirmed" }] });
  const r3 = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, deps(landedFailed));
  assert.equal(r3.success, false);
  assert.match(r3.error, /failed on-chain/);
});

// ─── Price-impact cap (config.risk.maxSwapPriceImpactPct) ─────

const { config: walletConfig } = await import("../config.js");

test("price impact above maxSwapPriceImpactPct is refused before signing; no execute, no v1 fallback", async () => {
  const before = walletConfig.risk.maxSwapPriceImpactPct;
  try {
    walletConfig.risk.maxSwapPriceImpactPct = 5;
    // Negative on a healthy quote: the cap must compare the absolute value.
    const calls = routes({
      order: () => jsonResponse({ ...orderOk(), priceImpact: -7.5, priceImpactPct: "-0.075" }),
      execute: () => { throw new Error("execute must not be called"); },
    });
    const r = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, deps(stubConnection()));
    assert.equal(r.success, false);
    assert.equal(r.price_impact_refused, true);
    assert.equal(r.price_impact_pct, 7.5);
    assert.equal(r.max_price_impact_pct, 5);
    assert.match(r.error, /price impact 7\.50% exceeds maxSwapPriceImpactPct 5%/);
    assert.equal(execCalls(calls).length, 0);
    assert.equal(v1Calls(calls).length, 0);
  } finally {
    walletConfig.risk.maxSwapPriceImpactPct = before;
  }
});

test("price impact at or under the cap executes; the cap follows config", async () => {
  const before = walletConfig.risk.maxSwapPriceImpactPct;
  try {
    walletConfig.risk.maxSwapPriceImpactPct = 5;
    routes({
      order: () => jsonResponse({ ...orderOk(), priceImpact: -4.99 }),
      execute: () => jsonResponse({ status: "Success", signature: "SIG_UNDER", code: 0 }),
    });
    const ok = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, deps(stubConnection()));
    assert.equal(ok.success, true);
    assert.equal(ok.tx, "SIG_UNDER");

    // Tighter cap: the same 4.99% quote is now refused.
    walletConfig.risk.maxSwapPriceImpactPct = 2;
    routes({
      order: () => jsonResponse({ ...orderOk(), priceImpact: -4.99 }),
      execute: () => { throw new Error("execute must not be called"); },
    });
    const refused = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, deps(stubConnection()));
    assert.equal(refused.price_impact_refused, true);

    // Invalid config falls back to the 5% default.
    walletConfig.risk.maxSwapPriceImpactPct = "junk";
    routes({
      order: () => jsonResponse({ ...orderOk(), priceImpact: 6 }),
      execute: () => { throw new Error("execute must not be called"); },
    });
    const dflt = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, deps(stubConnection()));
    assert.equal(dflt.max_price_impact_pct, 5);
  } finally {
    walletConfig.risk.maxSwapPriceImpactPct = before;
  }
});

test("close swap-backs use maxCloseSwapPriceImpactPct (default 25), not the 5% cap", async () => {
  const before = { ...walletConfig.risk };
  try {
    walletConfig.risk.maxSwapPriceImpactPct = 5;
    walletConfig.risk.maxCloseSwapPriceImpactPct = 25;
    // A live-seen 5.307% exit impact: refused under the default cap...
    routes({
      order: () => jsonResponse({ ...orderOk(), priceImpact: -5.307 }),
      execute: () => { throw new Error("execute must not be called"); },
    });
    const agent = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, deps(stubConnection()));
    assert.equal(agent.price_impact_refused, true);
    assert.equal(agent.price_impact_cap_key, "maxSwapPriceImpactPct");

    // ...but a close swap-back goes through.
    routes({
      order: () => jsonResponse({ ...orderOk(), priceImpact: -5.307 }),
      execute: () => jsonResponse({ status: "Success", signature: "SIG_CLOSE", code: 0 }),
    });
    const close = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, { ...deps(stubConnection()), impactCap: "close" });
    assert.equal(close.success, true);
    assert.equal(close.tx, "SIG_CLOSE");

    // Above the close cap it is refused too, naming that cap.
    routes({
      order: () => jsonResponse({ ...orderOk(), priceImpact: -31.2 }),
      execute: () => { throw new Error("execute must not be called"); },
    });
    const over = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, { ...deps(stubConnection()), impactCap: "close" });
    assert.equal(over.price_impact_refused, true);
    assert.equal(over.max_price_impact_pct, 25);
    assert.equal(over.price_impact_cap_key, "maxCloseSwapPriceImpactPct");
    assert.match(over.error, /31\.20% exceeds maxCloseSwapPriceImpactPct 25%/);

    // The close cap follows config; an invalid value falls back to 25.
    walletConfig.risk.maxCloseSwapPriceImpactPct = "junk";
    routes({
      order: () => jsonResponse({ ...orderOk(), priceImpact: 26 }),
      execute: () => { throw new Error("execute must not be called"); },
    });
    const dflt = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, { ...deps(stubConnection()), impactCap: "close" });
    assert.equal(dflt.max_price_impact_pct, 25);
  } finally {
    Object.assign(walletConfig.risk, before);
  }
});

test("price-impact cap also applies to the swap/v1 fallback quote (fraction units)", async () => {
  const before = walletConfig.risk.maxSwapPriceImpactPct;
  try {
    walletConfig.risk.maxSwapPriceImpactPct = 5;
    const connection = stubConnection();
    const calls = routes({
      order: () => jsonResponse({ transaction: "", errorCode: 1, errorMessage: "no tx" }),
      quote: () => jsonResponse({ inAmount: "1000000", outAmount: "5000000", priceImpactPct: "0.12" }),
      swap: () => { throw new Error("v1 swap must not be requested"); },
    });
    const r = await swapToken({ input_mint: USDC, output_mint: SOL, amount: 1 }, deps(connection));
    assert.equal(r.success, false);
    assert.equal(r.price_impact_refused, true);
    assert.equal(r.price_impact_pct, 12);
    assert.equal(calls.filter((c) => c.url.includes("/swap/v1/swap")).length, 0);
    assert.equal(connection.calls.sendRawTransaction, 0);
  } finally {
    walletConfig.risk.maxSwapPriceImpactPct = before;
  }
});
