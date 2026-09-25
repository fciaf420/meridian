// LLM-provider outage hardening: Codex error parsing, non-retryable
// classification, the rule-4 OOR fallback and the deduped outage alert.
// Unit-only: no CLI is spawned, no RPC, no transactions.
import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyLlmError,
  codexFailureMessage,
  createLlmHealth,
  extractCodexJsonError,
  filterCodexStderr,
  LLM_ALERT_REPEAT_MS,
  LLM_PROBE_INTERVAL_MS,
  LlmUnavailableError,
  isLlmUnavailableError,
} from "../llm-health.js";
import { settleCodexRun } from "../llm-provider.js";
import {
  OOR_FALLBACK_REASON,
  findRule4Positions,
  runManagementWithOorFallback,
  runOorFallbackCloses,
} from "../oor-fallback.js";

// ─── Codex output as seen live (logs/live-20260925T133114.log) ───────────

const USAGE_MSG = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 26th, 2026 12:41 PM.";
const BRIEF_USAGE_MSG = "You’ve hit your usage limit ... try again at Sep 26th, 2026 12:41 PM.";

const codexStdout = (msg) => [
  JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "error", message: "Code Mode is unavailable in this environment." } }),
  JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "error", message: "Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest." } }),
  JSON.stringify({ type: "error", message: msg }),
  JSON.stringify({ type: "turn.failed", error: { message: msg } }),
].join("\n");

const RMCP_STDERR = [
  "2026-09-25T13:31:18.160422Z ERROR rmcp::transport::streamable_http_client: fail to get common stream: unexpected server response: GET returned HTTP 503",
  "2026-09-25T13:31:19.001234Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed",
].join("\n");

test("codex: turn.failed usage-limit message wins over rmcp stderr noise", () => {
  for (const msg of [USAGE_MSG, BRIEF_USAGE_MSG]) {
    const settled = settleCodexRun({ code: 1, stdout: codexStdout(msg), stderr: RMCP_STDERR });
    assert.equal(settled.ok, false);
    assert.equal(settled.error, msg);
    assert.doesNotMatch(settled.error, /rmcp|503/);
  }
});

test("codex: top-level {type:error} is used when there is no turn.failed", () => {
  const stdout = [
    JSON.stringify({ type: "item.completed", item: { type: "error", message: "Code Mode is unavailable" } }),
    JSON.stringify({ type: "error", message: USAGE_MSG }),
  ].join("\n");
  assert.equal(extractCodexJsonError(stdout), USAGE_MSG);
});

test("codex: benign item errors and rmcp stderr are never reported as the cause", () => {
  const stdout = [
    JSON.stringify({ type: "item.completed", item: { type: "error", message: "Code Mode is unavailable in this environment." } }),
    JSON.stringify({ type: "item.completed", item: { type: "error", message: "Skill descriptions were shortened to fit the skills context budget." } }),
  ].join("\n");
  assert.equal(extractCodexJsonError(stdout), "");
  assert.equal(filterCodexStderr(RMCP_STDERR), "");
  assert.equal(codexFailureMessage({ stdout, stderr: RMCP_STDERR, code: 1 }), "Codex CLI exited with code 1");
  // Real (non-rmcp) stderr still surfaces.
  assert.equal(
    codexFailureMessage({ stdout: "", stderr: `${RMCP_STDERR}\nError: Not logged in`, code: 1 }),
    "Error: Not logged in",
  );
});

test("codex: exit 0 with a failed turn and no agent message is a failure, not an answer", () => {
  const settled = settleCodexRun({ code: 0, stdout: codexStdout(USAGE_MSG), stderr: "" });
  assert.deepEqual(settled, { ok: false, error: USAGE_MSG });
});

test("codex: a normal run still returns the agent message", () => {
  const stdout = [
    JSON.stringify({ type: "item.completed", item: { type: "error", message: "Code Mode is unavailable" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{\"action\":\"respond\"}" } }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");
  assert.deepEqual(settleCodexRun({ code: 0, stdout, stderr: RMCP_STDERR }), { ok: true, content: "{\"action\":\"respond\"}" });
});

// ─── Classification ──────────────────────────────────────────────────────

test("usage limit is non-retryable and carries the reset time", () => {
  const cls = classifyLlmError(new Error(USAGE_MSG));
  assert.equal(cls.kind, "quota");
  assert.equal(cls.nonRetryable, true);
  assert.equal(cls.resetText, "at Sep 26th, 2026 12:41 PM");
  assert.ok(Number.isFinite(cls.resetAt), "reset time should parse to a timestamp");
  assert.equal(new Date(cls.resetAt).getFullYear(), 2026);

  assert.equal(classifyLlmError(BRIEF_USAGE_MSG).nonRetryable, true);
  assert.equal(classifyLlmError("Rate limit reached for requests").nonRetryable, true);
  assert.equal(classifyLlmError("insufficient_quota").kind, "quota");
  assert.equal(classifyLlmError(Object.assign(new Error("Too Many"), { status: 429 })).nonRetryable, true);
  assert.equal(classifyLlmError("Claude rate limited — resets in ~12m. Use DeepSeek fallback.").nonRetryable, true);
});

test("auth failures are non-retryable; transient errors stay retryable", () => {
  const ds = classifyLlmError(new Error("401 Authentication Fails, Your api key: ****c640 is invalid"));
  assert.equal(ds.kind, "auth");
  assert.equal(ds.nonRetryable, true);

  for (const msg of ["Codex CLI timed out after 180s", "Codex CLI exited with code 1", "502 Bad Gateway", "socket hang up"]) {
    assert.equal(classifyLlmError(msg).nonRetryable, false, msg);
  }
});

test("LlmUnavailableError is recognisable", () => {
  const err = new LlmUnavailableError("LLM unavailable — codex: x", { provider: "codex" });
  assert.equal(isLlmUnavailableError(err), true);
  assert.equal(isLlmUnavailableError(new Error("x")), false);
});

// ─── Rule-4 OOR fallback ─────────────────────────────────────────────────

const MANAGEMENT = { outOfRangeWaitMinutes: 30, takeProfitFeePct: 5, emergencyPriceDropPct: -50 };
const POSITIONS = [
  { position: "UPSIDE1111", pair: "UP-SOL", in_range: false, oor_direction: "upside", minutes_out_of_range: 45, pnl_pct: 2 },
  { position: "DOWN22222", pair: "DOWN-SOL", in_range: false, oor_direction: "downside", minutes_out_of_range: 30, pnl_pct: -8 },
  { position: "INRANGE33", pair: "IN-SOL", in_range: true, minutes_out_of_range: 0, pnl_pct: 1 },
  { position: "YOUNGOOR4", pair: "YOUNG-SOL", in_range: false, oor_direction: "upside", minutes_out_of_range: 29, pnl_pct: 0 },
  { position: "INSTRUCT5", pair: "INSTR-SOL", in_range: false, oor_direction: "upside", minutes_out_of_range: 90, pnl_pct: 3 },
  { position: "TPHIT6666", pair: "TP-SOL", in_range: true, minutes_out_of_range: 0, pnl_pct: 12 },
  { position: "STOPHIT77", pair: "SL-SOL", in_range: true, minutes_out_of_range: 0, pnl_pct: -70 },
  { position: "PNLNULL88", pair: "NUL-SOL", in_range: true, minutes_out_of_range: 0, pnl_pct: null },
];

function makeDeps(overrides = {}) {
  const calls = [];
  const logs = [];
  const deps = {
    getPositions: async () => ({ positions: POSITIONS }),
    executeTool: async (name, args) => {
      calls.push({ name, args });
      return { success: true, position: args.position_address, txs: ["sig"] };
    },
    getTrackedPosition: (addr) => (addr === "INSTRUCT5" ? { instruction: "hold until 2x" } : { deployed_at: "2026-09-25T00:00:00Z" }),
    isBusy: () => false,
    isCloseInflight: () => false,
    management: MANAGEMENT,
    log: (cat, msg) => logs.push(`[${cat}] ${msg}`),
    dryRun: false,
    ...overrides,
  };
  return { deps, calls, logs };
}

test("rule 4 selection: past-wait OOR in either direction, no instruction", () => {
  const { deps } = makeDeps();
  assert.deepEqual(findRule4Positions(POSITIONS, deps).map((p) => p.position), ["UPSIDE1111", "DOWN22222"]);
  // A missing / zero wait never closes anything in code.
  assert.deepEqual(findRule4Positions(POSITIONS, { ...deps, management: { outOfRangeWaitMinutes: 0 } }), []);
  assert.deepEqual(findRule4Positions(POSITIONS, { ...deps, management: {} }), []);
});

test("LLM throws → only rule-4 positions are closed, via close_position with the fallback reason", async () => {
  const { deps, calls, logs } = makeDeps();
  const run = await runManagementWithOorFallback({
    runLlm: async () => { throw new LlmUnavailableError("LLM unavailable — codex: usage limit"); },
    fallbackDeps: deps,
  });
  assert.equal(run.content, null);
  assert.ok(isLlmUnavailableError(run.error));
  assert.deepEqual(calls.map((c) => c.name), ["close_position", "close_position"]);
  assert.deepEqual(calls.map((c) => c.args.position_address), ["UPSIDE1111", "DOWN22222"]);
  assert.equal(calls[0].args._close_reason, `${OOR_FALLBACK_REASON} (OOR upside)`);
  assert.equal(calls[1].args._close_reason, `${OOR_FALLBACK_REASON} (OOR downside)`);
  assert.deepEqual(run.fallbackSummary.closed.map((c) => c.position), ["UPSIDE1111", "DOWN22222"]);
  assert.ok(logs.some((l) => l.includes("Rule 4 close in code") && l.includes("UP-SOL")));
});

test("LLM returns no assistant message (agentLoop throws) → fallback runs too", async () => {
  const { deps, calls } = makeDeps();
  await runManagementWithOorFallback({
    runLlm: async () => { throw new Error("Provider returned no assistant message"); },
    fallbackDeps: deps,
  });
  assert.equal(calls.length, 2);
});

test("LLM succeeds → the fallback closes nothing", async () => {
  const { deps, calls } = makeDeps();
  let fetched = false;
  deps.getPositions = async () => { fetched = true; return { positions: POSITIONS }; };
  const run = await runManagementWithOorFallback({
    runLlm: async () => ({ content: "HOLD all" }),
    fallbackDeps: deps,
  });
  assert.equal(run.content, "HOLD all");
  assert.equal(run.fallbackSummary, null);
  assert.equal(calls.length, 0);
  assert.equal(fetched, false);
});

test("fallback respects busy lock, in-flight closes and failed closes", async () => {
  {
    const { deps, calls } = makeDeps({ isBusy: () => true });
    const s = await runOorFallbackCloses(deps);
    assert.equal(calls.length, 0);
    assert.deepEqual(s.skipped, [{ reason: "busy" }]);
  }
  {
    const { deps, calls } = makeDeps({ isCloseInflight: (a) => a === "UPSIDE1111" });
    const s = await runOorFallbackCloses(deps);
    assert.deepEqual(calls.map((c) => c.args.position_address), ["DOWN22222"]);
    assert.deepEqual(s.skipped, [{ position: "UPSIDE1111", reason: "close_in_flight" }]);
  }
  {
    const { deps } = makeDeps({ executeTool: async () => ({ success: false, error: "rpc down" }) });
    const s = await runOorFallbackCloses(deps);
    assert.equal(s.closed.length, 0);
    assert.equal(s.failed.length, 2);
    assert.equal(s.failed[0].error, "rpc down");
  }
  {
    const { deps } = makeDeps({ getPositions: async () => ({ positions: [], error: "RPC timeout" }) });
    const s = await runOorFallbackCloses(deps);
    assert.deepEqual(s.skipped, [{ reason: "positions_unavailable" }]);
  }
});

test("fallback in dry run goes through executeTool (whose DRY_RUN guard sends nothing)", async () => {
  const { deps, calls, logs } = makeDeps({
    dryRun: true,
    executeTool: async (name, args) => {
      calls.push({ name, args });
      return { dry_run: true, would_close: args.position_address };
    },
  });
  const s = await runOorFallbackCloses(deps);
  assert.equal(calls.length, 2);
  assert.ok(s.closed.every((c) => c.dry_run));
  assert.ok(logs.some((l) => l.includes("[DRY RUN]")));
});

// ─── Deduped outage notification ─────────────────────────────────────────

test("llm_unavailable alert is sent once per outage (distinct error or hourly)", () => {
  let t = Date.parse("2026-09-25T13:31:00Z");
  const events = [];
  const health = createLlmHealth({ emit: (name, data) => events.push({ name, data }), log: () => {}, now: () => t });
  const fail = (reason) => health.reportFailure({ provider: "codex", reason, resetText: "at Sep 26th, 2026 12:41 PM" });

  const reason = `codex: ${USAGE_MSG}; DeepSeek fallback key is invalid (401) — fix DEEPSEEK_API_KEY`;
  assert.equal(fail(reason), true);
  t += 5 * 60_000; assert.equal(fail(reason), false);
  t += 5 * 60_000; assert.equal(fail(reason), false);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "llm_unavailable");
  assert.equal(events[0].data.resetText, "at Sep 26th, 2026 12:41 PM");

  // Request ids / timestamps changing between identical failures do not re-alert.
  const short = "deepseek: 401 Authentication Fails";
  assert.equal(fail(`${short} (request_id: aaa-111)`), true, "a different error alerts");
  t += 60_000; assert.equal(fail(`${short} (request_id: bbb-222)`), false, "same error, new request id");
  t += 60_000; assert.equal(fail(`${reason}`), true, "switching back to the first error is distinct again");

  // Same error again after an hour: one reminder.
  t += 10 * 60_000; assert.equal(fail(reason), false);
  t += LLM_ALERT_REPEAT_MS; assert.equal(fail(reason), true);

  // Recovery ends the outage; the next failure alerts again.
  health.reportSuccess();
  assert.equal(health.getOutage(), null);
  t += 60_000; assert.equal(fail(reason), true);
  assert.equal(events.length, 5);
});

test("outage state gates screening until the probe interval (or an earlier reset)", () => {
  let t = 1_000_000;
  const health = createLlmHealth({ emit: () => {}, log: () => {}, now: () => t });
  assert.equal(health.isUnavailable(), false);
  health.reportFailure({ provider: "codex", reason: "usage limit" });
  assert.equal(health.isUnavailable(), true);
  t += LLM_PROBE_INTERVAL_MS - 1; assert.equal(health.isUnavailable(), true);
  t += 1; assert.equal(health.isUnavailable(), false, "a cycle may probe the LLM again");

  health.reportFailure({ provider: "codex", reason: "usage limit", resetAt: t + 5 * 60_000 });
  t += 5 * 60_000; assert.equal(health.isUnavailable(), false, "the provider's reset time ends the skip early");

  health.reportSuccess();
  assert.equal(health.isUnavailable(), false);
});
