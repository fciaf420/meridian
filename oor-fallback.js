// oor-fallback.js — close out-of-range positions (hard close rule 4) in code
// when the management LLM is unavailable.
//
// Only rule 4 (minutes_out_of_range >= outOfRangeWaitMinutes) is handled here:
// it is a pure threshold with no judgement, and a position left open past it
// keeps bleeding while the LLM is down. Every other management rule stays with
// the LLM (see the PR description / index.js management prompt).
//
// Dependencies are injected so the logic is unit-testable without RPC, wallet
// or LLM access.

export const OOR_FALLBACK_REASON = "OOR fallback (LLM unavailable)";

/**
 * True when rule 4 applies to this position:
 * - no position instruction (rules 1/2 outrank rule 4 and need the LLM),
 * - reported out of range (in_range !== true), direction-agnostic, like rule 4,
 * - minutes_out_of_range >= outOfRangeWaitMinutes.
 * PnL is not consulted: rule 4 closes "regardless of OOR direction or PnL".
 */
export function isRule4Position(p, { management, getTrackedPosition }) {
  const wait = Number(management?.outOfRangeWaitMinutes);
  if (!Number.isFinite(wait) || wait <= 0) return false; // misconfigured: never close in code
  if (!p?.position) return false;
  if (p.in_range === true) return false;
  if (getTrackedPosition?.(p.position)?.instruction) return false;
  const minutes = Number(p.minutes_out_of_range);
  return Number.isFinite(minutes) && minutes >= wait;
}

export function findRule4Positions(positions, deps) {
  const seen = new Set();
  return (positions || []).filter((p) => {
    if (!isRule4Position(p, deps) || seen.has(p.position)) return false;
    seen.add(p.position);
    return true;
  });
}

/**
 * Close every rule-4 position through executeTool("close_position"), the path
 * the LLM uses, so alerts, swap-back, state and KB updates all run.
 *
 * Re-reads positions first (the LLM may have closed some before failing) and
 * skips any position whose close is already in flight. Returns a summary.
 *
 * deps: { getPositions, executeTool, getTrackedPosition, isBusy, isCloseInflight,
 *         management, log, dryRun }
 */
export async function runOorFallbackCloses(deps) {
  const { getPositions, executeTool, isBusy, isCloseInflight, log, dryRun = false } = deps;
  const summary = { attempted: [], closed: [], failed: [], skipped: [] };

  if (isBusy?.()) {
    log("oor_fallback", "Skipped — another position action is in progress");
    summary.skipped.push({ reason: "busy" });
    return summary;
  }

  let positions;
  try {
    const res = await getPositions();
    if (res?.error) throw new Error(res.error);
    positions = res?.positions || [];
  } catch (e) {
    log("oor_fallback", `Skipped — could not re-read positions: ${e.message}`);
    summary.skipped.push({ reason: "positions_unavailable" });
    return summary;
  }

  const targets = findRule4Positions(positions, deps);
  if (targets.length === 0) {
    log("oor_fallback", "No position past the OOR wait — nothing to close in code");
    return summary;
  }

  for (const p of targets) {
    const label = `${p.pair || p.position.slice(0, 8)} (${p.oor_direction || "OOR"} ${p.minutes_out_of_range}m >= ${deps.management.outOfRangeWaitMinutes}m)`;
    if (isCloseInflight?.(p.position)) {
      log("oor_fallback", `Skipping ${label} — a close is already in progress`);
      summary.skipped.push({ position: p.position, reason: "close_in_flight" });
      continue;
    }
    if (isBusy?.()) {
      log("oor_fallback", `Stopping before ${label} — another position action started`);
      summary.skipped.push({ position: p.position, reason: "busy" });
      break;
    }
    log("oor_fallback", `Rule 4 close in code${dryRun ? " [DRY RUN]" : ""}: ${label} — ${OOR_FALLBACK_REASON}`);
    summary.attempted.push(p.position);
    let result;
    try {
      result = await executeTool("close_position", {
        position_address: p.position,
        _close_reason: `${OOR_FALLBACK_REASON}${p.oor_direction ? ` (OOR ${p.oor_direction})` : ""}`,
      });
    } catch (e) {
      result = { error: e.message };
    }
    const ok = result && !result.error && !result.blocked && result.success !== false;
    if (ok) {
      summary.closed.push({ position: p.position, pair: p.pair, dry_run: Boolean(result.dry_run) });
      log("oor_fallback", `Closed ${label}${result.dry_run ? " [DRY RUN — no tx sent]" : ""}`);
    } else {
      const why = result?.error || result?.reason || result?.status || "unknown error";
      summary.failed.push({ position: p.position, pair: p.pair, error: why });
      log("oor_fallback_error", `Close failed for ${label}: ${why}`);
    }
  }
  return summary;
}

/**
 * Run the management LLM call; if it throws (provider down, no assistant
 * message), run the rule-4 fallback instead. Returns
 * { content, fallbackSummary: null } on success, or
 * { content: null, fallbackSummary, error } after the fallback ran.
 */
export async function runManagementWithOorFallback({ runLlm, fallbackDeps, onLlmError = null }) {
  try {
    const { content } = await runLlm();
    return { content, fallbackSummary: null, error: null };
  } catch (error) {
    onLlmError?.(error);
    const fallbackSummary = await runOorFallbackCloses(fallbackDeps);
    return { content: null, fallbackSummary, error };
  }
}

export function formatOorFallbackReport(summary, llmError) {
  const lines = [`Management: LLM unavailable (${String(llmError || "unknown error").slice(0, 300)}).`];
  if (summary.closed.length) lines.push(`OOR fallback closed: ${summary.closed.map((c) => `${c.pair || c.position.slice(0, 8)}${c.dry_run ? " [dry run]" : ""}`).join(", ")}`);
  if (summary.failed.length) lines.push(`OOR fallback close failed: ${summary.failed.map((f) => `${f.pair || f.position.slice(0, 8)} (${f.error})`).join(", ")}`);
  if (!summary.attempted.length && !summary.skipped.length) lines.push("No position past the OOR wait; other rules wait for the LLM.");
  if (summary.skipped.length) lines.push(`Skipped: ${summary.skipped.map((s) => s.position ? `${s.position.slice(0, 8)} (${s.reason})` : s.reason).join(", ")}`);
  return lines.join("\n");
}
