import type { GameState } from './gameState';
import { TileKind } from './gameState';
import { BASE_INCOME, MAINTENANCE, POWER_PLANT_CONFIGS } from './constants';
import {
  BuildingStatus,
  BuildingCategory,
  getBuildingTemplate,
  listPowerPlants,
  placeBuilding,
  updateBuildingStates
} from './buildings';
import { recomputePowerNetwork } from './power';
import {
  getOrthogonalNeighbourCoords,
  hasRoadAccess,
  isFrontierZone,
  zoneHasRoadPath
} from './adjacency';
import { DAYS_PER_MONTH } from './time';
import { recordDailyBudget } from './budget';
import { computeDemand } from './demand';
import { computeLabourStats } from './computeLabourStats';

export interface SimulationConfig {
  ticksPerSecond: number;
  notify?: (alert: SimulationAlert) => void;
}

export type SimulationAlertSeverity = 'info' | 'warning' | 'success';

export interface SimulationAlert {
  id: string;
  message: string;
  severity?: SimulationAlertSeverity;
  sticky?: boolean;
}

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

export class Simulation {
  private state: GameState;
  private accumulator = 0;
  private readonly dt: number;
  private readonly zoneGrowthDelayTicks: number;
  private zoneGrowthTimers = new Map<number, number>();
  private readonly waterEnabled = false;
  private speedMultiplier = 1;
  private notify?: (alert: SimulationAlert) => void;
  private powerDeficitActive = false;
  private waterDeficitActive = false;

  constructor(state: GameState, config: SimulationConfig) {
    this.state = state;
    this.dt = 1 / config.ticksPerSecond;
    this.zoneGrowthDelayTicks = Math.max(1, Math.round(config.ticksPerSecond * 2)); // ~2s delay
    this.notify = config.notify;
  }

  setState(state: GameState) {
    this.state = state;
    this.zoneGrowthTimers = new Map();
    this.accumulator = 0;
    this.powerDeficitActive = false;
    this.waterDeficitActive = false;
  }

  setSpeed(multiplier: number) {
    this.speedMultiplier = Math.max(0.1, multiplier);
  }

  update(elapsedSeconds: number) {
    this.accumulator += elapsedSeconds * this.speedMultiplier;
    const epsilon = 1e-9;
    while (this.accumulator + epsilon >= this.dt) {
      this.tick();
      this.accumulator -= this.dt;
    }
  }

  private tick() {
    this.state.tick++;
    this.state.day += this.dt / 1.5;

    recomputePowerNetwork(this.state);
    this.spawnZoneBuildings();
    updateBuildingStates(this.state);
    recomputePowerNetwork(this.state);

    let residentialZones = 0;
    let commercialZones = 0;
    let industrialZones = 0;
    let developedResidentialZones = 0;
    let developedCommercialZones = 0;
    let developedIndustrialZones = 0;
    let maintenance = 0;
    let maintenanceRoads = 0;
    let maintenanceRail = 0;
    let maintenancePowerLines = 0;
    let maintenancePipes = 0;
    let buildingMaintenance = 0;
    let buildingMaintenancePower = 0;
    let buildingMaintenanceCivic = 0;
    let buildingMaintenanceZones = 0;
    const powerMaintenanceByType: Record<string, number> = {};
    const civicMaintenanceByType: Record<string, number> = {};
    const zoneMaintenanceByType: Record<string, number> = {};
    let buildingWaterOutput = 0;
    let buildingPowerUse = 0;
    let buildingWaterUse = 0;
    let populationCapacity = 0;
    let jobCapacity = 0;
    const pumpTemplate = getBuildingTemplate(TileKind.WaterPump);
    const parkTemplate = getBuildingTemplate(TileKind.Park);

    for (const tile of this.state.tiles) {
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
      const upkeep = MAINTENANCE[tile.kind];
      if (upkeep && tile.buildingId === undefined) {
        maintenance += upkeep;
        if (tile.kind === TileKind.Road) maintenanceRoads += upkeep;
        if (tile.kind === TileKind.Rail) maintenanceRail += upkeep;
        if (tile.kind === TileKind.PowerLine) maintenancePowerLines += upkeep;
        if (tile.kind === TileKind.WaterPipe) maintenancePipes += upkeep;
      }

      if (tile.buildingId === undefined && tile.kind === TileKind.WaterPump && pumpTemplate) {
        const active = pumpTemplate.requiresPower === false ? true : tile.powered;
        if (pumpTemplate.maintenance) {
          buildingMaintenance += pumpTemplate.maintenance;
          buildingMaintenanceCivic += pumpTemplate.maintenance;
          civicMaintenanceByType[pumpTemplate.id] =
            (civicMaintenanceByType[pumpTemplate.id] ?? 0) + pumpTemplate.maintenance;
        }
        if (this.waterEnabled && active && pumpTemplate.waterOutput)
          buildingWaterOutput += pumpTemplate.waterOutput;
      }
      if (tile.buildingId === undefined && tile.kind === TileKind.Park && parkTemplate) {
        if (parkTemplate.maintenance) {
          buildingMaintenance += parkTemplate.maintenance;
          buildingMaintenanceCivic += parkTemplate.maintenance;
          civicMaintenanceByType[parkTemplate.id] =
            (civicMaintenanceByType[parkTemplate.id] ?? 0) + parkTemplate.maintenance;
        }
      }
    }

    for (const building of this.state.buildings) {
      const template = getBuildingTemplate(building.templateId);
      if (!template) continue;
      if (template.maintenance) {
        buildingMaintenance += template.maintenance;
        if (template.category === BuildingCategory.Power) buildingMaintenancePower += template.maintenance;
        if (template.category === BuildingCategory.Civic) buildingMaintenanceCivic += template.maintenance;
        if (template.category === BuildingCategory.Zone) buildingMaintenanceZones += template.maintenance;
        if (template.category === BuildingCategory.Power && template.power?.type) {
          powerMaintenanceByType[template.power.type] =
            (powerMaintenanceByType[template.power.type] ?? 0) + template.maintenance;
        }
        if (template.category === BuildingCategory.Civic) {
          civicMaintenanceByType[template.id] =
            (civicMaintenanceByType[template.id] ?? 0) + template.maintenance;
        }
        if (template.category === BuildingCategory.Zone) {
          zoneMaintenanceByType[template.tileKind] =
            (zoneMaintenanceByType[template.tileKind] ?? 0) + template.maintenance;
        }
      }
      const isActive = building.state.status === BuildingStatus.Active;
      if (isActive) {
        if (this.waterEnabled && template.waterOutput) buildingWaterOutput += template.waterOutput;
        if (template.powerUse) buildingPowerUse += template.powerUse;
        if (this.waterEnabled && template.waterUse) buildingWaterUse += template.waterUse;
        if (template.populationCapacity) populationCapacity += template.populationCapacity;
        if (template.jobsCapacity) jobCapacity += template.jobsCapacity;
      }
    }

    const plants = listPowerPlants(this.state);
    for (const plant of plants) {
      if (plant.instance) continue;
      const templateMaintenance = plant.template?.maintenance;
      const fallbackMaintenance =
        plant.type && POWER_PLANT_CONFIGS[plant.type]
          ? POWER_PLANT_CONFIGS[plant.type].maintenancePerDay
          : 0;
      const maintenanceCost = templateMaintenance ?? fallbackMaintenance ?? 0;
      if (maintenanceCost) {
        buildingMaintenance += maintenanceCost;
        buildingMaintenancePower += maintenanceCost;
        if (plant.type) {
          powerMaintenanceByType[plant.type] =
            (powerMaintenanceByType[plant.type] ?? 0) + maintenanceCost;
        }
      }
    }

    const desiredPop = Math.min(
      populationCapacity,
      this.state.population + this.state.demand.residential * 0.05
    );
    const desiredJobs = Math.min(
      jobCapacity,
      this.state.jobs + (this.state.demand.commercial + this.state.demand.industrial) * 0.05
    );
    const growth = clamp(desiredPop - this.state.population, -2, 2);
    const jobGrowth = clamp(desiredJobs - this.state.jobs, -2, 2);
    this.state.population = clamp(this.state.population + growth, 0, populationCapacity);
    this.state.jobs = clamp(this.state.jobs + jobGrowth, 0, jobCapacity);

    const powerSupply = this.state.utilities.powerProduced;
    const waterSupply = this.waterEnabled ? buildingWaterOutput : 1e6;
    const powerUse = buildingPowerUse;
    const waterUse = this.waterEnabled ? buildingWaterUse : 0;
    this.state.utilities.powerUsed = powerUse;
    this.state.utilities.power = powerSupply - powerUse;
    this.state.utilities.water = waterSupply - waterUse;
    this.handleResourceAlerts(this.state.utilities.power, this.state.utilities.water);

    const cappedResidentialFill =
      populationCapacity > 0 ? Math.min(1, this.state.population / populationCapacity) : 0;
    const cappedJobFill = jobCapacity > 0 ? Math.min(1, this.state.jobs / jobCapacity) : 0;
    const pendingResidentialZones = Math.max(0, residentialZones - developedResidentialZones);
    const pendingCommercialZones = Math.max(0, commercialZones - developedCommercialZones);
    const pendingIndustrialZones = Math.max(0, industrialZones - developedIndustrialZones);
    const workforceGap = Math.max(0, this.state.population - this.state.jobs);
    const jobsOverPopulation = Math.max(0, this.state.jobs - this.state.population);
    const utilityPenalty = this.state.utilities.power < 0 ? 15 : 0;
    const pendingPenaltyEnabled = this.state.settings?.pendingPenaltyEnabled ?? true;
    const labourStats = computeLabourStats(this.state.population, populationCapacity, jobCapacity);
    const seeded = this.state.population === 0 && this.state.jobs === 0;

    const residentialDemand = computeDemand({
      base: 70,
      fillFraction: cappedResidentialFill,
      workforceTerm: jobsOverPopulation * 0.6,
      labourTerm: labourStats.vacancyRate * 20 - labourStats.unemploymentRate * 10,
      pendingZones: pendingResidentialZones,
      pendingSlope: 0.45,
      utilityPenalty,
      seeded,
      seededValue: 50,
      pendingPenaltyEnabled
    });
    const commercialDemand = computeDemand({
      base: 50,
      fillFraction: cappedJobFill,
      workforceTerm: workforceGap * 0.2,
      labourTerm: labourStats.unemploymentRate * 15 - labourStats.vacancyRate * 10,
      pendingZones: pendingCommercialZones,
      pendingSlope: 0.35,
      utilityPenalty: utilityPenalty * 0.5,
      seeded,
      seededValue: 30,
      pendingPenaltyEnabled
    });
    const industrialDemand = computeDemand({
      base: 55,
      fillFraction: cappedJobFill,
      workforceTerm: workforceGap * 0.25,
      labourTerm: labourStats.unemploymentRate * 18 - labourStats.vacancyRate * 10,
      pendingZones: pendingIndustrialZones,
      pendingSlope: 0.35,
      utilityPenalty: utilityPenalty * 0.5,
      seeded,
      seededValue: 30,
      pendingPenaltyEnabled
    });

    this.state.demand.residential = residentialDemand.value;
    this.state.demand.commercial = commercialDemand.value;
    this.state.demand.industrial = industrialDemand.value;

    const revenueBase = BASE_INCOME;
    const revenuePopulation = this.state.population * 1.5;
    const revenueCommercial = commercialZones * 6;
    const revenueIndustrial = industrialZones * 8;
    const revenue = revenueBase + revenuePopulation + revenueCommercial + revenueIndustrial;
    const expensesTransport = maintenance;
    const expensesBuildings = buildingMaintenance;
    const expenses = expensesTransport + expensesBuildings;
    const net = revenue - expenses;
    const netPerDay = net * 0.2 * 1.5;
    const netPerMonth = netPerDay * DAYS_PER_MONTH;
    this.state.budget = {
      revenue,
      expenses,
      net,
      netPerDay,
      netPerMonth,
      breakdown: {
        revenue: {
          base: revenueBase,
          residents: revenuePopulation,
          commercial: revenueCommercial,
          industrial: revenueIndustrial
        },
        expenses: {
          transport: expensesTransport,
          buildings: expensesBuildings
        },
        details: {
          transport: {
            roads: maintenanceRoads,
            rail: maintenanceRail,
            powerLines: maintenancePowerLines,
            waterPipes: maintenancePipes
          },
          buildings: {
            power: buildingMaintenancePower,
            civic: buildingMaintenanceCivic,
            zones: buildingMaintenanceZones,
            powerByType: powerMaintenanceByType,
            civicByType: civicMaintenanceByType,
            zonesByType: zoneMaintenanceByType
          }
        }
      }
    };
    recordDailyBudget(this.state);
    this.state.money = Math.max(0, this.state.money + netPerDay * (this.dt / 1.5));
  }

  private spawnZoneBuildings() {
    for (let y = 0; y < this.state.height; y++) {
      for (let x = 0; x < this.state.width; x++) {
        const tile = this.state.tiles[y * this.state.width + x];
        if (tile.buildingId !== undefined) continue;
        if (
          tile.kind !== TileKind.Residential &&
          tile.kind !== TileKind.Commercial &&
          tile.kind !== TileKind.Industrial
        ) {
          continue;
        }
        const hasRoadChain = zoneHasRoadPath(this.state, x, y);
        const frontierAllowed = isFrontierZone(this.state, x, y);
        if (!hasRoadAccess(this.state, x, y) && !hasRoadChain && !frontierAllowed) {
          this.zoneGrowthTimers.delete(y * this.state.width + x);
          continue;
        }
        const idx = y * this.state.width + x;
        const currentTimer = this.zoneGrowthTimers.get(idx) ?? this.zoneGrowthDelayTicks;
        if (currentTimer > 1) {
          this.zoneGrowthTimers.set(idx, currentTimer - 1);
          continue;
        }
        this.zoneGrowthTimers.delete(idx);
        const demand = this.getDemandForZone(tile.kind);
        if (demand <= 5) continue;
        if (this.state.utilities.power < 0) continue;
        const template = getBuildingTemplate(tile.kind);
        if (!template) continue;
        const result = placeBuilding(this.state, template, x, y);
        if (!result.success) continue;
      }
    }
  }

  private getDemandForZone(kind: TileKind): number {
    if (kind === TileKind.Residential) return this.state.demand.residential;
    if (kind === TileKind.Commercial) return this.state.demand.commercial;
    if (kind === TileKind.Industrial) return this.state.demand.industrial;
    return 0;
  }

  private handleResourceAlerts(powerBalance: number, waterBalance: number) {
    if (!this.notify) return;

    if (powerBalance < 0 && !this.powerDeficitActive) {
      this.powerDeficitActive = true;
      this.notify({
        id: 'power-deficit',
        message: 'Power deficit detected. Build more plants or reduce demand to restore growth.',
        severity: 'warning',
        sticky: true
      });
    } else if (powerBalance >= 0 && this.powerDeficitActive) {
      this.powerDeficitActive = false;
      this.notify({
        id: 'power-deficit',
        message: 'Power restored. Zones can grow again.',
        severity: 'success',
        sticky: false
      });
    }

    if (!this.waterEnabled) return;
    if (waterBalance < 0 && !this.waterDeficitActive) {
      this.waterDeficitActive = true;
      this.notify({
        id: 'water-deficit',
        message: 'Water deficit detected. Add pumps/towers or cut usage.',
        severity: 'warning',
        sticky: true
      });
    } else if (waterBalance >= 0 && this.waterDeficitActive) {
      this.waterDeficitActive = false;
      this.notify({
        id: 'water-deficit',
        message: 'Water restored. Supply is stable again.',
        severity: 'success',
        sticky: false
      });
    }
  }
}
