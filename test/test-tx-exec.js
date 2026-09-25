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
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

process.env.DRY_RUN = "false";
delete process.env.HELIUS_API_KEY; // no Helius fee-estimate fetch in tests

const dlmm = await import("../tools/dlmm.js");
const { config } = await import("../config.js");
const txSend = await import("../tools/tx-send.js");
const {
  reconcileChunkResults,
  _readChunkFundingForTest: readChunkFunding,
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

// ─── 6. Parallel chunks: reconcile + no blind resend ───────────

const ok = (v) => ({ status: "fulfilled", value: v });
const bad = (m) => ({ status: "rejected", reason: new Error(m) });

test("reconcile: all chunks confirmed → all landed", () => {
  const r = reconcileChunkResults([ok("a"), ok("b"), ok("c")], [true, true, true]);
  assert.deepEqual(r, { landed: [0, 1, 2], failed: [], unknown: [] });
});

test("reconcile: partial — one chunk rejected and verified empty → failed (partial deploy)", () => {
  const r = reconcileChunkResults([ok("a"), bad("block height exceeded"), ok("c")], [true, false, true]);
  assert.deepEqual(r, { landed: [0, 2], failed: [1], unknown: [] });
});

test("reconcile: rejected but its bins are funded → landed anyway (not a failure, not resent)", () => {
  const r = reconcileChunkResults([ok("a"), bad("confirm timeout")], [true, true]);
  assert.deepEqual(r, { landed: [0, 1], failed: [], unknown: [] });
});

test("reconcile: rejected and on-chain read failed → unknown (kept as possibly funded)", () => {
  const r = reconcileChunkResults([ok("a"), bad("x")], null);
  assert.deepEqual(r, { landed: [0], failed: [], unknown: [1] });
});

test("readChunkFunding maps position bins onto chunk ranges; read error → null", async () => {
  const bins = [
    { binId: -100, positionXAmount: "0", positionYAmount: "5" },
    { binId: -31, positionXAmount: "0", positionYAmount: "0" },
    { binId: -30, positionXAmount: "0", positionYAmount: "0" },
    { binId: 45, positionXAmount: "3", positionYAmount: "0" },
  ];
  const pool = { getPosition: async () => ({ positionData: { positionBinData: bins } }) };
  const ranges = [{ lowerBinId: -100, upperBinId: -31 }, { lowerBinId: -30, upperBinId: 39 }, { lowerBinId: 40, upperBinId: 61 }];
  assert.deepEqual(await readChunkFunding(pool, wallet.publicKey, ranges), [true, false, true]);
  const broken = { getPosition: async () => { throw new Error("rpc down"); } };
  assert.equal(await readChunkFunding(broken, wallet.publicKey, ranges), null);
});

const expireOnce = (n) => { if (n === 1) throw new Error("block height exceeded"); return { err: null }; };

test("no blind resend: expired chunk whose bins can't be verified empty is NOT resent", async () => {
  const conn = mockConnection({ confirm: expireOnce, statuses: [null] });
  setDeps({ connection: conn, wallet });
  mockSender();
  let checks = 0;
  await assert.rejects(
    sendManagedTransaction(makeTx(40), [wallet], "chunk 2/3", { beforeResend: async () => { checks++; return false; } }),
    /not resending after expiry/,
  );
  assert.equal(checks, 1);
  assert.equal(conn.calls.sendRaw, 1); // only the first send
  assert.equal(conn.calls.statuses, 1); // prior signature was checked first
});

test("no blind resend: a throwing resend check also blocks the resend", async () => {
  const conn = mockConnection({ confirm: expireOnce, statuses: [null] });
  setDeps({ connection: conn, wallet });
  mockSender();
  await assert.rejects(
    sendManagedTransaction(makeTx(40), [wallet], "chunk", { beforeResend: async () => { throw new Error("read failed"); } }),
    /not resending/,
  );
  assert.equal(conn.calls.sendRaw, 1);
});

test("resend happens only after the prior sig is not landed AND the bins are verified empty", async () => {
  const conn = mockConnection({ confirm: expireOnce, statuses: [null] });
  setDeps({ connection: conn, wallet });
  mockSender();
  const sig = await sendManagedTransaction(makeTx(40), [wallet], "chunk", { beforeResend: async () => true });
  assert.equal(conn.calls.sendRaw, 2);
  assert.equal(typeof sig, "string");
});

test("prior signature landed → returns it without calling the resend check or resending", async () => {
  const conn = mockConnection({ confirm: expireOnce, statuses: [{ err: null, confirmationStatus: "confirmed" }] });
  setDeps({ connection: conn, wallet });
  mockSender();
  let checks = 0;
  await sendManagedTransaction(makeTx(40), [wallet], "chunk", { beforeResend: async () => { checks++; return true; } });
  assert.equal(checks, 0);
  assert.equal(conn.calls.sendRaw, 1);
});

test("allSettled over concurrent chunks: one expiring chunk does not block the others", async () => {
  // Chunk B's first confirm expires and its bins can't be verified → rejected;
  // A and C land. Mirrors the deploy flow: Promise.allSettled + reconcile.
  const conn = mockConnection();
  let n = 0;
  const failSig = new Set();
  conn.confirmTransaction = async ({ signature }) => {
    n++;
    if (n === 2) { failSig.add(signature); throw new Error("block height exceeded"); }
    return { value: { err: null } };
  };
  setDeps({ connection: conn, wallet });
  mockSender();
  const txs = [makeTx(30), makeTx(31), makeTx(32)];
  const results = await Promise.allSettled(txs.map((tx, i) =>
    sendManagedTransaction(tx, [wallet], `add ${i + 1}/3`, { beforeResend: async () => false })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  const failedIdx = results.findIndex((r) => r.status === "rejected");
  const funded = results.map((r) => r.status === "fulfilled");
  const rec = reconcileChunkResults(results, funded);
  assert.deepEqual(rec.failed, [failedIdx]);
  assert.equal(conn.calls.sendRaw, 3); // one send per chunk, no resend
});

// ─── 7. CU limit: always simulate, replace a higher SDK limit ──

test("SDK set 1.4M, tx uses ~29k → replaced with max(50k, measured×1.2)", async () => {
  const conn = mockConnection({ unitsConsumed: 28_843 });
  setDeps({ connection: conn });
  const tx = makeTx(40, [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]);
  await applyPriorityFee(tx, wallet.publicKey, "create");
  assert.equal(conn.calls.simulate, 1);
  assert.equal(count(tx, isLimit), 1);
  assert.equal(limitOf(tx), 50_000); // 34,612 clamped up to the 50k floor
});

test("SDK limit replaced by measured×1.2 when that is lower", async () => {
  setDeps({ connection: mockConnection({ unitsConsumed: 300_000 }) });
  const tx = makeTx(40, [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]);
  await applyPriorityFee(tx, wallet.publicKey, "add");
  assert.equal(limitOf(tx), 360_000);
});

test("SDK limit kept when it is already lower than measured×1.2", async () => {
  setDeps({ connection: mockConnection({ unitsConsumed: 240_000 }) });
  const tx = makeTx(40, [ComputeBudgetProgram.setComputeUnitLimit({ units: 262_000 })]); // e.g. removeLiquidity sim+30%
  await applyPriorityFee(tx, wallet.publicKey, "remove");
  assert.equal(limitOf(tx), 262_000);
});

test("simulation failure keeps the SDK limit (never raises it)", async () => {
  const conn = mockConnection();
  conn.simulateTransaction = async () => { throw new Error("sim down"); };
  setDeps({ connection: conn });
  const tx = makeTx(40, [ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 })]);
  await applyPriorityFee(tx, wallet.publicKey, "x");
  assert.equal(limitOf(tx), 250_000);
});

test("measured×1.2 is clamped to 1.4M", async () => {
  setDeps({ connection: mockConnection({ unitsConsumed: 1_300_000 }) });
  const tx = makeTx(40);
  await applyPriorityFee(tx, wallet.publicKey, "x");
  assert.equal(limitOf(tx), 1_400_000);
});

test("fee cap uses the final (replaced) limit", async () => {
  config.management.minPriorityFeeMicroLamports = 5_000_000; // absurd price to force the cap
  config.management.maxPriorityFeeLamports = 100_000;
  setDeps({ connection: mockConnection({ unitsConsumed: 100_000 }) });
  const tx = makeTx(40, [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]);
  await applyPriorityFee(tx, wallet.publicKey, "x");
  assert.equal(limitOf(tx), 120_000);
  assert.equal(priceOf(tx), Math.floor((100_000 * 1_000_000) / 120_000));
});
