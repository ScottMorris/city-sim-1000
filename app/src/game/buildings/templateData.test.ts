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
import { BUILD_COST, POWER_PLANT_CONFIGS, PowerPlantType } from '../constants';
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

describe('POWER_PLANT_CONFIGS.outputMw — no drift from templateData.json outputMw', () => {
  // Kept parallel to constants.ts's own literal-to-BuildingKind-member-name
  // mapping (`engineBuildingData('HydroPlant')` &c.) rather than derived
  // from it, so a bug in `constants.ts`'s own key spelling shows up here too.
  const KIND_NAME: Record<PowerPlantType, string> = {
    [PowerPlantType.Hydro]: 'HydroPlant',
    [PowerPlantType.Coal]: 'CoalPlant',
    [PowerPlantType.Wind]: 'WindTurbine',
    [PowerPlantType.Solar]: 'SolarFarm'
  };

  it('every plant type\'s outputMw matches templateData.json, not a hand-duplicated literal', () => {
    for (const plantType of Object.values(PowerPlantType)) {
      expect(POWER_PLANT_CONFIGS[plantType].outputMw, `POWER_PLANT_CONFIGS.${plantType}.outputMw`).toBe(
        engineBuildingData(KIND_NAME[plantType]).outputMw
      );
    }
  });
});
