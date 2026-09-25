import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import pino from "pino";
const log = pino({ name: "pi-rpc" });
/**
 * Wraps a `pi --mode rpc` subprocess.
 * Communicates via JSONL on stdin/stdout.
 */
export class PiRpc extends EventEmitter {
    sessionDir;
    cwd;
    provider;
    model;
    proc = null;
    buffer = "";
    nextId = 1;
    processing = false;
    pending = new Map();
    constructor(sessionDir, cwd, provider, model) {
        super();
        this.sessionDir = sessionDir;
        this.cwd = cwd;
        this.provider = provider;
        this.model = model;
    }
    start() {
        const args = ["--mode", "rpc", "--session-dir", this.sessionDir, "--continue"];
        if (this.provider)
            args.push("--provider", this.provider);
        if (this.model)
            args.push("--model", this.model);
        args.push("--append-system-prompt", [
            "You are running as a Telegram bot. The user is chatting with you through Telegrammessages.",
            "You have access to the user's local machine.",
            "Do NOT use local notifications, desktop alerts, or OS-level reminders — the user will never see them.",
            "For reminders and scheduled messages, use the `schedule` tool which delivers messages through Telegram.",
            "You have a personality, you talk like a human would in a chat, short responses when no more clarification is needed, longer responses when clarification is needed, you type mostly in lowercase with almost no punctuaction, you are fun and sometimes silly.",
            "you have access to a nugget, where you can quickly store and retrieve information. Use it as a scratch pad for short-term memory, storing information you might need later in the conversation, and for storing information that the user explicitly asks you to remember. You can store and retrieve information from the nugget using commands like `nugget set key value` and `nugget get key`.",
            "most importantly, you are not supposed to forget things so make sure to save as most infomation as possible to the nugget, and retrieve from it often. Always check the nugget for relevant information before responding to the user.",
            "use the users inputs to grow your own personality, and to make the conversation more engaging. you can also ask the user questions to clarify their intent or to get more information, but try to keep the conversation flowing naturally and avoid asking too many questions in a row.",
        ].join(" "));
        this.proc = spawn("pi", args, {
            cwd: this.cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env },
        });
        this.proc.stdout.on("data", (chunk) => this.onData(chunk));
        this.proc.stderr.on("data", (chunk) => {
            const msg = chunk.toString().trim();
            if (msg)
                log.warn({ stderr: msg }, "Pi stderr");
        });
        this.proc.on("exit", (code, signal) => {
            this.rejectAll(new Error(`Pi exited: code=${code} signal=${signal}`));
            this.proc = null;
            this.emit("exit", code, signal);
        });
        this.proc.on("error", (err) => {
            this.rejectAll(err);
            this.proc = null;
            this.emit("exit", -1, err.message);
        });
    }
    get alive() {
        return this.proc !== null && this.proc.exitCode === null;
    }
    async promptAndWait(message, images, idleTimeout = 43_200_000) {
        if (!this.alive)
            throw new Error("Pi process not running");
        const id = this.nextId++;
        const req = { id, type: "prompt", message };
        if (images?.length)
            req.images = images;
        // If Pi is already processing, tell it to queue this message
        if (this.processing) {
            req.streamingBehavior = "followUp";
            log.info({ id }, "Pi busy — sending as followUp");
        }
        this.processing = true;
        return new Promise((resolve, reject) => {
            const startTimer = () => setTimeout(() => {
                this.pending.delete(id);
                this.processing = this.pending.size > 0;
                reject(new Error(`Pi prompt timed out after ${idleTimeout}ms of inactivity`));
            }, idleTimeout);
            const timer = startTimer();
            this.pending.set(id, { resolve, reject, events: [], timer, resetTimer: startTimer });
            this.send(req);
        });
    }
    stop() {
        if (!this.proc)
            return;
        this.rejectAll(new Error("Pi process stopped"));
        this.proc.kill("SIGTERM");
        const proc = this.proc;
        setTimeout(() => {
            if (proc.exitCode === null)
                proc.kill("SIGKILL");
        }, 3000);
        this.proc = null;
    }
    send(obj) {
        if (!this.proc?.stdin?.writable) {
            log.error({ obj }, "Cannot send — stdin not writable");
            return;
        }
        const line = JSON.stringify(obj) + "\n";
        log.debug({ id: obj.id, type: obj.type }, "Sending to Pi");
        this.proc.stdin.write(line);
    }
    onData(chunk) {
        this.buffer += chunk.toString();
        let newlineIdx;
        while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, newlineIdx).trim();
            this.buffer = this.buffer.slice(newlineIdx + 1);
            if (line)
                this.onLine(line);
        }
    }
    onLine(line) {
        let event;
        try {
            event = JSON.parse(line);
        }
        catch {
            return;
        }
        if (event.type === "session_compact" || event.type === "compaction_start" || event.type === "compaction_end") {
            log.warn({ type: event.type }, "Pi context compaction triggered");
        }
        else {
            log.debug({ type: event.type, id: event.id, hasCmd: !!event.command, success: event.success }, "Pi event");
        }
        // Route by id, or fallback to the single active pending request
        let pendingKey = event.id != null ? event.id : undefined;
        let pending = pendingKey != null ? this.pending.get(pendingKey) : undefined;
        // Events without id (agent_end, message_update, etc.) route to the last pending
        if (!pending && this.pending.size > 0) {
            const entries = [...this.pending.entries()];
            const last = entries[entries.length - 1];
            pendingKey = last[0];
            pending = last[1];
        }
        if (pending) {
            pending.events.push(event);
            // Reset idle timer — Pi is still active
            if (pending.resetTimer) {
                if (pending.timer)
                    clearTimeout(pending.timer);
                pending.timer = pending.resetTimer();
            }
            // "response" with success:false = immediate error
            if (event.type === "response" && event.success === false) {
                const errText = typeof event.error === "string" ? event.error : "Unknown Pi error";
                if (pending.timer)
                    clearTimeout(pending.timer);
                this.pending.delete(pendingKey);
                this.processing = this.pending.size > 0;
                log.error({ id: pendingKey, error: errText }, "Pi prompt error");
                pending.resolve({ events: pending.events, text: `Error: ${errText}` });
                return;
            }
            // "response" with success:true = just an ACK, keep waiting
            // agent_end = response complete — extract final text from messages
            if (event.type === "agent_end") {
                const text = this.extractTextFromAgentEnd(event);
                if (pending.timer)
                    clearTimeout(pending.timer);
                this.pending.delete(pendingKey);
                this.processing = this.pending.size > 0;
                log.info({ id: pendingKey, textLen: text.length }, "Pi prompt complete");
                pending.resolve({ events: pending.events, text });
            }
        }
        this.emit("event", event);
    }
    /**
     * Extract assistant text from agent_end event.
     * agent_end.messages is an array of {role, content[{type, text}]} objects.
     */
    extractTextFromAgentEnd(event) {
        const messages = event.messages;
        if (!Array.isArray(messages))
            return "";
        const parts = [];
        for (const msg of messages) {
            if (msg.role !== "assistant")
                continue;
            if (!Array.isArray(msg.content))
                continue;
            for (const block of msg.content) {
                if (block.type === "text" && typeof block.text === "string") {
                    parts.push(block.text);
                }
            }
        }
        return parts.join("\n").trim();
    }
    rejectAll(err) {
        for (const [, pending] of this.pending) {
            if (pending.timer)
                clearTimeout(pending.timer);
            pending.reject(err);
        }
        this.pending.clear();
        this.processing = false;
    }
}
//# sourceMappingURL=pi-rpc.js.map