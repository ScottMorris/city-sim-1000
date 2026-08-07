// tileLabel.test.ts — occupantsByStratum against layered strata.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { createInitialState, getTile, setTile, TileKind } from '../gameState';
import { Occupant, Terrain, setTileOccupant } from './occupants';
import { createBuildingState } from '../buildings/state';
import { occupantsByStratum } from './tileLabel';

describe('occupantsByStratum', () => {
  it('reports an empty tile as empty in every stratum', () => {
    const state = createInitialState(3, 3);
    const tile = getTile(state, 1, 1)!;
    tile.terrain = Terrain.Land; // procedural generation may have placed water here
    expect(occupantsByStratum(state, tile)).toEqual({ underground: [], surface: [], overhead: [] });
  });

  it('lists a single surface occupant under "surface", nowhere else', () => {
    const state = createInitialState(3, 3);
    setTile(state, 1, 1, TileKind.Road);
    const tile = getTile(state, 1, 1)!;
    expect(occupantsByStratum(state, tile)).toEqual({ underground: [], surface: [TileKind.Road], overhead: [] });
  });

  it('keeps a road, a power line, and a pipe all visible on the same tile at once', () => {
    const state = createInitialState(3, 3);
    setTile(state, 1, 1, TileKind.Road);
    const tile = getTile(state, 1, 1)!;
    setTileOccupant(tile, Occupant.PowerLine, true);
    setTileOccupant(tile, Occupant.Pipe, true);

    expect(occupantsByStratum(state, tile)).toEqual({
      underground: [TileKind.WaterPipe],
      surface: [TileKind.Road],
      overhead: [TileKind.PowerLine],
    });
  });

  it('resolves a Structure occupant through the building instance', () => {
    const state = createInitialState(3, 3);
    const tile = getTile(state, 1, 1)!;
    tile.terrain = Terrain.Land; // procedural generation may have placed water here
    setTileOccupant(tile, Occupant.Structure, true);
    tile.buildingId = 7;
    state.buildings.push({
      id: 7, templateId: TileKind.WaterPump, origin: { x: 1, y: 1 }, state: createBuildingState(),
    });

    expect(occupantsByStratum(state, tile)).toEqual({ underground: [], surface: [TileKind.WaterPump], overhead: [] });
  });

  it('omits a Structure occupant whose building instance is missing (no TileKind to report)', () => {
    const state = createInitialState(3, 3);
    const tile = getTile(state, 1, 1)!;
    setTileOccupant(tile, Occupant.Structure, true);
    tile.buildingId = 404; // no matching entry in state.buildings

    expect(occupantsByStratum(state, tile)).toEqual({ underground: [], surface: [], overhead: [] });
  });

  it('labels a zone tag with its BuildingKind spelling, matching the TileKind vocabulary MCP scripts already use', () => {
    const state = createInitialState(3, 3);
    setTile(state, 1, 1, TileKind.Commercial);
    const tile = getTile(state, 1, 1)!;
    expect(occupantsByStratum(state, tile)).toEqual({ underground: [], surface: [TileKind.Commercial], overhead: [] });
  });
});
