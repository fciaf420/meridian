// telegram.js — Telegram Bot API transport + owner-only access control.
//
// Plain Bot API over HTTP long polling (no framework). Menus, views, confirmations
// and alerts live in telegram-ui.js; this module only moves bytes and decides
// whether an update is allowed to reach them.
//
// Security model (see CLAUDE.md):
//   - Only the configured owner chat (user-config `telegramChatId`, else env
//     TELEGRAM_CHAT_ID) may control the bot. Updates from any other chat are
//     dropped with a log line and never answered.
//   - Every message and callback is checked on BOTH the chat id and the sender
//     (`from.id`): in a private chat the sender must be the chat itself; other
//     senders (e.g. group members) must be listed in TELEGRAM_ALLOWLIST.
//   - With no owner configured, the first PRIVATE chat to message the bot is
//     registered once, with a loud warning in the log. Callbacks never register.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { writeJsonAtomicSync } from "./atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

export const TELEGRAM_MAX_TEXT = 4096;
export const CALLBACK_DATA_MAX_BYTES = 64;

let _token = process.env.TELEGRAM_BOT_TOKEN || null;
let _fetch = (...args) => globalThis.fetch(...args);
let _saveOwner = saveChatIdToConfig;
let ownerChatId = null;
let allowlist = parseAllowlist(process.env.TELEGRAM_ALLOWLIST);
let _offset = 0;
let _polling = false;

function base() {
  return `https://api.telegram.org/bot${_token}`;
}

// ─── Owner / allowlist ───────────────────────────────────────────
function parseAllowlist(raw) {
  return new Set(
    String(raw || "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^-?\d+$/.test(s)),
  );
}

function loadOwnerChatId() {
  let id = process.env.TELEGRAM_CHAT_ID || null;
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) id = cfg.telegramChatId;
    }
  } catch { /* unreadable config: fall back to env */ }
  return id != null && String(id).trim() ? String(id).trim() : null;
}

function saveChatIdToConfig(id) {
  try {
    const cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    writeJsonAtomicSync(USER_CONFIG_PATH, cfg);
  } catch (e) {
    log("telegram_error", `Failed to persist owner chat id: ${e.message}`);
  }
}

ownerChatId = loadOwnerChatId();

export function getOwnerChatId() {
  return ownerChatId;
}

export function isEnabled() {
  return !!_token;
}

/** Test hook: inject token, fetch, owner, allowlist and the owner persister. */
export function __setTelegramTestHooks({ token, fetch, owner, allowlist: list, saveOwner } = {}) {
  if (token !== undefined) _token = token;
  if (fetch !== undefined) _fetch = fetch;
  if (owner !== undefined) ownerChatId = owner == null ? null : String(owner);
  if (list !== undefined) allowlist = parseAllowlist(Array.isArray(list) ? list.join(",") : list);
  if (saveOwner !== undefined) _saveOwner = saveOwner;
}

// ─── HTML helpers ────────────────────────────────────────────────
/** Escape text for Telegram's HTML parse mode. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Clip to Telegram's per-message cap without cutting an HTML entity in half. */
export function clipText(text, max = TELEGRAM_MAX_TEXT) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  const amp = cut.lastIndexOf("&");
  if (amp !== -1 && cut.indexOf(";", amp) === -1) cut = cut.slice(0, amp);
  return `${cut}…`;
}

// ─── Core API ────────────────────────────────────────────────────
/**
 * Call a Bot API method. Never throws: returns { ok, result?, description? }.
 */
export async function callApi(method, body = {}) {
  if (!_token) return { ok: false, description: "telegram disabled" };
  try {
    const res = await _fetch(`${base()}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok || !data?.ok) {
      const description = data?.description || `HTTP ${res.status}`;
      // Editing a message to identical content is a no-op, not an error.
      if (!/message is not modified/i.test(description)) {
        log("telegram_error", `${method} failed: ${String(description).slice(0, 160)}`);
      }
      return { ok: false, description };
    }
    return { ok: true, result: data.result };
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return { ok: false, description: e.message };
  }
}

/** Plain-text message to the owner chat (legacy callers). */
export async function sendMessage(text, extra = {}) {
  if (!_token || !ownerChatId) return null;
  const r = await callApi("sendMessage", {
    chat_id: ownerChatId,
    text: clipText(text),
    ...extra,
  });
  return r.ok ? r.result : null;
}

/** HTML message to the owner chat. Returns the sent Message or null. */
export async function sendHTML(html, extra = {}) {
  if (!_token || !ownerChatId) return null;
  const r = await callApi("sendMessage", {
    chat_id: ownerChatId,
    text: clipText(html),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
  return r.ok ? r.result : null;
}

/** Edit an owner-chat message in place. Returns true when Telegram accepted it. */
export async function editHTML(messageId, html, extra = {}) {
  if (!_token || !ownerChatId || messageId == null) return false;
  const r = await callApi("editMessageText", {
    chat_id: ownerChatId,
    message_id: messageId,
    text: clipText(html),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
  return r.ok || /message is not modified/i.test(r.description || "");
}

export async function answerCallback(callbackQueryId, text = "", showAlert = false) {
  if (!_token || !callbackQueryId) return false;
  const r = await callApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 190) } : {}),
    ...(showAlert ? { show_alert: true } : {}),
  });
  return r.ok;
}

/** Best-effort command list registration (shown in the client's "/" menu). */
export async function setMyCommands(commands) {
  if (!_token) return false;
  const r = await callApi("setMyCommands", { commands });
  if (r.ok) log("telegram", `Registered ${commands.length} bot commands`);
  return r.ok;
}

// ─── Authorization ───────────────────────────────────────────────
/**
 * Decide whether an update may reach the handlers.
 * Returns { ok, kind, chatId, fromId, register?, reason? }.
 */
export function authorizeUpdate(update) {
  const msg = update?.message;
  const cq = update?.callback_query;
  const kind = msg ? "message" : cq ? "callback" : "other";
  if (kind === "other") return { ok: false, kind, reason: "unsupported update" };

  const chat = msg ? msg.chat : cq.message?.chat;
  const from = msg ? msg.from : cq.from;
  const chatId = chat?.id != null ? String(chat.id) : null;
  const fromId = from?.id != null ? String(from.id) : null;
  const base = { kind, chatId, fromId };

  if (!chatId || !fromId) return { ...base, ok: false, reason: "missing chat or sender" };
  if (from.is_bot) return { ...base, ok: false, reason: "sender is a bot" };

  if (!ownerChatId) {
    // One-time registration: a human, in a private chat, via a message.
    if (kind === "message" && chat.type === "private" && fromId === chatId) {
      return { ...base, ok: true, register: true };
    }
    return { ...base, ok: false, reason: "no owner configured" };
  }

  if (chatId !== ownerChatId) return { ...base, ok: false, reason: "chat is not the owner chat" };
  if (fromId !== ownerChatId && !allowlist.has(fromId)) {
    return { ...base, ok: false, reason: "sender is not the owner or in TELEGRAM_ALLOWLIST" };
  }
  return { ...base, ok: true };
}

/**
 * Route one update. `handlers` = { onMessage(text, ctx), onCallback(data, ctx) }.
 * Unauthorized updates are logged and dropped without any reply.
 */
export async function processUpdate(update, handlers = {}) {
  const auth = authorizeUpdate(update);
  if (!auth.ok) {
    if (auth.kind !== "other") {
      log("telegram_warn", `Ignored ${auth.kind} from chat ${auth.chatId ?? "?"} / user ${auth.fromId ?? "?"}: ${auth.reason}`);
    }
    return { handled: false, reason: auth.reason };
  }

  if (auth.register) {
    ownerChatId = auth.chatId;
    _saveOwner(ownerChatId);
    log("telegram_warn", `!!! OWNER REGISTERED: chat ${ownerChatId} is now the ONLY chat that can control this bot. No telegramChatId/TELEGRAM_CHAT_ID was configured, so the first private sender was taken. If this was not you, stop the bot and set telegramChatId in user-config.json.`);
    await sendHTML("🔐 Connected. This chat is now the bot's owner — no other chat can control it.\nSend /menu to start.");
  }

  if (auth.kind === "message") {
    const msg = update.message;
    if (typeof msg.text !== "string" || !msg.text.trim()) return { handled: false, reason: "no text" };
    await handlers.onMessage?.(msg.text, { chatId: auth.chatId, fromId: auth.fromId, messageId: msg.message_id });
    return { handled: true };
  }

  const cq = update.callback_query;
  await handlers.onCallback?.(String(cq.data ?? ""), {
    chatId: auth.chatId,
    fromId: auth.fromId,
    messageId: cq.message?.message_id,
    callbackId: cq.id,
  });
  return { handled: true };
}

// ─── Long polling ────────────────────────────────────────────────
async function poll(handlers) {
  while (_polling) {
    try {
      const res = await _fetch(
        `${base()}/getUpdates?offset=${_offset}&timeout=30&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "callback_query"]))}`,
        { signal: AbortSignal.timeout(35_000) },
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        // Don't block the poll loop on long handlers (LLM chat, deploys): each
        // handler has its own busy/nonce guards.
        processUpdate(update, handlers).catch((e) => log("telegram_error", `Handler failed: ${e.message}`));
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

/**
 * Start long polling. Accepts { onMessage, onCallback } or, for older callers,
 * a bare onMessage(text) function.
 */
export function startPolling(handlers) {
  if (!_token) return;
  const h = typeof handlers === "function" ? { onMessage: (text) => handlers(text) } : handlers;
  if (ownerChatId) {
    log("telegram", `Owner chat: ${ownerChatId}${allowlist.size ? ` | allowlist: ${allowlist.size} user(s)` : ""}`);
    if (ownerChatId.startsWith("-") && allowlist.size === 0) {
      log("telegram_warn", "Owner chat is a group but TELEGRAM_ALLOWLIST is empty — no member can control the bot. Add member user ids to TELEGRAM_ALLOWLIST.");
    }
  } else {
    log("telegram_warn", "No telegramChatId / TELEGRAM_CHAT_ID configured — the FIRST private chat to message the bot becomes its owner.");
  }
  _polling = true;
  poll(h); // fire-and-forget
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
