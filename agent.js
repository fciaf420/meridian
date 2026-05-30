import OpenAI from "openai";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getMemoryContext } from "./memory.js";
import { getWeightsSummary } from "./signal-weights.js";
import { getLpOverviewSummary } from "./tools/lp-overview.js";
import { buildUnifiedMemoryBrief } from "./unified-memory.js";
import {
  createLlmClient,
  getDefaultModelForProvider,
  getLlmProvider,
  runCodexExec,
  runClaudeCli,
} from "./llm-provider.js";

const PROVIDER = getLlmProvider();
const CLI_PROVIDERS = new Set(["codex", "claude"]);
const client = CLI_PROVIDERS.has(PROVIDER) ? null : createLlmClient(PROVIDER);

const DEFAULT_MODEL = process.env.LLM_MODEL || getDefaultModelForProvider();
const RETRYABLE = new Set([402, 408, 429, 502, 503, 504, 529]);
// update_config mutates live risk params, so treat it as a guarded write: it must
// run through the strict-parse write path (no {} fallback) and serially, not in the
// lenient parallel read batch.
const WRITE_TOOLS = new Set(["deploy_position", "close_position", "claim_fees", "swap_token", "update_config"]);
const TOOL_SUMMARIES = tools.map((tool) => ({
  name: tool.function.name,
  description: tool.function.description,
  parameters: tool.function.parameters || { type: "object", properties: {} },
}));
const TOOL_SUMMARIES_TEXT = JSON.stringify(TOOL_SUMMARIES, null, 2);

export function getScreenerModelLabel() {
  return config.llm.screeningModel;
}

export async function screenerLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = []) {
  return agentLoop(goal, maxSteps, sessionHistory, "SCREENER", config.llm.screeningModel);
}

function getRolePrimaryModel(agentType) {
  if (agentType === "SCREENER") return config.llm.screeningModel;
  if (agentType === "MANAGER") return config.llm.managementModel;
  return config.llm.generalModel;
}

function getRoleFallbackModel(agentType, primaryModel) {
  const configuredFallback = agentType === "SCREENER"
    ? config.llm.screeningFallbackModel
    : agentType === "MANAGER"
      ? config.llm.managementFallbackModel
      : config.llm.generalFallbackModel;

  if (configuredFallback && configuredFallback !== primaryModel) {
    return configuredFallback;
  }

  const rolePrimary = getRolePrimaryModel(agentType);
  if (rolePrimary && rolePrimary !== primaryModel) {
    return rolePrimary;
  }

  return null;
}

function safeParseJson(raw, fallback = {}) {
  if (!raw || typeof raw !== "string") return fallback;

  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function formatMessageContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part?.text) return part.text;
      return JSON.stringify(part);
    }).join("\n");
  }

  return JSON.stringify(content, null, 2);
}

function findToolNameForResult(messages, index, toolCallId) {
  for (let i = index - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;

    const match = message.tool_calls.find((toolCall) => toolCall.id === toolCallId);
    if (match?.function?.name) {
      return match.function.name;
    }
  }

  return null;
}

function buildCodexTranscript(messages) {
  return messages.map((message, index) => {
    if (message.role === "system") {
      return `SYSTEM:\n${formatMessageContent(message.content)}`;
    }

    if (message.role === "user") {
      return `USER:\n${formatMessageContent(message.content)}`;
    }

    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      const requestedTools = message.tool_calls.map((toolCall) => ({
        name: toolCall.function?.name || "unknown_tool",
        arguments: safeParseJson(toolCall.function?.arguments, {}),
      }));

      return `ASSISTANT TOOL REQUESTS:\n${JSON.stringify(requestedTools, null, 2)}`;
    }

    if (message.role === "assistant") {
      return `ASSISTANT:\n${formatMessageContent(message.content)}`;
    }

    if (message.role === "tool") {
      const toolName = findToolNameForResult(messages, index, message.tool_call_id) || "unknown_tool";
      return `TOOL RESULT (${toolName}):\n${formatMessageContent(message.content)}`;
    }

    return `${String(message.role || "unknown").toUpperCase()}:\n${formatMessageContent(message.content)}`;
  }).join("\n\n");
}

// Static system prompt — cached by claude -p via --system-prompt (KV cache friendly)
const _systemPromptCache = {};
function getClaudeSystemPrompt(agentType) {
  if (_systemPromptCache[agentType]) return _systemPromptCache[agentType];
  _systemPromptCache[agentType] = [
    `You are the ${agentType} reasoning engine for a JavaScript trading agent runner.`,
    "Return raw JSON only. Do not wrap it in markdown fences or add any extra commentary.",
    "Choose one of two actions only:",
    '1. "respond" when you can fully answer the user with the information already available.',
    '2. "tool_calls" when you need one or more listed tools to continue.',
    "If you choose tool_calls, keep response null and provide exact JSON arguments for each tool call.",
    "Never invent tool outputs, transaction results, or on-chain state.",
    "Only use tool names from the available tools list.",
    "Be conservative with write tools. Only call them when you intentionally want the runner to perform the real action.",
    'Return exactly this shape: {"action":"respond","response":"...","tool_calls":[]} or {"action":"tool_calls","response":null,"tool_calls":[{"name":"tool_name","arguments":{}}]}',
    `AVAILABLE TOOLS:\n${TOOL_SUMMARIES_TEXT}`,
  ].join("\n\n");
  return _systemPromptCache[agentType];
}

// Full prompt for Codex/OpenRouter (everything in one blob)
function buildCodexAgentPrompt(messages, agentType) {
  const transcript = buildCodexTranscript(messages);

  return [
    `You are the ${agentType} reasoning engine for a JavaScript trading agent runner.`,
    "Return raw JSON only. Do not wrap it in markdown fences or add any extra commentary.",
    "Choose one of two actions only:",
    '1. "respond" when you can fully answer the user with the information already available.',
    '2. "tool_calls" when you need one or more listed tools to continue.',
    "If you choose tool_calls, keep response null and provide exact JSON arguments for each tool call.",
    "Never invent tool outputs, transaction results, or on-chain state.",
    "Only use tool names from the available tools list.",
    "Be conservative with write tools. Only call them when you intentionally want the runner to perform the real action.",
    'Return exactly this shape: {"action":"respond","response":"...","tool_calls":[]} or {"action":"tool_calls","response":null,"tool_calls":[{"name":"tool_name","arguments":{}}]}',
    `AVAILABLE TOOLS:\n${TOOL_SUMMARIES_TEXT}`,
    `CONVERSATION TRANSCRIPT:\n${transcript}`,
  ].join("\n\n");
}

function parseCodexJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const fencedMatch = content.match(/```json\s*([\s\S]*?)```/i) || content.match(/(\{[\s\S]*\})/);
    if (!fencedMatch) {
      throw new Error("Codex CLI returned non-JSON output");
    }
    return JSON.parse(fencedMatch[1]);
  }
}

function normalizeCodexToolCalls(toolCalls, step) {
  return toolCalls.map((toolCall, index) => {
    const name = typeof toolCall?.name === "string" ? toolCall.name.trim() : "";
    if (!name) {
      throw new Error("Codex CLI returned a tool call without a name");
    }

    const args = toolCall.arguments && typeof toolCall.arguments === "object" && !Array.isArray(toolCall.arguments)
      ? toolCall.arguments
      : {};

    return {
      id: `codex-tool-${step + 1}-${index + 1}`,
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    };
  });
}

async function createCodexMessage(messages, model, agentType, step) {
  const prompt = buildCodexAgentPrompt(messages, agentType);
  const content = await runCodexExec(model, prompt, {
    cwd: process.cwd(),
    sandbox: "read-only",
    skipGitRepoCheck: true,
    config: {
      suppress_unstable_features_warning: "true",
      model_reasoning_effort: agentType === "MANAGER" ? "high" : "medium",
    },
  });

  if (!content) {
    throw new Error("Empty response from Codex CLI");
  }

  const plan = parseCodexJson(content);
  if (plan?.action === "respond") {
    return {
      role: "assistant",
      content: typeof plan.response === "string" ? plan.response : "",
    };
  }

  if (plan?.action === "tool_calls") {
    const toolCalls = Array.isArray(plan.tool_calls) ? plan.tool_calls : [];
    if (toolCalls.length === 0) {
      throw new Error("Codex CLI requested tool_calls without any tools");
    }

    return {
      role: "assistant",
      content: null,
      tool_calls: normalizeCodexToolCalls(toolCalls, step),
    };
  }

  throw new Error("Codex CLI returned an invalid action");
}

const CLAUDE_EFFORT_BY_ROLE = {
  SCREENER: "medium",
  MANAGER: "low",
  GENERAL: "medium",
  AUTORESEARCH: "high",
};

async function createClaudeMessage(messages, model, agentType, step) {
  // Split: static system prompt goes via --system-prompt (KV cached by claude -p)
  // Dynamic transcript goes via stdin (changes every call, not cached)
  const transcript = buildCodexTranscript(messages);
  const systemPrompt = getClaudeSystemPrompt(agentType);
  const effort = CLAUDE_EFFORT_BY_ROLE[agentType] || "medium";
  const content = await runClaudeCli(model, `CONVERSATION TRANSCRIPT:\n${transcript}`, { effort, systemPrompt });

  if (!content) {
    throw new Error("Empty response from Claude CLI");
  }

  const plan = parseCodexJson(content); // same JSON format
  if (plan?.action === "respond") {
    return {
      role: "assistant",
      content: typeof plan.response === "string" ? plan.response : "",
    };
  }

  if (plan?.action === "tool_calls") {
    const toolCalls = Array.isArray(plan.tool_calls) ? plan.tool_calls : [];
    if (toolCalls.length === 0) {
      throw new Error("Claude CLI requested tool_calls without any tools");
    }

    return {
      role: "assistant",
      content: null,
      tool_calls: normalizeCodexToolCalls(toolCalls, step),
    };
  }

  throw new Error("Claude CLI returned an invalid action");
}

async function createProviderMessage(messages, model, agentType, step) {
  if (PROVIDER === "codex") {
    return createCodexMessage(messages, model, agentType, step);
  }

  if (PROVIDER === "claude") {
    return createClaudeMessage(messages, model, agentType, step);
  }

  const completionOptions = {
    model,
    messages,
    tools,
    tool_choice: "auto",
    temperature: config.llm.temperature,
    max_tokens: config.llm.maxTokens,
  };

  if (PROVIDER === "minimax" && agentType === "SCREENER") {
    completionOptions.extra_body = { reasoning_split: true };
  }

  const response = await client.chat.completions.create(completionOptions);

  if (!response?.choices?.length) {
    const errCode = response?.error?.code || response?.error?.status;
    if (RETRYABLE.has(errCode)) {
      throw Object.assign(new Error(response.error?.message || `Provider error ${errCode}`), { status: errCode });
    }

    log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
    throw new Error(`API returned no choices: ${response?.error?.message || JSON.stringify(response)}`);
  }

  return response.choices[0].message;
}

function buildCodexLightChatPrompt(messages) {
  const transcript = buildCodexTranscript(messages);

  return [
    "You are answering a lightweight chat request for a DLMM trading agent.",
    'If live on-chain data or tools are required, reply with exactly "[NEED_TOOLS]" and nothing else.',
    "Otherwise answer directly, using only the provided transcript.",
    `CONVERSATION TRANSCRIPT:\n${transcript}`,
  ].join("\n\n");
}

async function requestLightChatContent(messages, model) {
  if (PROVIDER === "codex") {
    return runCodexExec(model, buildCodexLightChatPrompt(messages), {
      cwd: process.cwd(),
      sandbox: "read-only",
      skipGitRepoCheck: true,
      config: {
        suppress_unstable_features_warning: "true",
        model_reasoning_effort: "low",
      },
    });
  }

  if (PROVIDER === "claude") {
    return runClaudeCli(model, buildCodexLightChatPrompt(messages), { effort: "low" });
  }

  const response = await client.chat.completions.create({
    model,
    messages,
    temperature: config.llm.temperature,
    max_tokens: config.llm.maxTokens,
  });

  return response.choices?.[0]?.message?.content || "";
}

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null) {
  const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
  const stateSummary = getStateSummary();
  const perfSummary = getPerformanceSummary();
  const signalWeights = agentType === "SCREENER" ? (getWeightsSummary() || null) : null;
  const unifiedMemory = buildUnifiedMemoryBrief(agentType);
  let systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, unifiedMemory, perfSummary, signalWeights);

  const lpSummary = await getLpOverviewSummary().catch(() => null);
  if (lpSummary) {
    systemPrompt += `\n\nLP AGENT PERFORMANCE (real data from LP Agent API - use this for accurate PnL):\n${lpSummary}\n`;
  }

  const messages = [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];
  let consecutiveEmptyResponses = 0;

  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const activeModel = model || getRolePrimaryModel(agentType) || DEFAULT_MODEL;
      const fallbackModel = getRoleFallbackModel(agentType, activeModel);
      let msg;
      let usedModel = activeModel;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          msg = await createProviderMessage(messages, usedModel, agentType, step);
          break;
        } catch (apiErr) {
          const errMsg = apiErr.message || "";
          // Claude rate limit — skip retries, go straight to DeepSeek
          if (errMsg.includes("rate limited") || errMsg.includes("hit your limit") || errMsg.includes("resets")) {
            log("agent", `Claude rate limited — skipping retries, falling back to DeepSeek`);
            msg = null;
            break;
          }

          const status = apiErr.status || apiErr.statusCode;
          const retryable = PROVIDER === "codex" || PROVIDER === "claude" || RETRYABLE.has(status);
          if (!retryable) throw apiErr;

          if (attempt >= 1 && fallbackModel && usedModel !== fallbackModel) {
            usedModel = fallbackModel;
            log("agent", `Primary model failed (${status || apiErr.message}), switching to fallback ${fallbackModel}`);
          } else {
            const wait = (attempt + 1) * 5000;
            log("agent", `Provider error ${status || apiErr.message}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await sleep(wait);
          }
          msg = null;
        }
      }

      // If primary provider exhausted all retries, fall back to DeepSeek
      if (!msg) {
        const DEEPSEEK_FALLBACK_MODELS = {
          SCREENER: "deepseek-reasoner",
          MANAGER: "deepseek-chat",
          GENERAL: "deepseek-chat",
          AUTORESEARCH: "deepseek-reasoner",
        };
        const dsModel = DEEPSEEK_FALLBACK_MODELS[agentType] || "deepseek-chat";

        const fallbackKey = process.env.DEEPSEEK_API_KEY;
        if (fallbackKey) {
          try {
            log("agent", `All ${PROVIDER} retries exhausted — falling back to ${dsModel} via DeepSeek API`);
            const fallbackClient = new OpenAI({
              baseURL: "https://api.deepseek.com/v1",
              apiKey: fallbackKey,
            });
            const dsResponse = await fallbackClient.chat.completions.create({
              model: dsModel,
              messages,
              tools,
              tool_choice: "auto",
              temperature: config.llm.temperature,
              max_tokens: config.llm.maxTokens,
            });
            if (dsResponse?.choices?.length) {
              msg = dsResponse.choices[0].message;
              log("agent", `DeepSeek fallback succeeded (model: ${dsModel})`);
            }
          } catch (dsErr) {
            log("agent", `DeepSeek fallback also failed: ${dsErr.message}`);
          }
        }
      }

      if (!msg) {
        throw new Error("Provider returned no assistant message");
      }

      messages.push(msg);

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        if (!msg.content) {
          messages.pop();
          consecutiveEmptyResponses += 1;
          if (consecutiveEmptyResponses >= 3) {
            throw new Error(`Model returned ${consecutiveEmptyResponses} empty responses in a row`);
          }
          log("agent", `Empty response, retrying (${consecutiveEmptyResponses}/3)...`);
          continue;
        }

        consecutiveEmptyResponses = 0;
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return { content: msg.content, userMessage: goal };
      }

      consecutiveEmptyResponses = 0;
      const writeCalls = msg.tool_calls.filter((toolCall) => WRITE_TOOLS.has(toolCall.function.name));
      const readCalls = msg.tool_calls.filter((toolCall) => !WRITE_TOOLS.has(toolCall.function.name));

      const readResults = await Promise.all(readCalls.map(async (toolCall) => {
        const functionName = toolCall.function.name;
        let functionArgs;
        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch (parseError) {
          log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
          functionArgs = {};
        }
        const result = await executeTool(functionName, functionArgs);
        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      }));

      const writeResults = [];
      for (const toolCall of writeCalls) {
        const functionName = toolCall.function.name;
        let functionArgs;
        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch (parseError) {
          // Write tools mutate on-chain state / live risk params. Do NOT fall back to
          // {} and execute with defaults — return a tool error so the LLM must re-issue
          // the call with well-formed arguments.
          log("error", `Failed to parse args for write tool ${functionName}: ${parseError.message}`);
          writeResults.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              error: `Malformed JSON arguments for write tool "${functionName}": ${parseError.message}. Not executed. Re-issue the call with valid JSON arguments.`,
              tool: functionName,
            }),
          });
          continue;
        }
        const result = await executeTool(functionName, functionArgs);
        writeResults.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }

      const resultMap = new Map([...readResults, ...writeResults].map((result) => [result.tool_call_id, result]));
      const toolResults = msg.tool_calls.map((toolCall) => resultMap.get(toolCall.id)).filter(Boolean);

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

/**
 * Lightweight chat - uses nuggets-cached context instead of fetching from chain.
 * First attempts a single LLM call with no tools. If the LLM says it needs tools
 * (by including "[NEED_TOOLS]" in its response), escalates to full agentLoop.
 *
 * Typical response time: ~1-3s vs ~15-30s for full agentLoop.
 */
export async function lightChat(goal, sessionHistory = [], model = null) {
  const stateSummary = getStateSummary();
  const memoryContext = getMemoryContext();
  const perfSummary = getPerformanceSummary();

  const contextParts = [
    "You are a DLMM liquidity agent assistant. Answer the user's question using the context below.",
    'If you need LIVE on-chain data (current prices, exact PnL, execute transactions) that is not in the context, respond with exactly "[NEED_TOOLS]" and nothing else.',
    "For general questions, explanations, strategy discussion, or anything answerable from context - just answer directly.",
  ];

  if (stateSummary) contextParts.push(`\nCURRENT STATE:\n${stateSummary}`);
  if (memoryContext) contextParts.push(`\nMEMORY (from nuggets):\n${memoryContext}`);
  if (perfSummary) {
    contextParts.push(`\nPERFORMANCE: ${perfSummary.total_positions_closed} closed, win rate ${perfSummary.win_rate_pct}%, avg PnL ${perfSummary.avg_pnl_pct}%`);
  }

  const lpSummary = await getLpOverviewSummary().catch(() => null);
  if (lpSummary) {
    contextParts.push(`\nLP AGENT PERFORMANCE (verified on-chain data):\n${lpSummary}`);
  }

  const messages = [
    { role: "system", content: contextParts.join("\n") },
    ...sessionHistory,
    { role: "user", content: goal },
  ];

  const primaryModel = model || getRolePrimaryModel("GENERAL") || DEFAULT_MODEL;
  const fallbackModel = getRoleFallbackModel("GENERAL", primaryModel);
  const modelsToTry = fallbackModel ? [primaryModel, fallbackModel] : [primaryModel];

  for (const tryModel of modelsToTry) {
    try {
      const content = await requestLightChatContent(messages, tryModel);
      if (!content || content.trim().includes("[NEED_TOOLS]")) {
        log("agent", "Light chat escalating to full agent loop");
        return agentLoop(goal, config.llm.maxSteps, sessionHistory, "GENERAL", model);
      }

      log("agent", `Light chat answered directly (${tryModel})`);
      return { content, userMessage: goal };
    } catch (error) {
      const status = error.status || error.statusCode;
      const retryable = PROVIDER === "codex" || PROVIDER === "claude" || RETRYABLE.has(status);
      if (fallbackModel && tryModel !== fallbackModel && retryable) {
        log("agent", `Light chat primary failed (${status || error.message}), trying fallback ${fallbackModel}`);
        continue;
      }
      log("agent", `Light chat failed (${error.message}), falling back to full agent loop`);
      return agentLoop(goal, config.llm.maxSteps, sessionHistory, "GENERAL", model);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
