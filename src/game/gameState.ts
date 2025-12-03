import { PowerPlantType } from './constants';
import type { BudgetHistory } from './budget';
import type { BuildingInstance } from './buildings';
import type { ServiceSystemState, TileServiceState } from './services';
import { createServiceSystemState, createTileServiceState } from './services';

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
  WaterTower = 'water_tower',
  WaterPipe = 'water_pipe',
  Park = 'park'
}

export interface Tile {
  kind: TileKind;
  elevation: number;
  happiness: number;
  powered: boolean;
  roadUnderlay?: boolean;
  railUnderlay?: boolean;
  powerOverlay?: boolean;
  powerPlantType?: PowerPlantType;
  powerPlantId?: number;
  buildingId?: number;
  services: TileServiceState;
}

export type MinimapMode = 'base';

export type MinimapSize = 'small' | 'medium';

export interface MinimapSettings {
  open: boolean;
  size: MinimapSize;
  mode: MinimapMode;
}

export interface GameSettings {
  pendingPenaltyEnabled: boolean;
  minimap: MinimapSettings;
}

export interface UtilityStats {
  power: number;
  water: number;
  powerProduced: number;
  powerUsed: number;
}

export interface DemandStats {
  residential: number;
  commercial: number;
  industrial: number;
}

export interface BudgetStats {
  revenue: number;
  expenses: number;
  net: number;
  netPerDay: number;
  netPerMonth: number;
  breakdown: {
    revenue: {
      base: number;
      residents: number;
      commercial: number;
      industrial: number;
    };
    expenses: {
      transport: number;
      buildings: number;
    };
    details: {
      transport: {
        roads: number;
        rail: number;
        powerLines: number;
        waterPipes: number;
      };
      buildings: {
        power: number;
        civic: number;
        zones: number;
      };
    };
  };
}

export interface GameState {
  width: number;
  height: number;
  tiles: Tile[];
  money: number;
  day: number;
  tick: number;
  population: number;
  jobs: number;
  utilities: UtilityStats;
  demand: DemandStats;
  budget: BudgetStats;
  budgetHistory: import('./budget').BudgetHistory;
  buildings: BuildingInstance[];
  nextBuildingId: number;
  services: ServiceSystemState;
  settings: GameSettings;
}

export function createDefaultMinimapSettings(): MinimapSettings {
  return { open: true, size: 'medium', mode: 'base' };
}

export function createDefaultSettings(): GameSettings {
  return {
    pendingPenaltyEnabled: true,
    minimap: createDefaultMinimapSettings()
  };
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
        happiness: 1,
        powered: false,
        services: createTileServiceState()
      });
    }
  }
  return {
    width,
    height,
    tiles,
    money: 100000,
    day: 1,
    tick: 0,
    population: 12,
    jobs: 4,
    utilities: {
      power: 10,
      water: 10,
      powerProduced: 0,
      powerUsed: 0
    },
    budget: {
      revenue: 0,
      expenses: 0,
      net: 0,
      netPerDay: 0,
      netPerMonth: 0,
      breakdown: {
        revenue: { base: 0, residents: 0, commercial: 0, industrial: 0 },
        expenses: { transport: 0, buildings: 0 },
        details: {
          transport: { roads: 0, rail: 0, powerLines: 0, waterPipes: 0 },
          buildings: { power: 0, civic: 0, zones: 0 }
        }
      }
    },
    budgetHistory: { daily: [], lastRecordedDay: 0 },
    demand: { residential: 30, commercial: 30, industrial: 30 },
    buildings: [],
    nextBuildingId: 1,
    services: createServiceSystemState(),
    settings: createDefaultSettings()
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
  tile.roadUnderlay = undefined;
  tile.railUnderlay = undefined;
  tile.powerOverlay = undefined;
  tile.happiness = Math.min(1.5, tile.happiness + 0.05);
  if (kind !== TileKind.HydroPlant) {
    tile.powerPlantType = undefined;
    tile.powerPlantId = undefined;
    tile.buildingId = undefined;
  }
}
