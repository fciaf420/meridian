/**
 * Shared state for the getWalletBalances() result cache (tools/wallet.js).
 * Kept in its own module so the send path (tools/tx-send.js) can invalidate it
 * without importing wallet.js (which imports tx-send.js).
 *
 * `generation` bumps on every invalidation; a read that started before an
 * invalidation must not write its (possibly pre-send) result back.
 */

export const WALLET_BALANCES_TTL_MS = 20_000;

const state = { entry: null, inflight: null, generation: 0 };

export function walletCacheState() {
  return state;
}

/** Drop the cached balances. Call after anything that moves funds. */
export function invalidateWalletBalances() {
  state.entry = null;
  state.inflight = null;
  state.generation++;
}
