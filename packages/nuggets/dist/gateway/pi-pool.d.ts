import { PiRpc } from "./pi-rpc.js";
export declare class PiPool {
    private sessions;
    getOrCreate(jid: string): PiRpc;
    markBusy(jid: string): void;
    markIdle(jid: string): void;
    /** Force-kill a Pi process so the next getOrCreate() spawns fresh */
    kill(jid: string): void;
    stopAll(): void;
    get size(): number;
    private evictOldestIdle;
}
//# sourceMappingURL=pi-pool.d.ts.map