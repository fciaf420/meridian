import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";
import { basePriorityPrice, cappedPriorityPrice, sendAndConfirmSigned, MAX_CU_LIMIT } from "./tx-send.js";
import { getTokensInfo } from "./jup-tokens.js";
import { countRpc, instrumentConnection } from "./rpc-stats.js";
import { WALLET_BALANCES_TTL_MS, walletCacheState, invalidateWalletBalances } from "./wallet-cache.js";

export { invalidateWalletBalances };

let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) _connection = instrumentConnection(new Connection(process.env.RPC_URL, "confirmed"));
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const JUPITER_QUOTE_API = "https://api.jup.ag/swap/v1";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";

if (!JUPITER_API_KEY) {
  log(
    "wallet_warning",
    "JUPITER_API_KEY not set in .env — Jupiter calls will run without an API key (rate limits may apply)."
  );
}

/**
 * Fetch wrapper for Jupiter HTTP calls with an AbortController timeout and a
 * small bounded retry. Retries only on network errors and HTTP 429/5xx; does
 * NOT retry other 4xx responses. Returns a standard Response object so the call
 * sites keep their existing return shapes.
 */
async function jupiterFetch(url, options = {}, { timeoutMs = 15000, maxRetries = 2 } = {}) {
  const backoffs = [500, 1500];
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      // Retry only on 429 or 5xx; return other responses (incl. other 4xx) as-is.
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, backoffs[attempt] ?? 1500));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      // Network error / abort — retry if attempts remain.
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, backoffs[attempt] ?? 1500));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

// ─── Wallet balances (RPC + Jupiter; no Helius Wallet API) ─────
// The Helius Wallet API costs 100 credits per call and was ~97% of the plan's
// spend (the positions scan called it every 30–60s just for the SOL price).
// Balances now come from 3 RPC calls (getBalance + parsed token accounts for
// Token and Token-2022), prices from Jupiter Price v3 and symbols from
// Jupiter Tokens v2. USE_HELIUS_WALLET_API=true restores the old source.
//
// BALANCE_RPC_URL (optional) routes ONLY these balance reads to a separate RPC
// (e.g. Flux). Everything else — position scans, sends, simulations, on-chain
// PnL, close-swap balance reads — stays on RPC_URL. It must serve
// getTokenAccountsByOwner (PublicNode's free endpoint refuses it).

const TOKEN_PROGRAM_IDS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
];
const PRICE_BATCH = 50; // Jupiter Price v3 max ids per request
export const SOL_PRICE_TTL_MS = 60_000;
const BALANCE_RPC_TIMEOUT_MS = 5_000;
const BALANCE_RPC_WARN_INTERVAL_MS = 3_600_000;

let _balanceConnection = null;
let _balanceRpcWarnAt = 0;
let _solPrice = null; // { at, price }
let _solPriceInflight = null;
const _symbols = new Map(); // mint -> symbol | null (null = Jupiter doesn't know it)
let _testDeps = null;

/**
 * Test seam: { connection, balanceConnection, owner, balanceRpcTimeoutMs }
 * replace the main RPC connection, the BALANCE_RPC_URL connection, the wallet
 * address and the balance-RPC timeout. Also clears every balance/price/symbol
 * cache. Pass null to restore.
 */
export function _setWalletTestDeps(deps) {
  _testDeps = deps;
  _solPrice = null;
  _solPriceInflight = null;
  _symbols.clear();
  _balanceRpcWarnAt = 0;
  invalidateWalletBalances();
}

function rpcHost(url) {
  try { return new URL(url).hostname; } catch { return "(invalid url)"; }
}

/** Connection for balance reads from BALANCE_RPC_URL, or null when unset. */
function getBalanceConnection() {
  if (_testDeps) return _testDeps.balanceConnection ?? null;
  const url = process.env.BALANCE_RPC_URL;
  if (!url) return null;
  if (!_balanceConnection) _balanceConnection = instrumentConnection(new Connection(url, "confirmed"));
  return _balanceConnection;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** SOL lamports + per-mint token totals (Token + Token-2022) from one RPC. */
async function readHoldings(connection, owner) {
  const [lamports, ...tokenResults] = await Promise.all([
    connection.getBalance(owner, "confirmed"),
    ...TOKEN_PROGRAM_IDS.map((programId) =>
      connection.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(programId) }, "confirmed")),
  ]);
  if (lamports == null || !Number.isFinite(Number(lamports))) throw new Error("getBalance returned no value");
  const byMint = new Map(); // mint -> { raw: bigint, decimals }
  for (const res of tokenResults) {
    if (!res || !Array.isArray(res.value)) throw new Error("getParsedTokenAccountsByOwner returned no value");
    for (const { account } of res.value) {
      const info = account?.data?.parsed?.info;
      const amt = info?.tokenAmount;
      if (!info?.mint || amt?.amount == null || !/^\d+$/.test(String(amt.amount))) continue;
      const cur = byMint.get(info.mint) ?? { raw: 0n, decimals: Number.isInteger(amt.decimals) ? amt.decimals : 0 };
      cur.raw += BigInt(amt.amount);
      byMint.set(info.mint, cur);
    }
  }
  return { lamports: Number(lamports), byMint };
}

/**
 * Holdings via BALANCE_RPC_URL when set; on error or ~5s timeout, retried once
 * on the main RPC (logged at most once per hour, hostname only).
 */
async function readHoldingsRouted(owner) {
  const balanceConn = getBalanceConnection();
  const mainConn = _testDeps?.connection ?? getConnection();
  if (!balanceConn) return readHoldings(mainConn, owner);
  try {
    const timeoutMs = _testDeps?.balanceRpcTimeoutMs ?? BALANCE_RPC_TIMEOUT_MS;
    return await withTimeout(readHoldings(balanceConn, owner), timeoutMs, "balance RPC");
  } catch (e) {
    const now = Date.now();
    if (now - _balanceRpcWarnAt >= BALANCE_RPC_WARN_INTERVAL_MS) {
      _balanceRpcWarnAt = now;
      const host = _testDeps ? "test" : rpcHost(process.env.BALANCE_RPC_URL);
      log("wallet_warn", `Balance RPC ${host} failed (${e.message}); retrying on the main RPC (logged at most hourly)`);
    }
    return readHoldings(mainConn, owner);
  }
}

/** USD prices from Jupiter Price v3, batched. Missing/failed mints are absent. */
async function fetchJupiterPrices(mints) {
  const out = new Map();
  const ids = [...new Set(mints.filter(Boolean))];
  for (let i = 0; i < ids.length; i += PRICE_BATCH) {
    const chunk = ids.slice(i, i + PRICE_BATCH);
    try {
      const res = await jupiterFetch(`${JUPITER_PRICE_API}?ids=${chunk.join(",")}`, {
        headers: { "x-api-key": JUPITER_API_KEY },
      }, { timeoutMs: 5000, maxRetries: 1 });
      if (!res.ok) {
        log("wallet_warn", `Jupiter price request failed: HTTP ${res.status}`);
        continue;
      }
      const body = await res.json();
      for (const m of chunk) {
        const p = Number(body?.[m]?.usdPrice);
        if (Number.isFinite(p) && p > 0) out.set(m, p);
      }
    } catch (e) {
      log("wallet_warn", `Jupiter price request failed: ${e.message}`);
    }
  }
  if (out.has(SOL_MINT)) _solPrice = { at: Date.now(), price: out.get(SOL_MINT) };
  return out;
}

/**
 * SOL/USD from Jupiter Price v3, cached 60s (concurrent callers share one
 * request). On failure returns the last known price, or 0 if there is none.
 */
export async function getSolPrice() {
  if (_solPrice && Date.now() - _solPrice.at < SOL_PRICE_TTL_MS) return _solPrice.price;
  if (_solPriceInflight) return _solPriceInflight;
  const p = fetchJupiterPrices([SOL_MINT])
    .then((prices) => prices.get(SOL_MINT) ?? _solPrice?.price ?? 0)
    .finally(() => { if (_solPriceInflight === p) _solPriceInflight = null; });
  _solPriceInflight = p;
  return p;
}

/** Best-effort symbols from Jupiter Tokens v2 (cached for the process). */
async function resolveSymbols(mints) {
  const need = mints.filter((m) => !_symbols.has(m));
  if (need.length) {
    try {
      const info = await getTokensInfo(need);
      if (info) for (const m of need) _symbols.set(m, info.get(m)?.symbol || null);
    } catch { /* fall back to mint prefix */ }
  }
  return (m) => _symbols.get(m) || m.slice(0, 8);
}

const round2 = (n) => Math.round(n * 100) / 100;

async function readWalletBalances(walletAddress) {
  const { lamports, byMint } = await readHoldingsRouted(new PublicKey(walletAddress));
  const held = [...byMint.entries()].filter(([, v]) => v.raw > 0n);
  const mints = held.map(([m]) => m);
  const [prices, symbolOf] = await Promise.all([
    fetchJupiterPrices([SOL_MINT, ...mints]),
    resolveSymbols(mints),
  ]);

  const solPrice = prices.get(SOL_MINT) ?? _solPrice?.price ?? 0;
  const sol = lamports / LAMPORTS_PER_SOL;
  const solUsd = sol * solPrice;
  // Native SOL first, as the Helius Wallet API listed it (consumers skip it).
  const tokens = [{ mint: SOL_MINT, symbol: "SOL", balance: sol, usd: solPrice > 0 ? round2(solUsd) : null }];
  let totalUsd = solUsd;
  let usdc = 0;
  for (const [mint, { raw, decimals }] of held) {
    const balance = Number(raw) / 10 ** decimals;
    const price = prices.get(mint);
    const usd = price != null ? balance * price : null;
    if (usd != null) totalUsd += usd;
    if (mint === config.tokens.USDC) usdc = balance;
    tokens.push({
      mint,
      symbol: mint === SOL_MINT ? "WSOL" : symbolOf(mint),
      balance,
      usd: usd == null ? null : round2(usd),
    });
  }

  return {
    wallet: walletAddress,
    sol: Math.round(sol * 1e6) / 1e6,
    sol_price: round2(solPrice),
    sol_usd: round2(solUsd),
    usdc: round2(usdc),
    tokens,
    total_usd: round2(totalUsd),
  };
}

/** Legacy source (opt-in via USE_HELIUS_WALLET_API=true): 100 credits/call. */
async function readHeliusWalletBalances(walletAddress) {
  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) throw new Error("Helius API key missing");
  countRpc("helius:wallet_balances");
  const res = await fetch(`https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`);
  if (!res.ok) throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const balances = data.balances || [];
  const solEntry = balances.find((b) => b.mint === config.tokens.SOL || b.symbol === "SOL");
  const usdcEntry = balances.find((b) => b.mint === config.tokens.USDC || b.symbol === "USDC");
  if (solEntry?.pricePerToken > 0) _solPrice = { at: Date.now(), price: solEntry.pricePerToken };
  return {
    wallet: walletAddress,
    sol: Math.round((solEntry?.balance || 0) * 1e6) / 1e6,
    sol_price: round2(solEntry?.pricePerToken || 0),
    sol_usd: round2(solEntry?.usdValue || 0),
    usdc: round2(usdcEntry?.balance || 0),
    tokens: balances.map((b) => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? round2(b.usdValue) : null,
    })),
    total_usd: round2(data.totalUsdValue || 0),
  };
}

const emptyBalances = (wallet, error) => ({ wallet, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error });

/**
 * Wallet balances: { wallet, sol, sol_price, sol_usd, usdc,
 * tokens: [{ mint, symbol, balance, usd }], total_usd } or the same shape with
 * `error` on failure. Cached for WALLET_BALANCES_TTL_MS (20s); every send
 * invalidates the cache (tx-send.js, swapToken). Pass { fresh: true } to skip
 * the cache when the read feeds a decision about moving funds.
 */
export async function getWalletBalances(opts) {
  const fresh = opts?.fresh === true;
  let walletAddress;
  try {
    walletAddress = _testDeps?.owner ?? getWallet().publicKey.toString();
  } catch {
    return emptyBalances(null, "Wallet not configured");
  }

  const c = walletCacheState();
  if (!fresh && c.entry && Date.now() - c.entry.at < WALLET_BALANCES_TTL_MS) return structuredClone(c.entry.value);
  if (!fresh && c.inflight) return c.inflight.then((v) => structuredClone(v));

  const gen = c.generation;
  const useHelius = process.env.USE_HELIUS_WALLET_API === "true";
  const p = (useHelius ? readHeliusWalletBalances(walletAddress) : readWalletBalances(walletAddress))
    .then((value) => {
      // Don't cache a read that raced a send (it may predate the send).
      if (c.generation === gen) c.entry = { at: Date.now(), value };
      return value;
    })
    .catch((error) => {
      log("wallet_error", error.message);
      return emptyBalances(walletAddress, error.message);
    })
    .finally(() => { if (c.inflight === p) c.inflight = null; });
  if (!fresh) c.inflight = p;
  return p.then((v) => structuredClone(v));
}

/**
 * On-chain balance of one mint for the wallet, read straight from RPC at
 * `confirmed` (not the Helius indexed balances API, which lags behind txs that
 * just confirmed). Sums every token account the owner holds for the mint. The
 * `mint` filter makes the RPC resolve the mint's own program, so Token and
 * Token-2022 accounts are both covered.
 *
 * Returns { raw: bigint, decimals: number|null, accounts }. decimals is null
 * only when the owner has no account for the mint (raw is then 0n). Throws when
 * the read fails or an account is unparseable, so callers can treat the balance
 * as unknown instead of zero.
 *
 * @param {string} mint
 * @param {object} [deps] Test seam only: { connection, owner }.
 */
export async function getOnchainTokenBalance(mint, deps = {}) {
  const connection = deps.connection ?? getConnection();
  const owner = deps.owner ?? getWallet().publicKey;
  const res = await connection.getParsedTokenAccountsByOwner(
    owner,
    { mint: new PublicKey(mint) },
    { commitment: "confirmed" },
  );
  if (!res || !Array.isArray(res.value)) throw new Error(`getParsedTokenAccountsByOwner returned no value for ${mint}`);
  let raw = 0n;
  let decimals = null;
  for (const { account } of res.value) {
    const amt = account?.data?.parsed?.info?.tokenAmount;
    if (amt?.amount == null || !/^\d+$/.test(String(amt.amount))) {
      throw new Error(`Unparseable token account for ${mint}`);
    }
    raw += BigInt(amt.amount);
    if (decimals == null && Number.isInteger(amt.decimals)) decimals = amt.decimals;
  }
  return { raw, decimals, accounts: res.value.length };
}

/**
 * Best-effort USD price for one mint from Jupiter Price v3. Returns null when
 * the token has no price or the request fails; never throws.
 */
export async function getTokenUsdPrice(mint) {
  try {
    const res = await jupiterFetch(`${JUPITER_PRICE_API}?ids=${mint}`, {
      headers: { "x-api-key": JUPITER_API_KEY },
    }, { timeoutMs: 5000, maxRetries: 0 });
    if (!res.ok) return null;
    const body = await res.json();
    const price = Number(body?.[mint]?.usdPrice);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/**
 * Swap tokens via Jupiter Swap v2 (order → sign → execute), with the swap/v1
 * quote+swap API as a fallback that is only used before anything is signed.
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Decimal-safe UI→raw integer conversion. Avoids JS float precision loss
 * (e.g. 0.1 * 1e9) by working on the decimal string directly: split on '.',
 * pad/truncate the fractional part to `decimals`, concatenate, and parse as a
 * BigInt. Returns the raw integer amount as a string (suitable for Jupiter).
 */
export function uiToRawAmount(amount, decimals) {
  const dec = Number(decimals);
  if (!Number.isInteger(dec) || dec < 0) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
  // Normalize to a plain decimal string (handles numbers and numeric strings).
  let s = typeof amount === "string" ? amount.trim() : String(amount);
  if (s === "" || isNaN(Number(s))) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  let [intPart, fracPart = ""] = s.split(".");
  intPart = intPart || "0";
  // Truncate fractional digits beyond `decimals` (matches prior Math.floor).
  fracPart = fracPart.slice(0, dec);
  // Right-pad fractional digits up to `decimals`.
  fracPart = fracPart.padEnd(dec, "0");
  const rawStr = `${intPart}${fracPart}`;
  // BigInt strips leading zeros and validates the integer string.
  const raw = BigInt(rawStr === "" ? "0" : rawStr);
  return ((negative && raw !== 0n ? -raw : raw)).toString();
}

/**
 * Price impact of a Swap v2 /order response, in percent (0.12 = 0.12%).
 * Prefers `priceImpact` (number, already percent); falls back to the deprecated
 * `priceImpactPct` (string decimal fraction, e.g. "-0.0012") × 100. Returns
 * null when neither is a finite number. Sign is preserved; callers take abs.
 */
export function parsePriceImpactPercent(order) {
  const direct = order?.priceImpact;
  if (direct != null && direct !== "" && Number.isFinite(Number(direct))) return Number(direct);
  const frac = order?.priceImpactPct;
  if (frac != null && frac !== "" && Number.isFinite(Number(frac))) return Number(frac) * 100;
  return null;
}

export const DEFAULT_MAX_SWAP_PRICE_IMPACT_PCT = 5;
export const DEFAULT_MAX_CLOSE_SWAP_PRICE_IMPACT_PCT = 25;

/**
 * Price-impact caps, in percent. "default" (maxSwapPriceImpactPct, 5) covers
 * agent swap_token calls, the deploy auto-swap and USDC-mode entry. "close"
 * (maxCloseSwapPriceImpactPct, 25) covers post-close swap-backs, where leaving
 * the withdrawn bag is worse than the slippage. The kind is chosen by code
 * callers through swapToken's second (deps) argument, never by tool args.
 */
const IMPACT_CAPS = {
  default: { key: "maxSwapPriceImpactPct", fallback: DEFAULT_MAX_SWAP_PRICE_IMPACT_PCT },
  close: { key: "maxCloseSwapPriceImpactPct", fallback: DEFAULT_MAX_CLOSE_SWAP_PRICE_IMPACT_PCT },
};

/** Effective cap for `kind` from config.risk, or its default when unset/invalid. */
export function priceImpactCap(kind = "default") {
  const c = IMPACT_CAPS[kind] ?? IMPACT_CAPS.default;
  const v = Number(config.risk?.[c.key]);
  return { key: c.key, cap: Number.isFinite(v) && v > 0 ? v : c.fallback };
}

/** Back-compat: the default cap in percent. */
export function maxSwapPriceImpactPct() {
  return priceImpactCap("default").cap;
}

/**
 * Refusal result when |impactPct| exceeds the cap of `kind`, else null. An
 * unknown impact (null) is allowed and logged: the field is undocumented on
 * Swap v2, and blocking every swap if Jupiter dropped it would strand exits.
 */
export function checkPriceImpact(impactPct, { input_mint, output_mint, kind = "default" } = {}) {
  const { key, cap } = priceImpactCap(kind);
  if (impactPct == null) {
    log("swap", `Price impact unknown for ${input_mint} → ${output_mint}; the ${cap}% ${key} cap could not be checked`);
    return null;
  }
  const abs = Math.abs(impactPct);
  if (abs <= cap) return null;
  const error = `Swap refused: price impact ${abs.toFixed(2)}% exceeds ${key} ${cap}%`;
  log("swap", `${error} (${input_mint} → ${output_mint})`);
  return { success: false, price_impact_refused: true, price_impact_pct: Math.round(abs * 100) / 100, max_price_impact_pct: cap, price_impact_cap_key: key, input_mint, output_mint, error };
}

/** Documented Swap v2 /execute `code` values. */
export const EXECUTE_CODES = {
  0: "Success",
  [-1]: "Missing cached order (requestId not found or expired)",
  [-2]: "Invalid signed transaction",
  [-3]: "Invalid message bytes",
  [-1000]: "Aggregator: failed to land",
  [-1001]: "Aggregator: unknown error",
  [-1002]: "Aggregator: invalid transaction",
  [-1003]: "Aggregator: transaction not fully signed",
  [-1004]: "Aggregator: invalid block height",
  [-2000]: "RFQ: failed to land",
  [-2001]: "RFQ: unknown error",
  [-2002]: "RFQ: invalid payload",
  [-2003]: "RFQ: quote expired",
  [-2004]: "RFQ: swap rejected",
};

// Codes where Jupiter rejected the tx before sending it. Only these (and only
// with no signature in the response) make the swap/v1 fallback safe.
const PRE_LANDING_CODES = new Set([-1, -2, -3, -1002, -1003, -1004, -2002, -2003, -2004]);

/**
 * Classify a Swap v2 /execute result. Pure; no I/O.
 *  - "success":     status "Success" with a signature on a 2xx.
 *  - "ambiguous":   transport error, HTTP 5xx, any signature without a 2xx
 *                   "Success", or a code other than the pre-send rejections
 *                   (failed to land, unknown, undocumented). The tx may have
 *                   landed: check on-chain, never fall back.
 *  - "pre_landing": documented pre-send rejection code and no signature.
 *                   Safe to fall back.
 *  - "failed":      non-5xx response with no code and no signature (e.g. a
 *                   plain 4xx). No fallback.
 */
export function classifyExecuteResponse({ httpStatus, body, transportError }) {
  if (transportError) {
    return { kind: "ambiguous", reason: `transport error: ${transportError.message}`, signature: null };
  }
  const signature = typeof body?.signature === "string" && body.signature ? body.signature : null;
  const code = body?.code != null && Number.isFinite(Number(body.code)) ? Number(body.code) : null;
  const meaning = code != null ? (EXECUTE_CODES[code] ?? "undocumented code") : "no code";
  const desc = `HTTP ${httpStatus ?? "?"}, status=${body?.status ?? "?"}, code=${code ?? "-"} (${meaning})`;

  if (httpStatus >= 500) return { kind: "ambiguous", reason: desc, signature, code };
  if (body?.status === "Success") {
    const ok2xx = httpStatus >= 200 && httpStatus < 300;
    return { kind: ok2xx && signature ? "success" : "ambiguous", reason: desc, signature, code };
  }
  if (signature) return { kind: "ambiguous", reason: desc, signature, code };
  if (code != null && PRE_LANDING_CODES.has(code)) return { kind: "pre_landing", reason: desc, signature: null, code };
  // Any other code (failed to land, unknown error, undocumented) means Jupiter
  // may have sent the tx: check the locally known signature on-chain.
  if (code != null) return { kind: "ambiguous", reason: desc, signature: null, code };
  return { kind: "failed", reason: desc, signature: null, code };
}

/** Base58 tx id of a signed VersionedTransaction, or null if unsigned. */
function firstSignature(tx) {
  const sig = tx?.signatures?.[0];
  if (!sig || sig.every((b) => b === 0)) return null;
  return bs58.encode(sig);
}

/**
 * Poll getSignatureStatuses until the tx is confirmed/finalized, has errored,
 * or attempts run out. RPC errors count as "not found yet".
 */
async function checkSignatureOnChain(connection, signature, { attempts = 15, intervalMs = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const st = value?.[0];
      if (st?.err) return { landed: true, ok: false, err: st.err };
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        return { landed: true, ok: true };
      }
    } catch (e) {
      log("swap", `Signature status check failed (${e.message})`);
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { landed: false };
}

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

/**
 * @param {object} params
 * @param {object} [deps] { impactCap: "close" } selects the post-close
 *   price-impact cap (code callers only; executeTool never passes deps).
 *   Test seam: { connection, wallet, statusPollMs, statusPollAttempts }.
 */
export async function swapToken({
  input_mint,
  output_mint,
  amount,
}, deps = {}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    const wallet = deps.wallet ?? getWallet();
    const connection = deps.connection ?? getConnection();

    // ─── Gas-buffer safety net (central, can't-bypass) ─────────
    // NEVER let a SOL-out swap drain the wallet below the gas reserve. This is a
    // hard floor regardless of caller (settle, deploy, manual) so the wallet can
    // always pay for gas. input_mint is already normalized to wrapped-SOL.
    if (input_mint === SOL_MINT) {
      const GAS_FLOOR = config.usdc?.gasReserveSol ?? config.management?.gasReserve ?? 0.05;
      try {
        const solBal = (await connection.getBalance(wallet.publicKey)) / 1e9;
        const maxSwappable = solBal - GAS_FLOOR;
        if (maxSwappable <= 0) {
          log("swap", `Refusing SOL swap: balance ${solBal.toFixed(6)} <= gas reserve ${GAS_FLOOR} SOL`);
          return { success: false, error: `SOL swap refused — would drop below ${GAS_FLOOR} SOL gas reserve (balance ${solBal.toFixed(6)})` };
        }
        if (amount > maxSwappable) {
          log("swap", `Clamping SOL swap ${amount} → ${maxSwappable.toFixed(6)} to preserve ${GAS_FLOOR} SOL gas reserve`);
          amount = maxSwappable;
        }
      } catch (e) {
        log("swap", `Gas-buffer check skipped (${e.message}) — proceeding with requested amount`);
      }
    }

    log("swap", `${amount} of ${input_mint} → ${output_mint}`);

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = uiToRawAmount(amount, decimals);

    // Output decimals — used to normalize the received amount to UI units.
    let outDecimals = 9; // SOL default
    if (output_mint !== config.tokens.SOL) {
      const outInfo = await connection.getParsedAccountInfo(new PublicKey(output_mint));
      outDecimals = outInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const toUi = (raw, dec) => (raw != null && !isNaN(Number(raw)) ? Number(raw) / Math.pow(10, dec) : null);

    // ─── Get Swap v2 order (unsigned tx + requestId) ───────────
    // No slippageBps on purpose: slippage stays with Jupiter's RTSE, as before.
    const orderUrl =
      `${JUPITER_SWAP_V2_API}/order` +
      `?inputMint=${input_mint}` +
      `&outputMint=${output_mint}` +
      `&amount=${amountStr}` +
      `&taker=${wallet.publicKey.toString()}`;

    const orderRes = await jupiterFetch(orderUrl, {
      headers: { "x-api-key": JUPITER_API_KEY },
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      if (orderRes.status === 500) {
        log("swap", `Swap v2 order failed for ${input_mint}, falling back to swap/v1 quote API`);
        return await swapViaQuoteApi({ wallet, connection, input_mint, output_mint, amountStr, decimals, outDecimals, deps });
      }
      throw new Error(`Swap v2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    // transaction is "" when the router quoted but could not build a tx
    // (errorCode/errorMessage set), and null when taker is missing.
    if (!order.transaction || order.errorCode || order.errorMessage) {
      log(
        "swap",
        `Swap v2 order has no transaction for ${input_mint} ` +
          `(router=${order.router ?? "?"} errorCode=${order.errorCode ?? "-"} ${order.errorMessage ?? ""}), ` +
          `falling back to swap/v1 quote API`
      );
      return await swapViaQuoteApi({ wallet, connection, input_mint, output_mint, amountStr, decimals, outDecimals, deps });
    }

    const impact = parsePriceImpactPercent(order);
    log(
      "swap",
      `Swap v2 order: router=${order.router ?? "?"} mode=${order.mode ?? "?"} ` +
        `priceImpact=${impact == null ? "n/a" : `${Math.abs(impact).toFixed(4)}%`}`
    );
    // Nothing is signed yet, so a refusal here can't leave anything in flight.
    // No fallback to swap/v1 either: that would quote the same thin route.
    const impactRefusal = checkPriceImpact(impact, { input_mint, output_mint, kind: deps.impactCap });
    if (impactRefusal) return impactRefusal;

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");
    // The tx id is known before sending, so an ambiguous /execute (no body,
    // no signature) can still be checked on-chain.
    const localSig = firstSignature(tx);

    // ─── Execute ───────────────────────────────────────────────
    // jupiterFetch may resend on 429/5xx/network errors. That resends the SAME
    // signed tx (same signature), so it cannot land twice.
    let execRes = null;
    let result = null;
    let transportError = null;
    try {
      execRes = await jupiterFetch(`${JUPITER_SWAP_V2_API}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": JUPITER_API_KEY,
        },
        body: JSON.stringify({ signedTransaction: signedTx, requestId }),
      });
      const text = await execRes.text();
      try { result = text ? JSON.parse(text) : null; } catch { result = null; }
    } catch (e) {
      transportError = e;
    }

    const outcome = classifyExecuteResponse({ httpStatus: execRes?.status, body: result, transportError });
    const amounts = (r) => ({
      amount_in: r?.inputAmountResult ?? null,
      amount_out: r?.outputAmountResult ?? null,
      in_ui: toUi(r?.inputAmountResult, decimals),
      out_ui: toUi(r?.outputAmountResult, outDecimals),
    });

    if (outcome.kind === "success") {
      log("swap", `SUCCESS tx: ${result.signature}`);
      return { success: true, tx: result.signature, input_mint, output_mint, ...amounts(result) };
    }

    if (outcome.kind === "pre_landing") {
      // Jupiter rejected the tx before sending it and returned no signature:
      // nothing can land, so the swap/v1 route is safe to try.
      log("swap", `Swap v2 execute rejected before landing (${outcome.reason}), falling back to swap/v1 quote API`);
      return await swapViaQuoteApi({ wallet, connection, input_mint, output_mint, amountStr, decimals, outDecimals, deps });
    }

    if (outcome.kind === "failed") {
      throw new Error(`Swap v2 execute failed: ${outcome.reason}`);
    }

    // ─── Ambiguous: the tx may have landed. Never fall back. ──
    const sig = outcome.signature || localSig;
    log("swap", `Swap v2 execute ambiguous (${outcome.reason}); checking signature ${sig ?? "(none)"} on-chain`);
    if (!sig) {
      return {
        success: false,
        ambiguous: true,
        input_mint,
        output_mint,
        error: `Swap v2 execute outcome unknown (${outcome.reason}) and no signature to check — verify wallet balances before retrying`,
      };
    }
    const chain = await checkSignatureOnChain(connection, sig, {
      attempts: deps.statusPollAttempts ?? 15,
      intervalMs: deps.statusPollMs ?? 2000,
    });
    if (chain.landed && chain.ok) {
      log("swap", `SUCCESS (confirmed on-chain after ambiguous execute) tx: ${sig}`);
      return { success: true, tx: sig, input_mint, output_mint, confirmed_via: "rpc", ...amounts(result) };
    }
    if (chain.landed) {
      throw new Error(`Swap failed on-chain (${sig}): ${JSON.stringify(chain.err)}`);
    }
    log("swap_error", `Swap v2 tx ${sig} unconfirmed after execute (${outcome.reason})`);
    return {
      success: false,
      ambiguous: true,
      tx: sig,
      input_mint,
      output_mint,
      error: `Swap v2 execute outcome unknown (${outcome.reason}); tx ${sig} not confirmed yet — it may still land, do not retry until it has expired`,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  } finally {
    // Any live swap attempt may have moved funds: the next balance read must
    // come from chain, not the 20s cache.
    invalidateWalletBalances();
  }
}

async function swapViaQuoteApi({ wallet, connection, input_mint, output_mint, amountStr, decimals = 9, outDecimals = 9, deps = {} }) {
  // ─── Get quote ─────────────────────────────────────────────
  const quoteRes = await jupiterFetch(
    `${JUPITER_QUOTE_API}/quote?inputMint=${input_mint}&outputMint=${output_mint}&amount=${amountStr}&slippageBps=300`,
    { headers: { "x-api-key": JUPITER_API_KEY } }
  );
  if (!quoteRes.ok) throw new Error(`Quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
  const quote = await quoteRes.json();
  if (quote.error) throw new Error(`Quote error: ${quote.error}`);
  // swap/v1 priceImpactPct is a decimal fraction string ("0.0123" = 1.23%).
  const v1Impact = quote.priceImpactPct != null && quote.priceImpactPct !== "" && Number.isFinite(Number(quote.priceImpactPct))
    ? Number(quote.priceImpactPct) * 100
    : null;
  const impactRefusal = checkPriceImpact(v1Impact, { input_mint, output_mint, kind: deps.impactCap });
  if (impactRefusal) return impactRefusal;

  // ─── Get swap tx ───────────────────────────────────────────
  // Same CU price policy as the DLMM send path: the configured floor/fallback
  // (no tx exists yet to ask Helius about), capped so price × the worst-case
  // 1.4M CU stays within maxPriorityFeeLamports. Jupiter sizes the CU limit
  // from its own simulation (dynamicComputeUnitLimit), so the real fee is lower.
  const { microLamports } = cappedPriorityPrice({ microLamports: basePriorityPrice(null), cuLimit: MAX_CU_LIMIT });
  const swapRes = await jupiterFetch(`${JUPITER_QUOTE_API}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": JUPITER_API_KEY },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      computeUnitPriceMicroLamports: microLamports,
    }),
  });
  if (!swapRes.ok) throw new Error(`Swap tx failed: ${swapRes.status} ${await swapRes.text()}`);
  const { swapTransaction, lastValidBlockHeight: swapLvbh } = await swapRes.json();

  // ─── Sign, send with rebroadcast, confirm ──────────────────
  // Sign once; the same bytes are rebroadcast until confirmed or expired.
  // Jupiter's tx carries no Helius Sender tip, so it goes through the RPC only.
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([wallet]);
  const txHash = firstSignature(tx);
  if (!txHash) throw new Error("swap/v1 fallback: transaction has no signature after signing");
  let lastValidBlockHeight = Number(swapLvbh);
  if (!Number.isFinite(lastValidBlockHeight) || lastValidBlockHeight <= 0) {
    lastValidBlockHeight = (await connection.getLatestBlockhash("confirmed")).lastValidBlockHeight;
  }

  let status;
  try {
    status = await sendAndConfirmSigned(connection, {
      wire: tx.serialize(),
      signature: txHash,
      blockhash: tx.message.recentBlockhash,
      lastValidBlockHeight,
      label: "swap v1 fallback",
      sender: false,
    });
  } catch (confirmErr) {
    // Expiry or a confirm transport error. Before reporting, check whether the
    // tx landed anyway — never report failure for a swap that executed.
    const chain = await checkSignatureOnChain(connection, txHash, {
      attempts: deps.statusPollAttempts ?? 3,
      intervalMs: deps.statusPollMs ?? 2000,
    });
    if (!chain.landed) {
      throw new Error(`swap/v1 fallback tx ${txHash} did not confirm: ${confirmErr.message}`, { cause: confirmErr });
    }
    status = { err: chain.ok ? null : chain.err };
  }
  if (status?.err) {
    // Landed but FAILED on-chain: nothing was swapped. Report failure so the
    // caller retries or flags exposure instead of assuming the tokens are sold.
    log("swap_error", `swap/v1 fallback tx ${txHash} failed on-chain: ${JSON.stringify(status.err)}`);
    return {
      success: false,
      tx: txHash,
      input_mint,
      output_mint,
      error: `Swap failed on-chain (${txHash}): ${JSON.stringify(status.err)}`,
    };
  }

  log("swap", `SUCCESS (fallback) tx: ${txHash}`);
  const toUi = (raw, dec) => (raw != null && !isNaN(Number(raw)) ? Number(raw) / Math.pow(10, dec) : null);
  return {
    success: true,
    tx: txHash,
    input_mint,
    output_mint,
    amount_in: quote.inAmount,
    amount_out: quote.outAmount,
    in_ui: toUi(quote.inAmount, decimals),
    out_ui: toUi(quote.outAmount, outDecimals),
  };
}
