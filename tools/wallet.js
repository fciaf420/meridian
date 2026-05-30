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
const JUPITER_ULTRA_API = "https://api.jup.ag/ultra/v1";
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
 * Swap tokens via Jupiter Ultra API (order → sign → execute).
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

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}) {
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
    const wallet = getWallet();
    const connection = getConnection();

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

    // ─── Get Ultra order (unsigned tx + requestId) ─────────────
    const orderUrl =
      `${JUPITER_ULTRA_API}/order` +
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
        log("swap", `Ultra failed for ${input_mint}, falling back to regular swap API`);
        return await swapViaQuoteApi({ wallet, connection, input_mint, output_mint, amountStr, decimals, outDecimals });
      }
      throw new Error(`Ultra order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      log("swap", `Ultra error for ${input_mint}, falling back to regular swap API`);
      return await swapViaQuoteApi({ wallet, connection, input_mint, output_mint, amountStr, decimals, outDecimals });
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await jupiterFetch(`${JUPITER_ULTRA_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": JUPITER_API_KEY,
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Ultra execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      in_ui: toUi(result.inputAmountResult, decimals),
      out_ui: toUi(result.outputAmountResult, outDecimals),
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}

async function swapViaQuoteApi({ wallet, connection, input_mint, output_mint, amountStr, decimals = 9, outDecimals = 9 }) {
  // ─── Get quote ─────────────────────────────────────────────
  const quoteRes = await jupiterFetch(
    `${JUPITER_QUOTE_API}/quote?inputMint=${input_mint}&outputMint=${output_mint}&amount=${amountStr}&slippageBps=300`,
    { headers: { "x-api-key": JUPITER_API_KEY } }
  );
  if (!quoteRes.ok) throw new Error(`Quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
  const quote = await quoteRes.json();
  if (quote.error) throw new Error(`Quote error: ${quote.error}`);

  // ─── Get swap tx ───────────────────────────────────────────
  const swapRes = await jupiterFetch(`${JUPITER_QUOTE_API}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": JUPITER_API_KEY },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true,
    }),
  });
  if (!swapRes.ok) throw new Error(`Swap tx failed: ${swapRes.status} ${await swapRes.text()}`);
  const { swapTransaction } = await swapRes.json();

  // ─── Sign and send ─────────────────────────────────────────
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([wallet]);
  const txHash = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await connection.confirmTransaction(txHash, "confirmed");

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
