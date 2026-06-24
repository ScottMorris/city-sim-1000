/**
 * SoA tile buffer layout — TS mirror of crates/sim_protocol/src/tile_buffer.rs.
 *
 * For an N-tile map (N = width × height) the flat ArrayBuffer is laid out as:
 *
 *   kind[N]        u8   — TileKind u8 values
 *   flags[N]       u8   — bit-packed booleans (see FLAGS)
 *   happiness[N]   u8   — quantised 0–255 (0.0–2.0)
 *   elevation[N]   i8   — signed elevation
 *   building_id[N] u16  — building ID, little-endian (0 = none)
 *
 * Total: N × 6 bytes.
 *
 * On the web path the buffer is a SharedArrayBuffer owned by the Worker.
 * The main thread reads it via typed array views without copying.
 */

export const BYTES_PER_TILE = 6;

export function tileBufferOffsets(n: number) {
  return {
    kind:       0,
    flags:      n,
    happiness:  n * 2,
    elevation:  n * 3,
    buildingId: n * 4,   // u16le → occupies n*2 bytes starting here
  } as const;
}

export const FLAGS = {
  POWERED:       1 << 0,
  WATERED:       1 << 1,
  ABANDONED:     1 << 2,
  ROAD_UNDERLAY: 1 << 3,
  RAIL_UNDERLAY: 1 << 4,
  POWER_OVERLAY: 1 << 5,
} as const;

/** Decode a u8 happiness byte back to the [0, 2] float range. */
export function decodeHappiness(u8: number): number {
  return u8 / 127.5;
}

/** Encode a [0, 2] happiness float to u8. */
export function encodeHappiness(h: number): number {
  return Math.round(Math.min(Math.max(h, 0), 2) * 127.5);
}
