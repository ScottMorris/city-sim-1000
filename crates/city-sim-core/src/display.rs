// display.rs — deriving the wire tile bytes from the canonical strata.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

//! The single place that turns a stratified [`Tile`] back into the v4-shaped
//! `(kind, flags, underground)` triple the wire has always carried.
//!
//! Three emitters call it and no other code may reimplement it:
//!
//! - `city-sim-wasm`'s `SimHost::tile_buffer` — the SoA `kind[N]` / `flags[N]`
//!   / `underground_kind[N]` arrays the TypeScript renderer reads;
//! - `tauri-plugin-city-sim`'s `build_tick_event` — the kind byte array on
//!   `TickEvent`;
//! - [`crate::sim::state_hash`], whose committed golden hash pins the bytes for
//!   the small road-and-zone city `make_city_sim` builds. That city reaches
//!   none of the three deltas below — no structure, no bulldozer, no rail, no
//!   line — so the golden hash proves the derivation did not disturb the
//!   ordinary case, not that it is byte-identical everywhere. The tests named
//!   under "the three deltas" are what cover the rest.
//!
//! **The rule is "reproduce the canonical spelling `apply_tool` used to write",
//! not "apply visual precedence".** The renderer's visual precedence — road and
//! rail are the base sprite, hydro composites on top — lives entirely in
//! `tileRenderUtils.ts` and is spelling-agnostic: `carriagewayBeneath` reads
//! `roadUnderlay || kind === Road`, `carriesHydroOverlay` reads `powerOverlay ||
//! (kind === PowerLine && …)`. But three consumers are *not* spelling-agnostic
//! — `ui/minimap.ts` (`powerOverlay → railUnderlay → roadUnderlay →
//! palette[kind]`), `getTileColour` (`palette[kind]`, brightened only when
//! `kind === PowerLine`) and the HUD tile inspector, which prints the `kind`
//! string verbatim in its Type row (`hud.ts`). Emitting the visual order would
//! change the flat colour of every road that carries a line. Emitting the old
//! canonical order changes nothing for any tile `apply_tool` can build, so that
//! is what this does. (It is not a no-op over every *legacy* spelling — see
//! delta 2 below.)
//!
//! ## The three deltas
//!
//! Exactly three classes of tile come off the wire differently than they did on
//! **the pre-strata tree** — step 2 of #177,
//! `fix(sim): read every stratum, so no feature goes uncounted`, the last commit
//! where `kind` was canonical. That baseline is named by commit *subject*
//! throughout this branch, not by hash: the branch has been rebased more than
//! once and a hash cited here does not survive it. Two are
//! **normalisations** — one physical tile that v4 could spell two ways,
//! collapsing onto one — and the third is a **behaviour fix** that reversing
//! the derivation forced. Nothing else changes;
//! `the_two_normalisations` pins the first two, and
//! `commands::tests::a_bulldozed_park_leaves_bare_ground`,
//! `commands::tests::one_bulldozer_click_clears_a_whole_footprint` and
//! `wilderness::tests::a_bulldozed_park_stops_scoring_as_a_park` pin the third.
//! `every_tool_built_tile_against_the_v4_bytes` records, case by case, which
//! tool sequences are byte-identical to v4 and which are not.
//!
//! 1. **A bare level crossing.** `Tool::Road` over rail wrote `Road` +
//!    `RAIL_UNDERLAY`; `Tool::Rail` over road wrote `Rail` + `ROAD_UNDERLAY`.
//!    **Rail wins** — a player drags a railway across an existing road network
//!    far more often than the reverse, so it is the spelling most saves already
//!    hold, and `commands.rs` writes it in both build orders now. The sprite is
//!    unchanged (`resolveBaseTileSprite` tests `(Rail && roadUnderlay) || (Road
//!    && railUnderlay)`, and `pickRailCrossingTexture` orients off the rail axis
//!    either way) and so are the renderer's debug labels. What changes is a
//!    road-last crossing's *flat* colour, and the two consumers move opposite
//!    ways: `minimap.ts` tests `railUnderlay` before `roadUnderlay`, so
//!    `(Road, RAIL_UNDERLAY)` drew rail-brown and `(Rail, ROAD_UNDERLAY)` now
//!    draws road-grey; `getTileColour` reads `palette[kind]`, so the same tile
//!    goes road-grey → rail-brown on the renderer's flat-colour path. The
//!    inspector's Type row reads `road` → `rail`.
//!
//! 2. **A bare hydro line on open ground.** `Tool::PowerLine` wrote
//!    `PowerLine` with `POWER_OVERLAY`; regrading or planting under a line left
//!    the *same physical tile* spelled `Land` with `POWER_OVERLAY`, the line
//!    demoted to the flag. **`PowerLine` wins** — it is what the tool writes,
//!    it is what
//!    `getTileColour` and `carriesWires` expect of a line, and normalising the
//!    other way would erase every bare line from the wire. What changes is that
//!    a terraformed line now draws the opaque hydro sprite and takes the
//!    powerline palette colour, instead of drawing grass with a transparent
//!    wire composited on top. That is the same tile drawing two different ways
//!    depending on its history — the bug class `docs/tile-model.md` is about —
//!    so collapsing it is the point rather than a cost.
//!
//!    The same collapse reaches one spelling `apply_tool` can no longer
//!    produce but old saves still carry: a road under a line spelled `Road` +
//!    `POWER_OVERLAY`, written before the road/rail/line tools were made
//!    build-order symmetric (`migrate.rs` names both v4 spellings). It loads as
//!    `{Road, PowerLine}` and re-emits as `PowerLine` + `ROAD_UNDERLAY |
//!    POWER_OVERLAY` — the canonical spelling of that tile — so it changes flat
//!    colour from road-grey to the hydro palette on load. Same normalisation,
//!    not a fourth delta, and the only case where "emitting the canonical order
//!    changes nothing" does not hold.
//!
//! 3. **A bulldozed footprint building.** *Not* a normalisation — a deliberate
//!    behaviour change, and the only one of the three that moves a number.
//!    `remove_building` deleted the `BuildingInstance` and cleared
//!    `building_id` but kept `kind`, leaving a park spelled `Park` with nothing
//!    behind it: it took a second bulldozer click to clear and went on scoring
//!    +4.0 of wilderness for ever. Under the strata that ghost is
//!    unrepresentable — `Occupant::Structure` is one flat tag whose identity
//!    lives on the `BuildingInstance` — so `remove_building` now clears the tag
//!    with the development and the tile emits `Land`. On an 8×8 city
//!    `Tool::Park` then `Tool::Bulldoze` moves the razed tile's eco from 2.0615
//!    back to bare ground's 1.0000 and the city score from 67.03 to 66.67,
//!    which is the point: the razed tile now scores what is actually there.
//!    `migrate::tile_from_v4` applies the same rule to ghosts already sitting
//!    in v4 saves (`snapshot.rs`'s `Normalisation::GhostStructure`), so a
//!    loaded city agrees with a freshly bulldozed one.

use crate::occupants::{zone_template_kind, Occupant, StructureLookup, Terrain};
use crate::state::{Tile, DERIVED_FLAG_MASK};
use city_sim_protocol::tile_buffer::flags;
use city_sim_protocol::tile_kind::TileKind;

/// The `kind` byte for a tile.
///
/// Precedence ladder, highest first. Each rung is the spelling the tool that
/// produces it used to write:
///
/// 1. `terrain == Water` → `Water`. `Tool::Water` over a live line wrote
///    `kind = Water` and left the overlay flag standing, so water outranks the
///    span it carries.
/// 2. `Structure` → the structure's own kind, resolved through the development.
///    `wasmSimBridge.ts` reads this byte back as the template id for the
///    display building mirror, so it must be exact.
/// 3. a zone tag → `Residential` | `Commercial` | `Industrial`.
///    `Tool::PowerLine` deliberately did not overwrite a zoned tile's kind, and
///    zoning left `POWER_OVERLAY` standing, so `{Zone, PowerLine}` is the zone.
/// 4. `Trees` → `Tree`. Above `PowerLine`, counter-intuitively but correctly:
///    `Tool::Tree` over a line wrote `kind = Tree` and left the overlay
///    (`known_defect_trees_are_planted_through_a_live_hydro_line`), and the
///    converse could not arise because `Tool::PowerLine` destroyed the canopy.
/// 5. `PowerLine` → `PowerLine`. Above road and rail: both build orders of
///    line-over-carriageway wrote `kind = PowerLine` plus an underlay flag.
///    This rung is also normalisation 2 — see the module note.
/// 6. `Rail` → `Rail`. Above `Road`: normalisation 1.
/// 7. `Road` → `Road`.
/// 8. otherwise → `Land`.
pub fn wire_kind(tile: &Tile, lookup: &StructureLookup) -> TileKind {
    if tile.terrain == Terrain::Water {
        // No `debug_assert` that the surface is empty, tempting as it is. Every
        // tool that builds forces `Terrain::Land`, so `apply_tool` cannot
        // produce drowned infrastructure — but saves written before the terrain
        // brushes learned to clear both spellings of a carriageway do carry it,
        // and this function has to be total over what loads, not only over what
        // is buildable. Water still wins the byte, exactly as `kind = Water`
        // did, and the road comes back out in `ROAD_UNDERLAY`.
        return TileKind::Water;
    }
    if let Some(kind) = lookup.structure_kind(tile) {
        return kind;
    }
    if let Some(zone) = tile.zone_occupant() {
        // Infallible: `zone_occupant` only ever returns one of the three tags.
        if let Some(kind) = zone_template_kind(zone) {
            return kind;
        }
    }
    if tile.has_occupant(Occupant::Trees) {
        return TileKind::Tree;
    }
    if tile.has_occupant(Occupant::PowerLine) {
        return TileKind::PowerLine;
    }
    if tile.has_occupant(Occupant::Rail) {
        return TileKind::Rail;
    }
    if tile.has_occupant(Occupant::Road) {
        return TileKind::Road;
    }
    TileKind::Land
}

/// The `flags` byte for a tile — all six protocol bits.
///
/// `POWERED` / `WATERED` / `ABANDONED` are copied straight off the tile; the three
/// structural bits are re-derived. An underlay bit means "this occupant is
/// present but did not win the kind byte", which is exactly the fallback the
/// flags were minted as. `POWER_OVERLAY` is unconditional, even when the kind
/// byte is already `PowerLine`, because `Tool::PowerLine` always set both.
///
/// The zone-density bits 6–7 are emitted as 0, exactly as before: nothing ever
/// set them on the wire.
pub fn wire_flags(tile: &Tile, kind: TileKind) -> u8 {
    let mut out = tile.flags & DERIVED_FLAG_MASK;
    if tile.has_occupant(Occupant::Road) && kind != TileKind::Road {
        out |= flags::ROAD_UNDERLAY;
    }
    if tile.has_occupant(Occupant::Rail) && kind != TileKind::Rail {
        out |= flags::RAIL_UNDERLAY;
    }
    if tile.has_occupant(Occupant::PowerLine) {
        out |= flags::POWER_OVERLAY;
    }
    out
}

/// The `underground_kind` byte — `WaterPipe` or the 0xFF "nothing" sentinel
/// (0 is `TileKind::Land`, so it cannot serve).
pub fn wire_underground(tile: &Tile) -> u8 {
    if tile.has_occupant(Occupant::Pipe) {
        TileKind::WaterPipe as u8
    } else {
        0xFF
    }
}

/// Both bytes at once, for the emitters that want them together.
#[inline]
pub fn wire_kind_and_flags(tile: &Tile, lookup: &StructureLookup) -> (TileKind, u8) {
    let kind = wire_kind(tile, lookup);
    (kind, wire_flags(tile, kind))
}

/// The wire kind byte of one tile, indexing the building list on the spot.
///
/// Test convenience — this is how the assertions that used to read `tile.kind`
/// ask their question now. Production emitters build the [`StructureLookup`]
/// once per pass instead; doing it per tile is O(B) each time.
#[cfg(test)]
pub fn wire_kind_at(state: &crate::state::GameState, x: u32, y: u32) -> TileKind {
    let lookup = StructureLookup::new(state);
    wire_kind(state.tile_at(x, y).expect("tile in bounds"), &lookup)
}

/// The wire flags byte of one tile. Same caveat as [`wire_kind_at`].
#[cfg(test)]
pub fn wire_flags_at(state: &crate::state::GameState, x: u32, y: u32) -> u8 {
    let lookup = StructureLookup::new(state);
    let tile = state.tile_at(x, y).expect("tile in bounds");
    wire_flags(tile, wire_kind(tile, &lookup))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::apply_tool;
    use crate::migrate::tile_from_v4;
    use crate::state::GameState;
    use city_sim_protocol::commands::Tool;

    /// A lookup over a city with no buildings — enough for every tile whose
    /// spelling does not involve a structure.
    fn empty_lookup() -> StructureLookup {
        StructureLookup::new(&GameState::new(1, 1, 0))
    }

    /// Every v4 `(kind, structural flags)` spelling, decoded into the strata,
    /// re-emitted, and decoded again — the second decode must equal the first.
    ///
    /// This is the *lossless* half of the proof, and it holds over the whole
    /// space including spellings no tool could produce: whatever the wire says
    /// coming out means exactly the tile that went in. It deliberately does
    /// **not** claim the bytes are identical, because for two physical tiles
    /// they cannot be — see `the_two_normalisations`. The byte comparison is
    /// `every_tool_built_tile_against_the_v4_bytes`, which enumerates what
    /// `apply_tool` can actually build and records, case by case, whether v4
    /// wrote the same bytes or different ones.
    #[test]
    fn every_v4_spelling_survives_a_round_trip_through_the_wire() {
        let lookup = empty_lookup();
        let mut checked = 0;
        for k in 0u8..20 {
            let Some(kind) = TileKind::from_u8(k) else {
                continue;
            };
            for i in 0u8..8 {
                let f = (if i & 1 != 0 { flags::ROAD_UNDERLAY } else { 0 })
                    | (if i & 2 != 0 { flags::RAIL_UNDERLAY } else { 0 })
                    | (if i & 4 != 0 { flags::POWER_OVERLAY } else { 0 });
                for underground in [None, Some(TileKind::WaterPipe)] {
                    // A structure kind is given a development, or it decodes to
                    // the bare ground a v4 ghost really was.
                    let bid = crate::occupants::is_structure_kind(kind).then_some(1);
                    let tile = tile_from_v4(kind, f, underground, bid);
                    let lookup = match bid {
                        Some(_) => {
                            let mut s = GameState::new(1, 1, 0);
                            s.buildings.push(crate::buildings::BuildingInstance::new(
                                1,
                                kind,
                                (0, 0),
                            ));
                            s.next_building_id = 2;
                            StructureLookup::new(&s)
                        }
                        None => empty_lookup(),
                    };
                    let (wk, wf) = wire_kind_and_flags(&tile, &lookup);
                    let wu = wire_underground(&tile);
                    let back = tile_from_v4(
                        wk,
                        wf,
                        (wu != 0xFF).then_some(TileKind::WaterPipe),
                        tile.building_id,
                    );
                    assert_eq!(
                        (back.terrain, back.occupants()),
                        (tile.terrain, tile.occupants()),
                        "v4 ({kind:?}, {f:#06b}, {underground:?}) did not survive the wire"
                    );
                    checked += 1;
                }
            }
        }
        let _ = lookup;
        assert!(checked >= 300, "only {checked} spellings enumerated");
    }

    /// **The two spellings the strata cannot tell apart, named.**
    ///
    /// v4 could write the same physical tile two ways, and the difference was
    /// always *build order* — which is not stored, and is not a property of the
    /// tile. Both normalise, and both normalise onto the spelling a player is
    /// likelier to already have in a save.
    #[test]
    fn the_two_normalisations() {
        let lookup = empty_lookup();

        // 1. A bare level crossing. `Tool::Road` over rail wrote Road +
        //    RAIL_UNDERLAY, `Tool::Rail` over road wrote Rail + ROAD_UNDERLAY.
        //    Rail wins: dragging a railway across an existing road network is
        //    far commoner than the reverse.
        for f in [flags::RAIL_UNDERLAY, flags::ROAD_UNDERLAY] {
            let kind = if f == flags::RAIL_UNDERLAY {
                TileKind::Road
            } else {
                TileKind::Rail
            };
            let tile = tile_from_v4(kind, f, None, None);
            assert_eq!(
                wire_kind_and_flags(&tile, &lookup),
                (TileKind::Rail, flags::ROAD_UNDERLAY),
                "level crossing spelled ({kind:?}, {f:#06b})"
            );
        }

        // 2. A bare hydro line on open ground. `Tool::PowerLine` wrote
        //    PowerLine + POWER_OVERLAY; regrading under it left Land +
        //    POWER_OVERLAY, the same tile with the line demoted to the flag.
        //    PowerLine wins: it is what the tool writes, it is what
        //    `wasmSimBridge` and `getTileColour` expect of a line, and the
        //    alternative would erase every bare line from the wire.
        for kind in [TileKind::PowerLine, TileKind::Land] {
            let tile = tile_from_v4(kind, flags::POWER_OVERLAY, None, None);
            assert_eq!(
                wire_kind_and_flags(&tile, &lookup),
                (TileKind::PowerLine, flags::POWER_OVERLAY),
                "bare line spelled {kind:?}"
            );
        }

        // Everything else that could hold `kind` over a line still does:
        // terrain, a zone and the canopy all outrank the span above them.
        for (kind, want) in [
            (TileKind::Water, TileKind::Water),
            (TileKind::Tree, TileKind::Tree),
            (TileKind::Residential, TileKind::Residential),
            (TileKind::Commercial, TileKind::Commercial),
            (TileKind::Industrial, TileKind::Industrial),
        ] {
            let tile = tile_from_v4(kind, flags::POWER_OVERLAY, None, None);
            assert_eq!(
                wire_kind_and_flags(&tile, &lookup),
                (want, flags::POWER_OVERLAY),
                "{kind:?} under a line"
            );
        }
    }

    #[test]
    fn the_derived_flags_survive_untouched() {
        let mut tile = tile_from_v4(TileKind::Road, 0, None, None);
        tile.flags = flags::POWERED | flags::WATERED | flags::ABANDONED;
        let (kind, f) = wire_kind_and_flags(&tile, &empty_lookup());
        assert_eq!(kind, TileKind::Road);
        assert_eq!(f, flags::POWERED | flags::WATERED | flags::ABANDONED);
    }

    #[test]
    fn a_structure_emits_its_own_kind_not_a_flat_tag() {
        let mut s = GameState::new(6, 6, 0);
        apply_tool(&mut s, Tool::CoalPlant, 0, 0);
        apply_tool(&mut s, Tool::Park, 4, 4);
        let lookup = StructureLookup::new(&s);
        assert_eq!(
            wire_kind(&s.tiles[0], &lookup),
            TileKind::CoalPlant,
            "the coal plant's footprint origin"
        );
        assert_eq!(wire_kind(s.tile_at(4, 4).unwrap(), &lookup), TileKind::Park);
    }

    #[test]
    fn a_developed_zone_lot_still_emits_its_zone() {
        let mut s = GameState::new(4, 4, 0);
        apply_tool(&mut s, Tool::Residential, 1, 1);
        let lookup = StructureLookup::new(&s);
        assert_eq!(
            wire_kind(s.tile_at(1, 1).unwrap(), &lookup),
            TileKind::Residential
        );
    }

    #[test]
    fn a_buried_pipe_uses_the_sentinel_when_absent() {
        let mut s = GameState::new(4, 4, 0);
        assert_eq!(wire_underground(&s.tiles[0]), 0xFF);
        apply_tool(&mut s, Tool::WaterPipe, 0, 0);
        assert_eq!(wire_underground(&s.tiles[0]), TileKind::WaterPipe as u8);
    }

    /// Where v4 wrote the same bytes for a tool sequence, and where it did not.
    ///
    /// Every case's third column is what the pre-strata tree — the last commit
    /// where `kind` was canonical, named in this module's note — emitted for the
    /// identical sequence, read off that tree through `apply_tool` +
    /// `tile.kind`/`tile.flags`. `Same` is the
    /// byte-identity claim, case by case. `Was(..)` is an acknowledged delta,
    /// and the comment beside it names which of the module note's three it is.
    ///
    /// **There are exactly three `Was(..)` cases here and that is the point.**
    /// The list covers the producible occupant vocabulary, so a fourth
    /// appearing means reversing the derivation changed something nobody
    /// decided to change.
    #[test]
    fn every_tool_built_tile_against_the_v4_bytes() {
        /// What v4 emitted, relative to what this tree emits.
        #[derive(Debug)]
        enum V4 {
            /// v4 wrote these exact bytes too.
            Same,
            /// v4 wrote different bytes. Deliberate — see the module note.
            Was(TileKind, u8),
        }
        use V4::{Same, Was};

        let cases: &[(&[Tool], TileKind, u8, V4)] = &[
            (&[], TileKind::Land, 0, Same),
            (&[Tool::Tree], TileKind::Tree, 0, Same),
            (&[Tool::Road], TileKind::Road, 0, Same),
            (&[Tool::Rail], TileKind::Rail, 0, Same),
            (
                &[Tool::Road, Tool::Rail],
                TileKind::Rail,
                flags::ROAD_UNDERLAY,
                Same,
            ),
            // Delta 1 — the level crossing. v4 spelled a road-last crossing
            // the other way round; build order is not stored, so it collapses.
            (
                &[Tool::Rail, Tool::Road],
                TileKind::Rail,
                flags::ROAD_UNDERLAY,
                Was(TileKind::Road, flags::RAIL_UNDERLAY),
            ),
            (
                &[Tool::PowerLine],
                TileKind::PowerLine,
                flags::POWER_OVERLAY,
                Same,
            ),
            (
                &[Tool::Road, Tool::PowerLine],
                TileKind::PowerLine,
                flags::ROAD_UNDERLAY | flags::POWER_OVERLAY,
                Same,
            ),
            (
                &[Tool::PowerLine, Tool::Road],
                TileKind::PowerLine,
                flags::ROAD_UNDERLAY | flags::POWER_OVERLAY,
                Same,
            ),
            (
                &[Tool::Rail, Tool::PowerLine],
                TileKind::PowerLine,
                flags::RAIL_UNDERLAY | flags::POWER_OVERLAY,
                Same,
            ),
            (
                &[Tool::Road, Tool::Rail, Tool::PowerLine],
                TileKind::PowerLine,
                flags::ROAD_UNDERLAY | flags::RAIL_UNDERLAY | flags::POWER_OVERLAY,
                Same,
            ),
            (&[Tool::Residential], TileKind::Residential, 0, Same),
            (
                &[Tool::Residential, Tool::PowerLine],
                TileKind::Residential,
                flags::POWER_OVERLAY,
                Same,
            ),
            (
                &[Tool::PowerLine, Tool::Residential],
                TileKind::Residential,
                flags::POWER_OVERLAY,
                Same,
            ),
            (
                &[Tool::PowerLine, Tool::Tree],
                TileKind::Tree,
                flags::POWER_OVERLAY,
                Same,
            ),
            (&[Tool::Water], TileKind::Water, 0, Same),
            (
                &[Tool::PowerLine, Tool::Water],
                TileKind::Water,
                flags::POWER_OVERLAY,
                Same,
            ),
            (
                &[Tool::PowerLine, Tool::TerraformLower],
                TileKind::Water,
                flags::POWER_OVERLAY,
                Same,
            ),
            (&[Tool::TerraformRaise], TileKind::Land, 0, Same),
            (
                &[Tool::Water, Tool::TerraformRaise],
                TileKind::Land,
                0,
                Same,
            ),
            // Delta 2 — the line demoted to its flag by a regrade. v4 kept the
            // span only in `POWER_OVERLAY` and let `Land` take the kind byte.
            (
                &[Tool::PowerLine, Tool::TerraformRaise],
                TileKind::PowerLine,
                flags::POWER_OVERLAY,
                Was(TileKind::Land, flags::POWER_OVERLAY),
            ),
            (&[Tool::Park], TileKind::Park, 0, Same),
            // Delta 3 — the bulldozed footprint building. v4 kept the kind byte
            // after `remove_building` had taken the development away, so the
            // razed tile went on drawing and scoring as a park.
            (
                &[Tool::Park, Tool::Bulldoze],
                TileKind::Land,
                0,
                Was(TileKind::Park, 0),
            ),
            (&[Tool::Road, Tool::Bulldoze], TileKind::Land, 0, Same),
            (&[Tool::Rail, Tool::Bulldoze], TileKind::Land, 0, Same),
            (&[Tool::Tree, Tool::Bulldoze], TileKind::Land, 0, Same),
            (&[Tool::WaterPipe], TileKind::Land, 0, Same),
            (&[Tool::WaterPipe, Tool::Bulldoze], TileKind::Land, 0, Same),
            (
                &[Tool::Residential, Tool::Bulldoze],
                TileKind::Land,
                0,
                Same,
            ),
        ];

        let mut deltas = 0;
        for (tools, want_kind, want_flags, v4) in cases {
            let mut s = GameState::new(4, 4, 0);
            for &tool in *tools {
                let r = apply_tool(&mut s, tool, 1, 1);
                assert!(r.success, "{tools:?} — {tool:?} refused: {:?}", r.message);
            }
            let lookup = StructureLookup::new(&s);
            let (kind, f) = wire_kind_and_flags(s.tile_at(1, 1).unwrap(), &lookup);
            assert_eq!(
                (kind, f),
                (*want_kind, *want_flags),
                "{tools:?} emitted the wrong bytes"
            );
            // `Same` needs no second assertion — the v4 bytes *are* the
            // expected bytes, which the assert above just checked. `Was` does:
            // if a claimed delta has quietly become byte-identical again, the
            // table is stale and the module note is lying about the count.
            if let Was(k4, f4) = v4 {
                assert_ne!(
                    (kind, f),
                    (*k4, *f4),
                    "{tools:?} is marked as a delta from v4 but emits the v4 bytes"
                );
                deltas += 1;
            }
        }
        assert_eq!(
            deltas, 3,
            "the module note names three deltas from v4; this list holds {deltas}"
        );
    }
}
