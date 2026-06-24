import { describe, it, expect } from 'vitest';
import { createInitialState } from './gameState';
import { Simulation } from './simulation';
import { applyTool } from './tools';
import { Tool } from './toolTypes';
import { SeededRng } from './rng';
import { extractSnapshot, hashState, hashSnapshot, snapshotToString } from './stateHash';

describe('stateHash', () => {
  it('same seed + commands → identical hash across 10 runs', async () => {
    const SEED = 42;

    const run = async () => {
      const state = createInitialState(8, 8, SEED);
      state.money = 50000;
      applyTool(state, Tool.Road, 2, 2);
      applyTool(state, Tool.Residential, 2, 3);
      state.demand.residential = 80;
      const sim = new Simulation(state, { ticksPerSecond: 1 });
      sim.rng = SeededRng.fromState([0, 0, 0, 0]); // deterministic growth
      sim.update(3);
      return hashState(state);
    };

    const hashes = await Promise.all(Array.from({ length: 10 }, run));
    expect(new Set(hashes).size).toBe(1);
  });

  it('different seeds → different hashes', async () => {
    const makeHash = async (seed: number) => {
      const state = createInitialState(8, 8, seed);
      return hashState(state);
    };
    const [h1, h2] = await Promise.all([makeHash(1), makeHash(2)]);
    expect(h1).not.toBe(h2);
  });

  it('snapshot excludes settings and budgetHistory', () => {
    const state = createInitialState(6, 6, 0);
    const snap = extractSnapshot(state);
    // settings and budgetHistory are intentionally absent
    expect((snap as Record<string, unknown>).settings).toBeUndefined();
    expect((snap as Record<string, unknown>).budgetHistory).toBeUndefined();
  });

  it('snapshotToString is stable (same input → same string)', () => {
    const state = createInitialState(6, 6, 99);
    const a = snapshotToString(extractSnapshot(state));
    const b = snapshotToString(extractSnapshot(state));
    expect(a).toBe(b);
  });

  it('hash changes after simulation step', async () => {
    const state = createInitialState(8, 8, 7);
    const before = await hashState(state);
    const sim = new Simulation(state, { ticksPerSecond: 1 });
    sim.update(1.1); // ensure at least one full tick fires
    const after = await hashState(state);
    expect(before).not.toBe(after);
  });

  it('hashSnapshot returns 64-char hex string', async () => {
    const state = createInitialState(4, 4, 0);
    const h = await hashState(state);
    expect(h).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(h)).toBe(true);
  });
});
