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
use city_sim_protocol::events::{AlertKind, SimAlert};

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
    /// Fixed-timestep accumulator — real seconds waiting to be consumed as
    /// ticks. Real-time (not sim-time), so it stays on the driver; sim-time
    /// accumulators (`day_frac`, `money_frac`) live in `GameState` instead so
    /// snapshot restores are exact.
    accumulator: f64,
    /// Edge-triggered hysteresis latches for the deficit alerts below — set
    /// the tick the balance is decided negative, cleared the tick it recovers,
    /// so a balance sitting at exactly the boundary doesn't re-fire every tick.
    power_deficit_active: bool,
    water_deficit_active: bool,
    /// Alerts raised since the last `take_alerts()` call. A `Vec` rather than
    /// firing a callback directly: `step()` can run several `tick_fixed()`s
    /// per call (see `MAX_TICKS_PER_STEP`), and both hosts drain this once per
    /// external step/tick rather than per fixed tick, so none can be dropped.
    pending_alerts: Vec<SimAlert>,
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
            power_deficit_active: false,
            water_deficit_active: false,
            pending_alerts: Vec::new(),
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
        // The accumulator lives in `GameState` so snapshot restores are exact.
        self.state.day_frac += tick_dt / 1.5;
        let days_to_add = self.state.day_frac as u32;
        if days_to_add > 0 {
            self.state.day += days_to_add;
            self.state.day_frac -= days_to_add as f64;
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

        // 4. Building states (power/water coverage per building footprint).
        // Water requirements are opt-in: until the first pump/tower/pipe
        // exists, buildings don't need water ("stubbed high until pipes
        // land"), so a young city's power draw behaves normally instead of
        // every zone sitting at `InactiveNoWater` drawing nothing.
        let water_active = self.water_enabled && self.state.has_water_system();
        update_building_states(&mut self.state, water_active);

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
        if self
            .state
            .tick
            .is_multiple_of(self.wilderness_tunables.recompute_interval_ticks)
        {
            let tunables = self
                .wilderness_tunables
                .effective(&self.state.policies.wilderness);
            let out = compute_wilderness(&self.state, &tunables);
            update_trend(
                &mut self.state.wilderness,
                out.score,
                &self.wilderness_tunables,
            );
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

    /// Replace the current state and reset transient caches. Sim-time
    /// accumulators (`day_frac`, `money_frac`) travel inside `GameState`, so
    /// a restore continues the clock and treasury exactly.
    pub fn load_state(&mut self, state: GameState) {
        // Resync the deficit latches to the loaded balance without alerting —
        // this is a restore, not a live transition, and a save can easily
        // load into an already-negative balance.
        self.power_deficit_active = state.utilities.power < 0;
        self.water_deficit_active = self.water_enabled && state.utilities.water < 0;
        self.pending_alerts.clear();
        self.state = state;
        self.zone_growth = ZoneGrowthSim::new();
        self.accumulator = 0.0;

        // `utility_networks` is `#[serde(skip)]` (`#230`) — a restored
        // `GameState` carries the scalar `utilities` totals it was saved
        // with, but its component breakdown decoded to empty. Recompute it
        // here rather than waiting for the next `tick_fixed()`: while paused
        // (`speed == 0`), that tick may never come, leaving
        // `powerComponents`/`waterComponents` empty indefinitely after a
        // load/undo/redo even though the aggregate figures are already
        // correct. `recompute_utility_network` also rewrites
        // `power`/`water`/`*_produced` and zeroes `*_used` as its usual
        // "start clean for this tick" contract — preserve the `*_used` the
        // snapshot was saved with and rebuild the net balance from it
        // afterward, so a load doesn't transiently show zero consumption
        // until the next tick's `compute_utility_use()` corrects it.
        let power_used = self.state.utilities.power_used;
        let water_used = self.state.utilities.water_used;
        recompute_utility_network(&mut self.state, UtilityKind::Power);
        if self.water_enabled {
            recompute_utility_network(&mut self.state, UtilityKind::Water);
        }
        self.state.utilities.power_used = power_used;
        self.state.utilities.water_used = water_used;
        self.state.utilities.power = self.state.utilities.power_produced - power_used;
        self.state.utilities.water = if self.water_enabled {
            self.state.utilities.water_produced - water_used
        } else {
            1_000_000
        };
    }

    /// Drain and return alerts raised since the last call. Both hosts call
    /// this once per external step/tick to forward to their UI transport.
    pub fn take_alerts(&mut self) -> Vec<SimAlert> {
        std::mem::take(&mut self.pending_alerts)
    }

    // --- internal ---

    /// Compute utility use (power_used, water_used) from active buildings and
    /// update the net balance in `state.utilities`.
    fn compute_utility_use(&mut self) {
        // Mirrors the building-state gate above: no water system yet means
        // water use is stubbed to zero, not accumulated into a deficit.
        let water_active = self.water_enabled && self.state.has_water_system();
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
            let wu = if water_active { tmpl.water_use } else { 0.0 };
            water_used += wu;

            // Attribute this draw to the component its origin tile is
            // labelled with — fresh from this tick's step-5 recompute, which
            // ran before this pass. `state.buildings` (read above) and
            // `state.utility_networks` (mutated here) are disjoint fields,
            // so no borrow conflict requires collecting draws separately. An
            // Active building is by definition powered, so its origin is
            // labelled; `label == 0` only fires if that invariant is ever
            // violated, and is a silent no-op rather than a panic.
            if let Some(idx) = self.state.tile_index(b.origin.0, b.origin.1) {
                if let Some(&label) = self.state.utility_networks.power_labels.get(idx) {
                    if label != 0 {
                        self.state.utility_networks.power_components[(label - 1) as usize].used +=
                            tmpl.power_use;
                    }
                }
                if water_active {
                    if let Some(&label) = self.state.utility_networks.water_labels.get(idx) {
                        if label != 0 {
                            self.state.utility_networks.water_components[(label - 1) as usize]
                                .used += wu;
                        }
                    }
                }
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

        self.handle_resource_alerts();
    }

    /// Edge-triggered power/water deficit alerts — ported from the deleted TS
    /// oracle's `handleResourceAlerts` (`git show 1f8140a:app/src/game/simulation.ts:742-812`),
    /// now the sole producer since neither host re-derives this state machine.
    fn handle_resource_alerts(&mut self) {
        let power_balance = self.state.utilities.power;
        if power_balance < 0 && !self.power_deficit_active {
            self.power_deficit_active = true;
            self.pending_alerts.push(SimAlert {
                kind: AlertKind::PowerDeficit,
                message:
                    "Power deficit detected. Build more plants or reduce demand to restore growth."
                        .into(),
                sticky: true,
            });
        } else if power_balance >= 0 && self.power_deficit_active {
            self.power_deficit_active = false;
            self.pending_alerts.push(SimAlert {
                kind: AlertKind::PowerRestored,
                message: "Power restored. Zones can grow again.".into(),
                sticky: false,
            });
        }

        if !self.water_enabled {
            return;
        }
        let water_balance = self.state.utilities.water;
        if water_balance < 0 && !self.water_deficit_active {
            self.water_deficit_active = true;
            self.pending_alerts.push(SimAlert {
                kind: AlertKind::WaterDeficit,
                message: "Water deficit detected. Add pumps/towers or cut usage.".into(),
                sticky: true,
            });
        } else if water_balance >= 0 && self.water_deficit_active {
            self.water_deficit_active = false;
            self.pending_alerts.push(SimAlert {
                kind: AlertKind::WaterRestored,
                message: "Water restored. Supply is stable again.".into(),
                sticky: false,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Golden hash (parity milestone P3-10)
// ---------------------------------------------------------------------------

/// Compute a deterministic FNV-1-64 hash of the key simulation state fields.
///
/// Used in the golden-hash regression test — if this value changes unexpectedly
/// a determinism bug has been introduced. `history.rs` also asserts undo/redo
/// fidelity with it, and `snapshot_restore_is_deterministic` below asserts the
/// postcard round trip with it, which makes this function the oracle three
/// separate suites trust to notice when a tile changed.
///
/// **It has to see the tile, then, and not just a census of `kind`.** Until
/// step 2 of #177 the whole grid entered the hash as a one-byte kind histogram
/// and nothing else, so two states differing by a structural flag —
/// `FLAG_POWER_OVERLAY` on a `kind = Land` tile, which is every hydro line the
/// player has terraformed under — hashed identically, at
/// `0x6d3ea3b9c3ab333a` both, despite differing in `tile_upkeep_unfunded` and
/// in `conducts(Network::Power)`. An undo, or a snapshot, that silently
/// dropped the road, rail or power flags passed every one of those tests. The
/// histogram was blind to position as well: swap a `Water` tile for a `Land`
/// one somewhere else and the counts are unchanged.
///
/// So the grid now enters tile by tile, in index order — deterministic, and
/// identical across a snapshot boundary because `tiles` is a `Vec` in
/// row-major order, never a set. Per tile:
///
/// - `terrain`, `Land` or `Water` — the one authored field a wire `kind` byte
///   used to carry incidentally (`kind = Water` always won the byte), now
///   hashed directly since there is no more derived byte to carry it;
/// - [`Tile::occupants`], what actually stands there — the union of the three
///   strata, which is what keeps this hash stable across the tile gaining
///   three fields. Deliberately the occupant
///   set rather than the raw `flags` byte: the two spellings one physical tile
///   used to have hash alike;
/// - `building_id`, so a tile losing its link to a live `BuildingInstance` is
///   visible — the state defect B of this pass was about.
///
/// No `StructureLookup`, no wire `kind`/`underground` bytes — both were
/// derived from `occupants()`/`terrain` and `building_id` alone
/// (`display.rs`'s deletion, #177's TS/wire follow-up). **`building_id`
/// alone is not enough**, though: it names *which* `BuildingInstance` sits
/// on a tile, not what that instance *is*. Two states differing only in a
/// stable id's own `BuildingInstance::kind` — a `Park` swapped for a
/// `CoalPlant` behind the same `building_id`, nothing else touched — hashed
/// identically until the fix below, exactly the class of silent corruption
/// this function exists to catch. So `state.buildings` is hashed too, one
/// `(id, kind)` pair per instance, in the `Vec`'s own push order — stable
/// because buildings are only ever appended or removed via `retain`, never
/// reordered.
///
/// The derived flags — `FLAG_POWERED`, `FLAG_WATERED`, `FLAG_ABANDONED` and
/// the zone density bits — stay out on purpose. They are recomputed from the
/// grid each tick, so hashing them would report a difference that the next
/// step erases by itself.
pub fn state_hash(state: &GameState) -> u64 {
    fn fnv(data: &[u8]) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        for &b in data {
            h = h.wrapping_mul(0x100000000001b3) ^ b as u64;
        }
        h
    }

    let mut buf: Vec<u8> = Vec::with_capacity(64 + state.tiles.len() * 5);
    buf.extend_from_slice(&state.tick.to_le_bytes());
    buf.extend_from_slice(&state.day.to_le_bytes());
    buf.extend_from_slice(&state.population.to_le_bytes());
    buf.extend_from_slice(&state.jobs.to_le_bytes());
    buf.extend_from_slice(&state.money.to_le_bytes());
    buf.extend_from_slice(&state.utilities.power.to_le_bytes());
    buf.extend_from_slice(&state.utilities.water.to_le_bytes());
    buf.extend_from_slice(&(state.buildings.len() as u32).to_le_bytes());
    // Grid shape, so a 4×16 city and a 16×4 one with the same tile vector are
    // not the same state.
    buf.extend_from_slice(&state.width.to_le_bytes());
    buf.extend_from_slice(&state.height.to_le_bytes());
    // The grid, tile by tile in index order.
    for tile in &state.tiles {
        buf.push(tile.terrain as u8);
        buf.extend_from_slice(&tile.occupants().to_le_bytes());
        buf.extend_from_slice(&tile.building_id.unwrap_or(u16::MAX).to_le_bytes());
    }
    // Buildings, in push order — see the doc comment above for why
    // `building_id` on the grid isn't enough on its own.
    for building in &state.buildings {
        buf.extend_from_slice(&building.id.to_le_bytes());
        buf.push(building.kind as u8);
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
    ///
    /// Re-cut in step 2 of #177: [`state_hash`] stopped reducing the grid to a
    /// histogram of `kind` and started hashing each tile's occupant set,
    /// `underground` and `building_id`, so the same city hashes to a new — and
    /// far more discriminating — value.
    ///
    /// Re-cut again for #177's TS/wire follow-up: `state_hash` dropped the
    /// derived wire `kind`/`underground` bytes (the functions producing them
    /// were deleted) in favour of hashing `terrain` directly — see the
    /// doc comment on [`state_hash`] for what that trades away and keeps.
    const GOLDEN_HASH_SEED42_8X8_100TICKS: u64 = 0xf0e59d797cc623c6;

    fn make_city_sim(seed: u32) -> Simulation {
        use crate::commands::apply_tool;
        use city_sim_protocol::commands::{Tool, ViewStratum};
        let mut sim = Simulation::new(8, 8, seed);
        // Place roads + zones so zone growth fires and RNG is exercised
        apply_tool(&mut sim.state, Tool::Road, 3, 0, ViewStratum::Surface);
        apply_tool(&mut sim.state, Tool::Road, 3, 1, ViewStratum::Surface);
        apply_tool(&mut sim.state, Tool::Road, 3, 2, ViewStratum::Surface);
        apply_tool(&mut sim.state, Tool::Road, 3, 3, ViewStratum::Surface);
        apply_tool(
            &mut sim.state,
            Tool::Residential,
            0,
            0,
            ViewStratum::Surface,
        );
        apply_tool(
            &mut sim.state,
            Tool::Residential,
            1,
            0,
            ViewStratum::Surface,
        );
        apply_tool(
            &mut sim.state,
            Tool::Residential,
            0,
            1,
            ViewStratum::Surface,
        );
        apply_tool(
            &mut sim.state,
            Tool::Residential,
            1,
            1,
            ViewStratum::Surface,
        );
        apply_tool(&mut sim.state, Tool::Commercial, 0, 2, ViewStratum::Surface);
        apply_tool(&mut sim.state, Tool::Industrial, 0, 3, ViewStratum::Surface);
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

    /// The hole step 2 of #177 found in the oracle itself: the grid used to
    /// enter [`state_hash`] as a one-byte histogram of `kind`, so a structural
    /// flag was invisible to it. Two states differing only by
    /// `FLAG_POWER_OVERLAY` on a `kind = Land` tile hashed the same
    /// (`0x6d3ea3b9c3ab333a` both) even though one billed `MAINT_POWER_LINE`
    /// every day and conducted power and the other did neither — so an undo or
    /// a snapshot round trip that dropped the flag passed silently.
    ///
    /// Since step 3 those flags are occupant bits, and the tiles below are
    /// built by setting the bit rather than the flag. The question is the same
    /// one: a tile carrying a road, a rail or a line must not hash like bare
    /// land. `underground` and `building_id` follow.
    #[test]
    fn a_structural_occupant_changes_the_hash() {
        use crate::occupants::Occupant;
        use city_sim_protocol::tile_kind::TileKind;

        let base = Simulation::new(4, 4, 1);
        let base_hash = state_hash(&base.state);

        for occupant in [Occupant::Road, Occupant::Rail, Occupant::PowerLine] {
            let mut other = Simulation::new(4, 4, 1);
            other.state.tiles[5].set_occupant(occupant, true);
            assert_ne!(
                state_hash(&other.state),
                base_hash,
                "{occupant:?} on a Land tile is invisible to the hash"
            );
        }

        // The same for the two tile fields the occupant set cannot fully
        // report: a buried pipe, and the link to a live building.
        let mut piped = Simulation::new(4, 4, 1);
        piped.state.tiles[5].set_occupant(Occupant::Pipe, true);
        assert_ne!(state_hash(&piped.state), base_hash, "a buried pipe");

        let mut built = Simulation::new(4, 4, 1);
        built.state.tiles[5].building_id = Some(7);
        assert_ne!(state_hash(&built.state), base_hash, "a building link");

        // And position, which a histogram of `kind` cannot see: the same two
        // kinds, swapped between two tiles, is a different city.
        let mut moved = Simulation::new(4, 4, 1);
        crate::migrate::set_v4_kind(&mut moved.state.tiles[5], TileKind::Water);
        crate::migrate::set_v4_kind(&mut moved.state.tiles[6], TileKind::Land);
        let mut swapped = Simulation::new(4, 4, 1);
        crate::migrate::set_v4_kind(&mut swapped.state.tiles[5], TileKind::Land);
        crate::migrate::set_v4_kind(&mut swapped.state.tiles[6], TileKind::Water);
        assert_ne!(
            state_hash(&moved.state),
            state_hash(&swapped.state),
            "a kind histogram cannot tell two layouts apart"
        );
    }

    /// `building_id` alone names *which* instance a tile is linked to, not
    /// what that instance *is* — so a hash built only from the grid cannot
    /// tell a `Park` from a `CoalPlant` behind the same stable id. Caught by
    /// review during the tile-model migration: two states differing only in
    /// `BuildingInstance::kind`, same `id`, same tile link, used to hash
    /// identically.
    #[test]
    fn a_buildings_kind_changes_the_hash_even_behind_a_stable_id() {
        use crate::buildings::BuildingInstance;
        use city_sim_protocol::tile_kind::TileKind;

        let mut park = Simulation::new(4, 4, 1);
        park.state.tiles[5].building_id = Some(7);
        park.state
            .buildings
            .push(BuildingInstance::new(7, TileKind::Park, (1, 1)));

        let mut plant = Simulation::new(4, 4, 1);
        plant.state.tiles[5].building_id = Some(7);
        plant
            .state
            .buildings
            .push(BuildingInstance::new(7, TileKind::CoalPlant, (1, 1)));

        assert_ne!(
            state_hash(&park.state),
            state_hash(&plant.state),
            "the same building_id resolving to a different BuildingInstance::kind must not hash alike"
        );
    }

    /// The determinism guarantee the snapshot-stack undo system rests on:
    /// restoring a snapshot puts the sim back on the identical deterministic
    /// path, so a restored city stepped forward matches the live run exactly.
    #[test]
    fn snapshot_restore_is_deterministic() {
        let mut live = make_city_sim(42);
        for _ in 0..50 {
            live.step(1.0 / 20.0);
        }
        let bytes = crate::snapshot::to_bytes(&live.state).expect("snapshot encodes");
        for _ in 0..100 {
            live.step(1.0 / 20.0);
        }

        let mut restored = Simulation::new(8, 8, 42);
        restored.load_state(crate::snapshot::from_bytes(&bytes).expect("snapshot decodes"));
        for _ in 0..100 {
            restored.step(1.0 / 20.0);
        }

        assert_eq!(
            state_hash(&restored.state),
            state_hash(&live.state),
            "a restored snapshot must continue on the identical deterministic path"
        );
    }

    /// The "stubbed high until pipes land" rule: buildings must not require
    /// water before the player has placed any water infrastructure — a young
    /// city's zones stay `Active` and draw power normally. Placing the first
    /// pump opts the city into the water system and unwatered zones start
    /// requiring it.
    #[test]
    fn water_requirement_is_opt_in_until_infrastructure_exists() {
        use crate::buildings::BuildingStatus;
        use crate::commands::apply_tool;
        use city_sim_protocol::commands::{Tool, ViewStratum};
        use city_sim_protocol::tile_kind::TileKind;

        let mut sim = Simulation::new(16, 16, 42);
        for x in 0..12 {
            apply_tool(&mut sim.state, Tool::Road, x, 5, ViewStratum::Surface);
        }
        apply_tool(&mut sim.state, Tool::CoalPlant, 0, 3, ViewStratum::Surface);
        for x in 2..10 {
            apply_tool(
                &mut sim.state,
                Tool::Residential,
                x,
                4,
                ViewStratum::Surface,
            );
            apply_tool(
                &mut sim.state,
                Tool::Residential,
                x,
                6,
                ViewStratum::Surface,
            );
        }
        sim.state.demand.residential = 90.0;
        for _ in 0..300 {
            sim.step(1.0 / 20.0);
        }

        let zone_statuses: Vec<BuildingStatus> = sim
            .state
            .buildings
            .iter()
            .filter(|b| b.kind == TileKind::Residential)
            .map(|b| b.status)
            .collect();
        assert!(!zone_statuses.is_empty(), "zones should have grown");
        assert!(
            zone_statuses
                .iter()
                .all(|s| *s != BuildingStatus::InactiveNoWater),
            "no water system exists yet — water must not be required"
        );
        assert!(
            sim.state.utilities.power_used > 0,
            "active zones must draw power (the frozen-meter bug)"
        );

        // Opting in: a pump far from the zones activates the requirement.
        apply_tool(
            &mut sim.state,
            Tool::WaterPump,
            13,
            13,
            ViewStratum::Surface,
        );
        for _ in 0..5 {
            sim.step(1.0 / 20.0);
        }
        assert!(
            sim.state
                .buildings
                .iter()
                .any(|b| b.kind == TileKind::Residential
                    && b.status == BuildingStatus::InactiveNoWater),
            "with a water system present, unwatered zones require water again"
        );
    }

    /// The issue's headline defect (`#230`): a segment can be locally
    /// starved — its own consumption exceeds its own production — while the
    /// pooled city-wide balance still reads as a healthy surplus, because
    /// the old aggregate had no notion of "which segment" at all.
    #[test]
    fn a_starved_segment_is_invisible_to_the_pooled_city_balance() {
        use crate::buildings::{BuildingInstance, BuildingStatus};
        use crate::migrate::set_v4_kind;
        use city_sim_protocol::tile_kind::TileKind;

        let mut sim = Simulation::new(14, 2, 1);
        {
            let s = &mut sim.state;

            // Segment A: an 80 MW coal plant with no consumers — pure surplus.
            for dy in 0..2 {
                for dx in 0..2 {
                    let t = s.tile_at_mut(dx, dy).unwrap();
                    t.power_plant_mw = 80;
                    t.building_id = Some(1);
                }
            }
            s.buildings.push({
                let mut b = BuildingInstance::new(1, TileKind::CoalPlant, (0, 0));
                b.status = BuildingStatus::Active;
                b
            });

            // (3,0)/(4,0) stay plain Land — breaks the chain into two segments.

            // Segment B: an 8 MW wind turbine feeding six 1.5 MW residential
            // zones (9 MW drawn) — starved on its own, unrelated to A.
            for dy in 0..2 {
                for dx in 0..2 {
                    let t = s.tile_at_mut(5 + dx, dy).unwrap();
                    t.power_plant_mw = 8;
                    t.building_id = Some(2);
                }
            }
            s.buildings.push({
                let mut b = BuildingInstance::new(2, TileKind::WindTurbine, (5, 0));
                b.status = BuildingStatus::Active;
                b
            });
            set_v4_kind(s.tile_at_mut(7, 0).unwrap(), TileKind::Road);
            for (i, x) in (8..14).enumerate() {
                set_v4_kind(s.tile_at_mut(x, 0).unwrap(), TileKind::Residential);
                let id = 10 + i as u32;
                s.tile_at_mut(x, 0).unwrap().building_id = Some(id as u16);
                s.buildings.push({
                    let mut b = BuildingInstance::new(id, TileKind::Residential, (x, 0));
                    b.status = BuildingStatus::Active;
                    b
                });
            }
        }

        recompute_utility_network(&mut sim.state, UtilityKind::Power);
        sim.compute_utility_use();

        assert!(
            sim.state.utilities.power > 0,
            "the pooled city-wide balance reads as a surplus"
        );

        let components = sim.state.utility_networks.components(UtilityKind::Power);
        assert_eq!(components.len(), 2, "two disconnected segments");

        let starved = components
            .iter()
            .find(|c| c.produced.round() as i32 == 8)
            .expect("segment B (the wind turbine) is in the component list");
        assert!(
            starved.used > starved.produced,
            "segment B alone is in deficit: {} used vs {} produced",
            starved.used,
            starved.produced
        );
        assert_eq!(starved.utilization(), 1.0);

        let surplus = components
            .iter()
            .find(|c| c.produced.round() as i32 == 80)
            .expect("segment A (the coal plant) is in the component list");
        assert_eq!(surplus.used, 0.0, "segment A has no consumers of its own");
    }

    /// Mutation-testing gap: the power half of `compute_utility_use`'s
    /// draw-attribution loop is exercised above, but nothing previously ran
    /// an `Active`, water-consuming building through the water half, so a
    /// `cargo-mutants` pass over this PR's diff found the `+=`/`label - 1`
    /// arithmetic there could be broken without any test failing.
    #[test]
    fn water_consumption_is_summed_and_attributed_to_its_component() {
        use crate::buildings::{BuildingInstance, BuildingStatus};
        use crate::migrate::set_v4_kind;
        use crate::occupants::Occupant;
        use city_sim_protocol::tile_kind::TileKind;

        let mut sim = Simulation::new(3, 1, 1);
        {
            let s = &mut sim.state;
            s.tile_at_mut(0, 0).unwrap().water_output = 50;
            set_v4_kind(s.tile_at_mut(0, 0).unwrap(), TileKind::WaterPump);
            s.tile_at_mut(0, 0).unwrap().building_id = Some(1);
            s.buildings.push({
                let mut b = BuildingInstance::new(1, TileKind::WaterPump, (0, 0));
                b.status = BuildingStatus::Active;
                b
            });
            s.tile_at_mut(1, 0)
                .unwrap()
                .set_occupant(Occupant::Pipe, true);
            set_v4_kind(s.tile_at_mut(2, 0).unwrap(), TileKind::Residential);
            s.tile_at_mut(2, 0).unwrap().building_id = Some(2);
            s.buildings.push({
                let mut b = BuildingInstance::new(2, TileKind::Residential, (2, 0));
                b.status = BuildingStatus::Active;
                b
            });
        }

        recompute_utility_network(&mut sim.state, UtilityKind::Water);
        sim.compute_utility_use();

        assert_eq!(
            sim.state.utilities.water_used, 1,
            "one Residential zone draws its template's water_use (1.0)"
        );
        let components = sim.state.utility_networks.components(UtilityKind::Water);
        assert_eq!(components.len(), 1);
        assert_eq!(components[0].used, 1.0);
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
            (high_budget.revenue - (low_budget.revenue + high_budget.revenue_tourism)).abs()
                < 0.001,
            "tourism must be the only revenue difference"
        );
    }

    #[test]
    fn power_deficit_alert_fires_once_and_clears_on_recovery() {
        let mut sim = Simulation::new(4, 4, 1);
        sim.state.utilities.power = -5;
        sim.handle_resource_alerts();
        let alerts = sim.take_alerts();
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].kind, AlertKind::PowerDeficit);
        assert!(alerts[0].sticky);

        // Still negative — must not re-fire every tick.
        sim.handle_resource_alerts();
        assert!(sim.take_alerts().is_empty());

        sim.state.utilities.power = 3;
        sim.handle_resource_alerts();
        let alerts = sim.take_alerts();
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].kind, AlertKind::PowerRestored);
        assert!(!alerts[0].sticky);
    }

    /// A balance of exactly zero is not a deficit, and is the exact threshold
    /// a recovery reads as "restored" — pins the boundary on both sides of
    /// the `< 0` / `>= 0` comparisons in `handle_resource_alerts`.
    #[test]
    fn power_deficit_boundary_is_strictly_negative() {
        let mut sim = Simulation::new(4, 4, 1);
        sim.state.utilities.power = 0;
        sim.handle_resource_alerts();
        assert!(
            sim.take_alerts().is_empty(),
            "zero balance must not read as a deficit"
        );

        sim.state.utilities.power = -1;
        sim.handle_resource_alerts();
        let alerts = sim.take_alerts();
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].kind, AlertKind::PowerDeficit);

        sim.state.utilities.power = 0;
        sim.handle_resource_alerts();
        let alerts = sim.take_alerts();
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].kind, AlertKind::PowerRestored);
    }

    /// Same boundary as `power_deficit_boundary_is_strictly_negative`, for
    /// water — plus proves the deficit latch actually suppresses a second
    /// fire while still negative (catches the `!` in
    /// `!self.water_deficit_active` being dropped).
    #[test]
    fn water_deficit_boundary_and_no_refire_while_active() {
        let mut sim = Simulation::new(4, 4, 1);
        assert!(sim.water_enabled);

        sim.state.utilities.water = 0;
        sim.handle_resource_alerts();
        assert!(
            sim.take_alerts().is_empty(),
            "zero balance must not read as a deficit"
        );

        sim.state.utilities.water = -1;
        sim.handle_resource_alerts();
        let alerts = sim.take_alerts();
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].kind, AlertKind::WaterDeficit);

        // Still negative and already active — must not re-fire.
        sim.handle_resource_alerts();
        assert!(sim.take_alerts().is_empty());

        sim.state.utilities.water = 0;
        sim.handle_resource_alerts();
        let alerts = sim.take_alerts();
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].kind, AlertKind::WaterRestored);
    }

    #[test]
    fn water_deficit_alert_respects_water_enabled_gate() {
        let mut sim = Simulation::new(4, 4, 1);
        sim.water_enabled = false;
        sim.state.utilities.water = -10;
        sim.handle_resource_alerts();
        assert!(
            sim.take_alerts().is_empty(),
            "water alerts must not fire while water_enabled is false"
        );
    }

    /// `#230` regression: `utility_networks` is `#[serde(skip)]`, so a
    /// restored `GameState` always decodes with it empty. `load_state` must
    /// repopulate it immediately rather than waiting for the next
    /// `tick_fixed()` — which may never come while paused — and must not
    /// clobber the `*_used`/net-balance figures the snapshot was saved with
    /// in the process (`recompute_utility_network` zeroes `*_used` as its
    /// usual "start clean for this tick" contract).
    #[test]
    fn load_state_repopulates_utility_networks_without_clobbering_used() {
        use crate::buildings::{BuildingInstance, BuildingStatus};
        use crate::migrate::set_v4_kind;
        use city_sim_protocol::tile_kind::TileKind;

        let mut sim = Simulation::new(3, 1, 1);
        {
            let s = &mut sim.state;
            s.tile_at_mut(0, 0).unwrap().power_plant_mw = 60;
            s.tile_at_mut(0, 0).unwrap().building_id = Some(1);
            s.buildings.push({
                let mut b = BuildingInstance::new(1, TileKind::CoalPlant, (0, 0));
                b.status = BuildingStatus::Active;
                b
            });
            set_v4_kind(s.tile_at_mut(1, 0).unwrap(), TileKind::Residential);
            s.tile_at_mut(1, 0).unwrap().building_id = Some(2);
            s.buildings.push({
                let mut b = BuildingInstance::new(2, TileKind::Residential, (1, 0));
                b.status = BuildingStatus::Active;
                b
            });
        }
        recompute_utility_network(&mut sim.state, UtilityKind::Power);
        sim.compute_utility_use();
        assert_eq!(
            sim.state.utilities.power_used, 2,
            "one Residential zone draws 1.5 MW, rounds to 2"
        );
        let expected_power = sim.state.utilities.power;

        // Round-trip through the real snapshot format, the same path a
        // save/load or an undo/redo restore takes.
        let bytes = crate::snapshot::to_bytes(&sim.state).unwrap();
        let restored = crate::snapshot::from_bytes(&bytes).unwrap();
        sim.load_state(restored);

        assert_eq!(
            sim.state.utilities.power_used, 2,
            "load_state must not zero *_used before the next tick's compute_utility_use()"
        );
        assert_eq!(sim.state.utilities.power, expected_power);
        assert_eq!(
            sim.state
                .utility_networks
                .components(UtilityKind::Power)
                .len(),
            1,
            "components must be populated immediately after load, not wait for the next tick"
        );
    }

    #[test]
    fn load_state_resyncs_latches_without_alerting() {
        let mut sim = Simulation::new(4, 4, 1);
        let mut loaded = sim.state.clone();
        loaded.utilities.power = -5;
        sim.load_state(loaded);
        assert!(
            sim.take_alerts().is_empty(),
            "a load must resync the latch silently, not raise an alert"
        );
        // Recovering from here proves the latch resynced to active=true —
        // if it hadn't, this transition wouldn't be seen as a recovery at all.
        sim.state.utilities.power = 3;
        sim.handle_resource_alerts();
        let alerts = sim.take_alerts();
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].kind, AlertKind::PowerRestored);
    }

    /// Pins `load_state`'s latch resync to the same strictly-negative
    /// boundary as `handle_resource_alerts` itself: a loaded balance of
    /// exactly zero must resync to "not active", not "active".
    #[test]
    fn load_state_resyncs_latches_at_the_strictly_negative_boundary() {
        let mut sim = Simulation::new(4, 4, 1);

        let mut zero_balance = sim.state.clone();
        zero_balance.utilities.power = 0;
        zero_balance.utilities.water = 0;
        sim.load_state(zero_balance);
        sim.state.utilities.power = 0;
        sim.state.utilities.water = 0;
        sim.handle_resource_alerts();
        assert!(
            sim.take_alerts().is_empty(),
            "a latch resynced from a zero balance must start inactive, so an unchanged zero balance is not a recovery"
        );

        let mut negative_balance = sim.state.clone();
        negative_balance.utilities.power = -1;
        negative_balance.utilities.water = -1;
        sim.load_state(negative_balance);
        sim.state.utilities.power = 0;
        sim.state.utilities.water = 0;
        sim.handle_resource_alerts();
        let alerts = sim.take_alerts();
        assert!(
            alerts.iter().any(|a| a.kind == AlertKind::PowerRestored),
            "a latch resynced from a negative balance must start active, so recovering to zero is a restore"
        );
        assert!(alerts.iter().any(|a| a.kind == AlertKind::WaterRestored));
    }

    /// Every other alert test calls `handle_resource_alerts()` directly on
    /// the private method — none of them would notice if a future refactor
    /// of `compute_utility_use`/`tick_fixed` silently dropped the call that
    /// wires it into the real tick path (exactly the class of bug #199
    /// itself was: code that exists but is never actually invoked). This one
    /// drives a real deficit through `step()` — the same entry point both
    /// hosts call — via actual zone growth and network connectivity, not a
    /// hand-set balance.
    ///
    /// Same road/plant/zone fixture as
    /// `water_requirement_is_opt_in_until_infrastructure_exists` below, with
    /// a 5 MW `SolarFarm` in place of an 80 MW `CoalPlant` — but built
    /// directly via `place_zone_building` (same helper real zone growth
    /// calls) instead of waiting on growth's own timing/RNG, since the
    /// demand-vs-deficit feedback loop this branch's own economy now runs
    /// (a live balance suppresses further growth) makes waiting for organic
    /// growth to overshoot 5 MW non-deterministic — it settles into
    /// equilibrium right at the boundary instead.
    #[test]
    fn step_wires_handle_resource_alerts_into_the_real_tick_path() {
        use crate::commands::apply_tool;
        use crate::zones::place_zone_building;
        use city_sim_protocol::commands::{Tool, ViewStratum};

        let mut sim = Simulation::new(16, 16, 42);
        for x in 0..12 {
            apply_tool(&mut sim.state, Tool::Road, x, 5, ViewStratum::Surface);
        }
        apply_tool(&mut sim.state, Tool::SolarFarm, 0, 3, ViewStratum::Surface);
        // 5 zoned-and-built residential lots at 1.5 MW each = 7.5 MW,
        // comfortably past the SolarFarm's 5 MW — not the razor-thin 4.5 MW
        // (rounds to 5, exactly tying production) that 3 lots would give.
        for x in 2..7 {
            apply_tool(
                &mut sim.state,
                Tool::Residential,
                x,
                4,
                ViewStratum::Surface,
            );
            assert!(
                place_zone_building(&mut sim.state, x, 4),
                "zone tag must place a building on a tile this test just zoned"
            );
        }

        let mut alerts = Vec::new();
        for _ in 0..5 {
            sim.step(1.0 / 20.0);
            alerts.extend(sim.take_alerts());
        }

        assert!(
            alerts.iter().any(|a| a.kind == AlertKind::PowerDeficit),
            "5 active 1.5 MW lots against a 5 MW SolarFarm must raise PowerDeficit \
             via handle_resource_alerts — if this fails, check compute_utility_use \
             still calls it"
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
