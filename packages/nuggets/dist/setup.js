import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { stdin, stdout } from "node:process";
const ENV_PATH = ".env";
const TMP_PATH = ".env.tmp";
// ── Helpers ──────────────────────────────────────────────────────
function parseEnv(path) {
    if (!existsSync(path))
        return {};
    const vars = {};
    for (const line of readFileSync(path, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1)
            continue;
        vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return vars;
}
function mask(value) {
    if (value.length <= 8)
        return "****";
    return value.slice(0, 6) + "..." + value.slice(-4);
}
// ── Validators ───────────────────────────────────────────────────
function validateApiKey(v) {
    if (!v.startsWith("sk-ant-"))
        return "API key must start with 'sk-ant-'";
    return null;
}
function validateBotToken(v) {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(v))
        return "Token format: 123456:ABC-DEF...";
    return null;
}
function validateChatId(v) {
    if (!/^\d+$/.test(v))
        return "Chat ID must be numeric";
    return null;
}
// ── Main ─────────────────────────────────────────────────────────
async function main() {
    const rl = createInterface({ input: stdin, output: stdout });
    const existing = parseEnv(ENV_PATH);
    console.log();
    console.log("  Nuggets Setup Wizard");
    console.log("  ====================");
    console.log();
    if (Object.keys(existing).length > 0) {
        console.log("  Existing .env detected — press Enter to keep current values.");
        console.log();
    }
    async function ask(label, help, envKey, opts = {}) {
        const current = existing[envKey];
        const fallback = opts.defaultValue ?? "";
        const showDefault = current ? mask(current) : fallback || undefined;
        console.log(`  ${help}`);
        const prompt = showDefault ? `  ${label} [${showDefault}]: ` : `  ${label}: `;
        while (true) {
            const answer = (await rl.question(prompt)).trim();
            // Enter with no input → use existing or default
            if (!answer) {
                if (current)
                    return current;
                if (fallback)
                    return fallback;
                if (opts.required) {
                    console.log("  ⚠ This field is required.\n");
                    continue;
                }
                return "";
            }
            if (opts.validate) {
                const err = opts.validate(answer);
                if (err) {
                    console.log(`  ⚠ ${err}\n`);
                    continue;
                }
            }
            return answer;
        }
    }
    // 1. Anthropic API key
    console.log("  ── AI Provider ──────────────────────────────────────");
    console.log();
    console.log("  Note: Anthropic Max plan does NOT work (third-party OAuth");
    console.log("  was blocked Jan 2026). You need an API key from:");
    console.log("  https://console.anthropic.com/");
    console.log();
    const apiKey = await ask("Anthropic API key", "Paste your sk-ant-... key:", "ANTHROPIC_API_KEY", { required: true, validate: validateApiKey });
    console.log();
    // 2. Telegram bot token
    console.log("  ── Telegram ─────────────────────────────────────────");
    console.log();
    const botToken = await ask("Bot token", "Create a bot via @BotFather on Telegram, paste the token:", "TELEGRAM_BOT_TOKEN", { required: true, validate: validateBotToken });
    console.log();
    // 3. Telegram chat ID
    const chatId = await ask("Chat ID", "Send /start to @userinfobot on Telegram to get your chat ID:", "TELEGRAM_ALLOWLIST", { required: true, validate: validateChatId });
    console.log();
    // 4. WhatsApp JID (optional)
    console.log("  ── WhatsApp (optional) ──────────────────────────────");
    console.log();
    const whatsappJid = await ask("WhatsApp JID", "Your JID (e.g. 1234567890@s.whatsapp.net) — press Enter to skip:", "GATEWAY_ALLOWLIST");
    console.log();
    // 5. Pi model (optional)
    console.log("  ── Pi Model (optional) ──────────────────────────────");
    console.log();
    const piModel = await ask("Model", "Model ID (press Enter for Pi's default):", "PI_MODEL");
    console.log();
    rl.close();
    // ── Write .env ────────────────────────────────────────────────
    const env = `\
# ── Messaging Channels ─────────────────────────────────────────
# Configure at least one channel (WhatsApp or Telegram).

# WhatsApp (optional — skip if only using Telegram)
GATEWAY_ALLOWLIST=${whatsappJid}

# Telegram
TELEGRAM_BOT_TOKEN=${botToken}
TELEGRAM_ALLOWLIST=${chatId}

# ── AI Provider ───────────────────────────────────────────────
ANTHROPIC_API_KEY=${apiKey}
PI_PROVIDER=anthropic
PI_MODEL=${piModel}

# ── Pi Process Pool ───────────────────────────────────────────
PI_IDLE_TIMEOUT_MS=${existing["PI_IDLE_TIMEOUT_MS"] || "300000"}
MAX_PI_PROCESSES=${existing["MAX_PI_PROCESSES"] || "5"}

# ── Proactive System ─────────────────────────────────────────
HEARTBEAT_INTERVAL_MS=${existing["HEARTBEAT_INTERVAL_MS"] || "1800000"}
QUIET_HOURS_START=${existing["QUIET_HOURS_START"] || "22"}
QUIET_HOURS_END=${existing["QUIET_HOURS_END"] || "8"}
CRON_EVAL_INTERVAL_MS=${existing["CRON_EVAL_INTERVAL_MS"] || "60000"}
`;
    writeFileSync(TMP_PATH, env, "utf-8");
    renameSync(TMP_PATH, ENV_PATH);
    console.log("  ✓ .env written successfully.");
    console.log();
    console.log("  Ready! Run `npm run dev` to start.");
    console.log();
}
main().catch((err) => {
    console.error("Setup failed:", err);
    process.exit(1);
});
//# sourceMappingURL=setup.js.map