import fs from "fs";
import path from "path";
import { repoPath } from "./repo-root.js";

export const FEE_MOMENTUM_FILE = repoPath("logs", "fee-momentum.jsonl");
export const FEE_MOMENTUM_INTERVAL_MS = 5 * 60 * 1000;

const lastRecordedAt = new Map();

function finiteOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveOrNull(value) {
  const parsed = finiteOrNull(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function snapshotKey(snapshot) {
  return `${snapshot.stage}:${snapshot.mint}:${snapshot.pool || "token"}`;
}

export function buildTokenFeeSnapshot({ token, info, infoCheck, now = Date.now() }) {
  const mint = token?.address || info?.address;
  if (!mint) return null;

  const openedAt = finiteOrNull(token?.open_timestamp);
  return {
    ts: new Date(now).toISOString(),
    stage: "token_info",
    mint,
    symbol: token?.symbol || info?.symbol || null,
    total_fee_sol: finiteOrNull(infoCheck?.totalFeeSol ?? info?.total_fee),
    trade_fee_sol: finiteOrNull(infoCheck?.tradeFeeSol ?? info?.trade_fee),
    price: positiveOrNull(info?.price ?? token?.price),
    price_change_pct: finiteOrNull(token?.price_change_percent5m ?? token?.price_change_percent),
    mcap: finiteOrNull(token?.market_cap),
    volume: finiteOrNull(token?.volume),
    holders: finiteOrNull(info?.holder_count ?? token?.holder_count),
    token_age_hours: openedAt == null ? null : Math.max(0, (now / 1000 - openedAt) / 3600),
    stage2_passed: Boolean(infoCheck?.passed),
    stage2_reasons: Array.isArray(infoCheck?.reasons) ? infoCheck.reasons.slice(0, 8) : [],
  };
}

export function buildPoolFeeSnapshot(candidate, { now = Date.now() } = {}) {
  const mint = candidate?.base?.mint;
  if (!mint || !candidate?.pool) return null;

  return {
    ts: new Date(now).toISOString(),
    stage: "stage5_dlmm",
    mint,
    symbol: candidate.base?.symbol || candidate.name || null,
    pool: candidate.pool,
    total_fee_sol: finiteOrNull(candidate.gmgn_total_fee_sol),
    trade_fee_sol: finiteOrNull(candidate.gmgn_trade_fee_sol),
    price: positiveOrNull(candidate.price),
    price_change_pct: finiteOrNull(candidate.price_change_pct),
    mcap: finiteOrNull(candidate.mcap),
    volume: finiteOrNull(candidate.volume),
    holders: finiteOrNull(candidate.holders),
    token_age_hours: finiteOrNull(candidate.token_age_hours),
    tvl: finiteOrNull(candidate.tvl),
    active_tvl: finiteOrNull(candidate.active_tvl),
    fee_active_tvl_ratio: finiteOrNull(candidate.fee_active_tvl_ratio),
    volatility: finiteOrNull(candidate.volatility),
    bin_step: finiteOrNull(candidate.bin_step),
    gmgn_score: finiteOrNull(candidate.gmgn_score),
  };
}

export function recordFeeMomentumSnapshots(snapshots, {
  now = Date.now(),
  outputPath = FEE_MOMENTUM_FILE,
  intervalMs = FEE_MOMENTUM_INTERVAL_MS,
} = {}) {
  const records = [];

  for (const snapshot of snapshots || []) {
    if (!snapshot?.stage || !snapshot?.mint || snapshot.total_fee_sol == null) continue;
    const key = snapshotKey(snapshot);
    const previous = lastRecordedAt.get(key);
    if (previous != null && now - previous < intervalMs) continue;
    records.push({ ...snapshot, ts: new Date(now).toISOString() });
  }

  if (records.length === 0) return 0;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.appendFileSync(outputPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  for (const record of records) lastRecordedAt.set(snapshotKey(record), now);
  return records.length;
}
