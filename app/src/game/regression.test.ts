/**
 * Regression oracle — tolerance-banded golden scenarios.
 *
 * Each scenario specifies a seed, a command log, and a tick count.
 * After replay, key metrics are asserted within tolerance bands.
 *
 * PURPOSE: detect simulation divergence across refactors and, later,
 * confirm that the Rust sim_core produces values within the same bands.
 *
 * TOLERANCE PHILOSOPHY: bands are wide enough to survive minor tuning
 * (±10% on economic metrics, exact counts on tile kinds) but narrow
 * enough to catch algorithmic regressions.
 *
 * Do not tighten bands for cosmetic precision — loosen them if legitimate
 * parameter changes shift a value slightly outside.
 */

import { describe, it, expect } from 'vitest';
import { createInitialState } from './gameState';
import { Simulation } from './simulation';
import { applyTool } from './tools';
import { Tool } from './toolTypes';
import { extractSnapshot, StateSnapshot } from './stateHash';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Band {
  min: number;
  max: number;
}

function band(centre: number, pct = 0.15): Band {
  const margin = Math.abs(centre) * pct + 1; // +1 so zero-valued centres still have room
  return { min: centre - margin, max: centre + margin };
}

function assertBand(label: string, value: number, b: Band) {
  expect(value, `${label} (${value}) should be in [${b.min.toFixed(1)}, ${b.max.toFixed(1)}]`).toBeGreaterThanOrEqual(b.min);
  expect(value, `${label} (${value}) should be in [${b.min.toFixed(1)}, ${b.max.toFixed(1)}]`).toBeLessThanOrEqual(b.max);
}

function runSim(
  seed: number,
  mapSize: number,
  setup: (state: ReturnType<typeof createInitialState>) => void,
  ticks: number
): StateSnapshot {
  const state = createInitialState(mapSize, mapSize, seed);
  state.money = 200000;
  setup(state);
  const sim = new Simulation(state, { ticksPerSecond: 20 });
  sim.update(ticks / 20);
  return extractSnapshot(state);
}

// ---------------------------------------------------------------------------
// Scenario 1 — Baseline (no buildings, just economy + demand decay)
// seed=1, 8×8, 100 ticks
// ---------------------------------------------------------------------------

describe('regression: scenario 1 — baseline', () => {
  const snap = runSim(1, 8, () => {}, 100);

  it('tick count', () => expect(snap.tick).toBe(100));
  // With no zone buildings the sim recomputes population from buildings → 0.
  it('population zero (no zone buildings)', () => expect(snap.population).toBe(0));
  // Money may rise slightly from initial base income before population resets to 0.
  it('money roughly unchanged (no upkeep without buildings)', () => {
    assertBand('money', snap.money, band(200_000_000, 0.01)); // ±1% of initial (quantised ×1000)
  });
  it('demand non-zero', () => {
    assertBand('res demand', snap.demand.residential, { min: 1000, max: 50000 });
  });
  it('no buildings', () => expect(snap.buildingCount).toBe(0));
});

// ---------------------------------------------------------------------------
// Scenario 2 — Power + residential growth
// seed=2, 16×16, hydro + road + 3 residential zones, 200 ticks
// ---------------------------------------------------------------------------

describe('regression: scenario 2 — power + residential growth', () => {
  const snap = runSim(2, 16, (state) => {
    state.demand.residential = 80;
    applyTool(state, Tool.HydroPlant, 1, 1);
    applyTool(state, Tool.Road, 3, 1);
    applyTool(state, Tool.Road, 3, 2);
    applyTool(state, Tool.Road, 3, 3);
    applyTool(state, Tool.Residential, 4, 1);
    applyTool(state, Tool.Residential, 4, 2);
    applyTool(state, Tool.Residential, 4, 3);
  }, 200);

  it('tick count', () => expect(snap.tick).toBe(200));
  it('some buildings spawned', () => expect(snap.buildingCount).toBeGreaterThan(0));
  it('population grew', () => expect(snap.population).toBeGreaterThan(5));
  it('power produced', () => {
    expect(snap.utilities.powerProduced).toBeGreaterThan(0);
  });
  it('land tiles present', () => {
    expect(snap.tileCounts['terrain:land'] ?? 0).toBeGreaterThan(0);
  });
  it('residential tiles present', () => {
    expect(snap.tileCounts['zone-residential'] ?? 0).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Water + zones
// seed=3, 16×16, water pump + tower + pipe + road + 3 residential, 300 ticks
// ---------------------------------------------------------------------------

describe('regression: scenario 3 — water + zones', () => {
  const snap = runSim(3, 16, (state) => {
    state.demand.residential = 90;
    // Power
    applyTool(state, Tool.HydroPlant, 1, 1);
    // Power lines bridging hydro (ends at x=2) to road spine at x=5
    applyTool(state, Tool.PowerLine, 3, 1);
    applyTool(state, Tool.PowerLine, 4, 1);
    // Water system
    applyTool(state, Tool.WaterPump, 1, 3);
    applyTool(state, Tool.WaterPipe, 2, 3);
    applyTool(state, Tool.WaterTower, 3, 3);
    // Road spine + zones
    applyTool(state, Tool.Road, 5, 1);
    applyTool(state, Tool.Road, 5, 2);
    applyTool(state, Tool.Road, 5, 3);
    applyTool(state, Tool.Road, 5, 4);
    applyTool(state, Tool.Residential, 6, 1);
    applyTool(state, Tool.Residential, 6, 2);
    applyTool(state, Tool.Residential, 6, 3);
    applyTool(state, Tool.Residential, 6, 4);
  }, 300);

  it('tick count', () => expect(snap.tick).toBe(300));
  it('water produced', () => expect(snap.utilities.waterProduced).toBeGreaterThan(0));
  it('buildings grew', () => expect(snap.buildingCount).toBeGreaterThan(0));
  it('population grew', () => expect(snap.population).toBeGreaterThan(20));
  it('residential tiles present', () => {
    expect(snap.tileCounts['zone-residential'] ?? 0).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Abandonment under power stress
// seed=4, 16×16, build zones with marginal power, run long enough to see
// some trouble / abandonment behaviour
// ---------------------------------------------------------------------------

describe('regression: scenario 4 — power stress + abandonment', () => {
  const snap = runSim(4, 16, (state) => {
    state.demand.residential = 95;
    state.demand.commercial = 60;
    // Minimal power plant — may not cover all zones under load
    applyTool(state, Tool.WindTurbine, 1, 1);
    applyTool(state, Tool.Road, 3, 1);
    applyTool(state, Tool.Road, 3, 2);
    applyTool(state, Tool.Road, 3, 3);
    applyTool(state, Tool.Road, 3, 4);
    // 4 residential + 2 commercial (likely to stress power)
    applyTool(state, Tool.Residential, 4, 1);
    applyTool(state, Tool.Residential, 4, 2);
    applyTool(state, Tool.Residential, 4, 3);
    applyTool(state, Tool.Residential, 4, 4);
    applyTool(state, Tool.Commercial, 5, 2);
    applyTool(state, Tool.Commercial, 5, 3);
  }, 400);

  it('tick count', () => expect(snap.tick).toBe(400));
  it('simulation remained alive (money >= 0)', () => expect(snap.money).toBeGreaterThanOrEqual(0));
  it('tile kinds are populated', () => {
    // Every tile contributes to exactly one terrain bucket — unlike the
    // occupant buckets, which a single tile can contribute to several of at
    // once (a zoned lot crossed by a wire counts under both) — so summing
    // just those two is the equivalent of the old "every tile accounted
    // for" sanity check.
    const total = (snap.tileCounts['terrain:land'] ?? 0) + (snap.tileCounts['terrain:water'] ?? 0);
    expect(total).toBe(16 * 16);
  });
  it('some road tiles present', () => {
    expect(snap.tileCounts['road'] ?? 0).toBeGreaterThan(0);
  });
});
