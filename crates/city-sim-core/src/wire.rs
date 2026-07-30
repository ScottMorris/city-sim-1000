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
use crate::state::{Tile, DERIVED_FLAG_MASK};
use city_sim_protocol::tile_buffer::status;

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
/// `Tile::flags`, copied verbatim), plus terrain and density in the bits the
/// old flags byte never used.
#[inline]
pub fn wire_status_byte(tile: &Tile) -> u8 {
    let mut out = tile.flags & DERIVED_FLAG_MASK;
    if tile.terrain == Terrain::Water {
        out |= status::WATER_TERRAIN;
    }
    out |= (tile.density as u8) << status::DENSITY_SHIFT;
    out
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
    }
}
