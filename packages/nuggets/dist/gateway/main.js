import { mkdirSync } from "node:fs";
import pino from "pino";
import { SESSIONS_DIR, AUTH_DIR, ALLOWLIST, GATEWAY_DIR, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWLIST, } from "./config.js";
import { PiPool } from "./pi-pool.js";
import { connectWhatsApp } from "./whatsapp.js";
import { connectTelegram } from "./telegram.js";
import { createRouter } from "./router.js";
import { EventQueue } from "./event-queue.js";
import { CronScheduler } from "./cron.js";
import { HeartbeatManager } from "./heartbeat.js";
const log = pino({ name: "gateway" });
async function main() {
    log.info("Starting Gateway for Pi + Nuggets");
    // Ensure runtime dirs exist
    mkdirSync(SESSIONS_DIR, { recursive: true });
    mkdirSync(AUTH_DIR, { recursive: true });
    mkdirSync(`${GATEWAY_DIR}/cron`, { recursive: true });
    // Initialize proactive system
    const eventQueue = new EventQueue();
    const heartbeat = new HeartbeatManager(eventQueue);
    const cron = new CronScheduler(eventQueue);
    const pool = new PiPool();
    // Unified send function — routes to correct channel based on ID format
    // WhatsApp JIDs contain "@", Telegram chat IDs are numeric
    const senders = new Map();
    function universalSend(id, text) {
        const sender = senders.get(id);
        if (sender)
            return sender(id, text);
        // Fallback: guess channel by ID format
        for (const [, s] of senders) {
            return s(id, text);
        }
        log.error({ id }, "No sender registered for this ID");
        return Promise.resolve();
    }
    const router = createRouter(() => universalSend, pool, eventQueue, heartbeat);
    // --- WhatsApp ---
    let waConnected = false;
    if (ALLOWLIST.size > 0) {
        log.info({ count: ALLOWLIST.size }, "WhatsApp allowlist configured");
        try {
            const conn = await connectWhatsApp(router);
            // Register WhatsApp sender for all allowlisted JIDs
            for (const jid of ALLOWLIST) {
                senders.set(jid, conn.sendMessage);
            }
            // Also register a catch-all pattern matcher for new JIDs
            const origSend = conn.sendMessage;
            const waRouter = async (jid, text) => {
                if (jid.includes("@")) {
                    senders.set(jid, origSend);
                    return origSend(jid, text);
                }
                throw new Error(`Not a WhatsApp JID: ${jid}`);
            };
            // Set default JID for cron
            if (ALLOWLIST.size === 1) {
                const defaultJid = [...ALLOWLIST][0];
                cron.setDefaultJid(defaultJid);
                heartbeat.register(defaultJid);
                log.info({ jid: defaultJid }, "Default JID set from WhatsApp allowlist");
            }
            await conn.ready;
            waConnected = true;
            log.info("WhatsApp connected");
        }
        catch (err) {
            log.error({ err }, "Failed to connect WhatsApp — continuing without it");
        }
    }
    else {
        log.info("No GATEWAY_ALLOWLIST — skipping WhatsApp");
    }
    // --- Telegram ---
    let tgConnection = null;
    if (TELEGRAM_BOT_TOKEN) {
        log.info({ allowlistCount: TELEGRAM_ALLOWLIST.size }, "Telegram bot token found — starting bot");
        // Wrap router for Telegram: Pi response goes through Telegram sendMessage
        tgConnection = connectTelegram(TELEGRAM_BOT_TOKEN, async (chatId, text) => {
            // Register sender for this chat
            senders.set(chatId, tgConnection.sendMessage);
            heartbeat.register(chatId);
            await router(chatId, text);
        });
        // Register senders for allowlisted Telegram chats
        for (const chatId of TELEGRAM_ALLOWLIST) {
            senders.set(chatId, tgConnection.sendMessage);
        }
        // Set default JID for cron if no WhatsApp default
        if (!waConnected && TELEGRAM_ALLOWLIST.size === 1) {
            const defaultId = [...TELEGRAM_ALLOWLIST][0];
            cron.setDefaultJid(defaultId);
            heartbeat.register(defaultId);
            log.info({ chatId: defaultId }, "Default ID set from Telegram allowlist");
        }
        log.info("Telegram bot started");
    }
    else {
        log.info("No TELEGRAM_BOT_TOKEN — skipping Telegram");
    }
    if (!waConnected && !tgConnection) {
        log.error("No channels configured — set GATEWAY_ALLOWLIST and/or TELEGRAM_BOT_TOKEN");
        process.exit(1);
    }
    // Start proactive systems
    cron.start();
    log.info("Gateway ready — proactive systems active");
    const shutdown = () => {
        log.info("Shutting down...");
        cron.stop();
        heartbeat.stopAll();
        pool.stopAll();
        if (tgConnection)
            tgConnection.stop();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
//# sourceMappingURL=main.js.map