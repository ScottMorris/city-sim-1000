// water.ts — water-source connectivity check used by the debug overlay.
//
// The BFS that used to compute `watered` flags for the whole grid
// (`recomputeWaterNetwork`) ran only in the TS shadow engine that mirrored
// `crates/city-sim-core`'s water system for the test oracle; production
// water flow is computed in Rust. `hasWaterSourceConnection` survives
// because `debugStats.ts` still uses it to report a pump/tower's own
// connectivity in the debug overlay.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { GameState } from '../gameState';
import { getOrthogonalNeighbourCoords, isWaterCarrier } from '../adjacency';

function getIndex(state: GameState, x: number, y: number) {
  return y * state.width + x;
}

export function hasWaterSourceConnection(
  state: GameState,
  origin: { x: number; y: number },
  footprint: { width: number; height: number },
  buildingId?: number
) {
  for (let dy = 0; dy < footprint.height; dy++) {
    for (let dx = 0; dx < footprint.width; dx++) {
      const x = origin.x + dx;
      const y = origin.y + dy;
      for (const [nx, ny] of getOrthogonalNeighbourCoords(state, x, y)) {
        const neighbour = state.tiles[getIndex(state, nx, ny)];
        if (!neighbour) continue;
        if (buildingId !== undefined && neighbour.buildingId === buildingId) continue;
        if (isWaterCarrier(neighbour)) return true;
      }
    }
  }
  return false;
}
