// utilities.rs — power and water network propagation.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use crate::buildings::BuildingStatus;
use crate::occupants::Network;
use crate::state::{GameState, Tile, FLAG_POWERED, FLAG_WATERED};
use std::collections::VecDeque;

/// Which utility network to recompute.
///
/// The same generic BFS drives both power and water — see the locked
/// architecture decision in `docs/rust-migration-plan.md`. Extensible to
/// sewage, heat, etc. by adding variants here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UtilityKind {
    Power,
    Water,
}

impl UtilityKind {
    /// The [`Network`] this utility propagates along.
    ///
    /// Two enums for what looks like one concept, because they answer
    /// different questions: `UtilityKind` names a *pass* (which flag to clear,
    /// which sources to seed, which `utilities` fields to update), `Network`
    /// names a *property of a tile* (does anything here conduct). Adding
    /// sewage means a variant here, a `Network` variant, and a column in
    /// `OCCUPANT_DEFS::conducts` — no new BFS and no new carrier predicate.
    #[inline]
    pub fn network(self) -> Network {
        match self {
            UtilityKind::Power => Network::Power,
            UtilityKind::Water => Network::Water,
        }
    }
}

// ---------------------------------------------------------------------------
// Carrier / source predicates
// ---------------------------------------------------------------------------

fn is_source(tile: &Tile, kind: UtilityKind) -> bool {
    match kind {
        UtilityKind::Power => tile.power_plant_mw > 0,
        UtilityKind::Water => tile.water_output > 0,
    }
}

/// Whether the network flows *through* this tile.
///
/// Step 2 of the tile-model migration (#177, design note `docs/tile-model.md`):
/// this used to be two hand-written predicates, `is_power_carrier` and
/// `is_water_carrier`, each re-deriving "what is on this tile?" from `kind`
/// with a partial list of flag fallbacks.
/// The power one asked `tile.kind == PowerLine` and never asked
/// `has_power_overlay()`, so a hydro line was only visible to the BFS when it
/// happened to own the contested `kind` slot.
///
/// **That was a live bug, and converting to [`Tile::conducts`] fixes it.**
/// `Tool::Tree` and the terrain brushes rewrite `kind` and leave
/// `flags::POWER_OVERLAY` standing: plant a tree on a hydro line, or flood it,
/// and the tile kept charging `MAINT_POWER_LINE` every day while silently
/// severing the grid. Two spellings of the same physical tile —
/// `kind = PowerLine` and `kind = Tree` + overlay — now conduct alike, which
/// is the whole point of the occupant model.
///
/// Water converts with an empty diff: `is_water_carrier` already read the
/// buried pipe out of `underground` and both underlays out of the flags.
pub(crate) fn is_carrier(tile: &Tile, kind: UtilityKind) -> bool {
    tile.conducts(kind.network())
}

// ---------------------------------------------------------------------------
// Orthogonal neighbour iterator
// ---------------------------------------------------------------------------

fn orthogonal_neighbours(
    width: u32,
    height: u32,
    x: u32,
    y: u32,
) -> impl Iterator<Item = (u32, u32)> {
    const DIRS: [(i32, i32); 4] = [(0, -1), (1, 0), (0, 1), (-1, 0)];
    DIRS.into_iter().filter_map(move |(dx, dy)| {
        let nx = x as i32 + dx;
        let ny = y as i32 + dy;
        if nx >= 0 && ny >= 0 && (nx as u32) < width && (ny as u32) < height {
            Some((nx as u32, ny as u32))
        } else {
            None
        }
    })
}

// ---------------------------------------------------------------------------
// Generic BFS
// ---------------------------------------------------------------------------

/// Recompute one utility network (power or water) for the whole map.
///
/// 1. Clears the relevant flag (FLAG_POWERED / FLAG_WATERED) on every tile.
/// 2. Seeds the BFS queue from all source tiles.
/// 3. Propagates through carriers via orthogonal adjacency.
/// 4. Updates the matching fields in `state.utilities`.
pub fn recompute_utility_network(state: &mut GameState, kind: UtilityKind) {
    let flag = match kind {
        UtilityKind::Power => FLAG_POWERED,
        UtilityKind::Water => FLAG_WATERED,
    };

    // Clear flags
    for tile in &mut state.tiles {
        tile.set_flag(flag, false);
    }

    // Collect sources, seed their flags, build initial queue.
    // For water: a tile only seeds the BFS if its building is Active — an
    // unpowered pump must not supply water (mirrors the TS check for
    // `building.state.status === BuildingStatus.Active`).
    let sources: Vec<usize> = state
        .tiles
        .iter()
        .enumerate()
        .filter(|(_, t)| {
            if !is_source(t, kind) {
                return false;
            }
            if kind == UtilityKind::Water {
                if let Some(bid) = t.building_id {
                    return state
                        .buildings
                        .iter()
                        .any(|b| b.id == bid as u32 && b.status == BuildingStatus::Active);
                }
            }
            true
        })
        .map(|(i, _)| i)
        .collect();

    for &idx in &sources {
        state.tiles[idx].set_flag(flag, true);
    }

    let mut queue: VecDeque<usize> = sources.into_iter().collect();

    // BFS
    while let Some(idx) = queue.pop_front() {
        let (x, y) = state.index_to_xy(idx);
        for (nx, ny) in orthogonal_neighbours(state.width, state.height, x, y) {
            let nidx = (ny * state.width + nx) as usize;
            // Read phase (immutable)
            {
                let t = &state.tiles[nidx];
                if t.flags & flag != 0 {
                    continue;
                }
                if !is_carrier(t, kind) {
                    continue;
                }
            }
            // Write phase (mutable)
            state.tiles[nidx].set_flag(flag, true);
            queue.push_back(nidx);
        }
    }

    // Update utility stats
    match kind {
        UtilityKind::Power => {
            // Underfunded power departments brown out: plant output scales
            // with the funding level (100% funding → full output, exact).
            let raw = sum_output_power(state);
            let fund = city_sim_protocol::commands::BudgetPolicy::funding_multiplier(
                state.policies.budget.fund_power,
            );
            let produced = (raw as f32 * fund).round() as i32;
            state.utilities.power_produced = produced;
            // power_used is updated by the economy tick; zero it here so
            // a fresh recompute starts clean.
            state.utilities.power_used = 0;
            state.utilities.power = produced;
        }
        UtilityKind::Water => {
            let produced = sum_output_water(state);
            state.utilities.water_produced = produced;
            state.utilities.water_used = 0;
            state.utilities.water = produced;
        }
    }
}

// ---------------------------------------------------------------------------
// Output summation helpers (dedup by building_id to avoid counting 2×2 plants
// multiple times, matching the TS `listPowerPlants` dedup logic)
// ---------------------------------------------------------------------------

fn sum_output_power(state: &GameState) -> i32 {
    let mut seen: std::collections::HashSet<u16> = std::collections::HashSet::new();
    let mut total = 0;
    for tile in &state.tiles {
        if tile.power_plant_mw <= 0 {
            continue;
        }
        match tile.building_id {
            Some(bid) if seen.insert(bid) => {
                total += tile.power_plant_mw;
            }
            Some(_) => {} // duplicate tile of same plant
            None => {
                total += tile.power_plant_mw;
            }
        }
    }
    total
}

fn sum_output_water(state: &GameState) -> i32 {
    let mut seen: std::collections::HashSet<u16> = std::collections::HashSet::new();
    let mut total = 0;
    for tile in &state.tiles {
        if tile.water_output <= 0 {
            continue;
        }
        match tile.building_id {
            Some(bid) if seen.insert(bid) => {
                total += tile.water_output;
            }
            Some(_) => {}
            None => {
                total += tile.water_output;
            }
        }
    }
    total
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::apply_tool;
    use crate::migrate::{set_v4_kind, tile_from_v4};
    use crate::occupants::Occupant;
    use crate::state::Tile;
    use city_sim_protocol::commands::Tool;
    use city_sim_protocol::tile_buffer::flags;
    use city_sim_protocol::tile_kind::TileKind;

    fn grid(w: u32, h: u32) -> GameState {
        GameState::new(w, h, 0)
    }

    fn place(state: &mut GameState, x: u32, y: u32, kind: TileKind) {
        set_v4_kind(state.tile_at_mut(x, y).unwrap(), kind);
    }

    fn is_power_carrier(tile: &Tile) -> bool {
        is_carrier(tile, UtilityKind::Power)
    }

    fn is_water_carrier(tile: &Tile) -> bool {
        is_carrier(tile, UtilityKind::Water)
    }

    // --- carrier predicate tests ---

    #[test]
    fn power_line_is_power_carrier() {
        let t = tile_from_v4(TileKind::PowerLine, 0, None, None);
        assert!(is_power_carrier(&t));
    }

    #[test]
    fn road_is_power_carrier() {
        let t = tile_from_v4(TileKind::Road, 0, None, None);
        assert!(is_power_carrier(&t));
    }

    #[test]
    fn land_is_not_power_carrier() {
        assert!(!is_power_carrier(&Tile::land()));
    }

    #[test]
    fn residential_is_power_carrier() {
        let t = tile_from_v4(TileKind::Residential, 0, None, None);
        assert!(is_power_carrier(&t));
    }

    #[test]
    fn road_underlay_is_power_carrier() {
        let mut t = Tile::land();
        t.set_occupant(Occupant::Road, true);
        // Even with no visible carriageway sprite, the road makes it a carrier
        assert!(is_power_carrier(&t));
    }

    #[test]
    fn building_tile_is_power_carrier() {
        let t = Tile {
            building_id: Some(1),
            ..Tile::land()
        };
        assert!(is_power_carrier(&t));
    }

    /// **Behaviour change, step 2 of #177.** A hydro line recorded only in
    /// `flags::POWER_OVERLAY` is a carrier. The old `is_power_carrier` asked
    /// `kind == PowerLine` and nothing else, so every one of these tiles broke
    /// the grid while still being billed `MAINT_POWER_LINE` a day.
    ///
    /// Every v4 kind is decoded, not just the reachable ones: the overlay flag
    /// was orthogonal to `kind` in the old encoding, and every one of those
    /// spellings has to land on the same `Occupant::PowerLine` bit now.
    #[test]
    fn a_line_in_the_overlay_flag_alone_carries_power() {
        for &kind in TileKind::ALL {
            // `building_id: None` deliberately: `conducts` short-circuits on a
            // building reference, so passing `Some(1)` here would carry the
            // assertion on its own and never consult the occupant set at all.
            let t = tile_from_v4(kind, flags::POWER_OVERLAY, None, None);
            assert!(
                is_power_carrier(&t),
                "{kind:?} + flags::POWER_OVERLAY must carry power"
            );
        }
    }

    /// The overlay carries power; it does not carry water. A line is a line —
    /// `OCCUPANT_DEFS[PowerLine].conducts` is `NET_POWER` only, and a road
    /// under a line carries water because it is a road.
    #[test]
    fn a_line_in_the_overlay_flag_alone_does_not_carry_water() {
        let bare = tile_from_v4(TileKind::Tree, flags::POWER_OVERLAY, None, None);
        assert!(is_power_carrier(&bare));
        assert!(!is_water_carrier(&bare));

        let paved = tile_from_v4(
            TileKind::PowerLine,
            flags::POWER_OVERLAY | flags::ROAD_UNDERLAY,
            None,
            None,
        );
        assert!(is_water_carrier(&paved), "the road under the line carries");
    }

    #[test]
    fn water_pipe_underground_is_water_carrier() {
        let t = tile_from_v4(TileKind::Land, 0, Some(TileKind::WaterPipe), None);
        assert!(is_water_carrier(&t));
    }

    #[test]
    fn road_is_water_carrier() {
        let t = tile_from_v4(TileKind::Road, 0, None, None);
        assert!(is_water_carrier(&t));
    }

    #[test]
    fn land_is_not_water_carrier() {
        assert!(!is_water_carrier(&Tile::land()));
    }

    // --- power BFS tests ---

    #[test]
    fn no_sources_leaves_all_unpowered() {
        let mut g = grid(5, 5);
        place(&mut g, 2, 2, TileKind::Road);
        recompute_utility_network(&mut g, UtilityKind::Power);
        assert!(g.tiles.iter().all(|t| !t.is_powered()));
        assert_eq!(g.utilities.power_produced, 0);
    }

    #[test]
    fn isolated_source_powers_only_itself() {
        let mut g = grid(5, 5);
        g.tile_at_mut(2, 2).unwrap().power_plant_mw = 60;
        recompute_utility_network(&mut g, UtilityKind::Power);
        assert!(g.tile_at(2, 2).unwrap().is_powered());
        // Neighbours are Land (not carriers) — should not be powered
        assert!(!g.tile_at(1, 2).unwrap().is_powered());
        assert_eq!(g.utilities.power_produced, 60);
    }

    #[test]
    fn underfunded_power_department_browns_out() {
        let mut g = grid(5, 5);
        g.tile_at_mut(2, 2).unwrap().power_plant_mw = 60;
        g.policies.budget.fund_power = 50;
        recompute_utility_network(&mut g, UtilityKind::Power);
        assert_eq!(
            g.utilities.power_produced, 30,
            "50% power funding should halve plant output"
        );
    }

    #[test]
    fn power_flows_along_road() {
        let mut g = grid(7, 1);
        // Power plant at (0, 0), road from (0,0) to (5,0)
        g.tile_at_mut(0, 0).unwrap().power_plant_mw = 60;
        set_v4_kind(g.tile_at_mut(0, 0).unwrap(), TileKind::Road);
        for x in 1..=5 {
            place(&mut g, x, 0, TileKind::Road);
        }
        recompute_utility_network(&mut g, UtilityKind::Power);
        for x in 0..=5 {
            assert!(
                g.tile_at(x, 0).unwrap().is_powered(),
                "tile {x} should be powered"
            );
        }
        // Tile 6 is Land — not powered
        assert!(!g.tile_at(6, 0).unwrap().is_powered());
    }

    #[test]
    fn power_flows_through_residential_zone() {
        let mut g = grid(3, 1);
        g.tile_at_mut(0, 0).unwrap().power_plant_mw = 60;
        set_v4_kind(g.tile_at_mut(0, 0).unwrap(), TileKind::Road);
        place(&mut g, 1, 0, TileKind::Residential);
        recompute_utility_network(&mut g, UtilityKind::Power);
        assert!(g.tile_at(1, 0).unwrap().is_powered());
    }

    /// The bug this conversion closes, built with the real tools rather than
    /// hand-set flags: string a line, then plant a tree on it (or flood it).
    /// Both tools rewrite `kind` and leave `flags::POWER_OVERLAY` standing, so
    /// before step 2 the grid went dark from that tile onward while the daily
    /// budget kept charging `MAINT_POWER_LINE` for the very span that had
    /// stopped conducting.
    ///
    /// Both tools are exercised because both rewrite `kind` over a tile whose
    /// line lives only in the flag — the water brush by design, since a line
    /// over water is a pylon span, and the tree by the blindness
    /// `known_defect_trees_are_planted_through_a_live_hydro_line` describes.
    /// The two terraform tools reach the same tile the same way. What neither
    /// leaves standing is the *surface*: a regrade takes the whole surface
    /// stratum with it, which is why this test strings its line over bare
    /// ground.
    #[test]
    fn a_line_buried_under_a_tree_or_flooded_still_carries_power() {
        for tool in [Tool::Tree, Tool::Water] {
            let mut g = grid(5, 1);
            g.money = 10_000;
            g.tile_at_mut(0, 0).unwrap().power_plant_mw = 60;
            set_v4_kind(g.tile_at_mut(0, 0).unwrap(), TileKind::Road);
            for x in 1..=3 {
                apply_tool(&mut g, Tool::PowerLine, x, 0);
            }
            apply_tool(&mut g, tool, 2, 0);

            let mid = g.tile_at(2, 0).unwrap();
            assert!(
                mid.has_occupant(Occupant::PowerLine),
                "{tool:?} regraded the ground and left the span — the premise \
                 of this test"
            );

            recompute_utility_network(&mut g, UtilityKind::Power);
            assert!(
                g.tile_at(2, 0).unwrap().is_powered(),
                "{tool:?}: the tile still carries a billed line"
            );
            assert!(
                g.tile_at(3, 0).unwrap().is_powered(),
                "{tool:?}: the span beyond it must not go dark"
            );
        }
    }

    #[test]
    fn land_gap_breaks_power_chain() {
        let mut g = grid(5, 1);
        g.tile_at_mut(0, 0).unwrap().power_plant_mw = 60;
        set_v4_kind(g.tile_at_mut(0, 0).unwrap(), TileKind::Road);
        // gap at (1,0) = Land (not carrier)
        place(&mut g, 2, 0, TileKind::Road);
        place(&mut g, 3, 0, TileKind::Road);
        recompute_utility_network(&mut g, UtilityKind::Power);
        assert!(g.tile_at(0, 0).unwrap().is_powered());
        assert!(!g.tile_at(1, 0).unwrap().is_powered());
        assert!(!g.tile_at(2, 0).unwrap().is_powered());
    }

    #[test]
    fn power_deduplicates_two_by_two_plant() {
        let mut g = grid(4, 2);
        // 2×2 plant: all 4 tiles have power_plant_mw=60, same building_id
        for y in 0..2 {
            for x in 0..2 {
                let t = g.tile_at_mut(x, y).unwrap();
                t.power_plant_mw = 60;
                t.building_id = Some(1);
            }
        }
        recompute_utility_network(&mut g, UtilityKind::Power);
        // Output should be 60, not 240
        assert_eq!(g.utilities.power_produced, 60);
    }

    #[test]
    fn two_separate_plants_sum_correctly() {
        let mut g = grid(3, 1);
        g.tile_at_mut(0, 0).unwrap().power_plant_mw = 60;
        g.tile_at_mut(0, 0).unwrap().building_id = Some(1);
        set_v4_kind(g.tile_at_mut(0, 0).unwrap(), TileKind::Road);
        set_v4_kind(g.tile_at_mut(1, 0).unwrap(), TileKind::Road);
        g.tile_at_mut(2, 0).unwrap().power_plant_mw = 80;
        g.tile_at_mut(2, 0).unwrap().building_id = Some(2);
        set_v4_kind(g.tile_at_mut(2, 0).unwrap(), TileKind::Road);
        recompute_utility_network(&mut g, UtilityKind::Power);
        assert_eq!(g.utilities.power_produced, 140);
    }

    #[test]
    fn recompute_clears_stale_powered_flags() {
        let mut g = grid(3, 1);
        // First run: plant at (0,0), road to (2,0)
        g.tile_at_mut(0, 0).unwrap().power_plant_mw = 60;
        set_v4_kind(g.tile_at_mut(0, 0).unwrap(), TileKind::Road);
        place(&mut g, 1, 0, TileKind::Road);
        place(&mut g, 2, 0, TileKind::Road);
        recompute_utility_network(&mut g, UtilityKind::Power);
        assert!(g.tile_at(2, 0).unwrap().is_powered());

        // Remove plant, recompute — (2,0) should lose power
        g.tile_at_mut(0, 0).unwrap().power_plant_mw = 0;
        recompute_utility_network(&mut g, UtilityKind::Power);
        assert!(!g.tile_at(2, 0).unwrap().is_powered());
    }

    // --- water BFS tests ---

    fn active_pump(g: &mut GameState, id: u32, x: u32, y: u32) {
        use crate::buildings::{BuildingInstance, BuildingStatus};
        g.tile_at_mut(x, y).unwrap().water_output = 50;
        set_v4_kind(g.tile_at_mut(x, y).unwrap(), TileKind::WaterPump);
        g.tile_at_mut(x, y).unwrap().building_id = Some(id as u16);
        let mut b = BuildingInstance::new(id, TileKind::WaterPump, (x, y));
        b.status = BuildingStatus::Active;
        g.buildings.push(b);
    }

    #[test]
    fn water_pump_seeds_water_network() {
        let mut g = grid(3, 1);
        active_pump(&mut g, 1, 0, 0);
        g.tile_at_mut(1, 0)
            .unwrap()
            .set_occupant(Occupant::Pipe, true);
        g.tile_at_mut(2, 0)
            .unwrap()
            .set_occupant(Occupant::Pipe, true);
        recompute_utility_network(&mut g, UtilityKind::Water);
        assert!(g.tile_at(0, 0).unwrap().is_watered());
        assert!(g.tile_at(1, 0).unwrap().is_watered());
        assert!(g.tile_at(2, 0).unwrap().is_watered());
        assert_eq!(g.utilities.water_produced, 50);
    }

    #[test]
    fn water_does_not_flow_without_carrier() {
        let mut g = grid(3, 1);
        active_pump(&mut g, 1, 0, 0);
        // (1,0) and (2,0) are plain Land — not water carriers
        recompute_utility_network(&mut g, UtilityKind::Water);
        assert!(g.tile_at(0, 0).unwrap().is_watered());
        assert!(!g.tile_at(1, 0).unwrap().is_watered());
    }

    #[test]
    fn inactive_pump_does_not_seed_water_network() {
        use crate::buildings::{BuildingInstance, BuildingStatus};
        let mut g = grid(3, 1);
        // Pump tile has water_output set but its building is Inactive (no power)
        g.tile_at_mut(0, 0).unwrap().water_output = 50;
        set_v4_kind(g.tile_at_mut(0, 0).unwrap(), TileKind::WaterPump);
        g.tile_at_mut(0, 0).unwrap().building_id = Some(1);
        let mut b = BuildingInstance::new(1, TileKind::WaterPump, (0, 0));
        b.status = BuildingStatus::InactiveNoPower;
        g.buildings.push(b);
        g.tile_at_mut(1, 0)
            .unwrap()
            .set_occupant(Occupant::Pipe, true);
        recompute_utility_network(&mut g, UtilityKind::Water);
        assert!(
            !g.tile_at(0, 0).unwrap().is_watered(),
            "inactive pump must not seed water"
        );
        assert!(!g.tile_at(1, 0).unwrap().is_watered());
    }

    // --- orthogonal_neighbours tests ---

    #[test]
    fn neighbours_corner_has_two() {
        let v: Vec<_> = orthogonal_neighbours(5, 5, 0, 0).collect();
        assert_eq!(v.len(), 2);
    }

    #[test]
    fn neighbours_interior_has_four() {
        let v: Vec<_> = orthogonal_neighbours(5, 5, 2, 2).collect();
        assert_eq!(v.len(), 4);
    }

    #[test]
    fn neighbours_edge_has_three() {
        let v: Vec<_> = orthogonal_neighbours(5, 5, 0, 2).collect();
        assert_eq!(v.len(), 3);
    }
}
