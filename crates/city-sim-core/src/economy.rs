use city_sim_protocol::tile_kind::TileKind;
use crate::buildings::get_building_template;
use crate::state::{BudgetStats, BudgetHistoryEntry, GameState};

// ---------------------------------------------------------------------------
// Constants (from `app/src/game/constants.ts` and `time.ts`)
// ---------------------------------------------------------------------------

const BASE_INCOME:     f32 = 120.0;
const DAYS_PER_MONTH:  u32 = 30;

// Per-tile maintenance per day (from `constants.ts` MAINTENANCE table).
// Only tiles with no building_id contribute transport maintenance.
const MAINT_ROAD:       f32 = 0.1;
const MAINT_RAIL:       f32 = 0.2;
const MAINT_POWER_LINE: f32 = 0.08;
const MAINT_WATER_PIPE: f32 = 0.04;

// Lighting bylaw scaling is not yet ported (P3-9+).  Default bylaw is neutral
// (multiplier = 1.0), so civic/zone maintenance is unscaled here.

// ---------------------------------------------------------------------------
// compute_daily_budget — pure read of GameState → BudgetStats
// ---------------------------------------------------------------------------

/// Compute the current daily budget from `GameState`.
///
/// Matches the budget block in `simulation.ts:tick()`:
/// - Transport maintenance: per-tile upkeep for Road/Rail/PowerLine/WaterPipe
///   (only tiles where `building_id.is_none()`).
/// - Building maintenance: summed from `state.buildings` templates.
/// - Revenue: base + population + commercial zones + industrial zones.
///
/// Lighting-bylaw scaling of civic/zone maintenance is stubbed to 1.0 until
/// bylaws are ported (P3-9+).
pub fn compute_daily_budget(state: &GameState) -> BudgetStats {
    let mut maint_roads       = 0.0_f32;
    let mut maint_rail        = 0.0_f32;
    let mut maint_power_lines = 0.0_f32;
    let mut maint_pipes       = 0.0_f32;
    let mut commercial_zones  = 0_u32;
    let mut industrial_zones  = 0_u32;

    for tile in &state.tiles {
        // Zone revenue counters (all commercial/industrial tiles, developed or not)
        match tile.kind {
            TileKind::Commercial => commercial_zones += 1,
            TileKind::Industrial => industrial_zones += 1,
            _ => {}
        }

        // Transport maintenance — only undeveloped/unoccupied tiles
        if tile.building_id.is_none() {
            match tile.kind {
                TileKind::Road      => maint_roads       += MAINT_ROAD,
                TileKind::Rail      => maint_rail        += MAINT_RAIL,
                TileKind::PowerLine => maint_power_lines += MAINT_POWER_LINE,
                TileKind::WaterPipe => maint_pipes       += MAINT_WATER_PIPE,
                _ => {}
            }
        }

        // Underground water pipe (e.g. under a road) always contributes
        if tile.underground == Some(TileKind::WaterPipe) {
            maint_pipes += MAINT_WATER_PIPE;
        }
    }

    // Building maintenance — all buildings in state.buildings
    let mut maint_power = 0.0_f32;
    let mut maint_civic = 0.0_f32;
    let mut maint_zones = 0.0_f32;

    for building in &state.buildings {
        let Some(tmpl) = get_building_template(building.kind) else { continue };
        if tmpl.maintenance == 0.0 { continue; }
        if tmpl.is_power_plant { maint_power += tmpl.maintenance; }
        else if tmpl.is_civic  { maint_civic += tmpl.maintenance; }
        else if tmpl.is_zone   { maint_zones += tmpl.maintenance; }
    }

    // Revenue
    let revenue_base       = BASE_INCOME;
    let revenue_pop        = state.population as f32 * 1.5;
    let revenue_commercial = commercial_zones as f32 * 6.0;
    let revenue_industrial = industrial_zones as f32 * 8.0;
    let revenue = revenue_base + revenue_pop + revenue_commercial + revenue_industrial;

    // Expenses
    let expenses_transport = maint_roads + maint_rail + maint_power_lines + maint_pipes;
    let expenses_buildings = maint_power + maint_civic + maint_zones;
    let expenses = expenses_transport + expenses_buildings;

    let net          = revenue - expenses;
    // net_per_day matches TS `net * 0.2 * 1.5`
    let net_per_day  = net * 0.3;
    let net_per_month = net_per_day * DAYS_PER_MONTH as f32;

    BudgetStats {
        revenue, expenses, net, net_per_day, net_per_month,
        revenue_base, revenue_pop, revenue_commercial, revenue_industrial,
        expenses_transport, expenses_buildings,
        maint_power, maint_civic, maint_zones,
        maint_roads, maint_rail, maint_power_lines, maint_pipes,
    }
}

// ---------------------------------------------------------------------------
// record_daily_budget — append to rolling 200-day history
// ---------------------------------------------------------------------------

/// Mirror of `recordDailyBudget()` from `economy.ts`.
pub fn record_daily_budget(state: &mut GameState) {
    let day = state.day;
    if let Some(last) = state.budget_history.back() {
        if last.day >= day { return; }
    }
    let entry = BudgetHistoryEntry {
        day,
        revenue:  state.budget.revenue,
        expenses: state.budget.expenses,
        net:      state.budget.net,
    };
    state.budget_history.push_back(entry);
    while state.budget_history.len() > 200 {
        state.budget_history.pop_front();
    }
}

// ---------------------------------------------------------------------------
// apply_population_growth
// ---------------------------------------------------------------------------

/// Apply one tick of population and job growth driven by demand.
///
/// Must be called AFTER `compute_city_demand` has updated `state.demand`.
/// `pop_cap` and `job_cap` are the capacity totals already summed by the
/// demand pass; passing them in avoids a redundant tile scan.
///
/// Mirrors the growth block in `simulation.ts:tick()`.
pub fn apply_population_growth(
    state:   &mut GameState,
    pop_cap: u32,
    job_cap: u32,
) {
    fn clamp_i32(v: i32, lo: i32, hi: i32) -> i32 { v.max(lo).min(hi) }

    let desired_pop = (state.population as i32)
        + (state.demand.residential * 0.05) as i32;
    let desired_pop = desired_pop.min(pop_cap as i32).max(0);
    let growth      = clamp_i32(desired_pop - state.population as i32, -2, 2);
    let new_pop     = (state.population as i32 + growth)
        .clamp(0, pop_cap as i32) as u32;

    let combined_demand = state.demand.commercial + state.demand.industrial;
    let desired_jobs = (state.jobs as i32) + (combined_demand * 0.05) as i32;
    let desired_jobs = desired_jobs.min(job_cap as i32).max(0);
    let job_growth   = clamp_i32(desired_jobs - state.jobs as i32, -2, 2);
    let new_jobs     = (state.jobs as i32 + job_growth)
        .clamp(0, job_cap as i32) as u32;

    state.population = new_pop;
    state.jobs       = new_jobs;
}

// ---------------------------------------------------------------------------
// apply_money_tick — apply per-tick money change
// ---------------------------------------------------------------------------

/// Apply money change for one simulation tick of duration `dt` seconds.
///
/// `money += net_per_day * (dt / 1.5)`, clamped to [0, i64::MAX].
/// Mirrors `this.state.money = Math.max(0, this.state.money + netPerDay * (this.dt / 1.5))`.
pub fn apply_money_tick(state: &mut GameState, dt: f64) {
    let delta = (state.budget.net_per_day as f64) * (dt / 1.5);
    let new_money = (state.money as f64 + delta).max(0.0);
    state.money = new_money.min(i64::MAX as f64) as i64;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buildings::{BuildingInstance, BuildingStatus};

    fn gs(w: u32, h: u32) -> GameState { GameState::new(w, h, 0) }

    #[test]
    fn empty_city_has_base_income_only() {
        let s = gs(4, 4);
        let b = compute_daily_budget(&s);
        // No zones or buildings → revenue = BASE_INCOME + pop*1.5, expenses = 0
        let expected_revenue = BASE_INCOME + s.population as f32 * 1.5;
        assert!((b.revenue - expected_revenue).abs() < 0.01, "revenue {}", b.revenue);
        assert!((b.expenses_transport).abs() < 0.01);
        assert!((b.expenses_buildings).abs() < 0.01);
    }

    #[test]
    fn road_tiles_contribute_transport_maintenance() {
        let mut s = gs(3, 1);
        s.tile_at_mut(0, 0).unwrap().kind = TileKind::Road;
        s.tile_at_mut(1, 0).unwrap().kind = TileKind::Road;
        let b = compute_daily_budget(&s);
        assert!((b.maint_roads - 2.0 * MAINT_ROAD).abs() < 0.001);
        assert!((b.expenses_transport - b.maint_roads).abs() < 0.001);
    }

    #[test]
    fn road_with_building_does_not_count_transport() {
        let mut s = gs(1, 1);
        s.tile_at_mut(0, 0).unwrap().kind = TileKind::Road;
        s.tile_at_mut(0, 0).unwrap().building_id = Some(1);
        let b = compute_daily_budget(&s);
        assert!((b.maint_roads).abs() < 0.001, "occupied tile should not contribute");
    }

    #[test]
    fn underground_water_pipe_always_contributes() {
        let mut s = gs(1, 1);
        s.tile_at_mut(0, 0).unwrap().kind = TileKind::Road;
        s.tile_at_mut(0, 0).unwrap().underground = Some(TileKind::WaterPipe);
        let b = compute_daily_budget(&s);
        // Road upkeep + pipe underlay upkeep
        assert!((b.maint_roads - MAINT_ROAD).abs() < 0.001);
        assert!((b.maint_pipes - MAINT_WATER_PIPE).abs() < 0.001);
    }

    #[test]
    fn commercial_zones_contribute_revenue() {
        let mut s = gs(2, 1);
        s.tile_at_mut(0, 0).unwrap().kind = TileKind::Commercial;
        s.tile_at_mut(1, 0).unwrap().kind = TileKind::Commercial;
        let b = compute_daily_budget(&s);
        assert!((b.revenue_commercial - 2.0 * 6.0).abs() < 0.001);
    }

    #[test]
    fn building_maintenance_categorised_correctly() {
        let mut s = gs(4, 4);
        // Zone building
        let mut res = BuildingInstance::new(1, TileKind::Residential, (0, 0));
        res.status = BuildingStatus::Active;
        s.buildings.push(res);
        // Civic building
        let mut park = BuildingInstance::new(2, TileKind::Park, (1, 0));
        park.status = BuildingStatus::Active;
        s.buildings.push(park);
        // Power plant
        let mut plant = BuildingInstance::new(3, TileKind::HydroPlant, (2, 0));
        plant.status = BuildingStatus::Active;
        s.buildings.push(plant);
        let b = compute_daily_budget(&s);
        assert!((b.maint_zones - 1.0).abs() < 0.001,   "res maintenance");
        assert!((b.maint_civic - 0.05).abs() < 0.001,  "park maintenance");
        assert!((b.maint_power - 150.0).abs() < 0.001, "hydro maintenance");
        assert!((b.expenses_buildings - (1.0 + 0.05 + 150.0)).abs() < 0.001);
    }

    #[test]
    fn net_per_day_matches_ts_formula() {
        let s = gs(2, 2);
        let b = compute_daily_budget(&s);
        assert!((b.net_per_day - b.net * 0.3).abs() < 0.001);
    }

    #[test]
    fn record_daily_budget_appends_entry() {
        let mut s = gs(2, 2);
        s.budget = compute_daily_budget(&s);
        s.day = 5;
        record_daily_budget(&mut s);
        assert_eq!(s.budget_history.len(), 1);
        assert_eq!(s.budget_history[0].day, 5);
    }

    #[test]
    fn record_daily_budget_deduplicates_same_day() {
        let mut s = gs(2, 2);
        s.budget = compute_daily_budget(&s);
        s.day = 3;
        record_daily_budget(&mut s);
        record_daily_budget(&mut s);
        assert_eq!(s.budget_history.len(), 1, "should not record same day twice");
    }

    #[test]
    fn record_daily_budget_caps_at_200_entries() {
        let mut s = gs(2, 2);
        s.budget = compute_daily_budget(&s);
        for day in 1..=250u32 {
            s.day = day;
            record_daily_budget(&mut s);
        }
        assert_eq!(s.budget_history.len(), 200);
        // Oldest entry should be day 51 (250 - 200 + 1)
        assert_eq!(s.budget_history.front().unwrap().day, 51);
    }

    #[test]
    fn apply_population_growth_increases_pop_toward_capacity() {
        let mut s = gs(2, 2);
        s.population = 0;
        s.demand.residential = 60.0;  // positive demand → growth
        apply_population_growth(&mut s, 100, 50);
        assert!(s.population > 0, "population should grow toward capacity");
    }

    #[test]
    fn apply_population_growth_clamps_at_capacity() {
        let mut s = gs(2, 2);
        s.population = 10;
        s.demand.residential = 100.0;
        apply_population_growth(&mut s, 10, 0);  // at capacity
        // desired_pop = min(10, 10 + 5) = 10; growth = clamp(0, -2, 2) = 0
        assert_eq!(s.population, 10);
    }

    #[test]
    fn apply_money_tick_increases_money_on_positive_net() {
        let mut s = gs(2, 2);
        let before = s.money;
        s.budget.net_per_day = 100.0;
        apply_money_tick(&mut s, 1.0);
        assert!(s.money > before, "money should increase with positive net_per_day");
    }

    #[test]
    fn apply_money_tick_does_not_go_below_zero() {
        let mut s = gs(2, 2);
        s.money = 0;
        s.budget.net_per_day = -1000.0;
        apply_money_tick(&mut s, 1.0);
        assert_eq!(s.money, 0, "money should not go below zero");
    }
}
