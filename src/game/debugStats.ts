import { BuildingStatus, getBuildingTemplate } from './buildings';
import { GameState, TileKind } from './gameState';

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

export interface DemandDetails {
  base: number;
  fillFraction: number;
  fillTerm: number;
  pendingZones: number;
  pendingPenalty: number;
  workforceGap: number;
  workforceTerm: number;
  utilityPenalty: number;
  seeded: boolean;
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
  let developedResidentialZones = 0;
  let developedCommercialZones = 0;
  let developedIndustrialZones = 0;

  const pumpTemplate = getBuildingTemplate(TileKind.WaterPump);

  for (const tile of state.tiles) {
    if (tile.kind === TileKind.Residential) {
      residentialZones++;
      if (tile.buildingId !== undefined) developedResidentialZones++;
    }
    if (tile.kind === TileKind.Commercial) {
      commercialZones++;
      if (tile.buildingId !== undefined) developedCommercialZones++;
    }
    if (tile.kind === TileKind.Industrial) {
      industrialZones++;
      if (tile.buildingId !== undefined) developedIndustrialZones++;
    }

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

  const pendingResidentialZones = Math.max(0, residentialZones - developedResidentialZones);
  const pendingCommercialZones = Math.max(0, commercialZones - developedCommercialZones);
  const pendingIndustrialZones = Math.max(0, industrialZones - developedIndustrialZones);
  const cappedResidentialFill =
    populationCapacity > 0 ? Math.min(1, state.population / populationCapacity) : 0;
  const cappedJobFill = jobCapacity > 0 ? Math.min(1, state.jobs / jobCapacity) : 0;
  const workforceGap = Math.max(0, state.population - state.jobs);
  const jobsOverPopulation = Math.max(0, state.jobs - state.population);
  const utilityPenalty = state.utilities.power < 0 ? 15 : 0;
  const pendingPenaltyEnabled = state.settings?.pendingPenaltyEnabled ?? true;

  const seeded = state.population === 0 && state.jobs === 0;

  const residentialFillTerm = 70 * (1 - cappedResidentialFill);
  const residentialPendingPenalty = pendingPenaltyEnabled ? pendingResidentialZones * 1.2 : 0;
  const residentialValue = seeded
    ? 50
    : clamp(residentialFillTerm + jobsOverPopulation * 0.6 - residentialPendingPenalty - utilityPenalty, 0, 100);

  const commercialFillTerm = 50 * (1 - cappedJobFill);
  const commercialPendingPenalty = pendingPenaltyEnabled ? pendingCommercialZones * 1.1 : 0;
  const commercialValue = seeded
    ? 30
    : clamp(
        commercialFillTerm + workforceGap * 0.2 - commercialPendingPenalty - utilityPenalty * 0.5,
        0,
        100
      );

  const industrialFillTerm = 55 * (1 - cappedJobFill);
  const industrialPendingPenalty = pendingPenaltyEnabled ? pendingIndustrialZones * 1.1 : 0;
  const industrialValue = seeded
    ? 30
    : clamp(
        industrialFillTerm + workforceGap * 0.25 - industrialPendingPenalty - utilityPenalty * 0.5,
        0,
        100
      );

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
      residential: residentialValue,
      commercial: commercialValue,
      industrial: industrialValue
    },
    demandDetails: {
      residential: {
        base: 70,
        fillFraction: cappedResidentialFill,
        fillTerm: residentialFillTerm,
        pendingZones: pendingResidentialZones,
        pendingPenalty: residentialPendingPenalty,
        workforceGap: jobsOverPopulation,
        workforceTerm: jobsOverPopulation * 0.6,
        utilityPenalty,
        seeded,
        final: residentialValue
      },
      commercial: {
        base: 50,
        fillFraction: cappedJobFill,
        fillTerm: commercialFillTerm,
        pendingZones: pendingCommercialZones,
        pendingPenalty: commercialPendingPenalty,
        workforceGap,
        workforceTerm: workforceGap * 0.2,
        utilityPenalty: utilityPenalty * 0.5,
        seeded,
        final: commercialValue
      },
      industrial: {
        base: 55,
        fillFraction: cappedJobFill,
        fillTerm: industrialFillTerm,
        pendingZones: pendingIndustrialZones,
        pendingPenalty: industrialPendingPenalty,
        workforceGap,
        workforceTerm: workforceGap * 0.25,
        utilityPenalty: utilityPenalty * 0.5,
        seeded,
        final: industrialValue
      }
    }
  };
}
