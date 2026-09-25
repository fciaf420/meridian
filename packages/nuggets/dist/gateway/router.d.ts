import { PiPool } from "./pi-pool.js";
import { EventQueue } from "./event-queue.js";
import { HeartbeatManager } from "./heartbeat.js";
export type SendFn = (jid: string, text: string) => Promise<unknown>;
export declare function createRouter(getSend: () => SendFn, pool: PiPool, eventQueue: EventQueue, heartbeat: HeartbeatManager): (jid: string, text: string) => Promise<void>;
//# sourceMappingURL=router.d.ts.map