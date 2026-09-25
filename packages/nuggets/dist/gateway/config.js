import { createHash } from "node:crypto";
import { resolve } from "node:path";
import "dotenv/config";
// Project root: src/gateway/ → src/ → nuggets/
export const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
export const GATEWAY_DIR = resolve(PROJECT_ROOT, ".gateway");
export const SESSIONS_DIR = resolve(GATEWAY_DIR, "sessions");
export const AUTH_DIR = resolve(GATEWAY_DIR, "auth");
export const ALLOWLIST = new Set((process.env.GATEWAY_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean));
// Telegram config
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const TELEGRAM_ALLOWLIST = new Set((process.env.TELEGRAM_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean));
export const PI_PROVIDER = process.env.PI_PROVIDER || "anthropic";
export const PI_MODEL = process.env.PI_MODEL || "";
export const PI_IDLE_TIMEOUT_MS = Number(process.env.PI_IDLE_TIMEOUT_MS) || 300_000;
export const MAX_PI_PROCESSES = Number(process.env.MAX_PI_PROCESSES) || 5;
// Proactive system config
export const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS) || 1_800_000; // 30 min
export const QUIET_HOURS_START = Number(process.env.QUIET_HOURS_START ?? 22); // 10 PM
export const QUIET_HOURS_END = Number(process.env.QUIET_HOURS_END ?? 8); // 8 AM
export const CRON_EVAL_INTERVAL_MS = Number(process.env.CRON_EVAL_INTERVAL_MS) || 60_000; // 1 min
/** Stable hash of a JID for filesystem-safe directory names */
export function jidHash(jid) {
    return createHash("sha256").update(jid).digest("hex").slice(0, 16);
}
export function isAllowed(id) {
    // Check both WhatsApp and Telegram allowlists
    if (ALLOWLIST.size === 0 && TELEGRAM_ALLOWLIST.size === 0)
        return true;
    return ALLOWLIST.has(id) || TELEGRAM_ALLOWLIST.has(id);
}
//# sourceMappingURL=config.js.map