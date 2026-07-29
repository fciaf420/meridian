import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";

const MANAGER_TOOLS  = new Set(["close_position", "claim_fees", "swap_token", "get_position_pnl", "get_my_positions", "get_wallet_balance"]);
const SCREENER_TOOLS = new Set(["deploy_position", "get_active_bin", "get_top_candidates", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_pool_memory", "get_wallet_balance", "get_my_positions"]);
const GENERAL_INTENT_ONLY_TOOLS = new Set([
  "self_update",
  "update_config",
  "add_to_blacklist",
  "remove_from_blacklist",
  "block_deployer",
  "unblock_deployer",
  "add_pool_note",
  "set_position_note",
  "add_smart_wallet",
  "remove_smart_wallet",
  "add_lesson",
  "pin_lesson",
  "unpin_lesson",
  "clear_lessons",
  "add_strategy",
  "remove_strategy",
  "set_active_strategy",
]);

// Intent → tool subsets for GENERAL role
const INTENT_TOOLS = {
  decisions:   new Set(["get_recent_decisions"]),
  deploy:      new Set(["deploy_position", "get_top_candidates", "get_active_bin", "get_pool_memory", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_wallet_balance", "get_my_positions", "add_pool_note"]),
  close:       new Set(["close_position", "get_my_positions", "get_position_pnl", "get_wallet_balance", "swap_token"]),
  claim:       new Set(["claim_fees", "get_my_positions", "get_position_pnl", "get_wallet_balance"]),
  swap:        new Set(["swap_token", "get_wallet_balance"]),
  config:      new Set(["update_config"]),
  blocklist:   new Set(["add_to_blacklist", "remove_from_blacklist", "list_blacklist", "block_deployer", "unblock_deployer", "list_blocked_deployers"]),
  selfupdate:  new Set(["self_update"]),
  balance:     new Set(["get_wallet_balance", "get_my_positions", "get_wallet_positions"]),
  positions:   new Set(["get_my_positions", "get_position_pnl", "get_wallet_balance", "set_position_note", "get_wallet_positions"]),
  strategy:    new Set(["list_strategies", "get_strategy", "add_strategy", "update_strategy", "delete_strategy", "remove_strategy", "set_active_strategy"]),
  screen:      new Set(["get_top_candidates", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "check_smart_wallets_on_pool", "get_pool_detail", "get_my_positions", "discover_pools"]),
  memory:      new Set(["get_pool_memory", "add_pool_note", "list_blacklist", "add_to_blacklist", "remove_from_blacklist"]),
  smartwallet: new Set(["add_smart_wallet", "remove_smart_wallet", "list_smart_wallets", "check_smart_wallets_on_pool"]),
  study:       new Set(["study_top_lpers", "get_top_lpers", "get_pool_detail", "search_pools", "get_token_info", "discover_pools", "add_smart_wallet", "list_smart_wallets"]),
  performance: new Set(["get_performance_history", "get_my_positions", "get_position_pnl"]),
  lessons:     new Set(["add_lesson", "pin_lesson", "unpin_lesson", "list_lessons", "clear_lessons"]),
};

const INTENT_PATTERNS = [
  { intent: "decisions",   re: /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i },
  { intent: "deploy",      re: /\b(deploy|open|add liquidity|lp into|invest in)\b/i },
  { intent: "close",       re: /\b(close|exit|withdraw|remove liquidity|shut down)\b/i },
  { intent: "claim",       re: /\b(claim|harvest|collect)\b.*\bfee/i },
  { intent: "swap",        re: /\b(swap|convert|sell|exchange)\b/i },
  { intent: "selfupdate",  re: /\b(self.?update|git pull|pull latest|update (the )?bot|update (the )?agent|update yourself)\b/i },
  { intent: "blocklist",   re: /\b(blacklist|block|unblock|blocklist|blocked deployer|rugger|block dev|block deployer)\b/i },
  { intent: "config",      re: /\b(config|setting|threshold|update|set |change)\b/i },
  { intent: "balance",     re: /\b(balance|wallet|sol|how much)\b/i },
  { intent: "positions",   re: /\b(position|portfolio|open|pnl|yield|range)\b/i },
  { intent: "strategy",    re: /\b(strategy|strategies)\b/i },
  { intent: "screen",      re: /\b(screen|candidate|find pool|search|research|token)\b/i },
  { intent: "memory",      re: /\b(memory|pool history|note|remember)\b/i },
  { intent: "smartwallet", re: /\b(smart wallet|kol|whale|watch.?list|add wallet|remove wallet|list wallet|tracked wallet|check pool|who.?s in|wallets in|add to (smart|watch|kol))\b/i },
  { intent: "study",       re: /\b(study top|top lpers?|best lpers?|who.?s lping|lp behavior|lpers?)\b/i },
  { intent: "performance", re: /\b(performance|history|how.?s the bot|how.?s it doing|stats|report)\b/i },
  { intent: "lessons",     re: /\b(lesson|learned|teach|pin|unpin|clear lesson|what did you learn)\b/i },
];

function getToolsForRole(agentType, goal = "") {
  if (agentType === "MANAGER")  return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") return tools.filter(t => SCREENER_TOOLS.has(t.function.name));

  // GENERAL: match intent from goal, combine matched tool sets
  const matched = new Set();
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(goal)) {
      for (const t of INTENT_TOOLS[intent]) matched.add(t);
    }
  }

  // Fall back to all tools if no intent matched
  if (matched.size === 0) return tools.filter(t => !GENERAL_INTENT_ONLY_TOOLS.has(t.function.name));
  return tools.filter(t => matched.has(t.function.name));
}
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getDecisionSummary } from "./decision-log.js";

// Supports OpenRouter (default) or any OpenAI-compatible local server (e.g. LM Studio)
// To use LM Studio: set LLM_BASE_URL=http://localhost:1234/v1 and LLM_API_KEY=lm-studio in .env
const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY;
// Keep module import side-effect free so the loop can be tested with injected
// dependencies without requiring production credentials or opening provider handles.
let client = null;

const DEFAULT_MODEL = process.env.LLM_MODEL || "openrouter/healer-alpha";

async function createChatCompletion(reqParams) {
  if (!/api\.deepseek\.com/i.test(LLM_BASE_URL)) {
    if (!LLM_API_KEY) throw new Error("LLM_API_KEY or OPENROUTER_API_KEY is required");
    client ??= new OpenAI({ baseURL: LLM_BASE_URL, apiKey: LLM_API_KEY, timeout: 5 * 60 * 1000 });
    return client.chat.completions.create(reqParams);
  }

  const base = LLM_BASE_URL.replace(/\/$/, "").replace(/\/v1$/i, "");
  const body = {
    ...reqParams,
    // DeepSeek v4 Pro supports tool calls with thinking, but rejects tool_choice="required".
    // Keep thinking enabled and let the model choose tools naturally.
    thinking: { type: "enabled", reasoning_effort: "high" },
    stream: false,
  };
  if (body.tool_choice === "required") delete body.tool_choice;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000); // 3 min timeout
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`DeepSeek returned non-JSON response (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(json?.error?.message || json?.message || `DeepSeek API error ${res.status}`);
  }
  return json;
}

const MUTATING_TOOL_INTENTS = /\b(deploy|open position|add liquidity|lp into|invest in|close|exit|withdraw|remove liquidity|claim|harvest|collect|swap|convert|sell|exchange|block|unblock|blacklist|add smart wallet|remove smart wallet|add wallet|remove wallet|pin|unpin|clear lesson|add lesson|set active strategy|remove strategy|add strategy|set |change |update |self.?update|pull latest|git pull|update yourself)\b/i;
const LIVE_DATA_TOOL_INTENTS = /\b(balance|wallet|position|portfolio|pnl|yield|range|show positions|open positions|screen|candidate|find pool|search|research|analyze|check pool|token holders|narrative|study top|top lpers?|lp behavior|who.?s lping|performance|history|stats|report|list smart wallets|list blacklist|list blocked deployers|list lessons)\b/i;
const CONFIG_READ_ONLY_INTENTS = /\b(check|show|what(?:'s| is)?|review|inspect|see)\b.*\b(config|settings?|thresholds?)\b/i;
const DECISION_EXPLANATION_INTENTS = /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i;

function shouldRequireRealToolUse(goal, agentType, interactive = false) {
  if (agentType === "MANAGER") return false;
  if (DECISION_EXPLANATION_INTENTS.test(goal)) return false;
  if (CONFIG_READ_ONLY_INTENTS.test(goal)) return false;
  if (MUTATING_TOOL_INTENTS.test(goal)) return true;
  return interactive && LIVE_DATA_TOOL_INTENTS.test(goal);
}

function buildMessages(systemPrompt, sessionHistory, goal, providerMode = "system") {
  if (providerMode === "user_embedded") {
    return [
      ...sessionHistory,
      {
        role: "user",
        content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
      },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];
}

function isSystemRoleError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /invalid message role:\s*system/i.test(message);
}

function isToolChoiceRequiredError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /tool_choice/i.test(message) && /required/i.test(message);
}

function isThinkingModeToolChoiceError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /thinking mode does not support/i.test(message) && /tool_choice/i.test(message);
}

function isTransientProviderError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  const status = error?.status || error?.code || error?.error?.code;
  return [408, 409, 429, 500, 502, 503, 504, 529].includes(Number(status))
    || /premature close|socket hang up|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(message);
}

export function normalizeScreenerOutcome(modelContent, deployOutcome) {
  const content = String(modelContent || "").trim();
  if (deployOutcome?.success === true) {
    const status = deployOutcome.partial
      ? "⚠️ PARTIAL DEPLOY — VERIFIED TOOL RESULT"
      : "🚀 DEPLOYED — VERIFIED TOOL RESULT";
    const verified = [
      status,
      deployOutcome.pool_name || deployOutcome.pool ? `Pool: ${deployOutcome.pool_name || deployOutcome.pool}` : null,
      deployOutcome.position ? `Position: ${deployOutcome.position}` : null,
      deployOutcome.tx || deployOutcome.txs?.[0] ? `Transaction: ${deployOutcome.tx || deployOutcome.txs[0]}` : null,
      deployOutcome.warning ? `Warning: ${deployOutcome.warning}` : null,
    ].filter(Boolean).join("\n");
    const notes = content.replace(/^\s*(?:🚀\s*DEPLOYED[^\n]*|⛔\s*NO DEPLOY)\s*/i, "").trim();
    return notes ? `${verified}\n\nMODEL ASSESSMENT\n${notes}` : verified;
  }
  if (deployOutcome || /🚀\s*DEPLOYED|position opened|deploy(?:ment)? successful/i.test(content)) {
    const why = deployOutcome?.error || deployOutcome?.reason || (deployOutcome ? "deployment did not succeed" : "deploy_position was not called");
    return `⛔ NO DEPLOY\n\nDeployment failed: ${why}`;
  }
  return content;
}

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null, options = {}) {
  const { interactive = false, onToolStart = null, onToolFinish = null, dependencies = {}, autonomousDeploymentPlans = null, toolArgBindings = null } = options;
  const deps = {
    getWalletBalances,
    getMyPositions,
    createChatCompletion,
    executeTool,
    ...dependencies,
  };
  // Build dynamic system prompt with current portfolio state
  const [portfolio, positions] = await Promise.all([deps.getWalletBalances(), deps.getMyPositions()]);
  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const decisionSummary = getDecisionSummary();
  let weightsSummary = null;
  if (agentType === "SCREENER") {
    try {
      const { getWeightsSummary } = await import("./signal-weights.js");
      const { config } = await import("./config.js");
      if (config.darwin?.enabled) weightsSummary = getWeightsSummary();
    } catch { /* signal-weights not critical */ }
  }
  const systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary, weightsSummary, decisionSummary);

  let providerMode = "system";
  let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);

  // Track write tools fired this session — prevent the model from calling the same
  // destructive tool twice (e.g. deploy twice, swap twice after auto-swap)
  const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
  // These lock after first attempt regardless of success — retrying them is always wrong
  const NO_RETRY_TOOLS = new Set(["deploy_position"]);
  const firedOnce = new Set();
  const mustUseRealTool = shouldRequireRealToolUse(goal, agentType, interactive);
  let sawToolCall = false;
  let noToolRetryCount = 0;
  let deployOutcome = null;
  // Stays true for the whole run once a thinking-mode provider rejects tool_choice
  let omitToolChoice = false;

  let emptyStreak = 0;
  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const activeModel = model || DEFAULT_MODEL;

      // Retry up to 3 times on transient provider errors (502, 503, 529)
      const FALLBACK_MODEL = "stepfun/step-3.5-flash:free";
      let response;
      let usedModel = activeModel;
      // Force a tool call on step 0 for action intents — prevents the model from inventing deploy/close outcomes
      const ACTION_INTENTS = /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;
      // A screener is allowed to make the safe choice (NO_DEPLOY) without a
      // ceremonial tool call. Only an actual deployment must be tool-backed.
      let toolChoice = (agentType !== "SCREENER" && step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool)) ? "required" : "auto";

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const reqParams = {
            model: usedModel,
            messages,
            tools: getToolsForRole(agentType, goal),
            temperature: config.llm.temperature,
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
          };
          if (!omitToolChoice) reqParams.tool_choice = toolChoice;
          response = await deps.createChatCompletion(reqParams);
        } catch (error) {
          if (providerMode === "system" && isSystemRoleError(error)) {
            providerMode = "user_embedded";
            messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);
            log("agent", "Provider rejected system role — retrying with embedded system instructions");
            attempt -= 1;
            continue;
          }
          if (toolChoice === "required" && isToolChoiceRequiredError(error)) {
            toolChoice = "auto";
            log("agent", "Provider rejected tool_choice=required — retrying with tool_choice=auto");
            attempt -= 1;
            continue;
          }
          if (!omitToolChoice && isThinkingModeToolChoiceError(error)) {
            omitToolChoice = true;
            log("agent", "Provider thinking mode does not support tool_choice — retrying without it");
            attempt -= 1;
            continue;
          }
          if (isTransientProviderError(error) && attempt < 2) {
            const wait = (attempt + 1) * 5000;
            log("agent", `Transient provider error (${error?.message || error}), retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          throw error;
        }
        if (response.choices?.length) break;
        const errCode = response.error?.code;
        if (errCode === 502 || errCode === 503 || errCode === 529) {
          const wait = (attempt + 1) * 5000;
          if (attempt === 1 && usedModel !== FALLBACK_MODEL) {
            usedModel = FALLBACK_MODEL;
            log("agent", `Switching to fallback model ${FALLBACK_MODEL}`);
          } else {
            log("agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
          }
        } else {
          break;
        }
      }

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }
      const msg = response.choices[0].message;
      // Repair malformed tool call JSON before pushing to history —
      // the API rejects the next request if history contains invalid JSON args
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
                log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
              } catch {
                tc.function.arguments = "{}";
                log("error", `Could not repair JSON args for ${tc.function.name} — cleared to {}`);
              }
            }
          }
        }
      }
      // DeepSeek thinking mode: push full message (content + reasoning_content + tool_calls)
      const assistantMsg = { role: msg.role || "assistant", content: msg.content };
      if (msg.reasoning_content) assistantMsg.reasoning_content = msg.reasoning_content;
      if (msg.tool_calls) assistantMsg.tool_calls = msg.tool_calls;
      messages.push(assistantMsg);

      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Hermes sometimes returns null content — pop the empty message and retry once
        if (!msg.content) {
          messages.pop(); // remove the empty assistant message
          log("agent", "Empty response, retrying...");
          continue;
        }
        if (mustUseRealTool && !sawToolCall) {
          noToolRetryCount += 1;
          messages.pop();
          log("agent", `Rejected no-tool final answer (${noToolRetryCount}/2) for tool-required request`);
          if (noToolRetryCount >= 2) {
            return {
              content: "I couldn't complete that reliably because no tool call was made. Please retry after checking the logs.",
              userMessage: goal,
            };
          }
          messages.push({
            role: providerMode === "system" ? "system" : "user",
            content: providerMode === "system"
              ? "You have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result."
              : "[SYSTEM REMINDER]\nYou have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result.",
          });
          continue;
        }
        const finalContent = agentType === "SCREENER"
          ? normalizeScreenerOutcome(msg.content, deployOutcome)
          : msg.content;
        log("agent", "Final answer reached");
        log("agent", finalContent);
        return { content: finalContent, userMessage: goal };
      }
      sawToolCall = true;

      // Parse and reserve before starting any asynchronous work. This closes the
      // duplicate-deploy TOCTOU window when a model emits two deploy calls in one batch.
      const MUTATING_TOOLS = new Set([
        "deploy_position", "close_position", "claim_fees", "swap_token",
        "set_position_note", "self_update", "update_config", "add_strategy",
        "set_active_strategy", "remove_strategy", "add_pool_note", "add_to_blacklist",
        "remove_from_blacklist", "block_deployer", "unblock_deployer", "add_smart_wallet",
        "remove_smart_wallet", "add_lesson", "pin_lesson", "unpin_lesson", "clear_lessons",
      ]);
      const parsedCalls = msg.tool_calls.map((toolCall) => {
        const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
        let functionArgs;
        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          try {
            functionArgs = JSON.parse(jsonrepair(toolCall.function.arguments));
            log("warn", `Repaired malformed JSON args for ${functionName}`);
          } catch (parseError) {
            log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
            functionArgs = {};
          }
        }
        const duplicate = ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName);
        if (!duplicate && NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
        return { toolCall, functionName, functionArgs, duplicate };
      });

      let mutationChain = Promise.resolve();
      const toolResults = await Promise.all(parsedCalls.map((call) => {
        const run = async () => {
          const { toolCall, functionName, duplicate } = call;
          let { functionArgs } = call;
          if (duplicate) {
            const blocked = { blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` };
            log("agent", `Blocked duplicate ${functionName} call — already reserved this session`);
            await onToolFinish?.({ name: functionName, args: functionArgs, result: blocked, success: false, step });
            return { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(blocked) };
          }

          if (agentType === "SCREENER" && functionName === "deploy_position") {
            const trustedPlan = autonomousDeploymentPlans?.get?.(functionArgs.pool_address)
              || autonomousDeploymentPlans?.[functionArgs.pool_address];
            if (!trustedPlan) {
              const result = { blocked: true, reason: "Selected pool has no host-computed authoritative deployment plan" };
              deployOutcome = { ...result, success: false };
              await onToolFinish?.({ name: functionName, args: functionArgs, result, success: false, step });
              return { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(result) };
            }
            functionArgs = trustedPlan;
          }
          if (toolArgBindings?.[functionName]) {
            functionArgs = { ...functionArgs, ...toolArgBindings[functionName] };
          }
          await onToolStart?.({ name: functionName, args: functionArgs, step });
          const result = await deps.executeTool(functionName, functionArgs, {
            autonomous: agentType === "SCREENER",
            trustedAutonomousPlan: agentType === "SCREENER" && functionName === "deploy_position",
          });
          const success = result?.success !== false && !result?.error && !result?.blocked;
          if (functionName === "deploy_position") deployOutcome = { ...result, success };
          await onToolFinish?.({ name: functionName, args: functionArgs, result, success, step });
          // close/swap lock only after a successful attempt; deploy was reserved above.
          if (!NO_RETRY_TOOLS.has(functionName) && ONCE_PER_SESSION.has(functionName) && success) firedOnce.add(functionName);
          return { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(result) };
        };

        if (!MUTATING_TOOLS.has(call.functionName) || call.duplicate) return run();
        const queued = mutationChain.then(run, run);
        mutationChain = queued.then(() => undefined, () => undefined);
        return queued;
      }));

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      // If it's a rate limit, wait and retry
      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
