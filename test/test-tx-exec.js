/**
 * Transaction execution hardening (tools/dlmm.js send path): size guard,
 * idempotent fee preparation, CU sizing, retry escalation, parallel chunk
 * reconcile, and the PnL watcher's position-existence check.
 *
 * Everything runs against a mock connection and a mocked fetch. No network,
 * no RPC; the throwaway keypair is never funded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

process.env.DRY_RUN = "false";
delete process.env.HELIUS_API_KEY; // no Helius fee-estimate fetch in tests

const dlmm = await import("../tools/dlmm.js");
const { config } = await import("../config.js");
const txSend = await import("../tools/tx-send.js");
const {
  _applyPriorityFeeForTest: applyPriorityFee,
  _sendManagedTransactionForTest: sendManagedTransaction,
  _setDlmmTestDeps: setDeps,
} = dlmm;
const { legacyTxSize, isSenderTipIx, MAX_TX_BYTES } = txSend;

const wallet = Keypair.generate();
const PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const CB = ComputeBudgetProgram.programId;
const isLimit = (ix) => ix.programId.equals(CB) && ix.data[0] === 2;
const isPrice = (ix) => ix.programId.equals(CB) && ix.data[0] === 3;
const limitOf = (tx) => tx.instructions.find(isLimit).data.readUInt32LE(1);
const priceOf = (tx) => Number(tx.instructions.find(isPrice).data.readBigUInt64LE(1));
const count = (tx, pred) => tx.instructions.filter(pred).length;

/** Mock connection. `confirm(n)` returns the n-th confirm's status value or throws. */
function mockConnection({ unitsConsumed = 100_000, confirm = () => ({ err: null }), statuses = [] } = {}) {
  const calls = { simulate: 0, sendRaw: 0, confirm: 0, blockhash: 0, statuses: 0, sentWires: [] };
  return {
    calls,
    getLatestBlockhash: async () => {
      calls.blockhash++;
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 + calls.blockhash };
    },
    simulateTransaction: async () => { calls.simulate++; return { value: { err: null, unitsConsumed } }; },
    sendRawTransaction: async (wire) => { calls.sendRaw++; calls.sentWires.push(wire); return "rpc-sig"; },
    confirmTransaction: async () => { calls.confirm++; return { value: confirm(calls.confirm) }; },
    getSignatureStatuses: async () => { calls.statuses++; return { value: [statuses.shift() ?? null] }; },
  };
}

/** Record Helius Sender posts; Sender accepts everything. */
const realFetch = globalThis.fetch;
function mockSender() {
  const posts = [];
  globalThis.fetch = async (url, opts) => {
    posts.push({ url: String(url), body: opts?.body });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: "sender-sig" }), { status: 200 });
  };
  return posts;
}

const savedMgmt = { ...config.management };
test.afterEach(() => {
  globalThis.fetch = realFetch;
  setDeps({ connection: null, wallet: null });
  Object.assign(config.management, savedMgmt);
});

/** Legacy tx with one instruction carrying `dataLen` bytes of data. */
function makeTx(dataLen = 10, extra = []) {
  const tx = new Transaction();
  if (extra.length) tx.add(...extra);
  tx.add(new TransactionInstruction({
    programId: PROGRAM,
    keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }],
    data: Buffer.alloc(dataLen, 1),
  }));
  return tx;
}

/** Size a tx would have once tip + CU limit + CU price are added. */
function preparedSize(dataLen, withTip) {
  const tx = makeTx(dataLen);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }));
  if (withTip) tx.add(txSend.buildSenderTipIx(wallet.publicKey));
  return legacyTxSize(tx);
}
/** Smallest data length whose prepared size exceeds `limit` (data len >= 128: size grows 1:1). */
function dataLenOver(limit, withTip) {
  for (let n = 128; n < 1400; n++) if (preparedSize(n, withTip) > limit) return n;
  throw new Error("unreachable");
}

// ─── 4. Size guard + idempotency ───────────────────────────────

test("size helper matches web3.js serialize() for a signed tx", () => {
  const tx = makeTx(300);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.sign(wallet);
  assert.equal(legacyTxSize(tx), tx.serialize().length);
});

test("applyPriorityFee adds exactly one tip, one CU limit and one CU price", async () => {
  const conn = mockConnection();
  setDeps({ connection: conn });
  const tx = makeTx(50);
  await applyPriorityFee(tx, wallet.publicKey, "t");
  assert.equal(count(tx, isSenderTipIx), 1);
  assert.equal(count(tx, isLimit), 1);
  assert.equal(count(tx, isPrice), 1);
  assert.equal(limitOf(tx), 120_000); // 100k simulated × 1.2
  assert.ok(priceOf(tx) >= 50_000);
});

test("applyPriorityFee is idempotent: a second call adds no tip / CU instruction", async () => {
  const conn = mockConnection();
  setDeps({ connection: conn });
  const tx = makeTx(50);
  await applyPriorityFee(tx, wallet.publicKey, "t");
  const before = tx.instructions.length;
  await applyPriorityFee(tx, wallet.publicKey, "t");
  assert.equal(tx.instructions.length, before);
  assert.equal(count(tx, isSenderTipIx), 1);
  assert.equal(count(tx, isLimit), 1);
  assert.equal(count(tx, isPrice), 1);
  assert.equal(conn.calls.simulate, 1);
});

test("an existing tip / CU price is reused in place, never duplicated", async () => {
  setDeps({ connection: mockConnection() });
  const tx = makeTx(50, [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 7 }),
  ]);
  tx.add(txSend.buildSenderTipIx(wallet.publicKey));
  await applyPriorityFee(tx, wallet.publicKey, "t");
  assert.equal(count(tx, isSenderTipIx), 1);
  assert.equal(count(tx, isPrice), 1);
  assert.notEqual(priceOf(tx), 7);
});

test("size guard: over 1232 only because of the tip → tip dropped, sent via RPC only", async () => {
  const n = dataLenOver(MAX_TX_BYTES, true);
  assert.ok(preparedSize(n, false) <= MAX_TX_BYTES, "fixture must fit without the tip");
  const conn = mockConnection();
  setDeps({ connection: conn, wallet });
  const posts = mockSender();
  const tx = makeTx(n);
  const sig = await sendManagedTransaction(tx, [wallet], "big");
  assert.equal(count(tx, isSenderTipIx), 0);
  assert.equal(conn.calls.sendRaw, 1);            // RPC path used
  assert.equal(posts.length, 0);                  // Sender never called (it requires the tip)
  assert.ok(conn.calls.sentWires[0].length <= MAX_TX_BYTES);
  assert.equal(typeof sig, "string");
});

test("size guard: too large even without the tip → clear error, nothing signed or sent", async () => {
  const n = dataLenOver(MAX_TX_BYTES, false);
  const conn = mockConnection();
  setDeps({ connection: conn, wallet });
  const posts = mockSender();
  const tx = makeTx(n);
  await assert.rejects(sendManagedTransaction(tx, [wallet], "huge"), /over the 1232-byte limit even without the Sender tip/);
  assert.equal(tx.signature, null);
  assert.equal(conn.calls.sendRaw, 0);
  assert.equal(posts.length, 0);
});

test("normal-size tx goes to Sender and the RPC", async () => {
  const conn = mockConnection();
  setDeps({ connection: conn, wallet });
  const posts = mockSender();
  await sendManagedTransaction(makeTx(50), [wallet], "small");
  assert.equal(conn.calls.sendRaw, 1);
  assert.ok(posts.length >= 1);
});
