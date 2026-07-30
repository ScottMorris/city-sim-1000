// adjacency.test.ts — parity pins for the road-access and network-carrier predicates.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { createInitialState, getTile, setTile, TileKind } from './gameState';
import { Tool } from './toolTypes';
import { applyTool } from './tools';
import { recomputePowerNetwork } from './utilities/power';
import { Occupant, Terrain, hasOccupant, setTileOccupant } from './protocol/occupants';
import {
  hasRoadAccess,
  isPowerCarrier,
  isWaterCarrier,
  tileHasPower,
  zoneHasRoadPath
} from './adjacency';

/**
 * `simulation.ts` and these helpers are the test-only parity oracle for
 * `crates/city-sim-core`. Step 2 of #177 narrowed two predicates on the Rust
 * side and the TS copies were not mirrored, which nothing caught: the only TS
 * tests that touched `powerOverlay` were rendering and tool tests, so no test
 * ever built an overlay-spelled hydro line and asked a carrier question about
 * it. These are those tests.
 */
describe('adjacency — road access is roads only', () => {
  /**
   * Mirrors `a_bare_hydro_line_does_not_give_road_access` in
   * `crates/city-sim-core/src/adjacency.rs`.
   *
   * `hasRoadAccess` used to accept any neighbour whose `kind` was `PowerLine`,
   * so a zone strung with a line and no street grew, filled and paid tax.
   */
  it('does not grant road access from a bare hydro line', () => {
    const state = createInitialState(4, 3);
    state.money = 50000;
    applyTool(state, Tool.Residential, 0, 0);
    applyTool(state, Tool.PowerLine, 1, 0);

    const line = getTile(state, 1, 0)!;
    expect(hasOccupant(line.overhead, Occupant.PowerLine)).toBe(true);
    expect(hasOccupant(line.surface, Occupant.Road)).toBe(false); // no road under this line

    expect(hasRoadAccess(state, 0, 0)).toBe(false);
  });

  /**
   * The road *under* a line still grants access, whichever order it was built
   * in — that is what the deleted `kind === PowerLine` clause was really
   * compensating for, and `roadUnderlay` answers it without the special case.
   */
  it('keeps road access for a road buried under a hydro line, in either build order', () => {
    const lineFirst = createInitialState(4, 3);
    lineFirst.money = 50000;
    applyTool(lineFirst, Tool.Residential, 0, 0);
    applyTool(lineFirst, Tool.PowerLine, 1, 0);
    applyTool(lineFirst, Tool.Road, 1, 0);
    const lineFirstTile = getTile(lineFirst, 1, 0)!;
    expect(hasOccupant(lineFirstTile.overhead, Occupant.PowerLine)).toBe(true);
    expect(hasOccupant(lineFirstTile.surface, Occupant.Road)).toBe(true);
    expect(hasRoadAccess(lineFirst, 0, 0)).toBe(true);

    const roadFirst = createInitialState(4, 3);
    roadFirst.money = 50000;
    applyTool(roadFirst, Tool.Residential, 0, 0);
    applyTool(roadFirst, Tool.Road, 1, 0);
    applyTool(roadFirst, Tool.PowerLine, 1, 0);
    expect(hasRoadAccess(roadFirst, 0, 0)).toBe(true);
  });

  /**
   * A road standing underneath tree canopy and a hydro line all at once — not
   * reachable through any tool sequence (`Tool.Road`'s `regradeAt` always
   * clears the canopy), but a real combination the wire can carry, so
   * `hasRoadAccess` must still see the road through it.
   */
  it('grants road access through a road buried under trees and a hydro line', () => {
    const state = createInitialState(3, 3);
    applyTool(state, Tool.Residential, 0, 0);
    const neighbour = getTile(state, 1, 0)!;
    setTileOccupant(neighbour, Occupant.Road, true);
    setTileOccupant(neighbour, Occupant.Trees, true);
    setTileOccupant(neighbour, Occupant.PowerLine, true);

    expect(hasRoadAccess(state, 0, 0)).toBe(true);
  });

  /**
   * Where dropping the `PowerLine` clause actually reaches growth. A zone
   * directly beside a bare line is a frontier zone by construction, so it grows
   * either way; the tile that changes is the one deep inside a zone blob, which
   * used to reach a "road" through the chain — the bare line at the far end.
   *
   * Mirrors `a_zone_chain_ending_at_a_bare_line_is_not_a_road_path`.
   */
  it('does not treat a zone chain ending at a bare hydro line as a road path', () => {
    const state = createInitialState(5, 4);
    state.money = 50000;
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        applyTool(state, Tool.Residential, x, y);
      }
    }
    applyTool(state, Tool.PowerLine, 3, 1);

    expect(hasRoadAccess(state, 1, 1)).toBe(false);
    expect(zoneHasRoadPath(state, 1, 1)).toBe(false);

    // Pave the same tile and the chain is a road path again.
    applyTool(state, Tool.Road, 3, 1);
    expect(zoneHasRoadPath(state, 1, 1)).toBe(true);
  });
});

describe('adjacency — a hydro line conducts in either spelling', () => {
  /**
   * Mirrors `Tile::conducts(Network::Power)` in
   * `crates/city-sim-core/src/occupants.rs`. `isPowerCarrier` used to ask
   * `kind === PowerLine` only, so a line was invisible whenever something else
   * owned the contested `kind` slot.
   */
  it('treats a line recorded only in powerOverlay as a power carrier', () => {
    const state = createInitialState(3, 3);
    state.money = 50000;
    applyTool(state, Tool.PowerLine, 1, 1);
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

  /**
   * Mirrors `tile_has_power_via_a_line_in_the_overlay_flag`. The neighbour can
   * be flagged powered by the BFS and still refuse to hand the power on.
   */
  it('powers a tile from a powered neighbour whose line is only in the overlay', () => {
    const state = createInitialState(3, 3);
    applyTool(state, Tool.Residential, 0, 0);
    const neighbour = getTile(state, 1, 0)!;
    setTileOccupant(neighbour, Occupant.Trees, true);
    setTileOccupant(neighbour, Occupant.PowerLine, true);
    neighbour.powered = true;

    expect(tileHasPower(state, 0, 0)).toBe(true);
  });

  /**
   * End to end through the BFS in `utilities/power.ts`: a buried line is not a
   * broken line. Before the fix the flood fill stopped dead at (3, 0) while the
   * budget kept billing that tile for a power line every day.
   */
  it('floods power through a line buried under a tree', () => {
    const state = createInitialState(8, 4);
    state.money = 50000;
    applyTool(state, Tool.WindTurbine, 0, 0); // 2×2 from (0,0)
    for (let x = 2; x <= 5; x++) {
      applyTool(state, Tool.PowerLine, x, 0);
    }
    const buried = getTile(state, 3, 0)!;
    setTileOccupant(buried, Occupant.Trees, true); // canopy joins the line, doesn't replace it
    expect(hasOccupant(buried.overhead, Occupant.PowerLine)).toBe(true);

    recomputePowerNetwork(state);
    expect(getTile(state, 5, 0)?.powered).toBe(true);
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
    state.money = 50000;
    applyTool(state, Tool.PowerLine, 1, 1);
    const tile = getTile(state, 1, 1)!;
    expect(isPowerCarrier(tile)).toBe(true);
    expect(isWaterCarrier(tile)).toBe(false);

    setTileOccupant(tile, Occupant.Trees, true); // canopy joins the line, doesn't replace it
    expect(isPowerCarrier(tile)).toBe(true);
    expect(isWaterCarrier(tile)).toBe(false);
  });

  it('carries water along pipes, transport and zones', () => {
    const state = createInitialState(4, 4);
    state.money = 50000;

    const piped = getTile(state, 0, 0)!;
    setTileOccupant(piped, Occupant.Pipe, true);
    expect(isWaterCarrier(piped)).toBe(true);

    applyTool(state, Tool.Road, 1, 0);
    expect(isWaterCarrier(getTile(state, 1, 0))).toBe(true);

    applyTool(state, Tool.Rail, 2, 0);
    expect(isWaterCarrier(getTile(state, 2, 0))).toBe(true);

    applyTool(state, Tool.Commercial, 3, 0);
    expect(isWaterCarrier(getTile(state, 3, 0))).toBe(true);

    // A road that later had a line strung over it keeps carrying water, because
    // the road survives on the surface — the line lives overhead.
    applyTool(state, Tool.PowerLine, 1, 0);
    expect(hasOccupant(getTile(state, 1, 0)!.surface, Occupant.Road)).toBe(true);
    expect(isWaterCarrier(getTile(state, 1, 0))).toBe(true);

    // Bare land carries nothing.
    setTile(state, 0, 1, TileKind.Land);
    expect(isWaterCarrier(getTile(state, 0, 1))).toBe(false);
  });
});
