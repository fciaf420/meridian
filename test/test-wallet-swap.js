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

/** Stub connection recording every call. `statuses` feeds getSignatureStatuses. */
function stubConnection({ statuses = [null] } = {}) {
  const calls = { getSignatureStatuses: [], sendRawTransaction: 0, other: [] };
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
    confirmTransaction: async () => ({ value: { err: null } }),
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
    if (url.includes("/swap/v1/swap")) return (swap ?? (() => jsonResponse({ swapTransaction: unsignedTxBase64() })))(url, opts);
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
  assert.deepEqual(connection.calls, { getSignatureStatuses: [], sendRawTransaction: 0, other: [] });
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
  assert.equal(r.tx, "v1FallbackSig");
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
  assert.equal(r.tx, "v1FallbackSig");
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
