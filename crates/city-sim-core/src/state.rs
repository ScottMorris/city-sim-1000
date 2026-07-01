// state.rs — GameState and all subordinate types (Tile, DemandStats, etc.).
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use crate::buildings::BuildingInstance;
use crate::rng::SeededRng;
use city_sim_protocol::tile_kind::TileKind;
use std::collections::VecDeque;

// ---------------------------------------------------------------------------
// Tile flags
// ---------------------------------------------------------------------------

pub const FLAG_POWERED: u8 = 0b0000_0001;
pub const FLAG_WATERED: u8 = 0b0000_0010;
pub const FLAG_ABANDONED: u8 = 0b0000_0100;
pub const FLAG_ROAD_UNDERLAY: u8 = 0b0000_1000;
pub const FLAG_RAIL_UNDERLAY: u8 = 0b0001_0000;
pub const FLAG_POWER_OVERLAY: u8 = 0b0010_0000;
/// Zone density packed into bits 6–7: 00=Low, 01=Medium, 10=High.
pub const FLAG_ZONE_DENSITY_MASK: u8 = 0b1100_0000;
pub const FLAG_ZONE_DENSITY_SHIFT: u8 = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[repr(u8)]
pub enum ZoneDensity {
    Low = 0,
    Medium = 1,
    High = 2,
}

// ---------------------------------------------------------------------------
// ServiceKind — which city service a building provides
// ---------------------------------------------------------------------------

/// Which city service a building provides (or `None` for non-service buildings).
/// Mirrors `ServiceId` from `app/src/game/services.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub enum ServiceKind {
    #[default]
    None,
    EducationElementary,
    EducationHigh,
}

// ---------------------------------------------------------------------------
// Tile
// ---------------------------------------------------------------------------

/// One grid cell. Mirrors the TS `Tile` interface in `gameState.ts`.
///
/// `happiness` is stored as 0–100 (u8) to match the SoA tile buffer field.
/// `building_id` is `None` for unbuildable/empty tiles; `Some(id)` otherwise.
/// `underground` holds a buried `TileKind` (e.g. `WaterPipe`) if present.
/// `power_plant_mw` is > 0 for power plant tiles; used as both source flag and
///   output tracker in the power BFS (in MW, deduped by building_id at roll-up).
/// `water_output` is > 0 for active water source tiles (pumps/towers) in the same fashion.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Tile {
    pub kind: TileKind,
    pub flags: u8,
    /// Happiness in [0.0, 1.5] matching the TS float range (createInitialState
    /// sets 1.0; the SoA wire buffer quantises this to u8 on output).
    pub happiness: f32,
    pub elevation: u8,
    pub building_id: Option<u16>,
    pub underground: Option<TileKind>,
    pub power_plant_mw: i32,
    pub water_output: i32,
    /// True when an active elementary school covers this tile.
    pub elementary_served: bool,
    /// True when an active high school covers this tile.
    pub high_served: bool,
    /// Fraction of elementary load satisfied (0.0–1.0).
    pub elementary_score: f32,
    /// Fraction of high-school load satisfied (0.0–1.0).
    pub high_score: f32,
}

impl Tile {
    pub fn land() -> Self {
        Self {
            kind: TileKind::Land,
            flags: 0,
            happiness: 1.0,
            elevation: 0,
            building_id: None,
            underground: None,
            power_plant_mw: 0,
            water_output: 0,
            elementary_served: false,
            high_served: false,
            elementary_score: 0.0,
            high_score: 0.0,
        }
    }

    pub fn water() -> Self {
        Self {
            kind: TileKind::Water,
            ..Self::land()
        }
    }

    // --- flag accessors ---

    pub fn is_powered(&self) -> bool {
        self.flags & FLAG_POWERED != 0
    }
    pub fn is_watered(&self) -> bool {
        self.flags & FLAG_WATERED != 0
    }
    pub fn is_abandoned(&self) -> bool {
        self.flags & FLAG_ABANDONED != 0
    }
    pub fn has_road_underlay(&self) -> bool {
        self.flags & FLAG_ROAD_UNDERLAY != 0
    }
    pub fn has_rail_underlay(&self) -> bool {
        self.flags & FLAG_RAIL_UNDERLAY != 0
    }
    pub fn has_power_overlay(&self) -> bool {
        self.flags & FLAG_POWER_OVERLAY != 0
    }

    pub fn zone_density(&self) -> ZoneDensity {
        match (self.flags & FLAG_ZONE_DENSITY_MASK) >> FLAG_ZONE_DENSITY_SHIFT {
            1 => ZoneDensity::Medium,
            2 => ZoneDensity::High,
            _ => ZoneDensity::Low,
        }
    }

    pub fn set_flag(&mut self, mask: u8, on: bool) {
        if on {
            self.flags |= mask;
        } else {
            self.flags &= !mask;
        }
    }

    pub fn set_zone_density(&mut self, density: ZoneDensity) {
        self.flags =
            (self.flags & !FLAG_ZONE_DENSITY_MASK) | ((density as u8) << FLAG_ZONE_DENSITY_SHIFT);
    }
}

// ---------------------------------------------------------------------------
// DemandStats
// ---------------------------------------------------------------------------

/// Zone demand levels in [0, 100].  Mirrors `DemandStats` in `gameState.ts`.
///
/// Computed each tick by the demand system (P3-6).  P3-4 zone growth reads
/// these values; initial city starts with modest demand so early growth fires.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DemandStats {
    pub residential: f32,
    pub commercial: f32,
    pub industrial: f32,
}

impl DemandStats {
    /// Matches the initial demand a freshly-placed city would exhibit before
    /// the first demand tick runs.  Deliberately low: growth is demand-gated.
    pub fn initial() -> Self {
        Self {
            residential: 50.0,
            commercial: 30.0,
            industrial: 20.0,
        }
    }
}

// ---------------------------------------------------------------------------
// EducationStats
// ---------------------------------------------------------------------------

/// City-wide education coverage snapshot.  Mirrors `EducationStats` in
/// `app/src/game/education.ts`.  Recomputed each tick by `education::recompute_education`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EducationStats {
    pub elementary_served: f32,
    pub elementary_capacity: f32,
    pub elementary_load: f32,
    pub high_served: f32,
    pub high_capacity: f32,
    pub high_load: f32,
    /// Combined coverage score in [0, 1]:  elementary × 0.6 + high × 0.4.
    pub score: f32,
    pub elementary_coverage: f32,
    pub high_coverage: f32,
}

impl Default for EducationStats {
    fn default() -> Self {
        // No schools → load = 0 → coverage = 1 (matches TS `?? 1` defaults)
        Self {
            elementary_served: 0.0,
            elementary_capacity: 0.0,
            elementary_load: 0.0,
            high_served: 0.0,
            high_capacity: 0.0,
            high_load: 0.0,
            score: 1.0,
            elementary_coverage: 1.0,
            high_coverage: 1.0,
        }
    }
}

// ---------------------------------------------------------------------------
// BudgetStats + BudgetHistoryEntry
// ---------------------------------------------------------------------------

/// Daily budget snapshot.  Mirrors the TS `BudgetStats` interface in `gameState.ts`.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct BudgetStats {
    pub revenue: f32,
    pub expenses: f32,
    pub net: f32,
    /// Dollars earned per in-game day (net * 0.2 * 1.5).
    pub net_per_day: f32,
    /// `net_per_day * DAYS_PER_MONTH`.
    pub net_per_month: f32,
    // Revenue breakdown
    pub revenue_base: f32,
    pub revenue_pop: f32,
    pub revenue_commercial: f32,
    pub revenue_industrial: f32,
    // Expense breakdown
    pub expenses_transport: f32,
    pub expenses_buildings: f32,
    // Building expense sub-breakdown
    pub maint_power: f32,
    pub maint_civic: f32,
    pub maint_zones: f32,
    // Transport sub-breakdown
    pub maint_roads: f32,
    pub maint_rail: f32,
    pub maint_power_lines: f32,
    pub maint_pipes: f32,
}

/// One day's budget record, stored in the rolling history ring buffer.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BudgetHistoryEntry {
    pub day: u32,
    pub revenue: f32,
    pub expenses: f32,
    pub net: f32,
}

// ---------------------------------------------------------------------------
// UtilityStats
// ---------------------------------------------------------------------------

/// Mirrors the TS `UtilityStats` interface in `gameState.ts`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct UtilityStats {
    /// Net power balance (produced − used), in MW.
    pub power: i32,
    /// Net water balance (produced − used), in kL/day.
    pub water: i32,
    pub power_produced: i32,
    pub power_used: i32,
    pub water_produced: i32,
    pub water_used: i32,
}

impl UtilityStats {
    /// Matches `createInitialState()` defaults in the TS game.
    pub fn initial() -> Self {
        Self {
            power: 10,
            water: 10,
            power_produced: 0,
            power_used: 0,
            water_produced: 0,
            water_used: 0,
        }
    }
}

// ---------------------------------------------------------------------------
// GameState (minimal for P3-1; expanded per-task in later sub-phases)
// ---------------------------------------------------------------------------

/// Top-level simulation state. Mirrors the TS `GameState` interface, extended
/// with Rust-native types where appropriate.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GameState {
    pub width: u32,
    pub height: u32,
    pub tiles: Vec<Tile>,
    /// Original seed used to initialise the PRNG for this city.
    pub seed: u32,
    /// Live RNG instance — persisted so saves resume mid-stream.
    pub rng: SeededRng,
    /// Treasury balance in whole dollars (can be negative).
    pub money: i64,
    pub day: u32,
    pub tick: u64,
    pub population: u32,
    pub jobs: u32,
    /// Sub-integer population accumulator — fractional growth carries over between
    /// ticks so low-demand cities still grow slowly (mirrors TS float `population`).
    #[serde(default)]
    pub pop_frac: f64,
    /// Sub-integer jobs accumulator — same pattern as `pop_frac`.
    #[serde(default)]
    pub jobs_frac: f64,
    pub utilities: UtilityStats,
    pub demand: DemandStats,
    /// Monotonically increasing counter — bumped whenever tiles change.
    /// Used by the zone growth cache to know when to rescan vacant lots.
    pub tile_revision: u32,
    /// Next building ID to assign on placement.
    pub next_building_id: u32,
    /// All placed buildings — grows when zones develop, shrinks on abandonment.
    pub buildings: Vec<BuildingInstance>,
    /// Education coverage stats, recomputed each tick by `education::recompute_education`.
    pub education: EducationStats,
    /// Last computed daily budget snapshot.
    pub budget: BudgetStats,
    /// Rolling 200-day budget history for the finance panel.
    pub budget_history: VecDeque<BudgetHistoryEntry>,
}

impl GameState {
    /// Construct a new blank city (all-Land tiles).
    ///
    /// Initial values mirror `createInitialState()` in `gameState.ts`:
    /// money=100 000, day=1, tick=0, population=12, jobs=4.
    pub fn new(width: u32, height: u32, seed: u32) -> Self {
        let n = (width * height) as usize;
        Self {
            width,
            height,
            tiles: vec![Tile::land(); n],
            seed,
            rng: SeededRng::new(seed),
            money: 100_000,
            day: 1,
            tick: 0,
            population: 12,
            jobs: 4,
            pop_frac: 0.0,
            jobs_frac: 0.0,
            utilities: UtilityStats::initial(),
            demand: DemandStats::initial(),
            tile_revision: 0,
            next_building_id: 1,
            buildings: Vec::new(),
            education: EducationStats::default(),
            budget: BudgetStats::default(),
            budget_history: VecDeque::new(),
        }
    }

    // --- coordinate accessors ---

    /// Flat index for (x, y), or `None` if out of bounds.
    pub fn tile_index(&self, x: u32, y: u32) -> Option<usize> {
        if x < self.width && y < self.height {
            Some((y * self.width + x) as usize)
        } else {
            None
        }
    }

    /// Reverse a flat index to (x, y).
    pub fn index_to_xy(&self, idx: usize) -> (u32, u32) {
        let idx = idx as u32;
        (idx % self.width, idx / self.width)
    }

    pub fn tile_at(&self, x: u32, y: u32) -> Option<&Tile> {
        self.tile_index(x, y).map(|i| &self.tiles[i])
    }

    pub fn tile_at_mut(&mut self, x: u32, y: u32) -> Option<&mut Tile> {
        self.tile_index(x, y).map(|i| &mut self.tiles[i])
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn gs() -> GameState {
        GameState::new(10, 8, 42)
    }

    #[test]
    fn dimensions_and_tile_count() {
        let g = gs();
        assert_eq!(g.tiles.len(), 80);
        assert_eq!(g.width, 10);
        assert_eq!(g.height, 8);
    }

    #[test]
    fn initial_values_match_ts() {
        let g = gs();
        assert_eq!(g.money, 100_000);
        assert_eq!(g.day, 1);
        assert_eq!(g.tick, 0);
        assert_eq!(g.population, 12);
        assert_eq!(g.jobs, 4);
    }

    #[test]
    fn all_tiles_start_as_land() {
        let g = gs();
        assert!(g.tiles.iter().all(|t| t.kind == TileKind::Land));
    }

    #[test]
    fn tile_index_in_bounds() {
        let g = gs();
        assert_eq!(g.tile_index(0, 0), Some(0));
        assert_eq!(g.tile_index(9, 7), Some(79));
        assert_eq!(g.tile_index(5, 3), Some(35)); // 3*10 + 5
    }

    #[test]
    fn tile_index_out_of_bounds() {
        let g = gs();
        assert_eq!(g.tile_index(10, 0), None); // x == width
        assert_eq!(g.tile_index(0, 8), None); // y == height
        assert_eq!(g.tile_index(u32::MAX, u32::MAX), None);
    }

    #[test]
    fn index_to_xy_round_trips() {
        let g = gs();
        for idx in 0..80usize {
            let (x, y) = g.index_to_xy(idx);
            assert_eq!(g.tile_index(x, y), Some(idx));
        }
    }

    #[test]
    fn tile_at_returns_correct_tile() {
        let mut g = gs();
        g.tiles[35].kind = TileKind::Road;
        assert_eq!(g.tile_at(5, 3).unwrap().kind, TileKind::Road);
    }

    #[test]
    fn tile_at_out_of_bounds_returns_none() {
        let g = gs();
        assert!(g.tile_at(10, 0).is_none());
        assert!(g.tile_at(0, 8).is_none());
    }

    #[test]
    fn tile_at_mut_mutates() {
        let mut g = gs();
        g.tile_at_mut(2, 3).unwrap().kind = TileKind::Residential;
        assert_eq!(g.tile_at(2, 3).unwrap().kind, TileKind::Residential);
    }

    #[test]
    fn tile_flags_round_trip() {
        let mut t = Tile::land();
        assert!(!t.is_powered());
        t.set_flag(FLAG_POWERED, true);
        assert!(t.is_powered());
        t.set_flag(FLAG_POWERED, false);
        assert!(!t.is_powered());
    }

    #[test]
    fn zone_density_default_is_low() {
        let t = Tile::land();
        assert_eq!(t.zone_density(), ZoneDensity::Low);
    }

    #[test]
    fn zone_density_round_trips() {
        let mut t = Tile::land();
        for &d in &[ZoneDensity::Low, ZoneDensity::Medium, ZoneDensity::High] {
            t.set_zone_density(d);
            assert_eq!(t.zone_density(), d);
        }
    }

    #[test]
    fn zone_density_does_not_clobber_other_flags() {
        let mut t = Tile::land();
        t.set_flag(FLAG_POWERED, true);
        t.set_flag(FLAG_WATERED, true);
        t.set_zone_density(ZoneDensity::High);
        assert!(t.is_powered());
        assert!(t.is_watered());
        assert_eq!(t.zone_density(), ZoneDensity::High);
    }

    #[test]
    fn rng_is_seeded_from_state_seed() {
        let mut g = GameState::new(4, 4, 0);
        // Just confirm the RNG produces the same first value as SeededRng::new(0).
        let expected = crate::rng::SeededRng::new(0).next_u32();
        assert_eq!(g.rng.next_u32(), expected);
    }
}
