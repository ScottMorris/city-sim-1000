// Structure-of-Arrays tile buffer layout shared between the sim and the renderer.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

//! SoA tile buffer layout shared between the sim and the renderer via
//! SharedArrayBuffer (web) or a Tauri Channel binary payload (desktop).
//!
//! For a W×H map the buffer is divided into seven contiguous field arrays:
//!
//! ```text
//! | kind[N]  u8  | flags[N]  u8  | happiness[N]  u8  | elevation[N]  u8  | building_id[N*2]  u16le | underground_kind[N]  u8 | wilderness[N]  u8 |
//! |--- N --------|--- N ---------|--- N --------------|--- N --------------|--- N*2 ------------------|--- N -------------------|--- N --------------|
//! ```
//!
//! Where N = W × H.  All multi-byte values are little-endian.
//! `underground_kind` uses 0xFF as the "no underground" sentinel (0 = `TileKind::Land`).
//! `wilderness` is the per-tile eco value quantised via [`encode_eco`] (128 = neutral).
//!
//! The TS mirror is in `src/game/protocol/tileBuffer.ts`.

/// Number of bytes per tile in the flat buffer (1+1+1+1+2+1+1 = 8).
pub const BYTES_PER_TILE: usize = 8;

/// Byte offsets of each field array, as a function of N (number of tiles).
pub struct TileBufferOffsets {
    /// `kind[N]`             — TileKind u8 values.
    pub kind: usize,
    /// `flags[N]`            — bit-packed boolean fields (see FLAG_* constants).
    pub flags: usize,
    /// `happiness[N]`        — happiness quantised to u8 (0 = 0.0, 255 = 2.0).
    pub happiness: usize,
    /// `elevation[N]`        — signed elevation as i8.
    pub elevation: usize,
    /// `building_id[N*2]`    — building ID as u16le (0 = no building).
    pub building_id: usize,
    /// `underground_kind[N]` — TileKind u8 of buried tile (0xFF = none; 0 = `TileKind::Land`).
    pub underground_kind: usize,
    /// `wilderness[N]`       — per-tile eco value quantised to u8 (128 = neutral).
    pub wilderness: usize,
}

impl TileBufferOffsets {
    pub const fn for_size(n: usize) -> Self {
        Self {
            kind: 0,
            flags: n,
            happiness: n * 2,
            elevation: n * 3,
            building_id: n * 4,
            underground_kind: n * 6,
            wilderness: n * 7,
        }
    }

    pub const fn total_bytes(n: usize) -> usize {
        n * BYTES_PER_TILE
    }
}

/// Bit positions within the `flags` byte.
pub mod flags {
    pub const POWERED: u8 = 1 << 0;
    pub const WATERED: u8 = 1 << 1;
    pub const ABANDONED: u8 = 1 << 2;
    pub const ROAD_UNDERLAY: u8 = 1 << 3;
    pub const RAIL_UNDERLAY: u8 = 1 << 4;
    pub const POWER_OVERLAY: u8 = 1 << 5;
}

/// Encode a happiness float (0.0–2.0) to a u8.
#[inline]
pub fn encode_happiness(h: f32) -> u8 {
    (h.clamp(0.0, 2.0) * 127.5) as u8
}

/// Decode a u8 happiness back to f32.
#[inline]
pub fn decode_happiness(h: u8) -> f32 {
    h as f32 / 127.5
}

/// Half-range of the per-tile eco value carried in the `wilderness` field.
/// Values outside ±ECO_RANGE saturate.
pub const ECO_RANGE: f32 = 10.0;

/// Encode a per-tile eco value (−ECO_RANGE..+ECO_RANGE) to a u8, 128 = neutral.
#[inline]
pub fn encode_eco(eco: f32) -> u8 {
    let clamped = eco.clamp(-ECO_RANGE, ECO_RANGE);
    (clamped / ECO_RANGE * 127.0 + 128.0) as u8
}

/// Decode a u8 wilderness byte back to the eco float range.
#[inline]
pub fn decode_eco(v: u8) -> f32 {
    (v as f32 - 128.0) / 127.0 * ECO_RANGE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offsets_for_64x64() {
        let n = 64 * 64; // 4096
        let off = TileBufferOffsets::for_size(n);
        assert_eq!(off.kind, 0);
        assert_eq!(off.flags, 4096);
        assert_eq!(off.happiness, 8192);
        assert_eq!(off.elevation, 12288);
        assert_eq!(off.building_id, 16384);
        assert_eq!(off.underground_kind, 24576);
        assert_eq!(off.wilderness, 28672);
        assert_eq!(TileBufferOffsets::total_bytes(n), 32768);
    }

    #[test]
    fn happiness_round_trips() {
        for v in [0.0f32, 0.5, 1.0, 1.5, 2.0] {
            let encoded = encode_happiness(v);
            let decoded = decode_happiness(encoded);
            assert!(
                (decoded - v).abs() < 0.01,
                "happiness {v} → {encoded} → {decoded}"
            );
        }
    }

    #[test]
    fn bytes_per_tile_matches_layout() {
        // kind(1) + flags(1) + happiness(1) + elevation(1) + building_id(2)
        //   + underground_kind(1) + wilderness(1) = 8
        assert_eq!(BYTES_PER_TILE, 8);
    }

    #[test]
    fn eco_round_trips_within_tolerance() {
        for v in [-10.0f32, -5.0, -1.0, 0.0, 1.0, 5.0, 10.0] {
            let decoded = decode_eco(encode_eco(v));
            assert!((decoded - v).abs() < 0.1, "eco {v} → {decoded}");
        }
        // Neutral maps to the 128 centre and saturation clamps cleanly.
        assert_eq!(encode_eco(0.0), 128);
        assert_eq!(encode_eco(99.0), encode_eco(ECO_RANGE));
        assert_eq!(encode_eco(-99.0), encode_eco(-ECO_RANGE));
    }
}
