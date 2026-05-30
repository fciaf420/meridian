/**
 * Autoresearch — automated prompt optimization system inspired by ATLAS.
 *
 * Identifies the worst-performing prompt section, generates a targeted
 * modification via a cheap LLM, tests it over N real closes, and
 * keeps/reverts based on actual PnL improvement.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";
import {
  getPromptSectionText,
  setPromptSectionOverride,
  clearPromptSectionOverride,
} from "./prompt.js";
import { loadWeights } from "./signal-weights.js";
import {
  getDefaultModelForProvider,
  getChatCompletionsEndpoint,
  getLlmProvider,
  getProviderApiKey,
  runCodexExec,
} from "./llm-provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTORESEARCH_FILE = path.join(__dirname, "autoresearch.json");

// ─── Persistence ─────────────────────────────────────────────

const DEFAULTS = {
  enabled: false,
  experiments: [],       // history of all experiments
  active: null,          // currently running experiment (or null)
  cooldownRemaining: 0,  // closes remaining before next experiment
  kept_overrides: {},    // section → text for permanently kept experiment overrides
};

function readUserConfigSnapshot() {
  const userConfigPath = path.join(__dirname, "user-config.json");
  try {
    if (!fs.existsSync(userConfigPath)) return {};
    return JSON.parse(fs.readFileSync(userConfigPath, "utf8"));
  } catch {
    return {};
  }
}

function getEnvironmentSnapshot() {
  const userConfig = readUserConfigSnapshot();
  let weightsMeta = {};
  try {
    const weights = loadWeights();
    weightsMeta = {
      last_recalc: weights.last_recalc ?? null,
      recalc_count: weights.recalc_count ?? 0,
    };
  } catch {
    weightsMeta = {
      last_recalc: null,
      recalc_count: 0,
    };
  }

  return {
    thresholds_last_evolved: userConfig._lastEvolved ?? null,
    thresholds_positions_at_evolution: userConfig._positionsAtEvolution ?? 0,
    darwin_last_recalc: weightsMeta.last_recalc,
    darwin_recalc_count: weightsMeta.recalc_count,
  };
}

function environmentChangedSince(snapshot = {}) {
  const current = getEnvironmentSnapshot();
  // Only invalidate on threshold evolution (changes hard screening filters).
  // Darwin weight recalcs only affect prompt summary text, not hard filters —
  // they shouldn't invalidate experiments since the actual screening behavior
  // doesn't change. This was causing 50%+ of experiments to be invalidated
  // before completing the 7-close minimum.
  return (
    current.thresholds_last_evolved !== (snapshot.thresholds_last_evolved ?? null) ||
    current.thresholds_positions_at_evolution !== (snapshot.thresholds_positions_at_evolution ?? 0)
  );
}

function getTrialPositionsForExperiment(experiment, perfData) {
  if (!experiment) return [];

  if (experiment.section === "manager_logic") {
    return perfData.filter((p) => {
      const closedAt = p.recorded_at || p.closed_at;
      return closedAt ? closedAt >= experiment.started_at : false;
    });
  }

  return perfData.slice(experiment.started_at_position)
    .filter((p) => {
      const deployedAt = p.deployed_at;
      if (deployedAt) return deployedAt >= experiment.started_at;
      const closedAt = p.recorded_at || p.closed_at;
      return closedAt ? closedAt >= experiment.started_at : true;
    });
}

export function loadAutoresearch() {
  if (!fs.existsSync(AUTORESEARCH_FILE)) {
    saveAutoresearch(DEFAULTS);
    return { ...DEFAULTS };
  }
  try {
    const data = JSON.parse(fs.readFileSync(AUTORESEARCH_FILE, "utf8"));
    // Merge with DEFAULTS so existing files gain new fields (e.g. kept_overrides)
    return { ...DEFAULTS, ...data };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAutoresearch(data) {
  fs.writeFileSync(AUTORESEARCH_FILE, JSON.stringify(data, null, 2));
}

// ─── Startup Restoration ─────────────────────────────────────

/**
 * On module load, restore any active experiment's override into memory.
 * Without this, a restart would lose the in-memory override while
 * autoresearch.json still shows an active experiment.
 */
try {
  const state = loadAutoresearch();
  // First restore all kept overrides so they survive restarts
  if (state.kept_overrides) {
    for (const [section, text] of Object.entries(state.kept_overrides)) {
      setPromptSectionOverride(section, text);
      log("autoresearch", `Restored kept override: ${section}`);
    }
  }
  // Then restore the active experiment (overrides the kept one for that section)
  if (state.active?.modified_text && state.active?.section) {
    setPromptSectionOverride(state.active.section, state.active.modified_text);
    log("autoresearch", `Restored active experiment override: ${state.active.id} (${state.active.section})`);
  }
} catch { /* ignore on first load if file doesn't exist yet */ }

// ─── Main Entry Point ────────────────────────────────────────

/**
 * Called from recordPerformance after each close.
 * Evaluates an active experiment or starts a new one.
 */
export async function maybeRunAutoresearch(perfData, lessons, cfg) {
  if (cfg.autoresearch?.enabled !== true) return;

  const state = loadAutoresearch();

  if (state.active) {
    await evaluateExperiment(perfData, cfg, state);
  } else {
    // Decrement cooldown
    if (state.cooldownRemaining > 0) {
      state.cooldownRemaining--;
      saveAutoresearch(state);
      log("autoresearch", `Cooldown: ${state.cooldownRemaining} closes remaining`);
      return;
    }
    await analyzeAndGenerate(perfData, lessons, cfg, state);
  }
}

// ─── Analyze + Generate Experiment ───────────────────────────

async function analyzeAndGenerate(perfData, lessons, cfg, state) {
  const minCloses = cfg.autoresearch?.minClosesPerTrial ?? 7;

  // Need at least 15 closes to analyze, or at minimum minCloses * 2
  if (perfData.length < Math.max(15, minCloses * 2)) {
    log("autoresearch", `Not enough data (${perfData.length} closes) — skipping`);
    return;
  }

  // 1. Attribute recent losses to prompt sections
  const recent = perfData.slice(-15);
  const sectionLosses = {
    screener_criteria: [],
    manager_logic: [],
    range_selection: [],
  };

  for (const p of recent) {
    if ((p.pnl_usd ?? 0) >= 0) continue; // skip winners

    const reason = (p.close_reason || "").toLowerCase();

    if (reason.includes("stop_loss") || reason.includes("trailing_tp") || reason.includes("oor downside")) {
      sectionLosses.manager_logic.push(p);
    } else if ((p.range_efficiency ?? 100) < 30) {
      sectionLosses.range_selection.push(p);
    } else if (reason.includes("oor upside")) {
      // OOR upside on single-sided-below (bid_ask, SOL-only spot) is a
      // STRATEGY problem, not a range problem — wider range only adds bins
      // below and literally cannot catch upside moves.  Attribute to screener
      // so the LLM considers strategy changes, not range widening.
      const strat = (p.strategy || "").toLowerCase();
      if (strat.includes("bid_ask") || strat === "spot") {
        sectionLosses.screener_criteria.push(p);
      } else {
        sectionLosses.range_selection.push(p);
      }
    } else {
      sectionLosses.screener_criteria.push(p);
    }
  }

  // 2. Pick the worst section — with rotation to avoid optimizing the same section repeatedly
  const sections = Object.entries(sectionLosses).filter(([, losses]) => losses.length > 0);
  if (sections.length === 0) {
    log("autoresearch", "No losses in recent closes — nothing to optimize");
    return;
  }

  // Check last N experiments — if the same section was targeted 3+ times in a row, rotate
  const MAX_CONSECUTIVE = 3;
  const recentSections = (state.experiments || []).slice(-MAX_CONSECUTIVE).map(e => e.section);
  const lastSection = recentSections[0];
  const allSame = recentSections.length >= MAX_CONSECUTIVE && recentSections.every(s => s === lastSection);

  // Sort by loss count descending
  sections.sort((a, b) => b[1].length - a[1].length);

  let worstSection, worstCount;
  if (allSame && sections.length > 1) {
    // Force rotation to the second-worst section
    [worstSection, { length: worstCount }] = [sections[1][0], { length: sections[1][1].length }];
    log("autoresearch", `Rotating away from ${lastSection} (${MAX_CONSECUTIVE}x consecutive) → trying ${worstSection}`);
  } else {
    [worstSection, { length: worstCount }] = [sections[0][0], { length: sections[0][1].length }];
  }

  log("autoresearch", `Worst section: ${worstSection} (${worstCount} attributed losses)`);

  const minAttributedLosses = cfg.autoresearch?.minAttributedLosses ?? 3;
  if (worstCount < minAttributedLosses) {
    log("autoresearch", `Only ${worstCount} attributed losses for ${worstSection} (need ${minAttributedLosses}) — skipping`);
    return;
  }

  // 3. Read current prompt text for that section
  const currentText = getPromptSectionText(worstSection);
  if (!currentText) {
    log("autoresearch", `Could not read section text for "${worstSection}" — skipping`);
    return;
  }

  // 4. Generate modification via LLM with KB context
  const failures = sectionLosses[worstSection];
  const failureDesc = failures
    .map(f => `- ${f.pool_name || "unknown"}: PnL ${f.pnl_pct}%, reason: ${f.close_reason || "unknown"}, strategy: ${f.strategy || "?"}, volatility: ${f.volatility || "?"}`)
    .join("\n");

  // Search KB for patterns related to the failing pools/strategies
  let kbContext = "";
  try {
    const { searchArticles, readArticle } = await import("./knowledge-base.js");
    const kbQueries = new Set();
    for (const f of failures) {
      if (f.pool_name) kbQueries.add(f.pool_name.replace(/-SOL$/, ""));
      if (f.strategy) kbQueries.add(f.strategy);
      if (f.close_reason?.includes("OOR")) kbQueries.add("oor");
    }
    kbQueries.add(worstSection.replace("_", " "));

    const seen = new Set();
    const kbSnippets = [];
    for (const q of kbQueries) {
      const results = searchArticles(q);
      for (const r of (results.results || []).slice(0, 3)) {
        if (seen.has(r.path)) continue;
        seen.add(r.path);
        const article = readArticle(r.path);
        if (article?.content) {
          kbSnippets.push(`--- ${r.path} ---\n${article.content.slice(0, 500)}`);
        }
        if (kbSnippets.length >= 8) break;
      }
      if (kbSnippets.length >= 8) break;
    }
    if (kbSnippets.length > 0) {
      kbContext = `\n\nKNOWLEDGE BASE CONTEXT (relevant articles from prior experience):\n${kbSnippets.join("\n\n")}`;
    }
  } catch (e) {
    log("autoresearch", `KB lookup failed (non-fatal): ${e.message}`);
  }

  const llmModel = cfg.autoresearch?.llmModel ?? getDefaultModelForProvider(getLlmProvider());
  let hypothesis, modifiedText;

  try {
    const result = await callLLM(llmModel, worstSection, worstCount, currentText, failureDesc + kbContext);
    hypothesis = result.hypothesis;
    modifiedText = result.modifiedText;
  } catch (e) {
    log("autoresearch", `LLM call failed: ${e.message}`);
    return;
  }

  if (!modifiedText || modifiedText.trim() === currentText.trim()) {
    log("autoresearch", "LLM returned identical or empty text — skipping");
    return;
  }

  // 5. Compute baseline from last N positions
  const baselinePositions = perfData.slice(-minCloses);
  const baselineWins = baselinePositions.filter(p => (p.pnl_usd ?? 0) > 0).length;
  const baselineWR = baselinePositions.length > 0
    ? (baselineWins / baselinePositions.length) * 100
    : 0;
  const baselineAvgPnl = baselinePositions.length > 0
    ? baselinePositions.reduce((s, p) => s + (p.pnl_pct ?? 0), 0) / baselinePositions.length
    : 0;

  // 6. Create experiment
  const experiment = {
    id: `exp_${Date.now()}`,
    section: worstSection,
    hypothesis: hypothesis || "Targeted modification to reduce losses",
    original_text: currentText,
    modified_text: modifiedText,
    started_at: new Date().toISOString(),
    started_at_position: perfData.length,
    baseline: {
      win_rate: Math.round(baselineWR * 10) / 10,
      avg_pnl_pct: Math.round(baselineAvgPnl * 100) / 100,
      positions: baselinePositions.length,
    },
    trial: {
      win_rate: null,
      avg_pnl_pct: null,
      positions: 0,
    },
    status: "active",
    environment_snapshot: getEnvironmentSnapshot(),
  };

  // Snapshot current Darwin signal weights for audit trail.
  // NOTE: If Darwin adjusts weights during this experiment, the trial results
  // may be confounded — we cannot fully isolate prompt changes from weight
  // changes. This snapshot at least records the starting conditions.
  try {
    experiment.weights_at_start = loadWeights().weights;
  } catch {
    experiment.weights_at_start = null;
  }

  state.active = experiment;
  saveAutoresearch(state);

  // 7. Activate the override
  setPromptSectionOverride(worstSection, modifiedText);

  log("autoresearch", `Experiment ${experiment.id} started: ${worstSection}`);
  log("autoresearch", `Hypothesis: ${hypothesis}`);
  log("autoresearch", `Baseline WR: ${experiment.baseline.win_rate}%, avg PnL: ${experiment.baseline.avg_pnl_pct}%`);
}

// ─── Evaluate Active Experiment ──────────────────────────────

async function evaluateExperiment(perfData, cfg, state) {
  const experiment = state.active;
  if (!experiment) return;

  const minCloses = cfg.autoresearch?.minClosesPerTrial ?? 7;
  const minEvidenceCloses = cfg.autoresearch?.minEvidenceCloses ?? Math.max(10, minCloses + 2);
  const minAbsoluteWinRateDeltaPct = cfg.autoresearch?.minAbsoluteWinRateDeltaPct ?? 10;
  const minAbsolutePnlDeltaPct = cfg.autoresearch?.minAbsolutePnlDeltaPct ?? 0.5;
  const improvementPct = cfg.autoresearch?.improvementPct ?? 15;
  const declinePct = cfg.autoresearch?.declinePct ?? 15;
  const cooldownCloses = cfg.autoresearch?.cooldownCloses ?? 5;

  if (environmentChangedSince(experiment.environment_snapshot)) {
    log("autoresearch", `Environment changed during ${experiment.id} — invalidating trial to avoid confounded results`);
    finishExperiment(state, "invalidated_environment_change", 0);
    return;
  }

  // Screener/range changes should only be judged on positions deployed after the
  // experiment started. Manager changes should be judged on any positions CLOSED
  // after the experiment started, including positions that were already open.
  const trialPositions = getTrialPositionsForExperiment(experiment, perfData);
  const trialCount = trialPositions.length;

  experiment.trial.positions = trialCount;

  // Circuit breaker: if first 3 trial closes are ALL losses, auto-revert
  if (trialCount >= 3 && trialCount < minCloses) {
    const first3 = trialPositions.slice(0, 3);
    const allLosses = first3.every(p => (p.pnl_usd ?? 0) < 0);
    if (allLosses) {
      log("autoresearch", `Circuit breaker: first 3 closes all losses — reverting ${experiment.id}`);
      finishExperiment(state, "reverted_circuit_breaker", cooldownCloses);
      return;
    }
  }

  // Not enough data yet
  if (trialCount < minCloses) {
    saveAutoresearch(state);
    log("autoresearch", `Experiment ${experiment.id}: ${trialCount}/${minCloses} closes`);
    return;
  }

  // Require a slightly larger evidence window before making a keep/revert call.
  // This reduces noisy decisions when the default minCloses is just barely met.
  if (trialCount < minEvidenceCloses) {
    saveAutoresearch(state);
    log("autoresearch", `Experiment ${experiment.id}: ${trialCount}/${minEvidenceCloses} evidence closes (waiting for a less noisy verdict)`);
    return;
  }

  // Compute trial metrics
  const trialWins = trialPositions.filter(p => (p.pnl_usd ?? 0) > 0).length;
  const trialWR = (trialWins / trialCount) * 100;
  const trialAvgPnl = trialPositions.reduce((s, p) => s + (p.pnl_pct ?? 0), 0) / trialCount;

  experiment.trial.win_rate = Math.round(trialWR * 10) / 10;
  experiment.trial.avg_pnl_pct = Math.round(trialAvgPnl * 100) / 100;

  // Compare to baseline using composite score: 60% win rate + 40% avg PnL
  const baselineWR = experiment.baseline.win_rate;
  const wrImprovement = ((trialWR - baselineWR) / Math.max(baselineWR, 1)) * 100;
  const absoluteWinRateDelta = trialWR - baselineWR;

  const baselinePnl = experiment.baseline.avg_pnl_pct;
  const pnlImprovement = baselinePnl !== 0
    ? ((trialAvgPnl - baselinePnl) / Math.max(Math.abs(baselinePnl), 0.1)) * 100
    : (trialAvgPnl > 0 ? 100 : trialAvgPnl < 0 ? -100 : 0);
  const absolutePnlDelta = trialAvgPnl - baselinePnl;

  const compositeImprovement = (wrImprovement * 0.6) + (pnlImprovement * 0.4);

  const trialLosses = trialCount - trialWins;
  const isImbalancedTinySample = trialCount < 2 * minEvidenceCloses && (trialWins === 0 || trialLosses === 0);
  if (isImbalancedTinySample) {
    log("autoresearch", `Experiment ${experiment.id}: ${trialWins}/${trialCount} wins/losses too one-sided for a confident verdict — waiting for more closes`);
    saveAutoresearch(state);
    return;
  }

  const hasMeaningfulAbsoluteDelta =
    Math.abs(absoluteWinRateDelta) >= minAbsoluteWinRateDeltaPct ||
    Math.abs(absolutePnlDelta) >= minAbsolutePnlDeltaPct;

  if (!hasMeaningfulAbsoluteDelta) {
    log("autoresearch", `Experiment ${experiment.id}: absolute deltas too small for a confident verdict (WR Δ ${absoluteWinRateDelta.toFixed(1)} pts, PnL Δ ${absolutePnlDelta.toFixed(2)} pts)`);
    finishExperiment(state, "inconclusive", cooldownCloses);
    return;
  }

  log("autoresearch", `Experiment ${experiment.id}: trial WR ${trialWR.toFixed(1)}% vs baseline ${baselineWR.toFixed(1)}% (WR improvement: ${wrImprovement.toFixed(1)}%, PnL improvement: ${pnlImprovement.toFixed(1)}%, composite: ${compositeImprovement.toFixed(1)}%)`);

  if (compositeImprovement >= improvementPct) {
    // KEEP — the modification helped
    log("autoresearch", `KEEPING experiment ${experiment.id} — composite ${compositeImprovement.toFixed(1)}% improvement (WR: ${wrImprovement.toFixed(1)}%, PnL: ${pnlImprovement.toFixed(1)}%)`);
    experiment.status = "kept";
    // Persist the kept override so it survives restarts
    if (!state.kept_overrides) state.kept_overrides = {};
    state.kept_overrides[experiment.section] = experiment.modified_text;
    // Log as lesson
    logExperimentLesson(experiment, "kept", compositeImprovement);
    state.experiments.push(experiment);
    state.active = null;
    state.cooldownRemaining = cooldownCloses;
    saveAutoresearch(state);
  } else if (compositeImprovement <= -declinePct) {
    // REVERT — the modification hurt
    log("autoresearch", `REVERTING experiment ${experiment.id} — composite ${compositeImprovement.toFixed(1)}% decline (WR: ${wrImprovement.toFixed(1)}%, PnL: ${pnlImprovement.toFixed(1)}%)`);
    logExperimentLesson(experiment, "reverted", compositeImprovement);
    finishExperiment(state, "reverted", cooldownCloses);
  } else {
    // INCONCLUSIVE — revert to be safe
    log("autoresearch", `DISCARDING experiment ${experiment.id} — inconclusive (composite: ${compositeImprovement.toFixed(1)}%, WR: ${wrImprovement.toFixed(1)}%, PnL: ${pnlImprovement.toFixed(1)}%)`);
    logExperimentLesson(experiment, "inconclusive", compositeImprovement);
    finishExperiment(state, "inconclusive", cooldownCloses);
  }
}

function finishExperiment(state, status, cooldownCloses) {
  const experiment = state.active;
  if (!experiment) return;

  experiment.status = status;
  // If this section has a kept override, restore it instead of clearing entirely
  const keptText = state.kept_overrides?.[experiment.section];
  if (keptText) {
    setPromptSectionOverride(experiment.section, keptText);
  } else {
    clearPromptSectionOverride(experiment.section);
  }
  state.experiments.push(experiment);
  state.active = null;
  state.cooldownRemaining = cooldownCloses;
  saveAutoresearch(state);
}

function logExperimentLesson(experiment, outcome, improvementPct) {
  try {
    // Dynamic import to avoid circular dependency
    import("./lessons.js").then(({ addLesson }) => {
      const label = outcome === "kept" ? "KEPT" : outcome === "reverted" ? "REVERTED" : "INCONCLUSIVE";
      addLesson(
        `[AUTORESEARCH ${label}] Section "${experiment.section}": ${experiment.hypothesis}. ` +
        `Trial WR: ${experiment.trial.win_rate}% vs baseline ${experiment.baseline.win_rate}% ` +
        `(${improvementPct > 0 ? "+" : ""}${improvementPct.toFixed(1)}%).`,
        ["autoresearch", experiment.section, outcome],
      );
    }).catch(() => {});
  } catch { /* best-effort */ }
}

// ─── LLM Call ────────────────────────────────────────────────

async function callLLM(model, sectionName, lossCount, currentText, failureDesc) {
  const provider = getLlmProvider();

  const systemMsg = `You optimize prompts for an autonomous LP (Liquidity Provider) trading agent on Meteora/Solana DLMM. The agent uses these prompts as behavioral instructions. Your goal is to make small, surgical edits that reduce losses.

KEY DOMAIN KNOWLEDGE for your modifications:
- STRATEGIES: The agent can deploy "bid_ask" (single-sided SOL below price — earns fees on sell pressure, safe but goes idle if price pumps UP) or "spot" with sol_split_pct (two-sided, e.g. 80% SOL / 20% token — captures fees in both directions, better for pumping tokens but riskier if token dumps).
- OOR UPSIDE: Price pumped above the position range. For bid_ask, SOL sits idle earning nothing. Spot two-sided would have captured fees on the way up.
- OOR DOWNSIDE: Price dropped below the position range. SOL converted to token, real loss. Wider range helps stay in range longer.
- If failures show repeated "OOR upside" with bid_ask, consider switching to spot with high sol_split_pct (80-90) for those pool types, or improving screener criteria to avoid deploying into tokens that are mid-pump.
- If failures show "OOR downside", consider widening price_range_pct or tightening screening thresholds.
- HARD RULE: NEVER propose widening price_range_pct to fix OOR upside on bid_ask or SOL-only spot strategies. These strategies place bins BELOW the active bin only — wider range adds more bins below, which CANNOT reach a price that pumped ABOVE. This is a physical impossibility, not a tuning problem. If OOR upside is the issue, the fix is strategy selection or screener criteria, never range width.
- The agent has signal weights showing which screening signals predict wins (organic_score, fee_tvl_ratio, mcap are strong; holder_count, volume are weak).`;

  const userMsg = `Section "${sectionName}" has caused ${lossCount} recent losses.

Current text:
---
${currentText}
---

Recent failures:
${failureDesc}

Generate exactly ONE small, targeted modification. Change only one instruction or threshold. Do not rewrite the whole section.

Reply with:
HYPOTHESIS: [one sentence explaining what you're changing and why]
MODIFIED_TEXT:
[full section text with your single change applied]`;

  if (provider === "codex") {
    const content = await runCodexExec(model, `${systemMsg}\n\n${userMsg}`, {
      cwd: process.cwd(),
      sandbox: "read-only",
      skipGitRepoCheck: true,
      config: {
        "suppress_unstable_features_warning": "true",
        "model_reasoning_effort": config.autoresearch?.reasoningEffort ?? "medium",
      },
    });

    if (!content) throw new Error("Empty response from Codex CLI");

    const hypothesisMatch = content.match(/HYPOTHESIS:\s*(.+?)(?:\n|$)/i);
    const modifiedMatch = content.match(/MODIFIED_TEXT:\s*\n([\s\S]+)/i);

    return {
      hypothesis: hypothesisMatch?.[1]?.trim() || "Targeted modification",
      modifiedText: modifiedMatch?.[1]?.trim() || null,
    };
  }

  if (provider === "claude") {
    const { runClaudeCli } = await import("./llm-provider.js");

    const content = await runClaudeCli(model, `${systemMsg}\n\n${userMsg}`, {
      effort: "high",
    });

    if (!content) throw new Error("Empty response from Claude CLI");

    const hypothesisMatch = content.match(/HYPOTHESIS:\s*(.+?)(?:\n|$)/i);
    const modifiedMatch = content.match(/MODIFIED_TEXT:\s*\n([\s\S]+)/i);

    return {
      hypothesis: hypothesisMatch?.[1]?.trim() || "Targeted modification",
      modifiedText: modifiedMatch?.[1]?.trim() || null,
    };
  }

  const baseURL = getChatCompletionsEndpoint();
  const apiKey = getProviderApiKey();
  if (!apiKey) throw new Error("LLM API key/token not available for autoresearch");

  const body = {
    model,
    messages: [
      { role: "system", content: systemMsg },
      { role: "user", content: userMsg },
    ],
    temperature: 0.4,
    max_tokens: 4096,
  };

  if (provider === "minimax") {
    body.reasoning_split = true;
  }

  const response = await fetch(baseURL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "unknown");
    throw new Error(`LLM provider returned ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const message = data.choices?.[0]?.message;
  const content = message?.content;
  if (!content) throw new Error("Empty response from LLM");

  // Parse response
  const hypothesisMatch = content.match(/HYPOTHESIS:\s*(.+?)(?:\n|$)/i);
  const modifiedMatch = content.match(/MODIFIED_TEXT:\s*\n([\s\S]+)/i);

  return {
    hypothesis: hypothesisMatch?.[1]?.trim() || "Targeted modification",
    modifiedText: modifiedMatch?.[1]?.trim() || null,
  };
}

// ─── Public Accessors ────────────────────────────────────────

/**
 * Get the currently active experiment, or null.
 */
export function getActiveExperiment() {
  const state = loadAutoresearch();
  return state.active || null;
}

/**
 * Interface for prompt.js — get current text for a section.
 */
export function getPromptSection(sectionName) {
  return getPromptSectionText(sectionName);
}

/**
 * Interface for prompt.js — set override.
 */
export function setPromptOverride(sectionName, text) {
  setPromptSectionOverride(sectionName, text);
}

/**
 * Interface for prompt.js — clear override.
 */
export function clearPromptOverride(sectionName) {
  clearPromptSectionOverride(sectionName);
}
