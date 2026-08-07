// legacyTileBuffer.ts — frozen v4 wire tile-buffer layout, TS mirror of legacy_tile_buffer.rs.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/**
 * Frozen v4 tile-buffer layout — TS mirror of
 * crates/city-sim-protocol/src/legacy_tile_buffer.rs.
 *
 * The wire layout every `.citysim` JSON save was ever encoded against,
 * before the live wire moved to the occupant-strata representation. Used
 * only by `persistence.ts`'s `transcodeLegacySave` (encoding *to* this
 * shape for `SimHost.import_legacy`) and by `wasmSimBridge.ts`'s legacy
 * import decode path, if either needs to read/write it directly.
 *
 * **This module must never change again.** The live wire format
 * (`tileBuffer.ts`) is free to evolve; this one exists so old saves keep
 * importing byte-for-byte no matter how the live format moves on.
 *
 *   kind[N]             u8   — TileKind u8 values
 *   flags[N]            u8   — bit-packed booleans (see LEGACY_FLAGS)
 *   happiness[N]        u8   — quantised 0–255 (0.0–2.0)
 *   elevation[N]        u8   — unsigned elevation (0–255)
 *   building_id[N]      u16  — building ID, little-endian (0 = none)
 *   underground_kind[N] u8   — TileKind u8 of buried tile (0xFF = none)
 *   wilderness[N]       u8   — per-tile eco value, quantised (128 = neutral)
 *
 * Total: N × 8 bytes.
 */

export const LEGACY_BYTES_PER_TILE = 8;

export function legacyTileBufferOffsets(n: number) {
  return {
    kind: 0,
    flags: n,
    happiness: n * 2,
    elevation: n * 3,
    buildingId: n * 4, // u16le → occupies n*2 bytes starting here
    undergroundKind: n * 6,
    wilderness: n * 7
  } as const;
}

export const LEGACY_FLAGS = {
  POWERED: 1 << 0,
  WATERED: 1 << 1,
  ABANDONED: 1 << 2,
  ROAD_UNDERLAY: 1 << 3,
  RAIL_UNDERLAY: 1 << 4,
  POWER_OVERLAY: 1 << 5
} as const;
