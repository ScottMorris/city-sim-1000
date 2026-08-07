// utilities.rs — power and water network propagation.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use crate::buildings::BuildingStatus;
use crate::occupants::Network;
use crate::state::{GameState, Tile, FLAG_POWERED, FLAG_WATERED};
use std::collections::{HashSet, VecDeque};

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

/// Whether this tile is not just nominally a source ([`is_source`]) but is
/// *actually* producing right now.
///
/// For water, that means its owning building is `Active` — which, for a
/// pump, already folds in the `#200` footprint-touches-water check, since
/// `update_building_states` sets `InactiveNoSource` for a dry pump before
/// this runs. Used for both BFS seeding and [`sum_output_water`], so the
/// network that actually gets flooded and the number shown on the HUD
/// can't disagree (`#200` defect 2: an unpowered pump used to add to the
/// HUD total while supplying nothing).
fn is_effective_source(state: &GameState, tile: &Tile, kind: UtilityKind) -> bool {
    if !is_source(tile, kind) {
        return false;
    }
    if kind == UtilityKind::Water {
        if let Some(bid) = tile.building_id {
            return state
                .buildings
                .iter()
                .any(|b| b.id == bid as u32 && b.status == BuildingStatus::Active);
        }
    }
    true
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
// Connected components
// ---------------------------------------------------------------------------

/// One physically-connected segment of a utility network — the tiles
/// reachable from each other through carriers, for one [`UtilityKind`].
///
/// Rebuilt from scratch on every [`recompute_utility_network`] call, the same
/// lifecycle as the per-tile `FLAG_POWERED`/`FLAG_WATERED` flags: an id is
/// stable only within one recompute, and a grid edit can renumber every
/// segment on the next one. Nothing needs cross-tick identity today — see
/// `docs/features/utility-network-components.md`.
#[derive(Debug, Clone, Default)]
pub struct UtilityComponent {
    /// 1-based; matches the label written into [`UtilityNetworks`]'s label
    /// grid for this kind. `0` in that grid means "on no component".
    pub id: u16,
    /// Effective output of every source on this segment, funding-scaled for
    /// power. Deliberately left unrounded: [`recompute_utility_network`]
    /// rounds only the *sum* across all components, once, so the city-wide
    /// total is exactly what it was before components existed. Round for
    /// display at the wire boundary or in the UI, not here.
    pub produced: f32,
    /// Consumption attributed to this segment by `Simulation::compute_utility_use`.
    /// Zero until the first tick after a recompute.
    pub used: f32,
    /// Distinct buildings feeding this segment, deduped so a multi-tile
    /// plant counts once.
    pub source_count: u16,
}

impl UtilityComponent {
    /// Fraction of this segment's output currently drawn, clamped to `[0,
    /// 1]`. A segment can be momentarily overloaded (`used > produced`) when
    /// a funding brownout lands mid-tick, hence the clamp rather than an
    /// assertion.
    pub fn utilisation(&self) -> f32 {
        if self.produced <= 0.0 {
            return 0.0;
        }
        (self.used / self.produced).min(1.0)
    }
}

/// Per-kind connected-component labelling for [`GameState::utility_networks`].
///
/// `#[serde(skip)]` on the `GameState` field: this is derived from the grid,
/// so persisting it would buy nothing and cost a snapshot `VERSION` bump —
/// see the field's doc comment in `state.rs`.
#[derive(Debug, Clone, Default)]
pub struct UtilityNetworks {
    /// Component id per tile, index-aligned with `state.tiles`. `0` = not on
    /// this kind's network.
    pub power_labels: Vec<u16>,
    pub water_labels: Vec<u16>,
    pub power_components: Vec<UtilityComponent>,
    pub water_components: Vec<UtilityComponent>,
}

impl UtilityNetworks {
    /// The component id at `tile_index`, for the given kind — `None` if the
    /// tile isn't on that network.
    pub fn labels(&self, kind: UtilityKind) -> &[u16] {
        match kind {
            UtilityKind::Power => &self.power_labels,
            UtilityKind::Water => &self.water_labels,
        }
    }

    pub fn components(&self, kind: UtilityKind) -> &[UtilityComponent] {
        match kind {
            UtilityKind::Power => &self.power_components,
            UtilityKind::Water => &self.water_components,
        }
    }

    /// The component a tile belongs to, if any.
    pub fn component_at(&self, kind: UtilityKind, tile_index: usize) -> Option<&UtilityComponent> {
        let label = *self.labels(kind).get(tile_index)?;
        (label != 0).then(|| &self.components(kind)[(label - 1) as usize])
    }

    fn set(&mut self, kind: UtilityKind, labels: Vec<u16>, components: Vec<UtilityComponent>) {
        match kind {
            UtilityKind::Power => {
                self.power_labels = labels;
                self.power_components = components;
            }
            UtilityKind::Water => {
                self.water_labels = labels;
                self.water_components = components;
            }
        }
    }
}

/// Raw (unscaled, undeduped) output of one source tile.
fn raw_output(tile: &Tile, kind: UtilityKind) -> f32 {
    match kind {
        UtilityKind::Power => tile.power_plant_mw as f32,
        UtilityKind::Water => tile.water_output as f32,
    }
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
/// 2. Floods outward from each source tile in turn, labelling every tile it
///    reaches with a connected-component id — a source reached by an earlier
///    source's flood shares that component rather than starting a new one,
///    so this is still one pass over the reachable tiles, not a BFS per
///    source over the whole map.
/// 3. Updates the matching city-wide fields in `state.utilities`, and stores
///    the per-component breakdown in `state.utility_networks`.
pub fn recompute_utility_network(state: &mut GameState, kind: UtilityKind) {
    let flag = match kind {
        UtilityKind::Power => FLAG_POWERED,
        UtilityKind::Water => FLAG_WATERED,
    };

    // Clear flags
    for tile in &mut state.tiles {
        tile.set_flag(flag, false);
    }

    let mut labels = vec![0u16; state.tiles.len()];
    let mut components: Vec<UtilityComponent> = Vec::new();
    let mut seen_buildings: HashSet<u16> = HashSet::new();

    // Sources in tile-index order — same order the flat BFS used to seed
    // in, so labelling stays deterministic. See `is_effective_source` for
    // the status gating (power/water) and, for pumps, the `#200`
    // source-connection gate.
    let sources: Vec<usize> = state
        .tiles
        .iter()
        .enumerate()
        .filter(|(_, t)| is_effective_source(state, t, kind))
        .map(|(i, _)| i)
        .collect();

    for &src in &sources {
        let comp_idx = if labels[src] != 0 {
            // Already reached by an earlier source's flood (two plants on
            // one wire) — shares that component, no re-flood needed.
            (labels[src] - 1) as usize
        } else {
            let id = components.len() as u16 + 1;
            components.push(UtilityComponent {
                id,
                ..UtilityComponent::default()
            });
            state.tiles[src].set_flag(flag, true);
            labels[src] = id;

            let mut queue: VecDeque<usize> = VecDeque::new();
            queue.push_back(src);
            while let Some(cur) = queue.pop_front() {
                let (x, y) = state.index_to_xy(cur);
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
                    labels[nidx] = id;
                    queue.push_back(nidx);
                }
            }
            components.len() - 1
        };

        // Attribute this source's output, deduped by `building_id` so a
        // multi-tile plant (all of whose tiles are sources on the same
        // component) counts once — matches the TS `listPowerPlants` dedup.
        let tile = &state.tiles[src];
        let counted = match tile.building_id {
            Some(bid) => seen_buildings.insert(bid),
            None => true,
        };
        if counted {
            let comp = &mut components[comp_idx];
            comp.produced += raw_output(tile, kind);
            comp.source_count += 1;
        }
    }

    // Update utility stats. City-wide totals are computed from the raw
    // (pre-funding) sum, `fund × Σ raw_i` — the exact formula this function
    // always used — rather than `Σ(raw_i × fund)`: those are only equal in
    // real-number arithmetic, and `f32` rounding can make them disagree by a
    // unit at ordinary funding fractions (e.g. 1 MW + 14 MW at 90% funding
    // rounds to 14 either way in real numbers, but summing the two
    // already-scaled components can round to 13). Computing the city total
    // from the raw sum keeps it bit-for-bit what it always was; per-component
    // `produced` is still funding-scaled for the breakdown, but the
    // components' own sum can drift from the city total by that same ~1-unit
    // rounding at an arbitrary funding percentage.
    match kind {
        UtilityKind::Power => {
            // Underfunded power departments brown out: plant output scales
            // with the funding level (100% funding → full output, exact).
            let fund = city_sim_protocol::commands::BudgetPolicy::funding_multiplier(
                state.policies.budget.fund_power,
            );
            let raw_total: f32 = components.iter().map(|c| c.produced).sum();
            for c in &mut components {
                c.produced *= fund;
            }
            state.utilities.power_produced = (raw_total * fund).round() as i32;
            // power_used is updated by the economy tick; zero it here so
            // a fresh recompute starts clean.
            state.utilities.power_used = 0;
            state.utilities.power = state.utilities.power_produced;
        }
        UtilityKind::Water => {
            let produced: f32 = components.iter().map(|c| c.produced).sum();
            state.utilities.water_produced = produced.round() as i32;
            state.utilities.water_used = 0;
            state.utilities.water = state.utilities.water_produced;
        }
    }

    state.utility_networks.set(kind, labels, components);
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
    use city_sim_protocol::building_kind::BuildingKind;
    use city_sim_protocol::commands::{Tool, ViewStratum};
    use city_sim_protocol::legacy_tile_buffer::legacy_flags as flags;
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
    /// over water is a pylon span, and the tree by the official Trees +
    /// PowerLine coexistence `trees_coexist_with_a_live_hydro_line` pins.
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
                apply_tool(&mut g, Tool::PowerLine, x, 0, ViewStratum::Surface);
            }
            apply_tool(&mut g, tool, 2, 0, ViewStratum::Surface);

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
        let mut b = BuildingInstance::new(id, BuildingKind::WaterPump, (x, y));
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
        let mut b = BuildingInstance::new(1, BuildingKind::WaterPump, (0, 0));
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

    /// `#200` defect 2: `sum_output_water`/`water_produced` used to sum every
    /// `water_output > 0` tile regardless of status, so an inactive pump
    /// padded the HUD total even though the BFS (correctly, per the test
    /// above) refused to seed from it. One active and one inactive pump: the
    /// HUD total must match what actually entered the network, not double it.
    #[test]
    fn water_produced_excludes_inactive_pumps() {
        use crate::buildings::{BuildingInstance, BuildingStatus};
        let mut g = grid(2, 1);
        active_pump(&mut g, 1, 0, 0);
        g.tile_at_mut(1, 0).unwrap().water_output = 50;
        set_v4_kind(g.tile_at_mut(1, 0).unwrap(), TileKind::WaterPump);
        g.tile_at_mut(1, 0).unwrap().building_id = Some(2);
        let mut b = BuildingInstance::new(2, BuildingKind::WaterPump, (1, 0));
        b.status = BuildingStatus::InactiveNoPower;
        g.buildings.push(b);

        recompute_utility_network(&mut g, UtilityKind::Water);
        assert_eq!(
            g.utilities.water_produced, 50,
            "only the active pump's output should count"
        );
    }

    /// `#200` end-to-end: `update_building_states` (the source-connection
    /// gate) and `recompute_utility_network` (the BFS) agree without any
    /// extra plumbing — a dry pump's own status already excludes it, and a
    /// pump beside water terrain seeds normally. Exercises the full pipeline
    /// the isolated `buildings.rs` status tests and the BFS tests above don't
    /// cover together.
    #[test]
    fn dry_pump_does_not_produce_end_to_end() {
        use crate::buildings::update_building_states;
        use crate::occupants::Terrain;

        let mut g = grid(2, 1);
        set_v4_kind(g.tile_at_mut(0, 0).unwrap(), TileKind::WaterPump);
        g.tile_at_mut(0, 0)
            .unwrap()
            .set_occupant(Occupant::Structure, true);
        g.tile_at_mut(0, 0).unwrap().building_id = Some(1);
        g.tile_at_mut(0, 0).unwrap().water_output = 50;
        g.tile_at_mut(0, 0)
            .unwrap()
            .set_flag(crate::state::FLAG_POWERED, true);
        g.buildings.push(crate::buildings::BuildingInstance::new(
            1,
            BuildingKind::WaterPump,
            (0, 0),
        ));

        update_building_states(&mut g, true);
        recompute_utility_network(&mut g, UtilityKind::Water);
        assert_eq!(g.utilities.water_produced, 0, "a dry pump must not produce");
        assert!(!g.tile_at(0, 0).unwrap().is_watered());

        // Water terrain appears next door: the same pump comes online.
        g.tile_at_mut(1, 0).unwrap().terrain = Terrain::Water;
        update_building_states(&mut g, true);
        recompute_utility_network(&mut g, UtilityKind::Water);
        assert_eq!(g.utilities.water_produced, 50);
        assert!(g.tile_at(0, 0).unwrap().is_watered());
    }

    // --- connected component tests ---

    /// The issue's headline verification: two grids with no shared wire are
    /// two components with independent `produced` values, even though the
    /// city-wide total still pools them (unchanged aggregate behaviour).
    #[test]
    fn two_disconnected_power_grids_report_independent_produced() {
        let mut g = grid(7, 1);
        g.tile_at_mut(0, 0).unwrap().power_plant_mw = 60;
        g.tile_at_mut(0, 0).unwrap().building_id = Some(1);
        set_v4_kind(g.tile_at_mut(0, 0).unwrap(), TileKind::Road);
        place(&mut g, 1, 0, TileKind::Road);
        // (2,0)..=(4,0) are plain Land — breaks the chain into two segments.
        g.tile_at_mut(5, 0).unwrap().power_plant_mw = 80;
        g.tile_at_mut(5, 0).unwrap().building_id = Some(2);
        set_v4_kind(g.tile_at_mut(5, 0).unwrap(), TileKind::Road);
        place(&mut g, 6, 0, TileKind::Road);

        recompute_utility_network(&mut g, UtilityKind::Power);

        assert_eq!(
            g.utilities.power_produced, 140,
            "city-wide total still pools every component"
        );
        let mut produced: Vec<i32> = g
            .utility_networks
            .components(UtilityKind::Power)
            .iter()
            .map(|c| c.produced.round() as i32)
            .collect();
        produced.sort_unstable();
        assert_eq!(
            produced,
            vec![60, 80],
            "two disconnected grids report as two independent components"
        );
    }

    #[test]
    fn two_plants_on_one_segment_share_one_component() {
        let mut g = grid(3, 1);
        g.tile_at_mut(0, 0).unwrap().power_plant_mw = 60;
        g.tile_at_mut(0, 0).unwrap().building_id = Some(1);
        set_v4_kind(g.tile_at_mut(0, 0).unwrap(), TileKind::Road);
        place(&mut g, 1, 0, TileKind::Road);
        g.tile_at_mut(2, 0).unwrap().power_plant_mw = 80;
        g.tile_at_mut(2, 0).unwrap().building_id = Some(2);
        set_v4_kind(g.tile_at_mut(2, 0).unwrap(), TileKind::Road);

        recompute_utility_network(&mut g, UtilityKind::Power);

        let components = g.utility_networks.components(UtilityKind::Power);
        assert_eq!(components.len(), 1, "one wire joins both plants");
        assert_eq!(components[0].produced.round() as i32, 140);
        assert_eq!(components[0].source_count, 2);
    }

    #[test]
    fn component_deduplicates_a_two_by_two_plant() {
        let mut g = grid(4, 2);
        for y in 0..2 {
            for x in 0..2 {
                let t = g.tile_at_mut(x, y).unwrap();
                t.power_plant_mw = 60;
                t.building_id = Some(1);
            }
        }
        recompute_utility_network(&mut g, UtilityKind::Power);

        let components = g.utility_networks.components(UtilityKind::Power);
        assert_eq!(components.len(), 1);
        assert_eq!(
            components[0].produced.round() as i32,
            60,
            "the plant's 4 tiles must not be counted as 4 sources"
        );
        assert_eq!(components[0].source_count, 1);
    }

    #[test]
    fn brownout_scales_every_component_by_the_same_funding_fraction() {
        let mut g = grid(7, 1);
        g.tile_at_mut(0, 0).unwrap().power_plant_mw = 60;
        g.tile_at_mut(0, 0).unwrap().building_id = Some(1);
        set_v4_kind(g.tile_at_mut(0, 0).unwrap(), TileKind::Road);
        place(&mut g, 1, 0, TileKind::Road);
        g.tile_at_mut(5, 0).unwrap().power_plant_mw = 80;
        g.tile_at_mut(5, 0).unwrap().building_id = Some(2);
        set_v4_kind(g.tile_at_mut(5, 0).unwrap(), TileKind::Road);
        place(&mut g, 6, 0, TileKind::Road);
        g.policies.budget.fund_power = 50;

        recompute_utility_network(&mut g, UtilityKind::Power);

        assert_eq!(
            g.utilities.power_produced, 70,
            "city total is still the rounded sum of the brownout-scaled components"
        );
        let mut produced: Vec<i32> = g
            .utility_networks
            .components(UtilityKind::Power)
            .iter()
            .map(|c| c.produced.round() as i32)
            .collect();
        produced.sort_unstable();
        assert_eq!(produced, vec![30, 40]);
    }

    /// Regression: summing each component's *already-scaled* output
    /// (`Σ(raw_i × fund)`) instead of scaling the raw total once (`fund ×
    /// Σ raw_i`) can round to a different integer at an ordinary,
    /// non-contrived funding fraction — `fund_power=50` above is dyadic
    /// (`0.5`) and safe from `f32` rounding either way, which is exactly why
    /// it didn't catch this. `fund_power=90` isn't: `1.0×0.9 + 14.0×0.9`
    /// rounds to `13` in `f32`, while `(1.0 + 14.0)×0.9` rounds to `14`.
    #[test]
    fn city_total_matches_the_raw_total_scaled_once_not_the_sum_of_scaled_components() {
        let mut g = grid(7, 1);
        g.tile_at_mut(0, 0).unwrap().power_plant_mw = 1;
        g.tile_at_mut(0, 0).unwrap().building_id = Some(1);
        set_v4_kind(g.tile_at_mut(0, 0).unwrap(), TileKind::Road);
        place(&mut g, 1, 0, TileKind::Road);
        g.tile_at_mut(5, 0).unwrap().power_plant_mw = 14;
        g.tile_at_mut(5, 0).unwrap().building_id = Some(2);
        set_v4_kind(g.tile_at_mut(5, 0).unwrap(), TileKind::Road);
        place(&mut g, 6, 0, TileKind::Road);
        g.policies.budget.fund_power = 90;

        recompute_utility_network(&mut g, UtilityKind::Power);

        assert_eq!(
            g.utilities.power_produced, 14,
            "(1 + 14) MW at 90% funding rounds to 14, matching the pre-components formula"
        );
    }

    #[test]
    fn label_grid_marks_off_network_tiles_as_zero() {
        let mut g = grid(3, 1);
        g.tile_at_mut(0, 0).unwrap().power_plant_mw = 60;
        g.tile_at_mut(0, 0).unwrap().building_id = Some(1);
        set_v4_kind(g.tile_at_mut(0, 0).unwrap(), TileKind::Road);
        // (1,0), (2,0) are plain Land — off network.

        recompute_utility_network(&mut g, UtilityKind::Power);

        let labels = g.utility_networks.labels(UtilityKind::Power);
        assert_ne!(labels[0], 0);
        assert_eq!(labels[1], 0);
        assert_eq!(labels[2], 0);
    }

    #[test]
    fn component_at_resolves_the_owning_component() {
        let mut g = grid(3, 1);
        g.tile_at_mut(0, 0).unwrap().power_plant_mw = 60;
        g.tile_at_mut(0, 0).unwrap().building_id = Some(1);
        set_v4_kind(g.tile_at_mut(0, 0).unwrap(), TileKind::Road);
        place(&mut g, 1, 0, TileKind::Road);

        recompute_utility_network(&mut g, UtilityKind::Power);

        let networks = &g.utility_networks;
        let on_network = g.tile_index(1, 0).unwrap();
        let off_network = g.tile_index(2, 0).unwrap();
        assert_eq!(
            networks
                .component_at(UtilityKind::Power, on_network)
                .unwrap()
                .produced
                .round() as i32,
            60
        );
        assert!(networks
            .component_at(UtilityKind::Power, off_network)
            .is_none());
    }

    /// Mutation-testing gap: nothing previously read `UtilityComponent::id`
    /// itself — every other test reaches a component only through
    /// `component_at`'s label-indexed lookup, which stays correct even if
    /// `id` is never populated on the struct. Assert the field directly.
    #[test]
    fn component_id_matches_its_label_in_the_grid() {
        let mut g = grid(3, 1);
        g.tile_at_mut(0, 0).unwrap().power_plant_mw = 60;
        g.tile_at_mut(0, 0).unwrap().building_id = Some(1);
        set_v4_kind(g.tile_at_mut(0, 0).unwrap(), TileKind::Road);
        place(&mut g, 1, 0, TileKind::Road);

        recompute_utility_network(&mut g, UtilityKind::Power);

        let idx = g.tile_index(1, 0).unwrap();
        let label = g.utility_networks.labels(UtilityKind::Power)[idx];
        let component = g
            .utility_networks
            .component_at(UtilityKind::Power, idx)
            .unwrap();
        assert_eq!(
            component.id, label,
            "component.id must mirror the label grid's value"
        );
    }

    #[test]
    fn inactive_pump_produces_no_water_component() {
        use crate::buildings::{BuildingInstance, BuildingStatus};
        let mut g = grid(3, 1);
        g.tile_at_mut(0, 0).unwrap().water_output = 50;
        set_v4_kind(g.tile_at_mut(0, 0).unwrap(), TileKind::WaterPump);
        g.tile_at_mut(0, 0).unwrap().building_id = Some(1);
        let mut b = BuildingInstance::new(1, BuildingKind::WaterPump, (0, 0));
        b.status = BuildingStatus::InactiveNoPower;
        g.buildings.push(b);

        recompute_utility_network(&mut g, UtilityKind::Water);

        assert!(g.utility_networks.components(UtilityKind::Water).is_empty());
    }

    #[test]
    fn utilisation_is_zero_with_no_production() {
        assert_eq!(UtilityComponent::default().utilisation(), 0.0);
    }

    #[test]
    fn utilisation_clamps_to_one_when_overloaded() {
        let c = UtilityComponent {
            produced: 50.0,
            used: 80.0,
            ..UtilityComponent::default()
        };
        assert_eq!(c.utilisation(), 1.0);
    }

    #[test]
    fn utilisation_is_the_used_over_produced_fraction() {
        let c = UtilityComponent {
            produced: 100.0,
            used: 25.0,
            ..UtilityComponent::default()
        };
        assert_eq!(c.utilisation(), 0.25);
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
