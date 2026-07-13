/**
 * SoA tile buffer layout — TS mirror of crates/sim_protocol/src/tile_buffer.rs.
 *
 * For an N-tile map (N = width × height) the flat ArrayBuffer is laid out as:
 *
 *   kind[N]             u8   — TileKind u8 values
 *   flags[N]            u8   — bit-packed booleans (see FLAGS)
 *   happiness[N]        u8   — quantised 0–255 (0.0–2.0)
 *   elevation[N]        u8   — unsigned elevation (0–255)
 *   building_id[N]      u16  — building ID, little-endian (0 = none)
 *   underground_kind[N] u8   — TileKind u8 of buried tile (0xFF = none)
 *   wilderness[N]       u8   — per-tile eco value, quantised (128 = neutral)
 *
 * Total: N × 8 bytes.
 *
 * On the web path the buffer is a SharedArrayBuffer owned by the Worker.
 * The main thread reads it via typed array views without copying.
 */

export const BYTES_PER_TILE = 8;

export function tileBufferOffsets(n: number) {
  return {
    kind:            0,
    flags:           n,
    happiness:       n * 2,
    elevation:       n * 3,
    buildingId:      n * 4,   // u16le → occupies n*2 bytes starting here
    undergroundKind: n * 6,   // TileKind u8 (0xFF = none; 0 = TileKind::Land)
    wilderness:      n * 7,   // quantised eco value (see decodeEco)
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

/**
 * Encode a [0, 2] happiness float to u8.
 * Uses truncation (Math.floor) to match Rust's `as u8` cast behaviour.
 */
export function encodeHappiness(h: number): number {
  return Math.floor(Math.min(Math.max(h, 0), 2) * 127.5);
}

/** Half-range of the per-tile eco value carried in the wilderness field. */
export const ECO_RANGE = 10;

/** Decode a u8 wilderness byte back to the eco float range (−10..+10). */
export function decodeEco(v: number): number {
  return ((v - 128) / 127) * ECO_RANGE;
}

/** Encode an eco float to u8, matching Rust's truncating cast (128 = neutral). */
export function encodeEco(eco: number): number {
  const clamped = Math.min(Math.max(eco, -ECO_RANGE), ECO_RANGE);
  return Math.trunc((clamped / ECO_RANGE) * 127 + 128);
}
