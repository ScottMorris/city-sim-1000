use std::collections::{BTreeSet, HashMap};
use sim_protocol::tile_kind::TileKind;
use crate::adjacency::{has_road_access, is_frontier_zone, zone_has_road_path, tile_has_power, tile_has_water};
use crate::buildings::BuildingInstance;
use crate::rng::SeededRng;
use crate::state::{GameState, FLAG_ABANDONED};

// ---------------------------------------------------------------------------
// Zone growth simulation state (not serialised — rebuilt from GameState)
// ---------------------------------------------------------------------------

/// Transient zone growth state — lives on the simulation driver, not in
/// `GameState`, mirroring how `Simulation` holds these in the TS codebase.
///
/// `vacant` uses `BTreeSet` for deterministic iteration order, matching TS
/// `Set<number>` which iterates in insertion (numeric) order.
#[derive(Debug, Default)]
pub struct ZoneGrowthSim {
    /// Countdown timers (ticks remaining) per vacant-zone tile index.
    timers:        HashMap<usize, u32>,
    /// Set of tile indices that are vacant zone tiles.
    vacant:        BTreeSet<usize>,
    /// Last seen `GameState.tile_revision` — used to invalidate the cache.
    last_revision: u32,
}

impl ZoneGrowthSim {
    pub fn new() -> Self { Self::default() }

    /// Rebuild the vacant-zone cache if `tile_revision` changed or cache is empty.
    fn refresh_vacant(&mut self, state: &GameState) {
        let rev = state.tile_revision;
        if rev == self.last_revision && !self.vacant.is_empty() { return; }

        self.vacant.clear();
        for (idx, tile) in state.tiles.iter().enumerate() {
            if tile.building_id.is_some() { continue; }
            if matches!(tile.kind, TileKind::Residential | TileKind::Commercial | TileKind::Industrial) {
                self.vacant.insert(idx);
            }
        }
        // Prune stale timers
        self.timers.retain(|k, _| self.vacant.contains(k));
        self.last_revision = rev;
    }

    /// Number of tracked vacant zones (for tests / diagnostics).
    #[cfg(test)]
    pub fn vacant_count(&self) -> usize { self.vacant.len() }

    /// Run one zone-growth tick.  Returns `true` if any building was placed.
    ///
    /// Mirrors `spawnZoneBuildings()` + `applyZoneGrowthForType()` from
    /// `simulation.ts`.  `delay_ticks` ≈ `ticksPerSecond * 2` (~2 s delay).
    pub fn tick(&mut self, state: &mut GameState, rng: &mut SeededRng, delay_ticks: u32) -> bool {
        self.refresh_vacant(state);

        // --- build candidate lists ---
        let mut residential: Vec<Candidate> = Vec::new();
        let mut commercial:  Vec<Candidate> = Vec::new();
        let mut industrial:  Vec<Candidate> = Vec::new();

        let vacant_snapshot: Vec<usize> = self.vacant.iter().copied().collect();

        for idx in vacant_snapshot {
            let tile = &state.tiles[idx];
            // Already developed (building placed by another system)
            if tile.building_id.is_some() {
                self.timers.remove(&idx);
                self.vacant.remove(&idx);
                continue;
            }
            if !matches!(tile.kind, TileKind::Residential | TileKind::Commercial | TileKind::Industrial) {
                self.timers.remove(&idx);
                self.vacant.remove(&idx);
                continue;
            }

            let x = (idx as u32) % state.width;
            let y = (idx as u32) / state.width;
            let has_road  = has_road_access(state, x, y);
            let has_chain = zone_has_road_path(state, x, y);
            let frontier  = is_frontier_zone(state, x, y);
            if !has_road && !has_chain && !frontier {
                self.timers.remove(&idx);
                continue;
            }

            // Growth-delay countdown
            let delay = delay_ticks.max(1);
            let timer = self.timers.entry(idx).or_insert(delay);
            if *timer > 1 {
                *timer -= 1;
                continue;
            }
            self.timers.remove(&idx);

            let has_power = tile_has_power(state, x, y);
            let has_water = tile_has_water(state, x, y);
            let kind = tile.kind;
            match kind {
                TileKind::Residential => residential.push(Candidate { idx, x, y, has_power, has_water }),
                TileKind::Commercial  => commercial .push(Candidate { idx, x, y, has_power, has_water }),
                TileKind::Industrial  => industrial .push(Candidate { idx, x, y, has_power, has_water }),
                _ => {}
            }
        }

        let demand_r = state.demand.residential;
        let demand_c = state.demand.commercial;
        let demand_i = state.demand.industrial;
        let grew_r = grow_zone_type(state, rng, TileKind::Residential, demand_r, &mut residential, &mut self.vacant);
        let grew_c = grow_zone_type(state, rng, TileKind::Commercial,  demand_c, &mut commercial,  &mut self.vacant);
        let grew_i = grow_zone_type(state, rng, TileKind::Industrial,  demand_i, &mut industrial,  &mut self.vacant);

        if grew_r || grew_c || grew_i {
            self.last_revision = state.tile_revision;
        }

        grew_r || grew_c || grew_i
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

struct Candidate { idx: usize, x: u32, y: u32, has_power: bool, has_water: bool }

/// Mirrors `applyZoneGrowthForType()` from `simulation.ts`.
fn grow_zone_type(
    state:      &mut GameState,
    rng:        &mut SeededRng,
    _kind:      TileKind,
    demand:     f32,
    candidates: &mut Vec<Candidate>,
    vacant:     &mut BTreeSet<usize>,
) -> bool {
    if candidates.is_empty() { return false; }

    // Cap: how many lots can develop this tick
    let max_new = (1 + (demand / 40.0) as u32).clamp(0, 4);
    if max_new == 0 { return false; }

    // Base growth probability
    let p_grow: f32 = if demand >= 50.0 {
        1.0
    } else if demand <= 0.0 {
        0.0
    } else {
        ((demand + 20.0) / 120.0).clamp(0.0, 1.0)
    };

    let power_bal = state.utilities.power as f32;
    let water_bal = state.utilities.water as f32;

    // Fisher-Yates shuffle over candidates (matches TS shuffle loop)
    let n = candidates.len();
    for i in (1..n).rev() {
        let j = rng.next_below((i + 1) as u32) as usize;
        candidates.swap(i, j);
    }

    let mut grown = 0u32;
    for c in candidates.iter() {
        if grown >= max_new { break; }

        let mut util_factor: f32 = 1.0;
        if !c.has_power { util_factor *= 0.15; }
        if !c.has_water { util_factor *= 0.35; }
        if power_bal < 0.0 { util_factor *= (1.0 + power_bal / 20.0).clamp(0.05, 1.0); }
        if water_bal < 0.0 { util_factor *= (1.0 + water_bal / 30.0).clamp(0.05, 1.0); }

        let adj_p = (p_grow * util_factor).clamp(0.0, 1.0);
        if adj_p <= 0.0 || rng.next_f32() > adj_p { continue; }

        if place_zone_building(state, c.x, c.y) {
            vacant.remove(&c.idx);
            grown += 1;
        }
    }
    grown > 0
}

/// Place a zone building: set tile.building_id, add to state.buildings, bump counters.
fn place_zone_building(state: &mut GameState, x: u32, y: u32) -> bool {
    let Some(idx) = state.tile_index(x, y) else { return false };
    if state.tiles[idx].building_id.is_some() { return false; }

    let bid  = state.next_building_id;
    let kind = state.tiles[idx].kind;
    state.next_building_id += 1;
    state.tile_revision += 1;

    state.tiles[idx].building_id = Some(bid as u16);
    state.tiles[idx].set_flag(FLAG_ABANDONED, false);
    state.buildings.push(BuildingInstance::new(bid, kind, (x, y)));
    true
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::FLAG_POWERED;

    fn gs(w: u32, h: u32) -> GameState { GameState::new(w, h, 42) }

    fn kind(s: &mut GameState, x: u32, y: u32, k: TileKind) {
        s.tile_at_mut(x, y).unwrap().kind = k;
    }

    fn road(s: &mut GameState, x: u32, y: u32) { kind(s, x, y, TileKind::Road); }

    fn residential(s: &mut GameState, x: u32, y: u32) {
        kind(s, x, y, TileKind::Residential);
    }

    fn power_tile(s: &mut GameState, x: u32, y: u32) {
        s.tile_at_mut(x, y).unwrap().set_flag(FLAG_POWERED, true);
    }

    #[test]
    fn no_growth_without_demand() {
        let mut s = gs(3, 1);
        residential(&mut s, 0, 0);
        road(&mut s, 1, 0);
        s.demand.residential = 0.0;
        let mut zg = ZoneGrowthSim::new();
        let mut rng = SeededRng::new(42);
        // Even with long enough timer countdown, demand=0 → no growth
        for _ in 0..100 {
            zg.tick(&mut s, &mut rng, 1);
        }
        assert!(s.tile_at(0, 0).unwrap().building_id.is_none());
    }

    #[test]
    fn growth_with_high_demand_and_road() {
        let mut s = gs(3, 1);
        residential(&mut s, 0, 0);
        road(&mut s, 1, 0);
        power_tile(&mut s, 1, 0);
        // Also mark the residential as powered (it's adjacent to powered road)
        power_tile(&mut s, 0, 0);
        s.demand.residential = 100.0;
        s.utilities.power = 100;
        s.utilities.water = 100;
        let mut zg = ZoneGrowthSim::new();
        let mut rng = SeededRng::new(0);
        let mut grew = false;
        for _ in 0..50 {
            if zg.tick(&mut s, &mut rng, 1) { grew = true; break; }
        }
        assert!(grew, "should have grown with demand=100");
        assert!(s.tile_at(0, 0).unwrap().building_id.is_some());
    }

    #[test]
    fn no_growth_without_road_access() {
        // 3×3 grid: interior (1,1) is Residential surrounded by Residential on all
        // four sides — not a frontier zone, no road access, no road path.
        let mut s = gs(3, 3);
        for y in 0..3u32 {
            for x in 0..3u32 {
                residential(&mut s, x, y);
            }
        }
        s.demand.residential = 100.0;
        let mut zg = ZoneGrowthSim::new();
        let mut rng = SeededRng::new(0);
        for _ in 0..50 {
            zg.tick(&mut s, &mut rng, 1);
        }
        // Centre tile should never develop — it is excluded by road-access check
        assert!(s.tile_at(1, 1).unwrap().building_id.is_none());
    }

    #[test]
    fn growth_delay_prevents_immediate_growth() {
        let mut s = gs(3, 1);
        residential(&mut s, 0, 0);
        road(&mut s, 1, 0);
        power_tile(&mut s, 0, 0);
        s.demand.residential = 100.0;
        s.utilities.power = 100;
        s.utilities.water = 100;
        let mut zg = ZoneGrowthSim::new();
        let mut rng = SeededRng::new(0);
        // delay_ticks=10 → first 9 ticks must not grow
        for i in 0..9 {
            let grew = zg.tick(&mut s, &mut rng, 10);
            assert!(!grew, "should not grow on tick {i} (delay not expired)");
        }
    }

    #[test]
    fn place_zone_building_sets_building_id() {
        let mut s = gs(1, 1);
        kind(&mut s, 0, 0, TileKind::Residential);
        let ok = place_zone_building(&mut s, 0, 0);
        assert!(ok);
        assert_eq!(s.tile_at(0, 0).unwrap().building_id, Some(1));
        assert_eq!(s.next_building_id, 2);
        assert_eq!(s.tile_revision, 1);
    }

    #[test]
    fn place_zone_building_rejects_occupied() {
        let mut s = gs(1, 1);
        kind(&mut s, 0, 0, TileKind::Residential);
        place_zone_building(&mut s, 0, 0);
        let ok2 = place_zone_building(&mut s, 0, 0);
        assert!(!ok2, "second placement should fail");
        assert_eq!(s.next_building_id, 2);
    }

    #[test]
    fn determinism_same_seed_same_outcome() {
        fn run(seed: u32) -> Option<u16> {
            let mut s = gs(4, 1);
            residential(&mut s, 0, 0);
            residential(&mut s, 1, 0);
            road(&mut s, 2, 0);
            power_tile(&mut s, 0, 0);
            power_tile(&mut s, 1, 0);
            s.demand.residential = 60.0;
            s.utilities.power = 100;
            s.utilities.water = 100;
            let mut zg = ZoneGrowthSim::new();
            let mut rng = SeededRng::new(seed);
            for _ in 0..30 {
                zg.tick(&mut s, &mut rng, 1);
            }
            s.tile_at(0, 0).unwrap().building_id
                .or_else(|| s.tile_at(1, 0).unwrap().building_id)
        }
        // Same seed → same outcome
        assert_eq!(run(7), run(7));
        // Different seeds → might differ (at least one should grow)
        assert!(run(7).is_some() || run(99).is_some());
    }
}
