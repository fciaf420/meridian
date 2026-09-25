/**
 * HRR (Holographic Reduced Representation) math primitives.
 *
 * All functions operate on complex-valued vectors with unit magnitude.
 * Binding is element-wise complex multiplication; unbinding uses conjugate.
 * Zero external dependencies — pure Float64Array math.
 */
export interface ComplexVector {
    re: Float64Array;
    im: Float64Array;
}
declare function mulberry32(seed: number): () => number;
/** Derive a u32 seed from a string (same as Python version). */
export declare function seedFromName(name: string): number;
/**
 * Create V unit-magnitude complex key vectors of dimension D.
 * Each entry has magnitude 1 (phase-only): key = exp(i * phi)
 * where phi ~ Uniform(0, 2*pi).
 */
export declare function makeVocabKeys(V: number, D: number, rng: () => number): ComplexVector[];
/**
 * Create L role/position keys via successive powers of a base root.
 * role[k] = base^k where base = exp(2*pi*i * arange(D) / D).
 */
export declare function makeRoleKeys(D: number, L: number): ComplexVector[];
/**
 * Gram-Schmidt-like decorrelation in R^{2D}, projected back to unit phase.
 * 1. Stack real/imag → R^{2D}
 * 2. Iteratively subtract correlated components
 * 3. Re-normalise and convert back to unit-magnitude complex
 */
export declare function orthogonalize(keys: ComplexVector[], iters?: number, step?: number): ComplexVector[];
/**
 * Magnitude-sharpening nonlinearity.
 * z_out = z * (|z| + eps)^(p - 1)
 * p > 1  → contrast-increasing
 * p < 1  → softening
 * p == 1 → identity
 */
export declare function sharpen(z: ComplexVector, p?: number, eps?: number): ComplexVector;
/**
 * Gentle magnitude limiter (CORVACS-lite).
 * z_out = z * tanh(a * |z|) / |z|
 * a == 0 → identity
 * a > 0  → soft saturation
 */
export declare function corvacsLite(z: ComplexVector, a?: number): ComplexVector;
/** Temperature-scaled softmax over similarity logits. */
export declare function softmaxTemp(sims: Float64Array, T?: number): Float64Array;
/**
 * Convert [V, D] complex → [V, 2D] real with unit row norms.
 * Used for efficient cosine similarity: sims = vocab_norm @ query_2d.
 */
export declare function stackAndUnitNorm(keys: ComplexVector[]): Float64Array[];
/** Bind: element-wise complex product a * b. */
export declare function bind(a: ComplexVector, b: ComplexVector): ComplexVector;
/** Unbind: m * conj(key). */
export declare function unbind(m: ComplexVector, key: ComplexVector): ComplexVector;
/** Create a seeded PRNG from a u32 seed. */
export { mulberry32 };
//# sourceMappingURL=core.d.ts.map