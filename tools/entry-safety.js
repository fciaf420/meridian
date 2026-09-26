/**
 * Entry-safety guards: checks that decide whether a pool/token may be entered.
 *
 * Everything here is read-only. The pure evaluators take already-fetched data
 * (mint facts, lbPair state, oracle) so they are unit-testable without RPC; the
 * few async helpers only read accounts. Thresholds come from
 * config.entryFilters (user-config.json keys, see config.js).
 *
 * Token guards (Token-2022 extensions + authorities) and the Jupiter scam flag
 * (blockJupiterSuspicious) apply in screening, in the token lookup card and as
 * a hard check in deployPosition.
 */

import { config } from "../config.js";
import { log } from "../logger.js";

export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Token-2022 mint extension type ids (spl-token ExtensionType). */
export const EXT = {
  TransferFeeConfig: 1,
  MintCloseAuthority: 3,
  ConfidentialTransferMint: 4,
  DefaultAccountState: 6,
  NonTransferable: 9,
  InterestBearingConfig: 10,
  PermanentDelegate: 12,
  TransferHook: 14,
  MetadataPointer: 18,
  TokenMetadata: 19,
  GroupPointer: 20,
  TokenGroup: 21,
  GroupMemberPointer: 22,
  TokenGroupMember: 23,
  ScaledUiAmountConfig: 25,
  PausableConfig: 26,
};
const EXT_NAME = Object.fromEntries(Object.entries(EXT).map(([k, v]) => [v, k[0].toLowerCase() + k.slice(1)]));

/** The entry-filter keys (user-config.json) with their safe defaults. */
export const ENTRY_FILTER_DEFAULTS = Object.freeze({
  blockTransferFeeAbovePct: 1.0, // null = no transfer-fee limit
  blockTransferHook: true,
  blockPermanentDelegate: true,
  blockFreezeAuthority: true,
  blockMintAuthority: false,
  blockPausable: true,
  blockNonTransferable: true,
  solFeePoolsOnly: false,
  twapSpikeMaxPct: 15, // null = off
  twapWindowMinutes: 60,
  // Jupiter Tokens API: block audit.isSus (present = flagged) or banned tokens.
  // A failed lookup / unknown token is allowed with a warning.
  blockJupiterSuspicious: false,
});

export const TOKEN_GUARD_BOOL_KEYS = [
  "blockTransferHook",
  "blockPermanentDelegate",
  "blockFreezeAuthority",
  "blockMintAuthority",
  "blockPausable",
  "blockNonTransferable",
];

const ZERO_KEY = "11111111111111111111111111111111";
const b58 = (pk) => {
  if (pk == null) return null;
  const s = typeof pk === "string" ? pk : pk.toBase58?.() ?? String(pk);
  return s && s !== ZERO_KEY ? s : null;
};

export function currentEntryFilters() {
  return { ...ENTRY_FILTER_DEFAULTS, ...(config.entryFilters || {}) };
}

/* ============================== mint facts ============================== */

function programName(owner) {
  const o = b58(owner);
  if (o === TOKEN_PROGRAM_ID) return "spl-token";
  if (o === TOKEN_2022_PROGRAM_ID) return "token-2022";
  return "unknown";
}

function emptyFacts(mint, program, source) {
  return {
    mint: mint ?? null,
    program,
    source,
    complete: true, // false = extensions not known (API-only facts for a Token-2022 mint)
    decimals: null,
    mintAuthority: null,
    freezeAuthority: null,
    extensions: [],
    transferFee: null,
    transferHook: null,
    permanentDelegate: null,
    defaultAccountStateFrozen: false,
    pausable: null,
    nonTransferable: false,
  };
}

function feeInfo(olderBps, newerBps, newerEpoch) {
  const older = Number(olderBps) || 0;
  const newer = Number(newerBps) || 0;
  const maxBps = Math.max(older, newer);
  return { olderBps: older, newerBps: newer, newerEpoch: newerEpoch ?? null, maxBps, pct: maxBps / 100 };
}

/** Parse Token-2022 mint TLV data (the bytes after the account-type byte). */
export function parseToken2022Tlv(tlv) {
  const out = {};
  if (!tlv || !tlv.length) return out;
  const buf = Buffer.from(tlv);
  let i = 0;
  while (i + 4 <= buf.length) {
    const type = buf.readUInt16LE(i);
    const len = buf.readUInt16LE(i + 2);
    if (type === 0) break; // uninitialized padding
    const v = buf.subarray(i + 4, i + 4 + len);
    i += 4 + len;
    const key = (off) => (v.length >= off + 32 ? b58(bs58encode(v.subarray(off, off + 32))) : null);
    switch (type) {
      case EXT.TransferFeeConfig:
        // authority(32) withdraw(32) withheld u64 | older{epoch u64, max u64, bps u16} | newer{...}
        if (v.length >= 108) {
          out.transferFee = feeInfo(v.readUInt16LE(88), v.readUInt16LE(106), Number(v.readBigUInt64LE(90)));
        } else out.transferFee = feeInfo(0, 0, null);
        break;
      case EXT.DefaultAccountState:
        out.defaultAccountStateFrozen = v[0] === 2; // AccountState::Frozen
        break;
      case EXT.NonTransferable:
        out.nonTransferable = true;
        break;
      case EXT.PermanentDelegate:
        out.permanentDelegate = key(0);
        break;
      case EXT.TransferHook:
        out.transferHook = { authority: key(0), programId: key(32) };
        break;
      case EXT.PausableConfig:
        out.pausable = { authority: key(0), paused: v.length > 32 ? v[32] === 1 : false };
        break;
      default:
        break;
    }
    (out.extensions ||= []).push(EXT_NAME[type] || `extension${type}`);
  }
  return out;
}

// Minimal base58 encoder (avoids a hard bs58 dep in the pure path).
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let s = "";
  while (n > 0n) { s = B58_ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s || "1";
}

/**
 * Mint facts from the DLMM SDK's TokenReserve (pool.tokenX): `mint` is the
 * unpacked spl-token Mint (with tlvData), `owner` the token program. Zero RPC.
 */
export function mintFactsFromSdkReserve(reserve) {
  const m = reserve?.mint;
  const f = emptyFacts(b58(m?.address ?? reserve?.publicKey), programName(reserve?.owner), "sdk");
  if (!m) return { ...f, complete: false };
  f.decimals = m.decimals ?? null;
  f.mintAuthority = b58(m.mintAuthority);
  f.freezeAuthority = b58(m.freezeAuthority);
  if (f.program === "token-2022") Object.assign(f, parseToken2022Tlv(m.tlvData));
  f.extensions ||= [];
  return f;
}

/** Mint facts from getParsedAccountInfo(...).value (jsonParsed). */
export function mintFactsFromParsed(value, mint = null) {
  const program = value?.data?.program === "spl-token-2022" ? "token-2022"
    : value?.data?.program === "spl-token" ? "spl-token"
      : programName(value?.owner);
  const f = emptyFacts(mint, program, "rpc");
  const info = value?.data?.parsed?.info;
  if (!info) return { ...f, complete: false };
  f.decimals = info.decimals ?? null;
  f.mintAuthority = b58(info.mintAuthority);
  f.freezeAuthority = b58(info.freezeAuthority);
  for (const e of info.extensions || []) {
    const st = e.state || {};
    f.extensions.push(e.extension);
    switch (e.extension) {
      case "transferFeeConfig":
        f.transferFee = feeInfo(st.olderTransferFee?.transferFeeBasisPoints, st.newerTransferFee?.transferFeeBasisPoints, st.newerTransferFee?.epoch);
        break;
      case "transferHook":
        f.transferHook = { authority: b58(st.authority), programId: b58(st.programId) };
        break;
      case "permanentDelegate":
        f.permanentDelegate = b58(st.delegate);
        break;
      case "defaultAccountState":
        f.defaultAccountStateFrozen = String(st.accountState).toLowerCase() === "frozen";
        break;
      case "nonTransferable":
        f.nonTransferable = true;
        break;
      case "pausableConfig":
      case "pausable":
        f.pausable = { authority: b58(st.authority), paused: !!st.paused };
        break;
      default:
        break;
    }
  }
  return f;
}

/**
 * Mint facts from the pool-discovery API's token_x (TokenMetrics):
 * token_program, has_freeze_authority, has_mint_authority. Complete only for
 * the legacy SPL Token program (no extensions possible); Token-2022 needs a
 * mint read for its extensions.
 */
export function mintFactsFromApi(t, mint = null) {
  if (!t || (t.token_program == null && t.has_freeze_authority == null && t.has_mint_authority == null)) return null;
  const program = programName(t.token_program);
  const f = emptyFacts(mint ?? t.address ?? t.mint ?? null, program, "api");
  f.freezeAuthority = t.has_freeze_authority ? "(set)" : null;
  f.mintAuthority = t.has_mint_authority ? "(set)" : null;
  f.complete = program === "spl-token";
  return f;
}

/** Batch-read mints (jsonParsed) with one getMultipleParsedAccounts per 100. */
export async function fetchMintFacts(connection, mints) {
  const { PublicKey } = await import("@solana/web3.js");
  const out = new Map();
  const list = [...new Set(mints.filter(Boolean))];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const res = await connection.getMultipleParsedAccounts(chunk.map((m) => new PublicKey(m)));
    (res?.value || []).forEach((v, k) => {
      if (v) out.set(chunk[k], mintFactsFromParsed(v, chunk[k]));
    });
  }
  return out;
}

/* ============================== evaluation ============================== */

const fmtPct = (v) => `${Number(v).toFixed(2).replace(/\.?0+$/, "") || "0"}%`;

/**
 * Evaluate the token guards. Returns { pass, reasons, checks, unknown }.
 *   checks: [{ key, pass: true|false|null, off?, text }] for the ✅/❌ lines.
 *   reasons: the exact refusal reasons (failed, enabled guards).
 *   unknown: true when extensions could not be checked (incomplete facts).
 */
export function evaluateTokenGuards(facts, filters = currentEntryFilters()) {
  const f = { ...ENTRY_FILTER_DEFAULTS, ...(filters || {}) };
  const checks = [];
  const reasons = [];
  const unknownExt = !facts || facts.complete === false;
  const t22 = facts?.program === "token-2022";

  const add = (key, enabled, bad, textBad, textOk, reason, needsExt = true) => {
    if ((needsExt ? unknownExt : !facts) && !bad) {
      checks.push({ key, pass: null, off: !enabled, text: `${textOk.split(":")[0]}: unknown (mint not read)${enabled ? "" : " — guard off"}` });
      return;
    }
    if (!enabled) {
      checks.push({ key, pass: bad ? null : true, off: true, text: `${bad ? textBad : textOk} — guard off` });
      return;
    }
    checks.push({ key, pass: !bad, text: bad ? textBad : textOk });
    if (bad) reasons.push(reason);
  };

  checks.push({
    key: "program",
    pass: facts?.program && facts.program !== "unknown" ? true : null,
    text: `Program: ${facts?.program ?? "unknown"}${t22 && facts?.extensions?.length ? ` (${facts.extensions.join(", ")})` : ""}`,
  });

  // Transfer fee
  const tf = facts?.transferFee;
  const feeLimit = f.blockTransferFeeAbovePct;
  const feeBad = tf != null && feeLimit != null && tf.pct > Number(feeLimit);
  const feeText = tf
    ? `Transfer fee: ${fmtPct(tf.olderBps / 100)}${tf.newerBps !== tf.olderBps ? ` → ${fmtPct(tf.newerBps / 100)} from epoch ${tf.newerEpoch}` : ""}`
    : "Transfer fee: none";
  add("transfer_fee", feeLimit != null, feeBad,
    `${feeText} (limit ${fmtPct(feeLimit ?? 0)})`,
    `${feeText}${feeLimit != null ? ` (limit ${fmtPct(feeLimit)})` : ""}`,
    `Token-2022 transfer fee ${fmtPct(tf?.pct ?? 0)} is above the ${fmtPct(feeLimit ?? 0)} limit (blockTransferFeeAbovePct)`);

  const hook = facts?.transferHook;
  const hookBad = !!hook && !!(hook.programId || hook.authority);
  add("transfer_hook", f.blockTransferHook, hookBad,
    `Transfer hook: ${hook?.programId ? `program ${short(hook.programId)}` : `authority ${short(hook?.authority)} can set one`}`,
    "Transfer hook: none",
    `Token-2022 transfer hook ${hook?.programId ? `(program ${hook.programId})` : "(hook authority set)"} (blockTransferHook)`);

  add("permanent_delegate", f.blockPermanentDelegate, !!facts?.permanentDelegate,
    `Permanent delegate: ${short(facts?.permanentDelegate)}`,
    "Permanent delegate: none",
    `Token-2022 permanent delegate ${facts?.permanentDelegate} can move any holder's tokens (blockPermanentDelegate)`);

  const frozenDefault = !!facts?.defaultAccountStateFrozen;
  const freezeBad = !!facts?.freezeAuthority || frozenDefault;
  add("freeze_authority", f.blockFreezeAuthority, freezeBad,
    `Freeze authority: ${frozenDefault ? "new accounts frozen by default" : `set (${short(facts?.freezeAuthority)})`}`,
    "Freeze authority: none",
    frozenDefault
      ? "Token-2022 default account state is FROZEN (blockFreezeAuthority)"
      : `Mint has a freeze authority ${facts?.freezeAuthority} (blockFreezeAuthority)`,
    false);

  add("mint_authority", f.blockMintAuthority, !!facts?.mintAuthority,
    `Mint authority: not renounced (${short(facts?.mintAuthority)})`,
    "Mint authority: renounced",
    `Mint authority is not renounced (${facts?.mintAuthority}) (blockMintAuthority)`,
    false);

  const pz = facts?.pausable;
  const pauseBad = !!pz && (pz.paused || !!pz.authority);
  add("pausable", f.blockPausable, pauseBad,
    `Pausable: ${pz?.paused ? "PAUSED" : `authority ${short(pz?.authority)} can pause transfers`}`,
    "Pausable: no",
    `Token-2022 pausable${pz?.paused ? " (currently PAUSED)" : ""} (blockPausable)`);

  add("non_transferable", f.blockNonTransferable, !!facts?.nonTransferable,
    "Non-transferable: yes",
    "Non-transferable: no",
    "Token-2022 non-transferable mint (blockNonTransferable)");

  return { pass: reasons.length === 0, reasons, checks, unknown: unknownExt };
}

function short(a) {
  if (!a) return "?";
  const s = String(a);
  return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

const num = (v) => {
  if (v == null) return null;
  const n = typeof v === "object" && typeof v.toNumber === "function" ? Number(v.toString()) : Number(v);
  return Number.isFinite(n) ? n : null;
};

/* ============================== fee mode ============================== */

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
const FEE_MODE_LABEL = {
  OnlyY: "fees in SOL (OnlyY)",
  InputOnly: "fees in the input token (InputOnly: sellers pay in the token)",
  unknown: "fee mode unknown",
};

/**
 * CollectFeeMode from on-chain state: lbPair.parameters.collectFeeMode
 * (SDK 1.9.14 enum CollectFeeMode { InputOnly = 0, OnlyY = 1 }). `solFees` is
 * true only for OnlyY with wrapped SOL as token Y.
 */
export function feeModeFromLbPair(lbPair) {
  const raw = num(lbPair?.parameters?.collectFeeMode);
  const mode = raw === 1 ? "OnlyY" : raw === 0 ? "InputOnly" : "unknown";
  const tokenY = b58(lbPair?.tokenYMint);
  const solFees = mode === "OnlyY" && tokenY === WSOL_MINT;
  return { mode, solFees, source: "chain", label: FEE_MODE_LABEL[mode] };
}

/** Pool-discovery API dlmm_params.collect_fee_mode: "quote" = OnlyY, "both" = InputOnly. */
export function feeModeFromApi(value, quoteMint = WSOL_MINT) {
  const v = value == null ? null : String(value).toLowerCase();
  const mode = v === "quote" || v === "only_y" || v === "onlyy" ? "OnlyY" : v === "both" || v === "input_only" || v === "inputonly" ? "InputOnly" : "unknown";
  return { mode, solFees: mode === "OnlyY" && quoteMint === WSOL_MINT, source: "api", label: FEE_MODE_LABEL[mode] };
}

/** Short tag for candidate cards. */
export function feeModeTag(fm) {
  if (!fm || fm.mode === "unknown") return "fees ?";
  return fm.solFees ? "fees SOL" : fm.mode === "OnlyY" ? "fees Y" : "fees token";
}

/* ============================== TWAP ============================== */

/**
 * Price deviation from the on-chain oracle TWAP over the last `windowMinutes`.
 * The TWAP is geometric (it averages bin ids): devPct = (1 + binStep/1e4)^(active − twapBin) − 1.
 * `oracle` is pool.getOracle() (SDK IDynamicOracle); getActiveIdByTime returns
 * null when the oracle's samples don't cover the window → known: false.
 */
export async function computeTwapDeviation({ oracle, activeId = null, binStep, nowSec = Math.floor(Date.now() / 1000), windowMinutes = 60 }) {
  const BN = (await import("bn.js")).default;
  const windowSec = Math.max(60, Math.round(Number(windowMinutes) * 60));
  const out = { known: false, windowMinutes: windowSec / 60, twapBin: null, activeId: null, devBins: null, devPct: null, coveredMinutes: null };
  if (!oracle) return { ...out, note: "oracle unavailable" };
  try {
    const cov = oracle.getMaxDuration?.(new BN(nowSec));
    if (cov != null) out.coveredMinutes = Math.floor(Number(cov.toString()) / 60);
  } catch { /* informational */ }
  const res = oracle.getActiveIdByTime(new BN(nowSec - windowSec), new BN(nowSec));
  // getOracle() decodes a fresh lbPair and keeps its activeId on the wrapper.
  const active = num(oracle.currentActiveBinId) ?? num(activeId);
  if (!res || active == null || !(binStep > 0)) {
    return { ...out, note: `oracle covers ${out.coveredMinutes ?? "?"} min of the ${out.windowMinutes}-min window` };
  }
  const twapBin = num(res.value);
  const devBins = active - twapBin;
  const devPct = (Math.pow(1 + binStep / 10_000, devBins) - 1) * 100;
  return { ...out, known: true, twapBin, activeId: active, devBins, devPct: Math.round(devPct * 100) / 100 };
}

/**
 * TWAP spike guard: refuse a bid_ask entry when price is more than
 * twapSpikeMaxPct above the TWAP. Unknown TWAP (window not covered) allows with a note.
 */
export function evaluateTwapGuard(twap, { maxPct = 15, strategy = "bid_ask" } = {}) {
  if (maxPct == null) return { pass: true, note: "TWAP spike guard off" };
  if (strategy !== "bid_ask") return { pass: true, note: `TWAP spike guard applies to bid_ask only (strategy ${strategy})` };
  if (!twap?.known) return { pass: true, unknown: true, note: `TWAP unknown (${twap?.note ?? "no data"}) — allowed` };
  if (twap.devPct > Number(maxPct)) {
    return {
      pass: false,
      reason: `price is ${fmtSigned(twap.devPct)}% vs the ${twap.windowMinutes}-min on-chain TWAP (${twap.devBins > 0 ? "+" : ""}${twap.devBins} bins), above the ${maxPct}% limit (twapSpikeMaxPct)`,
    };
  }
  return { pass: true, note: `price ${fmtSigned(twap.devPct)}% vs ${twap.windowMinutes}-min TWAP (limit ${maxPct}%)` };
}

const fmtSigned = (v) => `${v >= 0 ? "+" : ""}${Number(v).toFixed(1)}`;

/** pool.getOracle() + computeTwapDeviation, never throwing (errors → unknown). */
export async function readTwap(pool, { windowMinutes = 60, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  try {
    const oracle = await pool.getOracle();
    return await computeTwapDeviation({ oracle, activeId: pool?.lbPair?.activeId, binStep: num(pool?.lbPair?.binStep), nowSec, windowMinutes });
  } catch (e) {
    return { known: false, windowMinutes, note: `oracle read failed: ${e.message}` };
  }
}

/* ============================== pool status ============================== */

/**
 * Pool status guard (always on). Refuses when the pair is Disabled, its
 * activation point is still in the future (checked against the clock directly:
 * the SDK's isSwapDisabled only checks activation for Permissioned and
 * CustomizablePermissionless pairs, and live pools are PermissionlessV2), the
 * SDK reports swaps disabled, or the Meteora API flags the pool as blacklisted.
 *   lbPair: pool.lbPair; clock: pool.clock ({ slot, unixTimestamp });
 *   nowSec: wall clock (the later of it and clock.unixTimestamp is used);
 *   apiBlacklisted: true | false | null (unknown → allowed with a note).
 * Returns { pass, reasons, notes, text }.
 */
export function evaluatePoolStatus({ lbPair, clock = null, nowSec = Math.floor(Date.now() / 1000), apiBlacklisted = null, swapDisabled = false } = {}) {
  const reasons = [];
  const notes = [];
  if (!lbPair) return { pass: false, reasons: ["pool state unavailable"], notes, text: "unknown (pool not read)" };
  const status = num(lbPair.status);
  if (status !== 0) reasons.push(`pair status is ${status === 1 ? "Disabled" : `unknown (${status})`}`);
  const point = num(lbPair.activationPoint) ?? 0;
  const bySlot = num(lbPair.activationType) === 0;
  let activationText = "active";
  if (point > 0) {
    if (bySlot) {
      const slot = num(clock?.slot);
      if (slot == null) reasons.push(`activation slot ${point} can't be checked (no clock)`);
      else if (point > slot) {
        reasons.push(`activation slot ${point} is in the future (current slot ${slot})`);
        activationText = `activates at slot ${point} (now ${slot})`;
      }
    } else {
      const now = Math.max(nowSec, num(clock?.unixTimestamp) ?? 0);
      if (point > now) {
        const mins = Math.ceil((point - now) / 60);
        reasons.push(`activation time ${new Date(point * 1000).toISOString()} is in the future (in ${mins} min)`);
        activationText = `activates in ${mins} min`;
      }
    }
  }
  if (swapDisabled && status === 0 && !reasons.length) reasons.push("SDK reports swaps disabled for this pair");
  if (apiBlacklisted === true) reasons.push("Meteora API flags the pool as blacklisted");
  else if (apiBlacklisted == null) notes.push("Meteora blacklist flag unknown (API unavailable)");
  const text = reasons.length ? `⛔ ${reasons.join("; ")}` : `enabled · ${activationText}${apiBlacklisted === false ? " · not blacklisted" : ""}`;
  return { pass: reasons.length === 0, reasons, notes, text };
}

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";

/** The pool-discovery row for one pool (is_blacklisted, collect_fee_mode, token_x…), or null. */
export async function fetchPoolApiRow(poolAddress, { timeoutMs = 5000 } = {}) {
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return (data?.data || [])[0] || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Entry state of a loaded DLMM pool for display (lookup / confirm cards) and
 * the re-center shadow log. Read-only.
 */
export async function describePoolEntryState(pool, { apiBlacklisted = null, nowSec = Math.floor(Date.now() / 1000), strategy = "bid_ask", filters = currentEntryFilters(), twap: withTwap = true } = {}) {
  const status = evaluatePoolStatus({ lbPair: pool?.lbPair, clock: pool?.clock, nowSec, apiBlacklisted });
  const feeMode = feeModeFromLbPair(pool?.lbPair);
  const twap = withTwap && typeof pool?.getOracle === "function"
    ? await readTwap(pool, { windowMinutes: filters.twapWindowMinutes ?? 60, nowSec })
    : null;
  const twapGuard = evaluateTwapGuard(twap, { maxPct: filters.twapSpikeMaxPct, strategy });
  return { status, feeMode, twap, twapGuard };
}

let _stateConn = null;
/** DLMM.create + describePoolEntryState for one pool address. */
export async function readPoolEntryState(poolAddress, opts = {}) {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const { default: DLMM } = await import("@meteora-ag/dlmm");
  if (!_stateConn) _stateConn = new Connection(process.env.RPC_URL, "confirmed");
  const pool = await DLMM.create(_stateConn, new PublicKey(poolAddress));
  return describePoolEntryState(pool, opts);
}

let _apiRowFetcher = (poolAddress) => fetchPoolApiRow(poolAddress);
/** Test hook: replace the pool-discovery row fetcher used by deploy checks. */
export function _setApiRowFetcherForTest(fn) { _apiRowFetcher = fn || ((a) => fetchPoolApiRow(a)); }

/* ============================== Jupiter scam flag ============================== */

/**
 * Jupiter Tokens API lookup for many mints: Map<mint, info> (unknown mints
 * absent) or null when the lookup failed. Replaceable for tests.
 */
async function defaultJupiterLookup(mints) {
  const { getTokensInfo } = await import("./jup-tokens.js");
  return getTokensInfo(mints);
}
let _jupiterLookup = defaultJupiterLookup;
/** Test hook: replace the Jupiter Tokens lookup used by screening and deploy checks. */
export function _setJupiterLookupForTest(fn) { _jupiterLookup = fn || defaultJupiterLookup; }
/** The current Jupiter lookup (mints → Map | null); used by the token lookup card too. */
export function jupiterLookup(mints) { return _jupiterLookup(mints); }

/** The informational Jupiter fields carried on candidates (no gating on these). */
export function jupiterSummary(info) {
  if (!info) return null;
  return {
    organic_score: info.organic_score != null ? Math.round(info.organic_score * 10) / 10 : null,
    verified: info.is_verified ?? null,
    sus: !!info.is_sus,
    banned: !!info.banned,
  };
}

/**
 * blockJupiterSuspicious: block when Jupiter flags the token (audit.isSus
 * present) or lists it as banned. `info` undefined/null = unknown token or a
 * failed lookup → allowed (never block on an API outage).
 * Returns { pass, reason, check: { key, pass, off?, text }, unknown }.
 */
export function evaluateJupiterGuard(info, filters = currentEntryFilters()) {
  const f = { ...ENTRY_FILTER_DEFAULTS, ...(filters || {}) };
  const enabled = !!f.blockJupiterSuspicious;
  if (!info) {
    return { pass: true, reason: null, unknown: true, check: { key: "jupiter_flag", pass: null, off: !enabled, text: `Jupiter scam flag: unknown (lookup failed or token unknown)${enabled ? " — allowed" : " — guard off"}` } };
  }
  const flags = [];
  if (info.is_sus || info.sus) flags.push("suspicious (audit.isSus)");
  if (info.banned) flags.push("banned");
  const bad = flags.length > 0;
  const text = bad ? `Jupiter scam flag: ${flags.join(" + ")}` : "Jupiter scam flag: none";
  if (!enabled) return { pass: true, reason: null, unknown: false, check: { key: "jupiter_flag", pass: bad ? null : true, off: true, text: `${text} — guard off` } };
  return {
    pass: !bad,
    reason: bad ? `Jupiter flags the token as ${flags.join(" + ")} (blockJupiterSuspicious)` : null,
    unknown: false,
    check: { key: "jupiter_flag", pass: !bad, text },
  };
}

/**
 * Screening step: one batched Jupiter lookup, tag every candidate with
 * `jupiter` (organic score / verified, informational), and drop flagged tokens
 * when blockJupiterSuspicious is on. A failed lookup keeps everything.
 */
export async function screenJupiterFlags(pools, { filters = currentEntryFilters(), jupiterLookup = _jupiterLookup } = {}) {
  const f = { ...ENTRY_FILTER_DEFAULTS, ...(filters || {}) };
  const mints = pools.map((p) => p.base?.mint ?? p.base_mint).filter(Boolean);
  let infos = null;
  if (mints.length) {
    try {
      infos = await jupiterLookup(mints);
    } catch (e) {
      log("screening_warn", `Jupiter token lookup threw: ${e.message}`);
    }
    if (!infos) log("screening_warn", `Jupiter token lookup failed (${mints.length} mints): scam-flag filter skipped, candidates allowed`);
  }
  const kept = [];
  const dropped = [];
  for (const p of pools) {
    const mint = p.base?.mint ?? p.base_mint;
    const info = infos?.get(mint) ?? null;
    const tagged = { ...p, jupiter: jupiterSummary(info) };
    const r = evaluateJupiterGuard(info, f);
    if (!r.pass) {
      dropped.push({ pool: p.pool, name: p.name, reasons: [r.reason] });
      log("screening", `Entry filter dropped ${p.name ?? p.pool}: ${r.reason}`);
      continue;
    }
    kept.push(tagged);
  }
  return { kept, dropped };
}

/* ============================== screening ============================== */

let _screenConn = null;
async function defaultReadMints(mints) {
  const { Connection } = await import("@solana/web3.js");
  if (!_screenConn) _screenConn = new Connection(process.env.RPC_URL, "confirmed");
  return fetchMintFacts(_screenConn, mints);
}

/**
 * Apply the token guards to screening candidates. Uses the pool-discovery
 * API's token_program / has_freeze_authority / has_mint_authority when present
 * (no RPC); Token-2022 or unknown mints are read in ONE batched
 * getMultipleParsedAccounts. A failed read keeps the candidate, tagged
 * `token_safety.unknown` (deployPosition re-checks from the pool's own mint).
 * Returns { kept, dropped: [{ pool, name, reasons }] }.
 */
export async function screenTokenGuards(pools, { filters = currentEntryFilters(), readMints = defaultReadMints } = {}) {
  const need = [];
  const pre = pools.map((p) => {
    const mint = p.base?.mint ?? null;
    const api = mintFactsFromApi(p.base_token ?? p.base, mint);
    if (!api || !api.complete) need.push(mint);
    return { p, mint, api };
  });
  let read = new Map();
  const toRead = need.filter(Boolean);
  if (toRead.length) {
    try {
      read = (await readMints(toRead)) || new Map();
    } catch (e) {
      log("screening_warn", `Token guard mint read failed (${toRead.length} mints): ${e.message}`);
    }
  }
  const kept = [];
  const dropped = [];
  for (const { p, mint, api } of pre) {
    const facts = read.get(mint) || api || null;
    // API authority flags stay authoritative when the mint read is missing.
    const r = evaluateTokenGuards(facts, filters);
    const tagged = { ...p, token_safety: { pass: r.pass, unknown: r.unknown, reasons: r.reasons, program: facts?.program ?? null, transfer_fee_pct: facts?.transferFee?.pct ?? null } };
    if (!r.pass) {
      dropped.push({ pool: p.pool, name: p.name, reasons: r.reasons });
      log("screening", `Entry filter dropped ${p.name ?? p.pool}: ${r.reasons.join("; ")}`);
      continue;
    }
    kept.push(tagged);
  }
  return { kept, dropped };
}

/* ============================== deploy ============================== */

/**
 * Hard token check for deployPosition, from the pool's own TokenReserve (the
 * SDK already read the mint at DLMM.create, so this adds no RPC).
 * Returns { pass, reason, facts, checks }.
 */
export function deployTokenCheck(pool, filters = currentEntryFilters()) {
  const facts = mintFactsFromSdkReserve(pool?.tokenX);
  if (!facts || facts.program === "unknown") {
    return { pass: false, reason: `Token safety: could not identify the base token's program (${facts?.program ?? "no mint data"}); refusing to deploy.`, facts, checks: [] };
  }
  const r = evaluateTokenGuards(facts, filters);
  if (r.unknown) {
    return { pass: false, reason: "Token safety: base mint data missing from the pool state; refusing to deploy.", facts, checks: r.checks };
  }
  return { pass: r.pass, reason: r.pass ? null : `Token safety: ${r.reasons.join("; ")}`, facts, checks: r.checks };
}

/**
 * All screening-time entry filters, in one place. Returns { kept, dropped }.
 * (Pool-level filters are added alongside the token guards.)
 */
export async function screenEntryCandidates(pools, opts = {}) {
  const dropped = [];
  const live = [];
  for (const p of pools) {
    if (p.is_blacklisted === true) {
      dropped.push({ pool: p.pool, name: p.name, reasons: ["Meteora API flags the pool as blacklisted"] });
      log("screening", `Entry filter dropped ${p.name ?? p.pool}: Meteora API flags the pool as blacklisted`);
      continue;
    }
    live.push(p);
  }
  // Token-age window (config.screening.min/maxTokenAgeHours), every source.
  // Unknown age is kept and tagged token_age_unknown; deployPosition re-checks.
  const { screenTokenAge } = await import("./token-age.js");
  const age = await screenTokenAge(live, opts.tokenAge || {});
  dropped.push(...age.dropped);
  // Fee mode from the API row; solFeePoolsOnly drops known non-SOL-fee pools
  // (unknown mode is kept and tagged — deployPosition checks on-chain).
  const filters = { ...ENTRY_FILTER_DEFAULTS, ...(opts.filters || currentEntryFilters()) };
  const feeOk = [];
  for (const p of age.kept) {
    const fm = p.fee_mode?.mode ? p.fee_mode : feeModeFromApi(p.collect_fee_mode, p.quote?.mint ?? WSOL_MINT);
    const tagged = { ...p, fee_mode: fm };
    if (filters.solFeePoolsOnly && fm.mode !== "unknown" && !fm.solFees) {
      dropped.push({ pool: p.pool, name: p.name, reasons: [`fees not paid in SOL (CollectFeeMode ${fm.mode}) (solFeePoolsOnly)`] });
      log("screening", `Entry filter dropped ${p.name ?? p.pool}: fee mode ${fm.mode} (solFeePoolsOnly)`);
      continue;
    }
    feeOk.push(tagged);
  }
  const tok = await screenTokenGuards(feeOk, opts);
  const jup = await screenJupiterFlags(tok.kept, { filters, ...(opts.jupiterLookup ? { jupiterLookup: opts.jupiterLookup } : {}) });
  return { kept: jup.kept, dropped: [...dropped, ...tok.dropped, ...jup.dropped] };
}

/**
 * Every deploy-time hard check, run by deployPosition after the pool is loaded
 * and before any swap or transaction. Returns { pass, reason, notes, token }.
 */
export async function runDeployEntryChecks({
  pool,
  pool_address = null,
  wallet = null,
  strategy = "bid_ask",
  filters = currentEntryFilters(),
  apiRow = undefined, // injectable; undefined = fetch the pool-discovery row
  nowSec = Math.floor(Date.now() / 1000),
  jupiterLookup = _jupiterLookup, // injectable Jupiter Tokens lookup (mints → Map | null)
} = {}) {
  const notes = [];
  const token = deployTokenCheck(pool, filters);
  if (!token.pass) return { pass: false, reason: token.reason, notes, token };
  if (token.facts?.transferFee) notes.push(`transfer fee ${token.facts.transferFee.pct}% (limit ${filters.blockTransferFeeAbovePct ?? "off"})`);

  // Jupiter scam flag (blockJupiterSuspicious). A failed lookup or an unknown
  // token is allowed with a warning: never block a deploy on an API outage.
  let jupiter = null;
  if ({ ...ENTRY_FILTER_DEFAULTS, ...(filters || {}) }.blockJupiterSuspicious) {
    const mint = token.facts?.mint ?? b58(pool?.lbPair?.tokenXMint);
    let infos;
    try { infos = mint ? await jupiterLookup([mint]) : null; } catch { infos = null; }
    const info = infos?.get(mint) ?? null;
    jupiter = jupiterSummary(info);
    const jg = evaluateJupiterGuard(info, filters);
    if (!jg.pass) return { pass: false, reason: `Token safety: ${jg.reason}`, notes, token, jupiter };
    if (!infos) {
      log("deploy_warn", `Jupiter scam-flag check skipped for ${mint ?? "unknown mint"}: Tokens API lookup failed; allowing deploy`);
      notes.push("Jupiter scam flag: lookup failed — allowed");
    } else if (!info) {
      log("deploy_warn", `Jupiter scam-flag check: ${mint} unknown to the Tokens API; allowing deploy`);
      notes.push("Jupiter scam flag: token unknown to Jupiter — allowed");
    }
  }

  // Pool status (always on).
  const row = apiRow !== undefined ? apiRow : (pool_address ? await _apiRowFetcher(pool_address) : null);
  let swapDisabled = false;
  try { swapDisabled = wallet && typeof pool?.isSwapDisabled === "function" ? !!pool.isSwapDisabled(wallet) : false; } catch { /* informational */ }
  const status = evaluatePoolStatus({
    lbPair: pool?.lbPair,
    clock: pool?.clock,
    nowSec,
    apiBlacklisted: row ? !!row.is_blacklisted : null,
    swapDisabled,
  });
  notes.push(...status.notes);
  if (!status.pass) return { pass: false, reason: `Pool status: ${status.reasons.join("; ")}`, notes, token, status };

  // SOL-fee-only pools (solFeePoolsOnly).
  const feeMode = feeModeFromLbPair(pool?.lbPair);
  if (filters.solFeePoolsOnly && !feeMode.solFees) {
    return { pass: false, reason: `Fee mode: pool pays LP fees ${feeMode.mode === "unknown" ? "in an unknown mode" : `in the input token (CollectFeeMode ${feeMode.mode})`}, not SOL (solFeePoolsOnly)`, notes, token, status, feeMode };
  }
  notes.push(feeMode.label);

  // TWAP spike guard (bid_ask only; unknown TWAP allows with a note).
  let twap = null;
  if (filters.twapSpikeMaxPct != null && strategy === "bid_ask") {
    twap = await readTwap(pool, { windowMinutes: filters.twapWindowMinutes ?? 60, nowSec });
  }
  const tg = evaluateTwapGuard(twap, { maxPct: filters.twapSpikeMaxPct, strategy });
  if (!tg.pass) return { pass: false, reason: `TWAP spike: ${tg.reason}`, notes, token, status, feeMode, twap };
  if (tg.note) notes.push(tg.note);

  return { pass: true, reason: null, notes, token, status, feeMode, twap, jupiter };
}

/* ============================== changes ============================== */

export const ENTRY_FILTER_KEYS = Object.keys(ENTRY_FILTER_DEFAULTS);
const BOOL_KEYS = new Set([...TOKEN_GUARD_BOOL_KEYS, "solFeePoolsOnly", "blockJupiterSuspicious"]);
const NULLABLE_PCT_KEYS = { blockTransferFeeAbovePct: [0, 100], twapSpikeMaxPct: [0, 1000] };

/** Normalize a requested value ("off"/"null" → null, "true"/"false" → bool, numeric strings → number). */
export function normalizeEntryFilterValue(key, value) {
  let v = value;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "off" || t === "null" || t === "none") v = null;
    else if (t === "true" || t === "on") v = true;
    else if (t === "false") v = false;
    else if (/^-?\d+(\.\d+)?$/.test(t)) v = Number(t);
  }
  if (BOOL_KEYS.has(key)) {
    if (typeof v !== "boolean") return { error: `${key} must be true or false` };
    return { value: v };
  }
  if (key in NULLABLE_PCT_KEYS) {
    if (v === null) return { value: null };
    const [lo, hi] = NULLABLE_PCT_KEYS[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) return { error: `${key} must be null (off) or a number in [${lo}, ${hi}]` };
    return { value: v };
  }
  if (key === "twapWindowMinutes") {
    if (!Number.isInteger(v) || v < 5 || v > 1440) return { error: "twapWindowMinutes must be an integer in [5, 1440]" };
    return { value: v };
  }
  return { error: `${key} is not an entry filter` };
}

/**
 * Does changing `key` from `before` to `after` loosen an entry guard?
 * Booleans: true → false loosens. Nullable % limits: raising the limit or
 * turning it off (null) loosens. twapWindowMinutes has no clear direction, so
 * any change counts as user-only.
 */
export function isLooseningChange(key, before, after) {
  if (BOOL_KEYS.has(key)) return before === true && after === false;
  if (key in NULLABLE_PCT_KEYS) {
    if (after === before) return false;
    if (after === null) return true;
    if (before === null || before === undefined) return false;
    return Number(after) > Number(before);
  }
  if (key === "twapWindowMinutes") return after !== before;
  return false;
}

/**
 * The LLM's update_config may TIGHTEN entry filters but never loosen them.
 * Returns { ok: true, value } or { ok: false, reason }.
 */
export function checkAgentEntryFilterChange(key, value, current = currentEntryFilters()) {
  const n = normalizeEntryFilterValue(key, value);
  if (n.error) return { ok: false, reason: `update_config rejected: ${n.error}.` };
  const before = current[key];
  if (isLooseningChange(key, before, n.value)) {
    return {
      ok: false,
      reason: `update_config refused: ${key} ${JSON.stringify(before)} → ${JSON.stringify(n.value)} would loosen an entry-safety guard. Only the user can loosen entry filters (Telegram ⚙️ Settings → 🛡 Entry filters, or user-config.json).`,
    };
  }
  return { ok: true, value: n.value };
}

/**
 * User-initiated change (Telegram toggle): validate, apply to the running
 * config immediately and persist through persistUserConfig (the update_config
 * write path). Loosening is allowed here — this is the user. Logs every change.
 * Returns { ok, key, before, after, text } or { ok: false, error }.
 */
export async function applyEntryFilterChange(key, value, { source = "telegram" } = {}) {
  const { persistUserConfig } = await import("../config.js");
  const n = normalizeEntryFilterValue(key, value);
  if (n.error) return { ok: false, error: n.error };
  config.entryFilters ||= { ...ENTRY_FILTER_DEFAULTS };
  const before = config.entryFilters[key];
  try {
    persistUserConfig({ [key]: n.value });
  } catch (e) {
    log("config_error", `Entry filter ${key} not saved (${source}): ${e.message}`);
    return { ok: false, error: `could not save user-config.json: ${e.message}` };
  }
  config.entryFilters[key] = n.value;
  const loosened = isLooseningChange(key, before, n.value);
  log("config", `Entry filter ${key}: ${JSON.stringify(before)} → ${JSON.stringify(n.value)} (${source}${loosened ? ", loosened by user" : ""})`);
  return { ok: true, key, before, after: n.value, loosened, text: `${key}: ${fmtFilterValue(key, before)} → ${fmtFilterValue(key, n.value)}` };
}

export function fmtFilterValue(key, v) {
  if (BOOL_KEYS.has(key)) return key === "solFeePoolsOnly" ? (v ? "on" : "off") : (v ? "block" : "allow");
  if (v == null) return "off";
  return key === "twapWindowMinutes" ? `${v} min` : `${v}%`;
}
