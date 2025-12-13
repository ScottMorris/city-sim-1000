import { PowerPlantType } from './constants';
import { BylawState, DEFAULT_BYLAWS } from './bylaws';
import { defaultHotkeys } from '../ui/hotkeys';
import type { BudgetHistory } from './budget';
import type { EducationStats } from './education';
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
  ElementarySchool = 'elementary_school',
  HighSchool = 'high_school',
  Park = 'park'
}

export interface Tile {
  kind: TileKind;
  elevation: number;
  happiness: number;
  powered: boolean;
  abandoned?: boolean;
  roadUnderlay?: boolean;
  railUnderlay?: boolean;
  powerOverlay?: boolean;
  powerPlantType?: PowerPlantType;
  powerPlantId?: number;
  buildingId?: number;
  services: TileServiceState;
}

export type MinimapMode = 'base' | 'power' | 'water' | 'alerts' | 'education';

export type MinimapSize = 'small' | 'medium';

export interface MinimapSettings {
  open: boolean;
  size: MinimapSize;
  mode: MinimapMode;
}

export type PanSpeedPreset = 'slow' | 'normal' | 'fast';
export type ZoomSensitivityPreset = 'gentle' | 'normal' | 'fast';

export interface InputSettings {
  invertPan: boolean;
  panSpeed: PanSpeedPreset;
  edgeScrollEnabled: boolean;
  edgeScrollSpeed: PanSpeedPreset;
  shiftScrollsToPan: boolean;
  ctrlScrollsToPan: boolean;
  zoomSensitivity: ZoomSensitivityPreset;
}

export interface AccessibilitySettings {
  reducedMotion: boolean;
  highContrastOverlays: boolean;
}

export interface AudioSettings {
  radioVolume: number;
  sfxVolume: number;
}

export interface CosmeticSettings {
  geminiBuildingsEnabled: boolean;
}

export interface GameSettings {
  pendingPenaltyEnabled: boolean;
  minimap: MinimapSettings;
  input: InputSettings;
  accessibility: AccessibilitySettings;
  audio: AudioSettings;
  hotkeys: Record<string, string[]>;
  cosmetics: CosmeticSettings;
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
        powerByType: Record<string, number>;
        civicByType: Record<string, number>;
        zonesByType: Record<string, number>;
      };
    };
  };
}

export interface GameState {
  width: number;
  height: number;
  tiles: Tile[];
  tileRevision: number;
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
  education: EducationStats;
  bylaws: BylawState;
  settings: GameSettings;
}

export function createDefaultMinimapSettings(): MinimapSettings {
  return { open: true, size: 'medium', mode: 'base' };
}

export function createDefaultInputSettings(): InputSettings {
  return {
    invertPan: false,
    panSpeed: 'normal',
    edgeScrollEnabled: false,
    edgeScrollSpeed: 'normal',
    shiftScrollsToPan: false,
    ctrlScrollsToPan: true,
    zoomSensitivity: 'normal'
  };
}

export function createDefaultAccessibilitySettings(): AccessibilitySettings {
  return {
    reducedMotion: false,
    highContrastOverlays: false
  };
}

export function createDefaultAudioSettings(): AudioSettings {
  return {
    radioVolume: 1,
    sfxVolume: 1
  };
}

export function createDefaultCosmeticSettings(): CosmeticSettings {
  return {
    geminiBuildingsEnabled: false
  };
}

export function createDefaultSettings(): GameSettings {
  return {
    pendingPenaltyEnabled: true,
    minimap: createDefaultMinimapSettings(),
    input: createDefaultInputSettings(),
    accessibility: createDefaultAccessibilitySettings(),
    audio: createDefaultAudioSettings(),
    hotkeys: { ...defaultHotkeys },
    cosmetics: createDefaultCosmeticSettings()
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
    tileRevision: 0,
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
          buildings: { power: 0, civic: 0, zones: 0, powerByType: {}, civicByType: {}, zonesByType: {} }
        }
      }
    },
    budgetHistory: { daily: [], lastRecordedDay: 0 },
    demand: { residential: 30, commercial: 30, industrial: 30 },
    buildings: [],
    nextBuildingId: 1,
    services: createServiceSystemState(),
    education: {
      elementaryServed: 0,
      elementaryCapacity: 0,
      elementaryLoad: 0,
      highServed: 0,
      highCapacity: 0,
      highLoad: 0,
      score: 0,
      elementaryCoverage: 0,
      highCoverage: 0
    },
    bylaws: { ...DEFAULT_BYLAWS },
    settings: createDefaultSettings()
  };
}

function getIndex(state: GameState, x: number, y: number): number {
  return y * state.width + x;
}

export function bumpTileRevision(state: GameState) {
  state.tileRevision = (state.tileRevision ?? 0) + 1;
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
  bumpTileRevision(state);
}
