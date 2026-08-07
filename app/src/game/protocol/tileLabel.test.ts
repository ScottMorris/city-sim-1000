// tileLabel.test.ts — dominantOccupantLabel/occupantsByStratum against layered strata.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { createInitialState, getTile, setTile, TileKind } from '../gameState';
import { Occupant, Terrain, setTileOccupant } from './occupants';
import { createBuildingState } from '../buildings/state';
import { dominantOccupantLabel, occupantsByStratum } from './tileLabel';

describe('occupantsByStratum', () => {
  it('reports an empty tile as empty in every stratum', () => {
    const state = createInitialState(3, 3);
    const tile = getTile(state, 1, 1)!;
    tile.terrain = Terrain.Land; // procedural generation may have placed water here
    expect(occupantsByStratum(state, tile)).toEqual({ underground: [], surface: [], overhead: [] });
    expect(dominantOccupantLabel(state, tile)).toBe(TileKind.Land);
  });

  it('lists a single surface occupant under "surface", nowhere else', () => {
    const state = createInitialState(3, 3);
    setTile(state, 1, 1, TileKind.Road);
    const tile = getTile(state, 1, 1)!;
    expect(occupantsByStratum(state, tile)).toEqual({ underground: [], surface: [TileKind.Road], overhead: [] });
  });

  it('keeps a road, a power line, and a pipe all visible on the same tile — what dominantOccupantLabel collapses away', () => {
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
    // The power line wins the single-label display slot — the road is still
    // there (proven above), just not visible through `dominantOccupantLabel`.
    expect(dominantOccupantLabel(state, tile)).toBe(TileKind.PowerLine);
  });

  it('resolves a Structure occupant through the building instance, same as dominantOccupantLabel', () => {
    const state = createInitialState(3, 3);
    const tile = getTile(state, 1, 1)!;
    tile.terrain = Terrain.Land; // procedural generation may have placed water here
    setTileOccupant(tile, Occupant.Structure, true);
    tile.buildingId = 7;
    state.buildings.push({
      id: 7, templateId: TileKind.WaterPump, origin: { x: 1, y: 1 }, state: createBuildingState(),
    });

    expect(occupantsByStratum(state, tile)).toEqual({ underground: [], surface: [TileKind.WaterPump], overhead: [] });
    expect(dominantOccupantLabel(state, tile)).toBe(TileKind.WaterPump);
  });

  it('omits a Structure occupant whose building instance is missing (no TileKind to report)', () => {
    const state = createInitialState(3, 3);
    const tile = getTile(state, 1, 1)!;
    setTileOccupant(tile, Occupant.Structure, true);
    tile.buildingId = 404; // no matching entry in state.buildings

    expect(occupantsByStratum(state, tile)).toEqual({ underground: [], surface: [], overhead: [] });
  });
});
