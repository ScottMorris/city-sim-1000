// debugStats.ts — derived debug-overlay figures (zone tile counts, utility use by building).
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// Demand and labour/capacity figures used to be recomputed here from a TS
// shadow of the engine's formula (`demand.ts`, `computeLabourStats.ts`, both
// deleted) — they now come straight off the wire (`state.demand`,
// `state.labour`; `#200`'s wire-adoption follow-up). What remains is display
// aggregation that cannot drift from the engine because it only counts bits
// the wire already decoded (zoned tiles) or reads static template data
// (per-building power/water use) — not a parallel copy of simulation math.

import { BuildingStatus } from './buildings/state';
import { getBuildingTemplate } from './buildings/templates';
import { DemandClassBreakdown, GameState, LabourStats } from './gameState';
import { hasWaterSourceConnection } from './utilities/water';
import { Occupant, hasOccupant } from './protocol/occupants';

export interface SimulationDebugStats {
  tick: number;
  day: number;
  population: number;
  jobs: number;
  labour: LabourStats;
  zones: {
    residential: number;
    commercial: number;
    industrial: number;
  };
  capacities: {
    population: number;
    jobs: number;
  };
  utilities: {
    powerProduced: number;
    powerUsed: number;
    powerBalance: number;
    waterOutput: number;
    waterUse: number;
    waterBalance: number;
  };
  education: {
    score: number;
    elementaryCoverage: number;
    highCoverage: number;
  };
  demand: {
    residential: number;
    commercial: number;
    industrial: number;
  };
  demandDetails: {
    residential: DemandClassBreakdown;
    commercial: DemandClassBreakdown;
    industrial: DemandClassBreakdown;
  };
}

/**
 * Computes a read-only snapshot of the debug-overlay's display figures
 * without mutating state. Demand, labour, and capacity figures are read
 * straight off `state` (wire-sourced); only zone tile counts and per-building
 * utility totals are aggregated here.
 */
export function getSimulationDebugStats(state: GameState): SimulationDebugStats {
  let residentialZones = 0;
  let commercialZones = 0;
  let industrialZones = 0;
  let buildingPowerUse = 0;
  let buildingWaterUse = 0;
  let buildingWaterOutput = 0;
  const educationScore = state.education?.score ?? 0;
  const elementaryCoverage = state.education?.elementaryCoverage ?? 0;
  const highCoverage = state.education?.highCoverage ?? 0;

  for (const tile of state.tiles) {
    if (hasOccupant(tile.surface, Occupant.ZoneResidential)) residentialZones++;
    if (hasOccupant(tile.surface, Occupant.ZoneCommercial)) commercialZones++;
    if (hasOccupant(tile.surface, Occupant.ZoneIndustrial)) industrialZones++;
  }

  for (const building of state.buildings) {
    const template = getBuildingTemplate(building.templateId);
    if (!template) continue;
    if (building.state.status !== BuildingStatus.Active) continue;
    if (
      template.waterOutput &&
      hasWaterSourceConnection(state, building.origin, template.footprint, building.id)
    ) {
      buildingWaterOutput += template.waterOutput;
    }
    if (template.powerUse) buildingPowerUse += template.powerUse;
    if (template.waterUse) buildingWaterUse += template.waterUse;
  }

  return {
    tick: state.tick,
    day: state.day,
    population: state.population,
    jobs: state.jobs,
    labour: state.labour,
    zones: { residential: residentialZones, commercial: commercialZones, industrial: industrialZones },
    capacities: { population: state.labour.resCapacity, jobs: state.labour.jobCapacity },
    utilities: {
      powerProduced: state.utilities.powerProduced,
      powerUsed: buildingPowerUse,
      powerBalance: state.utilities.power,
      waterOutput: buildingWaterOutput,
      waterUse: buildingWaterUse,
      waterBalance: state.utilities.water
    },
    education: {
      score: educationScore,
      elementaryCoverage,
      highCoverage
    },
    demand: {
      residential: state.demand.residential,
      commercial: state.demand.commercial,
      industrial: state.demand.industrial
    },
    demandDetails: state.demand.breakdown
  };
}
