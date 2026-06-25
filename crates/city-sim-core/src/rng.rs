// SeededRng: SplitMix64 seeding + xoshiro128** generation, mirroring app/src/game/rng.ts.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/// SeededRng — SplitMix64 seeding, xoshiro128** generation.
///
/// Must match `app/src/game/rng.ts` exactly.  The reference vectors in the
/// tests below are hardcoded from the TS implementation; do not change them
/// without also updating `rng.test.ts`.
///
/// Algorithm:
/// - **Seeding**: SplitMix64 expands a u32 seed (zero-extended to u64) into
///   four u32 state words.
/// - **Generation**: xoshiro128** — fast, high-quality 32-bit output.
#[derive(Debug, Clone)]
pub struct SeededRng {
    s0: u32,
    s1: u32,
    s2: u32,
    s3: u32,
}

impl SeededRng {
    /// Create from a u32 seed using SplitMix64 expansion.
    pub fn new(seed: u32) -> Self {
        const INCR: u64 = 0x9e3779b97f4a7c15;
        const M1: u64 = 0xbf58476d1ce4e5b9;
        const M2: u64 = 0x94d049bb133111eb;

        // TS: `let state = BigInt(seed >>> 0)` — u32 zero-extended to u64.
        let mut state: u64 = seed as u64;

        let mut sm = || -> u64 {
            state = state.wrapping_add(INCR);
            let mut z = state;
            z = (z ^ (z >> 30)).wrapping_mul(M1);
            z = (z ^ (z >> 27)).wrapping_mul(M2);
            z ^ (z >> 31)
        };

        let w0 = sm();
        let w1 = sm();

        Self {
            s0: w0 as u32,
            s1: (w0 >> 32) as u32,
            s2: w1 as u32,
            s3: (w1 >> 32) as u32,
        }
    }

    /// Restore RNG from a saved state tuple (no re-seeding).
    pub fn from_state(s: [u32; 4]) -> Self {
        Self {
            s0: s[0],
            s1: s[1],
            s2: s[2],
            s3: s[3],
        }
    }

    /// Serialise state for persistence.
    pub fn to_state(&self) -> [u32; 4] {
        [self.s0, self.s1, self.s2, self.s3]
    }

    /// Next u32 via xoshiro128**.
    pub fn next_u32(&mut self) -> u32 {
        let result = rotl(self.s1.wrapping_mul(5), 7).wrapping_mul(9);
        let t = self.s1 << 9;
        self.s2 ^= self.s0;
        self.s3 ^= self.s1;
        self.s1 ^= self.s2;
        self.s0 ^= self.s3;
        self.s2 ^= t;
        self.s3 = rotl(self.s3, 11);
        result
    }

    /// Float in [0, 1) — 24 bits of precision, matching TS `nextF32()`.
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / 16777216.0
    }

    /// Integer in [0, max).
    pub fn next_below(&mut self, max: u32) -> u32 {
        if max == 0 {
            return 0;
        }
        self.next_u32() % max
    }

    /// Derive an independent sub-RNG for a named system + tick.
    ///
    /// Matches TS `derive(systemId, tick)` — FNV-1a of the ASCII system name
    /// XOR'd with the tick (truncated to u32), then used as a fresh seed.
    pub fn derive(&self, system_id: &str, tick: u64) -> SeededRng {
        SeededRng::new(fnv1a(system_id) ^ (tick as u32))
    }
}

#[inline]
fn rotl(x: u32, k: u32) -> u32 {
    x.rotate_left(k)
}

/// FNV-1a 32-bit hash over ASCII bytes — used only by `derive()`.
fn fnv1a(s: &str) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for b in s.bytes() {
        h = (h ^ b as u32).wrapping_mul(0x01000193);
    }
    h
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // Reference vectors hardcoded from the canonical TS rng.test.ts.
    // The Rust sim_core MUST produce identical values for the same seeds.
    // Do NOT change without also updating rng.test.ts.
    const SEED0: [u32; 8] = [
        3737715805, 2584255861, 2876756834, 3286328325, 1553311962, 1625202774, 3260698944,
        2754151956,
    ];
    const SEED1: [u32; 8] = [
        1695105466, 1423115009, 634581793, 1068227753, 716759206, 4186505319, 3777694425,
        2710820970,
    ];
    const SEED12345: [u32; 8] = [
        2314518269, 2498321016, 2055377852, 4042509560, 1267802836, 503974162, 1443322985,
        3447162595,
    ];

    fn collect8(rng: &mut SeededRng) -> [u32; 8] {
        std::array::from_fn(|_| rng.next_u32())
    }

    #[test]
    fn seed0_reference_vectors() {
        assert_eq!(collect8(&mut SeededRng::new(0)), SEED0);
    }

    #[test]
    fn seed1_reference_vectors() {
        assert_eq!(collect8(&mut SeededRng::new(1)), SEED1);
    }

    #[test]
    fn seed12345_reference_vectors() {
        assert_eq!(collect8(&mut SeededRng::new(12345)), SEED12345);
    }

    #[test]
    fn same_seed_same_sequence() {
        let mut a = SeededRng::new(42);
        let mut b = SeededRng::new(42);
        for _ in 0..100 {
            assert_eq!(a.next_u32(), b.next_u32());
        }
    }

    #[test]
    fn different_seeds_different_sequences() {
        let mut a = SeededRng::new(1);
        let mut b = SeededRng::new(2);
        let sa: Vec<_> = (0..20).map(|_| a.next_u32()).collect();
        let sb: Vec<_> = (0..20).map(|_| b.next_u32()).collect();
        assert_ne!(sa, sb);
    }

    #[test]
    fn from_state_round_trips() {
        let mut rng = SeededRng::new(999);
        for _ in 0..10 {
            rng.next_u32();
        }
        let saved = rng.to_state();
        let mut restored = SeededRng::from_state(saved);
        for _ in 0..20 {
            assert_eq!(rng.next_u32(), restored.next_u32());
        }
    }

    #[test]
    fn next_f32_range() {
        let mut rng = SeededRng::new(7);
        for _ in 0..1000 {
            let f = rng.next_f32();
            assert!((0.0..1.0).contains(&f), "next_f32 out of range: {f}");
        }
    }

    #[test]
    fn next_below_range() {
        let mut rng = SeededRng::new(13);
        for max in 1u32..=50 {
            let v = rng.next_below(max);
            assert!(v < max, "next_below({max}) = {v} should be < max");
        }
    }

    #[test]
    fn next_below_zero_does_not_panic() {
        let mut rng = SeededRng::new(0);
        assert_eq!(rng.next_below(0), 0);
    }

    #[test]
    fn derive_produces_independent_rng() {
        let rng = SeededRng::new(1);
        let mut a = rng.derive("zone_growth", 0);
        let mut b = rng.derive("power_check", 0);
        assert_ne!(a.next_u32(), b.next_u32());
    }
}
