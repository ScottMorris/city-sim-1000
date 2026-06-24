/// Structure-of-Arrays (SoA) tile buffer layout shared between the sim and the
/// renderer via SharedArrayBuffer (web) or a Tauri Channel binary payload (desktop).
///
/// For a W×H map the buffer is divided into five contiguous field arrays:
///
/// ```text
/// | kind[N]  u8  | flags[N]  u8  | happiness[N]  u8  | elevation[N]  i8  | building_id[N*2]  u16le |
/// |--- N --------|--- N ---------|--- N --------------|--- N --------------|--- N*2 ------------------|
/// ```
///
/// Where N = W × H.  All multi-byte values are little-endian.
///
/// The TS mirror is in `src/game/protocol/tileBuffer.ts`.

/// Number of bytes per tile in the flat buffer (1+1+1+1+2 = 6).
pub const BYTES_PER_TILE: usize = 6;

/// Byte offsets of each field array, as a function of N (number of tiles).
pub struct TileBufferOffsets {
    /// `kind[N]`        — TileKind u8 values.
    pub kind: usize,
    /// `flags[N]`       — bit-packed boolean fields (see FLAG_* constants).
    pub flags: usize,
    /// `happiness[N]`   — happiness quantised to u8 (0 = 0.0, 255 = 2.0).
    pub happiness: usize,
    /// `elevation[N]`   — signed elevation as i8.
    pub elevation: usize,
    /// `building_id[N*2]` — building ID as u16le (0 = no building).
    pub building_id: usize,
}

impl TileBufferOffsets {
    pub const fn for_size(n: usize) -> Self {
        Self {
            kind:        0,
            flags:       n,
            happiness:   n * 2,
            elevation:   n * 3,
            building_id: n * 4,
        }
    }

    pub const fn total_bytes(n: usize) -> usize {
        n * BYTES_PER_TILE
    }
}

/// Bit positions within the `flags` byte.
pub mod flags {
    pub const POWERED:   u8 = 1 << 0;
    pub const WATERED:   u8 = 1 << 1;
    pub const ABANDONED: u8 = 1 << 2;
    pub const ROAD_UNDERLAY:  u8 = 1 << 3;
    pub const RAIL_UNDERLAY:  u8 = 1 << 4;
    pub const POWER_OVERLAY:  u8 = 1 << 5;
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
        assert_eq!(TileBufferOffsets::total_bytes(n), 24576);
    }

    #[test]
    fn happiness_round_trips() {
        for v in [0.0f32, 0.5, 1.0, 1.5, 2.0] {
            let encoded = encode_happiness(v);
            let decoded = decode_happiness(encoded);
            assert!((decoded - v).abs() < 0.01, "happiness {v} → {encoded} → {decoded}");
        }
    }

    #[test]
    fn bytes_per_tile_matches_layout() {
        // kind(1) + flags(1) + happiness(1) + elevation(1) + building_id(2) = 6
        assert_eq!(BYTES_PER_TILE, 6);
    }
}
