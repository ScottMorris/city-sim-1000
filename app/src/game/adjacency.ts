// adjacency.ts — orthogonal neighbour queries: road access, network carriers.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { GameState, Tile, TileKind, getTile } from './gameState';

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

/**
 * Returns true if any orthogonal neighbour of (x, y) carries traffic — that is,
 * has a road, whether recorded as `kind` or as `roadUnderlay`.
 *
 * Mirrors `has_road_access()` in `crates/city-sim-core/src/adjacency.rs`, which
 * asks `Tile::conducts(Network::Traffic)`.
 *
 * **Behaviour change, step 2 of #177.** This used to accept a third case,
 * `kind === TileKind.PowerLine`. That clause was compensation, not a rule: when
 * a hydro line is strung over a road the tile is recorded `kind = PowerLine` +
 * `roadUnderlay`, and its author was reaching for the road hidden underneath.
 * It reached too far — a *bare* hydro line across open country granted road
 * access to every zone beside it, so lots grew, filled and paid tax with no
 * street. The road-under-a-line case answers through `roadUnderlay` with no
 * special case at all. A hydro line is not a road.
 */
export function hasRoadAccess(state: GameState, x: number, y: number): boolean {
  return getOrthogonalNeighbourCoords(state, x, y).some(([nx, ny]) => {
    const neighbour = getTile(state, nx, ny);
    return neighbour?.kind === TileKind.Road || neighbour?.roadUnderlay === true;
  });
}

export function isZone(tile: Tile | undefined): boolean {
  if (!tile) return false;
  return (
    tile.kind === TileKind.Residential ||
    tile.kind === TileKind.Commercial ||
    tile.kind === TileKind.Industrial
  );
}

export function isFrontierZone(state: GameState, x: number, y: number): boolean {
  const tile = getTile(state, x, y);
  if (!isZone(tile)) return false;
  return getOrthogonalNeighbourCoords(state, x, y).some(([nx, ny]) => {
    const neighbour = getTile(state, nx, ny);
    return !isZone(neighbour);
  });
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
  if (tile.powerPlantType) return true;
  if (tile.buildingId !== undefined) return true;
  if (tile.kind === TileKind.PowerLine || tile.powerOverlay) return true;
  if (tile.kind === TileKind.Road || tile.roadUnderlay) return true;
  if (tile.kind === TileKind.Rail || tile.railUnderlay) return true;
  if (isZone(tile)) {
    return true;
  }
  return false;
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
  if (tile.underground === TileKind.WaterPipe) return true;
  if (tile.buildingId !== undefined) return true; // Buildings carry water
  if (tile.kind === TileKind.Road || tile.roadUnderlay) return true;
  if (tile.kind === TileKind.Rail || tile.railUnderlay) return true;
  if (isZone(tile)) return true;
  return false;
}

/**
 * Returns true if the tile is powered or has an orthogonally adjacent powered carrier.
 */
export function tileHasPower(state: GameState, x: number, y: number): boolean {
  const tile = getTile(state, x, y);
  if (!tile) return false;
  if (tile.powered) return true;
  return getOrthogonalNeighbourCoords(state, x, y).some(([nx, ny]) => {
    const neighbour = getTile(state, nx, ny);
    return neighbour?.powered && isPowerCarrier(neighbour);
  });
}

/**
 * Returns true if the tile is watered or has an orthogonally adjacent watered carrier.
 */
export function tileHasWater(state: GameState, x: number, y: number): boolean {
  const tile = getTile(state, x, y);
  if (!tile) return false;
  if (tile.watered) return true;
  return getOrthogonalNeighbourCoords(state, x, y).some(([nx, ny]) => {
    const neighbour = getTile(state, nx, ny);
    return neighbour?.watered && isWaterCarrier(neighbour);
  });
}

/**
 * Returns true if a zone tile can reach a road by walking orthogonally through other zone tiles.
 */
export function zoneHasRoadPath(state: GameState, startX: number, startY: number): boolean {
  const start = getTile(state, startX, startY);
  if (!isZone(start)) return false;
  if (hasRoadAccess(state, startX, startY)) return true;
  const visited = new Set<number>();
  const queue: Array<[number, number]> = [[startX, startY]];
  const toIndex = (x: number, y: number) => y * state.width + x;
  while (queue.length) {
    const [x, y] = queue.shift()!;
    for (const [nx, ny] of getOrthogonalNeighbourCoords(state, x, y)) {
      const idx = toIndex(nx, ny);
      if (visited.has(idx)) continue;
      visited.add(idx);
      const neighbour = getTile(state, nx, ny);
      if (!isZone(neighbour)) continue;
      if (hasRoadAccess(state, nx, ny)) return true;
      queue.push([nx, ny]);
    }
  }
  return false;
}
