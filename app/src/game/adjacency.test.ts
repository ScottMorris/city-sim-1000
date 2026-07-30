// adjacency.test.ts — parity pins for the road-access and network-carrier predicates.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { createInitialState, getTile, setTile, TileKind } from './gameState';
import { Tool } from './toolTypes';
import { applyTool } from './tools';
import { recomputePowerNetwork } from './utilities/power';
import { resyncTileStrata as resyncStrata } from './protocol/legacyProjection';
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
    expect(line.kind).toBe(TileKind.PowerLine);
    expect(line.roadUnderlay).toBeUndefined(); // no road under this line

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
    expect(getTile(lineFirst, 1, 0)?.kind).toBe(TileKind.PowerLine);
    expect(getTile(lineFirst, 1, 0)?.roadUnderlay).toBe(true);
    expect(hasRoadAccess(lineFirst, 0, 0)).toBe(true);

    const roadFirst = createInitialState(4, 3);
    roadFirst.money = 50000;
    applyTool(roadFirst, Tool.Residential, 0, 0);
    applyTool(roadFirst, Tool.Road, 1, 0);
    applyTool(roadFirst, Tool.PowerLine, 1, 0);
    expect(hasRoadAccess(roadFirst, 0, 0)).toBe(true);
  });

  /**
   * A road hidden under a hydro *overlay* — the spelling the engine sends over
   * the wire when a tree or a flood rewrites `kind` and leaves the overlay
   * standing. No `kind`-only test could see this tile.
   */
  it('grants road access through a road underlay beneath a power overlay', () => {
    const state = createInitialState(3, 3);
    applyTool(state, Tool.Residential, 0, 0);
    const neighbour = getTile(state, 1, 0)!;
    neighbour.kind = TileKind.Tree;
    neighbour.roadUnderlay = true;
    neighbour.powerOverlay = true;
    resyncStrata(neighbour);

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
    expect(tile.powerOverlay).toBe(true);

    // A tree planted over the line: the engine rewrites `kind` and the overlay
    // survives, so this is exactly what the display mirror receives.
    tile.kind = TileKind.Tree;
    expect(isPowerCarrier(tile)).toBe(true);

    // Flooding it is the same story.
    tile.kind = TileKind.Water;
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
    neighbour.kind = TileKind.Tree;
    neighbour.powerOverlay = true;
    neighbour.powered = true;
    resyncStrata(neighbour);

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
    buried.kind = TileKind.Tree; // overlay stands, kind is overwritten
    expect(buried.powerOverlay).toBe(true);

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

    tile.kind = TileKind.Tree; // overlay-only spelling
    expect(isPowerCarrier(tile)).toBe(true);
    expect(isWaterCarrier(tile)).toBe(false);
  });

  it('carries water along pipes, transport and zones', () => {
    const state = createInitialState(4, 4);
    state.money = 50000;

    const piped = getTile(state, 0, 0)!;
    piped.legacyUnderground = TileKind.WaterPipe;
    resyncStrata(piped);
    expect(isWaterCarrier(piped)).toBe(true);

    applyTool(state, Tool.Road, 1, 0);
    expect(isWaterCarrier(getTile(state, 1, 0))).toBe(true);

    applyTool(state, Tool.Rail, 2, 0);
    expect(isWaterCarrier(getTile(state, 2, 0))).toBe(true);

    applyTool(state, Tool.Commercial, 3, 0);
    expect(isWaterCarrier(getTile(state, 3, 0))).toBe(true);

    // A road that later had a line strung over it keeps carrying water, because
    // the road survives as an underlay.
    applyTool(state, Tool.PowerLine, 1, 0);
    expect(getTile(state, 1, 0)?.roadUnderlay).toBe(true);
    expect(isWaterCarrier(getTile(state, 1, 0))).toBe(true);

    // Bare land carries nothing.
    setTile(state, 0, 1, TileKind.Land);
    expect(isWaterCarrier(getTile(state, 0, 1))).toBe(false);
  });
});
