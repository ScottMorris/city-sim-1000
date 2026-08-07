// buildings.test.ts — legacy-save migration: minted civic building ids in the wire buffer.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { TileKind } from './gameState';
import { transcodeLegacySave } from './persistence';
import { legacyTileBufferOffsets } from './protocol/legacyTileBuffer';

describe('buildings — legacy save migration', () => {
  it('mints a building id for a legacy civic tile (no buildingId) into the wire buffer', () => {
    const width = 4;
    const height = 4;
    const n = width * height;
    const idx = 1 * width + 1;
    const tiles = Array.from({ length: n }, () => ({ kind: TileKind.Land }));
    tiles[idx] = { kind: TileKind.WaterPump } as any;
    const raw = JSON.stringify({
      width,
      height,
      seed: 1,
      tiles,
      money: 100000,
      day: 1,
      tick: 0,
      population: 12,
      jobs: 4
    });

    const { engine } = transcodeLegacySave(raw);
    const o = legacyTileBufferOffsets(n);
    const lo = engine.tiles[o.buildingId + idx * 2];
    const hi = engine.tiles[o.buildingId + idx * 2 + 1];
    const mintedId = lo | (hi << 8);

    expect(mintedId).toBeGreaterThan(0);
    // Rust's `import.rs` rebuilds the `BuildingInstance` straight off this
    // kind byte (first-occurrence-per-id, see `from_tile_buffer`) — no TS
    // `BuildingInstance` synthesis needed on this side any more.
    expect(engine.tiles[o.kind + idx]).toBe(10); // TileKind.WaterPump's u8
  });
});
