// Structure-of-Arrays tile buffer layout shared between the sim and the renderer.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

//! SoA tile buffer layout shared between the sim and the renderer via
//! SharedArrayBuffer (web) or a Tauri Channel binary payload (desktop).
//!
//! For a W×H map the buffer is divided into eight contiguous field arrays:
//!
//! ```text
//! | underground[N] u8 | surface[N] u8 | overhead[N] u8 | status[N] u8 | happiness[N] u8 | elevation[N] u8 | building_id[N*2] u16le | wilderness[N] u8 |
//! |--- N -------------|--- N ---------|--- N -----------|--- N --------|--- N --------------|--- N --------------|--- N*2 ------------------|--- N --------------|
//! ```
//!
//! Where N = W × H. All multi-byte values are little-endian.
//!
//! `underground`/`surface`/`overhead` are each a dense, rebased slice of one
//! stratum's occupant bits. `Occupant`'s discriminants
//! (`city_sim_core::occupants`) are absolute bit positions grouped by
//! stratum — 0-2 underground, 3-8 surface, 9-10 overhead — so each byte here
//! is that stratum's bits shifted down to start at bit 0: `underground` needs
//! no shift, `surface` is `>> 3`, `overhead` is `>> 9`. A reader reconstructs
//! the tile's full occupant set as
//! `underground | (surface << 3) | (overhead << 9)`.
//!
//! `status` bit layout: bit0=POWERED, bit1=WATERED, bit2=ABANDONED (mirrors
//! `city_sim_core::state`'s `FLAG_*` positions directly), bit3=WATER_TERRAIN
//! (0=Land, 1=Water), bits4-5=density (see `status::DENSITY_SHIFT`), bits6-7
//! spare. See the `status` module below.
//!
//! `wilderness` is the per-tile eco value quantised via [`encode_eco`] (128 = neutral).
//!
//! The TS mirror is in `src/game/protocol/tileBuffer.ts`.

/// Number of bytes per tile in the flat buffer (1+1+1+1+1+1+2+1 = 9).
pub const BYTES_PER_TILE: usize = 9;

/// Byte offsets of each field array, as a function of N (number of tiles).
pub struct TileBufferOffsets {
    /// `underground[N]` — Underground stratum occupant bits, absolute (no shift).
    pub underground: usize,
    /// `surface[N]`     — Surface stratum occupant bits, rebased `>> 3`.
    pub surface: usize,
    /// `overhead[N]`    — Overhead stratum occupant bits, rebased `>> 9`.
    pub overhead: usize,
    /// `status[N]`      — POWERED | WATERED | ABANDONED | WATER_TERRAIN | density (see `status`).
    pub status: usize,
    /// `happiness[N]`   — happiness quantised to u8 (0 = 0.0, 255 = 2.0).
    pub happiness: usize,
    /// `elevation[N]`   — unsigned elevation.
    pub elevation: usize,
    /// `building_id[N*2]` — building ID as u16le (0 = no building).
    pub building_id: usize,
    /// `wilderness[N]`  — per-tile eco value quantised to u8 (128 = neutral).
    pub wilderness: usize,
}

impl TileBufferOffsets {
    pub const fn for_size(n: usize) -> Self {
        Self {
            underground: 0,
            surface: n,
            overhead: n * 2,
            status: n * 3,
            happiness: n * 4,
            elevation: n * 5,
            building_id: n * 6,
            wilderness: n * 8,
        }
    }

    pub const fn total_bytes(n: usize) -> usize {
        n * BYTES_PER_TILE
    }
}

/// Bit positions within the `status` byte.
pub mod status {
    /// Mirrors `city_sim_core::state::FLAG_POWERED` — same bit, copied verbatim.
    pub const POWERED: u8 = 1 << 0;
    /// Mirrors `city_sim_core::state::FLAG_WATERED` — same bit, copied verbatim.
    pub const WATERED: u8 = 1 << 1;
    /// Mirrors `city_sim_core::state::FLAG_ABANDONED` — same bit, copied verbatim.
    pub const ABANDONED: u8 = 1 << 2;
    /// `Tile::terrain == Terrain::Water`. Terrain has no occupant bit of its
    /// own (it is not an occupant), so it rides in the spare status bits
    /// rather than in one of the three stratum bytes.
    pub const WATER_TERRAIN: u8 = 1 << 3;
    /// `Tile::density` (`ZoneDensity as u8`, 0-2), packed at bits 4-5.
    pub const DENSITY_SHIFT: u8 = 4;
    pub const DENSITY_MASK: u8 = 0b11 << DENSITY_SHIFT;
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
        assert_eq!(off.underground, 0);
        assert_eq!(off.surface, 4096);
        assert_eq!(off.overhead, 8192);
        assert_eq!(off.status, 12288);
        assert_eq!(off.happiness, 16384);
        assert_eq!(off.elevation, 20480);
        assert_eq!(off.building_id, 24576);
        assert_eq!(off.wilderness, 32768);
        assert_eq!(TileBufferOffsets::total_bytes(n), 36864);
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
        // underground(1) + surface(1) + overhead(1) + status(1) + happiness(1)
        //   + elevation(1) + building_id(2) + wilderness(1) = 9
        assert_eq!(BYTES_PER_TILE, 9);
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

    #[test]
    fn status_bits_do_not_overlap() {
        use status::*;
        assert_eq!(POWERED & WATERED, 0);
        assert_eq!(POWERED & ABANDONED, 0);
        assert_eq!(WATERED & ABANDONED, 0);
        assert_eq!(
            (POWERED | WATERED | ABANDONED | WATER_TERRAIN) & DENSITY_MASK,
            0
        );
        assert_eq!(DENSITY_MASK, 0b0011_0000);
    }
}
