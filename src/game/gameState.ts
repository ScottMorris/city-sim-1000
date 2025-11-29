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

export interface Tile {
  kind: TileKind;
  elevation: number;
  happiness: number;
}

export interface UtilityStats {
  power: number;
  water: number;
}

export interface DemandStats {
  residential: number;
  commercial: number;
  industrial: number;
}

export interface GameState {
  width: number;
  height: number;
  tiles: Tile[];
  money: number;
  day: number;
  population: number;
  jobs: number;
  utilities: UtilityStats;
  demand: DemandStats;
}

export function createInitialState(width = 64, height = 64): GameState {
  const tiles: Tile[] = [];
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
    utilities: {
      power: 10,
      water: 10
    },
    demand: { residential: 30, commercial: 30, industrial: 30 }
  };
}

function getIndex(state: GameState, x: number, y: number): number {
  return y * state.width + x;
}

export function getTile(state: GameState, x: number, y: number): Tile | undefined {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) return undefined;
  return state.tiles[getIndex(state, x, y)];
}

export function setTile(state: GameState, x: number, y: number, kind: TileKind) {
  const tile = getTile(state, x, y);
  if (!tile) return;
  tile.kind = kind;
  tile.happiness = Math.min(1.5, tile.happiness + 0.05);
}
