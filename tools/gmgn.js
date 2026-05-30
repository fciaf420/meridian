/**
 * GMGN enrichment for screening (drop-in replacement for tools/okx.js).
 * Solana only (--chain sol). Shells out to the locally-installed `gmgn-cli`
 * binary with `--raw` for single-line JSON, parses stdout, degrades to null.
 *
 *   fetchGmgnPriceInfo  -> price, momentum, volumes, ATH proximity, candle summary
 *   fetchGmgnSignal     -> per-token smart-money / KOL / whale conviction signal
 *
 * Return field names are kept identical to okx.js so consumers don't change.
 *
 * DATA SOURCES (verified live against gmgn-cli with a configured GMGN_API_KEY):
 *   - `token info` (/v1/token/info) is the backbone for BOTH functions:
 *       * `price` is an OBJECT: { price, price_5m, price_1h, price_6h, price_24h,
 *         volume_5m, volume_1h, ... } — gives exact momentum + per-window volume.
 *       * top-level `ath_price` is the true all-time-high (used for ATH proximity).
 *       * `wallet_tags_stat`: { smart_wallets, renowned_wallets, whale_wallets, ... }
 *         — per-token tagged-holder counts = the conviction signal.
 *       * `stat`: { holder_count, signal_count, degen_call_count } — GMGN-native signal.
 *     Both functions share one cached token-info fetch (one CLI spawn per mint).
 *   - `market kline` (/v1/market/token_kline) — only for the 6x5m candle summary
 *     and min-price; returns { list: [ { time(ms), open, close, high, low, volume } ] }.
 *   - `track smartmoney` / `track kol` (/v1/user/{smartmoney,kol}) — GLOBAL recent
 *     trade feed (NOT per-token-queryable). Used as an OVERLAY to add trade recency,
 *     USD flow, and sold-ratio WHEN the candidate mint happens to appear in the feed.
 */

import { execFile } from "node:child_process";
import { log } from "../logger.js";

const GMGN_BIN = "gmgn-cli";
const CHAIN = "sol";

// Spawn limits.
const SPAWN_TIMEOUT_MS = 15_000;
const SPAWN_MAX_BUFFER = 8 * 1024 * 1024; // 8MB — kline/track feeds can be large.

// Caches (mirror okx.js TTLs).
const TOKEN_INFO_TTL = 60_000;
const PRICE_CACHE_TTL = 60_000;
const SIGNAL_CACHE_TTL = 30_000;
const SIGNAL_EMPTY_TTL = 60_000;
const TRACK_SNAPSHOT_TTL = 30_000;
const TRACK_EMPTY_TTL = 60_000;

// GMGN uses a leaky-bucket limiter (rate=10/cap=10). Serialize spawns with a
// min-gap so we never burst; a 429 -> RATE_LIMIT_BANNED can extend the ban.
const GMGN_MIN_REQUEST_GAP_MS = 200;

// Global track feed size — recent trades across all tokens, filtered to the mint.
const TRACK_LIMIT = 200;

// Kline window: 5m candles over the last ~6h for the candle summary + min price.
const KLINE_RESOLUTION = "5m";
const KLINE_WINDOW_SECONDS = 6 * 60 * 60;

const _tokenInfoCache = new Map();
const _priceCache = new Map();
const _signalCache = new Map();

let _trackSnapshot = null;
let _trackSnapshotExpiresAt = 0;
let _trackSnapshotInflight = null;

let _gmgnRequestChain = Promise.resolve();
let _lastGmgnRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialized request queue with a min-gap between gmgn-cli spawns.
 * Same idea as okx.js queueOkxRequest — protects the leaky-bucket limiter.
 */
async function queueGmgnRequest(task) {
  const run = _gmgnRequestChain.then(async () => {
    const waitMs = Math.max(0, GMGN_MIN_REQUEST_GAP_MS - (Date.now() - _lastGmgnRequestAt));
    if (waitMs > 0) await sleep(waitMs);
    try {
      return await task();
    } finally {
      _lastGmgnRequestAt = Date.now();
    }
  });

  _gmgnRequestChain = run.catch(() => {});
  return run;
}

function readCache(cache, key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function writeCache(cache, key, data, ttlMs) {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

function looksRateLimited(text) {
  if (!text) return false;
  return /RATE_LIMIT|429/i.test(text);
}

/**
 * Spawn `gmgn-cli <...args> --raw`, JSON.parse stdout. The CLI prints the
 * unwrapped API `data` object (e.g. the token object, or { list: [...] }) on
 * success and exits non-zero (error on stderr) on failure. Returns null on
 * spawn/timeout/non-zero/parse/rate-limit.
 */
function spawnGmgn(args) {
  return queueGmgnRequest(
    () =>
      new Promise((resolve) => {
        const fullArgs = [...args, "--raw"];
        execFile(
          GMGN_BIN,
          fullArgs,
          { timeout: SPAWN_TIMEOUT_MS, maxBuffer: SPAWN_MAX_BUFFER },
          (error, stdout, stderr) => {
            if (error) {
              const blob = `${stderr || ""}${error.message || ""}`;
              if (looksRateLimited(blob)) {
                log("gmgn", `Rate limited: ${args.join(" ")}`);
              } else if (error.killed) {
                log("gmgn", `Timeout: ${args.join(" ")}`);
              } else {
                log("gmgn", `Spawn error (${args.join(" ")}): ${(stderr || error.message || "").trim().slice(0, 200)}`);
              }
              resolve(null);
              return;
            }

            const out = (stdout || "").trim();
            if (!out) {
              resolve(null);
              return;
            }

            try {
              resolve(JSON.parse(out));
            } catch (e) {
              log("gmgn", `Parse error (${args.join(" ")}): ${e.message}`);
              resolve(null);
            }
          },
        );
      }),
  );
}

function toNum(v) {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function pct(cur, ref) {
  const c = toNum(cur);
  const r = toNum(ref);
  if (!(r > 0)) return 0;
  return Math.round(((c - r) / r) * 10000) / 100;
}

function formatUsd(value) {
  if (value == null || Number.isNaN(value)) return "$0";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${Math.round(value)}`;
}

/* ============================== TOKEN INFO (shared) ============================== */

/**
 * Fetch + cache `token info` once per mint; both price and signal read from it.
 */
async function fetchTokenInfo(mint) {
  const cached = readCache(_tokenInfoCache, mint);
  if (cached !== null) return cached || null; // cached `false` => known-miss
  const info = await spawnGmgn(["token", "info", "--chain", CHAIN, "--address", mint]);
  writeCache(_tokenInfoCache, mint, info || false, TOKEN_INFO_TTL);
  return info || null;
}

/* ============================== PRICE / CANDLES ============================== */

/**
 * Fetch 5m klines for the candle summary + min price.
 * Returns candles sorted oldest -> newest, or null.
 */
async function fetchKlines(mint) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - KLINE_WINDOW_SECONDS;
  const json = await spawnGmgn([
    "market", "kline", "--chain", CHAIN, "--address", mint,
    "--resolution", KLINE_RESOLUTION, "--from", String(from), "--to", String(now),
  ]);

  if (!json) return null;
  const list = Array.isArray(json) ? json : Array.isArray(json?.list) ? json.list : null;
  if (!list?.length) return null;

  const candles = list
    .map((c) => ({
      time: toNum(c?.time),
      open: toNum(c?.open),
      close: toNum(c?.close),
      high: toNum(c?.high),
      low: toNum(c?.low),
      volume: toNum(c?.volume), // USD
    }))
    .filter((c) => c.time > 0)
    .sort((a, b) => a.time - b.time);

  return candles.length ? candles : null;
}

/**
 * Summarize the most recent 6x 5m candles into actionable signals.
 * Algorithm reused verbatim from okx.js fetchCandleSummary.
 */
function summarizeCandles(allCandles) {
  if (!allCandles?.length) return null;
  const candles = allCandles.slice(-6);
  if (!candles.length) return null;

  const vols = candles.map((c) => c.volume);
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const firstAvg = vols.slice(0, 3).reduce((s, v) => s + v, 0) / 3;
  const lastAvg = vols.slice(-3).reduce((s, v) => s + v, 0) / 3;
  const volume_trend =
    lastAvg > firstAvg * 1.2 ? "increasing" : lastAvg < firstAvg * 0.8 ? "decreasing" : "stable";
  const volume_dying = vols.filter((v) => v < 10).length >= 3;

  const firstClose = closes[0] || 0;
  const lastClose = closes[closes.length - 1] || 0;
  const changePct = firstClose > 0 ? ((lastClose - firstClose) / firstClose) * 100 : 0;
  const price_direction = changePct > 2 ? "up" : changePct < -2 ? "down" : "ranging";

  const allHigh = Math.max(...highs);
  const positiveLows = lows.filter((l) => l > 0);
  const allLow = positiveLows.length ? Math.min(...positiveLows) : 0;
  const price_range_pct = allLow > 0 ? Math.round(((allHigh - allLow) / allLow) * 1000) / 10 : 0;

  const mid = Math.floor(closes.length / 2);
  const firstHalfChange = mid > 0 && closes[0] > 0 ? (closes[mid] - closes[0]) / closes[0] : 0;
  const secondHalfChange =
    closes[mid] > 0 ? (closes[closes.length - 1] - closes[mid]) / closes[mid] : 0;
  let acceleration = "steady";
  if (Math.abs(secondHalfChange) > Math.abs(firstHalfChange) * 1.5) {
    acceleration = secondHalfChange > 0 ? "accelerating_up" : "accelerating_down";
  } else if (Math.abs(secondHalfChange) < Math.abs(firstHalfChange) * 0.5) {
    acceleration = "decelerating";
  }

  return {
    volume_trend,
    volume_dying,
    price_direction,
    price_range_pct,
    acceleration,
    latest_3_volumes_usd: vols.slice(-3).map((v) => Math.round(v)),
  };
}

/**
 * Fetch price info: realtime price, momentum, per-window volume, ATH proximity,
 * and a 5m candle summary. Mirrors okx.js fetchOkxPriceInfo return shape exactly.
 *
 * Momentum (change_5m/1h/24h), price, and volumes come from `token info.price`
 * (an object) directly — accurate even for brand-new tokens with little kline
 * history. ATH proximity uses the true top-level `ath_price`. change_4h is
 * derived from `price_6h` (GMGN exposes 6h, not 4h) as the closest proxy.
 */
export async function fetchGmgnPriceInfo(mint) {
  if (!mint) return null;

  const cached = readCache(_priceCache, mint);
  if (cached) return cached;

  try {
    const [info, candles] = await Promise.all([fetchTokenInfo(mint), fetchKlines(mint)]);

    if (!info && !candles) {
      log("gmgn", `No data for ${mint.slice(0, 8)}`);
      return null;
    }

    const p = info?.price || {};
    const lastClose = candles?.length ? candles[candles.length - 1].close : 0;
    const price = toNum(p.price) || lastClose;
    const athPrice = toNum(info?.ath_price);

    const lows = candles?.map((c) => c.low).filter((l) => l > 0) || [];
    const minPrice = lows.length ? Math.min(...lows) : 0;
    // max_price = true ATH from token info; fall back to highest candle high.
    const highs = candles?.map((c) => c.high).filter((h) => h > 0) || [];
    const maxPrice = athPrice > 0 ? athPrice : highs.length ? Math.max(...highs) : 0;

    const data = {
      ath_proximity_pct:
        maxPrice > 0 && price > 0 ? Math.round((price / maxPrice) * 1000) / 10 : null,
      price,
      max_price: maxPrice,
      min_price: minPrice,
      change_5m: pct(p.price, p.price_5m),
      change_1h: pct(p.price, p.price_1h),
      change_4h: pct(p.price, p.price_6h), // GMGN exposes 6h, not 4h — closest proxy.
      change_24h: pct(p.price, p.price_24h),
      volume_5m: Math.round(toNum(p.volume_5m) * 100) / 100,
      volume_1h: Math.round(toNum(p.volume_1h) * 100) / 100,
      candles: summarizeCandles(candles),
    };

    writeCache(_priceCache, mint, data, PRICE_CACHE_TTL);
    return data;
  } catch (e) {
    log("gmgn", `Price fetch error for ${mint.slice(0, 8)}: ${e.message}`);
    return null;
  }
}

/* ================================= SIGNAL ================================= */

function emptySignalMetrics(tokenAddress) {
  return {
    signal_present: false,
    latest_signal_age_min: null,
    signal_count_30m: 0,
    signal_count_2h: 0,
    signal_amount_usd_30m: 0,
    signal_amount_usd_2h: 0,
    latest_sold_ratio_percent: null,
    smart_money_count_30m: 0,
    smart_money_count_2h: 0,
    kol_count_30m: 0,
    kol_count_2h: 0,
    whale_count_30m: 0,
    whale_count_2h: 0,
    latest_wallet_type: null,
    token_address: tokenAddress,
    summary: "no GMGN smart-money/KOL holders",
  };
}

function summarizeSignalMetrics(m) {
  if (!m || !m.signal_present) return "no GMGN smart-money/KOL holders";
  const parts = [
    `holders S/K/W=${m.smart_money_count_2h}/${m.kol_count_2h}/${m.whale_count_2h}`,
  ];
  if (m.gmgn_native_signal_count) parts.push(`native_signals=${m.gmgn_native_signal_count}`);
  if (m.latest_signal_age_min != null) {
    parts.push(`latest_trade=${m.latest_signal_age_min}m`);
    parts.push(`flow_2h=${formatUsd(m.signal_amount_usd_2h)}`);
    if (m.latest_sold_ratio_percent != null) parts.push(`sold_ratio=${m.latest_sold_ratio_percent}%`);
  }
  return parts.join(" | ");
}

/* ---- Global track feed overlay (recency / USD flow / sold ratio) ---- */

function normalizeTrackRow(row, fallbackType) {
  const tokenAddress = row?.base_address;
  if (!tokenAddress) return null;
  const tsSec = Number(row?.timestamp || 0);
  if (!Number.isFinite(tsSec) || tsSec <= 0) return null;

  let walletType = fallbackType;
  const tags = row?.maker_info?.tags;
  const tagList = Array.isArray(tags) ? tags : typeof tags === "string" ? [tags] : [];
  if (tagList.some((t) => String(t).includes("smart_degen"))) walletType = "smart_money";
  else if (tagList.some((t) => String(t) === "kol" || String(t).includes("renowned"))) walletType = "kol";

  return {
    tokenAddress,
    ts: tsSec * 1000,
    walletType,
    amountUsd: toNum(row?.amount_usd),
    side: row?.side === "sell" ? "sell" : "buy",
  };
}

function rowsFromTrackFeed(json, fallbackType) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.list) ? json.list : [];
  const out = [];
  for (const raw of list) {
    const norm = normalizeTrackRow(raw, fallbackType);
    if (norm) out.push(norm);
  }
  return out;
}

/**
 * Fetch the global smart-money + KOL track feeds once and group rows by token.
 * Returns a Map<tokenAddress, row[]>. Cached so every mint in a screening batch
 * is served from one pair of CLI spawns.
 */
async function fetchTrackSnapshot() {
  if (_trackSnapshot && Date.now() < _trackSnapshotExpiresAt) return _trackSnapshot;
  if (_trackSnapshotInflight) return _trackSnapshotInflight;

  _trackSnapshotInflight = (async () => {
    const [smJson, kolJson] = await Promise.all([
      spawnGmgn(["track", "smartmoney", "--chain", CHAIN, "--limit", String(TRACK_LIMIT)]),
      spawnGmgn(["track", "kol", "--chain", CHAIN, "--limit", String(TRACK_LIMIT)]),
    ]);

    if (!smJson && !kolJson) return _trackSnapshot || new Map();

    const rows = [
      ...rowsFromTrackFeed(smJson, "smart_money"),
      ...rowsFromTrackFeed(kolJson, "kol"),
    ];

    const grouped = new Map();
    for (const row of rows) {
      if (!grouped.has(row.tokenAddress)) grouped.set(row.tokenAddress, []);
      grouped.get(row.tokenAddress).push(row);
    }

    _trackSnapshot = grouped;
    _trackSnapshotExpiresAt = Date.now() + (rows.length > 0 ? TRACK_SNAPSHOT_TTL : TRACK_EMPTY_TTL);
    return grouped;
  })().finally(() => {
    _trackSnapshotInflight = null;
  });

  return _trackSnapshotInflight;
}

/** Compute recency / USD flow / sold-ratio for a mint's track rows, if any. */
function overlayFromTrackRows(rows, now = Date.now()) {
  if (!rows?.length) return null;
  const cutoff30m = now - 30 * 60_000;
  const cutoff2h = now - 2 * 60 * 60_000;

  let amt30 = 0, amt2h = 0, n2h = 0, sells2h = 0;
  for (const r of rows) {
    if (r.ts >= cutoff2h) {
      amt2h += r.amountUsd;
      n2h += 1;
      if (r.side === "sell") sells2h += 1;
    }
    if (r.ts >= cutoff30m) amt30 += r.amountUsd;
  }

  const latest = rows.slice().sort((a, b) => b.ts - a.ts)[0];
  return {
    signal_amount_usd_30m: Math.round(amt30 * 100) / 100,
    signal_amount_usd_2h: Math.round(amt2h * 100) / 100,
    latest_signal_age_min: latest ? Math.max(0, Math.round((now - latest.ts) / 60_000)) : null,
    latest_sold_ratio_percent: n2h ? Math.round((sells2h / n2h) * 1000) / 10 : null,
    latest_wallet_type: latest?.walletType || null,
  };
}

/**
 * Per-token GMGN conviction signal. Mirrors okx.js fetchOkxDexSignal shape.
 *
 * Backbone: `token info.wallet_tags_stat` gives reliable per-token counts of
 * smart-money / KOL / whale HOLDERS (a snapshot, not a time window) — so the
 * 30m and 2h count fields are set to the same snapshot count. Overlay: when the
 * mint appears in the global track feed, real trade recency, USD flow, and
 * sold-ratio are layered on top. Returns an empty (but shaped) object when the
 * token has no tagged holders, or null only on hard error.
 */
export async function fetchGmgnSignal(mint) {
  if (!mint) return null;
  const cached = readCache(_signalCache, mint);
  if (cached) return cached;

  try {
    const [info, trackSnapshot] = await Promise.all([
      fetchTokenInfo(mint),
      fetchTrackSnapshot().catch(() => new Map()),
    ]);

    const tags = info?.wallet_tags_stat || {};
    const smart = Math.trunc(toNum(tags.smart_wallets));
    const kol = Math.trunc(toNum(tags.renowned_wallets));
    const whale = Math.trunc(toNum(tags.whale_wallets));
    const nativeSignals = Math.trunc(toNum(info?.stat?.signal_count));

    const overlay = overlayFromTrackRows(trackSnapshot.get(mint));
    const present = smart > 0 || kol > 0 || whale > 0 || nativeSignals > 0 || !!overlay;

    if (!present) {
      const empty = emptySignalMetrics(mint);
      writeCache(_signalCache, mint, empty, SIGNAL_EMPTY_TTL);
      return empty;
    }

    const totalConviction = smart + kol + whale;
    const metrics = {
      signal_present: true,
      // Snapshot holder counts — same value for both windows (not time-bucketed).
      smart_money_count_30m: smart,
      smart_money_count_2h: smart,
      kol_count_30m: kol,
      kol_count_2h: kol,
      whale_count_30m: whale,
      whale_count_2h: whale,
      signal_count_30m: totalConviction,
      signal_count_2h: totalConviction,
      // Overlay (trade flow) — null/0 when the mint isn't in the global feed.
      signal_amount_usd_30m: overlay?.signal_amount_usd_30m ?? 0,
      signal_amount_usd_2h: overlay?.signal_amount_usd_2h ?? 0,
      latest_signal_age_min: overlay?.latest_signal_age_min ?? null,
      latest_sold_ratio_percent: overlay?.latest_sold_ratio_percent ?? null,
      latest_wallet_type:
        overlay?.latest_wallet_type ?? (smart > 0 ? "smart_money" : kol > 0 ? "kol" : whale > 0 ? "whale" : null),
      gmgn_native_signal_count: nativeSignals,
      token_address: mint,
    };
    metrics.summary = summarizeSignalMetrics(metrics);

    writeCache(_signalCache, mint, metrics, SIGNAL_CACHE_TTL);
    return metrics;
  } catch (e) {
    log("gmgn", `Signal fetch error for ${mint.slice(0, 8)}: ${e.message}`);
    return null;
  }
}
