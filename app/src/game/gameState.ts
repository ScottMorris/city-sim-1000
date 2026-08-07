// GameState type definition and default factory helpers for all settings sub-objects.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { createDefaultPolicies, DEFAULT_LIGHTING_POLICY, type LightingPolicy, type Policies } from './protocol/commands';
import { defaultHotkeys, type HotkeyBindings } from '../ui/hotkeys';
import { createDefaultSfxOverrides, type SfxOverrides } from './sfxOverrides';
import { Occupant, Terrain, ZoneDensity, withOccupant } from './protocol/occupants';
import type { BudgetHistoryEntry } from './economy';
import type { EducationStats } from './education';
import type { BuildingInstance } from './buildings/state';
import type { TileServiceState } from './services';
import { createTileServiceState } from './services';
import { SeededRng } from './rng';
import type { WireBudgetStats } from './protocol/generated/WireBudgetStats';
import type { WireLabourStats } from './protocol/generated/WireLabourStats';
import type { WireWildernessBreakdown } from './protocol/generated/WireWildernessBreakdown';
import type { WireDemandBreakdown } from './protocol/generated/WireDemandBreakdown';
import type { WireDemandClassBreakdown } from './protocol/generated/WireDemandClassBreakdown';
import type { WireUtilityComponent } from './protocol/generated/WireUtilityComponent';

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
  buildingId?: number;
  /** Per-tile eco value, −10..+10 (0 = neutral). From the sim's eco field (see `protocol/tileBuffer.ts`'s `decodeEco`). */
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

/**
 * One physically-connected segment of a power or water network — the
 * generated wire shape verbatim (`crates/city-sim-core/src/utilities.rs`'s
 * `UtilityComponent`). `produced`/`used` are left unrounded on the wire;
 * round for display, not here. `id` is stable only within one tick's
 * recompute — a grid edit can renumber every component on the next one.
 */
export type UtilityComponentStats = WireUtilityComponent;

export interface UtilityStats {
  power: number;
  water: number;
  powerProduced: number;
  powerUsed: number;
  waterProduced: number;
  waterUsed: number;
  /** One entry per physically-connected power segment; see `#230`. */
  powerComponents: UtilityComponentStats[];
  /** One entry per physically-connected water segment. */
  waterComponents: UtilityComponentStats[];
}

/**
 * Every intermediate value the engine's demand formula derives for one zone
 * class on the way to its final clamped percentage — the generated wire
 * shape verbatim (`crates/city-sim-core/src/demand.rs`'s
 * `DemandComputation`, wired as `WireDemandClassBreakdown`). Replaces the TS
 * shadow model that used to recompute these locally (`app/src/game/
 * demand.ts`, deleted).
 */
export type DemandClassBreakdown = WireDemandClassBreakdown;

export interface DemandStats {
  residential: number;
  commercial: number;
  industrial: number;
  /** Per-class derivation, one entry per zone class — the generated wire
   *  shape verbatim; see `DemandClassBreakdown`. */
  breakdown: WireDemandBreakdown;
}

/**
 * City-wide labour aggregates — the generated wire shape verbatim (Rust's
 * `LabourStats`, `crates/city-sim-core/src/demand.rs`). Replaces the
 * TS-side `computeLabourStats.ts` recompute (including its hard-coded 0.55
 * worker-share constant).
 */
export type LabourStats = WireLabourStats;

/** Per-category eco totals for the wilderness tooltip — the generated wire
 *  shape verbatim (Rust's `WildernessBreakdown`,
 *  `crates/city-sim-core/src/wilderness.rs`). */
export type WildernessBreakdown = WireWildernessBreakdown;

/**
 * Wilderness score display state — `score`/`trend` and `breakdown` arrive
 * as three separately-wired values (see `wasmSim.worker.ts`'s `gatherStats`/
 * `tauriSimBridge.ts`'s `onTick`), assembled into one mirror object here
 * rather than reshaped from a single wire struct, so this stays a small
 * composition rather than a hand-duplicated parallel of one.
 */
export interface WildernessStats {
  /** Global score, 0–100. */
  score: number;
  /** Fast EMA − slow EMA; sign gives the trend arrow. */
  trend: number;
  breakdown: WildernessBreakdown;
}

/**
 * Full headline + breakdown budget snapshot — the generated wire shape
 * verbatim (`WireBudgetStats`), flat fields and all. The grouped display
 * maps (`powerByType`/`civicByType`/`zonesByType`) that used to live nested
 * under `breakdown.details.buildings` here are derived at display time from
 * these flat fields instead — see `budgetModal.ts`'s `deriveBudgetBreakdown`.
 */
export type BudgetStats = WireBudgetStats;

export interface GameState {
  width: number;
  height: number;
  tiles: Tile[];
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
  /** City-wide labour aggregates — see `LabourStats`. */
  labour: LabourStats;
  /** Number of tiles flagged abandoned — see `GameState::abandoned_count` (Rust). */
  abandonedCount: number;
  /** Mean tile happiness across the grid — see `GameState::avg_happiness` (Rust). */
  avgHappiness: number;
  budget: BudgetStats;
  /** `#229` — Rust-computed, wire-sourced; see `economy.ts`'s doc comment. */
  budgetHistory: BudgetHistoryEntry[];
  buildings: BuildingInstance[];
  education: EducationStats;
  /**
   * Every player-adjustable policy family (budget, wilderness, lighting —
   * the Bylaws screen's lighting standard included). Fully engine-owned and
   * persisted in the CSIM snapshot; `ClientState` carries no bylaws slice
   * any more. Written optimistically by the UI the moment a policy is
   * selected, so it can lead the engine by up to one tick.
   */
  policies: Policies;
  /**
   * The lighting policy the engine's wire figures were computed under —
   * refreshed to `policies.lighting` each time a tick's stats land, unlike
   * the optimistic `policies` write itself. The Bylaws/ledger previews
   * rescale wire figures by THIS policy's multipliers: while the game is
   * paused after a switch, the wire still carries the old policy's numbers,
   * and dividing them by the new policy's multiplier would inflate the
   * recovered baseline.
   */
  appliedLighting: LightingPolicy;
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

/** A starter-seed breakdown row — matches what the engine reports before the
 *  first real demand tick runs (`seeded: true`, no derivation yet). */
export function createDefaultDemandClassBreakdown(value: number): DemandClassBreakdown {
  return {
    base: 0,
    fillFraction: 0,
    fillTerm: 0,
    workforceTerm: 0,
    labourTerm: 0,
    pendingZones: 0,
    pendingPenaltyRaw: 0,
    pendingPenaltyCapped: 0,
    pendingPenaltyApplied: 0,
    pressureRelief: 0,
    utilityPenalty: 0,
    demandBeforeUtilities: value,
    floorApplied: false,
    seeded: true,
    value
  };
}

export function createDefaultLabourStats(): LabourStats {
  return {
    population: 0,
    resCapacity: 0,
    jobCapacity: 0,
    workers: 0,
    employed: 0,
    unemployed: 0,
    unemploymentRate: 0,
    vacancyRate: 0
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

export function createDefaultBudgetStats(): BudgetStats {
  return {
    revenue: 0,
    expenses: 0,
    net: 0,
    netPerDay: 0,
    netPerMonth: 0,
    revenueBase: 0,
    revenuePop: 0,
    revenueCommercial: 0,
    revenueIndustrial: 0,
    revenueTourism: 0,
    expensesTransport: 0,
    expensesBuildings: 0,
    expensesPolicies: 0,
    maintPower: 0,
    maintCivic: 0,
    maintZones: 0,
    maintRoads: 0,
    maintRail: 0,
    maintPowerLines: 0,
    maintPipes: 0,
    maintPowerHydro: 0,
    maintPowerCoal: 0,
    maintPowerWind: 0,
    maintPowerSolar: 0,
    maintCivicPark: 0,
    maintCivicPump: 0,
    maintCivicTower: 0,
    maintCivicSchool: 0,
    maintZonesRes: 0,
    maintZonesCom: 0,
    maintZonesInd: 0
  };
}

export function createDefaultSettings(): GameSettings {
  return {
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

/** A bare land tile — the shared shape for growing/seeding the mirror's tile array, immediately overwritten by a decode loop or (for `createInitialState`) a procedural terrain pass. */
export function createBlankTile(): Tile {
  return {
    elevation: 0,
    happiness: 1,
    powered: false,
    watered: false,
    services: createTileServiceState(),
    terrain: Terrain.Land,
    underground: 0,
    surface: 0,
    overhead: 0,
    density: ZoneDensity.Low
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
      tiles.push({ ...createBlankTile(), terrain: water ? Terrain.Water : Terrain.Land });
    }
  }
  return {
    width,
    height,
    tiles,
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
      waterUsed: 0,
      powerComponents: [],
      waterComponents: []
    },
    budget: createDefaultBudgetStats(),
    budgetHistory: [],
    demand: {
      residential: 30,
      commercial: 30,
      industrial: 30,
      breakdown: {
        residential: createDefaultDemandClassBreakdown(30),
        commercial: createDefaultDemandClassBreakdown(30),
        industrial: createDefaultDemandClassBreakdown(30)
      }
    },
    labour: createDefaultLabourStats(),
    abandonedCount: 0,
    avgHappiness: 1,
    buildings: [],
    // No schools yet → no load anywhere → full coverage, matching
    // `city_sim_core::state::EducationStats::default()`.
    education: {
      elementaryServed: 0,
      elementaryCapacity: 0,
      elementaryLoad: 0,
      highServed: 0,
      highCapacity: 0,
      highLoad: 0,
      score: 1,
      elementaryCoverage: 1,
      highCoverage: 1
    },
    policies: createDefaultPolicies(),
    appliedLighting: DEFAULT_LIGHTING_POLICY,
    wilderness: createDefaultWildernessStats(),
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
 * a buried pipe is orthogonal to whatever sits on the surface, so stamping
 * a new `kind` here shouldn't clear it. This is now the only TS-side
 * `TileKind` → occupant-bits mapping left (Rust's `tile_from_v4`, via
 * `city_sim_core::migrate`, is the sole place a v4 spelling gets decoded for
 * real saves) — kept small and inline rather than imported from anywhere,
 * since `Occupant`'s bit positions are pinned "never reorder" and there is
 * no longer a TS module doing the equivalent decode to share this with.
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
    tile.buildingId = undefined;
  }
}
