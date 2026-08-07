// serviceDistribution.ts — reachable-zone search for service allocators (the education ghost preview).
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// Used to also carry `computeZoneLoads`/`estimateZoneLoad`, a TS estimate of
// per-zone population/job load shares — dead code with no caller once the
// education overlay's placed-school case moved to the wire's own per-tile
// `services.served`/`scores` (`servedZoneTiles` in `education.ts`, `#200`'s
// wire-adoption follow-up); deleted rather than kept as an unused estimator.
// `getReachableZoneCandidates` remains: the ghost preview for a
// not-yet-placed school still has no engine equivalent to call.

import { getOrthogonalNeighbourCoords, isZone } from './adjacency';
import type { GameState, Tile } from './gameState';
import { getTile } from './gameState';
import { Occupant, hasOccupant } from './protocol/occupants';

function isRoadish(tile: Tile | undefined): boolean {
  if (!tile) return false;
  return hasOccupant(tile.surface, Occupant.Road);
}

export type ReachableZoneCandidates = Array<[index: number, distance: number]>;

/**
 * Walk roads/zones out from a service footprint to find reachable zone indices,
 * recording distance for capacity allocation ordering.
 */
export function getReachableZoneCandidates(
  state: GameState,
  origin: { x: number; y: number },
  footprint: { width: number; height: number },
  radius: number
): ReachableZoneCandidates {
  const reachable = new Map<number, number>();
  const queue: Array<{ x: number; y: number; d: number }> = [];
  const visited = new Set<number>();

  for (let dy = 0; dy < footprint.height; dy++) {
    for (let dx = 0; dx < footprint.width; dx++) {
      queue.push({ x: origin.x + dx, y: origin.y + dy, d: 0 });
    }
  }

  const toIndex = (x: number, y: number) => y * state.width + x;

  while (queue.length) {
    const { x, y, d } = queue.shift()!;
    if (d > radius) continue;
    const idx = toIndex(x, y);
    if (visited.has(idx)) continue;
    visited.add(idx);
    const tile = getTile(state, x, y);
    const isRoad = isRoadish(tile);
    const isServedZone = isZone(tile);

    if (isServedZone) {
      const existing = reachable.get(idx);
      reachable.set(idx, existing !== undefined ? Math.min(existing, d) : d);
    }

    // Travel along roads and through zones so interior lots can be served inside a radius.
    if (!isRoad && !isServedZone && d > 0) continue;

    for (const [nx, ny] of getOrthogonalNeighbourCoords(state, x, y)) {
      const nd = d + 1;
      if (nd > radius) continue;
      const neighbour = getTile(state, nx, ny);
      if (isRoadish(neighbour) || isZone(neighbour)) {
        queue.push({ x: nx, y: ny, d: nd });
      }
    }
  }

  return Array.from(reachable.entries()).sort((a, b) => a[1] - b[1]);
}
