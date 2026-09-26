/**
 * Code-level limits on LLM-initiated swap_token calls (executor runSafetyChecks).
 *
 * The agent may only finish a close's own swap-back: sell a base token back to
 * SOL, up to what a recent close of that mint withdrew and left unsold. Rules:
 * - SOL (or wSOL) input is refused: buying tokens is the deploy flow's job.
 *   Deploy's two-sided auto-swap calls wallet.swapToken directly, not through
 *   executeTool, so it never reaches this guard.
 * - Output must be SOL.
 * - The input mint needs a close exposure recorded within
 *   CLOSE_EXPOSURE_WINDOW_MS (state.js close_exposure, written by closePosition
 *   from tools/close-swap.js). Other wallet balances are not the agent's to sell.
 * - Refused while that close's swap (or a previous agent swap against it) is
 *   ambiguous and may still land (AMBIGUOUS_SWAP_WINDOW_MS, about a blockhash's
 *   validity), so nothing can be sold twice.
 * - Sellable = unsold exposure − what the agent already sold against it,
 *   capped by the on-chain balance above the pre-close balance (so a late-landing
 *   swap, or anything sold since, shrinks it). A larger request is clamped.
 *
 * Owner-initiated calls (executeTool manual: true) skip this guard. Code paths
 * that call wallet.swapToken directly (close-swap, deploy auto-swap, USDC mode,
 * state sync) are unaffected. The price-impact cap in wallet.swapToken applies
 * to all of them.
 */
import { normalizeMint, getOnchainTokenBalance, uiToRawAmount } from "./wallet.js";
import { rawToUiString } from "./close-swap.js";
import { findRecentCloseExposure } from "../state.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const CLOSE_EXPOSURE_WINDOW_MS = 2 * 60 * 60 * 1000;
export const AMBIGUOUS_SWAP_WINDOW_MS = 90_000;

/**
 * @param {object} args swap_token args from the LLM
 * @param {object} [deps] Test seam: { findExposure(mint, {now, windowMs}), readBalance(mint), now() }
 * @returns {Promise<{ pass: false, reason: string } | { pass: true, args: object, guard: { position: string, mint: string, sell_raw: string, clamped: boolean, sellable_ui: string } }>}
 */
export async function checkAgentSwap(args, deps = {}) {
  const findExposure = deps.findExposure ?? findRecentCloseExposure;
  const readBalance = deps.readBalance ?? getOnchainTokenBalance;
  const now = (deps.now ?? Date.now)();

  const input = normalizeMint(args?.input_mint);
  const output = normalizeMint(args?.output_mint);
  if (!input || !output) return refuse("swap_token needs input_mint and output_mint.");
  if (input === SOL_MINT) {
    return refuse("swap_token refused: the agent may not buy tokens with SOL. Token buys happen only inside deploy_position.");
  }
  if (output !== SOL_MINT) {
    return refuse("swap_token refused: the agent may only sell a closed position's base token back to SOL (output_mint must be SOL).");
  }

  const exposure = findExposure(input, { now, windowMs: CLOSE_EXPOSURE_WINDOW_MS });
  if (!exposure) {
    return refuse(`swap_token refused: ${input} has no unsold exposure from a close in the last ${CLOSE_EXPOSURE_WINDOW_MS / 3_600_000}h. Wallet balances that no recent close left behind are not the agent's to sell; report them to the owner instead.`);
  }

  const until = exposure.ambiguous_until ? Date.parse(exposure.ambiguous_until) : NaN;
  if (Number.isFinite(until) && now < until) {
    const secs = Math.ceil((until - now) / 1000);
    return refuse(`swap_token refused: an earlier swap of ${input} for this close has an unknown outcome and may still land (~${secs}s left). Selling now could sell twice; check again after it expires.`);
  }

  const decimals = exposure.decimals;
  let sellableRaw = toBig(exposure.unsold_raw) - toBig(exposure.agent_sold_raw);
  if (!Number.isInteger(decimals) || sellableRaw <= 0n) {
    return refuse(`swap_token refused: the close of ${input} left no attributable unsold amount (already sold, or the withdrawal could not be measured). Report it to the owner instead.`);
  }

  // What is really left on-chain from that close: balance above the pre-close balance.
  if (exposure.pre_raw == null) {
    return refuse(`swap_token refused: the pre-close balance of ${input} is unknown, so no amount is attributable to the close.`);
  }
  let bal;
  try {
    bal = await readBalance(input);
  } catch (e) {
    return refuse(`swap_token refused: could not read the on-chain ${input} balance (${e.message}); try again later.`);
  }
  const aboveRaw = bal.raw > toBig(exposure.pre_raw) ? bal.raw - toBig(exposure.pre_raw) : 0n;
  if (aboveRaw < sellableRaw) sellableRaw = aboveRaw;
  if (sellableRaw <= 0n) {
    return refuse(`swap_token refused: the ${input} a recent close left unsold is no longer in the wallet above its pre-close balance (it was sold or a pending swap landed).`);
  }

  let requestedRaw;
  try {
    requestedRaw = BigInt(uiToRawAmount(args.amount, decimals));
  } catch {
    return refuse(`swap_token refused: amount ${JSON.stringify(args?.amount)} is not a valid number.`);
  }
  if (requestedRaw <= 0n) return refuse("swap_token refused: amount must be positive.");

  const clamped = requestedRaw > sellableRaw;
  const sellRaw = clamped ? sellableRaw : requestedRaw;
  const sellableUi = rawToUiString(sellableRaw, decimals);
  return {
    pass: true,
    args: { ...args, input_mint: input, output_mint: SOL_MINT, amount: clamped ? sellableUi : args.amount },
    guard: { position: exposure.position, mint: input, sell_raw: sellRaw.toString(), clamped, sellable_ui: sellableUi },
  };
}

function toBig(v) {
  try { return BigInt(v ?? 0); } catch { return 0n; }
}

function refuse(reason) {
  return { pass: false, reason };
}
