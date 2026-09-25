/**
 * Nugget — a single holographic memory unit.
 *
 * Stores key-value facts as superposed complex-valued vectors and retrieves
 * them via algebraic unbinding. Deterministic rebuild from facts using
 * seeded RNG so vectors are never serialised.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { seedFromName, mulberry32, makeVocabKeys, makeRoleKeys, orthogonalize, stackAndUnitNorm, bind, unbind, sharpen, corvacsLite, softmaxTemp, } from "./core.js";
export const DEFAULT_SAVE_DIR = join(homedir(), ".nuggets");
export class Nugget {
    name;
    D;
    banks;
    ensembles;
    autoSave;
    saveDir;
    maxFacts;
    // Hyperparameters
    _sharpenP = 1.0;
    _corvacsA = 0.0;
    _tempT = 0.9;
    _orthIters = 1;
    _orthStep = 0.4;
    _fuzzyThreshold = 0.55;
    _facts = [];
    _E = null;
    _vocabWords = [];
    _tagToPos = new Map();
    _dirty = false;
    constructor(opts) {
        this.name = opts.name;
        this.D = opts.D ?? 16384;
        this.banks = opts.banks ?? 4;
        this.ensembles = opts.ensembles ?? 1;
        this.autoSave = opts.autoSave ?? true;
        this.saveDir = opts.saveDir ?? DEFAULT_SAVE_DIR;
        this.maxFacts = opts.maxFacts ?? 0;
    }
    // -- public API ----------------------------------------------------------
    remember(key, value) {
        key = key.trim();
        value = value.trim();
        if (!key || !value)
            return;
        let found = false;
        for (const f of this._facts) {
            if (f.key.toLowerCase() === key.toLowerCase()) {
                f.value = value;
                found = true;
                break;
            }
        }
        if (!found) {
            this._facts.push({ key, value, hits: 0, last_hit_session: "" });
        }
        // Evict oldest facts if max_facts exceeded
        if (this.maxFacts > 0 && this._facts.length > this.maxFacts) {
            this._facts = this._facts.slice(-this.maxFacts);
        }
        this._dirty = true;
        if (this.autoSave)
            this.save();
    }
    recall(query, sessionId = "") {
        const empty = { answer: null, confidence: 0, margin: 0, found: false, key: "" };
        if (this._facts.length === 0)
            return empty;
        if (this._dirty || this._E === null) {
            this._rebuild();
            this._dirty = false;
        }
        const tag = this._resolveTag(query);
        if (!tag || !this._tagToPos.has(tag))
            return empty;
        const { word, probs } = this._decode(tag);
        // Top-2 for confidence/margin
        let top1 = -Infinity;
        let top2 = -Infinity;
        for (let i = 0; i < probs.length; i++) {
            if (probs[i] > top1) {
                top2 = top1;
                top1 = probs[i];
            }
            else if (probs[i] > top2) {
                top2 = probs[i];
            }
        }
        const confidence = top1;
        const margin = top2 === -Infinity ? top1 : top1 - top2;
        // Hit tracking (per-session dedup)
        if (sessionId) {
            const pos = this._tagToPos.get(tag);
            const fact = this._facts[pos];
            if (fact.last_hit_session !== sessionId) {
                fact.hits = (fact.hits || 0) + 1;
                fact.last_hit_session = sessionId;
                if (this.autoSave)
                    this.save();
            }
        }
        return { answer: word, confidence, margin, found: true, key: tag };
    }
    forget(key) {
        const lower = key.toLowerCase().trim();
        const before = this._facts.length;
        this._facts = this._facts.filter((f) => f.key.toLowerCase() !== lower);
        const removed = this._facts.length < before;
        if (removed) {
            this._dirty = true;
            if (this.autoSave)
                this.save();
        }
        return removed;
    }
    facts() {
        return this._facts.map((f) => ({
            key: f.key,
            value: f.value,
            hits: f.hits || 0,
        }));
    }
    clear() {
        this._facts = [];
        this._E = null;
        this._vocabWords = [];
        this._tagToPos = new Map();
        this._dirty = false;
        if (this.autoSave)
            this.save();
    }
    status() {
        const capacityEst = this.banks * Math.floor(Math.sqrt(this.D));
        const usedPct = capacityEst > 0 ? (this._facts.length / capacityEst) * 100 : 0;
        let capacityWarning = "";
        if (usedPct > 90)
            capacityWarning = "CRITICAL: nearly full";
        else if (usedPct > 80)
            capacityWarning = "WARNING: approaching capacity";
        return {
            name: this.name,
            fact_count: this._facts.length,
            dimension: this.D,
            banks: this.banks,
            ensembles: this.ensembles,
            capacity_used_pct: Math.round(usedPct * 10) / 10,
            capacity_warning: capacityWarning,
            max_facts: this.maxFacts,
        };
    }
    // -- persistence ---------------------------------------------------------
    save(path) {
        if (!path) {
            mkdirSync(this.saveDir, { recursive: true });
            path = join(this.saveDir, `${this.name}.nugget.json`);
        }
        const data = {
            version: 3,
            name: this.name,
            D: this.D,
            banks: this.banks,
            ensembles: this.ensembles,
            max_facts: this.maxFacts,
            facts: this._facts,
            config: {
                sharpen_p: this._sharpenP,
                corvacs_a: this._corvacsA,
                temp_T: this._tempT,
                orth_iters: this._orthIters,
            },
        };
        const tmpPath = path + ".tmp";
        writeFileSync(tmpPath, JSON.stringify(data));
        renameSync(tmpPath, path);
        return path;
    }
    static load(path, opts) {
        const raw = readFileSync(path, "utf-8");
        const data = JSON.parse(raw);
        const n = new Nugget({
            name: data.name,
            D: data.D,
            banks: data.banks,
            ensembles: data.ensembles ?? 1,
            autoSave: opts?.autoSave ?? true,
            saveDir: join(path, ".."),
            maxFacts: data.max_facts ?? 0,
        });
        const cfg = data.config || {};
        n._sharpenP = cfg.sharpen_p ?? n._sharpenP;
        n._corvacsA = cfg.corvacs_a ?? n._corvacsA;
        n._tempT = cfg.temp_T ?? n._tempT;
        n._orthIters = cfg.orth_iters ?? n._orthIters;
        n._facts = (data.facts || []).map((f) => ({
            key: f.key,
            value: f.value,
            hits: f.hits ?? 0,
            last_hit_session: f.last_hit_session ?? "",
        }));
        if (n._facts.length > 0) {
            n._rebuild();
        }
        return n;
    }
    // -- internals -----------------------------------------------------------
    _rebuild() {
        if (this._facts.length === 0) {
            this._E = null;
            this._vocabWords = [];
            this._tagToPos = new Map();
            return;
        }
        // Build vocabulary from unique values
        const seen = new Set();
        const vocab = [];
        for (const f of this._facts) {
            if (!seen.has(f.value)) {
                vocab.push(f.value);
                seen.add(f.value);
            }
        }
        this._vocabWords = vocab;
        // Tag → position mapping
        this._tagToPos = new Map();
        for (let i = 0; i < this._facts.length; i++) {
            this._tagToPos.set(this._facts[i].key, i);
        }
        const L = this._facts.length;
        // Deterministic seed from name
        const seed = seedFromName(this.name);
        const rng = mulberry32(seed);
        const V = vocab.length;
        const idxW = new Map();
        for (let i = 0; i < V; i++)
            idxW.set(vocab[i], i);
        // Round-robin bank assignment
        const itemsByBank = [];
        for (let b = 0; b < this.banks; b++)
            itemsByBank.push([]);
        for (let i = 0; i < this._facts.length; i++) {
            itemsByBank[i % this.banks].push({
                sid: 0,
                pos: i,
                word: this._facts[i].value,
            });
        }
        const E = [];
        for (let e = 0; e < this.ensembles; e++) {
            let vocabKeys = makeVocabKeys(V, this.D, rng);
            if (this._orthIters > 0) {
                vocabKeys = orthogonalize(vocabKeys, this._orthIters, this._orthStep);
            }
            const vocabNorm = stackAndUnitNorm(vocabKeys);
            const sentKeys = makeVocabKeys(1, this.D, rng); // single sentence
            const roleKeys = makeRoleKeys(this.D, L);
            const banks = [];
            for (let b = 0; b < this.banks; b++) {
                const items = itemsByBank[b];
                const bindings = [];
                for (const { sid, pos, word } of items) {
                    const sKey = sentKeys[sid];
                    const rKey = roleKeys[pos];
                    const wKey = vocabKeys[idxW.get(word)];
                    bindings.push(bind(bind(sKey, rKey), wKey));
                }
                let memory;
                if (bindings.length > 0) {
                    // Sum bindings
                    const re = new Float64Array(this.D);
                    const im = new Float64Array(this.D);
                    for (const b of bindings) {
                        for (let d = 0; d < this.D; d++) {
                            re[d] += b.re[d];
                            im[d] += b.im[d];
                        }
                    }
                    // Scale by 1/sqrt(n)
                    const scale = 1.0 / Math.sqrt(bindings.length);
                    for (let d = 0; d < this.D; d++) {
                        re[d] *= scale;
                        im[d] *= scale;
                    }
                    memory = { re, im };
                }
                else {
                    memory = {
                        re: new Float64Array(this.D),
                        im: new Float64Array(this.D),
                    };
                }
                banks.push({ memory, vocabKeys, vocabNorm, sentKeys, roleKeys });
            }
            E.push({ banks });
        }
        this._E = E;
    }
    _decode(tag) {
        const pos = this._tagToPos.get(tag);
        const sid = 0;
        const V = this._vocabWords.length;
        const simsSum = new Float64Array(V);
        for (const ens of this._E) {
            for (const bank of ens.banks) {
                // Unbind sentence, then role
                let rec = unbind(unbind(bank.memory, bank.sentKeys[sid]), bank.roleKeys[pos]);
                rec = corvacsLite(sharpen(rec, this._sharpenP), this._corvacsA);
                // Convert to 2D real + unit norm
                const D = this.D;
                const rec2 = new Float64Array(D * 2);
                rec2.set(rec.re, 0);
                rec2.set(rec.im, D);
                let norm = 0;
                for (let d = 0; d < D * 2; d++)
                    norm += rec2[d] * rec2[d];
                norm = 1 / (Math.sqrt(norm) + 1e-12);
                for (let d = 0; d < D * 2; d++)
                    rec2[d] *= norm;
                // Cosine sim: vocab_norm @ rec2
                for (let v = 0; v < V; v++) {
                    const row = bank.vocabNorm[v];
                    let dot = 0;
                    for (let d = 0; d < D * 2; d++)
                        dot += row[d] * rec2[d];
                    simsSum[v] += dot;
                }
            }
        }
        const probs = softmaxTemp(simsSum, this._tempT);
        let bestIdx = 0;
        for (let i = 1; i < V; i++) {
            if (probs[i] > probs[bestIdx])
                bestIdx = i;
        }
        return { word: this._vocabWords[bestIdx], sims: simsSum, probs };
    }
    /** Fuzzy-match query to stored keys (threshold >= 0.55). */
    _resolveTag(query) {
        if (this._tagToPos.size === 0)
            return "";
        const text = query.toLowerCase().trim();
        const tags = [...this._tagToPos.keys()];
        // Exact match
        for (const t of tags) {
            if (t.toLowerCase() === text)
                return t;
        }
        // Substring match
        for (const t of tags) {
            if (t.toLowerCase().includes(text) || text.includes(t.toLowerCase()))
                return t;
        }
        // Fuzzy match (SequenceMatcher equivalent)
        let best = "";
        let bestScore = 0;
        for (const t of tags) {
            const s = sequenceMatchRatio(text, t.toLowerCase());
            if (s > bestScore) {
                best = t;
                bestScore = s;
            }
        }
        return bestScore >= this._fuzzyThreshold ? best : "";
    }
}
// ---------------------------------------------------------------------------
// Fuzzy matching — port of Python's SequenceMatcher.ratio()
// ---------------------------------------------------------------------------
function sequenceMatchRatio(a, b) {
    if (a.length === 0 && b.length === 0)
        return 1;
    if (a.length === 0 || b.length === 0)
        return 0;
    const matches = countMatches(a, b);
    return (2 * matches) / (a.length + b.length);
}
/** Count matching characters using longest common subsequence blocks. */
function countMatches(a, b) {
    // Simple LCS-based matching (approximates SequenceMatcher)
    const m = a.length;
    const n = b.length;
    // Find all matching blocks
    let total = 0;
    const usedA = new Set();
    const usedB = new Set();
    // Greedy longest common substring, iteratively
    while (true) {
        let bestLen = 0;
        let bestI = 0;
        let bestJ = 0;
        for (let i = 0; i < m; i++) {
            if (usedA.has(i))
                continue;
            for (let j = 0; j < n; j++) {
                if (usedB.has(j))
                    continue;
                let len = 0;
                while (i + len < m &&
                    j + len < n &&
                    !usedA.has(i + len) &&
                    !usedB.has(j + len) &&
                    a[i + len] === b[j + len]) {
                    len++;
                }
                if (len > bestLen) {
                    bestLen = len;
                    bestI = i;
                    bestJ = j;
                }
            }
        }
        if (bestLen === 0)
            break;
        for (let k = 0; k < bestLen; k++) {
            usedA.add(bestI + k);
            usedB.add(bestJ + k);
        }
        total += bestLen;
    }
    return total;
}
//# sourceMappingURL=memory.js.map