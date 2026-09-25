// telegram-ui.js — Telegram menus, inline-button views, two-tap confirmations
// and alerts. Transport and owner-only access control live in telegram.js; every
// update that reaches this module has already passed authorizeUpdate().
//
// Everything this module touches is injected through createTelegramUI(deps), so
// tests run it against a mocked transport and mocked trading functions.
//
// Fund-moving actions (close, deploy, "auto" deploy, run screening cycle) never
// execute on the first tap. They render a confirmation card whose Confirm button
// carries a short nonce; the exact parameters live server-side in the nonce store
// with a TTL, and a nonce is consumed on first use so double taps can't
// double-execute. Execution goes through deps.executeTool (tools/executor.js),
// i.e. the same path the agent's tools use, with every DRY_RUN guard and safety
// check intact.
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { escapeHtml, clipText, CALLBACK_DATA_MAX_BYTES } from "./telegram.js";
import { calculateBinsForPriceRange, MIN_RANGE_PCT, MIN_BINS } from "./runtime-helpers.js";
import {
  TRADING_PRESETS, DEPLOY_SIZE_MIN_SOL, DEPLOY_SIZE_MAX_SOL, readTradingSettings, fmtTradingValue,
  encodePresetValue, decodePreset, planTradingChange, riskIncreases, describeChanges,
  parseCustomDeploySize, stopLossOff,
} from "./trading-settings.js";

export const MENU_BUTTON_TEXT = "🏠 Menu";
export const CONFIRM_TTL_MS = 60_000;
export const PAGE_CHAR_BUDGET = 3500; // leaves headroom under Telegram's 4096 cap
export const POSITIONS_PER_PAGE = 5;
export const CANDIDATES_PER_PAGE = 5;
export const ENTRY_PREVIEW_TIMEOUT_MS = 8_000;

export const BOT_COMMANDS = [
  { command: "menu", description: "Main menu" },
  { command: "status", description: "Wallet + open positions" },
  { command: "candidates", description: "Top pools (Deploy → strategy + range → confirm)" },
  { command: "token", description: "Look up a token mint (SOL DLMM pools, filters, deploy)" },
  { command: "settings", description: "Effective config and where it comes from" },
  { command: "usdc", description: "Show or toggle USDC mode (on|off)" },
  { command: "autoresearch", description: "Prompt overrides: status, list, approve, reject" },
  { command: "thresholds", description: "Screening thresholds + performance" },
  { command: "briefing", description: "Last-24h briefing" },
  { command: "help", description: "All commands" },
];

// ─── Small helpers ───────────────────────────────────────────────
function randomId(len) {
  return crypto.randomBytes(16).toString("base64url").replace(/[-_]/g, "").slice(0, len).padEnd(len, "0");
}

/** Build callback_data, refusing anything over Telegram's 64-byte limit. */
export function cb(...parts) {
  const data = parts.join(":");
  if (Buffer.byteLength(data, "utf8") > CALLBACK_DATA_MAX_BYTES) {
    throw new Error(`callback_data too long (${Buffer.byteLength(data, "utf8")} bytes): ${data.slice(0, 20)}…`);
  }
  return data;
}

const btn = (text, data) => ({ text, callback_data: cb(data) });
const urlBtn = (text, url) => ({ text, url });

export function shortAddr(addr) {
  const s = String(addr ?? "");
  return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

export const meteoraPoolUrl = (pool) => `https://app.meteora.ag/dlmm/${pool}`;
export const solscanAccountUrl = (addr) => `https://solscan.io/account/${addr}`;
export const solscanTxUrl = (sig) => `https://solscan.io/tx/${sig}`;

function fmtNum(v, digits = 4) {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n * 10 ** digits) / 10 ** digits) : "?";
}

function fmtUsdCompact(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "?";
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

function fmtSigned(v, digits) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "?";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
}

export function fmtAge(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m < 0) return "?";
  if (m < 60) return `${Math.round(m)}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${Math.round(m % 60)}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtAgo(ts, now) {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  return `${fmtAge(s / 60)} ago`;
}

/** PnL line honoring pnlUnit. A null PnL is "unknown", never 0. */
export function fmtPnl(p, unit = "sol") {
  if (p?.pnl_pct == null || p?.pnl_unknown) return "unknown";
  const abs = unit === "sol" && p.pnl_sol != null
    ? `${fmtSigned(p.pnl_sol, 4)} SOL`
    : p.pnl_usd != null ? `${fmtSigned(p.pnl_usd, 2).replace(/^([+-])/, "$1$")}` : null;
  return `${abs ? `${abs} ` : ""}(${fmtSigned(p.pnl_pct, 2)}%)`;
}

function fmtValue(p, unit) {
  return unit === "sol" && p.total_value_sol != null ? `${fmtNum(p.total_value_sol, 4)} SOL` : `$${fmtNum(p.total_value_usd, 2)}`;
}

function fmtFees(p, unit) {
  return unit === "sol" && p.unclaimed_fees_sol != null ? `${fmtNum(p.unclaimed_fees_sol, 4)} SOL` : `$${fmtNum(p.unclaimed_fees_usd, 2)}`;
}

/** meteora | gmgn | both, from the candidate's sources (falls back to the configured source). */
export function candidateSourceTag(c, fallback = "meteora") {
  const sources = Array.isArray(c?.sources) ? c.sources.map(String) : [];
  if (c?.confirmed_by_both || (sources.includes("meteora") && sources.includes("gmgn"))) return "both";
  if (sources.length) return sources[0];
  if (c?.gmgn) return "gmgn";
  return fallback === "both" ? "meteora" : fallback;
}

/**
 * Greedy pagination: pack rendered blocks into pages of at most `perPage` items
 * and `budget` characters. Returns an array of pages, each an array of indices.
 */
export function paginate(blocks, { perPage = 5, budget = PAGE_CHAR_BUDGET } = {}) {
  const pages = [];
  let cur = [];
  let len = 0;
  blocks.forEach((b, i) => {
    const size = b.length + 2;
    if (cur.length && (cur.length >= perPage || len + size > budget)) {
      pages.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(i);
    len += size;
  });
  if (cur.length) pages.push(cur);
  return pages.length ? pages : [[]];
}

/** Cut point ≤ max that doesn't split an HTML entity like &amp;. */
function safeCut(s, max) {
  let cut = max;
  const amp = s.lastIndexOf("&", cut - 1);
  if (amp !== -1 && amp > cut - 10 && s.indexOf(";", amp) >= cut) cut = amp;
  return cut > 0 ? cut : max;
}

/**
 * Split long text into pages on line boundaries, each at most `budget` chars.
 * Safe on already-escaped HTML: an over-long line is never cut inside an entity.
 */
export function paginateText(text, budget = PAGE_CHAR_BUDGET) {
  const lines = String(text ?? "").split("\n");
  const pages = [];
  let cur = "";
  for (let line of lines) {
    while (line.length > budget) {
      if (cur) { pages.push(cur); cur = ""; }
      const cut = safeCut(line, budget);
      pages.push(line.slice(0, cut));
      line = line.slice(cut);
    }
    if (cur.length + line.length + 1 > budget) { pages.push(cur); cur = ""; }
    cur += (cur ? "\n" : "") + line;
  }
  if (cur || !pages.length) pages.push(cur);
  return pages;
}

function pagerRow(prefix, page, total) {
  if (total <= 1) return null;
  const row = [];
  if (page > 0) row.push(btn("◀ Prev", `${prefix}:${page - 1}`));
  row.push(btn(`${page + 1}/${total}`, `${prefix}:${page}`));
  if (page < total - 1) row.push(btn("Next ▶", `${prefix}:${page + 1}`));
  return row;
}

// ─── Nonce + ref stores ──────────────────────────────────────────
/**
 * Server-side store for confirmation nonces. Each nonce maps to the exact
 * action + parameters, expires after `ttlMs`, and is single-use (take()).
 */
export function createNonceStore({ ttlMs = CONFIRM_TTL_MS, now = () => Date.now(), max = 200 } = {}) {
  const map = new Map();
  const sweep = () => {
    const t = now();
    for (const [id, e] of map) if (e.expiresAt <= t) map.delete(id);
    while (map.size > max) map.delete(map.keys().next().value);
  };
  return {
    put(action, params, { chatId = null } = {}) {
      sweep();
      let id;
      do { id = randomId(10); } while (map.has(id));
      map.set(id, { id, action, params, chatId, messageId: null, createdAt: now(), expiresAt: now() + ttlMs });
      return id;
    },
    bind(id, messageId, chatId = undefined) {
      const e = map.get(id);
      if (!e) return;
      e.messageId = messageId;
      if (chatId != null) e.chatId = String(chatId);
    },
    peek(id) {
      const e = map.get(id);
      if (!e) return { error: "unknown" };
      if (e.expiresAt <= now()) { map.delete(id); return { error: "expired" }; }
      return { entry: e };
    },
    /** Consume: returns { entry } exactly once, then { error: "unknown" }. */
    take(id) {
      const r = this.peek(id);
      if (r.entry) map.delete(id);
      return r;
    },
    /** Restart the TTL of a live entry (multi-step menus). */
    touch(id) {
      const e = map.get(id);
      if (e && e.expiresAt > now()) e.expiresAt = now() + ttlMs;
    },
    size() { sweep(); return map.size; },
  };
}

/** Short id → long value (addresses, candidate snapshots) so callback_data stays tiny. */
export function createRefMap({ max = 500 } = {}) {
  const map = new Map();
  const byKey = new Map();
  return {
    put(value, key = null) {
      if (key != null && byKey.has(key) && map.has(byKey.get(key))) {
        const id = byKey.get(key);
        map.set(id, value);
        return id;
      }
      let id;
      do { id = randomId(6); } while (map.has(id));
      map.set(id, value);
      if (key != null) byKey.set(key, id);
      while (map.size > max) {
        const oldest = map.keys().next().value;
        map.delete(oldest);
      }
      return id;
    },
    get(id) { return map.get(id) ?? null; },
  };
}

// ─── Alert rate limiter ──────────────────────────────────────────
export function createAlertLimiter({ now = () => Date.now(), perMinute = 20 } = {}) {
  const last = new Map();
  let window = [];
  return {
    /** Per-key cooldown plus a global per-minute cap. */
    allow(key, cooldownMs = 0) {
      const t = now();
      window = window.filter((x) => t - x < 60_000);
      if (window.length >= perMinute) return false;
      if (cooldownMs > 0 && last.has(key) && t - last.get(key) < cooldownMs) return false;
      last.set(key, t);
      window.push(t);
      return true;
    },
  };
}

// ─── Log tail (Recent errors) ────────────────────────────────────
/** Strip secrets and full keys/addresses from a log line before it leaves the box. */
export function redactLogLine(line) {
  return String(line ?? "")
    .replace(/(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}/g, "[redacted-bot-token]")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[redacted-key]")
    .replace(/((?:api[-_]?key|apikey|access[-_]?token|token|secret|password|passwd|authorization|bearer|private[-_]?key)["']?\s*[=:]\s*["']?)[^\s&"',;]+/gi, "$1[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/g, "[redacted-bytes]")
    .replace(/\b[0-9a-fA-F]{40,}\b/g, (m) => `${m.slice(0, 4)}…${m.slice(-4)}`)
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,}\b/g, (m) => `${m.slice(0, 4)}…${m.slice(-4)}`);
}

const ERROR_LINE_RE = /\[[A-Z0-9_]*(?:ERROR|WARN)[A-Z0-9_]*\]/;

/**
 * Last `n` ERROR/WARN lines from the current log (logs/bot.logpath, else today's
 * logs/agent-YYYY-MM-DD.log), redacted. Reads only the file's tail.
 */
export function readRecentErrors({ n = 15, repoDir = process.cwd(), maxBytes = 512 * 1024 } = {}) {
  const logsDir = path.join(repoDir, "logs");
  const candidates = [];
  try {
    const p = fs.readFileSync(path.join(logsDir, "bot.logpath"), "utf8").trim();
    if (p) candidates.push(path.isAbsolute(p) ? p : path.join(repoDir, p));
  } catch { /* no bot.logpath */ }
  candidates.push(path.join(logsDir, `agent-${new Date().toISOString().slice(0, 10)}.log`));
  for (const file of candidates) {
    let fd;
    try {
      const { size } = fs.statSync(file);
      const start = Math.max(0, size - maxBytes);
      fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split("\n").filter((l) => ERROR_LINE_RE.test(l));
      return { file: path.basename(file), lines: lines.slice(-n).map((l) => redactLogLine(l).slice(0, 300)) };
    } catch { /* try the next candidate */ } finally {
      if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
  return { file: null, lines: [] };
}

// ─── Deploy plan ─────────────────────────────────────────────────
/**
 * Range from the default volatility table in prompt.js (upper edge of each band,
 * per its "pick the upper half" bias). Unknown volatility gets the widest band.
 */
export function rangeForVolatility(volatility, strategy) {
  const v = volatility == null || volatility === "" ? NaN : Number(volatility);
  const spot = strategy === "spot";
  if (!Number.isFinite(v) || v >= 8) return spot ? 85 : 75;
  if (v >= 5) return spot ? 70 : 60;
  if (v >= 2) return spot ? 65 : 55;
  return spot ? 50 : 45;
}

/** Range presets offered by the Telegram picker (besides Auto). */
export const RANGE_PRESETS = [25, 50, 80];

export const STRATEGY_LABELS = { bid_ask: "Bid-Ask", spot: "Spot" };

/** The strategy the bot would use on its own (the picker marks it as default). */
export function defaultPickerStrategy(config, usdcMode = false) {
  if (usdcMode) return "bid_ask";
  return config.strategy?.strategy === "bid_ask" ? "bid_ask" : "spot";
}

/**
 * Exact deploy_position arguments for a candidate. The confirmation card shows
 * these and the Confirm tap executes exactly these. Returns { error } when the
 * amount can't be determined (no silent fallback amount for real funds).
 *
 * `strategy` / `priceRangePct` are the picker's choices; without them the
 * configured default applies. Evil Panda ignores both (its own spot plan).
 * Always single-sided SOL: bins_above 0, never sol_split_pct or amount_x.
 */
export function buildDeployPlan(candidate, { wallet, config, computeDeployAmount, usdcMode = false, strategy: chosen = null, priceRangePct = null }) {
  if (!candidate?.pool) return { error: "Candidate has no pool address." };
  const evil = config.strategy?.activeStrategy === "evil_panda";
  let strategy;
  if (evil) strategy = "spot";
  else if (chosen != null) {
    if (chosen !== "bid_ask" && chosen !== "spot") return { error: `Unknown strategy ${chosen}.` };
    if (usdcMode && chosen !== "bid_ask") return { error: "USDC mode only supports Bid-Ask." };
    strategy = chosen;
  } else strategy = defaultPickerStrategy(config, usdcMode); // executor forces bid_ask in USDC mode
  let price_range_pct;
  if (evil) price_range_pct = config.strategy?.evilPanda?.priceRangePct ?? 80;
  else if (priceRangePct != null) {
    const r = Number(priceRangePct);
    if (!(r > 0 && r < 100)) return { error: `Invalid range ${priceRangePct}%.` };
    price_range_pct = r;
  } else price_range_pct = rangeForVolatility(candidate.volatility, strategy);

  const args = {
    pool_address: candidate.pool,
    pool_name: candidate.name || null,
    base_mint: candidate.base_mint || candidate.base?.mint || null,
    bin_step: candidate.bin_step ?? null,
    volatility: candidate.volatility ?? null,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio ?? null,
    organic_score: candidate.organic_score ?? null,
    strategy,
    price_range_pct,
    bins_above: 0,
  };
  for (const k of Object.keys(args)) if (args[k] == null) delete args[k];

  let amountLabel;
  if (usdcMode) {
    const usd = Number(config.usdc?.deployAmountUsd);
    if (!(usd > 0)) return { error: "USDC mode is on but usdc.deployAmountUsd is not set." };
    args.amount_usd = usd;
    amountLabel = `$${usd} (USDC → SOL, auto-funded)`;
  } else {
    if (!wallet || wallet.error || !Number.isFinite(Number(wallet.sol))) {
      return { error: `Can't read the wallet balance${wallet?.error ? ` (${wallet.error})` : ""} — deploy not offered.` };
    }
    const amt = computeDeployAmount(Number(wallet.sol));
    if (!(amt > 0)) return { error: "Computed deploy amount is 0." };
    args.amount_y = amt;
    amountLabel = `${amt} SOL`;
  }
  const strategyLabel = evil ? `Evil Panda (single-sided SOL spot, ${price_range_pct}% range)` : `${strategy}, single-sided SOL, ${price_range_pct}% range`;
  return { args, amountLabel, strategyLabel, evil, range: rangeInfo(price_range_pct, candidate.bin_step) };
}

/**
 * What deploy_position will actually do with a requested range: below
 * MIN_RANGE_PCT it widens to the floor (tools/dlmm.js). `bins` is the approximate
 * bin count at the pool's bin_step (null when the bin_step is unknown).
 */
export function rangeInfo(requestedPct, binStep) {
  const effectivePct = Math.max(Number(requestedPct), MIN_RANGE_PCT);
  const bs = Number(binStep);
  const bins = bs > 0 ? calculateBinsForPriceRange(bs, effectivePct) : null;
  return {
    requestedPct: Number(requestedPct),
    effectivePct,
    widened: effectivePct > Number(requestedPct),
    bins,
    tooFewBins: bins != null && bins < MIN_BINS, // deploy_position would reject it
  };
}

/** "35% (~44 bins at bin step 100)" or with the widening note. */
function fmtRange(r, binStep) {
  const bins = r.bins != null ? ` (~${r.bins} bins at bin step ${binStep})` : " (bins computed at deploy from the pool's bin step)";
  return r.widened
    ? `${r.requestedPct}% requested → deploy widens it to the ${MIN_RANGE_PCT}% minimum${bins}`
    : `${r.effectivePct}%${bins}`;
}

// ─── Views (pure renderers) ──────────────────────────────────────
export function renderMainMenu({ header = "" } = {}) {
  return {
    text: `🏠 <b>Meridian</b>${header ? `\n${header}` : ""}\n\nPick a view:`,
    keyboard: [
      [btn("📈 Status", "st"), btn("📊 Positions", "po:0")],
      [btn("🔍 Candidates", "ca:0"), btn("💰 Wallet", "wa")],
      [btn("⚙️ Settings", "se:0"), btn("🎛 Bot controls", "bc")],
      [btn("⚙️ Trading settings", "ts")],
    ],
  };
}

const backRow = (refresh) => [btn("🔄 Refresh", refresh), btn("⬅ Menu", "m")];

export function renderStatus(info, now = Date.now()) {
  const lines = [
    `📈 <b>Status</b>`,
    `Mode: <b>${info.dryRun ? "DRY RUN" : "LIVE"}</b>${info.usdcMode ? " · 💵 USDC mode" : ""}`,
    `Strategy: ${escapeHtml(info.activeStrategy ?? "?")}${info.strategy ? ` (${escapeHtml(info.strategy)})` : ""}`,
    `Models: manage <code>${escapeHtml(info.managementModel ?? "?")}</code> · screen <code>${escapeHtml(info.screeningModel ?? "?")}</code>`,
    `Screening source: ${escapeHtml(info.screeningSource ?? "meteora")}`,
    "",
    `Management: every ${info.managementIntervalMin}m · ${info.managementBusy ? "running" : `next in ${escapeHtml(info.nextManagement ?? "?")}`}`,
    `Screening: every ${info.screeningIntervalMin}m · ${info.paused ? "<b>⏸ PAUSED</b>" : info.screeningBusy ? "running" : `next in ${escapeHtml(info.nextScreening ?? "?")}`}`,
    `PnL watcher: every ${info.pnlWatcherIntervalSec ?? "?"}s (runs while paused)`,
    `Autonomous cycles: ${info.cronStarted ? "running" : "not started"}${info.busy ? " · ⏳ action in progress" : ""}`,
  ];
  for (const [label, c] of [["management", info.lastManagement], ["screening", info.lastScreening]]) {
    lines.push("", `<b>Last ${label}</b> (${fmtAgo(c?.at, now)}):`);
    lines.push(c?.summary ? escapeHtml(c.summary) : "—");
  }
  return { text: clipText(lines.join("\n"), PAGE_CHAR_BUDGET), keyboard: [backRow("st")] };
}

// ─── Wallet: true total (wallet + DLMM positions) ────────────────
export const WALLET_DUST_USD = 0.10;
export const WALLET_MAX_TOKENS = 12;
export const WALLET_MAX_POSITIONS = 15;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const finitePos = (v) => { const n = Number(v); return v != null && Number.isFinite(n) && n > 0 ? n : null; };

/**
 * Read-only totals from data the bot already has: getWalletBalances() (Helius
 * balances with per-token USD) and getMyPositions() (LP Agent / Meteora
 * position value, composition and unclaimed fees). A position whose value is
 * unknown (missing or 0) is excluded from the subtotal and flagged, never
 * counted as 0. Returns plain numbers; renderWallet formats them.
 *
 * Fees are added on top of total_value_usd because both sources exclude them:
 * LP Agent `value` reconciles as value + collectedFee + unCollectedFee −
 * inputValue = pnl.value, and Meteora's UnrealizedPnL.balances is the token X +
 * Y balance with unclaimed fees reported separately (dlmm.datapi OpenAPI).
 */
export function computeWalletTotals(wallet, positionsResult = null) {
  const posList = Array.isArray(positionsResult?.positions) ? positionsResult.positions : [];
  const price = finitePos(wallet?.sol_price) ?? finitePos(posList.find((p) => finitePos(p.sol_price))?.sol_price);
  const toSol = (usd) => (price && usd != null ? usd / price : null);

  // ── In wallet ──
  const walletItems = [];
  const sol = Number(wallet?.sol) || 0;
  const solUsd = Number.isFinite(Number(wallet?.sol_usd)) && Number(wallet.sol_usd) > 0 ? Number(wallet.sol_usd) : (price ? sol * price : 0);
  walletItems.push({ symbol: "SOL", amount: sol, usd: solUsd, kind: "sol" });
  const tokens = Array.isArray(wallet?.tokens) ? wallet.tokens : [];
  const isSol = (t) => t.mint === SOL_MINT || t.symbol === "SOL";
  const isUsdc = (t) => t.mint === USDC_MINT || t.symbol === "USDC";
  const usdcAmt = Number(wallet?.usdc) || 0;
  if (usdcAmt > 0) {
    const entry = tokens.find(isUsdc);
    walletItems.push({ symbol: "USDC", amount: usdcAmt, usd: finitePos(entry?.usd) ?? usdcAmt, kind: "usdc" });
  }
  const others = [];
  let dustUsd = 0;
  let dustCount = 0;
  let unpriced = 0;
  for (const t of tokens) {
    if (isSol(t) || isUsdc(t)) continue;
    const usd = t.usd == null ? null : Number(t.usd);
    if (usd == null || !Number.isFinite(usd)) { if (Number(t.balance) > 0) unpriced++; continue; }
    if (usd > WALLET_DUST_USD) others.push({ symbol: t.symbol || shortAddr(t.mint), amount: Number(t.balance), usd, kind: "token" });
    else if (usd > 0) { dustUsd += usd; dustCount++; }
  }
  others.sort((a, b) => b.usd - a.usd);
  walletItems.push(...others);
  const walletUsd = walletItems.reduce((a, x) => a + x.usd, 0) + dustUsd;

  // ── In DLMM positions ──
  const positions = posList.map((p) => {
    const valueUsd = finitePos(p.total_value_usd) ?? (price && finitePos(p.total_value_sol) ? finitePos(p.total_value_sol) * price : null);
    const feesUsd = Number.isFinite(Number(p.unclaimed_fees_usd)) && Number(p.unclaimed_fees_usd) > 0 ? Number(p.unclaimed_fees_usd) : 0;
    const c = p.composition || null;
    return {
      position: p.position,
      pair: p.pair ?? shortAddr(p.position),
      known: valueUsd != null,
      valueUsd,
      feesUsd,
      totalUsd: valueUsd != null ? valueUsd + feesUsd : null,
      solSide: c && Number.isFinite(Number(c.sol_amount)) ? { sol: Number(c.sol_amount), usd: Number(c.sol_usd) || (price ? Number(c.sol_amount) * price : null) } : null,
      tokenSide: c && Number.isFinite(Number(c.token_usd)) ? { amount: Number(c.token_amount), usd: Number(c.token_usd), sol: toSol(Number(c.token_usd)) } : null,
    };
  });
  const dlmmUsd = positions.reduce((a, x) => a + (x.known ? x.totalUsd : 0), 0);
  const unknownCount = positions.filter((x) => !x.known).length;
  const totalUsd = walletUsd + dlmmUsd;
  return {
    price,
    walletItems, dustUsd, dustCount, unpriced, walletUsd, walletSol: toSol(walletUsd),
    positions, positionsError: positionsResult?.error ?? (positionsResult ? null : "not loaded"),
    dlmmUsd, dlmmSol: toSol(dlmmUsd), unknownCount,
    totalUsd, totalSol: toSol(totalUsd),
  };
}

const usdStr = (v) => (v == null ? "?" : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const solStr = (v) => (v == null ? "? SOL" : `${fmtNum(v, 4)} SOL`);
const amtStr = (v) => (Number(v) >= 1000 ? Math.round(Number(v)).toLocaleString("en-US") : fmtNum(v, 4));

export function renderWallet(wallet, { config, usdcMode, positions = null } = {}) {
  const keyboard = [[btn("🔄 Refresh", "wa:r"), btn("⬅ Menu", "m")]];
  if (!wallet || wallet.error) {
    return { text: `💰 <b>Wallet</b>\n⚠️ Could not read balances: ${escapeHtml(wallet?.error ?? "unknown error")}`, keyboard };
  }
  const t = computeWalletTotals(wallet, positions);
  const reserve = usdcMode ? config.usdc?.gasReserveSol : (config.management?.gasReserve ?? 0.2);
  const lines = [`💰 <b>Wallet</b> <code>${escapeHtml(shortAddr(wallet.wallet))}</code>`];

  // Total first so it survives any clipping.
  lines.push(`<b>Total: ${solStr(t.totalSol)} (${usdStr(t.totalUsd)})</b>`);
  lines.push(`= wallet ${usdStr(t.walletUsd)} + DLMM ${usdStr(t.dlmmUsd)}${t.price ? ` · SOL price used: $${fmtNum(t.price, 2)}` : " · ⚠️ SOL price unknown, SOL totals not shown"}`);
  if (t.positionsError) lines.push(`⚠️ DLMM positions not included: ${escapeHtml(clipText(String(t.positionsError), 120))}`);
  if (t.unknownCount) lines.push(`⚠️ ${t.unknownCount} position${t.unknownCount === 1 ? "" : "s"} with unknown value not included.`);

  lines.push("", `<b>In wallet</b> (${usdStr(t.walletUsd)})`);
  const shown = t.walletItems.slice(0, WALLET_MAX_TOKENS);
  for (const x of shown) {
    if (x.kind === "sol") lines.push(`SOL: <b>${fmtNum(x.amount, 4)}</b> (${usdStr(x.usd)})`);
    else if (x.kind === "usdc") lines.push(`USDC: <b>$${fmtNum(x.amount, 2)}</b>${Math.abs(x.usd - x.amount) > 0.01 ? ` (${usdStr(x.usd)})` : ""}`);
    else lines.push(`${escapeHtml(clipText(String(x.symbol), 16))}: ${amtStr(x.amount)} (${usdStr(x.usd)})`);
  }
  const hidden = t.walletItems.slice(WALLET_MAX_TOKENS);
  if (hidden.length) lines.push(`+ ${hidden.length} more token${hidden.length === 1 ? "" : "s"} (${usdStr(hidden.reduce((a, x) => a + x.usd, 0))})`);
  if (t.dustCount) lines.push(`+ ${t.dustCount} balance${t.dustCount === 1 ? "" : "s"} under $${WALLET_DUST_USD.toFixed(2)} (${usdStr(t.dustUsd)})`);
  if (t.unpriced) lines.push(`${t.unpriced} unpriced token${t.unpriced === 1 ? "" : "s"} not counted.`);
  lines.push(`Gas reserve: ${fmtNum(reserve, 4)} SOL${usdcMode ? " (USDC mode, warn-only)" : ""}`);
  if (Number(wallet.sol) < Number(reserve)) lines.push("⚠️ SOL is below the gas reserve.");

  if (!t.positionsError) {
    lines.push("", `<b>In DLMM positions</b> (${usdStr(t.dlmmUsd)}${t.dlmmSol != null ? ` · ${solStr(t.dlmmSol)}` : ""}; value + unclaimed fees)`);
    if (!t.positions.length) lines.push("No open positions.");
    t.positions.slice(0, WALLET_MAX_POSITIONS).forEach((x, i) => {
      const head = `${i + 1}. <b>${escapeHtml(clipText(String(x.pair), 24))}</b>`;
      if (!x.known) {
        lines.push(`${head}: value unknown (not counted)`);
        return;
      }
      const parts = [`${solStr(t.price ? x.totalUsd / t.price : null)} (${usdStr(x.totalUsd)})`];
      if (x.solSide) parts.push(`SOL side ${solStr(x.solSide.sol)}`);
      if (x.tokenSide) parts.push(`token side ${solStr(x.tokenSide.sol)} (${usdStr(x.tokenSide.usd)})`);
      parts.push(`fees ${solStr(t.price ? x.feesUsd / t.price : null)} (${usdStr(x.feesUsd)})`);
      lines.push(`${head}: ${parts.join(" · ")}`);
    });
    const more = t.positions.slice(WALLET_MAX_POSITIONS);
    if (more.length) lines.push(`+ ${more.length} more position${more.length === 1 ? "" : "s"} (${usdStr(more.reduce((a, x) => a + (x.known ? x.totalUsd : 0), 0))})`);
    if (t.positions.length) lines.push("Excludes position rent (refunded on close).");
  }
  if (wallet.wallet) keyboard.unshift([urlBtn("Solscan ↗", solscanAccountUrl(wallet.wallet))]);
  return { text: clipText(lines.join("\n"), PAGE_CHAR_BUDGET), keyboard, totals: t };
}

function positionBlock(p, i, unit) {
  const range = p.in_range
    ? "✅ in range"
    : `⚠️ OOR${p.oor_direction ? ` ${escapeHtml(p.oor_direction)}` : ""}${p.minutes_out_of_range ? ` ${p.minutes_out_of_range}m` : ""}`;
  return [
    `<b>${i + 1}. ${escapeHtml(p.pair ?? shortAddr(p.position))}</b> · ${range}`,
    `PnL: ${escapeHtml(fmtPnl(p, unit))} · Value: ${fmtValue(p, unit)}`,
    `Fees: ${fmtFees(p, unit)} unclaimed · Age: ${fmtAge(p.age_minutes)}`,
    `<code>${escapeHtml(shortAddr(p.position))}</code>`,
  ].join("\n");
}

export function renderPositions(result, { page = 0, refs, unit = "sol" } = {}) {
  if (!result || result.error) {
    return { text: `📊 <b>Positions</b>\n⚠️ ${escapeHtml(result?.error ?? "Could not load positions")}`, keyboard: [backRow("po:0")] };
  }
  const positions = result.positions || [];
  if (!positions.length) return { text: "📊 <b>Positions</b>\nNo open positions.", keyboard: [backRow("po:0")] };
  const blocks = positions.map((p, i) => positionBlock(p, i, unit));
  const pages = paginate(blocks, { perPage: POSITIONS_PER_PAGE });
  const pg = Math.min(Math.max(0, page), pages.length - 1);
  const keyboard = [];
  for (const i of pages[pg]) {
    const p = positions[i];
    const row = [btn(`🔒 Close ${i + 1}`, `pc:${refs.put(p.position, `pos:${p.position}`)}`)];
    if (p.pool) row.push(urlBtn("Meteora ↗", meteoraPoolUrl(p.pool)));
    row.push(urlBtn("Solscan ↗", solscanAccountUrl(p.position)));
    keyboard.push(row);
  }
  const pager = pagerRow("po", pg, pages.length);
  if (pager) keyboard.push(pager);
  keyboard.push(backRow(`po:${pg}`));
  const text = `📊 <b>Positions</b> (${positions.length} open)\n\n${pages[pg].map((i) => blocks[i]).join("\n\n")}`;
  return { text, keyboard, page: pg, pages: pages.length };
}

/** Fee mode of a candidate: on-chain entry state, else the screening tag, else the API string. */
function feeModeOf(c) {
  const fm = c?.entry_state?.feeMode || c?.fee_mode;
  if (fm?.mode) return fm;
  const v = c?.collect_fee_mode == null ? null : String(c.collect_fee_mode).toLowerCase();
  if (v === "quote") return { mode: "OnlyY", solFees: true };
  if (v === "both") return { mode: "InputOnly", solFees: false };
  return null;
}

const FEE_MODE_TEXT = {
  OnlyY: "LP fees paid in SOL (OnlyY)",
  InputOnly: "LP fees paid in the input token (InputOnly): sellers pay you in the token",
};

function candidateBlock(c, i, fallbackSource) {
  const vol = c.volume ?? c.volume_window ?? c.volume_24h;
  const metrics = [
    `darwin ${c.darwin_score ?? "?"}`,
    `fee/aTVL ${c.fee_active_tvl_ratio ?? c.fee_tvl_ratio ?? "?"}%`,
    `vol ${fmtUsdCompact(vol)}`,
    `organic ${c.organic_score ?? "?"}`,
    `volatility ${c.volatility ?? "?"}`,
    `bin ${c.bin_step ?? "?"}`,
  ];
  if (c.holders != null) metrics.push(`holders ${c.holders}`);
  const fm = feeModeOf(c);
  if (fm) metrics.push(fm.solFees ? "fees SOL" : fm.mode === "InputOnly" ? "fees token" : "fees ?");
  return `<b>${i + 1}. ${escapeHtml(c.name ?? shortAddr(c.pool))}</b> [${escapeHtml(candidateSourceTag(c, fallbackSource))}]\n${escapeHtml(metrics.join(" · "))}`;
}

export function renderCandidates(list, { page = 0, refs, source = "meteora", fetchedAt = null, now = Date.now(), meta = null } = {}) {
  const candidates = list || [];
  const header = `🔍 <b>Candidates</b>${meta ? ` (${meta.total_eligible ?? candidates.length} eligible / ${meta.total_screened ?? "?"} screened)` : ""} · ${fetchedAt ? fmtAgo(fetchedAt, now) : "not screened yet"}`;
  if (!candidates.length) {
    return { text: `${header}\nNo candidates. Tap Screen now.`, keyboard: [[btn("🔍 Screen now", "cs")], [btn("⬅ Menu", "m")]] };
  }
  const blocks = candidates.map((c, i) => candidateBlock(c, i, source));
  const pages = paginate(blocks, { perPage: CANDIDATES_PER_PAGE });
  const pg = Math.min(Math.max(0, page), pages.length - 1);
  const keyboard = [];
  for (const i of pages[pg]) {
    const c = candidates[i];
    keyboard.push([
      btn(`🚀 Deploy ${i + 1}`, `dp:${refs.put(c, `cand:${c.pool}`)}`),
      urlBtn("Meteora ↗", meteoraPoolUrl(c.pool)),
    ]);
  }
  const pager = pagerRow("ca", pg, pages.length);
  if (pager) keyboard.push(pager);
  keyboard.push([btn("🔍 Screen now", "cs"), btn("⬅ Menu", "m")]);
  const text = `${header}\n\n${pages[pg].map((i) => blocks[i]).join("\n\n")}\n\nDeploy lets you pick the strategy and range, then asks for confirmation. You can also reply with a number.`;
  return { text, keyboard, page: pg, pages: pages.length };
}

// ─── Token lookup card (paste a mint) ────────────────────────────
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const gmgnTokenUrl = (mint) => `https://gmgn.ai/sol/token/${mint}`;
export const solscanTokenUrl = (mint) => `https://solscan.io/token/${mint}`;

const checkMark = (ch) => (ch.pass === false ? "❌" : ch.off ? "➖" : ch.pass === true ? "✅" : "❔");

/**
 * ❌ lines for the confirmation card: the token's and the chosen pool's failed
 * screening filters. A bin step outside the range is also a deploy_position
 * hard block, so it says so.
 */
export function failedFilterLines(c) {
  return [...(c?.checks?.token || []), ...(c?.checks?.pool || []), ...(c?.checks?.safety || [])]
    .filter((ch) => ch.pass === false)
    .map((ch) => `❌ ${ch.text}${ch.key === "bin_step" ? " (deploy_position blocks bin steps outside this range)" : ""}`);
}

function fmtPct(v) {
  const n = Number(v);
  return v == null || !Number.isFinite(n) ? "?" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

/**
 * Entry-state lines for a pool (lookup + confirm cards): pool status and, when
 * known, fee mode and TWAP. Plain text; the caller escapes.
 */
export function entryStateLines(c, filters = null) {
  const st = c?.entry_state;
  const out = [];
  if (st?.status) out.push(`${st.status.pass ? "✅" : "⛔"} Pool status: ${st.status.pass ? st.status.text : st.status.reasons.join("; ")}`);
  else if (c?.is_blacklisted === true) out.push("⛔ Pool status: Meteora API flags the pool as blacklisted");
  else if (st?.error) out.push(`❔ Pool status: unknown (${clipText(String(st.error), 60)})`);
  const tw = st?.twap;
  if (tw) {
    const g = st.twapGuard;
    const head = tw.known
      ? `price ${tw.devPct >= 0 ? "+" : ""}${Number(tw.devPct).toFixed(1)}% vs ${tw.windowMinutes}-min on-chain TWAP (${tw.devBins > 0 ? "+" : ""}${tw.devBins} bins)`
      : `unknown (${tw.note ?? "no oracle data"})`;
    const tail = g?.pass === false ? ` — ⛔ above the ${filters?.twapSpikeMaxPct ?? "?"}% limit for bid_ask` : !tw.known ? " — allowed" : "";
    out.push(`${g?.pass === false ? "⛔" : tw.known ? "📈" : "❔"} TWAP: ${head}${tail}`);
  }
  const fm = feeModeOf(c);
  out.push(`💸 Fee mode: ${fm ? FEE_MODE_TEXT[fm.mode] ?? "unknown" : "unknown"}${fm && !fm.solFees && filters?.solFeePoolsOnly ? " — ⛔ solFeePoolsOnly is on" : ""}`);
  return out;
}

/** `pools[i].ref` = the Deploy button's ref (absent when deploy is not offered). */
export function renderTokenCard(r, { tokenRef, poolRefs = [], source = "meteora", entryFilters = null } = {}) {
  const top = r.pools?.[0] || null;
  const sym = r.symbol || top?.base?.symbol || shortAddr(r.mint);
  const lines = [`🔎 <b>${escapeHtml(sym)}</b> token lookup`, `<code>${escapeHtml(r.mint)}</code>`];
  if (r.blacklisted) lines.push("⛔ <b>Blacklisted token</b>: deploy is disabled.");

  const price = r.gmgn?.price || null;
  const signal = r.gmgn?.signal || null;
  const tokenFacts = [
    `mcap ${fmtUsdCompact(top?.mcap ?? price?.market_cap)}`,
    `holders ${top?.holders ?? price?.holders ?? "?"}`,
    `age ${price?.token_age_hours != null ? fmtAge(price.token_age_hours * 60) : "?"}`,
    `1h ${fmtPct(price?.change_1h)}`,
    `24h ${fmtPct(price?.change_24h)}`,
  ];
  lines.push(`Token: ${escapeHtml(tokenFacts.join(" · "))}`);
  if (r.gmgn) {
    const g = [];
    if (signal) g.push(`smart money ${signal.smart_money_count_30m ?? 0}`, `KOL ${signal.kol_count_30m ?? 0}`);
    if (price?.candles?.supertrend_direction) g.push(`supertrend ${price.candles.supertrend_direction}`);
    if (price?.candles?.rsi_2 != null) g.push(`RSI(2) ${Math.round(price.candles.rsi_2 * 10) / 10}`);
    lines.push(`GMGN: ${escapeHtml(g.join(" · ") || "no signals")}`);
  } else {
    lines.push(`⚠️ GMGN data unavailable${r.gmgn_error ? ` (${escapeHtml(clipText(String(r.gmgn_error), 80))})` : ""}`);
  }

  const tokenChecks = r.checks?.token || [];
  if (tokenChecks.length) {
    lines.push("", "<b>Your screening filters</b> (token):", ...tokenChecks.map((ch) => `${checkMark(ch)} ${escapeHtml(ch.text)}`));
  }

  const ts = r.token_safety;
  if (ts?.checks?.length) {
    lines.push("", `<b>Entry filters</b> (token)${ts.pass ? "" : " — ⛔ deploy_position will refuse"}:`, ...ts.checks.map((ch) => `${checkMark(ch)} ${escapeHtml(ch.text)}`));
  } else if (r.token_safety_error) {
    lines.push("", `⚠️ Token safety unknown (${escapeHtml(clipText(String(r.token_safety_error), 80))})`);
  }

  const pools = r.pools || [];
  lines.push("");
  if (r.error) lines.push(`⚠️ Meteora lookup failed: ${escapeHtml(clipText(String(r.error), 120))}`);
  if (!pools.length) {
    if (!r.error) lines.push("No SOL-quoted Meteora DLMM pool found for this token. (If this is a wallet address, ask in chat instead.)");
  } else {
    lines.push(`<b>SOL DLMM pools</b> (${pools.length}${r.total_pools > pools.length ? ` of ${r.total_pools}` : ""}, by fee/aTVL then TVL):`);
    pools.forEach((c, i) => {
      lines.push("", candidateBlock(c, i, source));
      const pc = c.checks?.pool || [];
      if (pc.length) lines.push(escapeHtml(pc.map((ch) => `${checkMark(ch)} ${ch.text}`).join(" · ")));
      lines.push(...entryStateLines(c, entryFilters).map((l) => escapeHtml(l)));
    });
  }

  const keyboard = [];
  pools.forEach((c, i) => {
    const row = [];
    if (poolRefs[i]) row.push(btn(`🚀 Deploy ${i + 1}`, `tp:${poolRefs[i]}`));
    row.push(urlBtn(`Meteora ${i + 1} ↗`, meteoraPoolUrl(c.pool)));
    keyboard.push(row);
  });
  keyboard.push([btn("🔄 Refresh", `tr:${tokenRef}`), btn("⬅ Menu", "m")]);
  const links = [];
  if (top) links.push(urlBtn("Meteora ↗", meteoraPoolUrl(top.pool)));
  links.push(urlBtn("GMGN ↗", gmgnTokenUrl(r.mint)), urlBtn("Solscan ↗", solscanTokenUrl(r.mint)));
  keyboard.push(links);
  return { text: clipText(lines.join("\n"), PAGE_CHAR_BUDGET), keyboard };
}

export function renderTextPages(title, body, { page = 0, prefix, extraRows = [] } = {}) {
  // Paginate the ESCAPED text so entity expansion can't push a page past the cap.
  const pages = paginateText(escapeHtml(body), PAGE_CHAR_BUDGET - title.length - 40);
  const pg = Math.min(Math.max(0, page), pages.length - 1);
  const keyboard = [...extraRows];
  const pager = pagerRow(prefix, pg, pages.length);
  if (pager) keyboard.push(pager);
  return { text: `${title}\n<pre>${pages[pg]}</pre>`, keyboard, page: pg, pages: pages.length };
}

export function renderControls(info) {
  return {
    text: [
      `🎛 <b>Bot controls</b>`,
      `Screening: ${info.paused ? "<b>⏸ PAUSED</b>" : "▶️ running"} (management + PnL watcher always run)`,
      `Mode: <b>${info.dryRun ? "DRY RUN" : "LIVE"}</b>`,
    ].join("\n"),
    keyboard: [
      [info.paused ? btn("▶️ Resume screening", "sp:0") : btn("⏸ Pause screening", "sp:1")],
      [btn("🔍 Run screening now", "sn")],
      [btn("🧪 Autoresearch", "ar"), btn("🧯 Recent errors", "er")],
      [btn("🛡 Entry filters", "ef")],
      [btn("⬅ Menu", "m")],
    ],
  };
}

// ─── Entry filters (Settings → 🛡 Entry filters) ─────────────────
// Callback data: ef (view), et:<code> (toggle a boolean), ev:<code>:<value>
// (preset). Codes keep every callback_data far under 64 bytes.
export const ENTRY_TOGGLES = [
  ["fh", "blockTransferHook", "Transfer hook"],
  ["fd", "blockPermanentDelegate", "Permanent delegate"],
  ["fz", "blockFreezeAuthority", "Freeze authority"],
  ["fm", "blockMintAuthority", "Mint authority"],
  ["fp", "blockPausable", "Pausable"],
  ["fn", "blockNonTransferable", "Non-transferable"],
  ["fs", "solFeePoolsOnly", "SOL-fee pools only"],
];
export const ENTRY_PRESETS = {
  tf: { key: "blockTransferFeeAbovePct", label: "Transfer fee >", values: [null, 0.5, 1, 2, 5] },
  tw: { key: "twapSpikeMaxPct", label: "TWAP spike >", values: [null, 10, 15, 25] },
};

export function renderEntryFilters(filters = {}, { note = null } = {}) {
  const f = filters || {};
  const pct = (v) => (v == null ? "off" : `${v}%`);
  const lines = [
    "🛡 <b>Entry filters</b>",
    "Checked in screening, on the token lookup card and as a hard check in deploy_position (every deploy path).",
    "✅ = guard on (blocks), ❌ = off. Changes save to user-config.json and apply now. The agent can only tighten these.",
    "",
    `Transfer fee limit: <b>${pct(f.blockTransferFeeAbovePct)}</b> · TWAP spike limit: <b>${pct(f.twapSpikeMaxPct)}</b> over ${escapeHtml(f.twapWindowMinutes ?? 60)} min (bid_ask)`,
    "Pool status (disabled / not yet active / blacklisted) is always checked.",
  ];
  if (note) lines.push("", note);
  const keyboard = [];
  for (let i = 0; i < ENTRY_TOGGLES.length; i += 2) {
    keyboard.push(ENTRY_TOGGLES.slice(i, i + 2).map(([code, key, label]) => btn(`${f[key] ? "✅" : "❌"} ${label}`, `et:${code}`)));
  }
  for (const [code, p] of Object.entries(ENTRY_PRESETS)) {
    keyboard.push([{ text: `${p.label}`, callback_data: cb("ef") }]);
    keyboard.push(p.values.map((v) => btn(`${f[p.key] === v ? "● " : ""}${v == null ? "Off" : `${v}%`}`, `ev:${code}:${v == null ? "off" : v}`)));
  }
  keyboard.push([btn("⚙️ Settings", "se:0"), btn("⬅ Menu", "m")]);
  return { text: lines.join("\n"), keyboard };
}

// ─── Trading settings (Settings / Menu → ⚙️ Trading settings) ────
// Callback data: ts (view), tv:<code>:<value> (preset, codes in
// TRADING_PRESETS), tc (custom deploy size), tq (cancel custom input).
// Risk-increasing presets render a y:/n: nonce confirm card like fund moves.

const presetLabel = (key, v) => {
  if (key === "stopLossPct") return stopLossOff(v) ? "Off" : `${v}%`;
  if (key === "trailingTakeProfit") return v ? "On" : "Off";
  if (key === "outOfRangeWaitMinutes") return `${v}m`;
  if (key === "pnlWatcherIntervalSec") return `${v}s`;
  if (key === "deployAmountSol" || key === "maxPositions") return `${v}`;
  return `${v}%`;
};

function presetSelected(key, v, cur) {
  if (key === "stopLossPct") return stopLossOff(v) ? stopLossOff(cur.stopLossPct) : Number(cur.stopLossPct) === v;
  if (key === "deployAmountSol") return Number(cur.deployAmountSol) === v && Number(cur.maxDeployAmount) === v;
  if (key === "trailingTakeProfit") return !!cur.trailingTakeProfit === v;
  return Number(cur[key]) === v;
}

export function renderTradingSettings(config, { note = null, usdcMode = false, customPending = false } = {}) {
  const cur = readTradingSettings(config);
  const f = (k) => escapeHtml(fmtTradingValue(k, cur[k]));
  const fixed = Number(cur.deployAmountSol) === Number(cur.maxDeployAmount);
  const lines = [
    "⚙️ <b>Trading settings</b>",
    "Taps save to user-config.json and apply now. ✅ = current. Risk-raising changes (stop loss off/wider, bigger deploy size, more positions, trailing TP off) ask for a second tap.",
    "",
    `Take profit: <b>${f("takeProfitFeePct")}</b> · Stop loss: <b>${f("stopLossPct")}</b>`,
    `Trailing TP: <b>${cur.trailingTakeProfit ? "on" : "off"}</b> · trigger ${f("trailingTriggerPct")} · drop ${f("trailingDropPct")}`,
    `Out-of-range wait: <b>${f("outOfRangeWaitMinutes")}</b>`,
    `Deploy size: <b>${fixed ? f("deployAmountSol") : `${f("deployAmountSol")} – ${f("maxDeployAmount")}`}</b>${fixed ? " (fixed)" : " (floor – ceiling)"} · min SOL to open ${f("minSolToOpen")}`,
    `Max positions: <b>${f("maxPositions")}</b> · PnL watcher: every <b>${f("pnlWatcherIntervalSec")}</b>`,
  ];
  if (usdcMode) lines.push("💵 USDC mode is on: deploys use usdc.deployAmountUsd, not the SOL deploy size.");
  if (cur.trailingTakeProfit && Number(cur.trailingDropPct) >= Number(cur.trailingTriggerPct)) {
    lines.push(`⚠️ Trailing drop ${f("trailingDropPct")} ≥ trigger ${f("trailingTriggerPct")}: a trailing exit can land at or below break-even.`);
  }
  if (customPending) lines.push("", `✏️ <b>Send the deploy size in SOL</b> (${DEPLOY_SIZE_MIN_SOL}–${DEPLOY_SIZE_MAX_SOL}) as your next message, e.g. <code>1.3</code>.`);
  if (note) lines.push("", note);

  const keyboard = [];
  const row = (code) => {
    const p = TRADING_PRESETS[code];
    return p.values.map((v) => btn(`${presetSelected(p.key, v, cur) ? "✅ " : ""}${presetLabel(p.key, v)}`, `tv:${code}:${encodePresetValue(v)}`));
  };
  const label = (text) => [btn(text, "ts")];
  keyboard.push(label("Take profit (%)"), row("tp"));
  keyboard.push(label("Stop loss (%)"), row("sl"));
  keyboard.push(label("Trailing TP · trigger % · drop %"), row("tt"), row("tg"), row("td"));
  keyboard.push(label("Out-of-range wait"), row("oo"));
  keyboard.push(label("Deploy size (SOL, floor = ceiling)"), [...row("ds"), btn("Custom…", "tc")]);
  keyboard.push(label("Max positions"), row("mp"));
  keyboard.push(label("PnL watcher interval"), row("pw"));
  if (customPending) keyboard.push([btn("✖ Cancel custom size", "tq")]);
  keyboard.push([btn("⚙️ Settings", "se:0"), btn("⬅ Menu", "m")]);
  return { text: lines.join("\n"), keyboard };
}

export function renderCloseConfirm(p, nonce, { unit = "sol", dryRun = false } = {}) {
  return {
    text: [
      `🔒 <b>Close position?</b>${dryRun ? " (DRY RUN)" : ""}`,
      `<b>${escapeHtml(p.pair ?? "?")}</b>`,
      `Position: <code>${escapeHtml(p.position)}</code>`,
      p.pool ? `Pool: <code>${escapeHtml(p.pool)}</code>` : null,
      `Value: ${fmtValue(p, unit)} · PnL: ${escapeHtml(fmtPnl(p, unit))}`,
      `Unclaimed fees: ${fmtFees(p, unit)} · ${p.in_range ? "in range" : "out of range"} · age ${fmtAge(p.age_minutes)}`,
      "",
      `Withdraws liquidity, claims fees and swaps the base token back. Expires in ${Math.round(CONFIRM_TTL_MS / 1000)}s.`,
    ].filter((l) => l != null).join("\n"),
    keyboard: [[btn("✅ Confirm close", `y:${nonce}`), btn("✖ Cancel", `n:${nonce}`)]],
  };
}

export function renderDeployConfirm(c, plan, nonce, { dryRun = false, source = "meteora", warnings = [], ttlMs = CONFIRM_TTL_MS, entryState = null, entryFilters = null } = {}) {
  const strategy = plan.evil ? escapeHtml(plan.strategyLabel) : `<b>${STRATEGY_LABELS[plan.args.strategy] ?? escapeHtml(plan.args.strategy)}</b>`;
  const lines = [
    `🚀 <b>Deploy into this pool?</b>${dryRun ? " (DRY RUN)" : ""}`,
    `<b>${escapeHtml(c.name ?? "?")}</b> [${escapeHtml(candidateSourceTag(c, source))}]`,
    `Pool: <code>${escapeHtml(c.pool)}</code>`,
    `Strategy: ${strategy} · single-sided SOL (no token side)`,
    `Range: ${escapeHtml(fmtRange(plan.range, c.bin_step))}`,
    `Amount: <b>${escapeHtml(plan.amountLabel)}</b>`,
    `bin step ${c.bin_step ?? "?"} · volatility ${c.volatility ?? "?"} · fee/aTVL ${c.fee_active_tvl_ratio ?? c.fee_tvl_ratio ?? "?"}%`,
  ];
  if (plan.range.tooFewBins) lines.push(`⚠️ Under ${MIN_BINS} bins: deploy_position will reject this.`);
  lines.push(...entryStateLines({ ...c, entry_state: entryState ?? c.entry_state }, entryFilters).map((l) => escapeHtml(l)));
  if (warnings.length) lines.push("", "⚠️ <b>Outside your screening filters:</b>", ...warnings.map((w) => escapeHtml(w)));
  lines.push("", `Runs the normal deploy_position safety checks. Expires in ${Math.round(ttlMs / 1000)}s.`);
  return {
    text: lines.join("\n"),
    keyboard: [[btn("✅ Confirm deploy", `y:${nonce}`), btn("✖ Cancel", `n:${nonce}`)], [urlBtn("Meteora ↗", meteoraPoolUrl(c.pool))]],
  };
}

// ─── Deploy picker (strategy → range → confirmation card) ────────
// Callback data: ds:<id>:b|s (strategy), dr:<id>:a|<pct> (range),
// db:<id> (back to strategy), dx:<id> (cancel). <id> is a short server-side
// step id; the candidate and the choices live in the step store, never in the data.

export function renderStrategyStep(c, stepId, { defaultStrategy } = {}) {
  const mark = (s) => (s === defaultStrategy ? " ✓" : "");
  return {
    text: [
      `🚀 <b>How do you want to deploy ${escapeHtml(c.name ?? shortAddr(c.pool))}?</b>`,
      `bin step ${c.bin_step ?? "?"} · volatility ${c.volatility ?? "?"} · fee/aTVL ${c.fee_active_tvl_ratio ?? c.fee_tvl_ratio ?? "?"}%`,
      "",
      "Both are single-sided SOL (liquidity below the price, no token needed):",
      "• <b>Bid-Ask</b>: more SOL further below the price; buys dips.",
      "• <b>Spot</b>: SOL spread evenly across the range.",
      `✓ = your configured default (${STRATEGY_LABELS[defaultStrategy]}).`,
    ].join("\n"),
    keyboard: [
      [btn(`Bid-Ask${mark("bid_ask")}`, `ds:${stepId}:b`), btn(`Spot${mark("spot")}`, `ds:${stepId}:s`)],
      [btn("✖ Cancel", `dx:${stepId}`)],
    ],
  };
}

/** Range options for a strategy: Auto + presets, minus any that deploy would reject. */
export function rangeOptions(c, strategy) {
  const auto = rangeForVolatility(c.volatility, strategy);
  const opts = [{ key: "a", pct: auto, label: `Auto (${auto}%)` }, ...RANGE_PRESETS.map((p) => ({ key: String(p), pct: p, label: `${p}%` }))];
  return opts
    .map((o) => ({ ...o, range: rangeInfo(o.pct, c.bin_step) }))
    .filter((o) => !o.range.tooFewBins)
    .map((o) => ({ ...o, label: o.range.widened ? `${o.label} → ${MIN_RANGE_PCT}% min` : o.label }));
}

export function renderRangeStep(c, stepId, strategy, { usdcMode = false } = {}) {
  const opts = rangeOptions(c, strategy);
  const lines = [`🚀 <b>${escapeHtml(c.name ?? shortAddr(c.pool))}</b> · <b>${STRATEGY_LABELS[strategy]}</b> (single-sided SOL)`];
  if (usdcMode) lines.push("💵 USDC mode is on: only Bid-Ask is available (the executor forces it).");
  lines.push(
    "",
    "<b>Pick a range</b> (how far below the current price the SOL goes):",
    `Auto is set from volatility ${c.volatility ?? "?"}.`,
    `deploy_position enforces a ${MIN_RANGE_PCT}% minimum, so narrower presets get widened to it.`,
  );
  if (opts.length < RANGE_PRESETS.length + 1) lines.push(`Ranges under ${MIN_BINS} bins at bin step ${c.bin_step} are hidden (deploy rejects them).`);
  if (!opts.length) lines.push("⚠️ No range reaches the bin minimum for this pool.");
  const rangeBtns = opts.map((o) => btn(o.label, `dr:${stepId}:${o.key}`));
  const keyboard = [];
  for (let i = 0; i < rangeBtns.length; i += 2) keyboard.push(rangeBtns.slice(i, i + 2));
  keyboard.push([btn("⬅ Back", `db:${stepId}`), btn("✖ Cancel", `dx:${stepId}`)]);
  return { text: lines.join("\n"), keyboard };
}

function txLinks(txs) {
  const list = (Array.isArray(txs) ? txs : txs ? [txs] : []).filter((t) => typeof t === "string" && t.length > 20);
  return list.slice(0, 4).map((sig, i) => `<a href="${solscanTxUrl(sig)}">tx ${i + 1}</a>`).join(" · ");
}

/** Render an executeTool result for the confirmation card. */
export function renderExecResult(action, label, result) {
  const title = action === "close" ? "Close" : "Deploy";
  if (!result) return `❌ <b>${title} failed</b> ${escapeHtml(label)}\nNo result.`;
  if (result.dry_run) {
    return `🧪 <b>${title} — DRY RUN</b> ${escapeHtml(label)}\n${escapeHtml(result.message ?? "No transaction sent.")}`;
  }
  if (result.blocked) return `🛑 <b>${title} blocked</b> ${escapeHtml(label)}\n${escapeHtml(result.reason ?? "")}`;
  if (result.success === false || result.error) {
    return `❌ <b>${title} failed</b> ${escapeHtml(label)}\n${escapeHtml(result.error ?? result.status ?? "unknown error")}${result.txs ? `\n${txLinks(result.txs)}` : ""}`;
  }
  const lines = [`✅ <b>${action === "close" ? "Closed" : "Deployed"}</b> ${escapeHtml(label)}`];
  if (result.position) lines.push(`Position: <code>${escapeHtml(result.position)}</code>`);
  if (action === "close" && result.pnl_pct != null) lines.push(`PnL: ${fmtSigned(result.pnl_pct, 2)}%`);
  const links = txLinks(result.txs ?? result.tx);
  if (links) lines.push(links);
  return lines.join("\n");
}

// ─── Controller ──────────────────────────────────────────────────
/**
 * deps:
 *   tg: { sendHTML(html, extra) → Message|null, editHTML(id, html, extra) → bool, answerCallback(id, text, alert) }
 *   config, computeDeployAmount, usdcModeEnabled()
 *   getMyPositions({force}), getWalletBalances(), getTopCandidates({limit})
 *   executeTool(name, args)               — tools/executor.js
 *   runExclusive(fn, { screening })       — → { busy: true } | { value }
 *   autoDeploy()                          — legacy "auto" (LLM picks + deploys); → text
 *   afterDeploy()                         — e.g. launchCron
 *   runScreeningNow()                     — → { started, reason, done: Promise<report> }
 *   isScreeningPaused(), setScreeningPaused(bool)
 *   getStatusInfo()                       — timers, models, busy flags
 *   buildSettingsReport(), handleAutoresearchCommand(args), readRecentErrors()
 *   setEntryFilter(key, value)            — → { ok, text, loosened } | { ok: false, error } (entry-safety.js)
 *   applyTradingSettings(changes)         — → { ok, text, changes, rescheduled } | { ok: false, error } (trading-settings.js)
 *   entryPreview(candidate, { strategy }) — read-only pool status / fee mode / TWAP for the confirm card
 *   log(category, msg), now(), ttlMs
 */
export function createTelegramUI(deps) {
  const now = deps.now || (() => Date.now());
  const logf = deps.log || (() => {});
  const nonces = createNonceStore({ ttlMs: deps.ttlMs ?? CONFIRM_TTL_MS, now });
  const steps = createNonceStore({ ttlMs: deps.ttlMs ?? CONFIRM_TTL_MS, now }); // deploy picker state
  const refs = createRefMap();
  const limiter = createAlertLimiter({ now });
  const state = {
    candidates: [],
    candidatesMeta: null,
    candidatesAt: null,
    lastManagement: null,
    lastScreening: null,
    customDeploy: null, // { chatId, expiresAt } while waiting for a "Custom…" deploy size
  };
  const isDryRun = () => process.env.DRY_RUN === "true";
  const unit = () => deps.config.management?.pnlUnit || "sol";
  const source = () => deps.config.screening?.source || "meteora";

  async function show(ctx, view, { fresh = false } = {}) {
    const extra = { reply_markup: { inline_keyboard: view.keyboard || [] } };
    if (!fresh && ctx?.messageId != null) {
      const ok = await deps.tg.editHTML(ctx.messageId, view.text, extra);
      if (ok) return { message_id: ctx.messageId, edited: true };
    }
    return deps.tg.sendHTML(view.text, extra);
  }

  async function statusInfo() {
    const base = (await deps.getStatusInfo?.()) || {};
    return {
      ...base,
      dryRun: isDryRun(),
      paused: !!deps.isScreeningPaused?.(),
      lastManagement: state.lastManagement,
      lastScreening: state.lastScreening,
    };
  }

  async function loadCandidates() {
    const result = await deps.getTopCandidates({ limit: 10 });
    state.candidates = result?.candidates || [];
    state.candidatesMeta = { total_eligible: result?.total_eligible, total_screened: result?.total_screened };
    state.candidatesAt = now();
    return state.candidates;
  }

  function candidatesView(page) {
    return renderCandidates(state.candidates, {
      page, refs, source: source(), fetchedAt: state.candidatesAt, now: now(), meta: state.candidatesMeta,
    });
  }

  // ── confirmation builders ──
  async function closeRequest(positionAddress) {
    const res = await deps.getMyPositions({ force: true });
    if (res?.error) return { view: { text: `⚠️ Could not load positions: ${escapeHtml(res.error)}`, keyboard: [[btn("⬅ Positions", "po:0")]] } };
    const p = (res?.positions || []).find((x) => x.position === positionAddress);
    if (!p) return { view: { text: `Position <code>${escapeHtml(shortAddr(positionAddress))}</code> is no longer open.`, keyboard: [[btn("📊 Positions", "po:0"), btn("⬅ Menu", "m")]] } };
    const nonce = nonces.put("close", { position_address: p.position, label: p.pair || shortAddr(p.position) });
    return { nonce, view: renderCloseConfirm(p, nonce, { unit: unit(), dryRun: isDryRun() }) };
  }

  /** Confirmation card for the final plan. `choice` = the picker's { strategy, priceRangePct }. */
  async function deployRequest(candidate, { strategy = null, priceRangePct = null, warnings = [] } = {}) {
    const usdcMode = !!deps.usdcModeEnabled?.(); // re-read: the mode may have changed mid-picker
    const wallet = usdcMode ? null : await deps.getWalletBalances().catch((e) => ({ error: e.message }));
    const plan = buildDeployPlan(candidate, {
      wallet, config: deps.config, computeDeployAmount: deps.computeDeployAmount, usdcMode, strategy, priceRangePct,
    });
    if (plan.error) return { view: { text: `⚠️ ${escapeHtml(plan.error)}`, keyboard: [[btn("🔍 Candidates", "ca:0"), btn("⬅ Menu", "m")]] } };
    // Read-only entry preview (pool status, fee mode, TWAP) for the card; best
    // effort — deploy_position re-runs every check as a hard gate.
    let entryState = null;
    if (deps.entryPreview) {
      entryState = await Promise.race([
        Promise.resolve().then(() => deps.entryPreview(candidate, { strategy: plan.args.strategy })),
        new Promise((resolve) => setTimeout(() => resolve({ error: "preview timed out" }), ENTRY_PREVIEW_TIMEOUT_MS).unref?.()),
      ]).catch((e) => ({ error: e.message }));
    }
    const nonce = nonces.put("deploy", { args: plan.args, label: candidate.name || shortAddr(candidate.pool) });
    return { nonce, view: renderDeployConfirm(candidate, plan, nonce, { dryRun: isDryRun(), source: source(), warnings, ttlMs: deps.ttlMs ?? CONFIRM_TTL_MS, entryState, entryFilters: deps.config.entryFilters || null }) };
  }

  // ── deploy picker (strategy → range → confirm) ──
  /**
   * Entry point for every manual candidate deploy. Evil Panda keeps its fixed
   * plan (straight to the confirmation card); USDC mode skips the strategy step
   * (Bid-Ask only). `origin` is where Back leads when there is no strategy step.
   */
  async function startPicker(candidate, ctx, opts = {}, { origin = "ca", warnings = [] } = {}) {
    if (deps.config.strategy?.activeStrategy === "evil_panda") {
      return presentConfirm(ctx, await deployRequest(candidate, { warnings }), opts);
    }
    const usdcMode = !!deps.usdcModeEnabled?.();
    const id = steps.put("pick", { candidate, usdcMode, strategy: usdcMode ? "bid_ask" : null, origin, warnings });
    const view = usdcMode
      ? renderRangeStep(candidate, id, "bid_ask", { usdcMode: true })
      : renderStrategyStep(candidate, id, { defaultStrategy: defaultPickerStrategy(deps.config) });
    const msg = await show(ctx, view, opts);
    steps.bind(id, msg?.message_id ?? null, ctx?.chatId ?? msg?.chat?.id ?? null);
    return msg;
  }

  /** Validate a step callback (live id, same chat, same message). Returns the entry or null. */
  async function stepEntry(id, ctx, answer) {
    const r = steps.peek(id);
    if (r.error) {
      logf("telegram_warn", `Refused picker step ${String(id).slice(0, 12)}: ${r.error}`);
      await answer("This menu expired, tap Candidates again.", true);
      if (ctx.messageId != null) {
        await show(ctx, { text: "⌛ This menu expired, tap Candidates again. Nothing was done.", keyboard: [[btn("🔍 Candidates", "ca:0"), btn("⬅ Menu", "m")]] });
      }
      return null;
    }
    const e = r.entry;
    if (e.chatId != null && ctx.chatId != null && String(ctx.chatId) !== e.chatId) {
      logf("telegram_warn", `Refused picker step ${id}: chat mismatch`);
      await answer("This menu belongs to a different chat.", true);
      return null;
    }
    if (e.messageId != null && ctx.messageId !== e.messageId) {
      logf("telegram_warn", `Refused picker step ${id}: message mismatch`);
      await answer("This menu belongs to a different message.", true);
      return null;
    }
    steps.touch(id);
    return e;
  }

  async function pickerCallback(head, id, choice, ctx, answer) {
    const e = await stepEntry(id, ctx, answer);
    if (!e) return;
    const p = e.params;
    const c = p.candidate;

    if (head === "dx") {
      steps.take(id);
      await answer("Cancelled");
      await show(ctx, { text: "✖ Cancelled. Nothing was done.", keyboard: [[btn("🔍 Candidates", "ca:0"), btn("⬅ Menu", "m")]] });
      return;
    }

    if (head === "db") {
      await answer();
      if (p.usdcMode) { // no strategy step in USDC mode: Back leaves the picker
        steps.take(id);
        await show(ctx, await originView(p.origin));
        return;
      }
      p.strategy = null;
      await show(ctx, renderStrategyStep(c, id, { defaultStrategy: defaultPickerStrategy(deps.config) }));
      return;
    }

    if (head === "ds") {
      const strategy = choice === "b" ? "bid_ask" : choice === "s" ? "spot" : null;
      if (!strategy || (p.usdcMode && strategy !== "bid_ask")) {
        await answer("That strategy isn't available here.", true);
        return;
      }
      p.strategy = strategy;
      await answer(STRATEGY_LABELS[strategy]);
      await show(ctx, renderRangeStep(c, id, strategy, { usdcMode: p.usdcMode }));
      return;
    }

    // head === "dr": the range tap builds the confirmation card.
    if (!p.strategy) {
      await answer("Pick a strategy first.", true);
      return;
    }
    const opt = rangeOptions(c, p.strategy).find((o) => o.key === choice);
    if (!opt) {
      await answer("That range isn't available for this pool.", true);
      return;
    }
    if (!steps.take(id).entry) { // single use: a double tap can't build two cards
      await answer("Already used.", true);
      return;
    }
    await answer();
    await presentConfirm(ctx, await deployRequest(c, { strategy: p.strategy, priceRangePct: opt.pct, warnings: p.warnings }));
  }

  // ── token lookup (paste a mint) ──
  /** Card for a cached lookup; registers a Deploy ref per deployable pool. */
  function tokenCardView(tokenRef) {
    const entry = refs.get(tokenRef);
    if (!entry?.result) return { text: "⌛ This lookup expired. Paste the mint again.", keyboard: [[btn("⬅ Menu", "m")]] };
    const r = entry.result;
    const poolRefs = (r.pools || []).map((c) => {
      // Never deployable: blacklisted tokens, pools not quoted in SOL.
      if (r.blacklisted || c.quote?.mint !== WSOL_MINT) return null;
      return refs.put({ kind: "token_pool", tokenRef, candidate: c, warnings: failedFilterLines(c) }, `tp:${c.pool}`);
    });
    return renderTokenCard(r, { tokenRef, poolRefs, source: source(), entryFilters: deps.config.entryFilters || null });
  }

  /** Look a mint up, editing a "Looking up…" message in place with the card. */
  async function tokenLookup(mint, ctx, opts = {}) {
    const loading = { text: `🔎 Looking up <code>${escapeHtml(mint)}</code>…`, keyboard: [] };
    const msg = await show(ctx, loading, opts);
    const target = { ...ctx, messageId: msg?.message_id ?? ctx?.messageId ?? null };
    let result;
    try {
      result = await deps.lookupToken(mint);
    } catch (e) {
      logf("telegram_error", `Token lookup ${mint.slice(0, 8)} failed: ${e.message}`);
      result = { mint, pools: [], total_pools: 0, gmgn: null, error: e.message, checks: { token: [], pool: [] } };
    }
    const tokenRef = refs.put({ kind: "token", mint, result }, `tok:${mint}`);
    return show(target, tokenCardView(tokenRef));
  }

  /** The view Back returns to when a picker has no strategy step. */
  async function originView(origin) {
    if (typeof origin === "function") return origin();
    return candidatesView(0);
  }

  function simpleConfirm(action, params, text, confirmLabel) {
    const nonce = nonces.put(action, params);
    return {
      nonce,
      view: {
        text: `${text}\n\nExpires in ${Math.round((deps.ttlMs ?? CONFIRM_TTL_MS) / 1000)}s.`,
        keyboard: [[btn(confirmLabel, `y:${nonce}`), btn("✖ Cancel", `n:${nonce}`)]],
      },
    };
  }

  async function presentConfirm(ctx, req, opts) {
    const msg = await show(ctx, req.view, opts);
    if (req.nonce) nonces.bind(req.nonce, msg?.message_id ?? null, ctx?.chatId ?? msg?.chat?.id ?? null);
    return msg;
  }

  // ── trading settings ──
  function customPending(chatId = null) {
    const c = state.customDeploy;
    if (!c) return null;
    if (c.expiresAt <= now()) { state.customDeploy = null; return null; }
    if (chatId != null && c.chatId != null && String(chatId) !== c.chatId) return null;
    return c;
  }

  const tradingView = (extra = {}) => renderTradingSettings(deps.config, {
    usdcMode: !!deps.usdcModeEnabled?.(),
    customPending: !!customPending(),
    ...extra,
  });

  /** Apply a planned change set through deps.applyTradingSettings; returns the card note. */
  function applyTrading(changes, { notes = [], warnings = [] } = {}) {
    if (!deps.applyTradingSettings) return { ok: false, error: "not available", note: "⚠️ Trading settings can't be changed here." };
    const r = deps.applyTradingSettings(changes);
    if (!r?.ok) {
      logf("telegram_warn", `Trading settings change failed: ${r?.error}`);
      return { ok: false, error: r?.error ?? "error", note: `⚠️ Not changed: ${escapeHtml(r?.error ?? "error")}` };
    }
    logf("telegram", `Trading settings changed from Telegram: ${r.text}`);
    const out = [`✅ Saved: ${escapeHtml(r.text)}`];
    for (const n of notes) out.push(`ℹ️ ${escapeHtml(n)}`);
    if (r.rescheduled) out.push(`⏱ PnL watcher rescheduled to every ${escapeHtml(r.changes?.pnlWatcherIntervalSec ?? "?")}s.`);
    for (const w of warnings) out.push(`⚠️ ${escapeHtml(w)}`);
    return { ok: true, text: r.text, note: out.join("\n") };
  }

  /**
   * One preset tap (or a custom deploy size). Risk-reducing changes apply at
   * once; risk-increasing ones get a nonce confirm card (60s, single use).
   */
  async function tradingChange(key, value, ctx, answer, opts = {}) {
    const current = readTradingSettings(deps.config);
    const plan = planTradingChange(key, value, current);
    if (plan.error) {
      await answer(`Not changed: ${plan.error}`.slice(0, 180), true);
      return show(ctx, tradingView({ note: `⚠️ Not changed: ${escapeHtml(plan.error)}` }), opts);
    }
    const changed = Object.fromEntries(Object.entries(plan.changes).filter(([k, v]) => {
      if (k === "stopLossPct") return stopLossOff(v) ? !stopLossOff(current[k]) : v !== Number(current[k]);
      if (k === "trailingTakeProfit") return v !== !!current[k];
      return v !== Number(current[k]);
    }));
    if (!Object.keys(changed).length) {
      await answer("Already set.");
      return show(ctx, tradingView(), opts);
    }
    const risk = riskIncreases(changed, current);
    const lines = describeChanges(changed, current);
    if (risk.length) {
      await answer();
      const nonce = nonces.put("trade_set", { changes: changed, notes: plan.notes, warnings: plan.warnings, label: lines.join("; ") });
      logf("telegram", `Trading settings confirm requested: ${lines.join("; ")} (${risk.join(", ")})`);
      const text = [
        "⚠️ <b>Raise risk?</b>",
        ...lines.map((l) => `<b>${escapeHtml(l)}</b>`),
        "",
        `This ${escapeHtml(risk.join(" and "))}.`,
        ...plan.notes.map((n) => `ℹ️ ${escapeHtml(n)}`),
        ...plan.warnings.map((w) => `⚠️ ${escapeHtml(w)}`),
        "",
        `Saves to user-config.json and applies to the running bot. Expires in ${Math.round((deps.ttlMs ?? CONFIRM_TTL_MS) / 1000)}s.`,
      ].join("\n");
      return presentConfirm(ctx, {
        nonce,
        view: { text, keyboard: [[btn("✅ Confirm change", `y:${nonce}`), btn("✖ Cancel", `n:${nonce}`)]] },
      }, opts);
    }
    const r = applyTrading(changed, plan);
    await answer(r.ok ? `Saved: ${r.text}`.slice(0, 180) : `Not changed: ${r.error}`.slice(0, 180), !r.ok);
    return show(ctx, tradingView({ note: r.note }), opts);
  }

  // ── execution (Confirm tap) ──
  async function execute(entry, ctx) {
    const edit = (text, keyboard = [[btn("📊 Positions", "po:0"), btn("⬅ Menu", "m")]]) =>
      show(ctx, { text, keyboard });
    const { action, params } = entry;

    // The bot runs one trade/cycle at a time. When it's busy, say plainly that
    // nothing happened and offer a Retry — a fresh single-use confirm with the
    // exact same parameters (still a deliberate tap; the deploy/close guards,
    // e.g. no duplicate pool, run again on retry).
    const busyRetry = async (kind, p, verb) => {
      const retryNonce = nonces.put(kind, p, { chatId: ctx?.chatId ?? null });
      const msg = await show(ctx, {
        text:
          `⏳ <b>Not ${verb}</b> — the bot is busy with another cycle or trade (e.g. a screening cycle that may itself be deploying).\n` +
          `Your ${kind} of <b>${escapeHtml(p.label)}</b> did <b>NOT</b> run. Check Positions, then Retry if you still want it (expires in ${Math.round(CONFIRM_TTL_MS / 1000)}s).`,
        keyboard: [[btn(`🔁 Retry ${kind}`, `y:${retryNonce}`), btn("📊 Positions", "po:0")], [btn("⬅ Menu", "m")]],
      });
      // Bind to this chat + message like every confirm card.
      nonces.bind(retryNonce, msg?.message_id ?? ctx?.messageId ?? null, ctx?.chatId ?? msg?.chat?.id ?? null);
      return msg;
    };

    if (action === "close") {
      await edit(`⏳ Closing ${escapeHtml(params.label)}…`, []);
      const r = await deps.runExclusive(() => deps.executeTool("close_position", { position_address: params.position_address }));
      if (r.busy) return busyRetry("close", params, "closed");
      return edit(renderExecResult("close", params.label, r.value));
    }

    if (action === "deploy") {
      await edit(`⏳ Deploying into ${escapeHtml(params.label)}…`, []);
      const r = await deps.runExclusive(() => deps.executeTool("deploy_position", { ...params.args }), { screening: true });
      if (r.busy) return busyRetry("deploy", params, "deployed");
      try { await deps.afterDeploy?.(); } catch { /* best-effort */ }
      return edit(renderExecResult("deploy", params.label, r.value));
    }

    if (action === "auto") {
      await edit("🤖 Agent is picking and deploying…", []);
      const r = await deps.runExclusive(() => deps.autoDeploy(), { screening: true });
      if (r.busy) return edit(`⏳ Agent is busy — nothing was deployed. Try again in a moment.`);
      try { await deps.afterDeploy?.(); } catch { /* best-effort */ }
      return edit(`🤖 <b>Auto deploy finished</b>\n${escapeHtml(clipText(String(r.value ?? ""), PAGE_CHAR_BUDGET))}`);
    }

    if (action === "screen") {
      const run = deps.runScreeningNow();
      if (!run.started) return edit(`⏳ Screening not started: ${escapeHtml(run.reason)}.`, [[btn("🎛 Controls", "bc"), btn("⬅ Menu", "m")]]);
      await edit("🔍 Screening cycle running… the report arrives as a separate message.", [[btn("📈 Status", "st"), btn("⬅ Menu", "m")]]);
      const report = await run.done;
      return edit(`🔍 <b>Screening cycle finished</b>\n${escapeHtml(clipText(String(report ?? "no report"), 1500))}`, [[btn("📊 Positions", "po:0"), btn("⬅ Menu", "m")]]);
    }

    if (action === "trade_set") {
      const r = applyTrading(params.changes, params);
      return show(ctx, tradingView({ note: r.note }));
    }

    if (action === "ar_approve" || action === "ar_reject") {
      const out = deps.handleAutoresearchCommand(action === "ar_approve" ? "approve" : "reject");
      return edit(`🧪 ${escapeHtml(out)}`, [[btn("🧪 Autoresearch", "ar"), btn("⬅ Menu", "m")]]);
    }

    return edit("Unknown action — nothing was done.");
  }

  // ── public: text messages ──
  /** Returns true when the UI handled the text; false lets the legacy handler run. */
  async function handleMessage(rawText, ctx = {}) {
    const text = String(rawText || "").trim();
    const lower = text.toLowerCase();

    if (text === "/start") {
      await deps.tg.sendHTML("👋 Meridian control. Use the menu below, or /help for text commands.", {
        reply_markup: { keyboard: [[{ text: MENU_BUTTON_TEXT }]], resize_keyboard: true, is_persistent: true },
      });
      await show(null, renderMainMenu({ header: await menuHeader() }), { fresh: true });
      return true;
    }
    if (text === "/menu" || text === MENU_BUTTON_TEXT || lower === "menu") {
      await show(null, renderMainMenu({ header: await menuHeader() }), { fresh: true });
      return true;
    }

    if (text === "/candidates") {
      await deps.tg.sendHTML("🔍 Screening candidates…");
      try {
        await loadCandidates();
      } catch (e) {
        await deps.tg.sendHTML(`❌ Screening failed: ${escapeHtml(e.message)}`);
        return true;
      }
      await show(null, candidatesView(0), { fresh: true });
      return true;
    }

    // "Custom…" deploy size: the owner's next numeric message sets it.
    if (customPending(ctx.chatId) && /^\s*[\d.,]+\s*(?:sol)?\s*$/i.test(text)) {
      const parsed = parseCustomDeploySize(text);
      if (parsed.error) {
        logf("telegram_warn", `Custom deploy size refused: ${parsed.error}`);
        await deps.tg.sendHTML(`⚠️ ${escapeHtml(parsed.error)}. Send a size between ${DEPLOY_SIZE_MIN_SOL} and ${DEPLOY_SIZE_MAX_SOL} SOL, or tap Cancel.`, {
          reply_markup: { inline_keyboard: [[btn("✖ Cancel custom size", "tq"), btn("⚙️ Trading settings", "ts")]] },
        });
        return true;
      }
      state.customDeploy = null; // single use
      await tradingChange("deployAmountSol", parsed.value, { chatId: ctx.chatId }, async () => {}, { fresh: true });
      return true;
    }

    const pick = parseInt(text, 10);
    if (!Number.isNaN(pick) && String(pick) === text) {
      const c = state.candidates[pick - 1];
      if (pick < 1 || !c) {
        await deps.tg.sendHTML(`No pool #${pick} in the current list. Send /candidates first.`);
        return true;
      }
      await startPicker(c, { chatId: ctx.chatId }, { fresh: true });
      return true;
    }

    // Token lookup: "/token <mint>", "/lookup <mint>", or a bare mint.
    const tokenCmd = /^\/(?:token|lookup)(?:@\w+)?(?:\s+(.*))?$/i.exec(text);
    if (tokenCmd && deps.lookupToken) {
      const mint = tokenCmd[1] ? await deps.parseMint(tokenCmd[1].trim()) : null;
      if (!mint) {
        await deps.tg.sendHTML("Usage: <code>/token &lt;mint&gt;</code> (a Solana token address). You can also just paste the mint.");
        return true;
      }
      await tokenLookup(mint, { chatId: ctx.chatId }, { fresh: true });
      return true;
    }
    if (deps.lookupToken && deps.parseMint && !/\s/.test(text)) {
      const mint = await deps.parseMint(text);
      if (mint) {
        await tokenLookup(mint, { chatId: ctx.chatId }, { fresh: true });
        return true;
      }
    }

    if (lower === "auto") {
      const amount = deps.usdcModeEnabled?.() ? `$${deps.config.usdc?.deployAmountUsd} (USDC mode)` : "the wallet-scaled amount";
      await presentConfirm({ chatId: ctx.chatId }, simpleConfirm("auto", {}, `🤖 <b>Auto deploy?</b>${isDryRun() ? " (DRY RUN)" : ""}\nThe agent screens, picks the best pool and deploys ${escapeHtml(amount)} with the active strategy.`, "✅ Confirm auto deploy"), { fresh: true });
      return true;
    }

    return false;
  }

  async function menuHeader() {
    const paused = !!deps.isScreeningPaused?.();
    return `Mode: <b>${isDryRun() ? "DRY RUN" : "LIVE"}</b> · screening ${paused ? "⏸ paused" : "▶️ on"}`;
  }

  // ── public: callbacks ──
  async function handleCallback(data, ctx = {}) {
    const fresh = data.endsWith("!");
    const d = fresh ? data.slice(0, -1) : data;
    const [head, arg, sub] = d.split(":");
    const opts = { fresh };
    let answered = false;
    const answer = async (text = "", alert = false) => {
      if (answered) return;
      answered = true;
      await deps.tg.answerCallback(ctx.callbackId, text, alert);
    };

    try {
      switch (head) {
        case "m":
          await answer();
          await show(ctx, renderMainMenu({ header: await menuHeader() }), opts);
          return;
        case "st":
          await answer();
          await show(ctx, renderStatus(await statusInfo(), now()), opts);
          return;
        case "wa": {
          // Read-only. Refresh (wa:r) forces a fresh position scan; the first
          // open reuses the positions cache.
          await answer(arg === "r" ? "Refreshing…" : "");
          const [wallet, positions] = await Promise.all([
            deps.getWalletBalances().catch((e) => ({ error: e.message })),
            deps.getMyPositions ? deps.getMyPositions(arg === "r" ? { force: true } : {}).catch((e) => ({ error: e.message })) : null,
          ]);
          await show(ctx, renderWallet(wallet, { config: deps.config, usdcMode: !!deps.usdcModeEnabled?.(), positions }), opts);
          return;
        }
        case "po": {
          await answer();
          const res = await deps.getMyPositions({}).catch((e) => ({ error: e.message }));
          await show(ctx, renderPositions(res, { page: Number(arg) || 0, refs, unit: unit() }), opts);
          return;
        }
        case "ca":
          await answer();
          if (!state.candidatesAt) await loadCandidates().catch((e) => logf("telegram_error", `Candidates load failed: ${e.message}`));
          await show(ctx, candidatesView(Number(arg) || 0), opts);
          return;
        case "cs":
          await answer("Screening…");
          await show(ctx, { text: "🔍 Screening candidates…", keyboard: [] }, opts);
          try {
            await loadCandidates();
            await show(ctx, candidatesView(0));
          } catch (e) {
            await show(ctx, { text: `❌ Screening failed: ${escapeHtml(e.message)}`, keyboard: [[btn("🔄 Retry", "cs"), btn("⬅ Menu", "m")]] });
          }
          return;
        case "se": {
          await answer();
          const report = deps.buildSettingsReport();
          const view = renderTextPages("⚙️ <b>Settings</b>", report, { page: Number(arg) || 0, prefix: "se" });
          const extraRow = [btn("⚙️ Trading settings", "ts")];
          if (deps.setEntryFilter) extraRow.unshift(btn("🛡 Entry filters", "ef"));
          view.keyboard.push(extraRow);
          view.keyboard.push(backRow(`se:${view.page}`));
          await show(ctx, view, opts);
          return;
        }
        case "bc":
          await answer();
          await show(ctx, renderControls(await statusInfo()), opts);
          return;
        case "ef":
          await answer();
          await show(ctx, renderEntryFilters(deps.config.entryFilters), opts);
          return;
        case "et":
        case "ev": {
          // Owner-only (transport), edited in place, no 2-tap confirm: these
          // tighten/loosen filters and never move funds. Every change is logged.
          if (!deps.setEntryFilter) {
            await answer("Entry filters can't be changed here.", true);
            return;
          }
          let key;
          let value;
          if (head === "et") {
            key = ENTRY_TOGGLES.find(([code]) => code === arg)?.[1];
            if (key) value = !deps.config.entryFilters?.[key];
          } else {
            const p = ENTRY_PRESETS[arg];
            const v = sub === "off" ? null : Number(sub);
            if (p && p.values.includes(v)) { key = p.key; value = v; }
          }
          if (!key) {
            await answer("Unknown filter.", true);
            return;
          }
          const r = await deps.setEntryFilter(key, value);
          if (!r?.ok) {
            logf("telegram_warn", `Entry filter ${key} change failed: ${r?.error}`);
            await answer(`Not changed: ${r?.error ?? "error"}`.slice(0, 180), true);
            await show(ctx, renderEntryFilters(deps.config.entryFilters, { note: `⚠️ Not changed: ${escapeHtml(r?.error ?? "error")}` }), opts);
            return;
          }
          logf("telegram", `Entry filter changed from Telegram: ${r.text}`);
          await answer(`Saved: ${r.text}`.slice(0, 180));
          await show(ctx, renderEntryFilters(deps.config.entryFilters, { note: `✅ Saved: ${escapeHtml(r.text)}${r.loosened ? " (loosened)" : ""}` }), opts);
          return;
        }
        case "ts":
          await answer();
          await show(ctx, tradingView(), opts);
          return;
        case "tv": {
          // Owner-only (transport), edited in place. Risk-raising presets go
          // through the nonce confirm; the rest apply in one tap. All logged.
          const preset = decodePreset(arg, sub);
          if (!preset) {
            logf("telegram_warn", `Unknown trading preset: ${d.slice(0, 20)}`);
            await answer("Unknown preset.", true);
            return;
          }
          await tradingChange(preset.key, preset.value, ctx, answer, opts);
          return;
        }
        case "tc":
          state.customDeploy = { chatId: ctx.chatId != null ? String(ctx.chatId) : null, expiresAt: now() + (deps.ttlMs ?? CONFIRM_TTL_MS) };
          await answer("Send the size in SOL");
          await show(ctx, tradingView(), opts);
          return;
        case "tq":
          state.customDeploy = null;
          await answer("Cancelled");
          await show(ctx, tradingView({ note: "✖ Custom size cancelled. Nothing was changed." }), opts);
          return;
        case "sp": {
          const pause = arg === "1";
          deps.setScreeningPaused(pause);
          await answer(pause ? "Screening paused" : "Screening resumed");
          await show(ctx, renderControls(await statusInfo()), opts);
          return;
        }
        case "sn": {
          await answer();
          await presentConfirm(ctx, simpleConfirm("screen", {}, `🔍 <b>Run a screening cycle now?</b>${isDryRun() ? " (DRY RUN)" : ""}\nThe screener may DEPLOY into the best candidate, exactly like the scheduled cycle. It won't overlap a running cycle.${deps.isScreeningPaused?.() ? "\n⏸ Scheduled screening is paused; this runs once anyway." : ""}`, "✅ Confirm run"), opts);
          return;
        }
        case "ar": {
          await answer();
          const out = deps.handleAutoresearchCommand("status");
          const view = renderTextPages("🧪 <b>Autoresearch</b>", out.split("\n\n/autoresearch")[0], { prefix: "ar" });
          view.keyboard = [
            [btn("📋 List overrides", "al:0")],
            [btn("✅ Approve pending", "aa"), btn("❌ Reject pending", "aj")],
            [btn("🔄 Refresh", "ar"), btn("⬅ Controls", "bc")],
          ];
          await show(ctx, view, opts);
          return;
        }
        case "al": {
          await answer();
          const view = renderTextPages("🧪 <b>Autoresearch overrides</b>", deps.handleAutoresearchCommand("list"), { page: Number(arg) || 0, prefix: "al" });
          view.keyboard.push([btn("⬅ Autoresearch", "ar")]);
          await show(ctx, view, opts);
          return;
        }
        case "aa":
        case "aj": {
          await answer();
          const status = deps.handleAutoresearchCommand("status");
          const pendingLine = status.split("\n").find((l) => l.startsWith("Pending proposal:")) || "Pending proposal: ?";
          if (/Pending proposal: none/.test(pendingLine)) {
            await show(ctx, { text: "🧪 No pending proposal.", keyboard: [[btn("⬅ Autoresearch", "ar")]] }, opts);
            return;
          }
          const approve = head === "aa";
          await presentConfirm(ctx, simpleConfirm(approve ? "ar_approve" : "ar_reject", {}, `🧪 <b>${approve ? "Approve" : "Reject"} the pending proposal?</b>\n${escapeHtml(pendingLine)}`, approve ? "✅ Confirm approve" : "✅ Confirm reject"), opts);
          return;
        }
        case "er": {
          await answer();
          const { file, lines } = deps.readRecentErrors();
          const body = lines.length ? lines.join("\n") : "No ERROR/WARN lines in the current log.";
          const view = renderTextPages(`🧯 <b>Recent errors</b>${file ? ` (${escapeHtml(file)})` : ""}`, body, { prefix: "er" });
          view.text = clipText(view.text, PAGE_CHAR_BUDGET);
          view.keyboard = [[btn("🔄 Refresh", "er"), btn("⬅ Controls", "bc")]];
          await show(ctx, view, opts);
          return;
        }
        case "pc": {
          const addr = refs.get(arg);
          if (!addr) {
            await answer("That button is stale — reopen Positions.", true);
            return;
          }
          await answer();
          await presentConfirm(ctx, await closeRequest(addr), opts);
          return;
        }
        case "dp": {
          const c = refs.get(arg);
          if (!c) {
            await answer("That button is stale — reopen Candidates.", true);
            return;
          }
          await answer();
          await startPicker(c, ctx, opts);
          return;
        }
        case "tr": {
          const entry = refs.get(arg);
          if (entry?.kind !== "token") {
            await answer("That button is stale — paste the mint again.", true);
            return;
          }
          await answer("Refreshing…");
          await tokenLookup(entry.mint, ctx, opts);
          return;
        }
        case "tp": {
          const entry = refs.get(arg);
          if (entry?.kind !== "token_pool") {
            await answer("That button is stale — paste the mint again.", true);
            return;
          }
          const token = refs.get(entry.tokenRef);
          if (token?.result?.blacklisted || entry.candidate.quote?.mint !== WSOL_MINT) {
            await answer("This pool can't be deployed into (blacklisted or not SOL-quoted).", true);
            return;
          }
          await answer();
          await startPicker(entry.candidate, ctx, opts, { origin: () => tokenCardView(entry.tokenRef), warnings: entry.warnings });
          return;
        }
        case "ds":
        case "dr":
        case "db":
        case "dx":
          await pickerCallback(head, arg, sub, ctx, answer);
          return;
        case "y": {
          const peek = nonces.peek(arg);
          if (peek.error) {
            logf("telegram_warn", `Refused confirm ${arg}: ${peek.error} nonce`);
            await answer(peek.error === "expired" ? "Expired — nothing was done." : "Unknown or already used — nothing was done.", true);
            // Only rewrite the card on expiry; an already-used nonce's card shows the real result.
            if (peek.error === "expired" && ctx.messageId != null) await show(ctx, { text: "⌛ This confirmation expired. Nothing was done.", keyboard: [[btn("⬅ Menu", "m")]] });
            return;
          }
          const e = peek.entry;
          if (e.chatId != null && ctx.chatId != null && String(ctx.chatId) !== e.chatId) {
            logf("telegram_warn", `Refused confirm ${arg}: chat mismatch`);
            await answer("This confirmation belongs to a different chat.", true);
            return;
          }
          if (e.messageId != null && ctx.messageId !== e.messageId) {
            logf("telegram_warn", `Refused confirm ${arg}: message mismatch`);
            await answer("This confirmation belongs to a different message.", true);
            return;
          }
          const taken = nonces.take(arg); // single-use: consumed before executing
          if (!taken.entry) {
            await answer("Already used — nothing was done.", true);
            return;
          }
          logf("telegram", `Confirmed ${e.action} ${JSON.stringify(e.params).slice(0, 200)}`);
          await answer("Executing…");
          try {
            await execute(taken.entry, ctx);
          } catch (err) {
            logf("telegram_error", `${e.action} failed: ${err.message}`);
            await show(ctx, { text: `❌ <b>${escapeHtml(e.action)} failed</b>\n${escapeHtml(err.message)}`, keyboard: [[btn("📊 Positions", "po:0"), btn("⬅ Menu", "m")]] });
          }
          return;
        }
        case "n": {
          const r = nonces.take(arg);
          await answer(r.entry ? "Cancelled" : "Nothing to cancel");
          if (r.entry?.action === "trade_set") logf("telegram", `Trading settings change cancelled: ${r.entry.params.label}`);
          const back = r.entry?.action === "trade_set" ? [[btn("⚙️ Trading settings", "ts"), btn("⬅ Menu", "m")]] : [[btn("⬅ Menu", "m")]];
          await show(ctx, { text: "✖ Cancelled. Nothing was done.", keyboard: back });
          return;
        }
        default:
          logf("telegram_warn", `Unknown callback data: ${d.slice(0, 20)}`);
          await answer("Unknown button.");
      }
    } catch (e) {
      logf("telegram_error", `Callback ${head} failed: ${e.message}`);
      await answer(`Error: ${e.message}`.slice(0, 180), true);
    } finally {
      if (!answered) await answer();
    }
  }

  // ── alerts ──
  const FUND_EVENTS = new Set(["deploy", "close", "pnl_watcher_close", "deploy_partial"]);
  function alert(kind, key, cooldownMs, text, keyboard = []) {
    if (!FUND_EVENTS.has(kind) && !limiter.allow(`${kind}:${key}`, cooldownMs)) {
      logf("telegram", `Alert suppressed (rate limit): ${kind} ${key}`);
      return Promise.resolve(null);
    }
    return deps.tg.sendHTML(text, { reply_markup: { inline_keyboard: keyboard } });
  }

  const positionsBtn = () => btn("📊 Positions", "po:0!");
  const closeBtn = (position) => btn("🔒 Close…", `pc:${refs.put(position, `pos:${position}`)}!`);

  function fmtAlertPnl(d) {
    const u = unit();
    if (d.pnlPct == null) return "PnL: unknown";
    const abs = u === "sol" && d.pnlSol != null ? `${fmtSigned(d.pnlSol, 4)} SOL` : d.pnlUsd != null ? `${fmtSigned(d.pnlUsd, 2).replace(/^([+-])/, "$1$")}` : "";
    return `PnL: ${abs} (${fmtSigned(d.pnlPct, 2)}%)`;
  }

  const handlers = {
    deploy: (d) => {
      const amount = d.amountUsd != null ? `$${fmtNum(d.amountUsd, 2)} (${fmtNum(d.amountSol, 4)} SOL)` : `${fmtNum(d.amountSol, 4)} SOL`;
      const kb = [[positionsBtn(), ...(d.position ? [closeBtn(d.position)] : [])]];
      if (d.pool) kb.push([urlBtn("Meteora ↗", meteoraPoolUrl(d.pool))]);
      return alert("deploy", d.position, 0, [
        `✅ <b>Deployed</b> ${escapeHtml(d.pair)}`,
        `Amount: ${amount}`,
        d.position ? `Position: <code>${escapeHtml(shortAddr(d.position))}</code>` : null,
        txLinks(d.txs ?? d.tx) || null,
      ].filter(Boolean).join("\n"), kb);
    },
    close: (d) => alert("close", d.position, 0, [
      `🔒 <b>Closed</b> ${escapeHtml(d.pair)}`,
      fmtAlertPnl(d),
      txLinks(d.txs) || null,
    ].filter(Boolean).join("\n"), [[positionsBtn()]]),
    pnl_watcher_close: (d) => alert("pnl_watcher_close", d.position, 0, [
      `⚡ <b>${/stop|loss/i.test(d.reason || "") ? "Stop-loss" : /tp|profit|trail/i.test(d.reason || "") ? "Take-profit" : "Exit"} hit — auto-closed</b> ${escapeHtml(d.pair)}`,
      escapeHtml(d.reason ?? ""),
      fmtAlertPnl(d),
      txLinks(d.txs) || null,
    ].filter(Boolean).join("\n"), [[positionsBtn()]]),
    deploy_partial: (d) => alert("deploy_partial", d.position, 0, [
      `⚠️ <b>Partial deploy</b> ${escapeHtml(d.pair)}`,
      `Position <code>${escapeHtml(shortAddr(d.position))}</code> is ${escapeHtml(d.status)} after a liquidity-add failure: ${escapeHtml(String(d.error ?? "").slice(0, 300))}`,
      `X=${escapeHtml(d.amountX ?? "?")} Y=${escapeHtml(d.amountY ?? "?")}`,
      "Kept OPEN for management — check it.",
    ].join("\n"), [[positionsBtn(), ...(d.position ? [closeBtn(d.position)] : [])]]),
    out_of_range: (d) => alert("out_of_range", d.pair, 6 * 60 * 60_000,
      `⚠️ <b>Out of range</b> ${escapeHtml(d.pair)} for ${escapeHtml(d.minutesOOR)} min`,
      [[positionsBtn()]]),
    gas_low: (d) => alert("gas_low", "gas", 2 * 60 * 60_000,
      `⛽ <b>Gas low — deploy paused</b>\n${escapeHtml(d.reason || `Native SOL ${d.sol} is below the gas reserve${d.reserve != null ? ` of ${d.reserve} SOL` : ""}.`)}\nTop up SOL to resume USDC-mode deploys.`,
      [[btn("💰 Wallet", "wa!")]]),
    cycle_error: (d) => alert("cycle_error", `${d.cycle}:${String(d.error).slice(0, 60)}`, 15 * 60_000,
      `❌ <b>${escapeHtml(d.cycle)} cycle failed</b>\n${escapeHtml(String(d.error ?? "").slice(0, 500))}`,
      [[btn("🧯 Recent errors", "er!")]]),
    // Cycle reports: always recorded for the Status view, but pushed only when
    // something happened. `routine` (set by index.js) means nothing did: a
    // code-only HOLD, an LLM pass that changed nothing, a screen that deployed
    // nothing. Failures are covered by the cycle_error alert.
    "cycle:management": ({ report, routine }) => {
      state.lastManagement = { at: now(), summary: String(report ?? "").slice(0, 400) };
      if (routine || /^Management cycle failed:/.test(report ?? "")) return null;
      return sendReport("🔄 <b>Management cycle</b>", report);
    },
    "cycle:screening": ({ report, routine }) => {
      state.lastScreening = { at: now(), summary: String(report ?? "").slice(0, 400) };
      if (routine || /^Screening cycle failed:/.test(report ?? "")) return null;
      return sendReport("🔍 <b>Screening cycle</b>", report);
    },
    briefing: ({ html }) => deps.tg.sendHTML(String(html ?? "")),
  };

  async function sendReport(title, report) {
    const pages = paginateText(escapeHtml(String(report ?? "")), PAGE_CHAR_BUDGET - 100);
    for (let i = 0; i < pages.length; i++) {
      const last = i === pages.length - 1;
      await deps.tg.sendHTML(`${i === 0 ? `${title}\n\n` : ""}${pages[i]}`, last
        ? { reply_markup: { inline_keyboard: [[positionsBtn(), btn("🏠 Menu", "m!")]] } }
        : {});
    }
  }

  /** Subscribe alert handlers to the notifier hub. */
  function attachAlerts(on) {
    for (const [event, fn] of Object.entries(handlers)) {
      on(event, (data) => {
        Promise.resolve()
          .then(() => fn(data || {}))
          .catch((e) => logf("telegram_error", `Alert ${event} failed: ${e.message}`));
      });
    }
  }

  return {
    handleMessage,
    handleCallback,
    attachAlerts,
    alerts: handlers,
    nonces,
    steps,
    refs,
    state,
    loadCandidates,
    getCandidates: () => state.candidates,
  };
}
