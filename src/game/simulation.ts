import { BASE_INCOME, MAINTENANCE } from './constants';
import { GameState, TileKind } from './gameState';

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

export function tick(state: GameState, dtSeconds: number) {
  state.day += dtSeconds / 1.5;

  let residential = 0;
  let commercial = 0;
  let industrial = 0;
  let generators = 0;
  let pumps = 0;
  let maintenance = 0;

  for (const tile of state.tiles) {
    if (tile.kind === TileKind.Residential) residential++;
    if (tile.kind === TileKind.Commercial) commercial++;
    if (tile.kind === TileKind.Industrial) industrial++;
    if (tile.kind === TileKind.HydroPlant) generators++;
    if (tile.kind === TileKind.WaterPump) pumps++;
    const upkeep = MAINTENANCE[tile.kind];
    if (upkeep) maintenance += upkeep;
  }

  const populationCapacity = residential * 14;
  const jobCapacity = commercial * 8 + industrial * 12;
  const desiredPop = Math.min(populationCapacity, state.population + state.demand.residential * 0.05);
  const desiredJobs = Math.min(jobCapacity, state.jobs + (state.demand.commercial + state.demand.industrial) * 0.05);
  const growth = clamp(desiredPop - state.population, -2, 2);
  const jobGrowth = clamp(desiredJobs - state.jobs, -2, 2);
  state.population = clamp(state.population + growth, 0, populationCapacity);
  state.jobs = clamp(state.jobs + jobGrowth, 0, jobCapacity);

  const powerSupply = generators * 50;
  const waterSupply = pumps * 50;
  const powerUse = residential * 1.5 + commercial * 2.5 + industrial * 3;
  const waterUse = residential * 1 + commercial * 1.5 + industrial * 2;
  state.power = powerSupply - powerUse;
  state.water = waterSupply - waterUse;

  state.demand.residential = clamp(60 - residential * 2 + Math.max(0, state.jobs - state.population), 0, 100);
  state.demand.commercial = clamp(50 - commercial * 3 + state.population * 0.2, 0, 100);
  state.demand.industrial = clamp(50 - industrial * 3 + state.population * 0.15, 0, 100);

  const utilityPenalty = (state.power < 0 ? 15 : 0) + (state.water < 0 ? 10 : 0);
  state.demand.residential = clamp(state.demand.residential - utilityPenalty, 0, 100);

  const revenue = BASE_INCOME + state.population * 1.5 + commercial * 6 + industrial * 8;
  const expenses = maintenance + generators * 4 + pumps * 3;
  state.money = Math.max(0, state.money + (revenue - expenses) * dtSeconds * 0.2);
}
