import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import OpenAI from "openai";

const DEFAULT_PROVIDER = "codex";

export function getLlmProvider() {
  return process.env.LLM_PROVIDER || DEFAULT_PROVIDER;
}

export function getDefaultModelForProvider(provider = getLlmProvider()) {
  if (provider === "codex") return "gpt-4o";
  if (provider === "claude") return "sonnet";
  if (provider === "deepseek") return "deepseek-chat";
  if (provider === "minimax") return "MiniMax-M2.7";
  return "openai/gpt-5.4-nano";
}

export function readCodexOAuthToken() {
  const authPath = path.join(homedir(), ".codex", "auth.json");

  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    const token = auth.access_token
      || auth.api_key
      || auth.token
      || auth.OPENAI_API_KEY
      || auth.tokens?.access_token
      || auth.tokens?.api_key
      || auth.tokens?.token;
    if (!token) {
      throw new Error("No token field found in ~/.codex/auth.json");
    }
    return token;
  } catch (error) {
    throw new Error(`Codex OAuth token not available (${error.message}). Run "codex login" first.`);
  }
}

export function getProviderApiKey(provider = getLlmProvider()) {
  if (provider === "codex") {
    throw new Error("Codex provider uses the Codex CLI harness, not direct API key access.");
  }
  if (provider === "claude") {
    throw new Error("Claude provider uses the Claude CLI (OAuth), not direct API key access.");
  }
  if (provider === "deepseek") return process.env.DEEPSEEK_API_KEY;
  if (provider === "minimax") return process.env.MINIMAX_API_KEY;
  if (provider === "openrouter") return process.env.OPENROUTER_API_KEY;
  throw new Error(`Unknown LLM provider: ${provider}`);
}

export function getProviderClientConfig(provider = getLlmProvider()) {
  if (provider === "codex") {
    throw new Error("Codex provider uses the Codex CLI harness, not OpenAI client config.");
  }
  if (provider === "claude") {
    throw new Error("Claude provider uses the Claude CLI (OAuth), not OpenAI client config.");
  }

  if (provider === "deepseek") {
    return {
      baseURL: "https://api.deepseek.com",
      apiKey: getProviderApiKey(provider),
    };
  }

  if (provider === "minimax") {
    return {
      baseURL: "https://api.minimax.io/v1",
      apiKey: getProviderApiKey(provider),
    };
  }

  if (provider !== "openrouter") {
    throw new Error(`Unknown LLM provider: ${provider}`);
  }

  return {
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: getProviderApiKey(provider),
  };
}

export function getChatCompletionsEndpoint(provider = getLlmProvider()) {
  if (provider === "codex") {
    throw new Error("Codex provider uses the Codex CLI harness, not direct chat completions.");
  }
  if (provider === "claude") {
    throw new Error("Claude provider uses the Claude CLI (OAuth), not direct chat completions.");
  }
  if (provider === "deepseek") return "https://api.deepseek.com/chat/completions";
  if (provider === "minimax") return "https://api.minimax.io/v1/chat/completions";
  if (provider !== "openrouter") {
    throw new Error(`Unknown LLM provider: ${provider}`);
  }
  return "https://openrouter.ai/api/v1/chat/completions";
}

export function createLlmClient(provider = getLlmProvider()) {
  return new OpenAI(getProviderClientConfig(provider));
}

function findExecutableOnPath(binName) {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookup, [binName], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || null;
}

function resolveCodexLaunch() {
  const configured = process.env.CODEX_PATH?.trim();
  if (configured) {
    if (process.platform === "win32") {
      if (/\.exe$/i.test(configured)) {
        return { command: configured, viaCmd: false };
      }

      const siblingExe = configured.replace(/\.(cmd|bat|ps1)$/i, ".exe");
      if (siblingExe !== configured && existsSync(siblingExe)) return { command: siblingExe, viaCmd: false };

      const codexExe = findExecutableOnPath("codex.exe");
      if (codexExe) return { command: codexExe, viaCmd: false };

      if (/\.(cmd|bat)$/i.test(configured)) {
        return { command: configured, viaCmd: true };
      }
    }

    return { command: configured, viaCmd: false };
  }

  if (process.platform === "win32") {
    const codexExe = findExecutableOnPath("codex.exe");
    if (codexExe) return { command: codexExe, viaCmd: false };

    const codexAny = findExecutableOnPath("codex");
    if (codexAny && /\.exe$/i.test(codexAny)) return { command: codexAny, viaCmd: false };

    const codexCmd = findExecutableOnPath("codex.cmd");
    if (codexCmd) {
      const siblingExe = codexCmd.replace(/\.cmd$/i, ".exe");
      if (siblingExe !== codexCmd && existsSync(siblingExe)) return { command: siblingExe, viaCmd: false };
      return { command: codexCmd, viaCmd: true };
    }
  }

  return { command: "codex", viaCmd: false };
}

function extractCodexMessage(output) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  let lastStructuredError = "";

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]);
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item?.text) {
        return event.item.text;
      }
      if (event.type === "message" && event.role === "assistant" && event.content) {
        return typeof event.content === "string"
          ? event.content
          : event.content.map((c) => c.text || "").join("\n");
      }
      if (!lastStructuredError && event.type === "item.completed" && event.item?.type === "error" && event.item?.message) {
        lastStructuredError = event.item.message;
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }

  return lastStructuredError || output.trim();
}

function killChildProcess(child) {
  if (!child?.pid) return;

  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      return;
    } catch {
      // Fall through to best-effort child kill.
    }
  }

  try {
    child.kill("SIGKILL");
  } catch {
    // Best-effort cleanup only.
  }
}

export function runCodexExec(model, prompt, {
  timeoutMs = 180000,
  cwd = process.cwd(),
  config = {},
  sandbox = "read-only",
  skipGitRepoCheck = true,
  outputSchemaPath = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const { command, viaCmd } = resolveCodexLaunch();
    const args = [
      "exec",
      "--model",
      model,
    ];

    if (outputSchemaPath) {
      args.push("--output-schema", outputSchemaPath);
    }

    args.push(
      "--sandbox",
      sandbox,
      "--json",
      "-",
    );

    if (skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }

    for (const [key, value] of Object.entries(config)) {
      args.push("-c", `${key}=${value}`);
    }

    const spawnCommand = viaCmd ? (process.env.ComSpec || "cmd.exe") : command;
    const spawnArgs = viaCmd ? ["/d", "/c", command, ...args] : args;
    const child = spawn(spawnCommand, spawnArgs, {
      env: { ...process.env },
      windowsHide: true,
      cwd,
    });

    child.stdin.end(prompt, "utf8");

    let killed = false;
    const killTimer = setTimeout(() => {
      killed = true;
      killChildProcess(child);
      reject(new Error(`Codex CLI timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.stdout.on("data", (data) => stdoutChunks.push(data.toString()));
    child.stderr.on("data", (data) => stderrChunks.push(data.toString()));

    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (killed) return;

      const output = stdoutChunks.join("");
      const stderr = stderrChunks.join("").trim();
      if (code !== 0) {
        reject(new Error(stderr || extractCodexMessage(output) || `Codex CLI exited with code ${code}`));
        return;
      }

      resolve(extractCodexMessage(output));
    });

    child.on("error", (err) => reject(err));
  });
}

function resolveClaudeLaunch() {
  const configured = process.env.CLAUDE_PATH?.trim();
  if (configured) {
    if (process.platform === "win32") {
      if (/\.exe$/i.test(configured)) {
        return { command: configured, viaCmd: false };
      }

      const siblingExe = configured.replace(/\.(cmd|bat|ps1)$/i, ".exe");
      if (siblingExe !== configured && existsSync(siblingExe)) return { command: siblingExe, viaCmd: false };

      const claudeExe = findExecutableOnPath("claude.exe");
      if (claudeExe) return { command: claudeExe, viaCmd: false };

      if (/\.(cmd|bat)$/i.test(configured)) {
        return { command: configured, viaCmd: true };
      }
    }

    return { command: configured, viaCmd: false };
  }

  if (process.platform === "win32") {
    const claudeExe = findExecutableOnPath("claude.exe");
    if (claudeExe) return { command: claudeExe, viaCmd: false };

    const claudeAny = findExecutableOnPath("claude");
    if (claudeAny && /\.exe$/i.test(claudeAny)) return { command: claudeAny, viaCmd: false };

    const claudeCmd = findExecutableOnPath("claude.cmd");
    if (claudeCmd) {
      const siblingExe = claudeCmd.replace(/\.cmd$/i, ".exe");
      if (siblingExe !== claudeCmd && existsSync(siblingExe)) return { command: siblingExe, viaCmd: false };
      return { command: claudeCmd, viaCmd: true };
    }
  }

  return { command: "claude", viaCmd: false };
}

// Rate limit tracking — skip Claude and go straight to DeepSeek until reset
let _claudeRateLimitedUntil = 0;

export function isClaudeRateLimited() {
  return Date.now() < _claudeRateLimitedUntil;
}

function parseRateLimitReset(msg) {
  // "You've hit your limit · resets 10pm (America/New_York)"
  // "You've hit your limit · resets 12pm (America/New_York)"
  const match = msg?.match(/resets?\s+(\d{1,2})(am|pm)/i);
  if (!match) return Date.now() + 3600_000; // default 1 hour
  let hour = parseInt(match[1]);
  if (match[2].toLowerCase() === "pm" && hour < 12) hour += 12;
  if (match[2].toLowerCase() === "am" && hour === 12) hour = 0;

  // Build target time in ET (approximate — use local offset)
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour + 4, 0, 0, 0); // ET is roughly UTC-4/5
  if (target <= now) target.setDate(target.getDate() + 1);
  return target.getTime();
}

export function runClaudeCli(model, prompt, {
  timeoutMs = 180000,
  systemPrompt = null,
  effort = null,
} = {}) {
  // Skip if rate limited — caller should fall back to DeepSeek
  if (isClaudeRateLimited()) {
    const mins = Math.ceil((_claudeRateLimitedUntil - Date.now()) / 60000);
    return Promise.reject(new Error(`Claude rate limited — resets in ~${mins}m. Use DeepSeek fallback.`));
  }
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const { command, viaCmd } = resolveClaudeLaunch();
    const args = [
      "-p",
      "--output-format", "json",
      "--model", model,
      "--no-session-persistence",
    ];

    if (effort) {
      args.push("--effort", effort);
    }

    // Note: --system-prompt can't be used for large prompts (ENAMETOOLONG).
    // Instead, prepend system prompt to stdin content for KV cache benefits.
    // claude -p still caches the prefix of stdin within its TTL window.

    const spawnCommand = viaCmd ? (process.env.ComSpec || "cmd.exe") : command;
    const spawnArgs = viaCmd ? ["/d", "/c", command, ...args] : args;
    const child = spawn(spawnCommand, spawnArgs, {
      env: { ...process.env },
      windowsHide: true,
    });

    // Prepend system prompt to stdin for KV cache — claude -p caches the
    // prefix of stdin within its TTL. Stable system prompt = cache hits.
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    child.stdin.end(fullPrompt, "utf8");

    let killed = false;
    const killTimer = setTimeout(() => {
      killed = true;
      killChildProcess(child);
      reject(new Error(`Claude CLI timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.stdout.on("data", (data) => stdoutChunks.push(data.toString()));
    child.stderr.on("data", (data) => stderrChunks.push(data.toString()));

    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (killed) return;

      const output = stdoutChunks.join("");
      const stderr = stderrChunks.join("").trim();
      if (code !== 0) {
        reject(new Error(stderr || output.trim() || `Claude CLI exited with code ${code}`));
        return;
      }

      try {
        const parsed = JSON.parse(output.trim());
        if (parsed.is_error) {
          const msg = parsed.result || "";
          // Detect rate limit and set cooldown
          if (msg.includes("hit your limit") || msg.includes("resets")) {
            _claudeRateLimitedUntil = parseRateLimitReset(msg);
            const mins = Math.ceil((_claudeRateLimitedUntil - Date.now()) / 60000);
            log("claude", `Rate limited — cooldown set for ~${mins} minutes`);
          }
          reject(new Error(msg || "Claude CLI returned an error"));
        } else if (parsed.type === "result") {
          resolve(typeof parsed.result === "string" ? parsed.result.trim() : "");
        } else {
          reject(new Error(`Unexpected Claude CLI response: ${JSON.stringify(parsed).slice(0, 300)}`));
        }
      } catch {
        // If JSON parsing fails, return the raw output as a fallback.
        if (output.trim()) {
          resolve(output.trim());
        } else {
          reject(new Error(stderr || "Claude CLI returned empty output"));
        }
      }
    });

    child.on("error", (err) => reject(err));
  });
}
