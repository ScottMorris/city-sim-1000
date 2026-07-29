// migrate.rs — decoding the pre-strata (v4) tile shape into the canonical strata.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

//! One function, [`tile_from_v4`], and two consumers.
//!
//! Before step 3 of #177 a tile was a single-valued `kind: TileKind` plus three
//! structural flags (`ROAD_UNDERLAY`, `RAIL_UNDERLAY`, `POWER_OVERLAY`) and an
//! `underground: Option<TileKind>`. That shape still arrives from two places:
//!
//! - `import.rs`, decoding the SoA tile buffer a legacy TS save is re-encoded
//!   into — where the `kind` byte is legitimately canonical, because it is
//!   the wire and the wire never changed shape;
//! - the v4 snapshot migration, which reads the same triple out of a postcard
//!   payload.
//!
//! Both go through this one function, so the legacy importer and the save
//! migration are a single code path with a single test surface. Its body is
//! literally the old derived `Tile::occupants()` predicate, relocated: the
//! two spellings of a road under a line (`kind = Road` + `POWER_OVERLAY`, and
//! `kind = PowerLine` + `ROAD_UNDERLAY | POWER_OVERLAY`) collapse to the same
//! `{Road, PowerLine}` here, which is what makes the decode into the strata
//! lossless in the direction that matters.

use crate::occupants::{is_structure_kind, Occupant, OccupantSet, Terrain};
use crate::state::{GameState, Tile, ZoneDensity, DERIVED_FLAG_MASK};
use city_sim_protocol::tile_buffer::flags as wire_flags;
use city_sim_protocol::tile_kind::TileKind;

/// Zone density lived in flags bits 6–7 before it became a field.
const V4_ZONE_DENSITY_MASK: u8 = 0b1100_0000;
const V4_ZONE_DENSITY_SHIFT: u8 = 6;

/// Branch-free "set this bit when the predicate holds".
#[inline]
const fn bit_when(present: bool, o: Occupant) -> OccupantSet {
    (present as OccupantSet) << (o as u8)
}

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
    let occupants =
        // Underground
        bit_when(matches!(underground, Some(TileKind::WaterPipe)), Occupant::Pipe)
        // Surface
        | bit_when(kind == TileKind::Road || f & wire_flags::ROAD_UNDERLAY != 0, Occupant::Road)
        | bit_when(kind == TileKind::Rail || f & wire_flags::RAIL_UNDERLAY != 0, Occupant::Rail)
        | bit_when(kind == TileKind::Residential, Occupant::ZoneResidential)
        | bit_when(kind == TileKind::Commercial, Occupant::ZoneCommercial)
        | bit_when(kind == TileKind::Industrial, Occupant::ZoneIndustrial)
        | bit_when(is_structure_kind(kind) && building_id.is_some(), Occupant::Structure)
        // Overhead
        | bit_when(kind == TileKind::PowerLine || f & wire_flags::POWER_OVERLAY != 0, Occupant::PowerLine)
        | bit_when(kind == TileKind::Tree, Occupant::Trees);

    let density = match (f & V4_ZONE_DENSITY_MASK) >> V4_ZONE_DENSITY_SHIFT {
        1 => ZoneDensity::Medium,
        2 => ZoneDensity::High,
        _ => ZoneDensity::Low,
    };

    Tile {
        terrain: if kind == TileKind::Water {
            Terrain::Water
        } else {
            Terrain::Land
        },
        occupants,
        building_id,
        density,
        flags: f & DERIVED_FLAG_MASK,
        ..Tile::land()
    }
}

// ---------------------------------------------------------------------------
// The v4 snapshot shim
// ---------------------------------------------------------------------------

/// The v4 `GameState` and `Tile`, described field for field and **in order**.
///
/// Postcard is not self-describing: there are no field names and no lengths on
/// the wire, so fields are decoded purely positionally. That means you cannot
/// deserialise "just the tiles" differently — the whole top-level struct has to
/// be spelled out, which is what this module is for.
///
/// **The nested types are the live ones on purpose.** `UtilityStats`,
/// `DemandStats`, `BudgetStats`, `EducationStats`, `BudgetHistoryEntry`,
/// `BuildingInstance`, `SeededRng`, `Policies` and `WildernessStats` are
/// re-used rather than copied, because none of them changed shape in step 3
/// — only [`Tile`] did. It is a deliberate trade: it saves ~200 lines of
/// duplication, at the cost of a drift risk (someone edits `BudgetStats` in
/// 2027 and silently changes what "v4" means). That risk is caught by
/// `v4_snapshot_loads_the_same_city`, which decodes a committed byte-for-byte
/// v4 file — and that is exactly the test that would have to catch a
/// duplicated-and-diverged copy too, so duplication would buy nothing.
pub(crate) mod v4 {
    use crate::buildings::BuildingInstance;
    use crate::rng::SeededRng;
    use crate::state::{
        BudgetHistoryEntry, BudgetStats, DemandStats, EducationStats, UtilityStats,
    };
    use crate::wilderness::WildernessStats;
    use city_sim_protocol::commands::Policies;
    use city_sim_protocol::tile_kind::TileKind;
    use std::collections::VecDeque;

    /// The pre-strata tile: one `kind` slot, three structural flags packed into
    /// `flags`, and a separate `underground` slot.
    #[derive(serde::Deserialize)]
    pub struct Tile {
        pub kind: TileKind,
        pub flags: u8,
        pub happiness: f32,
        pub elevation: u8,
        pub building_id: Option<u16>,
        pub underground: Option<TileKind>,
        pub power_plant_mw: i32,
        pub water_output: i32,
        pub elementary_served: bool,
        pub high_served: bool,
        pub elementary_score: f32,
        pub high_score: f32,
    }

    /// The v4 top-level state. `tiles` is the one substituted field; every
    /// other field is the live type at the live position.
    #[derive(serde::Deserialize)]
    pub struct GameState {
        pub width: u32,
        pub height: u32,
        pub tiles: Vec<Tile>,
        pub seed: u32,
        pub rng: SeededRng,
        pub money: i64,
        pub day: u32,
        pub tick: u64,
        pub population: u32,
        pub jobs: u32,
        pub pop_frac: f64,
        pub jobs_frac: f64,
        pub money_frac: f64,
        pub day_frac: f64,
        pub utilities: UtilityStats,
        pub demand: DemandStats,
        pub tile_revision: u32,
        pub next_building_id: u32,
        pub buildings: Vec<BuildingInstance>,
        pub education: EducationStats,
        pub budget: BudgetStats,
        pub budget_history: VecDeque<BudgetHistoryEntry>,
        pub policies: Policies,
        pub wilderness: WildernessStats,
    }
}

/// Convert a decoded v4 snapshot into the current [`GameState`].
///
/// Only the tile vector actually changes shape; everything else moves across
/// unchanged. Each tile goes through [`tile_from_v4`], so the save migration
/// and the legacy `import.rs` buffer path are one code path with one test
/// surface — and the derived fields the v4 tile carried (happiness, elevation,
/// the cached utility outputs, the four education fields) are copied over it,
/// because `tile_from_v4` only knows about structure.
pub(crate) fn v4_to_v5(old: v4::GameState) -> GameState {
    let tiles = old
        .tiles
        .into_iter()
        .map(|t| Tile {
            happiness: t.happiness,
            elevation: t.elevation,
            power_plant_mw: t.power_plant_mw,
            water_output: t.water_output,
            elementary_served: t.elementary_served,
            high_served: t.high_served,
            elementary_score: t.elementary_score,
            high_score: t.high_score,
            ..tile_from_v4(t.kind, t.flags, t.underground, t.building_id)
        })
        .collect();

    GameState {
        width: old.width,
        height: old.height,
        tiles,
        seed: old.seed,
        rng: old.rng,
        money: old.money,
        day: old.day,
        tick: old.tick,
        population: old.population,
        jobs: old.jobs,
        pop_frac: old.pop_frac,
        jobs_frac: old.jobs_frac,
        money_frac: old.money_frac,
        day_frac: old.day_frac,
        utilities: old.utilities,
        demand: old.demand,
        tile_revision: old.tile_revision,
        next_building_id: old.next_building_id,
        buildings: old.buildings,
        education: old.education,
        budget: old.budget,
        budget_history: old.budget_history,
        policies: old.policies,
        wilderness: old.wilderness,
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
    tile.occupants = v4.occupants;
    tile.density = v4.density;
}

/// Test-only shorthand for a bare `tile.kind = kind` on an otherwise-empty tile.
#[cfg(test)]
pub fn set_v4_kind(tile: &mut Tile, kind: TileKind) {
    set_v4(tile, kind, 0, None);
}

#[cfg(test)]
mod state_migration_tests {
    use super::*;

    /// Every per-tile field a v4 tile carried must arrive on the other side.
    ///
    /// [`tile_from_v4`] only knows about *structure* — it leaves the derived
    /// fields at [`Tile::land`]'s defaults for the caller to fill in, and
    /// [`v4_to_v5`] is that caller. The failure this guards is silent: add a
    /// field to [`Tile`], forget it in `v4_to_v5`, and every v4 save loads with
    /// it quietly zeroed. Naming all eight here means the next person to add a
    /// field finds out from a test rather than from a player's ruined city.
    #[test]
    fn v4_to_v5_carries_every_derived_tile_field_across() {
        let base = GameState::new(1, 1, 1);
        let old = v4::GameState {
            width: 1,
            height: 1,
            tiles: vec![v4::Tile {
                kind: TileKind::Residential,
                flags: wire_flags::POWERED,
                happiness: 1.25,
                elevation: 7,
                building_id: Some(4),
                underground: Some(TileKind::WaterPipe),
                power_plant_mw: 55,
                water_output: 66,
                elementary_served: true,
                high_served: false,
                elementary_score: 0.75,
                high_score: 0.25,
            }],
            seed: base.seed,
            rng: base.rng.clone(),
            money: 4321,
            day: 9,
            tick: 180,
            population: 12,
            jobs: 34,
            pop_frac: 0.5,
            jobs_frac: 0.25,
            money_frac: 0.125,
            day_frac: 0.0625,
            utilities: base.utilities.clone(),
            demand: base.demand.clone(),
            tile_revision: 3,
            next_building_id: 5,
            buildings: Vec::new(),
            education: base.education.clone(),
            budget: base.budget.clone(),
            budget_history: base.budget_history.clone(),
            policies: base.policies,
            wilderness: base.wilderness.clone(),
        };

        let new = v4_to_v5(old);
        let t = &new.tiles[0];

        // Derived fields — copied verbatim.
        assert_eq!(t.happiness, 1.25);
        assert_eq!(t.elevation, 7);
        assert_eq!(t.power_plant_mw, 55);
        assert_eq!(t.water_output, 66);
        assert!(t.elementary_served);
        assert!(!t.high_served);
        assert_eq!(t.elementary_score, 0.75);
        assert_eq!(t.high_score, 0.25);
        // Structural fields — converted.
        assert_eq!(t.terrain, Terrain::Land);
        assert!(t.has_occupant(Occupant::ZoneResidential));
        assert!(t.has_occupant(Occupant::Pipe));
        assert_eq!(t.building_id, Some(4));
        assert_eq!(t.flags, wire_flags::POWERED);

        // And the scalars that simply move across.
        assert_eq!(new.money, 4321);
        assert_eq!(new.day, 9);
        assert_eq!(new.tick, 180);
        assert_eq!(new.population, 12);
        assert_eq!(new.jobs, 34);
        assert_eq!(new.pop_frac, 0.5);
        assert_eq!(new.jobs_frac, 0.25);
        assert_eq!(new.money_frac, 0.125);
        assert_eq!(new.day_frac, 0.0625);
        assert_eq!(new.tile_revision, 3);
        assert_eq!(new.next_building_id, 5);
    }
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
        assert_eq!(road_first.occupants, set(&[Road, PowerLine]));
        assert_eq!(line_first.occupants, road_first.occupants);
        assert_eq!(road_first.terrain, Terrain::Land);
    }

    #[test]
    fn both_v4_spellings_of_a_level_crossing_agree() {
        let road_last = tile_from_v4(TileKind::Road, wire_flags::RAIL_UNDERLAY, None, None);
        let rail_last = tile_from_v4(TileKind::Rail, wire_flags::ROAD_UNDERLAY, None, None);
        assert_eq!(road_last.occupants, set(&[Road, Rail]));
        assert_eq!(rail_last.occupants, road_last.occupants);
    }

    #[test]
    fn water_is_terrain_and_a_pylon_span_survives_it() {
        let t = tile_from_v4(TileKind::Water, wire_flags::POWER_OVERLAY, None, None);
        assert_eq!(t.terrain, Terrain::Water);
        assert_eq!(t.occupants, set(&[PowerLine]));
    }

    #[test]
    fn a_v4_ghost_structure_converts_to_bare_ground() {
        let live = tile_from_v4(TileKind::Park, 0, None, Some(3));
        assert_eq!(live.occupants, set(&[Structure]));

        // Same kind byte, no development behind it — a bulldozed park.
        let ghost = tile_from_v4(TileKind::Park, 0, None, None);
        assert_eq!(ghost.occupants, 0, "a ghost keeps no occupant");
        assert_eq!(ghost.terrain, Terrain::Land);
    }

    #[test]
    fn an_unproducible_underground_byte_is_dropped() {
        let t = tile_from_v4(TileKind::Land, 0, Some(TileKind::CoalPlant), None);
        assert_eq!(t.occupants, 0);
    }

    #[test]
    fn a_pipe_is_underground_and_leaves_the_ground_bare() {
        let t = tile_from_v4(TileKind::Land, 0, Some(TileKind::WaterPipe), None);
        assert_eq!(t.occupants, set(&[Pipe]));
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
        assert_eq!(t.occupants, set(&[ZoneResidential, Road]));
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
                    t.occupants & !crate::occupants::ALL_MASK,
                    0,
                    "{kind:?}/{f} decoded an undeclared bit"
                );
                assert!(iter_set(t.occupants).count() <= 11);
            }
        }
    }
}
