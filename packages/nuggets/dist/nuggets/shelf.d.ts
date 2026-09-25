/**
 * NuggetShelf — multi-nugget manager.
 *
 * Organises multiple Nugget instances under a shared directory and
 * supports broadcast recall across all nuggets.
 */
import { Nugget } from "./memory.js";
export declare class NuggetShelf {
    readonly saveDir: string;
    readonly autoSave: boolean;
    private _nuggets;
    constructor(opts?: {
        saveDir?: string;
        autoSave?: boolean;
    });
    create(name: string, opts?: {
        D?: number;
        banks?: number;
        ensembles?: number;
    }): Nugget;
    get(name: string): Nugget;
    getOrCreate(name: string): Nugget;
    remove(name: string): void;
    list(): Array<ReturnType<Nugget["status"]>>;
    remember(nuggetName: string, key: string, value: string): void;
    recall(query: string, nuggetName?: string, sessionId?: string): ReturnType<Nugget["recall"]> & {
        nugget_name: string | null;
    };
    forget(nuggetName: string, key: string): boolean;
    loadAll(): void;
    saveAll(): void;
    has(name: string): boolean;
    get size(): number;
}
//# sourceMappingURL=shelf.d.ts.map