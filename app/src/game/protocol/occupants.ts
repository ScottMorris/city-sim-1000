// occupants.ts — TS mirror of crates/city-sim-core/src/occupants.rs's occupant/stratum model.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/**
 * A physical layer of the map. Depth/height ordering is the discriminant
 * order: underground → surface → overhead. Mirrors `Stratum` in
 * `occupants.rs`.
 */
export enum Stratum {
  Underground = 0,
  Surface = 1,
  Overhead = 2
}

/**
 * One thing that can occupy a tile. Discriminants are absolute bit positions
 * in an `OccupantSet` (a `number` used as a bitset here, matching Rust's
 * `u16`), grouped by stratum. **Never reorder these** — they must stay in
 * lockstep with `Occupant` in `crates/city-sim-core/src/occupants.rs`, and
 * with the wire byte layout in `tileBuffer.ts`.
 */
export enum Occupant {
  // --- Underground: bits 0-2 ---
  Pipe = 0,
  /** Reserved. No tool or TileKind exists for this yet. */
  Subway = 1,
  /** Reserved. No tool or TileKind exists for this yet. */
  Fibre = 2,
  // --- Surface: bits 3-8 ---
  Road = 3,
  Rail = 4,
  ZoneResidential = 5,
  ZoneCommercial = 6,
  ZoneIndustrial = 7,
  Structure = 8,
  // --- Overhead: bits 9-10 ---
  PowerLine = 9,
  Trees = 10
}

/** Number of occupants defined. Bits 11-15 of an OccupantSet are spare. */
export const OCCUPANT_COUNT = 11;

/** Every occupant, in bit order. */
export const ALL_OCCUPANTS: readonly Occupant[] = [
  Occupant.Pipe,
  Occupant.Subway,
  Occupant.Fibre,
  Occupant.Road,
  Occupant.Rail,
  Occupant.ZoneResidential,
  Occupant.ZoneCommercial,
  Occupant.ZoneIndustrial,
  Occupant.Structure,
  Occupant.PowerLine,
  Occupant.Trees
];

/** Bits 0-2. */
export const UNDERGROUND_MASK = (1 << Occupant.Pipe) | (1 << Occupant.Subway) | (1 << Occupant.Fibre);
/** Bits 3-8. */
export const SURFACE_MASK =
  (1 << Occupant.Road) |
  (1 << Occupant.Rail) |
  (1 << Occupant.ZoneResidential) |
  (1 << Occupant.ZoneCommercial) |
  (1 << Occupant.ZoneIndustrial) |
  (1 << Occupant.Structure);
/** Bits 9-10. */
export const OVERHEAD_MASK = (1 << Occupant.PowerLine) | (1 << Occupant.Trees);
/** The three zone tags — a tile carries at most one. */
export const ZONE_MASK = (1 << Occupant.ZoneResidential) | (1 << Occupant.ZoneCommercial) | (1 << Occupant.ZoneIndustrial);

/** The stratum an occupant belongs to. */
export function strataOf(occupant: Occupant): Stratum {
  const bit = 1 << occupant;
  if (bit & UNDERGROUND_MASK) return Stratum.Underground;
  if (bit & SURFACE_MASK) return Stratum.Surface;
  return Stratum.Overhead;
}

/** Whether `set` (a bitset over `Occupant`) contains `occupant`. */
export function hasOccupant(set: number, occupant: Occupant): boolean {
  return (set & (1 << occupant)) !== 0;
}

/** `set` with `occupant`'s bit set or cleared. */
export function withOccupant(set: number, occupant: Occupant, on: boolean): number {
  return on ? set | (1 << occupant) : set & ~(1 << occupant);
}

/** Every occupant present in `set`, in bit order. */
export function iterSet(set: number): Occupant[] {
  return ALL_OCCUPANTS.filter((o) => hasOccupant(set, o));
}

/**
 * The tile's land use, if it is zoned. Zones are mutually exclusive, and all
 * three are surface occupants. Mirrors `Tile::zone_occupant` in Rust.
 */
export function zoneOccupant(surface: number): Occupant | undefined {
  const bits = surface & ZONE_MASK;
  if (bits === 1 << Occupant.ZoneResidential) return Occupant.ZoneResidential;
  if (bits === 1 << Occupant.ZoneCommercial) return Occupant.ZoneCommercial;
  if (bits === 1 << Occupant.ZoneIndustrial) return Occupant.ZoneIndustrial;
  return undefined;
}

/** What the ground itself is, as distinct from anything occupying it. Mirrors `Terrain` in `occupants.rs`. */
export enum Terrain {
  Land = 0,
  Water = 1
}

/** Zone density. Mirrors `ZoneDensity` in `state.rs`. Not read by any system yet. */
export enum ZoneDensity {
  Low = 0,
  Medium = 1,
  High = 2
}

/** A network an occupant may conduct. Mirrors `Network` in `occupants.rs`. */
export enum Network {
  Power = 0,
  Water = 1,
  Traffic = 2
}

/** Occupant bits that conduct `Network.Power` by their own nature — mirrors each `OccupantDef.conducts` entry in `OCCUPANT_DEFS`. */
const NET_POWER_MASK =
  (1 << Occupant.Road) |
  (1 << Occupant.Rail) |
  (1 << Occupant.ZoneResidential) |
  (1 << Occupant.ZoneCommercial) |
  (1 << Occupant.ZoneIndustrial) |
  (1 << Occupant.PowerLine);

/** Occupant bits that conduct `Network.Water` by their own nature. */
const NET_WATER_MASK =
  (1 << Occupant.Pipe) |
  (1 << Occupant.Road) |
  (1 << Occupant.Rail) |
  (1 << Occupant.ZoneResidential) |
  (1 << Occupant.ZoneCommercial) |
  (1 << Occupant.ZoneIndustrial);

/** Occupant bits that conduct `Network.Traffic` by their own nature. Road only — no transit network exists yet, and rail is deliberately excluded (see `Occupant::Rail`'s `conducts` note in `occupants.rs`). */
const NET_TRAFFIC_MASK = 1 << Occupant.Road;

/** The union of everything on the tile — `underground | surface | overhead`. Mirrors `Tile::occupants` in Rust. */
export function tileOccupants(underground: number, surface: number, overhead: number): number {
  return underground | surface | overhead;
}

/**
 * Whether a tile carries `network`, given its occupant bits and whether it is
 * developed. Mirrors `Tile::conducts` in `occupants.rs`: a developed lot
 * conducts power/water by virtue of being developed — a property of the
 * development, not of any occupant — which is why `Structure` itself
 * declares `NET_NONE` in `OCCUPANT_DEFS` and this function still needs
 * `buildingId`/`isPowerPlant` passed in alongside the occupant bits.
 */
export function conducts(
  network: Network,
  occupants: number,
  buildingId: number | undefined,
  isPowerPlant: boolean
): boolean {
  switch (network) {
    case Network.Power:
      return isPowerPlant || buildingId !== undefined || (occupants & NET_POWER_MASK) !== 0;
    case Network.Water:
      return buildingId !== undefined || (occupants & NET_WATER_MASK) !== 0;
    case Network.Traffic:
      return (occupants & NET_TRAFFIC_MASK) !== 0;
  }
}
