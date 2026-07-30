// legacy_tile_buffer.rs — frozen v4 tile-buffer layout, for legacy save import only.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

//! The wire layout every `.citysim` JSON save was ever encoded against, before
//! the live wire moved to the occupant-strata representation (`docs/tile-model.md`,
//! #177's TS/wire follow-up). `city_sim_core::import::from_tile_buffer` decodes
//! exactly this shape via `crate::migrate::tile_from_v4`.
//!
//! **This module must never change again.** The live wire format
//! (`crate::tile_buffer`) is free to evolve; this one exists so old saves keep
//! importing byte-for-byte no matter how the live format moves on. If a save
//! format ever needs to change, it gets a new module, not an edit to this one.
//!
//! Layout — byte-for-byte identical to the pre-migration live format:
//!
//! ```text
//! | kind[N]  u8  | flags[N]  u8  | happiness[N]  u8  | elevation[N]  u8  | building_id[N*2]  u16le | underground_kind[N]  u8 | wilderness[N]  u8 |
//! |--- N --------|--- N ---------|--- N --------------|--- N --------------|--- N*2 ------------------|--- N -------------------|--- N --------------|
//! ```
//!
//! Where N = W × H. All multi-byte values are little-endian.
//! `underground_kind` uses 0xFF as the "no underground" sentinel (0 = `TileKind::Land`).
//! `happiness`/`wilderness` share the live format's codecs
//! (`crate::tile_buffer::{encode_happiness, decode_happiness, encode_eco, decode_eco}`)
//! — those aren't part of the kind/flags spelling this module freezes.

/// Number of bytes per tile in the frozen legacy buffer (1+1+1+1+2+1+1 = 8).
pub const LEGACY_BYTES_PER_TILE: usize = 8;

/// Byte offsets of each field array in the frozen legacy layout.
pub struct LegacyTileBufferOffsets {
    /// `kind[N]`             — TileKind u8 values.
    pub kind: usize,
    /// `flags[N]`            — bit-packed boolean fields (see `legacy_flags`).
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

impl LegacyTileBufferOffsets {
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
        n * LEGACY_BYTES_PER_TILE
    }
}

/// Bit positions within the legacy `flags` byte.
pub mod legacy_flags {
    pub const POWERED: u8 = 1 << 0;
    pub const WATERED: u8 = 1 << 1;
    pub const ABANDONED: u8 = 1 << 2;
    pub const ROAD_UNDERLAY: u8 = 1 << 3;
    pub const RAIL_UNDERLAY: u8 = 1 << 4;
    pub const POWER_OVERLAY: u8 = 1 << 5;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offsets_for_64x64() {
        let n = 64 * 64; // 4096
        let off = LegacyTileBufferOffsets::for_size(n);
        assert_eq!(off.kind, 0);
        assert_eq!(off.flags, 4096);
        assert_eq!(off.happiness, 8192);
        assert_eq!(off.elevation, 12288);
        assert_eq!(off.building_id, 16384);
        assert_eq!(off.underground_kind, 24576);
        assert_eq!(off.wilderness, 28672);
        assert_eq!(LegacyTileBufferOffsets::total_bytes(n), 32768);
    }

    #[test]
    fn bytes_per_tile_matches_layout() {
        // kind(1) + flags(1) + happiness(1) + elevation(1) + building_id(2)
        //   + underground_kind(1) + wilderness(1) = 8
        assert_eq!(LEGACY_BYTES_PER_TILE, 8);
    }
}
