import { EventEmitter } from "node:events";
export interface RpcEvent {
    id?: number;
    type: string;
    [key: string]: unknown;
}
export interface PromptResult {
    events: RpcEvent[];
    text: string;
}
/**
 * Wraps a `pi --mode rpc` subprocess.
 * Communicates via JSONL on stdin/stdout.
 */
export declare class PiRpc extends EventEmitter {
    private sessionDir;
    private cwd;
    private provider?;
    private model?;
    private proc;
    private buffer;
    private nextId;
    private processing;
    private pending;
    constructor(sessionDir: string, cwd: string, provider?: string | undefined, model?: string | undefined);
    start(): void;
    get alive(): boolean;
    promptAndWait(message: string, images?: string[], idleTimeout?: number): Promise<PromptResult>;
    stop(): void;
    private send;
    private onData;
    private onLine;
    /**
     * Extract assistant text from agent_end event.
     * agent_end.messages is an array of {role, content[{type, text}]} objects.
     */
    private extractTextFromAgentEnd;
    private rejectAll;
}
//# sourceMappingURL=pi-rpc.d.ts.map