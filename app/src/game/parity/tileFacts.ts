// tileFacts.ts — the shared vocabulary both engines are compared in.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/**
 * A tile stated as *what is on it*, not as *how it is spelled*.
 *
 * The cross-language parity harness cannot compare representations: Rust holds
 * per-stratum occupant sets and TypeScript holds a single-valued `kind` plus
 * underlay/overlay flags. It compares **observations** instead — the same
 * questions the renderer, the minimap and the placement guards ask — and both
 * sides answer them from their own representation through
 * {@link factsFromWire}.
 *
 * Deliberately *not* compared: the raw wire `kind` byte. `display.rs` documents
 * three intended normalisations at that level (rail wins a level crossing, a
 * hydro line wins over bare ground, a bulldozed footprint stops being a ghost),
 * so a byte-for-byte comparison would fail on changes that are the point of
 * #177 rather than on drift. Those bytes are the visual-regression harness's
 * job. Every predicate here is spelling-agnostic and therefore invariant under
 * all three normalisations — if one of these disagrees, something real does.
 *
 * Also deliberately not compared: wilderness. It is excluded from the oracle by
 * design — `docs/features/wilderness-score.md`, decision 4.
 */

import { TileKind } from '../gameState';
import { FLAGS } from '../protocol/tileBuffer';

/** Zone tags, in the order the wire kind byte spells them. */
export const ZONE_KINDS: ReadonlySet<TileKind> = new Set([
  TileKind.Residential,
  TileKind.Commercial,
  TileKind.Industrial
]);

/** Every kind that is a placed structure with a footprint behind it. */
export const STRUCTURE_KINDS: ReadonlySet<TileKind> = new Set([
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

export interface TileFacts {
  /** The ground reads as water. */
  water: boolean;
  /** Tree canopy stands here. */
  trees: boolean;
  /** A carriageway runs through, in either spelling. */
  road: boolean;
  /** A railway runs through, in either spelling. */
  rail: boolean;
  /** A hydro line spans the tile, in either spelling. */
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

/**
 * Read the facts out of one v4-shaped `(kind, flags, buildingId, underground)`
 * quadruple.
 *
 * Both engines feed this same function: the Rust side hands it bytes straight
 * off `SimHost::tile_buffer` (derived by `display.rs`), the TypeScript side
 * hands it the equivalent fields off its `Tile`, whose `kind` *is* the v4 wire
 * byte. Neither side gets a bespoke reading of its own state, so the mapping
 * cannot be where a disagreement is hidden.
 */
export function factsFromWire(
  kind: TileKind,
  flagBits: number,
  buildingId: number,
  underground: TileKind | undefined
): TileFacts {
  return {
    water: kind === TileKind.Water,
    trees: kind === TileKind.Tree,
    road: kind === TileKind.Road || (flagBits & FLAGS.ROAD_UNDERLAY) !== 0,
    rail: kind === TileKind.Rail || (flagBits & FLAGS.RAIL_UNDERLAY) !== 0,
    line: kind === TileKind.PowerLine || (flagBits & FLAGS.POWER_OVERLAY) !== 0,
    zone: ZONE_KINDS.has(kind) ? kind : null,
    structure: STRUCTURE_KINDS.has(kind) ? kind : null,
    pipe: underground === TileKind.WaterPipe,
    developed: buildingId !== 0,
    powered: (flagBits & FLAGS.POWERED) !== 0,
    watered: (flagBits & FLAGS.WATERED) !== 0,
    abandoned: (flagBits & FLAGS.ABANDONED) !== 0
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
