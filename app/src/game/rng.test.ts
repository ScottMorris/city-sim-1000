import { describe, it, expect } from 'vitest';
import { SeededRng } from './rng';

// ---------------------------------------------------------------------------
// Reference vectors — hardcoded from the canonical TS implementation.
// The Rust sim_core MUST produce IDENTICAL values for the same seeds.
// Do not change these without also updating the Rust golden-vector test.
//
// Algorithm: SplitMix64 seeding (seed treated as u32 extended to u64),
//            xoshiro128** generation.
// ---------------------------------------------------------------------------

/** First 8 u32 outputs for seed 0. */
const SEED0_U32 = [3737715805,2584255861,2876756834,3286328325,1553311962,1625202774,3260698944,2754151956];

/** First 8 u32 outputs for seed 1. */
const SEED1_U32 = [1695105466,1423115009,634581793,1068227753,716759206,4186505319,3777694425,2710820970];

/** First 8 u32 outputs for seed 12345. */
const SEED12345_U32 = [2314518269,2498321016,2055377852,4042509560,1267802836,503974162,1443322985,3447162595];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SeededRng', () => {
  it('same seed → same sequence', () => {
    const a = new SeededRng(42);
    const b = new SeededRng(42);
    for (let i = 0; i < 100; i++) {
      expect(a.nextU32()).toBe(b.nextU32());
    }
  });

  it('different seeds → different sequences', () => {
    const a = new SeededRng(1);
    const b = new SeededRng(2);
    const aVals = Array.from({ length: 20 }, () => a.nextU32());
    const bVals = Array.from({ length: 20 }, () => b.nextU32());
    expect(aVals).not.toEqual(bVals);
  });

  it('nextU32 values are in u32 range', () => {
    const rng = new SeededRng(999);
    for (let i = 0; i < 200; i++) {
      const v = rng.nextU32();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('nextF32 values are in [0, 1)', () => {
    const rng = new SeededRng(7);
    for (let i = 0; i < 200; i++) {
      const v = rng.nextF32();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('nextBelow is in [0, max)', () => {
    const rng = new SeededRng(3);
    for (const max of [1, 2, 5, 10, 100, 1000]) {
      for (let i = 0; i < 50; i++) {
        const v = rng.nextBelow(max);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(max);
      }
    }
  });

  it('nextBelow(0) returns 0', () => {
    expect(new SeededRng(0).nextBelow(0)).toBe(0);
  });

  it('serialize + restore produces identical continuation', () => {
    const rng = new SeededRng(555);
    // Advance a bit.
    for (let i = 0; i < 50; i++) rng.nextU32();

    const saved = rng.toJSON();
    const restored = SeededRng.fromState(saved);

    for (let i = 0; i < 100; i++) {
      expect(rng.nextU32()).toBe(restored.nextU32());
    }
  });

  it('derive produces independent stream per system', () => {
    const rng = new SeededRng(0);
    const a = rng.derive('zone_growth', 10);
    const b = rng.derive('zone_growth', 10);
    const c = rng.derive('decay', 10);

    // Same params → same stream.
    for (let i = 0; i < 20; i++) {
      expect(a.nextU32()).toBe(b.nextU32());
    }

    // Different id → different stream.
    const a2 = rng.derive('zone_growth', 10);
    const c2 = rng.derive('decay', 10);
    const aVals = Array.from({ length: 20 }, () => a2.nextU32());
    const cVals = Array.from({ length: 20 }, () => c2.nextU32());
    expect(aVals).not.toEqual(cVals);
  });

  // -------------------------------------------------------------------------
  // Reference-vector regression — these values must match the Rust sim_core.
  // If you need to update them, also update the Rust golden-vector test.
  // -------------------------------------------------------------------------

  it('seed=0 reference vectors are stable', () => {
    const rng = new SeededRng(0);
    const got = Array.from({ length: 8 }, () => rng.nextU32());
    expect(got).toEqual(SEED0_U32);
    // Print for Rust: console.log('seed0:', JSON.stringify(got));
  });

  it('seed=1 reference vectors are stable', () => {
    const rng = new SeededRng(1);
    const got = Array.from({ length: 8 }, () => rng.nextU32());
    expect(got).toEqual(SEED1_U32);
  });

  it('seed=12345 reference vectors are stable', () => {
    const rng = new SeededRng(12345);
    const got = Array.from({ length: 8 }, () => rng.nextU32());
    expect(got).toEqual(SEED12345_U32);
  });
});
