// GameState type definition and default factory helpers for all settings sub-objects.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { PowerPlantType } from './constants';
import { BylawState, DEFAULT_BYLAWS } from './bylaws';
import { createDefaultPolicies, type Policies } from './protocol/commands';
import { defaultHotkeys, type HotkeyBindings } from '../ui/hotkeys';
import { createDefaultSfxOverrides, type SfxOverrides } from './sfxOverrides';
import { Occupant, Terrain, ZoneDensity, withOccupant } from './protocol/occupants';
import type { BudgetHistory } from './economy';
import type { EducationStats } from './education';
import type { BuildingInstance } from './buildings/state';
import type { ServiceSystemState, TileServiceState } from './services';
import { createServiceSystemState, createTileServiceState } from './services';
import { SeededRng } from './rng';

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
  CoalPlant = 'coal',
  WindTurbine = 'wind',
  SolarFarm = 'solar',
  WaterPump = 'pump',
  WaterTower = 'water_tower',
  WaterPipe = 'water_pipe',
  ElementarySchool = 'elementary_school',
  HighSchool = 'high_school',
  Park = 'park',
  ParkLarge = 'park_large'
}

export interface Tile {
  elevation: number;
  happiness: number;
  powered: boolean;
  watered: boolean;
  abandoned?: boolean;
  powerPlantType?: PowerPlantType;
  powerPlantId?: number;
  buildingId?: number;
  /** Per-tile wilderness intensity, 0–1 (0.5 = neutral). From the sim's eco field. */
  wilderness?: number;
  services: TileServiceState;

  /** What the ground itself is, `Land` | `Water`. Mirrors Rust's `Tile::terrain`. */
  terrain: Terrain;
  /** Underground stratum occupant bits (`Occupant.Pipe`/`Subway`/`Fibre`). Mirrors Rust's `Tile::underground`. */
  underground: number;
  /** Surface stratum occupant bits (`Occupant.Road`/`Rail`/zone tags/`Structure`). Mirrors Rust's `Tile::surface`. */
  surface: number;
  /** Overhead stratum occupant bits (`Occupant.PowerLine`/`Trees`). Mirrors Rust's `Tile::overhead`. */
  overhead: number;
  /** Zone density — not read by any system yet, carried for parity with Rust. */
  density: ZoneDensity;
}

/**
 * Read-only diagnostic filters painted over the world — never gate what
 * tools may touch. `ViewStratum` (below) is the orthogonal axis that does.
 */
export type MinimapOverlay = 'base' | 'power' | 'water' | 'alerts' | 'education' | 'wilderness';

/** Single validated list — `clientState.ts`'s sanitiser and `minimap.ts`'s chip set both read this so they can't drift apart again. */
export const MINIMAP_OVERLAYS: MinimapOverlay[] = ['base', 'power', 'water', 'alerts', 'education', 'wilderness'];

/**
 * What the player's tools may touch — orthogonal to `MinimapOverlay`. Owned
 * by `main.ts` alongside the active tool, not persisted with `ClientState`;
 * a session always starts at `surface`. See `docs/features/view-layers.md`.
 */
export type ViewStratum = 'surface' | 'underground';

export type MinimapSize = 'small' | 'medium';

export interface MinimapSettings {
  open: boolean;
  size: MinimapSize;
  overlay: MinimapOverlay;
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
  sfxMuted: boolean;
}

export interface CosmeticSettings {
  geminiBuildingsEnabled: boolean;
}

export interface NarrativeSettings {
  enabled: boolean;
  tickerEnabled: boolean;
}

export type UiMode = 'auto' | 'desktop' | 'mobile';

export interface UiSettings {
  mode: UiMode;
}

export interface GameSettings {
  pendingPenaltyEnabled: boolean;
  minimap: MinimapSettings;
  input: InputSettings;
  accessibility: AccessibilitySettings;
  audio: AudioSettings;
  hotkeys: HotkeyBindings;
  cosmetics: CosmeticSettings;
  narrative: NarrativeSettings;
  ui: UiSettings;
  /** City-scoped custom sound effect voice stacks; see also globalSfxStore.ts for the cross-city scope. */
  sfxOverrides: SfxOverrides;
}

export interface UtilityStats {
  power: number;
  water: number;
  powerProduced: number;
  powerUsed: number;
  waterProduced: number;
  waterUsed: number;
}

export interface DemandStats {
  residential: number;
  commercial: number;
  industrial: number;
}

/** Per-category eco totals for the wilderness tooltip — mirrors
 *  `WildernessBreakdown` in `crates/city-sim-core/src/wilderness.rs`. */
export interface WildernessBreakdown {
  forests: number;
  parks: number;
  openLand: number;
  waterEdge: number;
  patch: number;
  fragmentation: number;
  zones: number;
  industry: number;
  transport: number;
  power: number;
  civic: number;
}

/** Wilderness score display state — mirrors the Rust `WildernessStats`. */
export interface WildernessStats {
  /** Global score, 0–100. */
  score: number;
  /** Fast EMA − slow EMA; sign gives the trend arrow. */
  trend: number;
  breakdown: WildernessBreakdown;
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
      tourism: number;
    };
    expenses: {
      transport: number;
      buildings: number;
      /** Daily cost of active wilderness programmes. */
      policies: number;
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
  /** Original seed used to initialise the PRNG for this city. */
  seed: number;
  /** Live xoshiro128** state — persisted so saves resume mid-stream. */
  rngState: [number, number, number, number];
  money: number;
  day: number;
  tick: number;
  population: number;
  jobs: number;
  utilities: UtilityStats;
  demand: DemandStats;
  budget: BudgetStats;
  budgetHistory: BudgetHistory;
  buildings: BuildingInstance[];
  nextBuildingId: number;
  services: ServiceSystemState;
  education: EducationStats;
  bylaws: BylawState;
  /** Every player-adjustable policy family (budget, wilderness, ...). */
  policies: Policies;
  /** Wilderness score, trend, and breakdown — computed by the Rust sim. */
  wilderness: WildernessStats;
  settings: GameSettings;
}

export function createDefaultMinimapSettings(): MinimapSettings {
  return { open: true, size: 'medium', overlay: 'base' };
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
    sfxVolume: 1,
    sfxMuted: false
  };
}

export function createDefaultCosmeticSettings(): CosmeticSettings {
  return {
    geminiBuildingsEnabled: false
  };
}

export function createDefaultNarrativeSettings(): NarrativeSettings {
  return {
    enabled: true,
    tickerEnabled: true
  };
}

export function createDefaultUiSettings(): UiSettings {
  return {
    mode: 'auto'
  };
}

export function createDefaultWildernessStats(): WildernessStats {
  return {
    score: 0,
    trend: 0,
    breakdown: {
      forests: 0,
      parks: 0,
      openLand: 0,
      waterEdge: 0,
      patch: 0,
      fragmentation: 0,
      zones: 0,
      industry: 0,
      transport: 0,
      power: 0,
      civic: 0
    }
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
    cosmetics: createDefaultCosmeticSettings(),
    narrative: createDefaultNarrativeSettings(),
    ui: createDefaultUiSettings(),
    sfxOverrides: createDefaultSfxOverrides()
  };
}

export function createInitialState(width = 64, height = 64, seed?: number): GameState {
  const resolvedSeed = (seed ?? Date.now()) >>> 0;
  const tiles: Tile[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = x < 3 || y < 3 || x > width - 4 || y > height - 4;
      const isWater = (x - width / 2) ** 2 + (y - height / 2) ** 2 < 180 && (x + y) % 5 === 0;
      const water = edge || isWater;
      tiles.push({
        elevation: 0,
        happiness: 1,
        powered: false,
        watered: false,
        services: createTileServiceState(),
        terrain: water ? Terrain.Water : Terrain.Land,
        underground: 0,
        surface: 0,
        overhead: 0,
        density: ZoneDensity.Low
      });
    }
  }
  return {
    width,
    height,
    tiles,
    tileRevision: 0,
    seed: resolvedSeed,
    rngState: new SeededRng(resolvedSeed).toJSON(),
    money: 100000,
    day: 1,
    tick: 0,
    population: 12,
    jobs: 4,
    utilities: {
      power: 10,
      water: 10,
      powerProduced: 0,
      powerUsed: 0,
      waterProduced: 0,
      waterUsed: 0
    },
    budget: {
      revenue: 0,
      expenses: 0,
      net: 0,
      netPerDay: 0,
      netPerMonth: 0,
      breakdown: {
        revenue: { base: 0, residents: 0, commercial: 0, industrial: 0, tourism: 0 },
        expenses: { transport: 0, buildings: 0, policies: 0 },
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
    policies: createDefaultPolicies(),
    wilderness: createDefaultWildernessStats(),
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

/**
 * Test-only convenience: stamp a tile to a single-valued `TileKind`,
 * translated to the strata it implies. Production placement is occupant-
 * native — it mutates `terrain`/`underground`/`surface`/`overhead` directly,
 * in the Rust engine (`crates/city-sim-core/src/commands.rs`'s `apply_tool`)
 * — this exists so tests can still set up a tile in one call the way
 * `TileKind` names it.
 *
 * Replaces the whole surface and overhead stratum (a bare `TileKind` can
 * only ever mean one thing at a time) but leaves `underground` standing —
 * mirrors `tileFromV4`'s treatment of a v4 tile's buried pipe, which this
 * function cannot call directly: `protocol/legacyProjection.ts` imports
 * `TileKind` from this module at its own top level, so importing back from
 * it here would form a cycle whose evaluation order left `TileKind`
 * `undefined` the one time this was tried (see git history). Duplicated
 * instead of shared; the mapping is small and `Occupant`'s bit positions
 * are pinned "never reorder".
 */
export function setTile(state: GameState, x: number, y: number, kind: TileKind) {
  const tile = getTile(state, x, y);
  if (!tile) return;
  tile.terrain = kind === TileKind.Water ? Terrain.Water : Terrain.Land;
  tile.surface = 0;
  tile.overhead = 0;
  tile.surface = withOccupant(tile.surface, Occupant.Road, kind === TileKind.Road);
  tile.surface = withOccupant(tile.surface, Occupant.Rail, kind === TileKind.Rail);
  tile.surface = withOccupant(tile.surface, Occupant.ZoneResidential, kind === TileKind.Residential);
  tile.surface = withOccupant(tile.surface, Occupant.ZoneCommercial, kind === TileKind.Commercial);
  tile.surface = withOccupant(tile.surface, Occupant.ZoneIndustrial, kind === TileKind.Industrial);
  tile.overhead = withOccupant(tile.overhead, Occupant.PowerLine, kind === TileKind.PowerLine);
  tile.overhead = withOccupant(tile.overhead, Occupant.Trees, kind === TileKind.Tree);
  tile.happiness = Math.min(1.5, tile.happiness + 0.05);
  const isPowerPlant = kind === TileKind.HydroPlant || kind === TileKind.CoalPlant
    || kind === TileKind.WindTurbine || kind === TileKind.SolarFarm;
  if (!isPowerPlant) {
    tile.powerPlantType = undefined;
    tile.powerPlantId = undefined;
    tile.buildingId = undefined;
  }
  bumpTileRevision(state);
}
