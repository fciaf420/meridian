// tools/bin-visual.js — emoji bin charts of a DLMM position for Telegram.
//
// Meteora's colors: 🟦 SOL (quote / Y), 🟪 token (base / X), ⬛ empty. The
// active bin gets no extra color; the current price is a thin │ between
// columns (Meteora's white Pool Price line). Out of range shows ◀ / ▶ at the
// edge instead. Bar height is the bin's value in SOL.
//
// The render functions are pure and take the normalized shape that
// getPositionBins() returns:
//   { name, position, pool, binStep, decX, decY, activeBin, activePrice,
//     lower, upper, bins: [{ id, price, px, py }] }
// where price is pricePerToken (Y per X in UI units) and px / py are raw
// amounts (strings or numbers).
//
// getPositionBins() is read-only (getPosition + getActiveBin) and never throws:
// on any failure it returns null and the caller leaves the chart out.

export const CHART_COLS = 16;
export const CHART_ROWS = 4;
export const BINS_CACHE_MS = 60_000;

const Y = "🟦";
const X = "🟪";
const E = "⬛";
const LINE = "│";
const SUB = "₀₁₂₃₄₅₆₇₈₉";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Meteora-style price: small prices get a subscript zero count, so
 * 0.0000150 → "0.0₄150". Three significant digits.
 */
export function fmtPx(p) {
  const n = Number(p);
  if (!Number.isFinite(n) || n <= 0) return "?";
  if (n >= 1000) return String(Math.round(n));
  if (n >= 0.01) return n.toPrecision(3);
  // Truncated, not rounded, to 3 digits (matches the approved mock); the extra
  // exponent digits keep float noise like 9.9999999e-6 from dropping a digit.
  const [mant, exp] = n.toExponential(8).split("e");
  const zeros = -Number(exp) - 1; // zeros between the decimal point and the first digit
  const digits = mant.replace(".", "").slice(0, 3);
  const sub = String(zeros).split("").map((c) => SUB[Number(c)]).join("");
  return `0.0${sub}${digits}`;
}

/** Per-bin value in SOL: x = token side valued at the bin price, y = SOL side. */
function binValues(p) {
  const dx = 10 ** Number(p.decX ?? 9);
  const dy = 10 ** Number(p.decY ?? 9);
  return (p.bins || []).map((b) => {
    const price = Number(b.price);
    const x = (Number(b.px) / dx) * (Number.isFinite(price) ? price : 0);
    const y = Number(b.py) / dy;
    return { id: b.id, x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
  });
}

/**
 * Bucket the position's bins into at most `ncols` columns.
 * `linePos` is where the price line goes: 0..ncols is the gap before that
 * column (in range), -1 means price is below the range, ncols + 1 above it.
 */
export function bucketBins(p, ncols = CHART_COLS) {
  const bins = binValues(p);
  const n = bins.length;
  const cols = [];
  if (!n) return { cols, linePos: null, ncols: 0 };
  const width = Math.min(ncols, n); // never repeat a bin across columns
  let linePos = null;
  for (let c = 0; c < width; c++) {
    const lo = Math.floor((c * n) / width);
    const hi = Math.floor(((c + 1) * n) / width);
    let x = 0;
    let y = 0;
    for (let k = lo; k < hi; k++) {
      x += bins[k].x;
      y += bins[k].y;
      if (bins[k].id === p.activeBin) linePos = (k - lo + 0.5) / (hi - lo) < 0.5 ? c : c + 1;
    }
    cols.push({ x, y, v: x + y });
  }
  if (linePos == null) {
    if (p.activeBin < p.lower) linePos = -1;
    else if (p.activeBin > p.upper) linePos = width + 1;
    else linePos = p.activeBin - p.lower < p.upper - p.activeBin ? 0 : width; // in range but bin missing: nearest edge
  }
  return { cols, linePos, ncols: width };
}

const cellOf = (c) => (c.v <= 0 ? E : c.y >= c.x ? Y : X);

function withMarker(cells, linePos) {
  const n = cells.length;
  if (linePos === -1) return "◀" + cells.join("");
  if (linePos === n + 1) return cells.join("") + "▶";
  return cells.slice(0, linePos).join("") + LINE + cells.slice(linePos).join("");
}

/** Stacked column, bottom → top: token 🟪 at the bottom, SOL 🟦 on top. */
function stackCells(c, max, rows) {
  if (c.v <= 0) return Array(rows).fill(E);
  const h = Math.min(rows, Math.max(1, Math.round((c.v / max) * rows)));
  let hx = Math.round((c.x / c.v) * h);
  if (c.x > 0 && c.y > 0 && h >= 2) hx = Math.min(h - 1, Math.max(1, hx)); // a mixed column keeps both colors
  return Array.from({ length: rows }, (_, r) => (r < hx ? X : r < h ? Y : E));
}

const pairParts = (p) => {
  const name = String(p.name || "");
  if (!name.includes("-")) return { tok: "token", quote: "SOL" }; // e.g. an address-prefix fallback name
  const [tok, quote] = name.split("-");
  return { tok: tok || "token", quote: quote || "SOL" };
};

/** SOL / token share of the position's value, and where the price sits. */
export function binSplit(p) {
  const bins = binValues(p);
  const tx = bins.reduce((a, b) => a + b.x, 0);
  const ty = bins.reduce((a, b) => a + b.y, 0);
  const t = tx + ty;
  const solPct = t > 0 ? Math.round((ty / t) * 100) : 0;
  const tokPct = t > 0 ? 100 - solPct : 0;
  let where;
  if (p.activeBin < p.lower) where = `OOR ↓ ${p.lower - p.activeBin} bins`;
  else if (p.activeBin > p.upper) where = `OOR ↑ ${p.activeBin - p.upper} bins`;
  else where = `${p.activeBin - p.lower}↓ ${p.upper - p.activeBin}↑ bins`;
  return { solPct, tokPct, where, totalSol: t };
}

function infoLines(p) {
  const { tok, quote } = pairParts(p);
  const s = binSplit(p);
  const first = p.bins[0]?.price;
  const last = p.bins[p.bins.length - 1]?.price;
  return [
    `<code>min ${fmtPx(first)} · now ${fmtPx(p.activePrice)} · max ${fmtPx(last)}</code>`,
    `${Y} ${esc(quote)} ${s.solPct}% · ${X} ${esc(tok)} ${s.tokPct}% · ${s.where}`,
  ];
}

const renderable = (p) => !!(p && Array.isArray(p.bins) && p.bins.length && Number.isFinite(Number(p.activeBin)));

/**
 * One-line strip plus the price and split lines (Telegram HTML).
 * Returns null when there is nothing to draw.
 */
export function renderBinStrip(p, { cols = CHART_COLS } = {}) {
  if (!renderable(p)) return null;
  const b = bucketBins(p, cols);
  if (!b.cols.length) return null;
  return [withMarker(b.cols.map(cellOf), b.linePos), ...infoLines(p)].join("\n");
}

/**
 * Tall chart: `rows` rows × `cols` columns, the price line through every row.
 * `header` adds "NPC-SOL · 82 bins" on top. Returns null when there is nothing to draw.
 */
export function renderBinChart(p, { cols = CHART_COLS, rows = CHART_ROWS, header = true } = {}) {
  if (!renderable(p)) return null;
  const b = bucketBins(p, cols);
  if (!b.cols.length) return null;
  const max = Math.max(...b.cols.map((c) => c.v));
  if (!(max > 0)) return null; // an emptied position: nothing worth drawing
  const stacks = b.cols.map((c) => stackCells(c, max, rows));
  const out = [];
  if (header) out.push(`<b>${esc(p.name || "Position")}</b> · ${p.bins.length} bins`);
  for (let r = rows - 1; r >= 0; r--) out.push(withMarker(stacks.map((s) => s[r]), b.linePos));
  out.push(...infoLines(p));
  return out.join("\n");
}

// ─── Read-only fetch + cache ─────────────────────────────────────

const cache = new Map(); // position → { at, data }
const inflight = new Map(); // position → Promise
let deps = null; // test overrides: { getPool, now }

export function _setBinVisualDepsForTest(d) {
  deps = d;
  cache.clear();
  inflight.clear();
}

const nowMs = () => (deps?.now ? deps.now() : Date.now());

async function loadPool(poolAddress) {
  if (deps?.getPool) return deps.getPool(poolAddress);
  const { getPoolForRead } = await import("./dlmm.js");
  return getPoolForRead(poolAddress);
}

async function loadPublicKey() {
  if (deps?.PublicKey) return deps.PublicKey;
  const { PublicKey } = await import("@solana/web3.js");
  return PublicKey;
}

/** Resolve within `ms`, or to `fallback` (default null) on timeout or rejection. */
export function withTimeout(promise, ms, fallback = null) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

async function fetchPositionBins(position) {
  const pool = await loadPool(position.pool);
  const PublicKey = await loadPublicKey();
  const [pos, active] = await Promise.all([
    pool.getPosition(new PublicKey(position.position)),
    pool.getActiveBin().catch(() => null),
  ]);
  const pd = pos?.positionData;
  if (!pd?.positionBinData?.length) return null;
  const binStep = Number(pool.lbPair?.binStep);
  const decX = Number(pool.tokenX?.mint?.decimals ?? pool.tokenX?.decimal);
  const decY = Number(pool.tokenY?.mint?.decimals ?? pool.tokenY?.decimal ?? 9);
  const activeBin = active?.binId ?? position.active_bin;
  if (!Number.isFinite(Number(activeBin)) || !Number.isFinite(decX)) return null;
  const activePrice = active?.pricePerToken != null
    ? Number(active.pricePerToken)
    : Math.pow(1 + binStep / 1e4, activeBin) * 10 ** (decX - decY);
  return {
    name: position.pair || null,
    position: position.position,
    pool: position.pool,
    binStep,
    decX,
    decY,
    activeBin: Number(activeBin),
    activePrice,
    lower: pd.lowerBinId,
    upper: pd.upperBinId,
    bins: pd.positionBinData.map((b) => ({
      id: b.binId,
      price: Number(b.pricePerToken),
      px: String(b.positionXAmount),
      py: String(b.positionYAmount),
    })),
  };
}

/**
 * Read-only bin data for one position ({ position, pool, pair, active_bin }),
 * cached ~60s per position. Never throws: returns null on any failure.
 */
export async function getPositionBins(position, { force = false } = {}) {
  try {
    if (!position?.position || !position?.pool) return null;
    const key = position.position;
    const hit = cache.get(key);
    if (!force && hit && nowMs() - hit.at < BINS_CACHE_MS) return hit.data;
    if (!force && inflight.has(key)) return await inflight.get(key);
    const p = fetchPositionBins(position)
      .then((data) => {
        if (data) {
          cache.set(key, { at: nowMs(), data });
          if (cache.size > 100) for (const [k, v] of cache) if (nowMs() - v.at >= BINS_CACHE_MS) cache.delete(k);
        }
        return data;
      })
      .catch(() => null)
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return await p;
  } catch {
    return null;
  }
}
