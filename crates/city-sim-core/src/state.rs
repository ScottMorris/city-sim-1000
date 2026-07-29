// state.rs — GameState and all subordinate types (Tile, DemandStats, etc.).
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use crate::buildings::BuildingInstance;
use crate::occupants::{Occupant, Overhead, Stratum, StratumSet, Surface, Terrain, Underground};
use crate::rng::SeededRng;
use crate::wilderness::WildernessStats;
use city_sim_protocol::commands::Policies;
use city_sim_protocol::tile_kind::TileKind;
use std::collections::VecDeque;

// ---------------------------------------------------------------------------
// Tile flags
// ---------------------------------------------------------------------------
//
// Three bits, and only three. `FLAG_ROAD_UNDERLAY`, `FLAG_RAIL_UNDERLAY` and
// `FLAG_POWER_OVERLAY` are gone: they were the overflow of the single-valued
// `kind` slot, and the strata are the slot now. Deleting them is what makes
// every stale structural-flag read fail to compile (step 3 of #177).
//
// The *wire* still carries all six bits — `city_sim_protocol::tile_buffer::flags`
// is untouched, and `display::wire_flags` re-derives the three structural ones
// from the occupant set on the way out.

pub const FLAG_POWERED: u8 = 0b0000_0001;
pub const FLAG_WATERED: u8 = 0b0000_0010;
pub const FLAG_ABANDONED: u8 = 0b0000_0100;

/// Every bit a `Tile::flags` byte may hold. Everything else is derived.
pub const DERIVED_FLAG_MASK: u8 = FLAG_POWERED | FLAG_WATERED | FLAG_ABANDONED;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[repr(u8)]
pub enum ZoneDensity {
    #[default]
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

/// One grid cell. The model is stratified: the ground itself is `terrain`, and
/// everything standing on, over or under it is a bit in one of the three
/// strata. Nothing competes for a slot any more, so no consumer has to check
/// two places — the bug class catalogued in `docs/tile-model.md`.
///
/// The accessors over the strata (`occupants`, `occupants_in`, `has_occupant`,
/// `set_occupant`, `clear_stratum`, …) live in `occupants.rs`, next to the
/// table they answer from and inside the only module that can write a stratum.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Tile {
    // ---- AUTHORED — what the player built. This is what the snapshot persists.
    /// What the ground is, `Land` | `Water`. Its own field, so it is no longer
    /// destroyed by whatever is built on top.
    ///
    /// **The bulldozer no longer flattens it (#177 step 4).** Clearing a tile
    /// restores it to its terrain — a bulldozed lake is still a lake — so the
    /// one-credit click is no longer a terraformer.
    ///
    /// It is not the only way to move terrain, though, and the brushes are not
    /// either. Every tool that *builds* still regrades to `Terrain::Land` first
    /// (see `regrade_at` in `commands.rs`), because construction over water is
    /// bridges and docks — a feature of its own, not a leftover — so a road
    /// laid across a lake and then razed leaves land behind for 6 credits,
    /// under the brushes' 10 and 12. The brushes are the only tools *for*
    /// terraforming; they are not the only ones that end up doing it. See
    /// `commands::tests::building_over_water_and_razing_it_is_the_cheapest_regrade`.
    pub terrain: Terrain,
    /// What is buried here: pipes, and the reserved subway/fibre tags.
    ///
    /// Three sibling fields, in physical order, because *where a thing sits* is
    /// a property of the tile and should be answerable by looking at it rather
    /// than by masking a word. Each is a [`StratumSet`] tagged with the
    /// [`Layer`](crate::occupants::Layer) it belongs to, rather than a bare
    /// `OccupantSet`, so that the shape costs nothing in safety: the inner
    /// field is private and only `occupants::strata` can write one, so a
    /// surface field holding an overhead bit is unrepresentable rather than
    /// merely unwritten. [`Tile::occupants`] unions them for free.
    pub underground: StratumSet<Underground>,
    /// What stands on the ground: road, rail, land use, structures.
    pub surface: StratumSet<Surface>,
    /// What passes overhead: conductors and canopy.
    pub overhead: StratumSet<Overhead>,
    /// The design note's `development`: the `BuildingInstance` this tile
    /// belongs to, and — with [`Occupant::Structure`] being one flat tag — the
    /// only thing that knows *which* structure stands here. Resolve it through
    /// `occupants::StructureLookup`.
    pub building_id: Option<u16>,
    /// Ground height. Beside `terrain` because it describes the ground.
    /// Authored by nothing today (import-only); no tool writes it.
    pub elevation: u8,
    /// Zone density. Was flags bits 6–7, promoted to a field because the flags
    /// byte no longer has room to hide it. Still read by no system.
    pub density: ZoneDensity,

    // ---- DERIVED — recomputed by the sim each tick. Not player-editable.
    /// `FLAG_POWERED | FLAG_WATERED | FLAG_ABANDONED` and nothing else; see
    /// [`DERIVED_FLAG_MASK`].
    pub flags: u8,
    /// Happiness in [0.0, 1.5] matching the TS float range (createInitialState
    /// sets 1.0; the SoA wire buffer quantises this to u8 on output).
    pub happiness: f32,
    /// MW this tile contributes as a power source. A cached copy of the
    /// building's template, keyed by `building_id`; kept as-is so the power BFS
    /// is untouched.
    pub power_plant_mw: i32,
    /// kL/day this tile contributes as a water source. Same story.
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
            terrain: Terrain::Land,
            underground: StratumSet::EMPTY,
            surface: StratumSet::EMPTY,
            overhead: StratumSet::EMPTY,
            building_id: None,
            elevation: 0,
            density: ZoneDensity::Low,
            flags: 0,
            happiness: 1.0,
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
            terrain: Terrain::Water,
            ..Self::land()
        }
    }

    // --- occupant accessors ---
    //
    // `occupants`, `occupants_in`, `has_occupant`, `visible_occupants`,
    // `zone_occupant`, `set_occupant` and `clear_stratum` are in `occupants.rs`.
    // `set_occupant` has to be: it is the sole writer into a stratum set, and
    // the function it delegates to is private to the module that defines those
    // types. The rest follow it so the group stays together.

    /// What the ground is. `Terrain::Land` is exactly the old
    /// `wilderness::is_buildable` (which was `kind != Water`).
    ///
    /// Kept as a method as well as a field so the step-2 call sites read
    /// unchanged.
    #[inline]
    pub fn terrain(&self) -> Terrain {
        self.terrain
    }

    /// Link this tile to a [`crate::buildings::BuildingInstance`], narrowing the
    /// instance's `u32` id to the `u16` the tile persists.
    ///
    /// **The two widths disagree, and since step 3 of #177 that matters more
    /// than it used to.** `next_building_id` counts in `u32`; `building_id` is
    /// the only thing that knows *which* structure stands here, so a truncated
    /// id no longer just bills the wrong ledger row — it resolves through
    /// `occupants::StructureLookup` to another building's template, renders and
    /// scores as that structure, and hands the bulldozer an unrelated lot.
    ///
    /// It is a `debug_assert!` rather than a `Result` because 65 535 buildings
    /// is far beyond what any map this engine builds can hold, and because
    /// there is no sensible thing for a placement to *do* about it. Widening the
    /// persisted field or recycling freed ids is the real fix; both change the
    /// snapshot format, so both belong in their own change.
    #[inline]
    pub fn set_building_id(&mut self, id: u32) {
        debug_assert!(
            id >= 1 && id <= u16::MAX as u32,
            "building id {id} does not fit the u16 `Tile::building_id` persists \
             — the tile would point at {} instead (0 reads as no building on the \
             SoA wire buffer)",
            id as u16
        );
        self.building_id = Some(id as u16);
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

    pub fn set_flag(&mut self, mask: u8, on: bool) {
        debug_assert_eq!(
            mask & !DERIVED_FLAG_MASK,
            0,
            "structural flags are derived from the occupant set, not stored"
        );
        if on {
            self.flags |= mask;
        } else {
            self.flags &= !mask;
        }
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
    /// Tourism dividend — paid when the wilderness score clears its threshold.
    pub revenue_tourism: f32,
    // Expense breakdown
    pub expenses_transport: f32,
    pub expenses_buildings: f32,
    /// Daily cost of active wilderness programmes (Nature Reserve, Green Industry).
    pub expenses_policies: f32,
    // Building expense sub-breakdown
    pub maint_power: f32,
    pub maint_civic: f32,
    pub maint_zones: f32,
    // Transport sub-breakdown
    pub maint_roads: f32,
    pub maint_rail: f32,
    pub maint_power_lines: f32,
    pub maint_pipes: f32,
    // Power plant maintenance by plant type
    pub maint_power_hydro: f32,
    pub maint_power_coal: f32,
    pub maint_power_wind: f32,
    pub maint_power_solar: f32,
    // Civic maintenance by building type
    pub maint_civic_park: f32,
    pub maint_civic_pump: f32,
    pub maint_civic_tower: f32,
    pub maint_civic_school: f32,
    // Zone maintenance by zone class
    pub maint_zones_res: f32,
    pub maint_zones_com: f32,
    pub maint_zones_ind: f32,
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
    /// Sub-dollar treasury accumulator — per-tick accrual is far below $1, so
    /// without this the `as i64` cast froze income for any city with
    /// `net_per_day` under $30 (wasm-sim-audit A4).
    #[serde(default)]
    pub money_frac: f64,
    /// Sub-day clock accumulator. Lives in state (not on `Simulation`) so
    /// snapshot restores — undo and save/load — keep exact sub-day progress.
    #[serde(default)]
    pub day_frac: f64,
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
    /// Every player-adjustable policy family (budget, wilderness, ...).
    /// Budget defaults are neutral (9% taxes, 100% funding), which
    /// reproduces the pre-policy economy bit-for-bit.
    pub policies: Policies,
    /// Wilderness score, trend, and breakdown — recomputed every
    /// `WildernessTunables::recompute_interval_ticks` by the tick loop.
    pub wilderness: WildernessStats,
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
            money_frac: 0.0,
            day_frac: 0.0,
            utilities: UtilityStats::initial(),
            demand: DemandStats::initial(),
            tile_revision: 0,
            next_building_id: 1,
            buildings: Vec::new(),
            education: EducationStats::default(),
            budget: BudgetStats::default(),
            budget_history: VecDeque::new(),
            policies: Policies::default(),
            wilderness: WildernessStats::default(),
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

    /// True once the player has opted into the water system: any pump, water
    /// tower, or underground pipe exists.
    ///
    /// Until then, buildings do not *require* water — the in-game tool card
    /// promises "water is stubbed high until pipes land" — so early cities
    /// grow, stay `Active`, and draw power normally. Water requirements (and
    /// water-use accounting) begin the moment the first piece of water
    /// infrastructure is placed.
    pub fn has_water_system(&self) -> bool {
        self.buildings
            .iter()
            .any(|b| matches!(b.kind, TileKind::WaterPump | TileKind::WaterTower))
            || self.tiles.iter().any(|t| t.has_occupant(Occupant::Pipe))
    }

    pub fn tile_at_mut(&mut self, x: u32, y: u32) -> Option<&mut Tile> {
        self.tile_index(x, y).map(|i| &mut self.tiles[i])
    }

    /// Overwrite untouched `Land` tiles with natural `Water`/`Tree` terrain
    /// from a row-major kind byte array (one `TileKind` u8 per tile).
    ///
    /// Only `Water` and `Tree` are accepted — anything else in the array is
    /// ignored so player-built kinds present in a display snapshot can never
    /// leak into the engine as free construction. Tiles that are no longer
    /// `Land` (already built on) are left alone.
    ///
    /// "No longer `Land`" was `kind != TileKind::Land`, and the question it was
    /// asking is *has anything happened to this cell yet?* — which the strata
    /// answer as bare land carrying nothing you can see. A hydro line is not a
    /// disqualifier: it lived in `FLAG_POWER_OVERLAY` on a `kind = Land` tile,
    /// so a terraformed line has always been seeded straight over. A buried
    /// pipe is not one either, for the same reason.
    pub fn seed_natural_terrain(&mut self, kinds: &[u8]) {
        let n = self.tiles.len().min(kinds.len());
        for (tile, &kind_byte) in self.tiles.iter_mut().zip(kinds.iter()).take(n) {
            let untouched = tile.terrain == Terrain::Land
                && tile.occupants_in(Stratum::Surface) == 0
                && !tile.has_occupant(Occupant::Trees);
            if !untouched {
                continue;
            }
            match TileKind::from_u8(kind_byte) {
                Some(TileKind::Water) => tile.terrain = Terrain::Water,
                Some(TileKind::Tree) => tile.set_occupant(Occupant::Trees, true),
                _ => {}
            }
        }
        self.tile_revision += 1;
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::display::wire_kind_at;
    use crate::migrate::set_v4_kind;

    #[test]
    fn has_water_system_detects_pumps_towers_and_pipes() {
        let mut s = GameState::new(4, 4, 0);
        assert!(!s.has_water_system(), "fresh city has no water system");

        s.tiles[0].set_occupant(Occupant::Pipe, true);
        assert!(s.has_water_system(), "a single pipe opts in");
        s.tiles[0].set_occupant(Occupant::Pipe, false);

        s.buildings.push(crate::buildings::BuildingInstance::new(
            1,
            TileKind::WaterPump,
            (0, 0),
        ));
        assert!(s.has_water_system(), "a pump opts in");
        s.buildings[0].kind = TileKind::WaterTower;
        assert!(s.has_water_system(), "a tower opts in");
        s.buildings[0].kind = TileKind::Residential;
        assert!(!s.has_water_system(), "zones alone do not opt in");
    }

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
        assert!(g
            .tiles
            .iter()
            .all(|t| t.terrain == Terrain::Land && t.occupants() == 0));
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
        set_v4_kind(&mut g.tiles[35], TileKind::Road);
        assert_eq!(wire_kind_at(&g, 5, 3), TileKind::Road);
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
        set_v4_kind(g.tile_at_mut(2, 3).unwrap(), TileKind::Residential);
        assert_eq!(wire_kind_at(&g, 2, 3), TileKind::Residential);
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
        assert_eq!(t.density, ZoneDensity::Low);
    }

    #[test]
    fn zone_density_round_trips() {
        let mut t = Tile::land();
        for &d in &[ZoneDensity::Low, ZoneDensity::Medium, ZoneDensity::High] {
            t.density = d;
            assert_eq!(t.density, d);
        }
    }

    /// Density is a field of its own now rather than flags bits 6–7, so it
    /// cannot collide with the derived flags by construction. Kept as the
    /// regression pin for the old packed representation.
    #[test]
    fn zone_density_does_not_clobber_other_flags() {
        let mut t = Tile::land();
        t.set_flag(FLAG_POWERED, true);
        t.set_flag(FLAG_WATERED, true);
        t.density = ZoneDensity::High;
        assert!(t.is_powered());
        assert!(t.is_watered());
        assert_eq!(t.density, ZoneDensity::High);
    }

    #[test]
    fn rng_is_seeded_from_state_seed() {
        let mut g = GameState::new(4, 4, 0);
        // Just confirm the RNG produces the same first value as SeededRng::new(0).
        let expected = crate::rng::SeededRng::new(0).next_u32();
        assert_eq!(g.rng.next_u32(), expected);
    }
}
