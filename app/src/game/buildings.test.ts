// buildings.test.ts — legacy-save migration into BuildingInstance.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { createInitialState, getTile, TileKind } from './gameState';
import { deserialize } from './persistence';
import { serialize } from './testSupport/legacyStateSerialize';

describe('buildings — legacy save migration', () => {
  it('rebuilds legacy civic tiles into building instances on load', () => {
    const state = createInitialState(4, 4);
    // Simulate a pre-migration save: `deserialize` branches on `terrain` being
    // absent to decode a v4-shaped tile, so a live `Tile` (which has no `kind`
    // field any more) can't stand in for one — spell the raw JSON directly.
    const json = JSON.parse(serialize(state));
    const idx = 1 * state.width + 1;
    delete json.tiles[idx].terrain;
    delete json.tiles[idx].underground;
    delete json.tiles[idx].surface;
    delete json.tiles[idx].overhead;
    json.tiles[idx].kind = TileKind.WaterPump;
    const restored = deserialize(JSON.stringify(json));
    const pumpTile = getTile(restored, 1, 1)!;
    expect(pumpTile.buildingId).toBeDefined();
    const building = restored.buildings.find((b) => b.id === pumpTile.buildingId);
    expect(building?.templateId).toBe(TileKind.WaterPump);
  });
});
