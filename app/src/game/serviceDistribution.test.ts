// serviceDistribution.test.ts — reachable-candidate search for the education ghost preview.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { createInitialState, setTile, TileKind } from './gameState';
import { getReachableZoneCandidates } from './serviceDistribution';

describe('serviceDistribution', () => {
  it('finds reachable zones through roads within a radius and sorts by distance', () => {
    const state = createInitialState(5, 5);
    // service origin at (1,1)
    setTile(state, 1, 1, TileKind.Road);
    setTile(state, 1, 2, TileKind.Road);
    setTile(state, 1, 3, TileKind.Residential); // reachable via road chain, distance 2
    setTile(state, 2, 1, TileKind.Road);
    setTile(state, 3, 1, TileKind.Commercial); // reachable via road chain, distance 2
    setTile(state, 4, 4, TileKind.Industrial); // outside radius / no path

    const candidates = getReachableZoneCandidates(
      state,
      { x: 1, y: 1 },
      { width: 1, height: 1 },
      2
    );
    const toIndex = (x: number, y: number) => y * state.width + x;
    const reachable = candidates.map(([idx]) => idx);

    expect(reachable).toContain(toIndex(1, 3));
    expect(reachable).toContain(toIndex(3, 1));
    expect(reachable).not.toContain(toIndex(4, 4));
    // All returned distances should be <= radius and sorted
    const distances = candidates.map(([, d]) => d);
    expect(distances.every((d, i, arr) => d <= 2 && (i === 0 || d >= arr[i - 1]))).toBe(true);
  });
});
