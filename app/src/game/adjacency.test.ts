// adjacency.test.ts — parity pins for the network-carrier predicates.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { createInitialState, getTile, setTile, TileKind } from './gameState';
import { Occupant, Terrain, hasOccupant, setTileOccupant } from './protocol/occupants';
import { isPowerCarrier, isWaterCarrier } from './adjacency';

/**
 * These are parity pins for `Tile::conducts` (`crates/city-sim-core/src/occupants.rs`),
 * kept from the days when the TS side ran its own copy of this logic as a
 * test-only oracle for the Rust engine (retired 2026-07-30, last version
 * preserved at commit `1f8140a`). `isPowerCarrier`/`isWaterCarrier` are still
 * live — the renderer and minimap read them directly — so the pins stay.
 */
describe('adjacency — a hydro line conducts in either spelling', () => {
  /**
   * Mirrors `Tile::conducts(Network::Power)` in
   * `crates/city-sim-core/src/occupants.rs`. `isPowerCarrier` used to ask
   * `kind === PowerLine` only, so a line was invisible whenever something else
   * owned the contested `kind` slot.
   */
  it('treats a line recorded only in powerOverlay as a power carrier', () => {
    const state = createInitialState(3, 3);
    setTile(state, 1, 1, TileKind.PowerLine);
    const tile = getTile(state, 1, 1)!;
    expect(hasOccupant(tile.overhead, Occupant.PowerLine)).toBe(true);

    // A tree planted over the line: the canopy joins the overhead stratum and
    // the line survives — `known_defect_trees_are_planted_through_a_live_hydro_line`.
    setTileOccupant(tile, Occupant.Trees, true);
    expect(isPowerCarrier(tile)).toBe(true);

    // Flooding it is the same story.
    setTileOccupant(tile, Occupant.Trees, false);
    tile.terrain = Terrain.Water;
    expect(isPowerCarrier(tile)).toBe(true);
  });
});

describe('adjacency — water carriers exclude hydro lines', () => {
  /**
   * `Tile::conducts(Network::Water)` was converted with an empty diff, and this
   * pins why: `Occupant::PowerLine` declares `NET_POWER` alone. A road carrying
   * a line still carries water, but that is the road's doing, not the line's,
   * so `isWaterCarrier` must not grow a `powerOverlay` clause to match
   * `isPowerCarrier`.
   */
  it('does not treat a hydro line as a water carrier, in either spelling', () => {
    const state = createInitialState(3, 3);
    setTile(state, 1, 1, TileKind.PowerLine);
    const tile = getTile(state, 1, 1)!;
    expect(isPowerCarrier(tile)).toBe(true);
    expect(isWaterCarrier(tile)).toBe(false);

    setTileOccupant(tile, Occupant.Trees, true); // canopy joins the line, doesn't replace it
    expect(isPowerCarrier(tile)).toBe(true);
    expect(isWaterCarrier(tile)).toBe(false);
  });

  it('carries water along pipes, transport and zones', () => {
    const state = createInitialState(4, 4);

    const piped = getTile(state, 0, 0)!;
    setTileOccupant(piped, Occupant.Pipe, true);
    expect(isWaterCarrier(piped)).toBe(true);

    setTile(state, 1, 0, TileKind.Road);
    expect(isWaterCarrier(getTile(state, 1, 0))).toBe(true);

    setTile(state, 2, 0, TileKind.Rail);
    expect(isWaterCarrier(getTile(state, 2, 0))).toBe(true);

    setTile(state, 3, 0, TileKind.Commercial);
    expect(isWaterCarrier(getTile(state, 3, 0))).toBe(true);

    // A road that later had a line strung over it keeps carrying water, because
    // the road survives on the surface — the line lives overhead.
    setTileOccupant(getTile(state, 1, 0)!, Occupant.PowerLine, true);
    expect(hasOccupant(getTile(state, 1, 0)!.surface, Occupant.Road)).toBe(true);
    expect(isWaterCarrier(getTile(state, 1, 0))).toBe(true);

    // Bare land carries nothing.
    setTile(state, 0, 1, TileKind.Land);
    expect(isWaterCarrier(getTile(state, 0, 1))).toBe(false);
  });
});
