// wire.rs — encodes a Tile's real strata into the live SoA wire buffer bytes.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

//! Replaces `display.rs`'s `wire_kind`/`wire_flags`/`wire_underground`
//! precedence ladder (deleted — #177's TS/wire follow-up). There is no
//! ladder left to run: [`Occupant`](crate::occupants::Occupant)'s
//! discriminants are already absolute bit positions grouped by stratum, so
//! the wire buffer's `underground`/`surface`/`overhead` bytes are each just
//! that stratum's bits rebased to start at bit 0 — no `StructureLookup`, no
//! precedence, nothing derived from anything but the tile itself.
//!
//! Byte layout: [`city_sim_protocol::tile_buffer`].

use crate::occupants::Terrain;
use crate::state::{BudgetHistoryEntry, EducationStats, GameState, Tile, DERIVED_FLAG_MASK};
use crate::utilities::UtilityComponent;
use city_sim_protocol::tile_buffer::{encode_happiness, encode_score, status, TileBufferOffsets};
use city_sim_protocol::wire_types::{
    WireBudgetHistoryEntry, WireEducationStats, WireUtilityComponent,
};

/// The `underground` wire byte: bits 0–2, already absolute — no shift needed.
#[inline]
pub fn wire_underground_byte(tile: &Tile) -> u8 {
    tile.underground.bits() as u8
}

/// The `surface` wire byte: bits 3–8, rebased to 0–63.
#[inline]
pub fn wire_surface_byte(tile: &Tile) -> u8 {
    (tile.surface.bits() >> 3) as u8
}

/// The `overhead` wire byte: bits 9–10, rebased to 0–3.
#[inline]
pub fn wire_overhead_byte(tile: &Tile) -> u8 {
    (tile.overhead.bits() >> 9) as u8
}

/// The `status` wire byte: the three derived flags (same bit positions as
/// `Tile::flags`, copied verbatim), plus terrain, density, and education
/// served flags in the bits the old flags byte never used.
#[inline]
pub fn wire_status_byte(tile: &Tile) -> u8 {
    let mut out = tile.flags & DERIVED_FLAG_MASK;
    if tile.terrain == Terrain::Water {
        out |= status::WATER_TERRAIN;
    }
    out |= (tile.density as u8) << status::DENSITY_SHIFT;
    if tile.elementary_served {
        out |= status::ELEMENTARY_SERVED;
    }
    if tile.high_served {
        out |= status::HIGH_SERVED;
    }
    out
}

/// Serialise the whole grid as the SoA wire buffer `city_sim_protocol::tile_buffer`
/// describes — one encoder shared by every host that streams tiles to a
/// client (WASM's `tile_buffer()`, the Tauri plugin's tick event), so a wire
/// bug fixed here is fixed on every transport at once, and no transport can
/// silently drift from what the others send.
pub fn encode_tile_buffer(state: &GameState) -> Vec<u8> {
    let tiles = &state.tiles;
    let n = tiles.len();
    let o = TileBufferOffsets::for_size(n);
    let mut buf = vec![0u8; n * city_sim_protocol::tile_buffer::BYTES_PER_TILE];
    for (i, tile) in tiles.iter().enumerate() {
        buf[o.underground + i] = wire_underground_byte(tile);
        buf[o.surface + i] = wire_surface_byte(tile);
        buf[o.overhead + i] = wire_overhead_byte(tile);
        buf[o.status + i] = wire_status_byte(tile);
        buf[o.happiness + i] = encode_happiness(tile.happiness);
        buf[o.elevation + i] = tile.elevation;
        let bid = tile.building_id.unwrap_or(0);
        let base = o.building_id + i * 2;
        buf[base] = (bid & 0xFF) as u8;
        buf[base + 1] = ((bid >> 8) & 0xFF) as u8;
        // 128 = neutral until the first wilderness recompute fills the field.
        buf[o.wilderness + i] = state.wilderness.local_field.get(i).copied().unwrap_or(128);
        buf[o.elementary_score + i] = encode_score(tile.elementary_score);
        buf[o.high_score + i] = encode_score(tile.high_score);
    }
    buf
}

// ── Wire conversions for the summary structs shared by both hosts ──────────
//
// These live here rather than in `city-sim-protocol` alongside the
// `city_sim_protocol::wire_types` structs themselves because that crate does
// not (and must not) depend on `city-sim-core` — `UtilityComponent`,
// `EducationStats`, and `BudgetHistoryEntry` are only visible from this side
// of the dependency edge.

impl From<&UtilityComponent> for WireUtilityComponent {
    fn from(c: &UtilityComponent) -> Self {
        Self {
            id: c.id,
            produced: c.produced,
            used: c.used,
            source_count: c.source_count,
            utilisation: c.utilisation(),
        }
    }
}

impl From<&EducationStats> for WireEducationStats {
    fn from(s: &EducationStats) -> Self {
        Self {
            elementary_served: s.elementary_served,
            elementary_capacity: s.elementary_capacity,
            elementary_load: s.elementary_load,
            high_served: s.high_served,
            high_capacity: s.high_capacity,
            high_load: s.high_load,
            score: s.score,
            elementary_coverage: s.elementary_coverage,
            high_coverage: s.high_coverage,
        }
    }
}

impl From<&BudgetHistoryEntry> for WireBudgetHistoryEntry {
    fn from(e: &BudgetHistoryEntry) -> Self {
        Self {
            day: e.day,
            revenue: e.revenue,
            expenses: e.expenses,
            net: e.net,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::occupants::Occupant;
    use crate::state::{GameState, FLAG_ABANDONED, FLAG_POWERED, FLAG_WATERED};

    #[test]
    fn underground_byte_is_absolute_no_shift() {
        let mut s = GameState::new(1, 1, 0);
        s.tiles[0].set_occupant(Occupant::Pipe, true);
        assert_eq!(wire_underground_byte(&s.tiles[0]), 0b001);
    }

    #[test]
    fn surface_byte_is_rebased_to_zero() {
        let mut s = GameState::new(1, 1, 0);
        s.tiles[0].set_occupant(Occupant::Road, true);
        // Road is bit 3 absolute; rebased to bit 0 of the surface byte.
        assert_eq!(wire_surface_byte(&s.tiles[0]), 0b1);
        s.tiles[0].set_occupant(Occupant::Structure, true);
        // Structure is bit 8 absolute (bit 5 of the rebased surface byte).
        assert_eq!(wire_surface_byte(&s.tiles[0]), 0b10_0001);
    }

    #[test]
    fn overhead_byte_is_rebased_to_zero() {
        let mut s = GameState::new(1, 1, 0);
        s.tiles[0].set_occupant(Occupant::Trees, true);
        // Trees is bit 10 absolute (bit 1 of the rebased overhead byte).
        assert_eq!(wire_overhead_byte(&s.tiles[0]), 0b10);
    }

    #[test]
    fn encode_tile_buffer_places_every_field_at_its_soa_offset() {
        // Every field differs between tile 0 and tile 1, and every field is
        // asserted at BOTH tiles' offsets — a mutant that swaps `+` for `-`
        // or `*` in any one field's placement must land a wrong byte at a
        // position this test actually reads, tile 0's or tile 1's.
        let mut s = GameState::new(2, 1, 0);
        s.tiles[1].set_occupant(Occupant::Pipe, true);
        s.tiles[1].set_occupant(Occupant::Road, true);
        s.tiles[1].set_occupant(Occupant::Trees, true);
        s.tiles[1].flags |= FLAG_POWERED;
        s.tiles[1].happiness = 2.0;
        s.tiles[1].elevation = 200;
        s.tiles[1].set_building_id(300);
        s.wilderness.local_field = vec![128, 40];
        s.tiles[1].elementary_served = true;
        s.tiles[1].elementary_score = 0.5;
        s.tiles[1].high_served = true;
        s.tiles[1].high_score = 1.0;

        let buf = encode_tile_buffer(&s);
        let o = TileBufferOffsets::for_size(2);

        assert_eq!(
            buf.len(),
            2 * city_sim_protocol::tile_buffer::BYTES_PER_TILE
        );
        assert_eq!(buf[o.underground], 0);
        assert_eq!(buf[o.underground + 1], 0b001);
        assert_eq!(buf[o.surface], 0);
        assert_eq!(buf[o.surface + 1], 0b1);
        assert_eq!(buf[o.overhead], 0);
        assert_eq!(buf[o.overhead + 1], 0b10);
        assert_eq!(buf[o.status], 0);
        assert_eq!(buf[o.status + 1] & status::POWERED, status::POWERED);
        assert_eq!(
            buf[o.status + 1] & status::ELEMENTARY_SERVED,
            status::ELEMENTARY_SERVED
        );
        assert_eq!(buf[o.status + 1] & status::HIGH_SERVED, status::HIGH_SERVED);
        assert_eq!(buf[o.happiness], encode_happiness(1.0)); // Tile::default's happiness
        assert_eq!(buf[o.happiness + 1], encode_happiness(2.0));
        assert_eq!(buf[o.elevation], 0);
        assert_eq!(buf[o.elevation + 1], 200);
        let bid_base0 = o.building_id;
        assert_eq!(
            buf[bid_base0] as u32 | ((buf[bid_base0 + 1] as u32) << 8),
            0
        );
        let bid_base1 = o.building_id + 2;
        assert_eq!(
            buf[bid_base1] as u32 | ((buf[bid_base1 + 1] as u32) << 8),
            300
        );
        assert_eq!(buf[o.wilderness], 128);
        assert_eq!(buf[o.wilderness + 1], 40);
        assert_eq!(buf[o.elementary_score], encode_score(0.0));
        assert_eq!(buf[o.elementary_score + 1], encode_score(0.5));
        assert_eq!(buf[o.high_score], encode_score(0.0));
        assert_eq!(buf[o.high_score + 1], encode_score(1.0));
    }

    #[test]
    fn status_byte_packs_flags_terrain_and_density() {
        let mut s = GameState::new(1, 1, 0);
        s.tiles[0].flags |= FLAG_POWERED | FLAG_WATERED | FLAG_ABANDONED;
        s.tiles[0].terrain = Terrain::Water;
        s.tiles[0].density = crate::state::ZoneDensity::High;
        let byte = wire_status_byte(&s.tiles[0]);
        assert_eq!(byte & status::POWERED, status::POWERED);
        assert_eq!(byte & status::WATERED, status::WATERED);
        assert_eq!(byte & status::ABANDONED, status::ABANDONED);
        assert_eq!(byte & status::WATER_TERRAIN, status::WATER_TERRAIN);
        assert_eq!((byte & status::DENSITY_MASK) >> status::DENSITY_SHIFT, 2);
        assert_eq!(byte & status::ELEMENTARY_SERVED, 0);
        assert_eq!(byte & status::HIGH_SERVED, 0);
    }

    #[test]
    fn status_byte_packs_education_served_flags() {
        let mut s = GameState::new(1, 1, 0);
        s.tiles[0].elementary_served = true;
        let byte = wire_status_byte(&s.tiles[0]);
        assert_eq!(byte & status::ELEMENTARY_SERVED, status::ELEMENTARY_SERVED);
        assert_eq!(byte & status::HIGH_SERVED, 0);

        s.tiles[0].elementary_served = false;
        s.tiles[0].high_served = true;
        let byte = wire_status_byte(&s.tiles[0]);
        assert_eq!(byte & status::ELEMENTARY_SERVED, 0);
        assert_eq!(byte & status::HIGH_SERVED, status::HIGH_SERVED);
    }
}
