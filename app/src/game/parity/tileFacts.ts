// tileFacts.ts — the shared vocabulary both engines are compared in.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/**
 * A tile stated as *what is on it*, not as *how it is spelled*.
 *
 * The cross-language parity harness cannot compare representations directly
 * — the two engines' internal layouts can and do change shape independently
 * — so it compares **observations** instead, the same questions the
 * renderer, the minimap and the placement guards ask, and both sides answer
 * them from their own strata through {@link factsFromTile}.
 *
 * Deliberately *not* compared: a resolved `kind` spelling. `legacyKind`
 * documents several intended precedence normalisations (rail wins a level
 * crossing, a hydro line wins over bare ground, a bulldozed footprint stops
 * being a ghost), so a byte-for-byte comparison of derived kinds would fail
 * on changes that are the point of those normalisations rather than on
 * drift. Reading occupant bits directly instead of going through a resolved
 * `kind` sidesteps that entirely: every predicate here is spelling-agnostic
 * and therefore invariant under all of them — if one of these disagrees,
 * something real does. That byte-for-byte comparison is the visual-
 * regression harness's job, not this one's.
 *
 * Also deliberately not compared: wilderness. It is excluded from the oracle
 * by design — `docs/features/wilderness-score.md`, decision 4.
 */

import { TileKind } from '../gameState';
import { Occupant, Terrain, hasOccupant, zoneOccupant } from '../protocol/occupants';

export interface TileFacts {
  /** The ground reads as water. */
  water: boolean;
  /** Tree canopy stands here. */
  trees: boolean;
  /** A carriageway runs through. */
  road: boolean;
  /** A railway runs through. */
  rail: boolean;
  /** A hydro line spans the tile. */
  line: boolean;
  /** The zone tag, or `null`. */
  zone: TileKind | null;
  /** The structure standing here, or `null`. */
  structure: TileKind | null;
  /** A water pipe is buried here. */
  pipe: boolean;
  /** Something is developed on this tile — a lot's building or a structure. */
  developed: boolean;
  powered: boolean;
  watered: boolean;
  abandoned: boolean;
}

/** One tile's strata, in the shape both engines' adapters decode their own state into. */
export interface TileStrata {
  terrain: Terrain;
  underground: number;
  surface: number;
  overhead: number;
  buildingId: number | undefined;
  /** Resolves a `building_id` to its template's `TileKind` — `undefined` if not live. */
  structureKindOf: (buildingId: number) => TileKind | undefined;
  powered: boolean;
  watered: boolean;
  abandoned: boolean;
}

function zoneKindOf(zone: Occupant | undefined): TileKind | null {
  switch (zone) {
    case Occupant.ZoneResidential:
      return TileKind.Residential;
    case Occupant.ZoneCommercial:
      return TileKind.Commercial;
    case Occupant.ZoneIndustrial:
      return TileKind.Industrial;
    default:
      return null;
  }
}

/**
 * Read the facts out of one tile's strata.
 *
 * Both engines feed this same function: the Rust side hands it the occupant
 * bits decoded straight off `SimHost::tile_buffer`, the TypeScript side
 * hands it its own `Tile`'s `terrain`/`underground`/`surface`/`overhead`
 * fields directly. Neither side gets a bespoke reading of its own state, so
 * the mapping cannot be where a disagreement is hidden.
 */
export function factsFromTile(t: TileStrata): TileFacts {
  const zone = zoneOccupant(t.surface);
  const hasStructure = hasOccupant(t.surface, Occupant.Structure) && t.buildingId !== undefined;
  return {
    water: t.terrain === Terrain.Water,
    trees: hasOccupant(t.overhead, Occupant.Trees),
    road: hasOccupant(t.surface, Occupant.Road),
    rail: hasOccupant(t.surface, Occupant.Rail),
    line: hasOccupant(t.overhead, Occupant.PowerLine),
    zone: zoneKindOf(zone),
    structure: hasStructure ? t.structureKindOf(t.buildingId!) ?? null : null,
    pipe: hasOccupant(t.underground, Occupant.Pipe),
    developed: t.buildingId !== undefined,
    powered: t.powered,
    watered: t.watered,
    abandoned: t.abandoned
  };
}

/** One-line rendering of a tile's facts, for failure messages. */
export function describeFacts(f: TileFacts): string {
  const on: string[] = [];
  if (f.water) on.push('water');
  if (f.trees) on.push('trees');
  if (f.road) on.push('road');
  if (f.rail) on.push('rail');
  if (f.line) on.push('line');
  if (f.zone) on.push(`zone:${f.zone}`);
  if (f.structure) on.push(`structure:${f.structure}`);
  if (f.pipe) on.push('pipe');
  if (f.developed) on.push('developed');
  if (f.powered) on.push('powered');
  if (f.watered) on.push('watered');
  if (f.abandoned) on.push('abandoned');
  return on.length ? on.join('+') : 'bare';
}

/** The keys on which two readings of the same tile differ. */
export function factsDiff(a: TileFacts, b: TileFacts): (keyof TileFacts)[] {
  return (Object.keys(a) as (keyof TileFacts)[]).filter(k => a[k] !== b[k]);
}
