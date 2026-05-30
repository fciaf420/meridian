/**
 * NuggetShelf — multi-nugget manager.
 *
 * Organises multiple Nugget instances under a shared directory and
 * supports broadcast recall across all nuggets.
 */
import { readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Nugget, DEFAULT_SAVE_DIR } from "./memory.js";
export class NuggetShelf {
    saveDir;
    autoSave;
    _nuggets = new Map();
    constructor(opts) {
        this.saveDir = opts?.saveDir ?? DEFAULT_SAVE_DIR;
        this.autoSave = opts?.autoSave ?? true;
    }
    // -- nugget lifecycle ----------------------------------------------------
    create(name, opts) {
        if (this._nuggets.has(name)) {
            throw new Error(`Nugget ${JSON.stringify(name)} already exists`);
        }
        const n = new Nugget({
            name,
            D: opts?.D ?? 16384,
            banks: opts?.banks ?? 4,
            ensembles: opts?.ensembles ?? 1,
            maxFacts: opts?.maxFacts ?? 0,
            autoSave: this.autoSave,
            saveDir: this.saveDir,
        });
        this._nuggets.set(name, n);
        return n;
    }
    get(name) {
        const n = this._nuggets.get(name);
        if (!n)
            throw new Error(`Nugget ${JSON.stringify(name)} not found`);
        return n;
    }
    getOrCreate(name, opts) {
        if (this._nuggets.has(name))
            return this._nuggets.get(name);
        return this.create(name, opts);
    }
    remove(name) {
        if (!this._nuggets.has(name)) {
            throw new Error(`Nugget ${JSON.stringify(name)} not found`);
        }
        const path = join(this.saveDir, `${name}.nugget.json`);
        if (existsSync(path))
            unlinkSync(path);
        this._nuggets.delete(name);
    }
    list() {
        return [...this._nuggets.values()].map((n) => n.status());
    }
    // -- convenience pass-throughs -------------------------------------------
    remember(nuggetName, key, value) {
        this.get(nuggetName).remember(key, value);
    }
    recall(query, nuggetName, sessionId = "") {
        if (nuggetName) {
            const result = this.get(nuggetName).recall(query, sessionId);
            return { ...result, nugget_name: nuggetName };
        }
        let best = {
            answer: null,
            confidence: 0,
            margin: 0,
            found: false,
            key: "",
            nugget_name: null,
        };
        for (const [name, nugget] of this._nuggets) {
            const result = nugget.recall(query, sessionId);
            if (result.found && result.confidence > best.confidence) {
                best = { ...result, nugget_name: name };
            }
        }
        return best;
    }
    forget(nuggetName, key) {
        return this.get(nuggetName).forget(key);
    }
    // -- persistence ---------------------------------------------------------
    loadAll() {
        if (!existsSync(this.saveDir))
            return;
        for (const fname of readdirSync(this.saveDir)) {
            if (!fname.endsWith(".nugget.json"))
                continue;
            const path = join(this.saveDir, fname);
            try {
                const n = Nugget.load(path, { autoSave: this.autoSave });
                this._nuggets.set(n.name, n);
            }
            catch {
                // skip corrupt files
            }
        }
    }
    saveAll() {
        for (const n of this._nuggets.values()) {
            n.save();
        }
    }
    has(name) {
        return this._nuggets.has(name);
    }
    get size() {
        return this._nuggets.size;
    }
}
//# sourceMappingURL=shelf.js.map