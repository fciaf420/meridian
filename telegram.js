import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { on } from "./notifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

let chatId   = process.env.TELEGRAM_CHAT_ID || null;
let _offset  = 0;
let _polling = false;

// ─── chatId persistence ──────────────────────────────────────────
function loadChatId() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) chatId = cfg.telegramChatId;
    }
  } catch { /**/ }
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

export async function sendMessage(text) {
  if (!TOKEN || !chatId) return;
  try {
    const res = await fetch(`${BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 4096),
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `sendMessage ${res.status}: ${err.slice(0, 100)}`);
    }
  } catch (e) {
    log("telegram_error", `sendMessage failed: ${e.message}`);
  }
}

export async function sendHTML(html) {
  if (!TOKEN || !chatId) return;
  try {
    const res = await fetch(`${BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: html.slice(0, 4096),
        parse_mode: "HTML",
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `sendHTML ${res.status}: ${err.slice(0, 100)}`);
    }
  } catch (e) {
    log("telegram_error", `sendHTML failed: ${e.message}`);
  }
}


// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;

        const incomingChatId = String(msg.chat.id);

        // Auto-register first sender as the owner
        if (!chatId) {
          chatId = incomingChatId;
          saveChatId(chatId);
          log("telegram", `Registered chat ID: ${chatId}`);
          await sendMessage("Connected! I'm your LP agent. Ask me anything or use commands like /status.");
        }

        // Only accept messages from the registered chat
        if (incomingChatId !== chatId) continue;

        await onMessage(msg.text);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  _polling = true;
  poll(onMessage); // fire-and-forget
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────
export async function notifyDeploy({ pair, amountSol, position, tx }) {
  await sendHTML(
    `✅ <b>Deployed</b> ${pair}\n` +
    `Amount: ${amountSol} SOL\n` +
    `Position: <code>${position?.slice(0, 8)}...</code>\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

export async function notifyClose({ pair, pnlUsd, pnlSol, pnlPct }) {
  const { config } = await import("./config.js");
  const unit = config.management.pnlUnit || "sol";
  const val = unit === "sol" && pnlSol != null ? pnlSol : (pnlUsd ?? 0);
  const sign = val >= 0 ? "+" : "";
  const label = unit === "sol" && pnlSol != null ? `${sign}${val.toFixed(4)} SOL` : `${sign}$${val.toFixed(2)}`;
  await sendHTML(
    `🔒 <b>Closed</b> ${pair}\n` +
    `PnL: ${label} (${sign}${(pnlPct ?? 0).toFixed(2)}%)`
  );
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
  await sendHTML(
    `⚠️ <b>Out of Range</b> ${pair}\n` +
    `Been OOR for ${minutesOOR} minutes`
  );
}

export async function notifyCycleSummary({ cycleType, positions, walletSol }) {
  await sendHTML(
    `🔄 <b>${cycleType === "management" ? "Management" : "Screening"} cycle done</b>\n` +
    `Positions: ${positions} open | SOL: ${walletSol}`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Subscribe to notifier events ────────────────────────────────
// Telegram receives all notifications via the pub/sub hub.
// Guards with isEnabled() so nothing fires when TOKEN is missing.
on("deploy", (data) => { if (isEnabled()) notifyDeploy(data).catch(() => {}); });
on("close", (data) => { if (isEnabled()) notifyClose(data).catch(() => {}); });
on("out_of_range", (data) => { if (isEnabled()) notifyOutOfRange(data).catch(() => {}); });
on("pnl_watcher_close", (data) => {
  if (!isEnabled()) return;
  const sign = (data.pnlPct || 0) >= 0 ? "+" : "";
  sendMessage(`⚡ PnL Watcher Auto-Close: ${data.pair}\n${data.reason}\nPnL: ${sign}${data.pnlPct?.toFixed(1)}%`).catch(() => {});
});
on("cycle:management", ({ report }) => { if (isEnabled()) sendMessage(`🔄 Management Cycle\n\n${report}`).catch(() => {}); });
on("cycle:screening", ({ report }) => { if (isEnabled()) sendMessage(`🔍 Screening Cycle\n\n${report}`).catch(() => {}); });
on("briefing", ({ html }) => { if (isEnabled()) sendHTML(html).catch(() => {}); });
