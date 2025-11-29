export enum TileKind {
  Land = 'land',
  Water = 'water',
  Tree = 'tree',
  Road = 'road',
  Rail = 'rail',
  Residential = 'residential',
  Commercial = 'commercial',
  Industrial = 'industrial',
  PowerLine = 'powerline',
  HydroPlant = 'hydro',
  WaterPump = 'pump',
  Park = 'park'
}

export enum Tool {
  Inspect = 'inspect',
  Terraform = 'terraform',
  Water = 'water',
  Tree = 'tree',
  Road = 'road',
  Rail = 'rail',
  PowerLine = 'powerline',
  HydroPlant = 'hydro',
  WaterPump = 'pump',
  Residential = 'residential',
  Commercial = 'commercial',
  Industrial = 'industrial',
  Bulldoze = 'bulldoze',
  Park = 'park'
}

export interface TileState {
  kind: TileKind;
  elevation: number;
  happiness: number;
}

export interface GameState {
  width: number;
  height: number;
  tiles: TileState[];
  money: number;
  day: number;
  population: number;
  jobs: number;
  power: number;
  water: number;
  demand: {
    residential: number;
    commercial: number;
    industrial: number;
  };
}

export interface ChangeResult {
  success: boolean;
  message?: string;
}

const BUILD_COST: Record<Tool, number> = {
  [Tool.Inspect]: 0,
  [Tool.Terraform]: 10,
  [Tool.Water]: 12,
  [Tool.Tree]: 8,
  [Tool.Road]: 5,
  [Tool.Rail]: 15,
  [Tool.PowerLine]: 6,
  [Tool.HydroPlant]: 600,
  [Tool.WaterPump]: 400,
  [Tool.Residential]: 40,
  [Tool.Commercial]: 60,
  [Tool.Industrial]: 80,
  [Tool.Bulldoze]: 1,
  [Tool.Park]: 10
};

const MAINTENANCE: Partial<Record<TileKind, number>> = {
  [TileKind.Road]: 0.1,
  [TileKind.Rail]: 0.2,
  [TileKind.PowerLine]: 0.08,
  [TileKind.HydroPlant]: 3,
  [TileKind.WaterPump]: 2,
  [TileKind.Park]: 0.05
};

const BASE_INCOME = 120;

export function createInitialState(width = 64, height = 64): GameState {
  const tiles: TileState[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = x < 3 || y < 3 || x > width - 4 || y > height - 4;
      const isWater = (x - width / 2) ** 2 + (y - height / 2) ** 2 < 180 && (x + y) % 5 === 0;
      tiles.push({
        kind: edge ? TileKind.Water : isWater ? TileKind.Water : TileKind.Land,
        elevation: 0,
        happiness: 1
      });
    }
  }
  return {
    width,
    height,
    tiles,
    money: 100000,
    day: 1,
    population: 12,
    jobs: 4,
    power: 10,
    water: 10,
    demand: { residential: 30, commercial: 30, industrial: 30 }
  };
}

function getIndex(state: GameState, x: number, y: number): number {
  return y * state.width + x;
}

export function getTile(state: GameState, x: number, y: number): TileState | undefined {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) return undefined;
  return state.tiles[getIndex(state, x, y)];
}

function setTile(state: GameState, x: number, y: number, kind: TileKind) {
  const tile = getTile(state, x, y);
  if (!tile) return;
  tile.kind = kind;
  tile.happiness = Math.min(1.5, tile.happiness + 0.05);
}

export function applyTool(state: GameState, tool: Tool, x: number, y: number): ChangeResult {
  const tile = getTile(state, x, y);
  if (!tile) return { success: false };
  const cost = BUILD_COST[tool];
  if (state.money < cost) {
    return { success: false, message: 'Not enough funds' };
  }
  const charge = () => {
    state.money -= cost;
  };

  switch (tool) {
    case Tool.Terraform:
      charge();
      setTile(state, x, y, TileKind.Land);
      return { success: true };
    case Tool.Water:
      charge();
      setTile(state, x, y, TileKind.Water);
      return { success: true };
    case Tool.Tree:
      charge();
      setTile(state, x, y, TileKind.Tree);
      return { success: true };
    case Tool.Road:
      charge();
      setTile(state, x, y, TileKind.Road);
      return { success: true };
    case Tool.Rail:
      charge();
      setTile(state, x, y, TileKind.Rail);
      return { success: true };
    case Tool.PowerLine:
      charge();
      setTile(state, x, y, TileKind.PowerLine);
      return { success: true };
    case Tool.HydroPlant:
      charge();
      setTile(state, x, y, TileKind.HydroPlant);
      return { success: true };
    case Tool.WaterPump:
      charge();
      setTile(state, x, y, TileKind.WaterPump);
      return { success: true };
    case Tool.Residential:
      charge();
      setTile(state, x, y, TileKind.Residential);
      return { success: true };
    case Tool.Commercial:
      charge();
      setTile(state, x, y, TileKind.Commercial);
      return { success: true };
    case Tool.Industrial:
      charge();
      setTile(state, x, y, TileKind.Industrial);
      return { success: true };
    case Tool.Park:
      charge();
      setTile(state, x, y, TileKind.Park);
      return { success: true };
    case Tool.Bulldoze:
      charge();
      setTile(state, x, y, TileKind.Land);
      return { success: true };
    default:
      return { success: false };
  }
}

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

export function tick(state: GameState, dtSeconds: number) {
  state.day += dtSeconds / 1.5; // faster than real time

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

export function serialize(state: GameState): string {
  return JSON.stringify(state);
}

export function deserialize(payload: string): GameState {
  const parsed = JSON.parse(payload);
  return parsed as GameState;
}

export function copyState(state: GameState): GameState {
  return deserialize(serialize(state));
}
