// templateData.test.ts — engineBuildingData/engineToolCost pin templateData.json, and BUILD_COST/getToolCost never disagree with it.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// `templateData.json` is generated from Rust (`crates/city-sim-core/tests/
// template_data.rs`) — the engine is authoritative for every number in it.
// This file doesn't re-derive those numbers (that would just be a second
// hand-copy); it pins the TS consumption side: a missing key throws loudly
// instead of returning `undefined`, and the HUD/toolbar's display cost
// (`getToolCost`) never drifts from what `tool_cost` actually charges.

import { describe, it, expect } from 'vitest';
import rawTemplateData from './templateData.json';
import { engineBuildingData, engineToolCost } from './templateData';
import { getToolCost } from './templates';
import { BUILD_COST } from '../constants';
import { Tool } from '../toolTypes';

describe('engineBuildingData', () => {
  it('returns the parsed entry for a known BuildingKind member name', () => {
    expect(engineBuildingData('Residential')).toEqual(
      (rawTemplateData as { buildings: Record<string, unknown> }).buildings.Residential
    );
  });

  it('throws rather than returning undefined for an unknown key', () => {
    expect(() => engineBuildingData('NotARealBuildingKind')).toThrow(/templateData\.json has no/);
  });
});

describe('engineToolCost', () => {
  it('throws rather than returning undefined for an unknown key', () => {
    expect(() => engineToolCost('NotARealTool')).toThrow(/templateData\.json has no/);
  });
});

describe('BUILD_COST / getToolCost — no drift from templateData.json toolCost', () => {
  const toolCost = (rawTemplateData as { toolCost: Record<string, number> }).toolCost;

  it('every Tool member has a templateData.json toolCost entry', () => {
    for (const key of Object.keys(Tool)) {
      expect(toolCost[key], `toolCost.${key}`).toBeDefined();
    }
  });

  it('BUILD_COST matches templateData.json toolCost for every tool', () => {
    for (const key of Object.keys(Tool) as (keyof typeof Tool)[]) {
      expect(BUILD_COST[Tool[key]], `BUILD_COST[Tool.${key}]`).toBe(toolCost[key]);
    }
  });

  it('getToolCost (the HUD/toolbar display value) matches BUILD_COST for every tool', () => {
    for (const tool of Object.values(Tool)) {
      expect(getToolCost(tool), `getToolCost(${tool})`).toBe(BUILD_COST[tool]);
    }
  });
});
