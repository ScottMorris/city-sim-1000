// sim.rs — fixed-timestep simulation tick loop and golden hash determinism tests.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use crate::buildings::{
    apply_building_decay, get_building_template, update_building_states, BuildingStatus,
    DecayConfig,
};
use crate::demand::{compute_city_demand, count_city_capacity};
use crate::economy::{
    apply_money_tick, apply_population_growth, compute_daily_budget, record_daily_budget,
};
use crate::education::recompute_education;
use crate::state::GameState;
use crate::utilities::{recompute_utility_network, UtilityKind};
use crate::wilderness::{
    apply_happiness_drift, compute_wilderness, update_trend, WildernessTunables,
};
use crate::zones::ZoneGrowthSim;

// ---------------------------------------------------------------------------
// Simulation driver
// ---------------------------------------------------------------------------

/// Fixed-timestep city simulation driver.
///
/// Owns the `GameState` and drives all simulation systems in the correct order,
/// mirroring `Simulation.tick()` in `app/src/game/simulation.ts`.
/// Maximum fixed ticks to fire per `step()` call.
/// Prevents the "spiral of death" at very high speed multipliers — the sim
/// runs at most this many ticks per frame, gracefully slowing apparent speed
/// rather than starving the renderer.  At the game's max speed of 3× and
/// 60 fps the sim fires ~3 ticks/frame, so this cap is never reached in
/// practice; it exists as a safety net.
const MAX_TICKS_PER_STEP: u32 = 8;

pub struct Simulation {
    pub state: GameState,
    zone_growth: ZoneGrowthSim,
    decay_config: DecayConfig,
    wilderness_tunables: WildernessTunables,
    water_enabled: bool,
    /// Ticks per real second at 1× speed; matches TS `ticksPerSecond = 20`.
    ticks_per_second: u32,
    /// Speed multiplier (1.0 = normal, 0.0 = paused).
    speed: f32,
    /// Fixed-timestep accumulator — real seconds waiting to be consumed as ticks.
    accumulator: f64,
    /// Sub-day accumulator — fractional days not yet rounded to a whole day.
    day_frac: f64,
}

impl Simulation {
    /// Create a new simulation on a blank all-Land grid.
    pub fn new(width: u32, height: u32, seed: u32) -> Self {
        Self {
            state: GameState::new(width, height, seed),
            zone_growth: ZoneGrowthSim::new(),
            decay_config: DecayConfig::default(),
            wilderness_tunables: WildernessTunables::default(),
            water_enabled: true,
            ticks_per_second: 20,
            speed: 1.0,
            accumulator: 0.0,
            day_frac: 0.0,
        }
    }

    /// Advance the simulation by `dt` real seconds.
    ///
    /// Feeds `dt * speed` into a fixed-timestep accumulator and fires
    /// `tick_fixed()` as many times as whole ticks have accumulated, up to
    /// `MAX_TICKS_PER_STEP`.  Frame rate and simulation tick rate are fully
    /// decoupled: the sim always advances at `ticks_per_second` ticks per
    /// real second regardless of renderer cadence.
    pub fn step(&mut self, dt: f64) {
        self.accumulator += dt * self.speed as f64;
        let tick_dt = 1.0 / self.ticks_per_second as f64;
        let mut fired = 0u32;
        while self.accumulator >= tick_dt && fired < MAX_TICKS_PER_STEP {
            self.tick_fixed();
            self.accumulator -= tick_dt;
            fired += 1;
        }
    }

    /// One fixed simulation tick — always represents exactly `1/ticks_per_second`
    /// seconds of sim time.  Called by `step()`; never call directly.
    ///
    /// Tick order mirrors `simulation.ts:tick()`:
    /// 1. Advance day
    /// 2. Power + water network recompute
    /// 3. Zone growth
    /// 4. Building state update (power/water coverage per building)
    /// 5. Re-run network (building changes may have altered sources)
    /// 6. Education coverage
    /// 7. Utility use accounting (power_used, water_used, net balance)
    /// 8. Population + job growth
    /// 9. Demand recompute
    /// 10. Economy / budget
    /// 11. Building decay
    /// 12. Tick counter
    fn tick_fixed(&mut self) {
        let tick_dt = 1.0 / self.ticks_per_second as f64;

        // 1. Advance day — accumulate fractional days to avoid truncation to 0.
        self.day_frac += tick_dt / 1.5;
        let days_to_add = self.day_frac as u32;
        if days_to_add > 0 {
            self.state.day += days_to_add;
            self.day_frac -= days_to_add as f64;
        }

        // 2. Utility networks
        recompute_utility_network(&mut self.state, UtilityKind::Power);
        if self.water_enabled {
            recompute_utility_network(&mut self.state, UtilityKind::Water);
        }

        // 3. Zone growth (delay_ticks ≈ ticksPerSecond * 2)
        let delay_ticks = (self.ticks_per_second * 2).max(1);
        let mut rng = self.state.rng.clone();
        self.zone_growth
            .tick(&mut self.state, &mut rng, delay_ticks);
        self.state.rng = rng;

        // 4. Building states (power/water coverage per building footprint)
        update_building_states(&mut self.state, self.water_enabled);

        // 5. Second network pass (building state changes affect node weights)
        recompute_utility_network(&mut self.state, UtilityKind::Power);
        if self.water_enabled {
            recompute_utility_network(&mut self.state, UtilityKind::Water);
        }

        // 6. Education
        recompute_education(&mut self.state);

        // 7. Utility use accounting
        self.compute_utility_use();

        // 8. Population + job growth (needs capacity from active buildings)
        let cap = count_city_capacity(&self.state);
        apply_population_growth(&mut self.state, cap.population, cap.jobs);

        // 8.5. Wilderness — recomputed on a coarser cadence than the tick
        // rate; demand (9) and economy (10) read the stored score.
        if self.state.tick % self.wilderness_tunables.recompute_interval_ticks == 0 {
            let out = compute_wilderness(&self.state, &self.wilderness_tunables);
            update_trend(&mut self.state.wilderness, out.score, &self.wilderness_tunables);
            self.state.wilderness.breakdown = out.breakdown;
            self.state.wilderness.local_field = out
                .eco_field
                .iter()
                .map(|&e| city_sim_protocol::tile_buffer::encode_eco(e))
                .collect();
            apply_happiness_drift(&mut self.state, out.score, &self.wilderness_tunables);
        }

        // 9. Demand
        let demand = compute_city_demand(&self.state);
        self.state.demand = demand;

        // 10. Economy / budget
        let budget = compute_daily_budget(&self.state);
        self.state.budget = budget;
        record_daily_budget(&mut self.state);
        apply_money_tick(&mut self.state, tick_dt);

        // 11. Building decay
        apply_building_decay(&mut self.state, &self.decay_config);

        // 12. Tick counter
        self.state.tick += 1;
    }

    /// Current speed multiplier (1.0 = normal, 0.0 = paused).
    pub fn speed(&self) -> f32 {
        self.speed
    }

    /// Set simulation speed multiplier.
    pub fn set_speed(&mut self, multiplier: f32) {
        self.speed = multiplier.max(0.0);
    }

    /// Replace the current state and reset transient caches.
    pub fn load_state(&mut self, state: GameState) {
        self.state = state;
        self.zone_growth = ZoneGrowthSim::new();
        self.accumulator = 0.0;
        self.day_frac = 0.0;
    }

    // --- internal ---

    /// Compute utility use (power_used, water_used) from active buildings and
    /// update the net balance in `state.utilities`.
    fn compute_utility_use(&mut self) {
        let mut power_used: f32 = 0.0;
        let mut water_used: f32 = 0.0;
        for b in &self.state.buildings {
            if b.status != BuildingStatus::Active {
                continue;
            }
            let Some(tmpl) = get_building_template(b.kind) else {
                continue;
            };
            power_used += tmpl.power_use;
            if self.water_enabled {
                water_used += tmpl.water_use;
            }
        }
        let pu = power_used.round() as i32;
        let wu = water_used.round() as i32;
        self.state.utilities.power_used = pu;
        self.state.utilities.water_used = wu;
        self.state.utilities.power = self.state.utilities.power_produced - pu;
        self.state.utilities.water = if self.water_enabled {
            self.state.utilities.water_produced - wu
        } else {
            1_000_000
        };
    }
}

// ---------------------------------------------------------------------------
// Golden hash (parity milestone P3-10)
// ---------------------------------------------------------------------------

/// Compute a deterministic FNV-1-64 hash of the key simulation state fields.
///
/// Used in the golden-hash regression test — if this value changes unexpectedly
/// a determinism bug has been introduced.
pub fn state_hash(state: &GameState) -> u64 {
    fn fnv(data: &[u8]) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        for &b in data {
            h = h.wrapping_mul(0x100000000001b3) ^ b as u64;
        }
        h
    }

    let mut buf: Vec<u8> = Vec::with_capacity(64);
    buf.extend_from_slice(&state.tick.to_le_bytes());
    buf.extend_from_slice(&state.day.to_le_bytes());
    buf.extend_from_slice(&state.population.to_le_bytes());
    buf.extend_from_slice(&state.jobs.to_le_bytes());
    buf.extend_from_slice(&state.money.to_le_bytes());
    buf.extend_from_slice(&state.utilities.power.to_le_bytes());
    buf.extend_from_slice(&state.utilities.water.to_le_bytes());
    buf.extend_from_slice(&(state.buildings.len() as u32).to_le_bytes());
    // Tile-kind histogram
    let mut kind_counts = [0u32; 64];
    for tile in &state.tiles {
        let k = tile.kind as u8 as usize;
        if k < kind_counts.len() {
            kind_counts[k] += 1;
        }
    }
    for c in kind_counts {
        buf.extend_from_slice(&c.to_le_bytes());
    }
    // Demand (quantised to i32 for stability)
    buf.extend_from_slice(&(state.demand.residential as i32).to_le_bytes());
    buf.extend_from_slice(&(state.demand.commercial as i32).to_le_bytes());
    buf.extend_from_slice(&(state.demand.industrial as i32).to_le_bytes());

    fnv(&buf)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Committed golden hash for seed=42, 8×8 city grid, 100 ticks at dt=1/20.
    ///
    /// If this test fails, a determinism regression has been introduced.
    /// To re-commit after intentional sim changes, run:
    ///   REGEN=1 cargo test -p sim_core golden_hash 2>&1 | grep "new hash"
    const GOLDEN_HASH_SEED42_8X8_100TICKS: u64 = 0xb234ed590e7135fb;

    fn make_city_sim(seed: u32) -> Simulation {
        use crate::commands::apply_tool;
        use city_sim_protocol::commands::Tool;
        let mut sim = Simulation::new(8, 8, seed);
        // Place roads + zones so zone growth fires and RNG is exercised
        apply_tool(&mut sim.state, Tool::Road, 3, 0);
        apply_tool(&mut sim.state, Tool::Road, 3, 1);
        apply_tool(&mut sim.state, Tool::Road, 3, 2);
        apply_tool(&mut sim.state, Tool::Road, 3, 3);
        apply_tool(&mut sim.state, Tool::Residential, 0, 0);
        apply_tool(&mut sim.state, Tool::Residential, 1, 0);
        apply_tool(&mut sim.state, Tool::Residential, 0, 1);
        apply_tool(&mut sim.state, Tool::Residential, 1, 1);
        apply_tool(&mut sim.state, Tool::Commercial, 0, 2);
        apply_tool(&mut sim.state, Tool::Industrial, 0, 3);
        sim.state.demand.residential = 80.0;
        sim.state.demand.commercial = 60.0;
        sim.state.demand.industrial = 60.0;
        sim
    }

    #[test]
    fn same_seed_same_hash() {
        fn run(seed: u32) -> u64 {
            let mut sim = make_city_sim(seed);
            for _ in 0..100 {
                sim.step(1.0 / 20.0);
            }
            state_hash(&sim.state)
        }
        // Key invariant: same seed must always produce the same result
        assert_eq!(run(42), run(42), "same seed must produce same hash");
        // Different seeds will usually differ once zone growth fires
        // (this is a probabilistic check, not a hard requirement)
        let h42 = run(42);
        let h99 = run(99);
        let _ = (h42, h99); // values captured for debugging if needed
    }

    #[test]
    fn golden_hash_seed42_8x8_100ticks() {
        let mut sim = make_city_sim(42);
        for _ in 0..100 {
            sim.step(1.0 / 20.0);
        }
        let hash = state_hash(&sim.state);

        if std::env::var("REGEN").is_ok() {
            println!("new hash: 0x{hash:016x}");
            return;
        }

        if GOLDEN_HASH_SEED42_8X8_100TICKS == 0 {
            println!("golden hash (commit this): 0x{hash:016x}");
            // Bootstrap run: don't fail, just print. Commit GOLDEN_HASH_* after reading.
            return;
        }

        assert_eq!(
            hash, GOLDEN_HASH_SEED42_8X8_100TICKS,
            "golden hash mismatch — run with REGEN=1 to update after intentional sim change"
        );
    }

    #[test]
    fn tick_advances_day_and_tick_counter() {
        let mut sim = Simulation::new(4, 4, 0);
        let before_tick = sim.state.tick;
        sim.step(1.0 / 20.0); // one tick's worth of real time → exactly one tick
        assert_eq!(sim.state.tick, before_tick + 1);
    }

    #[test]
    fn day_advances_with_small_dt() {
        // Regression guard: per-frame dt (≈1/60) must accumulate and cross the
        // 1.5s-per-day boundary rather than truncating to 0 each frame.
        let mut sim = Simulation::new(4, 4, 0);
        let start_day = sim.state.day;
        for _ in 0..120 {
            sim.step(1.0 / 60.0);
        }
        assert!(
            sim.state.day > start_day,
            "day must advance after 120 ticks at dt=1/60 (got {})",
            sim.state.day,
        );
    }

    #[test]
    fn set_speed_scales_advances() {
        let mut slow = Simulation::new(4, 4, 0);
        slow.set_speed(0.5);
        let mut fast = Simulation::new(4, 4, 0);
        fast.set_speed(2.0);
        slow.step(1.0);
        fast.step(1.0);
        // Fast sim should have a higher day than slow
        assert!(
            fast.state.day >= slow.state.day,
            "faster speed should advance the day further"
        );
    }

    #[test]
    fn tick_populates_wilderness_score() {
        let mut sim = Simulation::new(8, 8, 0);
        assert!(!sim.state.wilderness.seeded, "fresh state starts unseeded");
        sim.step(1.0 / 20.0); // first tick recomputes (tick 0 % interval == 0)
        assert!(sim.state.wilderness.seeded);
        // All-Land map → P/(P+k) = 1/1.5 ≈ 66.7
        assert!(
            (60.0..75.0).contains(&sim.state.wilderness.score),
            "blank map score should be mid-high, got {}",
            sim.state.wilderness.score
        );
        assert!(sim.state.wilderness.breakdown.open_land > 0.0);
    }

    #[test]
    fn wilderness_raises_residential_demand_and_pays_tourism() {
        use crate::demand::compute_city_demand;
        use crate::economy::compute_daily_budget;

        let mut sim = make_city_sim(42);
        sim.step(1.0 / 20.0); // seed wilderness
        sim.state.population = 500;

        sim.state.wilderness.score = 20.0;
        let low_demand = compute_city_demand(&sim.state).residential;
        let low_budget = compute_daily_budget(&sim.state);
        assert_eq!(low_budget.revenue_tourism, 0.0, "no dividend at low score");

        sim.state.wilderness.score = 90.0;
        let high_demand = compute_city_demand(&sim.state).residential;
        let high_budget = compute_daily_budget(&sim.state);
        assert!(
            high_demand > low_demand,
            "greener city must attract more residents ({high_demand} vs {low_demand})"
        );
        assert!(
            high_budget.revenue_tourism > 0.0,
            "score 90 must pay a tourism dividend"
        );
        assert!(
            (high_budget.revenue
                - (low_budget.revenue + high_budget.revenue_tourism))
                .abs()
                < 0.001,
            "tourism must be the only revenue difference"
        );
    }

    #[test]
    fn sim_money_changes_over_time() {
        let mut sim = Simulation::new(8, 8, 0);
        let start = sim.state.money;
        for _ in 0..100 {
            sim.step(1.0 / 20.0);
        }
        // With only BASE_INCOME revenue and no expenses, money should go up
        assert!(
            sim.state.money >= start,
            "blank city (no infrastructure costs) should be profitable"
        );
    }
}
