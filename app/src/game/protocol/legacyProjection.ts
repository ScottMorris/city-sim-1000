// legacyProjection.ts — TS port of the precedence Rust's (deleted) display.rs
// wire_kind/wire_flags used to run.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/**
 * The v4 wire format's flattened `kind`+flags spelling, derived on demand
 * from the real strata. `Tile` itself carries no shim fields any more (the
 * strangler window they existed for closed once every consumer converted to
 * reading `terrain`/`underground`/`surface`/`overhead` directly) — this
 * module survives purely as a *display* need now: `dominantOccupantLabel`
 * (`protocol/tileLabel.ts`, used by the HUD tile inspector, the minimap, and
 * `mcpBridge.ts`), the renderer (`tileRenderUtils.ts`), and the one minimap
 * mode that still wants v4-style precedence to pick a single label for a
 * tile that may carry several occupants at once.
 *
 * The other historical reason this module existed — importing old
 * `.citysim` JSON saves — is gone: `persistence.ts`'s `transcodeLegacySave`
 * transcodes a save's raw JSON fields directly into the frozen v4 wire
 * buffer with no strata round trip, so Rust's `tile_from_v4`
 * (`city_sim_core::migrate`) is the sole place a v4 spelling is decoded into
 * strata now. `legacyKind`/`legacyFlags` below are display-only exports —
 * *encoding* strata into a v4 spelling, never decoding one.
 *
 * Mirrors `city_sim_core::display::{wire_kind, wire_flags}` exactly (as they
 * were before deletion) — precedence: terrain > structure > zone > trees >
 * line > rail > road > land.
 */

import { TileKind } from '../gameState';
import { Occupant, Terrain, hasOccupant, zoneOccupant } from './occupants';

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

