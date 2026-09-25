import pino from "pino";
import { HEARTBEAT_INTERVAL_MS, QUIET_HOURS_START, QUIET_HOURS_END, } from "./config.js";
const log = pino({ name: "heartbeat" });
const HEARTBEAT_PROMPT = `It's been a while since you last interacted with the user. Check your memory — is there anything you should follow up on, remind the user about, or proactively share? Consider:
- Pending tasks or reminders
- Things the user asked you to check on later
- Useful information you've discovered since last time

If there's something worth saying, write a natural message to the user. If there's truly nothing to follow up on, respond with exactly: NOTHING`;
/**
 * Per-user heartbeat system that periodically prompts Pi to check in.
 * Respects quiet hours and skips recently-active users.
 */
export class HeartbeatManager {
    queue;
    users = new Map();
    constructor(queue) {
        this.queue = queue;
    }
    /** Register a user for heartbeats (called when they first message) */
    register(jid) {
        if (this.users.has(jid)) {
            this.touch(jid);
            return;
        }
        const hb = {
            jid,
            timer: null,
            lastInteraction: Date.now(),
        };
        this.users.set(jid, hb);
        this.startTimer(hb);
        log.info({ jid }, "Heartbeat registered");
    }
    /** Mark user as active — resets the heartbeat timer */
    touch(jid) {
        const hb = this.users.get(jid);
        if (!hb)
            return;
        hb.lastInteraction = Date.now();
        // Restart timer so heartbeat only fires after sustained inactivity
        this.stopTimer(hb);
        this.startTimer(hb);
    }
    /** Unregister a user */
    unregister(jid) {
        const hb = this.users.get(jid);
        if (!hb)
            return;
        this.stopTimer(hb);
        this.users.delete(jid);
    }
    stopAll() {
        for (const hb of this.users.values()) {
            this.stopTimer(hb);
        }
        this.users.clear();
    }
    startTimer(hb) {
        if (HEARTBEAT_INTERVAL_MS <= 0)
            return; // disabled
        hb.timer = setInterval(() => {
            this.fire(hb);
        }, HEARTBEAT_INTERVAL_MS);
    }
    stopTimer(hb) {
        if (hb.timer) {
            clearInterval(hb.timer);
            hb.timer = null;
        }
    }
    fire(hb) {
        if (isQuietHours()) {
            log.debug({ jid: hb.jid }, "Skipping heartbeat — quiet hours");
            return;
        }
        // Skip if user was active recently (within half the heartbeat interval)
        const timeSinceActive = Date.now() - hb.lastInteraction;
        if (timeSinceActive < HEARTBEAT_INTERVAL_MS / 2) {
            log.debug({ jid: hb.jid }, "Skipping heartbeat — user recently active");
            return;
        }
        log.info({ jid: hb.jid }, "Heartbeat firing");
        this.queue.push({
            type: "heartbeat",
            jid: hb.jid,
            prompt: HEARTBEAT_PROMPT,
        });
    }
}
function isQuietHours() {
    if (QUIET_HOURS_START < 0 || QUIET_HOURS_END < 0)
        return false; // disabled
    const hour = new Date().getHours();
    // Handle wrap-around (e.g., 22:00 - 08:00)
    if (QUIET_HOURS_START > QUIET_HOURS_END) {
        return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
    }
    return hour >= QUIET_HOURS_START && hour < QUIET_HOURS_END;
}
//# sourceMappingURL=heartbeat.js.map