import { EventQueue } from "./event-queue.js";
/**
 * Per-user heartbeat system that periodically prompts Pi to check in.
 * Respects quiet hours and skips recently-active users.
 */
export declare class HeartbeatManager {
    private queue;
    private users;
    constructor(queue: EventQueue);
    /** Register a user for heartbeats (called when they first message) */
    register(jid: string): void;
    /** Mark user as active — resets the heartbeat timer */
    touch(jid: string): void;
    /** Unregister a user */
    unregister(jid: string): void;
    stopAll(): void;
    private startTimer;
    private stopTimer;
    private fire;
}
//# sourceMappingURL=heartbeat.d.ts.map