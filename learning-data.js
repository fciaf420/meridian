/**
 * What the learning systems (threshold evolution, lesson derivation, pool
 * memory, Darwinian signal weights, autoresearch loss attribution) count as a
 * win, a loss, or nothing at all.
 *
 * One classifier for all of them. A close within ±1% is break-even: fees and
 * rounding noise, not evidence either way, and it is ignored where wins are
 * weighed against losses. Before this, `pnl_pct > 0` counted a 0.00x% OOR
 * close as a winner, and evolution lengthened outOfRangeWaitMinutes on it
 * (12 → 14 → 17 → 20).
 *
 * Records that are known to be wrong are excluded from learning entirely:
 * a record flagged `exclude_from_learning` / `corrupt`, a record already
 * marked `corrected` by a history-fix script, and the list below. Nothing
 * here writes runtime JSON; scripts/fix-learning-data-2026-09-26.js can stamp
 * the flag onto the stored records (bot stopped, preview by default).
 *
 * Pure module: no imports, safe to load from anywhere.
 */

export const WIN_PCT = 1;   // PnL above +1% is a win
export const LOSS_PCT = -1; // PnL below −1% is a loss

/**
 * @param {number} pnlPct
 * @returns {"win"|"loss"|"breakeven"|null} null when the PnL is not a finite number.
 */
export function classifyOutcome(pnlPct) {
  if (pnlPct == null || pnlPct === "") return null;
  const n = Number(pnlPct);
  if (!Number.isFinite(n)) return null;
  if (n > WIN_PCT) return "win";
  if (n < LOSS_PCT) return "loss";
  return "breakeven";
}

/** PnL % of a performance record, or null when it isn't known. */
export function recordPnlPct(rec) {
  if (!rec || rec.pnl_unknown === true) return null;
  for (const v of [rec.pnl_pct, rec.actual_pnl_pct]) {
    if (v != null && Number.isFinite(Number(v))) return Number(v);
  }
  const usd = Number(rec.pnl_usd ?? rec.actual_pnl_usd);
  const init = Number(rec.initial_value_usd);
  if (Number.isFinite(usd) && init > 0) return (usd / init) * 100;
  return null;
}

/** classifyOutcome of a performance record; null for unknown PnL (placeholder 0). */
export function classifyRecord(rec) {
  return classifyOutcome(recordPnlPct(rec));
}

/**
 * Records known to be wrong. Matched by position address (lessons.json
 * performance), by pool + deployed_at (pool-memory.json deploys), and by
 * pool + created_at === recorded_at (the lesson derived from the record).
 */
export const KNOWN_BAD_RECORDS = [
  {
    key: "COLLECT-false-stop-loss",
    position: "AT5nG76yVJNftdTnd2HHmN5rvRgsRFtSZ6weVq2GEwji",
    pool: "5qwvUa7H23GbRyfYDCvq2PBn3E27H87mmvgESBbCoLsX",
    pool_name: "COLLECT-SOL",
    deployed_at: "2026-09-25T01:50:37.448Z",
    recorded_at: "2026-09-25T01:56:37.968Z",
    reason: "false −66.44% stop loss (PnL API); the wallet shows ≈ +0.005 SOL for this close",
  },
  {
    key: "CUM-test-1",
    position: "29RyDEM1ZmFqyRGtQv6dHKyYrwkAifskmaKfmvXcGwnd",
    pool: "E37YaxGwu8aoUbbJraN4qK4tfKPtuxQvFHnnRRwkxypU",
    pool_name: "CUM-SOL",
    deployed_at: "2026-05-30T13:53:49.588Z",
    recorded_at: "2026-05-30T13:53:50.953Z",
    reason: "May test deploy (closed after 1s, no initial value)",
  },
  {
    key: "CUM-test-2",
    position: "CP1dzFkcsmaESATxUziNmGFdQZZMJhC5vNEcdaDPeQWZ",
    pool: "E37YaxGwu8aoUbbJraN4qK4tfKPtuxQvFHnnRRwkxypU",
    pool_name: "CUM-SOL",
    deployed_at: "2026-05-30T13:54:46.507Z",
    recorded_at: "2026-05-30T13:54:48.114Z",
    reason: "May test deploy (closed after 2s)",
  },
];

/** The KNOWN_BAD_RECORDS entry a record/deploy/lesson matches, or null. */
export function knownBadMatch(rec, poolAddress = null) {
  if (!rec) return null;
  const pool = rec.pool ?? poolAddress;
  return KNOWN_BAD_RECORDS.find((b) =>
    (rec.position && rec.position === b.position)
    || (pool === b.pool && rec.deployed_at && rec.deployed_at === b.deployed_at)
    || (pool === b.pool && rec.created_at && rec.created_at === b.recorded_at)) || null;
}

/**
 * Why a performance record (or pool-memory deploy) must not be learned from,
 * or null when it may. `poolAddress` is the pool-memory key for deploys, which
 * don't carry their pool.
 */
export function exclusionReason(rec, poolAddress = null) {
  if (!rec) return null;
  if (rec.exclude_from_learning) return typeof rec.exclude_from_learning === "string" ? rec.exclude_from_learning : "excluded";
  if (rec.corrupt) return typeof rec.corrupt === "string" ? rec.corrupt : "corrupt";
  if (rec.corrected) return `corrected: ${rec.corrected}`;
  return knownBadMatch(rec, poolAddress)?.reason ?? null;
}

export function isExcludedFromLearning(rec, poolAddress = null) {
  return exclusionReason(rec, poolAddress) != null;
}

/** Performance records the learning systems may use. */
export function learnableRecords(perfData) {
  return (perfData || []).filter((p) => !isExcludedFromLearning(p));
}

/**
 * A lesson derived from a known-bad record (or flagged). Corrected lessons
 * stay: they were rewritten into warnings on purpose.
 */
export function isExcludedLesson(lesson) {
  if (!lesson) return false;
  if (lesson.exclude_from_learning || lesson.corrupt) return true;
  return lesson.pool != null && lesson.created_at != null && knownBadMatch({ pool: lesson.pool, created_at: lesson.created_at }) != null;
}

/**
 * Pool-memory aggregates from a pool's deploys: excluded deploys don't count,
 * the win rate is wins / (wins + losses) with break-even ignored (null when
 * there are no decisive closes), and last_outcome is profit / loss / breakeven.
 */
export function poolAggregates(deploys, poolAddress = null) {
  const counted = (deploys || []).filter((d) => !isExcludedFromLearning(d, poolAddress));
  const withPnl = counted.filter((d) => classifyOutcome(d.pnl_pct) != null);
  const round2 = (n) => Math.round(n * 100) / 100;
  const wins = withPnl.filter((d) => classifyOutcome(d.pnl_pct) === "win").length;
  const losses = withPnl.filter((d) => classifyOutcome(d.pnl_pct) === "loss").length;
  const last = counted[counted.length - 1];
  const lastClass = last ? classifyOutcome(last.pnl_pct) : null;
  return {
    avg_pnl_pct: withPnl.length ? round2(withPnl.reduce((s, d) => s + Number(d.pnl_pct), 0) / withPnl.length) : 0,
    win_rate: wins + losses > 0 ? round2(wins / (wins + losses)) : null,
    last_outcome: !last ? null : lastClass == null ? "unknown" : lastClass === "win" ? "profit" : lastClass,
    counted_deploys: counted.length,
  };
}
