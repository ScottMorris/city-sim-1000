import type { GameState } from './gameState';
import { TileKind } from './gameState';
import { BASE_INCOME, MAINTENANCE, POWER_PLANT_CONFIGS } from './constants';
import { listPowerPlants, updateBuildingStates } from './buildings';
import { recomputePowerNetwork } from './power';

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

  constructor(state: GameState, config: SimulationConfig) {
    this.state = state;
    this.dt = 1 / config.ticksPerSecond;
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

    updateBuildingStates(this.state);

    let residential = 0;
    let commercial = 0;
    let industrial = 0;
    let pumps = 0;
    let maintenance = 0;
    let plantMaintenance = 0;

    for (const tile of this.state.tiles) {
      if (tile.kind === TileKind.Residential) residential++;
      if (tile.kind === TileKind.Commercial) commercial++;
      if (tile.kind === TileKind.Industrial) industrial++;
      if (tile.kind === TileKind.WaterPump) pumps++;
      const upkeep = MAINTENANCE[tile.kind];
      if (upkeep) maintenance += upkeep;
    }

    const plants = listPowerPlants(this.state);
    for (const plant of plants) {
      const templateMaintenance = plant.template?.maintenance;
      const fallbackMaintenance =
        plant.type && POWER_PLANT_CONFIGS[plant.type]
          ? POWER_PLANT_CONFIGS[plant.type].maintenancePerDay
          : 0;
      const maintenanceCost = templateMaintenance ?? fallbackMaintenance ?? 0;
      // v1: maintenance is owed regardless of active state
      if (maintenanceCost) {
        plantMaintenance += maintenanceCost;
      }
    }

    const populationCapacity = residential * 14;
    const jobCapacity = commercial * 8 + industrial * 12;
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

    recomputePowerNetwork(this.state);

    const powerSupply = this.state.utilities.powerProduced;
    const waterSupply = pumps * 50;
    const powerUse = residential * 1.5 + commercial * 2.5 + industrial * 3;
    const waterUse = residential * 1 + commercial * 1.5 + industrial * 2;
    this.state.utilities.powerUsed = powerUse;
    this.state.utilities.power = powerSupply - powerUse;
    this.state.utilities.water = waterSupply - waterUse;

    this.state.demand.residential = clamp(
      60 - residential * 2 + Math.max(0, this.state.jobs - this.state.population),
      0,
      100
    );
    this.state.demand.commercial = clamp(
      50 - commercial * 3 + this.state.population * 0.2,
      0,
      100
    );
    this.state.demand.industrial = clamp(
      50 - industrial * 3 + this.state.population * 0.15,
      0,
      100
    );

    const utilityPenalty =
      (this.state.utilities.power < 0 ? 15 : 0) + (this.state.utilities.water < 0 ? 10 : 0);
    this.state.demand.residential = clamp(this.state.demand.residential - utilityPenalty, 0, 100);

    const revenue =
      BASE_INCOME + this.state.population * 1.5 + commercial * 6 + industrial * 8;
    const expenses = maintenance + plantMaintenance + pumps * 3;
    this.state.money = Math.max(0, this.state.money + (revenue - expenses) * this.dt * 0.2);
  }
}
