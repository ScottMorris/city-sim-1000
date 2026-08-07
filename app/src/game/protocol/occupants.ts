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

interface TileStrata {
  underground: number;
  surface: number;
  overhead: number;
}

/**
 * Set or clear one occupant on the tile-shaped `strata`, in whichever
 * stratum field the occupant belongs to. Mirrors `Tile::set_occupant` in
 * Rust — the only write path into the strata, routed by the occupant's own
 * declaration rather than a stratum the caller names.
 */
export function setTileOccupant(strata: TileStrata, occupant: Occupant, on: boolean): void {
  switch (strataOf(occupant)) {
    case Stratum.Underground:
      strata.underground = withOccupant(strata.underground, occupant, on);
      return;
    case Stratum.Surface:
      strata.surface = withOccupant(strata.surface, occupant, on);
      return;
    case Stratum.Overhead:
      strata.overhead = withOccupant(strata.overhead, occupant, on);
      return;
  }
}

/**
 * Symmetric conflict masks, one per occupant — mirrors each `OccupantDef.conflicts`
 * entry in `OCCUPANT_DEFS` (`occupants.rs`). The set of occupants that cannot
 * share a tile with the key occupant.
 */
const CONFLICTS: Record<Occupant, number> = {
  [Occupant.Pipe]: 0,
  [Occupant.Subway]: 0,
  [Occupant.Fibre]: 0,
  [Occupant.Road]: SURFACE_MASK & ~((1 << Occupant.Road) | (1 << Occupant.Rail)),
  [Occupant.Rail]: SURFACE_MASK & ~((1 << Occupant.Road) | (1 << Occupant.Rail)),
  [Occupant.ZoneResidential]: SURFACE_MASK & ~(1 << Occupant.ZoneResidential),
  [Occupant.ZoneCommercial]: SURFACE_MASK & ~(1 << Occupant.ZoneCommercial),
  [Occupant.ZoneIndustrial]: SURFACE_MASK & ~(1 << Occupant.ZoneIndustrial),
  [Occupant.Structure]: (SURFACE_MASK & ~(1 << Occupant.Structure)) | (1 << Occupant.PowerLine),
  // Trees + PowerLine officially coexist — the overhead stratum's one exception,
  // same shape as the level crossing on Surface. See `COMPAT_EXCEPTIONS` in `occupants.rs`.
  [Occupant.PowerLine]: 1 << Occupant.Structure,
  [Occupant.Trees]: 0
};

/**
 * Whether `a` and `b` cannot share a tile. Mirrors `pair_conflicts` in
 * `occupants.rs`. Always `false` for an occupant against itself — a set
 * holds at most one of each.
 */
export function pairConflicts(a: Occupant, b: Occupant): boolean {
  return a !== b && (CONFLICTS[a] & (1 << b)) !== 0;
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
 * `buildingId` passed in alongside the occupant bits.
 *
 * Rust's `Tile::conducts` also checks `power_plant_mw > 0` for `Network::
 * Power` — a real field on Rust's `Tile`. There is no TS equivalent: the
 * wire buffer decodes `buildingId` per footprint tile (`tileBuffer.ts`), so
 * a power plant's tiles already conduct via `buildingId !== undefined`
 * before that check would ever matter; a TS-side `isPowerPlant` param would
 * be constant-`false` at every call site (nothing wire-decodes it), so it
 * doesn't exist here.
 */
export function conducts(
  network: Network,
  occupants: number,
  buildingId: number | undefined
): boolean {
  switch (network) {
    case Network.Power:
      return buildingId !== undefined || (occupants & NET_POWER_MASK) !== 0;
    case Network.Water:
      return buildingId !== undefined || (occupants & NET_WATER_MASK) !== 0;
    case Network.Traffic:
      return (occupants & NET_TRAFFIC_MASK) !== 0;
  }
}
