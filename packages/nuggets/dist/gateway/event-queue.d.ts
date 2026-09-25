import { EventEmitter } from "node:events";
export interface ProactiveEvent {
    type: "cron" | "heartbeat" | "timer" | "webhook";
    jid: string;
    prompt: string;
    metadata?: Record<string, unknown>;
}
/**
 * Central event queue for all proactive triggers.
 * Cron, heartbeat, and timers push events here.
 * The router subscribes and handles them like WhatsApp messages.
 */
export declare class EventQueue extends EventEmitter {
    push(event: ProactiveEvent): void;
}
//# sourceMappingURL=event-queue.d.ts.map