// wilderness.rs — Wilderness Score: natural capital vs urban pressure (#8).
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

//! Computes the 0–100 Wilderness Score from the tile grid.
//!
//! Every surface tile contributes a base "eco value" from its `TileKind`.
//! Strong nature tiles (`Tree`, `Park`) then receive neighbourhood
//! adjustments: a patch bonus for contiguous clusters, a water-edge bonus,
//! and a fragmentation penalty when isolated. Positive contributions sum to
//! natural capital `P`, negative magnitudes to urban pressure `U`, and the
//! score is `100 · P / (P + U + k)` — see `docs/features/wilderness-score.md`
//! for the design rationale and locked decisions.
//!
//! This module is Rust-first: its tests are the spec, and it is deliberately
//! excluded from the TS parity oracle (`simulation.ts`).

use crate::state::GameState;
use city_sim_protocol::tile_kind::TileKind;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/// All wilderness constants in one place so balancing is a one-file edit.
/// Starter values follow the weight table in the design doc.
#[derive(Debug, Clone)]
pub struct WildernessTunables {
    /// Base eco value indexed by `TileKind as u8`.
    pub base_eco: [f32; 19],
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
}

impl Default for WildernessTunables {
    fn default() -> Self {
        let mut base_eco = [0.0_f32; 19];
        base_eco[TileKind::Land as usize] = 1.0;
        base_eco[TileKind::Water as usize] = 0.0;
        base_eco[TileKind::Tree as usize] = 6.0;
        base_eco[TileKind::Road as usize] = -2.0;
        base_eco[TileKind::Rail as usize] = -2.0;
        base_eco[TileKind::Residential as usize] = -1.0;
        base_eco[TileKind::Commercial as usize] = -2.0;
        base_eco[TileKind::Industrial as usize] = -5.0;
        base_eco[TileKind::PowerLine as usize] = -1.0;
        base_eco[TileKind::HydroPlant as usize] = -2.0;
        base_eco[TileKind::WaterPump as usize] = -1.0;
        base_eco[TileKind::WaterTower as usize] = -1.0;
        // WaterPipe is an underground kind — nature above a buried pipe is
        // still nature. It only appears as a surface kind while unburied,
        // where it is neutral.
        base_eco[TileKind::WaterPipe as usize] = 0.0;
        base_eco[TileKind::ElementarySchool as usize] = -1.0;
        base_eco[TileKind::HighSchool as usize] = -1.0;
        base_eco[TileKind::Park as usize] = 4.0;
        base_eco[TileKind::CoalPlant as usize] = -8.0;
        base_eco[TileKind::WindTurbine as usize] = -1.0;
        base_eco[TileKind::SolarFarm as usize] = -1.0;
        Self {
            base_eco,
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

/// Strong nature: contributes to clusters, earns bonuses, risks fragmentation.
#[inline]
fn is_strong_nature(kind: TileKind) -> bool {
    matches!(kind, TileKind::Tree | TileKind::Park)
}

/// Buildable tiles set the scale of the softening constant `k` so that
/// water-heavy maps are not skewed.
#[inline]
fn is_buildable(kind: TileKind) -> bool {
    kind != TileKind::Water
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

    // Pass 1: label contiguous strong-nature clusters (4-connectivity) and
    // record each cluster's size. cluster_of[i] = usize::MAX for non-nature.
    let mut cluster_of = vec![usize::MAX; n];
    let mut cluster_sizes: Vec<u32> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    for start in 0..n {
        if cluster_of[start] != usize::MAX || !is_strong_nature(state.tiles[start].kind) {
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
                if cluster_of[j] == usize::MAX && is_strong_nature(state.tiles[j].kind) {
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
        let kind = state.tiles[i].kind;
        if is_buildable(kind) {
            buildable += 1;
        }
        let mut eco = t.base_eco[kind as usize];

        // Accumulate the base value into its breakdown category.
        match kind {
            TileKind::Tree => breakdown.forests += eco,
            TileKind::Park => breakdown.parks += eco,
            TileKind::Land => breakdown.open_land += eco,
            TileKind::Residential | TileKind::Commercial => breakdown.zones += eco,
            TileKind::Industrial => breakdown.industry += eco,
            TileKind::Road | TileKind::Rail => breakdown.transport += eco,
            TileKind::PowerLine
            | TileKind::HydroPlant
            | TileKind::CoalPlant
            | TileKind::WindTurbine
            | TileKind::SolarFarm => breakdown.power += eco,
            TileKind::WaterPump
            | TileKind::WaterTower
            | TileKind::ElementarySchool
            | TileKind::HighSchool => breakdown.civic += eco,
            TileKind::Water | TileKind::WaterPipe => {}
        }

        if is_strong_nature(kind) {
            let x = i % w;
            let y = i / w;

            // Patch bonus: saturating curve on cluster size.
            let size = cluster_sizes[cluster_of[i]] as f32;
            let patch = t.patch_bonus_cap * (1.0 - (-size / t.patch_reference_size).exp());
            eco += patch;
            breakdown.patch += patch;

            // Water-edge bonus: any 4-neighbour is water.
            let near_water = (x > 0 && state.tiles[i - 1].kind == TileKind::Water)
                || (x + 1 < w && state.tiles[i + 1].kind == TileKind::Water)
                || (y > 0 && state.tiles[i - w].kind == TileKind::Water)
                || (y + 1 < h && state.tiles[i + w].kind == TileKind::Water);
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
                        && is_strong_nature(state.tiles[ny as usize * w + nx as usize].kind)
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
        if matches!(
            tile.kind,
            TileKind::Residential | TileKind::Commercial | TileKind::Industrial
        ) {
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

    fn grid(w: u32, h: u32) -> GameState {
        GameState::new(w, h, 0)
    }

    fn set(state: &mut GameState, x: u32, y: u32, kind: TileKind) {
        state.tile_at_mut(x, y).unwrap().kind = kind;
    }

    fn score(state: &GameState) -> f32 {
        compute_wilderness(state, &WildernessTunables::default()).score
    }

    // --- base weights ---

    #[test]
    fn every_tile_kind_has_a_weight_entry() {
        let t = WildernessTunables::default();
        // The array must cover every TileKind discriminant.
        for &kind in TileKind::ALL {
            let _ = t.base_eco[kind as usize];
        }
        assert_eq!(t.base_eco.len(), TileKind::ALL.len());
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
        assert_eq!(t.base_eco[TileKind::WaterPipe as usize], 0.0);
        assert_eq!(t.base_eco[TileKind::Water as usize], 0.0);
    }

    #[test]
    fn coal_is_worse_than_wind_and_solar() {
        let t = WildernessTunables::default();
        assert!(t.base_eco[TileKind::CoalPlant as usize] < t.base_eco[TileKind::HydroPlant as usize]);
        assert!(t.base_eco[TileKind::HydroPlant as usize] < t.base_eco[TileKind::WindTurbine as usize]);
        assert_eq!(
            t.base_eco[TileKind::WindTurbine as usize],
            t.base_eco[TileKind::SolarFarm as usize]
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
        assert!(out.eco_field[idx] < t.base_eco[TileKind::Tree as usize]);
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
        let expected_min = t.base_eco[TileKind::Tree as usize];
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
        assert_eq!(tourism_dividend(100.0, 0, &t), 0.0, "no citizens, no tourism");
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
}
