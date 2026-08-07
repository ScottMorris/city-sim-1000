// adjacency.ts — orthogonal neighbour queries: zone/network-carrier predicates.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { GameState, Tile } from './gameState';
import { Network, conducts, tileOccupants, zoneOccupant } from './protocol/occupants';

const ORTHOGONAL_DIRS: Array<[number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0]
];

export function getOrthogonalNeighbourCoords(
  state: GameState,
  x: number,
  y: number
): Array<[number, number]> {
  const coords: Array<[number, number]> = [];
  for (const [dx, dy] of ORTHOGONAL_DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= state.width || ny >= state.height) continue;
    coords.push([nx, ny]);
  }
  return coords;
}

export function isZone(tile: Tile | undefined): boolean {
  if (!tile) return false;
  return zoneOccupant(tile.surface) !== undefined;
}

/**
 * Whether power flows *through* this tile.
 *
 * Mirrors `Tile::conducts(Network::Power)` in
 * `crates/city-sim-core/src/occupants.rs`.
 *
 * **Behaviour change, step 2 of #177.** The hydro-line clause used to ask
 * `kind === TileKind.PowerLine` and nothing else, so a line was only visible to
 * the BFS when it happened to own the contested `kind` slot. A line recorded
 * only in `powerOverlay` — the spelling `Tool.PowerLine` leaves on a zoned tile,
 * and the one a tree or a flood leaves behind in the engine — silently severed
 * the grid while the tile kept being billed for a power line every day.
 */
export function isPowerCarrier(tile: Tile | undefined): boolean {
  if (!tile) return false;
  return conducts(
    Network.Power,
    tileOccupants(tile.underground, tile.surface, tile.overhead),
    tile.buildingId
  );
}

/**
 * Whether water flows *through* this tile.
 *
 * Mirrors `Tile::conducts(Network::Water)` in
 * `crates/city-sim-core/src/occupants.rs`. Unchanged by step 2 of #177, and
 * deliberately so: a buried pipe is already read out of `underground` and both
 * transport underlays out of their flags, so there is no `kind`-only hole to
 * close. A hydro line is *not* on this list — a road carrying a line still
 * carries water, but that is the road's doing, not the line's, so nothing here
 * consults `powerOverlay`.
 */
export function isWaterCarrier(tile: Tile | undefined): boolean {
  if (!tile) return false;
  return conducts(
    Network.Water,
    tileOccupants(tile.underground, tile.surface, tile.overhead),
    tile.buildingId
  );
}
