import { Bot } from "grammy";
import pino from "pino";
import { isAllowed } from "./config.js";
const log = pino({ name: "telegram" });
const TG_MAX_LENGTH = 4000;
export function connectTelegram(token, onMessage) {
    const bot = new Bot(token);
    // Track sent message IDs to avoid echo (not needed for Telegram bots,
    // but kept for consistency — bots don't receive their own messages)
    bot.on("message:text", async (ctx) => {
        const chatId = String(ctx.chat.id);
        const text = ctx.message.text;
        const from = ctx.from;
        log.info({ chatId, from: from?.username || from?.id, text: text.slice(0, 80) }, "Incoming Telegram message");
        // Allowlist check (use chatId as the identifier)
        if (!isAllowed(chatId)) {
            log.warn({ chatId, from: from?.username }, "Message from non-allowlisted chat — add this chatId to TELEGRAM_ALLOWLIST");
            return;
        }
        // Show typing while Pi processes
        const typingInterval = setInterval(() => {
            ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => { });
        }, 4000);
        try {
            await onMessage(chatId, text);
        }
        finally {
            clearInterval(typingInterval);
        }
    });
    bot.catch((err) => {
        log.error({ err: err.message }, "Bot error");
    });
    // Start polling
    bot.start({
        onStart: () => log.info("Telegram bot started (polling)"),
        drop_pending_updates: true,
    });
    async function sendMessage(chatId, text) {
        const chunks = splitMessage(text, TG_MAX_LENGTH);
        for (const chunk of chunks) {
            try {
                // Try sending as HTML first (for formatted responses)
                await bot.api.sendMessage(Number(chatId), chunk, {
                    parse_mode: "HTML",
                });
            }
            catch {
                // Fallback to plain text if HTML parsing fails
                await bot.api.sendMessage(Number(chatId), chunk);
            }
        }
    }
    function stop() {
        bot.stop();
        log.info("Telegram bot stopped");
    }
    return { bot, sendMessage, stop };
}
function splitMessage(text, maxLen) {
    if (text.length <= maxLen)
        return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > maxLen) {
        let splitIdx = remaining.lastIndexOf("\n", maxLen);
        if (splitIdx < maxLen * 0.3) {
            splitIdx = remaining.lastIndexOf(" ", maxLen);
        }
        if (splitIdx < maxLen * 0.3) {
            splitIdx = maxLen;
        }
        chunks.push(remaining.slice(0, splitIdx));
        remaining = remaining.slice(splitIdx).trimStart();
    }
    if (remaining)
        chunks.push(remaining);
    return chunks;
}
//# sourceMappingURL=telegram.js.map