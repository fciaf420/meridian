import { EventQueue } from "./event-queue.js";
export interface CronJob {
    id: string;
    jid: string;
    cron: string;
    prompt: string;
    enabled: boolean;
    oneShot: boolean;
    createdAt: string;
}
/**
 * Simple cron scheduler with persistent JSON job store.
 * Evaluates jobs every CRON_EVAL_INTERVAL_MS and pushes matching events.
 */
export declare class CronScheduler {
    private queue;
    private jobs;
    private timer;
    private requestWatcher;
    private lastEvalMinute;
    private lastRequestSize;
    private defaultJid;
    constructor(queue: EventQueue);
    /** Set the default JID for requests that don't specify one (single-user mode) */
    setDefaultJid(jid: string): void;
    start(): void;
    stop(): void;
    addJob(jid: string, cron: string, prompt: string, oneShot?: boolean): CronJob;
    removeJob(id: string): boolean;
    listJobs(jid?: string): CronJob[];
    getJob(id: string): CronJob | undefined;
    private evaluate;
    private getRequestFileSize;
    private processRequests;
    private handleRequest;
    private load;
    private save;
}
//# sourceMappingURL=cron.d.ts.map