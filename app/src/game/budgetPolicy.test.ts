// budgetPolicy.test.ts — fiscal policy effects through the TS parity oracle.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { createInitialState, TileKind } from './gameState';
import { Simulation } from './simulation';
import { deserialize, serialize } from './persistence';
import { applyTool } from './tools';
import { Tool } from './toolTypes';
import { createDefaultBudgetPolicy } from './protocol/commands';
import { placeBuilding } from './buildings/manager';
import { getBuildingTemplate } from './buildings/templates';

function tickOnce(state: ReturnType<typeof createInitialState>) {
  const sim = new Simulation(state, { ticksPerSecond: 20 });
  sim.update(1 / 20);
}

/** Zone a lot and develop it so the city has real population capacity —
 *  otherwise the growth clamp zeroes population before the budget runs. */
function developResidential(state: ReturnType<typeof createInitialState>, x: number, y: number) {
  applyTool(state, Tool.Road, x, y - 1);
  applyTool(state, Tool.Residential, x, y);
  const tmpl = getBuildingTemplate(TileKind.Residential);
  if (!tmpl) throw new Error('missing residential template');
  const result = placeBuilding(state, tmpl, x, y);
  if (!result.success) throw new Error('failed to place residential building');
}

describe('budget policy', () => {
  it('scales residential revenue with the tax rate', () => {
    const neutral = createInitialState(8, 8, 1);
    developResidential(neutral, 4, 4);
    tickOnce(neutral);
    expect(neutral.population).toBeGreaterThan(0);

    const taxed = createInitialState(8, 8, 1);
    developResidential(taxed, 4, 4);
    taxed.budgetPolicy.taxResidential = 18; // double the neutral 9%
    tickOnce(taxed);

    expect(taxed.budget.breakdown.revenue.residents).toBeCloseTo(
      neutral.budget.breakdown.revenue.residents * 2,
      5
    );
  });

  it('scales road upkeep with transport funding', () => {
    const full = createInitialState(8, 8, 1);
    applyTool(full, Tool.Road, 4, 4);
    applyTool(full, Tool.Road, 5, 4);
    tickOnce(full);

    const half = createInitialState(8, 8, 1);
    applyTool(half, Tool.Road, 4, 4);
    applyTool(half, Tool.Road, 5, 4);
    half.budgetPolicy.fundTransport = 50;
    tickOnce(half);

    expect(half.budget.breakdown.details.transport.roads).toBeCloseTo(
      full.budget.breakdown.details.transport.roads * 0.5,
      5
    );
  });

  it('suppresses residential demand under high taxes', () => {
    const build = (tax: number) => {
      const state = createInitialState(12, 12, 1);
      // Plenty of developed capacity so fill stays low and demand is
      // positive — otherwise the 0–100 clamp hides the tax term.
      developResidential(state, 3, 4);
      developResidential(state, 5, 4);
      developResidential(state, 7, 4);
      developResidential(state, 9, 4);
      state.budgetPolicy.taxResidential = tax;
      tickOnce(state);
      return state.demand.residential;
    };
    const taxed = build(20);
    const neutral = build(9);
    expect(neutral).toBeGreaterThan(0);
    expect(taxed).toBeLessThan(neutral);
  });

  it('neutral policy matches the pre-policy economy exactly', () => {
    const state = createInitialState(8, 8, 1);
    developResidential(state, 3, 4);
    applyTool(state, Tool.Commercial, 5, 5);
    tickOnce(state);
    // Revenue formulas must reproduce the pre-policy literals at 9%/100%.
    expect(state.budget.breakdown.revenue.residents).toBeCloseTo(state.population * 1.5, 6);
    expect(state.budget.breakdown.revenue.commercial).toBeCloseTo(6, 6);
  });

  it('back-fills the neutral policy on old saves', () => {
    const state = createInitialState(4, 4, 1);
    const raw = JSON.parse(serialize(state));
    delete raw.budgetPolicy;
    const restored = deserialize(JSON.stringify(raw));
    expect(restored.budgetPolicy).toEqual(createDefaultBudgetPolicy());
  });

  it('clamps out-of-range policy values on load', () => {
    const state = createInitialState(4, 4, 1);
    const raw = JSON.parse(serialize(state));
    raw.budgetPolicy = { ...raw.budgetPolicy, taxResidential: 99, fundPower: 900 };
    const restored = deserialize(JSON.stringify(raw));
    expect(restored.budgetPolicy.taxResidential).toBe(20);
    expect(restored.budgetPolicy.fundPower).toBe(100);
  });
});
