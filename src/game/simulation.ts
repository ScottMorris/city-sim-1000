import type { GameState } from './gameState';
import { TileKind } from './gameState';
import { BASE_INCOME, MAINTENANCE, POWER_PLANT_CONFIGS } from './constants';
import {
  BuildingStatus,
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

export interface SimulationConfig {
  ticksPerSecond: number;
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

  constructor(state: GameState, config: SimulationConfig) {
    this.state = state;
    this.dt = 1 / config.ticksPerSecond;
    this.zoneGrowthDelayTicks = Math.max(1, Math.round(config.ticksPerSecond * 2)); // ~2s delay
  }

  update(elapsedSeconds: number) {
    this.accumulator += elapsedSeconds;
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
    let maintenance = 0;
    let buildingMaintenance = 0;
    let buildingWaterOutput = 0;
    let buildingPowerUse = 0;
    let buildingWaterUse = 0;
    let populationCapacity = 0;
    let jobCapacity = 0;
    const pumpTemplate = getBuildingTemplate(TileKind.WaterPump);
    const parkTemplate = getBuildingTemplate(TileKind.Park);

    for (const tile of this.state.tiles) {
      if (tile.kind === TileKind.Residential) residentialZones++;
      if (tile.kind === TileKind.Commercial) commercialZones++;
      if (tile.kind === TileKind.Industrial) industrialZones++;
      const upkeep = MAINTENANCE[tile.kind];
      if (upkeep && tile.buildingId === undefined) maintenance += upkeep;

      if (tile.buildingId === undefined && tile.kind === TileKind.WaterPump && pumpTemplate) {
        const active = pumpTemplate.requiresPower === false ? true : tile.powered;
        if (pumpTemplate.maintenance) buildingMaintenance += pumpTemplate.maintenance;
        if (this.waterEnabled && active && pumpTemplate.waterOutput)
          buildingWaterOutput += pumpTemplate.waterOutput;
      }
      if (tile.buildingId === undefined && tile.kind === TileKind.Park && parkTemplate) {
        if (parkTemplate.maintenance) buildingMaintenance += parkTemplate.maintenance;
      }
    }

    for (const building of this.state.buildings) {
      const template = getBuildingTemplate(building.templateId);
      if (!template) continue;
      if (template.maintenance) buildingMaintenance += template.maintenance;
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

    this.state.demand.residential = clamp(
      60 - residentialZones * 2 + Math.max(0, this.state.jobs - this.state.population),
      0,
      100
    );
    this.state.demand.commercial = clamp(
      50 - commercialZones * 3 + this.state.population * 0.2,
      0,
      100
    );
    this.state.demand.industrial = clamp(
      50 - industrialZones * 3 + this.state.population * 0.15,
      0,
      100
    );

    const utilityPenalty = this.state.utilities.power < 0 ? 15 : 0;
    this.state.demand.residential = clamp(this.state.demand.residential - utilityPenalty, 0, 100);

    const revenue =
      BASE_INCOME + this.state.population * 1.5 + commercialZones * 6 + industrialZones * 8;
    const expenses = maintenance + buildingMaintenance;
    this.state.money = Math.max(0, this.state.money + (revenue - expenses) * this.dt * 0.2);
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
}
