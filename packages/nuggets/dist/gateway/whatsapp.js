import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestWaWebVersion, } from "@whiskeysockets/baileys";
import pino from "pino";
// @ts-ignore no types available
import qrcode from "qrcode-terminal";
import { AUTH_DIR, isAllowed } from "./config.js";
const log = pino({ name: "whatsapp" });
/** Message IDs sent by the bot — used to avoid processing our own replies */
const sentMessageIds = new Set();
async function getWaVersion() {
    try {
        const { version, isLatest } = await fetchLatestWaWebVersion({});
        log.info({ version, isLatest }, "Fetched WA Web version");
        return version;
    }
    catch (err) {
        const fallback = [2, 3000, 1034074495];
        log.warn({ err, fallback }, "Failed to fetch WA version, using fallback");
        return fallback;
    }
}
export async function connectWhatsApp(onMessage) {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let readyResolve;
    const ready = new Promise((resolve) => {
        readyResolve = resolve;
    });
    let sock;
    let reconnecting = false;
    async function createSocket() {
        const version = await getWaVersion();
        sock = makeWASocket({
            auth: state,
            version,
            logger: pino({ level: "silent" }),
        });
        sock.ev.on("creds.update", saveCreds);
        sock.ev.on("connection.update", (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                log.info("Scan QR code with WhatsApp (Linked Devices):");
                qrcode.generate(qr, { small: true });
            }
            if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLogout = statusCode === DisconnectReason.loggedOut;
                if (isLogout) {
                    log.error("Logged out from WhatsApp — delete .gateway/auth/ and re-scan QR");
                    process.exit(1);
                }
                if (!reconnecting) {
                    reconnecting = true;
                    log.warn({ statusCode }, "Connection closed — reconnecting in 3s...");
                    setTimeout(async () => {
                        reconnecting = false;
                        try {
                            await createSocket();
                        }
                        catch (err) {
                            log.error({ err }, "Failed to reconnect");
                            reconnecting = false;
                            setTimeout(() => createSocket(), 10_000);
                        }
                    }, 3000);
                }
            }
            if (connection === "open") {
                log.info("WhatsApp connected");
                readyResolve();
            }
        });
        sock.ev.on("messages.upsert", ({ messages, type }) => {
            if (type !== "notify")
                return;
            for (const msg of messages) {
                if (msg.key.remoteJid === "status@broadcast")
                    continue;
                if (msg.key.id && sentMessageIds.has(msg.key.id)) {
                    sentMessageIds.delete(msg.key.id);
                    continue;
                }
                const jid = msg.key.remoteJid;
                if (!jid)
                    continue;
                if (!isAllowed(jid)) {
                    log.debug({ jid }, "Message from non-allowlisted JID — ignoring");
                    continue;
                }
                const text = msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text;
                if (!text) {
                    log.debug({ jid }, "Non-text message — ignoring");
                    continue;
                }
                log.info({ jid, text: text.slice(0, 80) }, "Incoming message");
                onMessage(jid, text).catch((err) => {
                    log.error({ jid, err }, "Message handler error");
                });
            }
        });
    }
    await createSocket();
    async function sendMessage(jid, text) {
        const sent = await sock.sendMessage(jid, { text });
        if (sent?.key?.id) {
            sentMessageIds.add(sent.key.id);
            setTimeout(() => sentMessageIds.delete(sent.key.id), 30_000);
        }
        return sent;
    }
    return {
        get sock() { return sock; },
        ready,
        sendMessage,
    };
}
//# sourceMappingURL=whatsapp.js.map