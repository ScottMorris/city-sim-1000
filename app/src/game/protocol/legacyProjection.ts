// legacyProjection.ts — TS port of the precedence Rust's (deleted) display.rs
// wire_kind/wire_flags/wire_underground used to run.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/**
 * Temporary strangler-window scaffolding: `wasmSimBridge.ts`/`tauriSimBridge.ts`
 * call this to populate `Tile`'s deprecated `kind`/`roadUnderlay`/`railUnderlay`/
 * `powerOverlay`/`legacyUnderground` shim fields from the real strata, so
 * consumers not yet converted to `terrain`/`underground`/`surface`/`overhead`
 * keep working. Deleted, along with the shim fields themselves, once every
 * consumer reads the strata directly.
 *
 * Mirrors `city_sim_core::display::{wire_kind, wire_flags, wire_underground}`
 * exactly (as they were before deletion) — precedence: terrain > structure >
 * zone > trees > line > rail > road > land.
 */

import type { Tile } from '../gameState';
import { TileKind } from '../gameState';
import { Occupant, Terrain, ZoneDensity, hasOccupant, withOccupant, zoneOccupant } from './occupants';

const ZONE_KIND: Partial<Record<Occupant, TileKind>> = {
  [Occupant.ZoneResidential]: TileKind.Residential,
  [Occupant.ZoneCommercial]: TileKind.Commercial,
  [Occupant.ZoneIndustrial]: TileKind.Industrial
};

export interface LegacyProjectionInput {
  terrain: Terrain;
  surface: number;
  overhead: number;
  buildingId?: number;
  /** Resolves a building's template kind — `undefined` if not live. */
  structureKindOf: (buildingId: number) => TileKind | undefined;
}

/**
 * The v4 `kind` for one tile. `None` for a developed zone lot's structure
 * lookup is deliberate: the lot carries a `building_id` and a
 * `BuildingInstance` whose kind is e.g. `Residential`, but its occupant is a
 * zone tag, not `Occupant.Structure` — see `zoneOccupant` below, which is
 * what actually resolves it.
 */
export function legacyKind(t: LegacyProjectionInput): TileKind {
  if (t.terrain === Terrain.Water) return TileKind.Water;
  if (hasOccupant(t.surface, Occupant.Structure) && t.buildingId !== undefined) {
    const structureKind = t.structureKindOf(t.buildingId);
    if (structureKind !== undefined) return structureKind;
  }
  const zone = zoneOccupant(t.surface);
  if (zone !== undefined) return ZONE_KIND[zone] as TileKind;
  if (hasOccupant(t.overhead, Occupant.Trees)) return TileKind.Tree;
  if (hasOccupant(t.overhead, Occupant.PowerLine)) return TileKind.PowerLine;
  if (hasOccupant(t.surface, Occupant.Rail)) return TileKind.Rail;
  if (hasOccupant(t.surface, Occupant.Road)) return TileKind.Road;
  return TileKind.Land;
}

/**
 * The v4 structural flags: true for whichever occupant is present but did not
 * win `kind`. `powerOverlay` is unconditional whenever the `PowerLine`
 * occupant is present, even when `kind` is already `PowerLine` — mirrors
 * `wire_flags`'s note that `Tool::PowerLine` always set both historically.
 */
export function legacyFlags(t: LegacyProjectionInput, kind: TileKind) {
  return {
    roadUnderlay: hasOccupant(t.surface, Occupant.Road) && kind !== TileKind.Road,
    railUnderlay: hasOccupant(t.surface, Occupant.Rail) && kind !== TileKind.Rail,
    powerOverlay: hasOccupant(t.overhead, Occupant.PowerLine)
  };
}

/** The v4 `underground` TileKind — `WaterPipe` or `undefined`. */
export function legacyUndergroundKind(underground: number): TileKind | undefined {
  return hasOccupant(underground, Occupant.Pipe) ? TileKind.WaterPipe : undefined;
}

/**
 * The ten `TileKind`s that derive to the single `Structure` occupant. Mirrors
 * `occupants::is_structure_kind`.
 */
const STRUCTURE_KINDS: ReadonlySet<TileKind> = new Set([
  TileKind.HydroPlant,
  TileKind.CoalPlant,
  TileKind.WindTurbine,
  TileKind.SolarFarm,
  TileKind.WaterPump,
  TileKind.WaterTower,
  TileKind.ElementarySchool,
  TileKind.HighSchool,
  TileKind.Park,
  TileKind.ParkLarge
]);

export interface V4Strata {
  terrain: Terrain;
  underground: number;
  surface: number;
  overhead: number;
  density: ZoneDensity;
}

/**
 * Decode a v4-shaped tile spelling into strata occupant bits. Mirrors
 * `migrate::tile_from_v4` — used only to import old `.citysim` JSON saves
 * (`persistence.ts`'s `deserialize`), which never encoded zone density, so
 * `density` is always `Low` here (matches the Rust importer's documented
 * fidelity limit).
 */
export function tileFromV4(
  kind: TileKind,
  flags: { roadUnderlay?: boolean; railUnderlay?: boolean; powerOverlay?: boolean },
  underground: TileKind | undefined,
  buildingId: number | undefined
): V4Strata {
  const hasPipe = underground === TileKind.WaterPipe;
  const hasRoad = kind === TileKind.Road || !!flags.roadUnderlay;
  const hasRail = kind === TileKind.Rail || !!flags.railUnderlay;
  const hasLine = kind === TileKind.PowerLine || !!flags.powerOverlay;
  const hasStructure = STRUCTURE_KINDS.has(kind) && buildingId !== undefined;

  let undergroundBits = 0;
  let surface = 0;
  let overhead = 0;
  undergroundBits = withOccupant(undergroundBits, Occupant.Pipe, hasPipe);
  surface = withOccupant(surface, Occupant.Road, hasRoad);
  surface = withOccupant(surface, Occupant.Rail, hasRail);
  surface = withOccupant(surface, Occupant.ZoneResidential, kind === TileKind.Residential);
  surface = withOccupant(surface, Occupant.ZoneCommercial, kind === TileKind.Commercial);
  surface = withOccupant(surface, Occupant.ZoneIndustrial, kind === TileKind.Industrial);
  surface = withOccupant(surface, Occupant.Structure, hasStructure);
  overhead = withOccupant(overhead, Occupant.PowerLine, hasLine);
  overhead = withOccupant(overhead, Occupant.Trees, kind === TileKind.Tree);

  return {
    terrain: kind === TileKind.Water ? Terrain.Water : Terrain.Land,
    underground: undergroundBits,
    surface,
    overhead,
    density: ZoneDensity.Low
  };
}

/**
 * Bring one tile's strata fields back in sync with its shim fields, in
 * place. `tools.ts`'s `applyTool` calls this (whole-grid, once per call —
 * see its own `syncStrataFromLegacy`) after every tool, since its handlers
 * are still unconverted v4-shape logic; tests that hand-spell a tile's shim
 * fields directly (bypassing `applyTool`) need the same call so predicates
 * reading the strata directly don't see stale zeros.
 */
export function resyncTileStrata(tile: Tile): void {
  const strata = tileFromV4(
    tile.kind,
    { roadUnderlay: tile.roadUnderlay, railUnderlay: tile.railUnderlay, powerOverlay: tile.powerOverlay },
    tile.legacyUnderground,
    tile.buildingId
  );
  tile.terrain = strata.terrain;
  tile.underground = strata.underground;
  tile.surface = strata.surface;
  tile.overhead = strata.overhead;
  tile.density = strata.density;
}
