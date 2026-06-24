/**
 * Deterministic pseudo-random number generator.
 *
 * Algorithm: SplitMix64 for seeding, xoshiro128** for generation.
 * Mirrors the Rust sim_core implementation so replay seeds produce
 * identical sequences on both sides of the bridge.
 *
 * All generation state is four u32 words (JS numbers kept in u32 range via >>> 0).
 * BigInt is used only in the constructor (one-time seeding) where correctness
 * matters more than performance.
 */
export class SeededRng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    // SplitMix64: expand a 64-bit seed into four u32 state words.
    // Using BigInt here for exact 64-bit arithmetic — this runs once per construction.
    const INCR = 0x9e3779b97f4a7c15n;
    const M1   = 0xbf58476d1ce4e5b9n;
    const M2   = 0x94d049bb133111ebn;
    const MASK = 0xffffffffffffffffn;

    let state = BigInt(seed >>> 0); // treat seed as u32; extend to u64

    const sm = (): bigint => {
      state = (state + INCR) & MASK;
      let z = state;
      z = ((z ^ (z >> 30n)) * M1) & MASK;
      z = ((z ^ (z >> 27n)) * M2) & MASK;
      return z ^ (z >> 31n);
    };

    const w0 = sm();
    const w1 = sm();

    this.s0 = Number(w0 & 0xffffffffn);
    this.s1 = Number(w0 >> 32n);
    this.s2 = Number(w1 & 0xffffffffn);
    this.s3 = Number(w1 >> 32n);
  }

  /** Next u32 via xoshiro128** */
  nextU32(): number {
    const result = (Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9)) >>> 0;

    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);

    return result;
  }

  /** Float in [0, 1) — 24 bits of precision, matching Rust's `next_f32()`. */
  nextF32(): number {
    return (this.nextU32() >>> 8) / 16777216;
  }

  /** Integer in [0, max). */
  nextBelow(max: number): number {
    if (max <= 0) return 0;
    return this.nextU32() % max;
  }

  /**
   * Derive an independent sub-system RNG from this seed + a string tag.
   * Using a fixed derivation means adding/removing a system doesn't shift
   * any other system's sequence.
   */
  derive(systemId: string, tick: number): SeededRng {
    return new SeededRng(fnv1a(systemId) ^ (tick >>> 0));
  }

  /** Serialise state tuple for inclusion in GameState saves. */
  toJSON(): [number, number, number, number] {
    return [this.s0, this.s1, this.s2, this.s3];
  }

  /** Restore an RNG directly from a saved state tuple (no re-seeding). */
  static fromState(state: [number, number, number, number]): SeededRng {
    const rng = new SeededRng(0);
    [rng.s0, rng.s1, rng.s2, rng.s3] = state;
    return rng;
  }
}

// ---------------------------------------------------------------------------
// Helpers (module-private)
// ---------------------------------------------------------------------------

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** FNV-1a 32-bit hash — used only for derive(). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h;
}
