// minimap.test.ts — minimapBaseColour against every rung of the base-mode ladder.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { createInitialState, getTile, setTile, TileKind } from '../game/gameState';
import { PowerPlantType } from '../game/constants';
import { createBuildingState } from '../game/buildings/state';
import { getBuildingTemplate } from '../game/buildings/templates';
import { Occupant, Terrain, setTileOccupant } from '../game/protocol/occupants';
import { createBuildingLookup, type BuildingLookup } from '../rendering/tileRenderUtils';
import { OCCUPANT_COLOURS, TERRAIN_COLOURS } from '../rendering/sprites';
import { minimapBaseColour } from './minimap';

const emptyLookup: BuildingLookup = new Map();

describe('minimapBaseColour', () => {
  it('paints plain land with the land colour when nothing occupies the tile', () => {
    const state = createInitialState(3, 3);
    const tile = getTile(state, 1, 1)!;
    tile.terrain = Terrain.Land; // procedural generation may have placed water here
    expect(minimapBaseColour(tile, emptyLookup)).toBe(TERRAIN_COLOURS[Terrain.Land]);
  });

  it('paints water when nothing else is on the tile', () => {
    const state = createInitialState(3, 3);
    const tile = getTile(state, 1, 1)!;
    tile.terrain = Terrain.Water;
    expect(minimapBaseColour(tile, emptyLookup)).toBe(TERRAIN_COLOURS[Terrain.Water]);
  });

  it('still lets a road bit override water — the deleted legacyFlags never special-cased terrain, only kind', () => {
    // Pure bit logic, not a reachable game state (you can't build a road on
    // water): the deleted `legacyFlags.roadUnderlay` was `hasOccupant(road)
    // && kind !== Road`, and a water tile's `kind` is always `Water`, never
    // `Road` — so a road bit surviving alongside water terrain still wins
    // the display slot, exactly as it would for any other non-Road winner.
    // `minimapBaseColour`'s "winner exists" branch reproduces that by design.
    const state = createInitialState(3, 3);
    setTile(state, 1, 1, TileKind.Road);
    const tile = getTile(state, 1, 1)!;
    tile.terrain = Terrain.Water; // override, after setTile forced it to Land
    expect(minimapBaseColour(tile, emptyLookup)).toBe(OCCUPANT_COLOURS[Occupant.Road]);
  });

  it('paints a resolved structure with its building template colour', () => {
    const state = createInitialState(3, 3);
    const tile = getTile(state, 1, 1)!;
    tile.terrain = Terrain.Land;
    tile.buildingId = 1;
    setTileOccupant(tile, Occupant.Structure, true);
    state.buildings.push({
      id: 1, templateId: PowerPlantType.Coal, origin: { x: 1, y: 1 }, state: createBuildingState()
    });
    const { buildingLookup } = createBuildingLookup(state);
    expect(minimapBaseColour(tile, buildingLookup)).toBe(getBuildingTemplate(PowerPlantType.Coal)!.colour);
  });

  it('falls through past a failed structure lookup to the next present rung (a stale/missing buildingId)', () => {
    // `Occupant.Structure` doesn't conflict with `Occupant.Trees` (unlike
    // road/rail/zone tags, see `occupants.ts`'s `CONFLICTS`), so this is a
    // reachable combination: a stale `buildingId` a save/undo left behind on
    // a tile that also has tree canopy.
    const state = createInitialState(3, 3);
    setTile(state, 1, 1, TileKind.Tree);
    const tile = getTile(state, 1, 1)!;
    setTileOccupant(tile, Occupant.Structure, true);
    tile.buildingId = 404; // no matching entry in state.buildings
    const { buildingLookup } = createBuildingLookup(state);
    expect(minimapBaseColour(tile, buildingLookup)).toBe(OCCUPANT_COLOURS[Occupant.Trees]);
  });

  it('falls all the way through to land when a Structure occupant has no buildingId at all', () => {
    const state = createInitialState(3, 3);
    const tile = getTile(state, 1, 1)!;
    tile.terrain = Terrain.Land;
    setTileOccupant(tile, Occupant.Structure, true); // no buildingId
    expect(minimapBaseColour(tile, emptyLookup)).toBe(TERRAIN_COLOURS[Terrain.Land]);
  });

  it('paints a zone tag with its zone colour', () => {
    const state = createInitialState(3, 3);
    setTile(state, 1, 1, TileKind.Commercial);
    const tile = getTile(state, 1, 1)!;
    expect(minimapBaseColour(tile, emptyLookup)).toBe(OCCUPANT_COLOURS[Occupant.ZoneCommercial]);
  });

  it('paints tree canopy with the tree colour', () => {
    const state = createInitialState(3, 3);
    setTile(state, 1, 1, TileKind.Tree);
    const tile = getTile(state, 1, 1)!;
    expect(minimapBaseColour(tile, emptyLookup)).toBe(OCCUPANT_COLOURS[Occupant.Trees]);
  });

  it('paints a power line above everything, even a zone tag on the same tile', () => {
    // A developed zone lot is the one case a live `PowerLine` occupant and a
    // zone tag coexist (a `Structure` occupant refuses to place over a line,
    // but a zone's own occupant doesn't) — see `tileRenderUtils.ts`'s
    // `isDevelopedZone`.
    const state = createInitialState(3, 3);
    setTile(state, 1, 1, TileKind.Residential);
    const tile = getTile(state, 1, 1)!;
    setTileOccupant(tile, Occupant.PowerLine, true);
    expect(minimapBaseColour(tile, emptyLookup)).toBe(OCCUPANT_COLOURS[Occupant.PowerLine]);
  });

  it('paints a power line above a rail/road-carrying tile too', () => {
    const state = createInitialState(3, 3);
    setTile(state, 1, 1, TileKind.Road);
    const tile = getTile(state, 1, 1)!;
    setTileOccupant(tile, Occupant.PowerLine, true);
    expect(minimapBaseColour(tile, emptyLookup)).toBe(OCCUPANT_COLOURS[Occupant.PowerLine]);
  });

  it('paints rail with the rail colour when nothing outranks it', () => {
    const state = createInitialState(3, 3);
    setTile(state, 1, 1, TileKind.Rail);
    const tile = getTile(state, 1, 1)!;
    expect(minimapBaseColour(tile, emptyLookup)).toBe(OCCUPANT_COLOURS[Occupant.Rail]);
  });

  it('paints road with the road colour when nothing outranks it', () => {
    const state = createInitialState(3, 3);
    setTile(state, 1, 1, TileKind.Road);
    const tile = getTile(state, 1, 1)!;
    expect(minimapBaseColour(tile, emptyLookup)).toBe(OCCUPANT_COLOURS[Occupant.Road]);
  });

  it('paints a level crossing (rail and road both present) with the road colour — the pinned pixel', () => {
    // `e2e/visual.spec.ts`'s `d-minimap.png` asserts this exact pixel at zero
    // threshold: a bare crossing's `legacyKind` was always `Rail` (rail
    // outranks road in the deleted precedence ladder), so `roadUnderlay` was
    // the one that fired, not `railUnderlay` — the crossing paints as road,
    // not rail.
    const state = createInitialState(3, 3);
    setTile(state, 1, 1, TileKind.Road);
    const tile = getTile(state, 1, 1)!;
    setTileOccupant(tile, Occupant.Rail, true);
    expect(minimapBaseColour(tile, emptyLookup)).toBe(OCCUPANT_COLOURS[Occupant.Road]);
  });

  it('paints rail over the winner colour when rail rides along with a rung that outranks it (tree canopy)', () => {
    // `Occupant.Trees` doesn't conflict with `Occupant.Rail` (see
    // `occupants.ts`'s `CONFLICTS`), so a tile can carry both — proving the
    // rail-before-road check inside the "winner exists" branch, not just the
    // "no winner" branch below it.
    const state = createInitialState(3, 3);
    setTile(state, 1, 1, TileKind.Tree);
    const tile = getTile(state, 1, 1)!;
    setTileOccupant(tile, Occupant.Rail, true);
    expect(minimapBaseColour(tile, emptyLookup)).toBe(OCCUPANT_COLOURS[Occupant.Rail]);
  });

  it('paints road over the winner colour when only road (not rail) rides along with tree canopy', () => {
    const state = createInitialState(3, 3);
    setTile(state, 1, 1, TileKind.Tree);
    const tile = getTile(state, 1, 1)!;
    setTileOccupant(tile, Occupant.Road, true);
    expect(minimapBaseColour(tile, emptyLookup)).toBe(OCCUPANT_COLOURS[Occupant.Road]);
  });
});
