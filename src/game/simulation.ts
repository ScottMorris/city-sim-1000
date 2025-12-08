import type { GameState } from './gameState';
import { getTile, TileKind } from './gameState';
import { BASE_INCOME, MAINTENANCE, POWER_PLANT_CONFIGS } from './constants';
import { BuildingStatus } from './buildings/state';
import { BuildingCategory, getBuildingTemplate } from './buildings/templates';
import { listPowerPlants, placeBuilding, updateBuildingStates } from './buildings/manager';
import { recomputePowerNetwork } from './utilities/power';
import { recomputeWaterNetwork } from './utilities/water';
import {
  getOrthogonalNeighbourCoords,
  hasRoadAccess,
  isFrontierZone,
  tileHasPower,
  zoneHasRoadPath
} from './adjacency';
import { DAYS_PER_MONTH } from './time';
import { recordDailyBudget } from './economy';
import { computeDemand } from './demand';
import { computeLabourStats } from './computeLabourStats';
import { recomputeEducation } from './education';
import { ServiceId } from './services';

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
  private readonly waterEnabled = true;
  private speedMultiplier = 1;
  private notify?: (alert: SimulationAlert) => void;
  private powerDeficitActive = false;
  private waterDeficitActive = false;
  private readonly decayConfig = {
    demandLowThreshold: 5,
    happinessThreshold: 0.4,
    troubleIncrement: 1,
    troublePowerPenalty: 3,
    troubleDecay: 2,
    troubleAbandonThreshold: 12
  };

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
    if (this.waterEnabled) recomputeWaterNetwork(this.state);
    this.spawnZoneBuildings();
    updateBuildingStates(this.state);
    recomputePowerNetwork(this.state);
    if (this.waterEnabled) recomputeWaterNetwork(this.state);
    this.state.education = recomputeEducation(this.state);

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
    let commercialJobCapacity = 0;
    let industrialJobCapacity = 0;
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

      if (tile.underground) {
        const uUpkeep = MAINTENANCE[tile.underground];
        if (uUpkeep) {
          maintenance += uUpkeep;
          if (tile.underground === TileKind.WaterPipe) maintenancePipes += uUpkeep;
        }
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
        if (template.jobsCapacity) {
          jobCapacity += template.jobsCapacity;
          if (template.tileKind === TileKind.Commercial) commercialJobCapacity += template.jobsCapacity;
          if (template.tileKind === TileKind.Industrial) industrialJobCapacity += template.jobsCapacity;
        }
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

    const fillResidential =
      populationCapacity > 0 ? Math.min(1, this.state.population / populationCapacity) : 0;
    const jobsInCommercial =
      jobCapacity > 0 ? (commercialJobCapacity / Math.max(jobCapacity, 1)) * this.state.jobs : 0;
    const jobsInIndustrial =
      jobCapacity > 0 ? (industrialJobCapacity / Math.max(jobCapacity, 1)) * this.state.jobs : 0;
    const fillCommercial =
      commercialJobCapacity > 0 ? Math.min(1, jobsInCommercial / commercialJobCapacity) : 1;
    const fillIndustrial =
      industrialJobCapacity > 0 ? Math.min(1, jobsInIndustrial / industrialJobCapacity) : 1;
    const pendingResidentialZones = Math.max(0, residentialZones - developedResidentialZones);
    const pendingCommercialZones = Math.max(0, commercialZones - developedCommercialZones);
    const pendingIndustrialZones = Math.max(0, industrialZones - developedIndustrialZones);
    const utilityPenalty = (this.state.utilities.power < 0 ? 15 : 0) + (this.waterEnabled && this.state.utilities.water < 0 ? 15 : 0);
    const pendingPenaltyEnabled = this.state.settings?.pendingPenaltyEnabled ?? true;
    const labourStats = computeLabourStats(this.state.population, populationCapacity, jobCapacity);
    const seeded = this.state.population === 0 && this.state.jobs === 0;
    const education = this.state.education;
    const educationScore = education?.score ?? 0;
    const educationDemandDelta = educationScore * 4 - (1 - educationScore) * 12;
    const workforcePenalty = (1 - (education?.highCoverage ?? 0)) * 20;

    const residentialDemand = computeDemand({
      base: 70, // fill coefficient for residential slots
      fillFraction: fillResidential,
      workforceTerm: 0,
      labourTerm: labourStats.vacancyRate * 60 - labourStats.unemploymentRate * 80 + educationDemandDelta,
      pendingZones: pendingResidentialZones,
      pendingSlope: 0.45,
      utilityPenalty,
      seeded,
      seededValue: 50,
      pendingPenaltyEnabled
    });
    const commercialDemand = computeDemand({
      base: 50, // fill coefficient for commercial job slots
      fillFraction: fillCommercial,
      workforceTerm:
        labourStats.unemploymentRate * 30 +
        Math.min(1, this.state.population / Math.max(populationCapacity, 1)) * 20 -
        workforcePenalty * 0.6,
      labourTerm: 0,
      pendingZones: pendingCommercialZones,
      pendingSlope: 0.35,
      utilityPenalty: utilityPenalty * 0.5,
      seeded,
      seededValue: 30,
      pendingPenaltyEnabled
    });
    const industrialDemand = computeDemand({
      base: 55, // fill coefficient for industrial job slots
      fillFraction: fillIndustrial,
      // Unemployment pulls industry, and slightly underfilled tiles push it; vacancy cools but softly.
      workforceTerm:
        labourStats.unemploymentRate * 80 +
        Math.max(0, 0.95 - fillIndustrial) * 20 -
        workforcePenalty,
      labourTerm: labourStats.vacancyRate * -5,
      pendingZones: pendingIndustrialZones,
      pendingSlope: 0.35,
      utilityPenalty: utilityPenalty * 0.5,
      seeded,
      seededValue: 30,
      pendingPenaltyEnabled,
      floorOverride: fillIndustrial >= 0.95 ? 5 : undefined
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
    const residentialCandidates: Array<{ x: number; y: number }> = [];
    const commercialCandidates: Array<{ x: number; y: number }> = [];
    const industrialCandidates: Array<{ x: number; y: number }> = [];

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

        // Keep existing road access gating.
        const hasRoadChain = zoneHasRoadPath(this.state, x, y);
        const frontierAllowed = isFrontierZone(this.state, x, y);
        if (!hasRoadAccess(this.state, x, y) && !hasRoadChain && !frontierAllowed) {
          this.zoneGrowthTimers.delete(y * this.state.width + x);
          continue;
        }

        const powerAvailable = this.state.utilities.powerProduced > 0;
        if (powerAvailable && !tileHasPower(this.state, x, y)) {
          this.zoneGrowthTimers.delete(y * this.state.width + x);
          continue;
        }

        // Preserve the per-tile growth delay before a lot is eligible.
        const idx = y * this.state.width + x;
        const currentTimer = this.zoneGrowthTimers.get(idx) ?? this.zoneGrowthDelayTicks;
        if (currentTimer > 1) {
          this.zoneGrowthTimers.set(idx, currentTimer - 1);
          continue;
        }
        this.zoneGrowthTimers.delete(idx);

        if (tile.kind === TileKind.Residential) residentialCandidates.push({ x, y });
        if (tile.kind === TileKind.Commercial) commercialCandidates.push({ x, y });
        if (tile.kind === TileKind.Industrial) industrialCandidates.push({ x, y });
      }
    }

    // Early-out if power is negative; growth is blocked.
    if (this.state.utilities.power < 0 || (this.waterEnabled && this.state.utilities.water < 0)) return;

    this.applyZoneGrowthForType(TileKind.Residential, this.state.demand.residential, residentialCandidates);
    this.applyZoneGrowthForType(TileKind.Commercial, this.state.demand.commercial, commercialCandidates);
    this.applyZoneGrowthForType(TileKind.Industrial, this.state.demand.industrial, industrialCandidates);
  }

  /**
   * Applies wave-like growth for a single zone type using demand as both
   * a cap and a probability driver. Demand is in 0–100; the cap and probability
   * scale modestly so growth arrives in small batches instead of instantly.
   */
  private applyZoneGrowthForType(
    kind: TileKind,
    demand: number,
    candidates: Array<{ x: number; y: number }>
  ) {
    if (candidates.length === 0) return;
    const debugWave = typeof process !== 'undefined' && process?.env?.WAVE_DEBUG === '1';

    // Cap how many lots can start growing this tick. At demand 0 this is 1; it rises gently
    // with demand and is hard-capped to avoid big bursts.
    const maxNewLots = clamp(1 + Math.floor(demand / 40), 0, 4);
    if (maxNewLots <= 0) return;

    // Growth chance per candidate. Demand below ~20 yields ~0 probability; high demand is near 1.
    const pGrow = demand >= 50 ? 1 : demand <= 0 ? 0 : clamp((demand + 20) / 120, 0, 1);
    if (debugWave) {
      console.log(`Grow ${kind}: demand=${demand.toFixed(1)} candidates=${candidates.length} max=${maxNewLots} p=${pGrow.toFixed(2)}`);
    }

    // Shuffle candidates to avoid biasing toward map order.
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    let grown = 0;
    for (const { x, y } of candidates) {
      if (grown >= maxNewLots) break;
      if (Math.random() > pGrow) continue;
      const template = getBuildingTemplate(kind);
      if (!template) continue;
      const result = placeBuilding(this.state, template, x, y);
      if (result.success) grown++;
    }
  }

  /**
   * Slow decay loop: when demand is very low, a building lacks power, or happiness is poor,
   * increment trouble ticks. Otherwise bleed them down. Abandon when the threshold is exceeded,
   * freeing capacity and letting demand recover. Decay is intentionally slower than growth.
   */
  private applyBuildingDecay() {
    const { demandLowThreshold, happinessThreshold, troubleIncrement, troublePowerPenalty, troubleDecay, troubleAbandonThreshold } =
      this.decayConfig;

    for (const building of this.state.buildings.slice()) {
      const template = getBuildingTemplate(building.templateId);
      if (!template) continue;
      if (template.category !== BuildingCategory.Zone) continue;

      const tile = getTile(this.state, building.origin.x, building.origin.y);
      if (!tile) continue;

      let trouble = building.state.troubleTicks ?? 0;
      const demand = this.getDemandForZone(template.tileKind);
      const noPower = building.state.status === BuildingStatus.InactiveNoPower;
      const unhappy = tile.happiness < happinessThreshold;
      const servedElementary = tile.services.served[ServiceId.EducationElementary];
      const servedHigh = tile.services.served[ServiceId.EducationHigh];
      const needsElementary = template.tileKind === TileKind.Residential;
      const needsHigh =
        template.tileKind === TileKind.Commercial ||
        template.tileKind === TileKind.Industrial ||
        template.tileKind === TileKind.Residential;
      const educationUnserved =
        (needsElementary && !servedElementary) || (needsHigh && !servedHigh);

      // Pressure from low demand combined with bad services/power; avoid punishing stable equilibrium.
      const lowDemand = demand < demandLowThreshold;
      if (lowDemand && (unhappy || noPower)) trouble += troubleIncrement;
      if (unhappy && noPower) trouble += troubleIncrement; // stack when both are bad
      if (noPower) trouble += troublePowerPenalty;
      if (educationUnserved) trouble += troubleIncrement * 0.5;

      // If conditions are fine, bleed trouble down slowly.
      if (!lowDemand && !unhappy && !noPower) {
        trouble = Math.max(0, trouble - troubleDecay);
        if (!educationUnserved) trouble = Math.max(0, trouble - troubleDecay * 0.25);
      }

      building.state.troubleTicks = trouble;

      if (trouble >= troubleAbandonThreshold) {
        this.abandonZoneBuilding(building, tile);
      }
    }
  }

  /**
   * Clears a zone building when decay wins: remove the building instance and leave the zoned tile
   * ready to regrow. Capacity drops to 0, which naturally nudges demand upward again.
   */
  private abandonZoneBuilding(building: import('./buildings/state').BuildingInstance, tile: import('./gameState').Tile) {
    // Remove building instance
    this.state.buildings = this.state.buildings.filter((b) => b.id !== building.id);
    // Clear building references but keep the zone kind so it can regrow.
    tile.buildingId = undefined;
    tile.powerPlantType = undefined;
    tile.powerPlantId = undefined;
    tile.abandoned = true;
    tile.happiness = Math.max(0.1, tile.happiness - 0.1);
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
