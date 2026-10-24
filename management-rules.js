// management-rules.js — hard close rules 3-6 of the management cycle, decided
// AND executed in code. The LLM no longer has to choose to close: it used to
// get "EXIT ALERTS" / rule hits and could hold (it held rule 3 4/4 times, all
// on PnL-API warm-up spikes, which the warm-up guard now handles in code).
//
//   rule 1/2  position instruction            → left to the LLM (free text)
//   rule 3    take profit                     → exit engine (on-chain confirm + N ticks)
//   rule 6    emergency stop / stop loss / trailing → exit engine (same streak as the watcher)
//   rule 4    minutes_out_of_range ≥ wait     → close now (pure threshold, PnL-agnostic)
//   rule 5    yield dead (fee/TVL and volume) → close now; unverifiable data → hold
//
// Rule 4 / 5 closes go through executeTool("close_position", …, { codeExit })
// so alerts, swap-back, state and KB updates run as for any close; PnL exits go
// through exit-engine.js closeForExit (the watcher's path). Every close carries
// an explicit rule label, never the "agent decision" default.
//
// All dependencies are injected so this is unit-testable without RPC/LLM.

import { evaluatePnlExit, closeForExit } from "./exit-engine.js";
import { isRule4Position } from "./oor-fallback.js";

export function ruleLabelForPnlExit(res) {
  const r = String(res?.reason || "");
  if (res?.kind === "take_profit") return `rule 3: take profit — ${r}`;
  if (/^EMERGENCY/.test(r)) return `rule 6: emergency stop — ${r}`;
  return r; // STOP_LOSS… / TRAILING_TP… (same labels as the watcher)
}

const ok = (r) => r && !r.error && !r.blocked && r.success !== false;

/**
 * Evaluate and execute rules for each position.
 * deps: { config, getTracked, getPoolDetail, executeTool, engineDeps, closeDeps, log, now }
 * Returns { llmNeeded: [hint], closed: [..], held: [..], failed: [..], lines: [..] }.
 */
export async function runManagementCodeRules(positions, deps) {
  const { config, getTracked, getPoolDetail, executeTool, log } = deps;
  const m = config.management;
  const s = config.screening;
  const out = { llmNeeded: [], closed: [], held: [], failed: [], lines: [] };
  const seen = new Set();

  for (const p of positions || []) {
    if (!p?.position || seen.has(p.position)) continue;
    seen.add(p.position);
    const pair = p.pair || String(p.position).slice(0, 8);
    const tracked = getTracked(p.position);
    if (tracked?.instruction) {
      out.llmNeeded.push(`${pair}: instruction`);
      continue; // rules 1/2 outrank every other rule
    }

    // ─── PnL rules (3, 6, stop loss, trailing) ───
    let pnl = null;
    try {
      pnl = await evaluatePnlExit(p, { ...deps.engineDeps, config, getTracked, now: deps.now ?? Date.now(), source: "management" });
    } catch (e) {
      log("cron_error", `Management: PnL rule check failed for ${pair}: ${e.message}`);
    }
    if (pnl?.action === "close") {
      const label = ruleLabelForPnlExit(pnl);
      const r = await closeForExit(p, { ...pnl, reason: label }, { ...deps.closeDeps, source: "management" });
      if (r.closed) { out.closed.push({ position: p.position, pair, rule: label }); out.lines.push(`${pair}: CLOSED in code — ${label}`); }
      else if (r.skipped) out.lines.push(`${pair}: ${label} — already closed/closing (${r.skipped})`);
      else { out.failed.push({ position: p.position, pair, rule: label, error: r.result?.error || "close failed" }); out.lines.push(`${pair}: close FAILED — ${label}`); }
      continue;
    }
    if (pnl?.action === "hold") {
      out.held.push({ position: p.position, pair, rule: pnl.reason || pnl.kind || "pnl exit", why: pnl.decision?.why || (pnl.suspicious ? "suspicious tick" : "awaiting confirmation") });
      out.lines.push(`${pair}: HOLD — ${pnl.reason || pnl.kind || "PnL exit"} awaiting confirmation (${pnl.tick ? `${pnl.tick.count} confirming tick(s)` : "unverified"})`);
    }

    // ─── Rule 4: OOR timeout ───
    if (isRule4Position(p, { management: m, getTrackedPosition: getTracked })) {
      const label = `rule 4: OOR timeout (${p.minutes_out_of_range}m ≥ ${m.outOfRangeWaitMinutes}m)${p.oor_direction ? ` (OOR ${p.oor_direction})` : ""}`;
      await closeRule(p, pair, label, out, { executeTool, log });
      continue;
    }

    // ─── Rule 5: yield dead ───
    if (!p.pool) { out.lines.push(`${pair}: rule 5 not checked (pool unknown)`); continue; }
    const d = await getPoolDetail({ pool_address: p.pool, timeframe: s.timeframe || "5m" }).catch(() => null);
    if (!d || !Number.isFinite(d.fee_active_tvl_ratio) || !Number.isFinite(d.volume)) {
      log("cron", `Management: ${pair} rule 5 unverified (pool data unavailable) — hold`);
      out.lines.push(`${pair}: rule 5 unverified (pool data unavailable) — hold`);
      continue;
    }
    if (d.fee_active_tvl_ratio < s.minFeeActiveTvlRatio && d.volume < s.minVolume) {
      const label = `rule 5: yield dead (fee/active TVL ${d.fee_active_tvl_ratio}% < ${s.minFeeActiveTvlRatio}%, volume $${Math.round(d.volume)} < $${s.minVolume})`;
      await closeRule(p, pair, label, out, { executeTool, log });
    }
  }
  return out;
}

async function closeRule(p, pair, label, out, { executeTool, log }) {
  log("cron", `Management: ${pair} ${label} — closing in code`);
  let r;
  try {
    r = await executeTool("close_position", { position_address: p.position, _close_reason: label }, { codeExit: true });
  } catch (e) {
    r = { error: e.message };
  }
  if (ok(r)) {
    out.closed.push({ position: p.position, pair, rule: label, dry_run: Boolean(r.dry_run) });
    out.lines.push(`${pair}: CLOSED in code — ${label}${r.dry_run ? " [DRY RUN]" : ""}`);
  } else {
    const why = r?.error || r?.reason || r?.status || "unknown error";
    out.failed.push({ position: p.position, pair, rule: label, error: why });
    out.lines.push(`${pair}: close FAILED — ${label}: ${why}`);
    log("cron_error", `Management: close failed for ${pair} (${label}): ${why}`);
  }
}

/** Context block for the LLM when it runs anyway (instructions / strategy alerts). */
export function formatCodeRuleResults(out) {
  if (!out?.lines?.length) return "";
  return `\n\nRUNNER CODE RULES (rules 3-6 are decided and executed by the runner in code; do NOT close positions for rules 3-6 yourself — closed ones are gone, held ones are being confirmed):\n${out.lines.join("\n")}\n`;
}
