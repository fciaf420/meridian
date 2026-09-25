/**
 * Nugget — a single holographic memory unit.
 *
 * Stores key-value facts as superposed complex-valued vectors and retrieves
 * them via algebraic unbinding. Deterministic rebuild from facts using
 * seeded RNG so vectors are never serialised.
 */
export declare const DEFAULT_SAVE_DIR: string;
export declare class Nugget {
    readonly name: string;
    readonly D: number;
    readonly banks: number;
    readonly ensembles: number;
    autoSave: boolean;
    saveDir: string;
    maxFacts: number;
    private _sharpenP;
    private _corvacsA;
    private _tempT;
    private _orthIters;
    private _orthStep;
    private _fuzzyThreshold;
    private _facts;
    private _E;
    private _vocabWords;
    private _tagToPos;
    private _dirty;
    constructor(opts: {
        name: string;
        D?: number;
        banks?: number;
        ensembles?: number;
        autoSave?: boolean;
        saveDir?: string;
        maxFacts?: number;
    });
    remember(key: string, value: string): void;
    recall(query: string, sessionId?: string): {
        answer: string | null;
        confidence: number;
        margin: number;
        found: boolean;
        key: string;
    };
    forget(key: string): boolean;
    facts(): Array<{
        key: string;
        value: string;
        hits: number;
    }>;
    clear(): void;
    status(): {
        name: string;
        fact_count: number;
        dimension: number;
        banks: number;
        ensembles: number;
        capacity_used_pct: number;
        capacity_warning: string;
        max_facts: number;
    };
    save(path?: string): string;
    static load(path: string, opts?: {
        autoSave?: boolean;
    }): Nugget;
    private _rebuild;
    private _decode;
    /** Fuzzy-match query to stored keys (threshold >= 0.55). */
    private _resolveTag;
}
//# sourceMappingURL=memory.d.ts.map