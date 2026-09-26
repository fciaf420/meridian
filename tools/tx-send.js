/**
 * Shared transaction-landing helpers: Helius Sender broadcast, rebroadcast
 * until confirmed, and priority-fee pricing. Used by the DLMM send path
 * (tools/dlmm.js sendManagedTransaction) and the Jupiter swap/v1 fallback
 * (tools/wallet.js) so both land the same way.
 *
 * Every function takes the connection explicitly: no module-level RPC state.
 */
import { PublicKey, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { log } from "../logger.js";
import { invalidateWalletBalances } from "./wallet-cache.js";

// ─── Helius Sender ──────────────────────────────────────────────
// Plain RPC sendTransaction is 1 tx/s on the Free plan, so sends and
// rebroadcasts were being throttled and txs expired. Sender (0 credits,
// 50 tx/s on every plan, staked/SWQoS routing) requires a SOL tip transfer to
// one of these accounts plus a compute-unit price in every tx.
// https://www.helius.dev/docs/sending-transactions/sender
export const HELIUS_SENDER_TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
];
const TIP_ACCOUNT_SET = new Set(HELIUS_SENDER_TIP_ACCOUNTS);

/** Legacy / v0 wire-size limit (PACKET_DATA_SIZE). */
export const MAX_TX_BYTES = 1232;
export const MAX_CU_LIMIT = 1_400_000;
export const MIN_CU_LIMIT = 50_000;

const shortVecLen = (n) => (n < 0x80 ? 1 : n < 0x4000 ? 2 : 3);

/**
 * Wire size in bytes of a legacy Transaction (signatures included), computed
 * from the compiled message. tx.serialize()/serializeMessage() cannot be used
 * to measure: web3.js throws once a tx passes 1232 bytes. Needs feePayer and
 * recentBlockhash set.
 */
export function legacyTxSize(tx) {
  const msg = tx.compileMessage();
  const nSig = msg.header.numRequiredSignatures;
  const nKeys = msg.accountKeys.length;
  let size = shortVecLen(nSig) + 64 * nSig // signatures
    + 3                                     // header
    + shortVecLen(nKeys) + 32 * nKeys       // account keys
    + 32                                    // recent blockhash
    + shortVecLen(msg.instructions.length);
  for (const ix of msg.instructions) {
    const dataLen = bs58.decode(ix.data).length;
    size += 1 + shortVecLen(ix.accounts.length) + ix.accounts.length + shortVecLen(dataLen) + dataLen;
  }
  return size;
}

export function heliusSenderEnabled() {
  return config.management.heliusSender !== false;
}

function heliusSenderUrl() {
  // SWQoS-only route: 0.000005 SOL minimum tip (Sender Max needs 0.001 SOL).
  return config.management.heliusSenderUrl || "https://sender.helius-rpc.com/fast?swqos_only=true";
}

export function buildSenderTipIx(feePayer) {
  const lamports = config.management.heliusSenderTipLamports ?? 5_000; // 0.000005 SOL
  const to = HELIUS_SENDER_TIP_ACCOUNTS[Math.floor(Math.random() * HELIUS_SENDER_TIP_ACCOUNTS.length)];
  return SystemProgram.transfer({ fromPubkey: feePayer, toPubkey: new PublicKey(to), lamports });
}

/** True for a SystemProgram transfer whose destination is a Sender tip account. */
export function isSenderTipIx(ix) {
  if (!ix?.programId?.equals?.(SystemProgram.programId)) return false;
  // Transfer = u32 LE 2; keys: [from, to]
  if (ix.data?.length !== 12 || ix.data.readUInt32LE(0) !== 2) return false;
  const to = ix.keys?.[1]?.pubkey?.toBase58?.();
  return !!to && TIP_ACCOUNT_SET.has(to);
}

/** POST signed bytes to Helius Sender. Resolves true on accept, false otherwise (never throws). */
export async function sendViaHeliusSender(wire, label) {
  try {
    const res = await fetch(heliusSenderUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `meridian-${Date.now()}`,
        method: "sendTransaction",
        params: [Buffer.from(wire).toString("base64"), { encoding: "base64", skipPreflight: true, maxRetries: 0 }],
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.error) {
      log("tx_sender_warn", `${label}: Helius Sender rejected (${res.status}${data?.error ? ` ${data.error.message || JSON.stringify(data.error)}` : ""})`);
      return false;
    }
    return true;
  } catch (error) {
    log("tx_sender_warn", `${label}: Helius Sender unreachable (${error.message})`);
    return false;
  }
}

/**
 * Broadcast signed bytes: Sender (when `sender`) as the fast path, RPC as a
 * redundant path. Throws only when neither accepted the tx.
 */
export async function broadcastSigned(connection, wire, sendOpts, label, { sender = heliusSenderEnabled(), rpc = true } = {}) {
  const viaSender = sender ? sendViaHeliusSender(wire, label) : Promise.resolve(false);
  const viaRpc = rpc
    ? connection.sendRawTransaction(wire, sendOpts).then(() => true, (e) => {
        log("tx_rpc_warn", `${label}: RPC send failed (${e.message})`);
        return false;
      })
    : Promise.resolve(false);
  const [s, r] = await Promise.all([viaSender, viaRpc]);
  if (!s && !r) throw new Error(`${label}: transaction was not accepted by ${sender ? "Helius Sender or " : ""}the RPC`);
}

export const DEFAULT_SEND_OPTS = { skipPreflight: true, preflightCommitment: "confirmed", maxRetries: 0 };

/**
 * Broadcast already-signed bytes, rebroadcast the SAME bytes every
 * txRebroadcastMs until confirmed or the blockhash expires, and return the
 * confirmation status value ({ err } — the caller decides what err means).
 * Identical bytes = same signature, so a rebroadcast can never double-execute.
 * Throws on expiry ("block height exceeded") or a confirm transport error.
 *
 * `sender` false (a tx with no Sender tip, e.g. a Jupiter-built tx or one
 * too large for the tip) sends and rebroadcasts through the RPC only.
 */
export async function sendAndConfirmSigned(connection, {
  wire, signature, blockhash, lastValidBlockHeight, label, sender = heliusSenderEnabled(), sendOpts = DEFAULT_SEND_OPTS,
}) {
  await broadcastSigned(connection, wire, sendOpts, label, { sender });
  const rebroadcastMs = config.management.txRebroadcastMs ?? 2_000;
  const rebroadcast = setInterval(() => {
    (sender
      ? sendViaHeliusSender(wire, label)
      : connection.sendRawTransaction(wire, sendOpts)
    ).catch(() => { /* best-effort; confirm decides */ });
  }, rebroadcastMs);
  try {
    return (await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed")).value;
  } finally {
    clearInterval(rebroadcast);
    // Deploy, close, claim and the swap/v1 fallback all send here: drop the
    // 20s wallet-balance cache so post-action reads come from chain.
    invalidateWalletBalances();
  }
}

// ─── Priority fee pricing ───────────────────────────────────────

/**
 * Base CU price (µL/CU) before escalation and cap: the Helius estimate (or
 * the configured fallback), never below the floor. At the 10k Helius
 * "recommended" level live deploy creates expired 3× in a row, while txs at
 * 50k landed in ~1s.
 */
export function basePriorityPrice(estimated) {
  const floor = config.management.minPriorityFeeMicroLamports ?? 50_000;
  return Math.max(estimated || (config.management.fallbackPriorityFeeMicroLamports || 50_000), floor);
}

/**
 * Cap a CU price so price × cuLimit never exceeds maxPriorityFeeLamports.
 * Returns { microLamports, capped, maxMicroLamports }.
 */
export function cappedPriorityPrice({ microLamports, cuLimit }) {
  const maxFeeLamports = config.management.maxPriorityFeeLamports ?? 1_000_000; // 0.001 SOL
  const limit = cuLimit || MAX_CU_LIMIT;
  const maxMicroLamports = Math.floor((maxFeeLamports * 1_000_000) / limit);
  return {
    microLamports: Math.min(microLamports, maxMicroLamports),
    capped: microLamports > maxMicroLamports,
    maxMicroLamports,
  };
}
