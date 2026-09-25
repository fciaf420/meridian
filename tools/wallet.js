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

let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
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

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
export async function getWalletBalances() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("wallet_error", "HELIUS_API_KEY not set in .env");
    return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Helius API key missing" };
  }

  try {
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    const res = await fetch(url);
    
    if (!res.ok) {
      throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const balances = data.balances || [];

    // ─── Find SOL and USDC ────────────────────────────────────
    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    // ─── Map all tokens ───────────────────────────────────────
    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    log("wallet_error", error.message);
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: error.message,
    };
  }
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
 * @param {object} [deps] Test seam only: { connection, wallet, statusPollMs,
 *   statusPollAttempts }. Production callers pass nothing.
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
