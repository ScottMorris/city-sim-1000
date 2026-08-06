// sprites.ts — tile size constant and the flat-colour fallback palettes, split by axis.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { Occupant, Terrain } from '../game/protocol/occupants';

export const TILE_SIZE = 28;

/** The ground itself — independent of anything occupying it. */
export const TERRAIN_COLOURS: Record<Terrain, number> = {
  [Terrain.Land]: 0x345c3d,
  [Terrain.Water]: 0x234c7f
};

/** Flat-colour fallback per occupant, for the occupants that can win a
 *  tile's display colour on their own (rather than through a
 *  `BuildingTemplate.colour` lookup) — trees, transport, power lines, and
 *  the three zone tags. Structures resolve through their template instead
 *  (see `BuildingTemplate.colour`), so `Occupant.Structure` has no entry
 *  here. */
export const OCCUPANT_COLOURS: Partial<Record<Occupant, number>> = {
  [Occupant.Trees]: 0x3c7a4b,
  [Occupant.Road]: 0x7f8894,
  [Occupant.Rail]: 0x8c6b3e,
  [Occupant.ZoneResidential]: 0xb3e675,
  [Occupant.ZoneCommercial]: 0x5bc0eb,
  [Occupant.ZoneIndustrial]: 0xf08c42,
  [Occupant.PowerLine]: 0xe9d985
};
