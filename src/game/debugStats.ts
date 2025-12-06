import { BuildingStatus, getBuildingTemplate } from './buildings';
import { GameState, TileKind } from './gameState';
import { computeDemand } from './demand';
import { computeLabourStats, LabourStats } from './computeLabourStats';
import { ServiceId } from './services';

export interface DemandDetails {
  base: number;
  fillFraction: number;
  fillTerm: number;
    pendingZones: number;
    pendingPenaltyRaw: number;
    pendingPenaltyCapped: number;
    pendingPenaltyApplied: number;
    pressureRelief: number;
    labourTerm: number;
    workforceGap: number;
    workforceTerm: number;
    utilityPenalty: number;
    demandBeforeUtilities: number;
    floorApplied: boolean;
  seeded: boolean;
  final: number;
}

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
  let commercialJobCapacity = 0;
  let industrialJobCapacity = 0;
  let buildingPowerUse = 0;
  let buildingWaterUse = 0;
  let buildingWaterOutput = 0;
  let developedResidentialZones = 0;
  let developedCommercialZones = 0;
  let developedIndustrialZones = 0;
  const educationScore = state.education?.score ?? 0;
  const elementaryCoverage = state.education?.elementaryCoverage ?? 0;
  const highCoverage = state.education?.highCoverage ?? 0;

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
    if (template.jobsCapacity) {
      jobCapacity += template.jobsCapacity;
      if (template.tileKind === TileKind.Commercial) commercialJobCapacity += template.jobsCapacity;
      if (template.tileKind === TileKind.Industrial) industrialJobCapacity += template.jobsCapacity;
    }
  }

  const labourStats = computeLabourStats(state.population, populationCapacity, jobCapacity);
  const pendingResidentialZones = Math.max(0, residentialZones - developedResidentialZones);
  const pendingCommercialZones = Math.max(0, commercialZones - developedCommercialZones);
  const pendingIndustrialZones = Math.max(0, industrialZones - developedIndustrialZones);
  const fillResidential =
    populationCapacity > 0 ? Math.min(1, state.population / populationCapacity) : 0;
  const jobsInCommercial =
    jobCapacity > 0 ? (commercialJobCapacity / Math.max(jobCapacity, 1)) * state.jobs : 0;
  const jobsInIndustrial =
    jobCapacity > 0 ? (industrialJobCapacity / Math.max(jobCapacity, 1)) * state.jobs : 0;
  const fillCommercial =
    commercialJobCapacity > 0 ? Math.min(1, jobsInCommercial / commercialJobCapacity) : 1;
  const fillIndustrial =
    industrialJobCapacity > 0 ? Math.min(1, jobsInIndustrial / industrialJobCapacity) : 1;
  const workforceGap = Math.max(0, state.population - state.jobs);
  const jobsOverPopulation = Math.max(0, state.jobs - state.population);
  const utilityPenalty = state.utilities.power < 0 ? 15 : 0;
  const pendingPenaltyEnabled = state.settings?.pendingPenaltyEnabled ?? true;

  const seeded = state.population === 0 && state.jobs === 0;

  const residentialDemand = computeDemand({
    base: 70,
    fillFraction: fillResidential,
    workforceTerm: 0,
    labourTerm: labourStats.vacancyRate * 60 - labourStats.unemploymentRate * 80,
    pendingZones: pendingResidentialZones,
    pendingSlope: 0.45,
    utilityPenalty,
    seeded,
    seededValue: 50,
    pendingPenaltyEnabled
  });

  const commercialDemand = computeDemand({
    base: 50,
    fillFraction: fillCommercial,
    workforceTerm:
      labourStats.unemploymentRate * 30 +
      Math.min(1, state.population / Math.max(populationCapacity, 1)) * 20,
    labourTerm: 0,
    pendingZones: pendingCommercialZones,
    pendingSlope: 0.35,
    utilityPenalty: utilityPenalty * 0.5,
    seeded,
    seededValue: 30,
    pendingPenaltyEnabled
  });

  const industrialDemand = computeDemand({
    base: 55,
    fillFraction: fillIndustrial,
    workforceTerm:
      labourStats.unemploymentRate * 80 + Math.max(0, 0.95 - fillIndustrial) * 20,
    labourTerm: labourStats.vacancyRate * -5,
    pendingZones: pendingIndustrialZones,
    pendingSlope: 0.35,
    utilityPenalty: utilityPenalty * 0.5,
    seeded,
    seededValue: 30,
    pendingPenaltyEnabled
  });

  return {
    tick: state.tick,
    day: state.day,
    population: state.population,
    jobs: state.jobs,
    labour: labourStats,
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
    education: {
      score: educationScore,
      elementaryCoverage,
      highCoverage
    },
    demand: {
      residential: residentialDemand.value,
      commercial: commercialDemand.value,
      industrial: industrialDemand.value
    },
    demandDetails: {
      residential: {
        base: 70,
        fillFraction: residentialDemand.fillFraction,
        fillTerm: residentialDemand.fillTerm,
        pendingZones: residentialDemand.pendingZones,
        pendingPenaltyRaw: residentialDemand.pendingPenaltyRaw,
        pendingPenaltyCapped: residentialDemand.pendingPenaltyCapped,
        pendingPenaltyApplied: residentialDemand.pendingPenaltyApplied,
        pressureRelief: residentialDemand.pressureRelief,
        labourTerm: residentialDemand.labourTerm ?? 0,
        workforceGap: jobsOverPopulation,
        workforceTerm: residentialDemand.workforceTerm,
        utilityPenalty: residentialDemand.utilityPenalty,
        demandBeforeUtilities: residentialDemand.demandBeforeUtilities,
        floorApplied: residentialDemand.floorApplied,
        seeded,
        final: residentialDemand.value
      },
      commercial: {
        base: 50,
        fillFraction: commercialDemand.fillFraction,
        fillTerm: commercialDemand.fillTerm,
        pendingZones: commercialDemand.pendingZones,
        pendingPenaltyRaw: commercialDemand.pendingPenaltyRaw,
        pendingPenaltyCapped: commercialDemand.pendingPenaltyCapped,
        pendingPenaltyApplied: commercialDemand.pendingPenaltyApplied,
        pressureRelief: commercialDemand.pressureRelief,
        labourTerm: commercialDemand.labourTerm ?? 0,
        workforceGap,
        workforceTerm: commercialDemand.workforceTerm,
        utilityPenalty: commercialDemand.utilityPenalty,
        demandBeforeUtilities: commercialDemand.demandBeforeUtilities,
        floorApplied: commercialDemand.floorApplied,
        seeded,
        final: commercialDemand.value
      },
      industrial: {
        base: 55,
        fillFraction: industrialDemand.fillFraction,
        fillTerm: industrialDemand.fillTerm,
        pendingZones: industrialDemand.pendingZones,
        pendingPenaltyRaw: industrialDemand.pendingPenaltyRaw,
        pendingPenaltyCapped: industrialDemand.pendingPenaltyCapped,
        pendingPenaltyApplied: industrialDemand.pendingPenaltyApplied,
        pressureRelief: industrialDemand.pressureRelief,
        labourTerm: industrialDemand.labourTerm ?? 0,
        workforceGap,
        workforceTerm: industrialDemand.workforceTerm,
        utilityPenalty: industrialDemand.utilityPenalty,
        demandBeforeUtilities: industrialDemand.demandBeforeUtilities,
        floorApplied: industrialDemand.floorApplied,
        seeded,
        final: industrialDemand.value
      }
    }
  };
}
