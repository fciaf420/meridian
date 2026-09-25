/**
 * Entry-safety guards: checks that decide whether a pool/token may be entered.
 *
 * Everything here is read-only. The pure evaluators take already-fetched data
 * (mint facts, lbPair state, oracle) so they are unit-testable without RPC; the
 * few async helpers only read accounts. Thresholds come from
 * config.entryFilters (user-config.json keys, see config.js).
 *
 * Token guards (Token-2022 extensions + authorities) apply in screening,
 * in the token lookup card and as a hard check in deployPosition.
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

/* ============================== pool status ============================== */

const num = (v) => {
  if (v == null) return null;
  const n = typeof v === "object" && typeof v.toNumber === "function" ? Number(v.toString()) : Number(v);
  return Number.isFinite(n) ? n : null;
};

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
export async function describePoolEntryState(pool, { apiBlacklisted = null, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const status = evaluatePoolStatus({ lbPair: pool?.lbPair, clock: pool?.clock, nowSec, apiBlacklisted });
  return { status };
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
  const tok = await screenTokenGuards(live, opts);
  return { kept: tok.kept, dropped: [...dropped, ...tok.dropped] };
}

/**
 * Every deploy-time hard check, run by deployPosition after the pool is loaded
 * and before any swap or transaction. Returns { pass, reason, notes, token }.
 */
export async function runDeployEntryChecks({
  pool,
  pool_address = null,
  wallet = null,
  filters = currentEntryFilters(),
  apiRow = undefined, // injectable; undefined = fetch the pool-discovery row
  nowSec = Math.floor(Date.now() / 1000),
} = {}) {
  const notes = [];
  const token = deployTokenCheck(pool, filters);
  if (!token.pass) return { pass: false, reason: token.reason, notes, token };
  if (token.facts?.transferFee) notes.push(`transfer fee ${token.facts.transferFee.pct}% (limit ${filters.blockTransferFeeAbovePct ?? "off"})`);

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

  return { pass: true, reason: null, notes, token, status };
}
