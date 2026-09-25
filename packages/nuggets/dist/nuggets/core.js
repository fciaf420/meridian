/**
 * HRR (Holographic Reduced Representation) math primitives.
 *
 * All functions operate on complex-valued vectors with unit magnitude.
 * Binding is element-wise complex multiplication; unbinding uses conjugate.
 * Zero external dependencies — pure Float64Array math.
 */
// ---------------------------------------------------------------------------
// Seeded PRNG — Mulberry32
// ---------------------------------------------------------------------------
function mulberry32(seed) {
    let s = seed | 0;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** Derive a u32 seed from a string (same as Python version). */
export function seedFromName(name) {
    const bytes = new TextEncoder().encode(name);
    const padded = new Uint8Array(8);
    padded.set(bytes.subarray(0, 8));
    // Little-endian u32 from first 4 bytes
    return ((padded[0] | (padded[1] << 8) | (padded[2] << 16) | (padded[3] << 24)) >>>
        0);
}
// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------
/**
 * Create V unit-magnitude complex key vectors of dimension D.
 * Each entry has magnitude 1 (phase-only): key = exp(i * phi)
 * where phi ~ Uniform(0, 2*pi).
 */
export function makeVocabKeys(V, D, rng) {
    const TWO_PI = 2 * Math.PI;
    const keys = [];
    for (let v = 0; v < V; v++) {
        const re = new Float64Array(D);
        const im = new Float64Array(D);
        for (let d = 0; d < D; d++) {
            const phi = TWO_PI * rng();
            re[d] = Math.cos(phi);
            im[d] = Math.sin(phi);
        }
        keys.push({ re, im });
    }
    return keys;
}
/**
 * Create L role/position keys via successive powers of a base root.
 * role[k] = base^k where base = exp(2*pi*i * arange(D) / D).
 */
export function makeRoleKeys(D, L) {
    const TWO_PI = 2 * Math.PI;
    // base[d] = exp(2*pi*i * d / D)
    const baseRe = new Float64Array(D);
    const baseIm = new Float64Array(D);
    for (let d = 0; d < D; d++) {
        const angle = (TWO_PI * d) / D;
        baseRe[d] = Math.cos(angle);
        baseIm[d] = Math.sin(angle);
    }
    const keys = [];
    for (let k = 0; k < L; k++) {
        const re = new Float64Array(D);
        const im = new Float64Array(D);
        for (let d = 0; d < D; d++) {
            // base^k: angle = k * (2*pi*d/D)
            const angle = (k * TWO_PI * d) / D;
            re[d] = Math.cos(angle);
            im[d] = Math.sin(angle);
        }
        keys.push({ re, im });
    }
    return keys;
}
// ---------------------------------------------------------------------------
// Orthogonalization
// ---------------------------------------------------------------------------
/**
 * Gram-Schmidt-like decorrelation in R^{2D}, projected back to unit phase.
 * 1. Stack real/imag → R^{2D}
 * 2. Iteratively subtract correlated components
 * 3. Re-normalise and convert back to unit-magnitude complex
 */
export function orthogonalize(keys, iters = 1, step = 0.4) {
    if (iters <= 0)
        return keys;
    const V = keys.length;
    if (V === 0)
        return keys;
    const D = keys[0].re.length;
    const D2 = D * 2;
    // Stack to [V, 2D] real matrix
    const K = new Float64Array(V * D2);
    for (let v = 0; v < V; v++) {
        const off = v * D2;
        K.set(keys[v].re, off);
        K.set(keys[v].im, off + D);
    }
    for (let iter = 0; iter < iters; iter++) {
        // G = K @ K^T — [V, V] Gram matrix
        const G = new Float64Array(V * V);
        for (let i = 0; i < V; i++) {
            for (let j = i; j < V; j++) {
                let dot = 0;
                const offI = i * D2;
                const offJ = j * D2;
                for (let d = 0; d < D2; d++) {
                    dot += K[offI + d] * K[offJ + d];
                }
                G[i * V + j] = dot;
                G[j * V + i] = dot;
            }
            // Zero diagonal
            G[i * V + i] = 0;
        }
        // K = K - step * (G @ K) / D2
        const correction = new Float64Array(V * D2);
        for (let i = 0; i < V; i++) {
            for (let j = 0; j < V; j++) {
                const g = G[i * V + j];
                if (g === 0)
                    continue;
                const offI = i * D2;
                const offJ = j * D2;
                for (let d = 0; d < D2; d++) {
                    correction[offI + d] += g * K[offJ + d];
                }
            }
        }
        const scale = step / D2;
        for (let i = 0; i < V * D2; i++) {
            K[i] -= scale * correction[i];
        }
        // Row-normalise
        for (let v = 0; v < V; v++) {
            const off = v * D2;
            let norm = 0;
            for (let d = 0; d < D2; d++) {
                norm += K[off + d] * K[off + d];
            }
            norm = 1 / (Math.sqrt(norm) + 1e-9);
            for (let d = 0; d < D2; d++) {
                K[off + d] *= norm;
            }
        }
    }
    // Convert back to unit-phase complex
    const result = [];
    for (let v = 0; v < V; v++) {
        const off = v * D2;
        const re = new Float64Array(D);
        const im = new Float64Array(D);
        for (let d = 0; d < D; d++) {
            const r = K[off + d];
            const i = K[off + D + d];
            const phase = Math.atan2(i, r);
            re[d] = Math.cos(phase);
            im[d] = Math.sin(phase);
        }
        result.push({ re, im });
    }
    return result;
}
// ---------------------------------------------------------------------------
// Signal processing
// ---------------------------------------------------------------------------
/**
 * Magnitude-sharpening nonlinearity.
 * z_out = z * (|z| + eps)^(p - 1)
 * p > 1  → contrast-increasing
 * p < 1  → softening
 * p == 1 → identity
 */
export function sharpen(z, p = 1.0, eps = 1e-12) {
    if (p === 1.0)
        return z;
    const D = z.re.length;
    const re = new Float64Array(D);
    const im = new Float64Array(D);
    const exp = p - 1.0;
    for (let d = 0; d < D; d++) {
        const mag = Math.sqrt(z.re[d] * z.re[d] + z.im[d] * z.im[d]);
        const scale = (mag + eps) ** exp;
        re[d] = z.re[d] * scale;
        im[d] = z.im[d] * scale;
    }
    return { re, im };
}
/**
 * Gentle magnitude limiter (CORVACS-lite).
 * z_out = z * tanh(a * |z|) / |z|
 * a == 0 → identity
 * a > 0  → soft saturation
 */
export function corvacsLite(z, a = 0.0) {
    if (a <= 0)
        return z;
    const D = z.re.length;
    const re = new Float64Array(D);
    const im = new Float64Array(D);
    for (let d = 0; d < D; d++) {
        const mag = Math.sqrt(z.re[d] * z.re[d] + z.im[d] * z.im[d]) + 1e-12;
        const scale = Math.tanh(a * mag) / mag;
        re[d] = z.re[d] * scale;
        im[d] = z.im[d] * scale;
    }
    return { re, im };
}
/** Temperature-scaled softmax over similarity logits. */
export function softmaxTemp(sims, T = 1.0) {
    T = Math.max(T, 1e-6);
    const n = sims.length;
    const z = new Float64Array(n);
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
        z[i] = sims[i] / T;
        if (z[i] > max)
            max = z[i];
    }
    let sum = 0;
    for (let i = 0; i < n; i++) {
        z[i] = Math.exp(z[i] - max);
        sum += z[i];
    }
    sum += 1e-12;
    for (let i = 0; i < n; i++) {
        z[i] /= sum;
    }
    return z;
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Convert [V, D] complex → [V, 2D] real with unit row norms.
 * Used for efficient cosine similarity: sims = vocab_norm @ query_2d.
 */
export function stackAndUnitNorm(keys) {
    const V = keys.length;
    if (V === 0)
        return [];
    const D = keys[0].re.length;
    const D2 = D * 2;
    const result = [];
    for (let v = 0; v < V; v++) {
        const row = new Float64Array(D2);
        row.set(keys[v].re, 0);
        row.set(keys[v].im, D);
        let norm = 0;
        for (let d = 0; d < D2; d++) {
            norm += row[d] * row[d];
        }
        norm = 1 / (Math.sqrt(norm) + 1e-12);
        for (let d = 0; d < D2; d++) {
            row[d] *= norm;
        }
        result.push(row);
    }
    return result;
}
// ---------------------------------------------------------------------------
// Bind / Unbind
// ---------------------------------------------------------------------------
/** Bind: element-wise complex product a * b. */
export function bind(a, b) {
    const D = a.re.length;
    const re = new Float64Array(D);
    const im = new Float64Array(D);
    for (let d = 0; d < D; d++) {
        re[d] = a.re[d] * b.re[d] - a.im[d] * b.im[d];
        im[d] = a.re[d] * b.im[d] + a.im[d] * b.re[d];
    }
    return { re, im };
}
/** Unbind: m * conj(key). */
export function unbind(m, key) {
    const D = m.re.length;
    const re = new Float64Array(D);
    const im = new Float64Array(D);
    for (let d = 0; d < D; d++) {
        // conj(key) = (key.re, -key.im)
        re[d] = m.re[d] * key.re[d] + m.im[d] * key.im[d];
        im[d] = -m.re[d] * key.im[d] + m.im[d] * key.re[d];
    }
    return { re, im };
}
/** Create a seeded PRNG from a u32 seed. */
export { mulberry32 };
//# sourceMappingURL=core.js.map