/**
 * SoA tile buffer layout — TS mirror of crates/city-sim-protocol/src/tile_buffer.rs.
 *
 * For an N-tile map (N = width × height) the flat ArrayBuffer is laid out as:
 *
 *   underground[N] u8   — Underground stratum occupant bits, absolute (no shift)
 *   surface[N]     u8   — Surface stratum occupant bits, rebased >> 3
 *   overhead[N]    u8   — Overhead stratum occupant bits, rebased >> 9
 *   status[N]      u8   — POWERED | WATERED | ABANDONED | WATER_TERRAIN | density (see STATUS)
 *   happiness[N]   u8   — quantised 0–255 (0.0–2.0)
 *   elevation[N]   u8   — unsigned elevation (0–255)
 *   building_id[N] u16  — building ID, little-endian (0 = none)
 *   wilderness[N]  u8   — per-tile eco value, quantised (128 = neutral)
 *
 * Total: N × 9 bytes.
 *
 * `underground`/`surface`/`overhead` are each a dense, rebased slice of one
 * stratum's occupant bits (see `protocol/occupants.ts`): `Occupant`'s
 * discriminants are absolute bit positions grouped by stratum — 0-2
 * underground, 3-8 surface, 9-10 overhead — so a reader reconstructs the
 * tile's full occupant set as `underground | (surface << 3) | (overhead << 9)`.
 *
 * On the web path the buffer is a SharedArrayBuffer owned by the Worker.
 * The main thread reads it via typed array views without copying.
 */

export const BYTES_PER_TILE = 9;

export function tileBufferOffsets(n: number) {
  return {
    underground: 0,
    surface: n,
    overhead: n * 2,
    status: n * 3,
    happiness: n * 4,
    elevation: n * 5,
    buildingId: n * 6, // u16le → occupies n*2 bytes starting here
    wilderness: n * 8
  } as const;
}

/** Bit positions within the `status` byte. */
export const STATUS = {
  POWERED: 1 << 0,
  WATERED: 1 << 1,
  ABANDONED: 1 << 2,
  WATER_TERRAIN: 1 << 3,
  DENSITY_SHIFT: 4,
  DENSITY_MASK: 0b11 << 4
} as const;

/** Rebase a wire `underground` byte back to absolute `Occupant` bits — already absolute, no shift. */
export function decodeUndergroundBits(byte: number): number {
  return byte;
}

/** Rebase a wire `surface` byte back to absolute `Occupant` bits (`<< 3`). */
export function decodeSurfaceBits(byte: number): number {
  return byte << 3;
}

/** Rebase a wire `overhead` byte back to absolute `Occupant` bits (`<< 9`). */
export function decodeOverheadBits(byte: number): number {
  return byte << 9;
}

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
