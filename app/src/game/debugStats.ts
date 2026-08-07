// debugStats.ts — derived debug-overlay figures: zone tile counts, plus wire-sourced demand/labour/utility totals reshaped for display.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// Demand and labour/capacity figures used to be recomputed here from a TS
// shadow of the engine's formula (`demand.ts`, `computeLabourStats.ts`, both
// deleted) — they now come straight off the wire (`state.demand`,
// `state.labour`; `#200`'s wire-adoption follow-up). Utility totals
// (power/water produced/used) are wire-sourced too (`state.utilities`) —
// summing static template `powerUse`/`waterUse`/`waterOutput` figures
// disagreed with the engine whenever a non-default lighting bylaw was
// active. The only aggregation left here is zone tile counts, which cannot
// drift from the engine because it only counts bits the wire already
// decoded.

import { DemandClassBreakdown, GameState, LabourStats } from './gameState';
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
 * without mutating state. Demand, labour, capacity, and utility totals are
 * read straight off `state` (wire-sourced); only zone tile counts are
 * aggregated here.
 */
export function getSimulationDebugStats(state: GameState): SimulationDebugStats {
  let residentialZones = 0;
  let commercialZones = 0;
  let industrialZones = 0;
  const educationScore = state.education?.score ?? 0;
  const elementaryCoverage = state.education?.elementaryCoverage ?? 0;
  const highCoverage = state.education?.highCoverage ?? 0;

  for (const tile of state.tiles) {
    if (hasOccupant(tile.surface, Occupant.ZoneResidential)) residentialZones++;
    if (hasOccupant(tile.surface, Occupant.ZoneCommercial)) commercialZones++;
    if (hasOccupant(tile.surface, Occupant.ZoneIndustrial)) industrialZones++;
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
      powerUsed: state.utilities.powerUsed,
      powerBalance: state.utilities.power,
      waterOutput: state.utilities.waterProduced,
      waterUse: state.utilities.waterUsed,
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
