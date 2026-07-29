// wilderness.rs — Wilderness Score: natural capital vs urban pressure (#8).
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

//! Computes the 0–100 Wilderness Score from the tile grid.
//!
//! Every tile contributes a base "eco value": the terrain's own credit plus
//! **one contribution per occupant standing on it**. Strong nature tiles
//! (`Tree`, `Park`) then receive neighbourhood adjustments: a patch bonus for
//! contiguous clusters, a water-edge bonus, and a fragmentation penalty when
//! isolated. Positive contributions sum to natural capital `P`, negative
//! magnitudes to urban pressure `U`, and the score is `100 · P / (P + U + k)`
//! — see `docs/features/wilderness-score.md` for the design rationale and
//! locked decisions.
//!
//! **The base value is a Σ, not a lookup (#173).** It used to be
//! `base_eco[tile.kind]` — one value per tile, with the structural flags never
//! consulted — so a road carrying a hydro line scored the line's −1.0 and the
//! road rode free. Stringing lines along your roads *raised* your wilderness
//! score. Worse, the breakdown's `match kind` forced one category per tile, so
//! the same tile moved its damage out of `transport` and into `power`: not
//! merely under-counted, misattributed. Scoring runs over
//! `Tile::occupants` now, so a road with a line costs −2.0 + −1.0 and each
//! half is filed on its own line.
//!
//! **Three concepts, three tables.** Those values used to share one dense
//! `base_eco[TileKind]` array, which meant the terrain's open-land credit, an
//! occupant's cost and a structure's cost were all looked up by the same key —
//! and so `TileKind` stayed an engine-internal lookup key long after it had
//! stopped describing a tile. [`WildernessTunables`] now carries
//! [`terrain_eco`](WildernessTunables::terrain_eco) keyed by [`Terrain`],
//! [`occupant_eco`](WildernessTunables::occupant_eco) keyed by [`Occupant`],
//! and [`structure_eco`](WildernessTunables::structure_eco) keyed by
//! `TileKind` — the last legitimately so, because that is the building
//! template key and it is what identifies *which* structure. Every value stayed
//! exactly where it was on the number line; only its address changed.
//!
//! All three are **tables, not constants**, and that is a requirement rather
//! than a habit: the Green Industry programme rewrites the industrial row at
//! runtime through [`WildernessTunables::effective`], so an eco value baked
//! into a static `OccupantDef` would be a second copy no policy could reach.
//!
//! This module is Rust-first: its tests are the spec, and it is deliberately
//! excluded from the TS parity oracle (`simulation.ts`).

use crate::occupants::{
    is_strong_nature, iter_set, occupant_category, occupant_eco, structure_category, structure_eco,
    tile_eco, EcoCategory, Occupant, StructureLookup, Terrain, OCCUPANT_COUNT, TERRAIN_COUNT,
};
use crate::state::GameState;
use city_sim_protocol::commands::WildernessPolicy;
use city_sim_protocol::tile_kind::TileKind;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/// All wilderness constants in one place so balancing is a one-file edit.
/// Starter values follow the weight table in the design doc.
#[derive(Debug, Clone)]
pub struct WildernessTunables {
    /// Eco credit of the ground itself, indexed by `Terrain as usize`. Read by
    /// [`Tile::terrain_eco`](crate::state::Tile::terrain_eco), which gates the
    /// `Land` credit on the tile being visibly empty.
    pub terrain_eco: [f32; TERRAIN_COUNT],
    /// Eco value of one occupant's presence, indexed by `Occupant as usize`.
    /// Read by [`occupant_eco`], once per occupant standing on the tile.
    ///
    /// The `Structure` row is never read and is held at `0.0`: a structure's
    /// value is per kind, so
    /// [`EcoSource::PerStructureKind`](crate::occupants::EcoSource::PerStructureKind)
    /// sends that one occupant to [`Self::structure_eco`] instead. See
    /// `the_structure_row_of_the_occupant_table_is_never_read`.
    pub occupant_eco: [f32; OCCUPANT_COUNT],
    /// Eco value of a structure, indexed by `TileKind as usize` — the building
    /// template key, which is what identifies *which* structure. Read by
    /// [`structure_eco`]; only the
    /// [`is_structure_kind`](crate::occupants::is_structure_kind) rows are ever
    /// live, and the rest stay `0.0`.
    pub structure_eco: [f32; TileKind::COUNT],
    /// Patch bonus ceiling per strong-nature tile (saturating curve).
    pub patch_bonus_cap: f32,
    /// Cluster size at which the patch bonus reaches ~63% of its cap.
    pub patch_reference_size: f32,
    /// Flat bonus for a strong-nature tile 4-adjacent to water.
    pub edge_bonus: f32,
    /// Penalty for a strong-nature tile with too few strong-nature neighbours.
    pub fragmentation_penalty: f32,
    /// Minimum strong-nature 8-neighbours before the penalty applies.
    pub min_nature_neighbours: u8,
    /// Score-softening constant per buildable tile (the `k` in `P/(P+U+k)`).
    pub k_per_tile: f32,
    /// Recompute cadence in simulation ticks.
    pub recompute_interval_ticks: u64,
    /// EMA smoothing factors for the trend indicator (per recompute).
    pub trend_fast_alpha: f32,
    pub trend_slow_alpha: f32,
    /// Residential demand delta at score 100 (linear through 0 at score 50).
    pub demand_weight: f32,
    /// Zone-tile happiness drifts toward `1.0 ± happiness_target_span`.
    pub happiness_target_span: f32,
    /// Fraction of the gap to the happiness target closed per recompute.
    pub happiness_drift_rate: f32,
    /// Tourism dividend starts above this score…
    pub dividend_threshold: f32,
    /// …and pays this many dollars per citizen per day at score 100.
    pub dividend_per_capita: f32,
    // --- Wilderness programmes (#9) ---
    /// Score required before the Nature Reserve programme can be enabled.
    pub reserve_unlock_score: f32,
    /// Patch bonus cap while Nature Reserve is active (replaces `patch_bonus_cap`).
    pub reserve_patch_bonus_cap: f32,
    /// Fragmentation penalty while Nature Reserve is active.
    pub reserve_fragmentation_penalty: f32,
    /// Flat daily cost of the Nature Reserve programme.
    pub reserve_cost_per_day: f32,
    /// Industrial base eco while Green Industry is active (replaces −5).
    pub green_industry_eco: f32,
    /// Daily subsidy per industrial zone tile while Green Industry is active.
    pub green_industry_subsidy_per_zone: f32,
}

impl WildernessTunables {
    /// Tunables with the active wilderness programmes applied.
    pub fn effective(&self, policy: &WildernessPolicy) -> Self {
        let mut t = self.clone();
        if policy.nature_reserve {
            t.patch_bonus_cap = self.reserve_patch_bonus_cap;
            t.fragmentation_penalty = self.reserve_fragmentation_penalty;
        }
        if policy.green_industry {
            // The occupant table, not a constant in `OCCUPANT_DEFS`: this is
            // the patch that forces every eco value to stay tunable at
            // runtime. A number baked into the static def would be a second
            // copy that the programme could never reach.
            t.occupant_eco[Occupant::ZoneIndustrial as usize] = self.green_industry_eco;
        }
        t
    }
}

impl Default for WildernessTunables {
    fn default() -> Self {
        // --- the ground itself ---
        let mut terrain_eco = [0.0_f32; TERRAIN_COUNT];
        terrain_eco[Terrain::Land as usize] = 1.0;
        terrain_eco[Terrain::Water as usize] = 0.0;

        // --- one row per occupant standing on it ---
        let mut occupant_eco = [0.0_f32; OCCUPANT_COUNT];
        // Nature above a buried pipe is still nature, so a pipe scores nothing
        // — and neither do the two reserved occupants, which stay at 0.0.
        occupant_eco[Occupant::Pipe as usize] = 0.0;
        occupant_eco[Occupant::Road as usize] = -2.0;
        occupant_eco[Occupant::Rail as usize] = -2.0;
        occupant_eco[Occupant::ZoneResidential as usize] = -1.0;
        occupant_eco[Occupant::ZoneCommercial as usize] = -2.0;
        // Patched by the Green Industry programme — see `effective`.
        occupant_eco[Occupant::ZoneIndustrial as usize] = -5.0;
        occupant_eco[Occupant::PowerLine as usize] = -1.0;
        occupant_eco[Occupant::Trees as usize] = 6.0;
        // `Occupant::Structure` deliberately has no value: which structure it
        // is decides, and that is the table below.

        // --- one row per structure, keyed by its building template ---
        let mut structure_eco = [0.0_f32; TileKind::COUNT];
        structure_eco[TileKind::HydroPlant as usize] = -2.0;
        structure_eco[TileKind::WaterPump as usize] = -1.0;
        structure_eco[TileKind::WaterTower as usize] = -1.0;
        structure_eco[TileKind::ElementarySchool as usize] = -1.0;
        structure_eco[TileKind::HighSchool as usize] = -1.0;
        structure_eco[TileKind::Park as usize] = 4.0;
        structure_eco[TileKind::ParkLarge as usize] = 4.0;
        structure_eco[TileKind::CoalPlant as usize] = -8.0;
        structure_eco[TileKind::WindTurbine as usize] = -1.0;
        structure_eco[TileKind::SolarFarm as usize] = -1.0;

        Self {
            terrain_eco,
            occupant_eco,
            structure_eco,
            patch_bonus_cap: 2.0,
            patch_reference_size: 32.0,
            edge_bonus: 2.0,
            fragmentation_penalty: 2.0,
            min_nature_neighbours: 3,
            k_per_tile: 0.5,
            recompute_interval_ticks: 10,
            trend_fast_alpha: 0.3,
            trend_slow_alpha: 0.05,
            demand_weight: 6.0,
            happiness_target_span: 0.2,
            happiness_drift_rate: 0.02,
            dividend_threshold: 60.0,
            dividend_per_capita: 0.4,
            reserve_unlock_score: 60.0,
            reserve_patch_bonus_cap: 3.0,
            reserve_fragmentation_penalty: 1.0,
            reserve_cost_per_day: 100.0,
            green_industry_eco: -2.0,
            green_industry_subsidy_per_zone: 2.0,
        }
    }
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/// Per-category eco totals for the HUD breakdown tooltip. Positive categories
/// carry positive values; pressure categories carry negative values.
#[derive(Debug, Clone, Copy, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct WildernessBreakdown {
    pub forests: f32,
    pub parks: f32,
    pub open_land: f32,
    pub water_edge: f32,
    pub patch: f32,
    pub fragmentation: f32,
    pub zones: f32,
    pub industry: f32,
    pub transport: f32,
    pub power: f32,
    pub civic: f32,
}

impl WildernessBreakdown {
    /// File one eco contribution on the line its category names.
    ///
    /// [`EcoCategory::Neutral`] deliberately lands nowhere — buried pipes and
    /// the reserved occupants score zero and belong on no line, which is what
    /// the old `Water | WaterPipe => {}` arm expressed.
    ///
    /// `water_edge`, `patch` and `fragmentation` have no `EcoCategory`: they
    /// are neighbourhood adjustments rather than per-occupant values, and are
    /// still accumulated inline by `compute_wilderness`.
    fn add(&mut self, category: EcoCategory, value: f32) {
        match category {
            EcoCategory::Forests => self.forests += value,
            EcoCategory::Parks => self.parks += value,
            EcoCategory::OpenLand => self.open_land += value,
            EcoCategory::Zones => self.zones += value,
            EcoCategory::Industry => self.industry += value,
            EcoCategory::Transport => self.transport += value,
            EcoCategory::Power => self.power += value,
            EcoCategory::Civic => self.civic += value,
            EcoCategory::Neutral => {}
        }
    }
}

/// Wilderness state stored on `GameState` — recomputed every
/// `recompute_interval_ticks`, carried between recomputes.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct WildernessStats {
    /// Global score, 0–100.
    pub score: f32,
    /// Fast EMA − slow EMA of the score; sign gives the trend arrow.
    pub trend: f32,
    pub fast_ema: f32,
    pub slow_ema: f32,
    /// True once the EMAs have been seeded by a first recompute.
    pub seeded: bool,
    pub breakdown: WildernessBreakdown,
    /// Per-tile eco field quantised via `city_sim_protocol::tile_buffer::encode_eco`
    /// (128 = neutral). Feeds the `wilderness[N]` tile-buffer array for the
    /// overlay heatmap. Empty until the first recompute.
    pub local_field: Vec<u8>,
}

/// Full result of one wilderness recompute.
pub struct WildernessOutput {
    pub score: f32,
    /// Per-tile eco contribution (positive = natural capital).
    pub eco_field: Vec<f32>,
    pub breakdown: WildernessBreakdown,
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

/// Strong nature by `TileKind` alone — the pre-migration rule, kept as an
/// independent oracle for the occupant model and **not** used to score.
///
/// `compute_wilderness` asks [`occupants::is_strong_nature`](crate::occupants::is_strong_nature)
/// instead, which sums over the tile's occupants and resolves a structure
/// through its development. This `matches!` stays so `occupants.rs` can pin its
/// answer against a rule written out longhand rather than against a copy of
/// itself.
#[cfg(test)]
#[inline]
pub(crate) fn strong_nature_kind(kind: TileKind) -> bool {
    matches!(kind, TileKind::Tree | TileKind::Park | TileKind::ParkLarge)
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/// Compute the wilderness score, per-tile eco field, and category breakdown.
///
/// Pure function of the tile grid: two O(N) passes (flood-fill cluster
/// labelling, then per-tile scoring). At the production 64×64 map this is
/// microseconds; no incremental machinery needed.
pub fn compute_wilderness(state: &GameState, t: &WildernessTunables) -> WildernessOutput {
    let w = state.width as usize;
    let h = state.height as usize;
    let n = w * h;

    // `Occupant::Structure` is one flat tag, so which structure stands on a
    // tile — and therefore whether it is a park worth +4.0 or a coal plant
    // worth −8.0 — lives on the `BuildingInstance` it points at. Index them
    // once, in O(buildings): asking `state.buildings.iter().find(…)` per tile
    // would make both O(N) passes O(N × B).
    let lookup = StructureLookup::new(state);

    // Pass 1: label contiguous strong-nature clusters (4-connectivity) and
    // record each cluster's size. cluster_of[i] = usize::MAX for non-nature.
    let mut cluster_of = vec![usize::MAX; n];
    let mut cluster_sizes: Vec<u32> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    for start in 0..n {
        if cluster_of[start] != usize::MAX || !is_strong_nature(&state.tiles[start], &lookup) {
            continue;
        }
        let cluster_id = cluster_sizes.len();
        cluster_sizes.push(0);
        stack.push(start);
        cluster_of[start] = cluster_id;
        while let Some(i) = stack.pop() {
            cluster_sizes[cluster_id] += 1;
            let x = i % w;
            let y = i / w;
            let mut visit = |j: usize| {
                if cluster_of[j] == usize::MAX && is_strong_nature(&state.tiles[j], &lookup) {
                    cluster_of[j] = cluster_id;
                    stack.push(j);
                }
            };
            if x > 0 {
                visit(i - 1);
            }
            if x + 1 < w {
                visit(i + 1);
            }
            if y > 0 {
                visit(i - w);
            }
            if y + 1 < h {
                visit(i + w);
            }
        }
    }

    // Pass 2: per-tile eco value with neighbourhood adjustments.
    let mut eco_field = vec![0.0_f32; n];
    let mut breakdown = WildernessBreakdown::default();
    let mut p_total = 0.0_f32;
    let mut u_total = 0.0_f32;
    let mut buildable = 0u32;

    for i in 0..n {
        let tile = &state.tiles[i];
        // Buildable tiles set the scale of the softening constant `k` so that
        // water-heavy maps are not skewed. `Terrain::Land` is exactly the old
        // `kind != Water`.
        if tile.terrain() == Terrain::Land {
            buildable += 1;
        }

        // Base value: the terrain's own credit, plus one contribution per
        // occupant. This is `Tile::tile_eco` unrolled — the sum has to be
        // taken term by term here so each term can be filed on its own
        // breakdown line, which is the half of #173 that misattributed rather
        // than merely under-counted.
        let mut eco = tile.terrain_eco(t);
        if let Some(category) = tile.terrain_category() {
            breakdown.add(category, eco);
        }
        for o in iter_set(tile.occupants()) {
            // A `None` pair means the occupant tag cannot answer for itself —
            // today only `Structure`, whose eco *and* line both come from the
            // structure's kind (a park is +4.0 on `parks`, a coal plant −8.0
            // on `power`).
            let (value, category) = match (occupant_eco(o, t), occupant_category(o)) {
                (Some(value), Some(category)) => (value, category),
                _ => match lookup.structure_kind(tile) {
                    Some(kind) => (structure_eco(kind, t), structure_category(kind)),
                    None => (0.0, EcoCategory::Neutral),
                },
            };
            eco += value;
            breakdown.add(category, value);
        }
        debug_assert_eq!(
            eco,
            tile_eco(tile, &lookup, t),
            "the scoring loop must sum to Tile::tile_eco"
        );

        if is_strong_nature(tile, &lookup) {
            let x = i % w;
            let y = i / w;

            // Patch bonus: saturating curve on cluster size.
            let size = cluster_sizes[cluster_of[i]] as f32;
            let patch = t.patch_bonus_cap * (1.0 - (-size / t.patch_reference_size).exp());
            eco += patch;
            breakdown.patch += patch;

            // Water-edge bonus: any 4-neighbour is water.
            let is_water = |j: usize| state.tiles[j].terrain() == Terrain::Water;
            let near_water = (x > 0 && is_water(i - 1))
                || (x + 1 < w && is_water(i + 1))
                || (y > 0 && is_water(i - w))
                || (y + 1 < h && is_water(i + w));
            if near_water {
                eco += t.edge_bonus;
                breakdown.water_edge += t.edge_bonus;
            }

            // Fragmentation penalty: too few strong-nature 8-neighbours.
            let mut nature_neighbours = 0u8;
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    let nx = x as i32 + dx;
                    let ny = y as i32 + dy;
                    if nx >= 0
                        && (nx as usize) < w
                        && ny >= 0
                        && (ny as usize) < h
                        && is_strong_nature(&state.tiles[ny as usize * w + nx as usize], &lookup)
                    {
                        nature_neighbours += 1;
                    }
                }
            }
            if nature_neighbours < t.min_nature_neighbours {
                eco -= t.fragmentation_penalty;
                breakdown.fragmentation -= t.fragmentation_penalty;
            }
        }

        eco_field[i] = eco;
        if eco >= 0.0 {
            p_total += eco;
        } else {
            u_total += -eco;
        }
    }

    let k = t.k_per_tile * buildable as f32;
    let denom = p_total + u_total + k;
    let score = if denom > 0.0 {
        100.0 * p_total / denom
    } else {
        0.0
    };

    WildernessOutput {
        score,
        eco_field,
        breakdown,
    }
}

/// Fold a fresh score into the trend EMAs on `stats`.
pub fn update_trend(stats: &mut WildernessStats, score: f32, t: &WildernessTunables) {
    if !stats.seeded {
        stats.fast_ema = score;
        stats.slow_ema = score;
        stats.seeded = true;
    } else {
        stats.fast_ema += t.trend_fast_alpha * (score - stats.fast_ema);
        stats.slow_ema += t.trend_slow_alpha * (score - stats.slow_ema);
    }
    stats.score = score;
    stats.trend = stats.fast_ema - stats.slow_ema;
}

// ---------------------------------------------------------------------------
// Consequence helpers (used by demand.rs / economy.rs / sim.rs)
// ---------------------------------------------------------------------------

/// Residential demand delta: linear in score, 0 at score 50,
/// ±`demand_weight` at the extremes.
pub fn demand_delta(score: f32, t: &WildernessTunables) -> f32 {
    (score - 50.0) / 50.0 * t.demand_weight
}

/// Daily tourism dividend in dollars: 0 below the threshold, scaling
/// linearly to `dividend_per_capita × population` at score 100.
pub fn tourism_dividend(score: f32, population: u32, t: &WildernessTunables) -> f32 {
    if score <= t.dividend_threshold {
        return 0.0;
    }
    let span = (100.0 - t.dividend_threshold).max(1.0);
    let strength = ((score - t.dividend_threshold) / span).clamp(0.0, 1.0);
    population as f32 * t.dividend_per_capita * strength
}

/// Drift zone-tile happiness toward the wilderness-driven target.
/// Called once per recompute, not per tick, so the rate stays gentle.
pub fn apply_happiness_drift(state: &mut GameState, score: f32, t: &WildernessTunables) {
    let target = 1.0 + (score - 50.0) / 50.0 * t.happiness_target_span;
    for tile in &mut state.tiles {
        // Only zoned land has residents to be happy or unhappy. Asked through
        // the accessor rather than off `kind` so step 3 of #177 can narrow
        // `kind` to terrain without freezing happiness city-wide.
        if tile.zone_occupant().is_some() {
            tile.happiness += (target - tile.happiness) * t.happiness_drift_rate;
            tile.happiness = tile.happiness.clamp(0.0, 1.5);
        }
    }
}

// ---------------------------------------------------------------------------
// Tests — these are the spec (no TS oracle mirror by design).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{apply_tool, tool_cost};
    use crate::migrate::set_v4_kind;
    use crate::occupants::{Occupant, ALL_OCCUPANTS};
    use city_sim_protocol::commands::Tool;

    fn grid(w: u32, h: u32) -> GameState {
        GameState::new(w, h, 0)
    }

    /// Paint a tile by its old v4 `kind`, giving structure kinds the
    /// development they need to be scored — `Occupant::Structure` is a flat
    /// tag, so a park with no `BuildingInstance` behind it is bare ground.
    fn set(state: &mut GameState, x: u32, y: u32, kind: TileKind) {
        if crate::occupants::is_structure_kind(kind) {
            let id = state.next_building_id;
            state.next_building_id += 1;
            state
                .buildings
                .push(crate::buildings::BuildingInstance::new(id, kind, (x, y)));
            let tile = state.tile_at_mut(x, y).unwrap();
            tile.set_occupant(Occupant::Structure, true);
            tile.building_id = Some(id as u16);
        } else {
            set_v4_kind(state.tile_at_mut(x, y).unwrap(), kind);
        }
    }

    fn score(state: &GameState) -> f32 {
        compute_wilderness(state, &WildernessTunables::default()).score
    }

    fn eco_at(state: &GameState, x: u32, y: u32) -> f32 {
        let out = compute_wilderness(state, &WildernessTunables::default());
        out.eco_field[state.tile_index(x, y).unwrap()]
    }

    /// Drive a row of tiles with the real tool handlers, so what is scored is
    /// the recording `commands.rs` actually writes rather than one invented
    /// here.
    fn build_row(state: &mut GameState, tools: &[Tool], y: u32, len: u32) {
        for tool in tools {
            for x in 0..len {
                let r = apply_tool(state, *tool, x, y);
                assert!(r.success, "{tool:?} at ({x}, {y}) failed: {:?}", r.message);
            }
        }
    }

    /// **The score half of delta 3** — see `display.rs`'s module note and
    /// `commands::tests::one_bulldozer_click_clears_a_whole_footprint`.
    ///
    /// On the pre-strata tree — the last commit where `kind` was canonical,
    /// named in `display.rs`'s module note — `remove_building` kept the tile's
    /// `kind`, so a bulldozed park stayed a park to every consumer that read
    /// the kind byte — including this one. It scored +4.0 of natural capital for a tile with
    /// nothing on it, for ever. Measured on that tree, an 8×8 city with one
    /// park at (4, 4) scored 67.0312 both before *and* after the bulldozer;
    /// here the razed tile drops back to exactly the eco of ground that was
    /// never built on, which is the whole point of clearing the tag.
    ///
    /// This is a gameplay change, not a representation one, and it is the only
    /// one step 3 made. It is pinned here so that stays true and visible.
    #[test]
    fn a_bulldozed_park_stops_scoring_as_a_park() {
        let untouched = grid(8, 8);
        let (blank_eco, blank_score) = (eco_at(&untouched, 4, 4), score(&untouched));

        let mut s = grid(8, 8);
        assert!(apply_tool(&mut s, Tool::Park, 4, 4).success);
        let built_eco = eco_at(&s, 4, 4);
        assert!(
            built_eco > blank_eco,
            "a park must be worth more than the ground it sits on ({built_eco} vs {blank_eco})"
        );

        assert!(apply_tool(&mut s, Tool::Bulldoze, 4, 4).success);
        assert_eq!(
            eco_at(&s, 4, 4),
            blank_eco,
            "the razed tile still scores as something"
        );
        assert_eq!(
            score(&s),
            blank_score,
            "the city still scores the dead park"
        );
    }

    /// **The score half of #177 step 4 — the bulldozer stops filling lakes in.**
    ///
    /// `buildable` is `terrain != Water`, and it is the only thing the softening
    /// constant `k` is scaled by, so anything that turns water into land moves
    /// the score twice over: `P` gains the +1.0 open-land credit, `k` gains
    /// 0.5, and every strong-nature tile that was on the shoreline loses its
    /// +2.0 water-edge bonus. Until now the bulldozer did all three for 1
    /// credit a tile.
    ///
    /// Measured on the 16×16 city below — three urban rows, two forest rows,
    /// and a 4×4 lake carved directly beneath the forest — bulldozing the whole
    /// lake used to move it like this:
    ///
    /// | | score | P | U | k | buildable |
    /// | --- | --- | --- | --- | --- | --- |
    /// | lake intact | 66.6920 | 400.456 | 80.0 | 120.0 | 240 |
    /// | bulldozed, old rule | 66.2587 | 408.456 | 80.0 | 128.0 | 256 |
    ///
    /// `P` rose by 8.0, not 16.0: sixteen tiles gained the +1.0 land credit and
    /// the four forest tiles that had been on the shore lost 2.0 each. `k` rose
    /// by the full 8.0. Sixteen credits of bulldozing therefore cost 0.4332 of
    /// wilderness score — and cost it for the *right* reason, filling in a
    /// lake, at a twelfth of the 192 credits the water brush charges to dig
    /// one back out.
    ///
    /// The sign flips with the city. The score is `100·P/(P+U+k)`, so filling a
    /// tile with no nature on its shore adds 1.0 to the numerator and 1.5 to
    /// the denominator: it *raises* the score of any city scoring under 66.67
    /// and lowers it above. A dirty city was the profitable case. On a 16×16
    /// map with eight industrial rows, a road row under them and a 4×8 lake
    /// nowhere near nature, thirty-two bulldozer clicks — 32 credits, no
    /// industry removed — took the score from 9.2593 to 12.2807. Filling in a
    /// lake bought three points of wilderness.
    ///
    /// Now the bulldozer moves neither term, because it no longer touches
    /// terrain. The lake is still there after the click.
    ///
    /// **What that did not do is close the exploit — it made it 6× dearer.**
    /// `regrade_at` still writes `Terrain::Land`, and every building tool calls
    /// it, so the same thirty-two tiles drain for 192 credits as `Tool::Road`
    /// followed by `Tool::Bulldoze`. Measured on the same 16×16 map without the
    /// road row: 11.3208 → 14.2857, the same three points. Whoever prices
    /// bridges and docks (`Terrain`'s note in `occupants.rs`) inherits that;
    /// `commands::tests::building_over_water_and_razing_it_is_the_cheapest_regrade`
    /// pins the price meanwhile so no doc can claim the brushes are the only
    /// way to drain a lake.
    #[test]
    fn bulldozing_a_lake_no_longer_fills_it_in_or_moves_the_score() {
        let mut s = grid(16, 16);
        s.money = 1_000_000;
        build_row(&mut s, &[Tool::Road], 2, 16);
        build_row(&mut s, &[Tool::Residential], 3, 16);
        build_row(&mut s, &[Tool::Commercial], 4, 16);
        build_row(&mut s, &[Tool::Tree], 10, 16);
        build_row(&mut s, &[Tool::Tree], 11, 16);
        for y in 12..16 {
            for x in 0..4 {
                assert!(apply_tool(&mut s, Tool::Water, x, y).success);
            }
        }

        let buildable = |s: &GameState| {
            s.tiles
                .iter()
                .filter(|t| t.terrain() == Terrain::Land)
                .count()
        };
        let (before_score, before_buildable) = (score(&s), buildable(&s));
        assert_eq!(before_buildable, 240, "the lake is 16 of the 256 tiles");

        for y in 12..16 {
            for x in 0..4 {
                assert!(apply_tool(&mut s, Tool::Bulldoze, x, y).success);
            }
        }

        assert_eq!(
            buildable(&s),
            before_buildable,
            "the bulldozer opened {} tiles of buildable land for 16 credits",
            buildable(&s) - before_buildable
        );
        assert_eq!(
            score(&s),
            before_score,
            "the bulldozer moved the wilderness score by changing the terrain"
        );
        // And the shoreline forest keeps the bonus it was drawing from the lake.
        assert!(
            eco_at(&s, 0, 11) > eco_at(&s, 8, 11),
            "the waterfront trees lost their edge bonus to the bulldozer"
        );
    }

    /// **The lake-filling exploit is 6× dearer, not gone.**
    ///
    /// The companion to the test above, and the reason its closing claim is
    /// "the bulldozer moves neither term" rather than "the lake cannot be
    /// drained". `regrade_at` writes `Terrain::Land` and every building tool
    /// calls it, so `Tool::Road` followed by `Tool::Bulldoze` buys the same
    /// terrain the 1-credit click used to, at 6 credits a tile.
    ///
    /// Measured on a dirty 16×16 — eight industrial rows and a 4×8 lake well
    /// clear of them, the shape the doc comment above uses to describe the old
    /// exploit — draining the lake still moves the score by the full three
    /// points:
    ///
    /// | | score | buildable |
    /// | --- | --- | --- |
    /// | lake intact | 11.3208 | 224 |
    /// | drained, 32 × (Road + Bulldoze) | 14.2857 | 256 |
    ///
    /// 192 credits against the 384 the water brush charges to dig it back out,
    /// so the round trip is still a loss — which is the only thing standing
    /// between the score and a pump. Pricing that properly is bridges and docks
    /// (see `Terrain` in `occupants.rs`); this test exists so nobody documents
    /// the exploit as closed while the numbers say otherwise.
    #[test]
    fn a_builder_and_a_bulldozer_still_drain_a_lake_and_move_the_score() {
        let mut s = grid(16, 16);
        s.money = 1_000_000;
        for y in 0..8 {
            build_row(&mut s, &[Tool::Industrial], y, 16);
        }
        for y in 8..16 {
            for x in 0..4 {
                assert!(apply_tool(&mut s, Tool::Water, x, y).success);
            }
        }
        let buildable = |s: &GameState| {
            s.tiles
                .iter()
                .filter(|t| t.terrain() == Terrain::Land)
                .count()
        };
        assert_eq!(buildable(&s), 224, "the lake is 32 of the 256 tiles");
        let before = score(&s);

        let money_before = s.money;
        for y in 8..16 {
            for x in 0..4 {
                assert!(apply_tool(&mut s, Tool::Road, x, y).success);
                assert!(apply_tool(&mut s, Tool::Bulldoze, x, y).success);
            }
        }

        assert_eq!(buildable(&s), 256, "the lake survived a road laid over it");
        assert_eq!(
            money_before - s.money,
            32 * (tool_cost(Tool::Road) + tool_cost(Tool::Bulldoze)),
            "the drain cost something other than 32 build-and-raze pairs"
        );
        assert!(
            score(&s) > before,
            "draining a lake in a dirty city no longer pays ({} → {})",
            before,
            score(&s)
        );
        assert!(
            money_before - s.money < 32 * tool_cost(Tool::Water),
            "the round trip through the brush must still cost more than the drain"
        );
    }

    // --- base weights ---

    /// Each eco table is exactly as long as its own key's domain — which is
    /// the whole point of the split. One `base_eco[TileKind]` array used to
    /// answer for terrain, occupants and structures alike, so `TileKind` was
    /// the key to three questions it only really answers one of.
    #[test]
    fn each_eco_table_is_indexed_by_its_own_key() {
        let t = WildernessTunables::default();
        assert_eq!(t.terrain_eco.len(), Terrain::ALL.len());
        assert_eq!(t.occupant_eco.len(), ALL_OCCUPANTS.len());
        assert_eq!(t.structure_eco.len(), TileKind::ALL.len());
        for terrain in Terrain::ALL {
            let _ = t.terrain_eco[terrain as usize];
        }
        for o in ALL_OCCUPANTS {
            let _ = t.occupant_eco[o as usize];
        }
        for &kind in TileKind::ALL {
            let _ = t.structure_eco[kind as usize];
        }
    }

    /// The structure table's live rows are exactly the structure kinds. Every
    /// other `TileKind` row is `0.0` and stays that way: a road's −2.0 moved
    /// *out* of the `TileKind`-keyed table when the split happened, rather
    /// than being copied into a second home where the two could drift.
    #[test]
    fn only_structure_kinds_carry_a_structure_eco() {
        let t = WildernessTunables::default();
        for &kind in TileKind::ALL {
            assert_eq!(
                t.structure_eco[kind as usize] != 0.0,
                crate::occupants::is_structure_kind(kind),
                "{kind:?}: only structures belong in the structure eco table"
            );
        }
    }

    /// `Occupant::Structure` is the one occupant with no value of its own, and
    /// its row must stay unread rather than merely unused — a `0.0` returned
    /// from the occupant table would flatten a park and a coal plant into each
    /// other exactly as the pre-`EcoSource` `Option<TileKind>` did.
    #[test]
    fn the_structure_row_of_the_occupant_table_is_never_read() {
        let mut t = WildernessTunables::default();
        assert_eq!(t.occupant_eco[Occupant::Structure as usize], 0.0);
        // Poison the row: nothing may notice.
        t.occupant_eco[Occupant::Structure as usize] = 999.0;
        assert_eq!(occupant_eco(Occupant::Structure, &t), None);
        assert_eq!(structure_eco(TileKind::CoalPlant, &t), -8.0);

        // …and no route into the score may notice either.
        let mut s = grid(8, 8);
        set(&mut s, 3, 3, TileKind::CoalPlant);
        let honest = compute_wilderness(&s, &WildernessTunables::default());
        let poisoned = compute_wilderness(&s, &t);
        assert_eq!(
            poisoned.score, honest.score,
            "a structure read its occupant row instead of its structure row"
        );
        assert_eq!(poisoned.breakdown.power, honest.breakdown.power);
        assert_eq!(poisoned.breakdown, honest.breakdown);
    }

    #[test]
    fn untouched_land_map_scores_mid_high() {
        let s = grid(16, 16);
        let v = score(&s);
        // All-Land: P = N·1, U = 0, k = 0.5·N → 100·1/1.5 ≈ 66.7
        assert!(
            (60.0..75.0).contains(&v),
            "untouched map should land mid-high, got {v}"
        );
    }

    #[test]
    fn industrial_city_scores_low_but_not_pinned() {
        let mut s = grid(16, 16);
        for y in 0..16 {
            for x in 0..16 {
                set(&mut s, x, y, TileKind::Industrial);
            }
        }
        let all_industrial = score(&s);
        assert!(all_industrial < 5.0, "industrial map must score near 0");

        // Marginal change must still move the needle (no dead zone).
        for y in 0..4 {
            for x in 0..4 {
                set(&mut s, x, y, TileKind::Tree);
            }
        }
        assert!(
            score(&s) > all_industrial + 1.0,
            "adding a forest to a bad city must visibly raise the score"
        );
    }

    #[test]
    fn water_pipe_and_water_are_neutral() {
        let t = WildernessTunables::default();
        // The buried pipe is an occupant; water is terrain. One array used to
        // hold both, which is exactly the conflation the split undid.
        assert_eq!(t.occupant_eco[Occupant::Pipe as usize], 0.0);
        assert_eq!(t.terrain_eco[Terrain::Water as usize], 0.0);
        // The reserved occupants score nothing either — a value, not a hole.
        assert_eq!(t.occupant_eco[Occupant::Subway as usize], 0.0);
        assert_eq!(t.occupant_eco[Occupant::Fibre as usize], 0.0);
    }

    #[test]
    fn coal_is_worse_than_wind_and_solar() {
        let t = WildernessTunables::default();
        assert!(
            t.structure_eco[TileKind::CoalPlant as usize]
                < t.structure_eco[TileKind::HydroPlant as usize]
        );
        assert!(
            t.structure_eco[TileKind::HydroPlant as usize]
                < t.structure_eco[TileKind::WindTurbine as usize]
        );
        assert_eq!(
            t.structure_eco[TileKind::WindTurbine as usize],
            t.structure_eco[TileKind::SolarFarm as usize]
        );
    }

    // --- neighbourhood adjustments ---

    #[test]
    fn big_patch_beats_scattered_trees() {
        // 20 trees as one 4×5 block…
        let mut block = grid(16, 16);
        for y in 0..5 {
            for x in 0..4 {
                set(&mut block, x, y, TileKind::Tree);
            }
        }
        // …versus 20 trees spread out on a lattice.
        let mut scattered = grid(16, 16);
        let mut placed = 0;
        'outer: for y in (0..16).step_by(3) {
            for x in (0..16).step_by(3) {
                set(&mut scattered, x, y, TileKind::Tree);
                placed += 1;
                if placed == 20 {
                    break 'outer;
                }
            }
        }
        assert_eq!(placed, 20);
        assert!(
            score(&block) > score(&scattered),
            "contiguous forest ({}) must beat scattered trees ({})",
            score(&block),
            score(&scattered)
        );
    }

    #[test]
    fn edge_bonus_rewards_waterfront_park() {
        // Park block next to a pond…
        let mut adjacent = grid(16, 16);
        for y in 4..8 {
            set(&mut adjacent, 4, y, TileKind::Water);
            set(&mut adjacent, 5, y, TileKind::Park);
        }
        // …versus the same park and pond far apart.
        let mut apart = grid(16, 16);
        for y in 4..8 {
            set(&mut apart, 0, y, TileKind::Water);
            set(&mut apart, 12, y, TileKind::Park);
        }
        assert!(
            score(&adjacent) > score(&apart),
            "waterfront park ({}) must beat distant park ({})",
            score(&adjacent),
            score(&apart)
        );
    }

    #[test]
    fn fragmentation_penalises_lone_tree() {
        let mut s = grid(8, 8);
        set(&mut s, 4, 4, TileKind::Tree);
        let out = compute_wilderness(&s, &WildernessTunables::default());
        let t = WildernessTunables::default();
        let idx = s.tile_index(4, 4).unwrap();
        // Base 6, small patch bonus, minus fragmentation penalty — must be
        // below base+patch by exactly the penalty.
        assert!(out.eco_field[idx] < t.occupant_eco[Occupant::Trees as usize]);
        assert!(out.breakdown.fragmentation < 0.0);
    }

    #[test]
    fn interior_forest_tile_has_no_fragmentation_penalty() {
        let mut s = grid(8, 8);
        for y in 2..7 {
            for x in 2..7 {
                set(&mut s, x, y, TileKind::Tree);
            }
        }
        let out = compute_wilderness(&s, &WildernessTunables::default());
        let t = WildernessTunables::default();
        let centre = s.tile_index(4, 4).unwrap();
        // Centre tile: base + patch bonus, no penalty, no edge bonus.
        let expected_min = t.occupant_eco[Occupant::Trees as usize];
        assert!(
            out.eco_field[centre] > expected_min,
            "interior tile should exceed base eco (got {})",
            out.eco_field[centre]
        );
    }

    #[test]
    fn road_through_forest_costs_more_than_road_tiles_alone() {
        // Forest block 8 wide, 5 tall.
        let mut forest = grid(16, 16);
        for y in 4..9 {
            for x in 4..12 {
                set(&mut forest, x, y, TileKind::Tree);
            }
        }
        let before = score(&forest);

        // Cut a vertical road through the middle: 5 road tiles replace trees.
        let mut cut = forest.clone();
        for y in 4..9 {
            set(&mut cut, 8, y, TileKind::Road);
        }
        let after = score(&cut);

        // Same road on open land far away: baseline cost of 5 road tiles.
        let mut open_road = forest.clone();
        for y in 4..9 {
            set(&mut open_road, 14, y, TileKind::Road);
        }
        let road_alone = score(&open_road);

        assert!(after < before, "road through forest must drop the score");
        assert!(
            before - after > before - road_alone,
            "splitting the forest ({} → {}) must cost more than the same road on open land ({} → {})",
            before,
            after,
            before,
            road_alone
        );
    }

    // --- score bounds & monotonicity ---

    #[test]
    fn score_is_always_in_bounds() {
        let mut s = grid(8, 8);
        assert!((0.0..=100.0).contains(&score(&s)));
        for y in 0..8 {
            for x in 0..8 {
                set(&mut s, x, y, TileKind::CoalPlant);
            }
        }
        assert!((0.0..=100.0).contains(&score(&s)));
        for y in 0..8 {
            for x in 0..8 {
                set(&mut s, x, y, TileKind::Tree);
            }
        }
        assert!((0.0..=100.0).contains(&score(&s)));
    }

    #[test]
    fn all_water_map_scores_zero() {
        let mut s = grid(8, 8);
        for y in 0..8 {
            for x in 0..8 {
                set(&mut s, x, y, TileKind::Water);
            }
        }
        assert_eq!(score(&s), 0.0);
    }

    #[test]
    fn adding_industry_monotonically_lowers_score() {
        let mut s = grid(16, 16);
        let mut prev = score(&s);
        for i in 0..8 {
            set(&mut s, i, 0, TileKind::Industrial);
            let v = score(&s);
            assert!(v < prev, "tile {i}: {v} should be below {prev}");
            prev = v;
        }
    }

    // --- trend ---

    #[test]
    fn trend_seeds_flat_then_follows_direction() {
        let t = WildernessTunables::default();
        let mut stats = WildernessStats::default();
        update_trend(&mut stats, 50.0, &t);
        assert_eq!(stats.trend, 0.0, "first sample must not fake a trend");
        for _ in 0..5 {
            update_trend(&mut stats, 60.0, &t);
        }
        assert!(stats.trend > 0.0, "rising scores → positive trend");
        for _ in 0..20 {
            update_trend(&mut stats, 40.0, &t);
        }
        assert!(stats.trend < 0.0, "falling scores → negative trend");
    }

    // --- consequence helpers ---

    #[test]
    fn demand_delta_is_zero_at_neutral_score() {
        let t = WildernessTunables::default();
        assert_eq!(demand_delta(50.0, &t), 0.0);
        assert!(demand_delta(100.0, &t) > 0.0);
        assert!(demand_delta(0.0, &t) < 0.0);
    }

    #[test]
    fn tourism_dividend_zero_below_threshold_scales_above() {
        let t = WildernessTunables::default();
        assert_eq!(tourism_dividend(59.9, 1000, &t), 0.0);
        assert_eq!(tourism_dividend(60.0, 1000, &t), 0.0);
        let mid = tourism_dividend(80.0, 1000, &t);
        let max = tourism_dividend(100.0, 1000, &t);
        assert!(mid > 0.0 && max > mid);
        assert!((max - 1000.0 * t.dividend_per_capita).abs() < 0.001);
        assert_eq!(
            tourism_dividend(100.0, 0, &t),
            0.0,
            "no citizens, no tourism"
        );
    }

    // --- wilderness programmes (#9) ---

    #[test]
    fn nature_reserve_raises_score_of_fragmented_nature() {
        let mut s = grid(16, 16);
        // Scattered trees: heavy fragmentation, small clusters.
        for y in (0..16).step_by(3) {
            for x in (0..16).step_by(3) {
                set(&mut s, x, y, TileKind::Tree);
            }
        }
        let base = WildernessTunables::default();
        let reserve = base.effective(&WildernessPolicy {
            nature_reserve: true,
            green_industry: false,
        });
        let without = compute_wilderness(&s, &base).score;
        let with = compute_wilderness(&s, &reserve).score;
        assert!(
            with > without,
            "nature reserve must raise a fragmented map's score ({with} vs {without})"
        );
    }

    #[test]
    fn green_industry_softens_industrial_pressure() {
        let mut s = grid(16, 16);
        for x in 0..8 {
            set(&mut s, x, 0, TileKind::Industrial);
        }
        let base = WildernessTunables::default();
        let green = base.effective(&WildernessPolicy {
            nature_reserve: false,
            green_industry: true,
        });
        let without = compute_wilderness(&s, &base);
        let with = compute_wilderness(&s, &green);
        assert!(with.score > without.score);
        assert!(
            with.breakdown.industry > without.breakdown.industry,
            "industry pressure must shrink (less negative) under green industry"
        );
    }

    #[test]
    fn effective_tunables_are_identity_when_all_programmes_off() {
        let base = WildernessTunables::default();
        let same = base.effective(&WildernessPolicy::default());
        assert_eq!(same.patch_bonus_cap, base.patch_bonus_cap);
        assert_eq!(same.fragmentation_penalty, base.fragmentation_penalty);
        assert_eq!(same.terrain_eco, base.terrain_eco);
        assert_eq!(same.occupant_eco, base.occupant_eco);
        assert_eq!(same.structure_eco, base.structure_eco);
    }

    #[test]
    fn happiness_drifts_toward_target_only_on_zone_tiles() {
        let t = WildernessTunables::default();
        let mut s = grid(4, 4);
        set(&mut s, 0, 0, TileKind::Residential);
        s.tile_at_mut(0, 0).unwrap().happiness = 1.0;
        s.tile_at_mut(1, 0).unwrap().happiness = 1.0; // Land — untouched
        apply_happiness_drift(&mut s, 100.0, &t);
        assert!(
            s.tile_at(0, 0).unwrap().happiness > 1.0,
            "zone tile should drift up at high wilderness"
        );
        assert_eq!(
            s.tile_at(1, 0).unwrap().happiness,
            1.0,
            "non-zone tiles must be untouched"
        );
        apply_happiness_drift(&mut s, 0.0, &t);
        // Now drifting toward 0.8 — must move down and stay in range.
        let h = s.tile_at(0, 0).unwrap().happiness;
        assert!((0.0..=1.5).contains(&h));
    }

    // --- one contribution per occupant (#173) ---

    /// **The headline symptom of #173, and it must never come back.**
    ///
    /// Scoring read `base_eco[tile.kind]` once. A road carrying a hydro line
    /// is recorded `kind = PowerLine` with a road underlay, so the road's
    /// −2.0 vanished and the tile scored the line's −1.0 alone: ten roads with
    /// lines scored *better* than ten bare roads, and the way to raise your
    /// wilderness score was to build more infrastructure.
    ///
    /// Driven through `apply_tool` so it is the real recording being scored.
    #[test]
    fn issue_173_stringing_a_line_over_a_road_must_lower_the_score() {
        const LEN: u32 = 10;

        let mut bare = grid(16, 16);
        build_row(&mut bare, &[Tool::Road], 8, LEN);
        let roads_only = score(&bare);

        let mut wired = grid(16, 16);
        build_row(&mut wired, &[Tool::Road, Tool::PowerLine], 8, LEN);
        let roads_and_lines = score(&wired);

        assert!(
            roads_and_lines < roads_only,
            "adding a hydro line to every road must make the score WORSE, \
             got {roads_and_lines} against {roads_only} for bare roads"
        );

        // Not merely "not better": the line costs its full −1.0 per tile, so
        // the pressure grows by exactly `LEN`.
        let u_of = |s: &GameState| -> f32 {
            compute_wilderness(s, &WildernessTunables::default())
                .eco_field
                .iter()
                .filter(|v| **v < 0.0)
                .map(|v| -v)
                .sum()
        };
        assert_eq!(u_of(&wired) - u_of(&bare), LEN as f32);

        // Build order must not change the score: `Tool::Road` and
        // `Tool::PowerLine` agree on one canonical recording, and the occupant
        // set collapses the two spellings anyway.
        let mut other_order = grid(16, 16);
        build_row(&mut other_order, &[Tool::PowerLine, Tool::Road], 8, LEN);
        assert_eq!(score(&other_order), roads_and_lines);
    }

    /// The other half of #173: the old breakdown `match kind` forced one
    /// category per tile, so a road under a line moved its damage *out of*
    /// `transport` and *into* `power`. Each occupant is filed on its own line
    /// now.
    #[test]
    fn issue_173_each_occupant_is_filed_on_its_own_breakdown_line() {
        let mut s = grid(8, 8);
        build_row(&mut s, &[Tool::Road, Tool::PowerLine], 4, 1);
        let b = compute_wilderness(&s, &WildernessTunables::default()).breakdown;

        // Before the fix: transport 0.0, power −1.0 — the road was invisible.
        assert_eq!(b.transport, -2.0, "the road keeps its own line");
        assert_eq!(b.power, -1.0, "the line keeps its own line");
        // …and the tile has lost the open-land credit exactly once.
        assert_eq!(b.open_land, 63.0, "63 of 64 tiles are still bare land");
        assert_eq!(eco_at(&s, 0, 4), -3.0);
    }

    /// A level crossing carries two occupants and used to be billed for one.
    #[test]
    fn a_level_crossing_costs_both_the_road_and_the_rail() {
        let mut s = grid(8, 8);
        build_row(&mut s, &[Tool::Rail, Tool::Road], 4, 1);
        // Before the fix: −2.0, whichever of the two owned `kind`.
        assert_eq!(eco_at(&s, 0, 4), -4.0);
        let b = compute_wilderness(&s, &WildernessTunables::default()).breakdown;
        assert_eq!(b.transport, -4.0, "both halves are transport");
    }

    /// A hydro line strung across a zone leaves the zone standing (the tile
    /// keeps `kind = Residential` and records the line in `FLAG_POWER_OVERLAY`)
    /// — the one spelling in which the line was completely invisible to
    /// scoring, since no flag was ever consulted.
    #[test]
    fn a_line_across_a_zone_costs_the_line_as_well_as_the_zone() {
        let mut s = grid(8, 8);
        build_row(&mut s, &[Tool::Residential, Tool::PowerLine], 4, 1);
        let tile = s.tile_at(0, 4).unwrap();
        assert_eq!(
            tile.zone_occupant(),
            Some(Occupant::ZoneResidential),
            "the zone survives"
        );
        assert!(tile.has_occupant(Occupant::PowerLine), "…carrying the line");

        // Before the fix: −1.0, all of it on `zones`.
        assert_eq!(eco_at(&s, 0, 4), -2.0);
        let b = compute_wilderness(&s, &WildernessTunables::default()).breakdown;
        assert_eq!(b.zones, -1.0);
        assert_eq!(b.power, -1.0);
    }

    /// `Tool::TerraformRaise` overwrites `kind` with `Land` and leaves the
    /// structural flags alone, so a hydro line can end up recorded *only* in
    /// `FLAG_POWER_OVERLAY`. That tile used to collect the +1.0 open-land
    /// credit while still carrying — and still being billed for — a live line.
    #[test]
    fn a_line_recorded_only_in_a_flag_still_costs_and_forfeits_the_open_land_credit() {
        let mut s = grid(8, 8);
        build_row(&mut s, &[Tool::PowerLine, Tool::TerraformRaise], 4, 1);
        let tile = s.tile_at(0, 4).unwrap();
        assert_eq!(tile.occupants_in(crate::occupants::Stratum::Surface), 0);
        assert!(tile.has_occupant(Occupant::PowerLine));

        // Before the fix: +1.0, filed on `open_land`.
        assert_eq!(eco_at(&s, 0, 4), -1.0);
        let b = compute_wilderness(&s, &WildernessTunables::default()).breakdown;
        assert_eq!(b.power, -1.0);
        assert_eq!(b.open_land, 63.0, "the built tile forfeits its credit");
    }

    /// Trees over a hydro line: the canopy keeps its +6.0 and its strong-nature
    /// standing (patch, water-edge and fragmentation passes all still see it),
    /// and the conductors underneath are charged on top.
    #[test]
    fn a_tree_planted_over_a_line_keeps_its_nature_and_pays_for_the_line() {
        let mut lone_tree = grid(8, 8);
        set(&mut lone_tree, 4, 4, TileKind::Tree);
        let plain = eco_at(&lone_tree, 4, 4);

        let mut over_line = grid(8, 8);
        build_row(&mut over_line, &[Tool::PowerLine, Tool::Tree], 4, 1);
        let tile = over_line.tile_at(0, 4).unwrap();
        assert!(tile.has_occupant(Occupant::Trees));
        assert!(tile.has_occupant(Occupant::PowerLine));

        // Same neighbourhood adjustments (lone tree, no water, fragmented) on
        // both grids, so the whole difference is the line's −1.0.
        assert_eq!(eco_at(&over_line, 0, 4), plain - 1.0);
        let b = compute_wilderness(&over_line, &WildernessTunables::default()).breakdown;
        assert_eq!(b.forests, 6.0, "the canopy is still a forest");
        assert_eq!(b.power, -1.0);
        assert!(
            b.fragmentation < 0.0,
            "a lone tree is still strong nature, so it can still be fragmented"
        );
    }

    /// The eco sum stays tunables-sourced, so the Green Industry programme
    /// still reaches a zone tile that also carries a hydro line — a static
    /// number in `OCCUPANT_DEFS` would have disabled the policy silently.
    #[test]
    fn green_industry_still_reaches_a_zone_that_carries_a_line() {
        let mut s = grid(8, 8);
        build_row(&mut s, &[Tool::Industrial, Tool::PowerLine], 4, 1);
        let tile = s.tile_at(0, 4).unwrap();
        assert_eq!(tile.zone_occupant(), Some(Occupant::ZoneIndustrial));
        assert!(tile.has_occupant(Occupant::PowerLine));

        let base = WildernessTunables::default();
        let green = base.effective(&WildernessPolicy {
            nature_reserve: false,
            green_industry: true,
        });
        let idx = s.tile_index(0, 4).unwrap();
        // −5.0 industry + −1.0 line, softening to −2.0 + −1.0.
        assert_eq!(compute_wilderness(&s, &base).eco_field[idx], -6.0);
        assert_eq!(compute_wilderness(&s, &green).eco_field[idx], -3.0);
        assert_eq!(compute_wilderness(&s, &green).breakdown.industry, -2.0);
        assert_eq!(compute_wilderness(&s, &green).breakdown.power, -1.0);
    }

    /// Green Industry patches the **occupant** table now, and it must still
    /// reach a plain industrial tile.
    ///
    /// The programme used to rewrite `base_eco[TileKind::Industrial]`, a row of
    /// the one array that also held the terrain credits and the per-structure
    /// values. Splitting that array by concept is only behaviour-preserving if
    /// the patch lands on the row the industrial *occupant* reads — so this
    /// pins both halves: exactly one row moves, and the tile's score follows.
    #[test]
    fn green_industry_reaches_an_industrial_tile_through_the_occupant_table() {
        let mut s = grid(8, 8);
        build_row(&mut s, &[Tool::Industrial], 4, 1);
        let idx = s.tile_index(0, 4).unwrap();
        assert_eq!(
            s.tile_at(0, 4).unwrap().zone_occupant(),
            Some(Occupant::ZoneIndustrial)
        );

        let base = WildernessTunables::default();
        let green = base.effective(&WildernessPolicy {
            nature_reserve: false,
            green_industry: true,
        });

        // One row moves, and it is the industrial occupant's.
        assert_eq!(base.occupant_eco[Occupant::ZoneIndustrial as usize], -5.0);
        assert_eq!(green.occupant_eco[Occupant::ZoneIndustrial as usize], -2.0);
        assert_eq!(green.terrain_eco, base.terrain_eco);
        assert_eq!(green.structure_eco, base.structure_eco);
        for o in ALL_OCCUPANTS {
            if o == Occupant::ZoneIndustrial {
                continue;
            }
            assert_eq!(
                green.occupant_eco[o as usize], base.occupant_eco[o as usize],
                "{o:?}: Green Industry moved a row it has no business touching"
            );
        }

        // …and the tile reads it, through the accessor and through the score.
        assert_eq!(occupant_eco(Occupant::ZoneIndustrial, &green), Some(-2.0));
        assert_eq!(compute_wilderness(&s, &base).eco_field[idx], -5.0);
        assert_eq!(compute_wilderness(&s, &green).eco_field[idx], -2.0);
        assert_eq!(compute_wilderness(&s, &base).breakdown.industry, -5.0);
        assert_eq!(compute_wilderness(&s, &green).breakdown.industry, -2.0);
    }

    /// The worst case the old scoring hid: road, rail and hydro line together.
    #[test]
    fn a_tile_carrying_road_rail_and_line_pays_for_all_three() {
        let mut s = grid(8, 8);
        build_row(&mut s, &[Tool::Road, Tool::Rail, Tool::PowerLine], 4, 1);
        let tile = s.tile_at(0, 4).unwrap();
        assert!(tile.has_occupant(Occupant::Road));

        // Before the fix: −1.0 or −2.0 depending on which occupant owned `kind`.
        assert_eq!(eco_at(&s, 0, 4), -5.0);
        let b = compute_wilderness(&s, &WildernessTunables::default()).breakdown;
        assert_eq!(b.transport, -4.0);
        assert_eq!(b.power, -1.0);
    }

    /// A buried pipe is invisible to the score, and leaves the surface free to
    /// keep its open-land credit — `WaterPipe` scores 0.0 and files on no line.
    #[test]
    fn a_buried_pipe_changes_nothing() {
        let mut s = grid(8, 8);
        let before = compute_wilderness(&s, &WildernessTunables::default());
        build_row(&mut s, &[Tool::WaterPipe], 4, 8);
        let after = compute_wilderness(&s, &WildernessTunables::default());
        assert_eq!(after.score, before.score);
        assert_eq!(after.breakdown, before.breakdown);
    }
}
