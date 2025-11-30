import { BuildingStatus, getBuildingTemplate } from './buildings';
import { GameState, TileKind } from './gameState';

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

export interface DemandDetails {
  base: number;
  zonePenalty: number;
  populationTerm: number;
  jobsTerm: number;
  utilityPenalty: number;
  final: number;
}

export interface SimulationDebugStats {
  tick: number;
  day: number;
  population: number;
  jobs: number;
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
  demand: {
    residential: number;
    commercial: number;
    industrial: number;
  };
  demandDetails: {
    residential: DemandDetails;
    commercial: DemandDetails;
    industrial: DemandDetails;
  };
}

/**
 * Computes a read-only snapshot of the simulation inputs without mutating state.
 */
export function getSimulationDebugStats(state: GameState): SimulationDebugStats {
  let residentialZones = 0;
  let commercialZones = 0;
  let industrialZones = 0;
  let populationCapacity = 0;
  let jobCapacity = 0;
  let buildingPowerUse = 0;
  let buildingWaterUse = 0;
  let buildingWaterOutput = 0;

  const pumpTemplate = getBuildingTemplate(TileKind.WaterPump);

  for (const tile of state.tiles) {
    if (tile.kind === TileKind.Residential) residentialZones++;
    if (tile.kind === TileKind.Commercial) commercialZones++;
    if (tile.kind === TileKind.Industrial) industrialZones++;

    const isLegacyPump = tile.buildingId === undefined && tile.kind === TileKind.WaterPump;
    if (isLegacyPump && pumpTemplate) {
      const active = pumpTemplate.requiresPower === false ? true : tile.powered;
      if (active && pumpTemplate.waterOutput) buildingWaterOutput += pumpTemplate.waterOutput;
    }
  }

  for (const building of state.buildings) {
    const template = getBuildingTemplate(building.templateId);
    if (!template) continue;
    const isActive = building.state.status === BuildingStatus.Active;
    if (!isActive) continue;
    if (template.waterOutput) buildingWaterOutput += template.waterOutput;
    if (template.powerUse) buildingPowerUse += template.powerUse;
    if (template.waterUse) buildingWaterUse += template.waterUse;
    if (template.populationCapacity) populationCapacity += template.populationCapacity;
    if (template.jobsCapacity) jobCapacity += template.jobsCapacity;
  }

  const utilityPenalty =
    (state.utilities.power < 0 ? 15 : 0) + (state.utilities.water < 0 ? 10 : 0);
  const jobsTerm = Math.max(0, state.jobs - state.population);
  const resZonePenalty = residentialZones * 2;
  const comZonePenalty = commercialZones * 3;
  const indZonePenalty = industrialZones * 3;

  const residentialBase = 60 - resZonePenalty + jobsTerm;
  const residentialAfterPenalty = clamp(clamp(residentialBase, 0, 100) - utilityPenalty, 0, 100);
  const commercialBase = 50 - comZonePenalty + state.population * 0.2;
  const industrialBase = 50 - indZonePenalty + state.population * 0.15;

  return {
    tick: state.tick,
    day: state.day,
    population: state.population,
    jobs: state.jobs,
    zones: { residential: residentialZones, commercial: commercialZones, industrial: industrialZones },
    capacities: { population: populationCapacity, jobs: jobCapacity },
    utilities: {
      powerProduced: state.utilities.powerProduced,
      powerUsed: buildingPowerUse,
      powerBalance: state.utilities.power,
      waterOutput: buildingWaterOutput,
      waterUse: buildingWaterUse,
      waterBalance: state.utilities.water
    },
    demand: {
      residential: residentialAfterPenalty,
      commercial: clamp(commercialBase, 0, 100),
      industrial: clamp(industrialBase, 0, 100)
    },
    demandDetails: {
      residential: {
        base: 60,
        zonePenalty: resZonePenalty,
        populationTerm: 0,
        jobsTerm,
        utilityPenalty,
        final: residentialAfterPenalty
      },
      commercial: {
        base: 50,
        zonePenalty: comZonePenalty,
        populationTerm: state.population * 0.2,
        jobsTerm: 0,
        utilityPenalty: 0,
        final: clamp(commercialBase, 0, 100)
      },
      industrial: {
        base: 50,
        zonePenalty: indZonePenalty,
        populationTerm: state.population * 0.15,
        jobsTerm: 0,
        utilityPenalty: 0,
        final: clamp(industrialBase, 0, 100)
      }
    }
  };
}
