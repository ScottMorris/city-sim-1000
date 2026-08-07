// migrate.rs — decoding the pre-strata (v4) tile shape into the canonical strata.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

//! One function, [`tile_from_v4`], and its one production consumer.
//!
//! Before step 3 of #177 a tile was a single-valued `kind: TileKind` plus three
//! structural flags (`ROAD_UNDERLAY`, `RAIL_UNDERLAY`, `POWER_OVERLAY`) and an
//! `underground: Option<TileKind>`. That shape still arrives from one place:
//! `import.rs`, decoding the SoA tile buffer a legacy TS save is re-encoded
//! into — where the `kind` byte is legitimately canonical, because it is the
//! wire and the wire never changed shape. Its body is literally the old
//! derived `Tile::occupants()` predicate, relocated: the two spellings of a
//! road under a line (`kind = Road` with `POWER_OVERLAY`, and `kind =
//! PowerLine` with `ROAD_UNDERLAY | POWER_OVERLAY`) collapse to the same
//! `{Road, PowerLine}` here, which is what makes the decode into the strata
//! lossless in the direction that matters.
//!
//! **The v4 *snapshot* migration this module also carried is gone — a
//! deliberate compatibility break, not an oversight.** It read the same
//! `(kind, flags, underground)` triple out of a postcard payload for
//! `snapshot::from_bytes`'s v4 arm. A real `.citysim` download or IndexedDB
//! engine snapshot saved against an old build genuinely was v4 bytes at the
//! time this module's snapshot-migration half was deleted, so that was not
//! "nothing ever shipped." It is the project's stated pre-release stance
//! applied on purpose: the CSIM snapshot format, unlike the legacy JSON save
//! vocabulary and the frozen `legacy_tile_buffer` layout, carries no
//! compatibility guarantee before 1.0 (`docs/tile-model.md`). `snapshot.rs`'s
//! `VERSION` (see its own doc comment for the full bump history) refuses
//! every value below the current one outright — an old CSIM save fails
//! loudly with `UnsupportedVersion` rather than loading into a wrong city.
//! The legacy JSON save import (`import.rs`'s `from_tile_buffer`, driven by
//! `persistence.ts`'s `transcodeLegacySave`) is a separate mechanism — it was
//! never a *snapshot* and this change doesn't touch it — so an old save is
//! still recoverable through that door; a CSAV binary save containing a CSIM
//! engine snapshot is not.
//!
//! `set_v4`/`set_v4_kind` below stay: they are how ~150 test call sites
//! spell a tile in the old `kind`-and-flags vocabulary, which exercises
//! [`tile_from_v4`] across essentially the whole Rust test suite rather than
//! by one migration test alone.

use crate::occupants::{Occupant, Terrain};
use crate::state::{Tile, ZoneDensity, DERIVED_FLAG_MASK};
use city_sim_protocol::building_kind::BuildingKind;
use city_sim_protocol::legacy_tile_buffer::legacy_flags as wire_flags;
use city_sim_protocol::tile_kind::TileKind;

/// Zone density lived in flags bits 6–7 before it became a field.
const V4_ZONE_DENSITY_MASK: u8 = 0b1100_0000;
const V4_ZONE_DENSITY_SHIFT: u8 = 6;

/// Rebuild the stratified [`Tile`] a v4 `(kind, flags, underground,
/// building_id)` quadruple described.
///
/// Everything not carried by the quadruple — happiness, elevation, the cached
/// utility outputs, the education fields — is left at [`Tile::land`]'s defaults
/// for the caller to fill in.
///
/// Two clean-ups happen on the way through, both of which make the result match
/// what `apply_tool` produces today rather than what v4 happened to hold:
///
/// 1. **A ghost structure drops its tag.** `is_structure_kind(kind)` with no
///    `building_id` is a park that `remove_building` bulldozed and left the
///    `kind` of — nothing bills it, nothing powers it, and with `Structure`
///    being one flat tag there is no longer anywhere for its identity to live.
///    It converts to bare ground, which is what a bulldozed park is.
/// 2. **A nonsense `underground` byte is dropped.** Only `WaterPipe` is
///    producible; anything else was never reachable and has no occupant bit.
pub fn tile_from_v4(
    kind: TileKind,
    flags: u8,
    underground: Option<TileKind>,
    building_id: Option<u16>,
) -> Tile {
    let f = flags;
    let density = match (f & V4_ZONE_DENSITY_MASK) >> V4_ZONE_DENSITY_SHIFT {
        1 => ZoneDensity::Medium,
        2 => ZoneDensity::High,
        _ => ZoneDensity::Low,
    };

    let mut tile = Tile {
        terrain: if kind == TileKind::Water {
            Terrain::Water
        } else {
            Terrain::Land
        },
        building_id,
        density,
        flags: f & DERIVED_FLAG_MASK,
        ..Tile::land()
    };

    // The two-spellings collapse: v4 could record a road either in `kind` or in
    // `ROAD_UNDERLAY`, and the same for rail and for a hydro line. Either
    // spelling decodes to the same occupant, which is what makes the decode
    // lossless in the direction that matters.
    let has_pipe = matches!(underground, Some(TileKind::WaterPipe));
    let has_road = kind == TileKind::Road || f & wire_flags::ROAD_UNDERLAY != 0;
    let has_rail = kind == TileKind::Rail || f & wire_flags::RAIL_UNDERLAY != 0;
    let has_line = kind == TileKind::PowerLine || f & wire_flags::POWER_OVERLAY != 0;
    let has_structure = is_structure_kind(kind) && building_id.is_some();

    // One call per occupant, each routed to its own stratum by
    // `Tile::set_occupant` — the decode names no stratum, so it cannot file an
    // occupant in the wrong one. The grouping is for the reader; the `Occupant`
    // is what actually decides.
    //
    // Underground
    tile.set_occupant(Occupant::Pipe, has_pipe);
    // Surface
    tile.set_occupant(Occupant::Road, has_road);
    tile.set_occupant(Occupant::Rail, has_rail);
    tile.set_occupant(Occupant::ZoneResidential, kind == TileKind::Residential);
    tile.set_occupant(Occupant::ZoneCommercial, kind == TileKind::Commercial);
    tile.set_occupant(Occupant::ZoneIndustrial, kind == TileKind::Industrial);
    tile.set_occupant(Occupant::Structure, has_structure);
    // Overhead
    tile.set_occupant(Occupant::PowerLine, has_line);
    tile.set_occupant(Occupant::Trees, kind == TileKind::Tree);

    tile
}

/// The `BuildingKind` a legacy structure `TileKind` names, if any.
///
/// The one-time conversion at the legacy-import boundary. `TileKind` is
/// frozen v4/save vocabulary (`docs/tile-model.md`); `BuildingKind` is the
/// live `BuildingInstance` alphabet, free to be renumbered pre-release. This
/// is the single function where the two are allowed to meet — `import.rs`'s
/// tile-buffer import calls it to turn a decoded wire byte into a
/// `BuildingInstance::kind` — so nothing downstream of the legacy boundary
/// ever matches on a raw `TileKind` to decide what a *live* building is.
///
/// The thirteen building-capable `TileKind`s map across one for one, in the
/// same order `BuildingKind::ALL` declares them; every other `TileKind`
/// (terrain, transport, the zone-agnostic overlays) returns `None`.
pub(crate) fn building_kind_of(kind: TileKind) -> Option<BuildingKind> {
    match kind {
        TileKind::Residential => Some(BuildingKind::Residential),
        TileKind::Commercial => Some(BuildingKind::Commercial),
        TileKind::Industrial => Some(BuildingKind::Industrial),
        TileKind::HydroPlant => Some(BuildingKind::HydroPlant),
        TileKind::CoalPlant => Some(BuildingKind::CoalPlant),
        TileKind::WindTurbine => Some(BuildingKind::WindTurbine),
        TileKind::SolarFarm => Some(BuildingKind::SolarFarm),
        TileKind::WaterPump => Some(BuildingKind::WaterPump),
        TileKind::WaterTower => Some(BuildingKind::WaterTower),
        TileKind::ElementarySchool => Some(BuildingKind::ElementarySchool),
        TileKind::HighSchool => Some(BuildingKind::HighSchool),
        TileKind::Park => Some(BuildingKind::Park),
        TileKind::ParkLarge => Some(BuildingKind::ParkLarge),
        TileKind::Land
        | TileKind::Water
        | TileKind::Tree
        | TileKind::Road
        | TileKind::Rail
        | TileKind::PowerLine
        | TileKind::WaterPipe => None,
    }
}

/// The ten non-zone `TileKind`s that derive to the single `Structure`
/// occupant when decoding a legacy v4 byte ([`tile_from_v4`]) — the three
/// zone kinds decode to a zone tag instead, never to `Structure`. They behave
/// identically under every compatibility rule — `place_footprint_building`
/// applies one guard to all of them — so one tag suffices, and the per-kind
/// data (eco, upkeep, category) is looked up rather than duplicated.
///
/// Legacy-decode-only: this asks the question of a v4 wire byte, not of a
/// live `BuildingInstance` — see [`building_kind_of`] for the analogous
/// question asked of the *current* alphabet. Lives beside it rather than in
/// `occupants.rs` (its only non-test caller) so `TileKind` stays out of that
/// file's production code, confined to this module's sanctioned boundary.
pub const fn is_structure_kind(kind: TileKind) -> bool {
    matches!(
        kind,
        TileKind::HydroPlant
            | TileKind::CoalPlant
            | TileKind::WindTurbine
            | TileKind::SolarFarm
            | TileKind::WaterPump
            | TileKind::WaterTower
            | TileKind::ElementarySchool
            | TileKind::HighSchool
            | TileKind::Park
            | TileKind::ParkLarge
    )
}

/// The inverse of [`building_kind_of`]: the legacy `TileKind` a live
/// `BuildingKind` was copied from.
///
/// Exists for the direction only the legacy-export test path still needs —
/// `import.rs`'s round-trip test re-derives a v4-shaped wire buffer from a
/// live `GameState` to check `from_tile_buffer` against it, and that is the
/// one place left that goes *from* `BuildingKind` back *to* `TileKind`.
/// Production code never runs this direction: a live save is CSAV, not the
/// legacy v4 buffer.
#[cfg(test)]
pub(crate) fn tile_kind_of(kind: BuildingKind) -> TileKind {
    match kind {
        BuildingKind::Residential => TileKind::Residential,
        BuildingKind::Commercial => TileKind::Commercial,
        BuildingKind::Industrial => TileKind::Industrial,
        BuildingKind::HydroPlant => TileKind::HydroPlant,
        BuildingKind::CoalPlant => TileKind::CoalPlant,
        BuildingKind::WindTurbine => TileKind::WindTurbine,
        BuildingKind::SolarFarm => TileKind::SolarFarm,
        BuildingKind::WaterPump => TileKind::WaterPump,
        BuildingKind::WaterTower => TileKind::WaterTower,
        BuildingKind::ElementarySchool => TileKind::ElementarySchool,
        BuildingKind::HighSchool => TileKind::HighSchool,
        BuildingKind::Park => TileKind::Park,
        BuildingKind::ParkLarge => TileKind::ParkLarge,
    }
}

/// Test-only: respell a tile's *structure* the way a v4 save would have written
/// it, leaving the derived fields (happiness, education scores, utility
/// outputs) alone.
///
/// This is how the ~150 test-side `tile.kind = TileKind::X` writes are
/// expressed now that the strata are canonical, which means [`tile_from_v4`] —
/// and therefore the v4 decode path — is executed by essentially the whole Rust
/// test suite rather than by one migration test.
#[cfg(test)]
pub fn set_v4(tile: &mut Tile, kind: TileKind, flags: u8, underground: Option<TileKind>) {
    let v4 = tile_from_v4(kind, flags, underground, tile.building_id);
    tile.terrain = v4.terrain;
    tile.underground = v4.underground;
    tile.surface = v4.surface;
    tile.overhead = v4.overhead;
    tile.density = v4.density;
}

/// Test-only shorthand for a bare `tile.kind = kind` on an otherwise-empty tile.
#[cfg(test)]
pub fn set_v4_kind(tile: &mut Tile, kind: TileKind) {
    set_v4(tile, kind, 0, None);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::occupants::{iter_set, Occupant::*, OccupantSet};

    fn set(bits: &[Occupant]) -> OccupantSet {
        bits.iter()
            .fold(0, |acc, &o| acc | crate::occupants::occupant_bit(o))
    }

    #[test]
    fn both_v4_spellings_of_a_road_under_a_line_agree() {
        // The two build orders v4 could produce for the same physical tile.
        let road_first = tile_from_v4(TileKind::Road, wire_flags::POWER_OVERLAY, None, None);
        let line_first = tile_from_v4(
            TileKind::PowerLine,
            wire_flags::ROAD_UNDERLAY | wire_flags::POWER_OVERLAY,
            None,
            None,
        );
        assert_eq!(road_first.occupants(), set(&[Road, PowerLine]));
        assert_eq!(line_first.occupants(), road_first.occupants());
        assert_eq!(road_first.terrain, Terrain::Land);
    }

    #[test]
    fn both_v4_spellings_of_a_level_crossing_agree() {
        let road_last = tile_from_v4(TileKind::Road, wire_flags::RAIL_UNDERLAY, None, None);
        let rail_last = tile_from_v4(TileKind::Rail, wire_flags::ROAD_UNDERLAY, None, None);
        assert_eq!(road_last.occupants(), set(&[Road, Rail]));
        assert_eq!(rail_last.occupants(), road_last.occupants());
    }

    #[test]
    fn water_is_terrain_and_a_pylon_span_survives_it() {
        let t = tile_from_v4(TileKind::Water, wire_flags::POWER_OVERLAY, None, None);
        assert_eq!(t.terrain, Terrain::Water);
        assert_eq!(t.occupants(), set(&[PowerLine]));
    }

    #[test]
    fn a_v4_ghost_structure_converts_to_bare_ground() {
        let live = tile_from_v4(TileKind::Park, 0, None, Some(3));
        assert_eq!(live.occupants(), set(&[Structure]));

        // Same kind byte, no development behind it — a bulldozed park.
        let ghost = tile_from_v4(TileKind::Park, 0, None, None);
        assert_eq!(ghost.occupants(), 0, "a ghost keeps no occupant");
        assert_eq!(ghost.terrain, Terrain::Land);
    }

    #[test]
    fn an_unproducible_underground_byte_is_dropped() {
        let t = tile_from_v4(TileKind::Land, 0, Some(TileKind::CoalPlant), None);
        assert_eq!(t.occupants(), 0);
    }

    #[test]
    fn a_pipe_is_underground_and_leaves_the_ground_bare() {
        let t = tile_from_v4(TileKind::Land, 0, Some(TileKind::WaterPipe), None);
        assert_eq!(t.occupants(), set(&[Pipe]));
        assert_eq!(t.visible_occupants(), 0);
    }

    #[test]
    fn density_comes_out_of_the_old_flag_bits_and_the_rest_are_dropped() {
        let t = tile_from_v4(
            TileKind::Residential,
            (2 << V4_ZONE_DENSITY_SHIFT) | wire_flags::POWERED | wire_flags::ROAD_UNDERLAY,
            None,
            None,
        );
        assert_eq!(t.density, ZoneDensity::High);
        assert_eq!(
            t.flags,
            wire_flags::POWERED,
            "only the derived flags survive into storage"
        );
        assert_eq!(t.occupants(), set(&[ZoneResidential, Road]));
    }

    /// Every producible v4 spelling decodes to a set whose occupants all belong
    /// to a declared stratum — a cheap guard that no bit escapes the model.
    #[test]
    fn every_decoded_bit_is_a_declared_occupant() {
        for k in 0u8..20 {
            let Some(kind) = TileKind::from_u8(k) else {
                continue;
            };
            for f in 0u8..64 {
                let t = tile_from_v4(kind, f, Some(TileKind::WaterPipe), Some(1));
                assert_eq!(
                    t.occupants() & !crate::occupants::ALL_MASK,
                    0,
                    "{kind:?}/{f} decoded an undeclared bit"
                );
                assert!(iter_set(t.occupants()).count() <= 11);
            }
        }
    }

    /// [`building_kind_of`]'s domain is a strict superset of
    /// [`is_structure_kind`]'s: every non-zone structure kind converts (the
    /// two must agree there, or `import.rs`'s decode loop would tag a tile
    /// `Structure` with no `BuildingKind` to build the instance from), *and*
    /// the three zone kinds also convert even though `is_structure_kind` is
    /// `false` for them — a developed lot's `BuildingInstance` is templated
    /// from `Residential`/`Commercial`/`Industrial` too, it just carries a
    /// zone tag rather than the `Structure` occupant (`is_structure_kind`'s
    /// own doc comment). Every other `TileKind` converts to neither.
    #[test]
    fn building_kind_of_is_a_superset_of_is_structure_kind_covering_zones_too() {
        for &kind in TileKind::ALL {
            let is_zone = matches!(
                kind,
                TileKind::Residential | TileKind::Commercial | TileKind::Industrial
            );
            assert_eq!(
                building_kind_of(kind).is_some(),
                is_structure_kind(kind) || is_zone,
                "{kind:?}: building_kind_of should be Some iff the kind is a \
                 non-zone structure or one of the three zone kinds"
            );
        }
    }

    /// The thirteen conversions land on the `BuildingKind` the name says,
    /// not just on *some* `Some(_)`.
    #[test]
    fn building_kind_of_maps_each_structure_tile_kind_to_the_matching_building_kind() {
        let cases = [
            (TileKind::Residential, BuildingKind::Residential),
            (TileKind::Commercial, BuildingKind::Commercial),
            (TileKind::Industrial, BuildingKind::Industrial),
            (TileKind::HydroPlant, BuildingKind::HydroPlant),
            (TileKind::CoalPlant, BuildingKind::CoalPlant),
            (TileKind::WindTurbine, BuildingKind::WindTurbine),
            (TileKind::SolarFarm, BuildingKind::SolarFarm),
            (TileKind::WaterPump, BuildingKind::WaterPump),
            (TileKind::WaterTower, BuildingKind::WaterTower),
            (TileKind::ElementarySchool, BuildingKind::ElementarySchool),
            (TileKind::HighSchool, BuildingKind::HighSchool),
            (TileKind::Park, BuildingKind::Park),
            (TileKind::ParkLarge, BuildingKind::ParkLarge),
        ];
        for (tile_kind, building_kind) in cases {
            assert_eq!(building_kind_of(tile_kind), Some(building_kind));
        }
    }

    #[test]
    fn building_kind_of_is_none_for_non_structure_tile_kinds() {
        for kind in [
            TileKind::Land,
            TileKind::Water,
            TileKind::Tree,
            TileKind::Road,
            TileKind::Rail,
            TileKind::PowerLine,
            TileKind::WaterPipe,
        ] {
            assert_eq!(building_kind_of(kind), None, "{kind:?}");
        }
    }
}
