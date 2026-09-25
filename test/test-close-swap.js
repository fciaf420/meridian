/**
 * Post-close swap-back tests (tools/close-swap.js) and the on-chain balance
 * helper (getOnchainTokenBalance). Everything is mocked: balance reads, price,
 * swap and the RPC connection. No network, no RPC, no transactions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";

process.env.DRY_RUN = "false";

const {
  swapBackWithdrawnBase,
  expectedBaseWithdrawRaw,
  rawToUiString,
  toRawBigInt,
} = await import("../tools/close-swap.js");
const { getOnchainTokenBalance, uiToRawAmount } = await import("../tools/wallet.js");

const MINT = "2PENPmfgJfq6CG3k4byj4oWwHf8SerqakmYHMkUupump";
const SOL = "So11111111111111111111111111111111111111112";
const DEC = 6;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PUnBqLxhVUXw1R";

/**
 * Harness: `balances` is the sequence of raw balances the on-chain read
 * returns (the last one repeats); an entry may be an Error to throw. Each
 * successful swap lowers the simulated balance by what it sold, so re-reads
 * after a swap see the real remaining delta.
 */
function harness({ balances, price = null, swapResults = [{ success: true, tx: "SIG1" }] }) {
  const logs = [];
  const swaps = [];
  let readIdx = 0;
  let sold = 0n;
  const deps = {
    readBalance: async (mint) => {
      assert.equal(mint, MINT);
      const v = balances[Math.min(readIdx, balances.length - 1)];
      readIdx++;
      if (v instanceof Error) throw v;
      return { raw: BigInt(v) - sold, decimals: DEC, accounts: 1 };
    },
    getPrice: async () => price,
    swap: async (args) => {
      swaps.push(args);
      const r = swapResults[Math.min(swaps.length - 1, swapResults.length - 1)];
      if (r instanceof Error) throw r;
      if (r?.success) sold += BigInt(uiToRawAmount(args.amount, DEC));
      return r;
    },
    sleep: async () => {},
    log: (cat, msg) => logs.push({ cat, msg }),
  };
  return { deps, logs, swaps, reads: () => readIdx };
}

const warns = (logs) => logs.filter((l) => l.cat === "close_warn");

test("rawToUiString round-trips through uiToRawAmount exactly", () => {
  for (const [raw, dec] of [[22104412857n, 6], [1n, 9], [0n, 6], [1000000n, 6], [123n, 0], [721233237n, 6]]) {
    const ui = rawToUiString(raw, dec);
    assert.equal(uiToRawAmount(ui, dec), raw.toString(), `${raw}/${dec} -> ${ui}`);
  }
  assert.equal(rawToUiString(2836447169n, 6), "2836.447169");
  assert.equal(rawToUiString(1000000n, 6), "1");
  assert.equal(toRawBigInt("14873991292.73"), 14873991292n);
  assert.equal(toRawBigInt({ toString: () => "7230421565" }), 7230421565n);
  assert.equal(toRawBigInt("abc"), null);
});

test("stale first reads that then catch up are swapped (not skipped)", async () => {
  // Pre 0; the first two reads still show the pre-close balance, then the
  // withdrawal (721.233237 BRAIN-style fee X) appears.
  const h = harness({ balances: [0, 0, 721233237], price: 0.0005 });
  const r = await swapBackWithdrawnBase({ baseMint: MINT, symbol: "BRAIN", preRaw: 0n, expectedRaw: 721233237n }, h.deps);
  assert.equal(h.swaps.length, 1);
  assert.deepEqual(h.swaps[0], { input_mint: MINT, output_mint: SOL, amount: "721.233237" });
  assert.equal(r.exposureFlag, false);
  assert.equal(r.swapOutcome.success, true);
  assert.deepEqual(r.txs, ["SIG1"]);
  assert.equal(h.reads(), 3);
});

test("pre-existing holdings are excluded from the sold delta", async () => {
  // NPC-style: 1.465829 already held, the close adds 1019.485077.
  const h = harness({ balances: [1020950906], price: 0.002 });
  const r = await swapBackWithdrawnBase({ baseMint: MINT, preRaw: 1465829n, expectedRaw: 1019485077n }, h.deps);
  assert.equal(h.swaps[0].amount, "1019.485077");
  assert.equal(r.swapOutcome.success, true);
});

test("a delta that never appears gives close_warn and exposure", async () => {
  const h = harness({ balances: [5000000] });
  const r = await swapBackWithdrawnBase({ baseMint: MINT, preRaw: 5000000n, expectedRaw: 13874465n }, h.deps);
  assert.equal(h.swaps.length, 0);
  assert.equal(r.exposureFlag, true);
  assert.equal(r.swapOutcome.success, false);
  assert.match(r.swapOutcome.error, /never showed/);
  assert.ok(warns(h.logs).some((l) => /no balance increase showed on-chain/.test(l.msg)));
  // It polled the whole schedule (~15s) before giving up.
  assert.ok(h.reads() >= 8);
});

test("an unpriced token still gets a swap attempt", async () => {
  const h = harness({ balances: [721233237], price: null });
  const r = await swapBackWithdrawnBase({ baseMint: MINT, preRaw: 0n, expectedRaw: 721233237n }, h.deps);
  assert.equal(h.swaps.length, 1);
  assert.equal(r.swapOutcome.success, true);
  assert.ok(h.logs.some((l) => /unpriced/.test(l.msg)));
});

test("a priced delta under the dust gate is left, logged, and not flagged", async () => {
  // STONK10-style: 13.874465 tokens worth well under $0.10.
  const h = harness({ balances: [13874465], price: 0.0005 });
  const r = await swapBackWithdrawnBase({ baseMint: MINT, preRaw: 0n, expectedRaw: 13874465n }, h.deps);
  assert.equal(h.swaps.length, 0);
  assert.equal(r.exposureFlag, false);
  assert.equal(r.swapOutcome.skipped, "dust");
  assert.ok(h.logs.some((l) => /dust gate/.test(l.msg)));
});

test("a no-route error on an unpriced token is reported as exposure", async () => {
  const h = harness({ balances: [721233237], price: null, swapResults: [{ success: false, error: "No route found" }] });
  const r = await swapBackWithdrawnBase({ baseMint: MINT, preRaw: 0n, expectedRaw: 721233237n }, h.deps);
  assert.equal(h.swaps.length, 1, "terminal error is not retried");
  assert.equal(r.exposureFlag, true);
  assert.equal(r.swapOutcome.success, false);
  assert.equal(r.swapOutcome.unsold_ui, "721.233237");
});

test("a pre-read error (unknown pre balance) skips the swap and flags exposure", async () => {
  const h = harness({ balances: [721233237] });
  const r = await swapBackWithdrawnBase({ baseMint: MINT, preRaw: null, expectedRaw: 721233237n }, h.deps);
  assert.equal(h.swaps.length, 0);
  assert.equal(h.reads(), 0);
  assert.equal(r.exposureFlag, true);
  assert.match(r.swapOutcome.error, /pre-close base balance unknown/);
  assert.ok(warns(h.logs).length > 0);
});

test("the delta is clamped to the expected amount (+2%)", async () => {
  // Another 5000 tokens land in the same window (e.g. a transfer in); only
  // expected + 2% of it is sold.
  const expected = 1000000000n; // 1000 tokens
  const h = harness({ balances: [expected + 5000000000n], price: 1 });
  const r = await swapBackWithdrawnBase({ baseMint: MINT, preRaw: 0n, expectedRaw: expected }, h.deps);
  assert.equal(h.swaps.length, 1);
  assert.equal(h.swaps[0].amount, "1020");
  assert.equal(r.swapOutcome.success, true);
  assert.equal(r.swapOutcome.unsold_over_expected_ui, "4980");
  assert.ok(warns(h.logs).some((l) => /not attributable/.test(l.msg)));
});

test("expected 0 never sells an unrelated inflow", async () => {
  const h = harness({ balances: [5000000], price: 1 });
  const r = await swapBackWithdrawnBase({ baseMint: MINT, preRaw: 0n, expectedRaw: 0n }, h.deps);
  assert.equal(h.swaps.length, 0);
  assert.equal(r.exposureFlag, false);
});

test("familiars partial case: waits for every remove chunk, sells the full delta", async () => {
  // On-chain: chunk 2 lands 2836.447169 first, chunk 1 adds 19267.965688
  // (22104.412857 total = X liquidity + 7230.421565 fee X). The old code read
  // the half-indexed balance and sold only 2836.447169.
  const h = harness({ balances: [2836447169, 2836447169, 22104412857], price: 0.0007 });
  const r = await swapBackWithdrawnBase({ baseMint: MINT, symbol: "familiars", preRaw: 0n, expectedRaw: 22104412857n }, h.deps);
  assert.equal(h.swaps.length, 1);
  assert.equal(h.swaps[0].amount, "22104.412857");
  assert.equal(r.swapOutcome.success, true);
});

test("familiars partial case with expected unknown: sells the partial delta, then the rest on re-read", async () => {
  // Without the expected hint the first read can only see chunk 2. After the
  // swap the balance is re-read and what arrived since is sold too.
  const h = harness({ balances: [2836447169, 22104412857], price: 0.0007, swapResults: [{ success: true, tx: "A" }, { success: true, tx: "B" }] });
  const r = await swapBackWithdrawnBase({ baseMint: MINT, preRaw: 0n, expectedRaw: null }, h.deps);
  assert.deepEqual(h.swaps.map((s) => s.amount), ["2836.447169", "19267.965688"]);
  assert.equal(r.swapOutcome.success, true);
  assert.equal(r.exposureFlag, false);
  assert.equal(r.swapOutcome.sold_ui, "22104.412857");
});

test("partial fill below expected triggers a re-read and a second swap for the rest", async () => {
  // First poll never catches up within the window (only chunk 2 visible), so
  // it sells that; the retry re-reads and sells the remainder.
  const partial = 2836447169;
  const full = 22104412857;
  const balances = [...Array(8).fill(partial), full];
  const h = harness({ balances, price: 0.0007, swapResults: [{ success: true, tx: "A" }, { success: true, tx: "B" }] });
  const r = await swapBackWithdrawnBase({ baseMint: MINT, preRaw: 0n, expectedRaw: BigInt(full) }, h.deps);
  assert.deepEqual(h.swaps.map((s) => s.amount), ["2836.447169", "19267.965688"]);
  assert.deepEqual(r.txs, ["A", "B"]);
  assert.equal(r.swapOutcome.success, true);
  assert.equal(r.swapOutcome.sold_ui, "22104.412857");
});

test("retries re-read the balance and re-clamp; a silently landed swap is not resold", async () => {
  // Attempt 1 reports failure but actually landed: the re-read shows delta 0.
  const logs = [];
  let bal = 721233237n;
  let calls = 0;
  const deps = {
    readBalance: async () => ({ raw: bal, decimals: DEC }),
    getPrice: async () => null,
    swap: async () => { calls++; bal = 0n; return { success: false, error: "timeout" }; },
    sleep: async () => {},
    log: (cat, msg) => logs.push({ cat, msg }),
  };
  const r = await swapBackWithdrawnBase({ baseMint: MINT, preRaw: 0n, expectedRaw: 721233237n }, deps);
  assert.equal(calls, 1);
  assert.equal(r.swapOutcome.success, true);
  assert.equal(r.exposureFlag, false);
});

test("an ambiguous swap is not retried and is flagged", async () => {
  const h = harness({ balances: [721233237], swapResults: [{ success: false, ambiguous: true, error: "outcome unknown" }] });
  const r = await swapBackWithdrawnBase({ baseMint: MINT, preRaw: 0n, expectedRaw: 721233237n }, h.deps);
  assert.equal(h.swaps.length, 1);
  assert.equal(r.exposureFlag, true);
  assert.equal(r.swapOutcome.ambiguous, true);
});

test("failed swaps retry up to 3 times, then flag exposure", async () => {
  const h = harness({ balances: [721233237], swapResults: [{ success: false, error: "slippage" }] });
  const r = await swapBackWithdrawnBase({ baseMint: MINT, preRaw: 0n, expectedRaw: 721233237n }, h.deps);
  assert.equal(h.swaps.length, 3);
  assert.equal(r.exposureFlag, true);
  assert.equal(r.swapOutcome.attempts, 3);
});

test("post-close read errors never count as a zero delta", async () => {
  const err = new Error("RPC 503");
  const h = harness({ balances: [err] });
  const r = await swapBackWithdrawnBase({ baseMint: MINT, preRaw: 0n, expectedRaw: 721233237n }, h.deps);
  assert.equal(h.swaps.length, 0);
  assert.equal(r.exposureFlag, true);
  assert.match(r.swapOutcome.error, /balance read failed/);
});

test("expectedBaseWithdrawRaw: X liquidity + fee X, net of transfer fee, only for token X", () => {
  const pool = { lbPair: { tokenXMint: new PublicKey(MINT) } };
  const bn = (s) => ({ toString: () => s });
  const pd = {
    positionData: {
      totalXAmount: "14873991292",
      feeX: bn("7230421565"),
      totalXAmountExcludeTransferFee: bn("14873991292"),
      feeXExcludeTransferFee: bn("7230421565"),
    },
  };
  assert.equal(expectedBaseWithdrawRaw(pool, pd, MINT), 22104412857n);
  // Falls back to gross amounts when the transfer-fee fields are missing.
  assert.equal(expectedBaseWithdrawRaw(pool, { positionData: { totalXAmount: "10", feeX: bn("5") } }, MINT), 15n);
  // Base token is not token X, or no data: unknown.
  assert.equal(expectedBaseWithdrawRaw(pool, pd, SOL), null);
  assert.equal(expectedBaseWithdrawRaw(pool, null, MINT), null);
});

// ─── getOnchainTokenBalance ────────────────────────────────────

function parsedAccount(amount, decimals, programId) {
  return {
    pubkey: Keypair.generate().publicKey,
    account: {
      owner: new PublicKey(programId),
      data: { program: programId === TOKEN_2022 ? "spl-token-2022" : "spl-token", parsed: { info: { mint: MINT, tokenAmount: { amount, decimals } } } },
    },
  };
}

test("getOnchainTokenBalance sums Token and Token-2022 accounts at confirmed", async () => {
  const owner = Keypair.generate().publicKey;
  const calls = [];
  const connection = {
    getParsedTokenAccountsByOwner: async (o, filter, cfg) => {
      calls.push({ o, filter, cfg });
      return { value: [parsedAccount("2836447169", DEC, TOKEN_2022), parsedAccount("19267965688", DEC, TOKEN_2022), parsedAccount("1", DEC, TOKEN_PROGRAM)] };
    },
  };
  const r = await getOnchainTokenBalance(MINT, { connection, owner });
  assert.equal(r.raw, 22104412858n);
  assert.equal(r.decimals, DEC);
  assert.equal(r.accounts, 3);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].o.equals(owner));
  assert.equal(calls[0].filter.mint.toBase58(), MINT);
  assert.equal(calls[0].cfg.commitment, "confirmed");
});

test("getOnchainTokenBalance: no accounts is a known zero; RPC errors throw", async () => {
  const owner = Keypair.generate().publicKey;
  const empty = await getOnchainTokenBalance(MINT, { owner, connection: { getParsedTokenAccountsByOwner: async () => ({ value: [] }) } });
  assert.equal(empty.raw, 0n);
  assert.equal(empty.decimals, null);
  await assert.rejects(
    getOnchainTokenBalance(MINT, { owner, connection: { getParsedTokenAccountsByOwner: async () => { throw new Error("429"); } } }),
    /429/,
  );
  await assert.rejects(
    getOnchainTokenBalance(MINT, { owner, connection: { getParsedTokenAccountsByOwner: async () => ({ value: [{ account: { data: {} } }] }) } }),
    /Unparseable/,
  );
});
