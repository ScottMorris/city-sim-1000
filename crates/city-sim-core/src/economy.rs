// economy.rs — budget tracking and per-tick revenue/expense ledger.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use crate::buildings::get_building_template;
use crate::state::{BudgetHistoryEntry, BudgetStats, GameState};
use crate::wilderness::{tourism_dividend, WildernessTunables};
use city_sim_protocol::commands::BudgetPolicy;
use city_sim_protocol::tile_kind::TileKind;

// ---------------------------------------------------------------------------
// Constants (from `app/src/game/constants.ts` and `time.ts`)
// ---------------------------------------------------------------------------

const BASE_INCOME: f32 = 120.0;
const DAYS_PER_MONTH: u32 = 30;

// Per-tile maintenance per day (from `constants.ts` MAINTENANCE table).
// Only tiles with no building_id contribute transport maintenance.
const MAINT_ROAD: f32 = 0.1;
const MAINT_RAIL: f32 = 0.2;
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
    let mut maint_roads = 0.0_f32;
    let mut maint_rail = 0.0_f32;
    let mut maint_power_lines = 0.0_f32;
    let mut maint_pipes = 0.0_f32;
    let mut commercial_zones = 0_u32;
    let mut industrial_zones = 0_u32;

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
                TileKind::Road => maint_roads += MAINT_ROAD,
                TileKind::Rail => maint_rail += MAINT_RAIL,
                TileKind::PowerLine => maint_power_lines += MAINT_POWER_LINE,
                TileKind::WaterPipe => maint_pipes += MAINT_WATER_PIPE,
                _ => {}
            }
        }

        // Underground water pipe (e.g. under a road) always contributes
        if tile.underground == Some(TileKind::WaterPipe) {
            maint_pipes += MAINT_WATER_PIPE;
        }
    }

    // Building maintenance — all buildings in state.buildings, accumulated
    // per type so the budget screen can show coal vs wind vs hydro etc.
    let mut maint_power = 0.0_f32;
    let mut maint_civic = 0.0_f32;
    let mut maint_zones = 0.0_f32;
    let mut maint_power_hydro = 0.0_f32;
    let mut maint_power_coal = 0.0_f32;
    let mut maint_power_wind = 0.0_f32;
    let mut maint_power_solar = 0.0_f32;
    let mut maint_civic_park = 0.0_f32;
    let mut maint_civic_pump = 0.0_f32;
    let mut maint_civic_tower = 0.0_f32;
    let mut maint_civic_school = 0.0_f32;
    let mut maint_zones_res = 0.0_f32;
    let mut maint_zones_com = 0.0_f32;
    let mut maint_zones_ind = 0.0_f32;

    for building in &state.buildings {
        let Some(tmpl) = get_building_template(building.kind) else {
            continue;
        };
        // Power plants carry their own maintenance in BuildingInstance so coal,
        // wind, and solar can differ from hydro without separate TileKind variants.
        let maint = if building.maintenance_per_day > 0.0 {
            building.maintenance_per_day
        } else {
            tmpl.maintenance
        };
        if maint == 0.0 {
            continue;
        }
        if tmpl.is_power_plant {
            maint_power += maint;
            match building.kind {
                TileKind::HydroPlant => maint_power_hydro += maint,
                TileKind::CoalPlant => maint_power_coal += maint,
                TileKind::WindTurbine => maint_power_wind += maint,
                TileKind::SolarFarm => maint_power_solar += maint,
                _ => {}
            }
        } else if tmpl.is_civic {
            maint_civic += maint;
            match building.kind {
                TileKind::Park => maint_civic_park += maint,
                TileKind::WaterPump => maint_civic_pump += maint,
                TileKind::WaterTower => maint_civic_tower += maint,
                TileKind::ElementarySchool | TileKind::HighSchool => maint_civic_school += maint,
                _ => {}
            }
        } else if tmpl.is_zone {
            maint_zones += maint;
            match building.kind {
                TileKind::Residential => maint_zones_res += maint,
                TileKind::Commercial => maint_zones_com += maint,
                TileKind::Industrial => maint_zones_ind += maint,
                _ => {}
            }
        }
    }

    // Fiscal policy — tax multipliers scale revenue, funding multipliers
    // scale upkeep. Defaults (9% / 100%) are exactly 1.0, so a neutral
    // policy reproduces the pre-policy numbers bit-for-bit.
    let policy = state.policies.budget;
    let tax_res = BudgetPolicy::tax_multiplier(policy.tax_residential);
    let tax_com = BudgetPolicy::tax_multiplier(policy.tax_commercial);
    let tax_ind = BudgetPolicy::tax_multiplier(policy.tax_industrial);
    let fund_transport = BudgetPolicy::funding_multiplier(policy.fund_transport);
    let fund_power = BudgetPolicy::funding_multiplier(policy.fund_power);
    let fund_civic = BudgetPolicy::funding_multiplier(policy.fund_civic);

    // Funding scales upkeep: transport covers roads/rail, power covers lines
    // and plants, civic covers civic buildings and water pipes. Zone upkeep
    // is private-sector and never publicly funded.
    maint_roads *= fund_transport;
    maint_rail *= fund_transport;
    maint_power_lines *= fund_power;
    maint_pipes *= fund_civic;
    maint_power *= fund_power;
    maint_power_hydro *= fund_power;
    maint_power_coal *= fund_power;
    maint_power_wind *= fund_power;
    maint_power_solar *= fund_power;
    maint_civic *= fund_civic;
    maint_civic_park *= fund_civic;
    maint_civic_pump *= fund_civic;
    maint_civic_tower *= fund_civic;
    maint_civic_school *= fund_civic;

    // Revenue
    let revenue_base = BASE_INCOME;
    let revenue_pop = state.population as f32 * 1.5 * tax_res;
    let revenue_commercial = commercial_zones as f32 * 6.0 * tax_com;
    let revenue_industrial = industrial_zones as f32 * 8.0 * tax_ind;
    // Tourism dividend — high-wilderness cities draw visitors (#8).
    let revenue_tourism = tourism_dividend(
        state.wilderness.score,
        state.population,
        &WildernessTunables::default(),
    );
    let revenue =
        revenue_base + revenue_pop + revenue_commercial + revenue_industrial + revenue_tourism;

    // Wilderness programme costs: a flat daily fee for the Nature Reserve
    // and a per-industrial-zone subsidy for Green Industry (#9).
    let wt = WildernessTunables::default();
    let mut expenses_policies = 0.0_f32;
    if state.policies.wilderness.nature_reserve {
        expenses_policies += wt.reserve_cost_per_day;
    }
    if state.policies.wilderness.green_industry {
        expenses_policies += industrial_zones as f32 * wt.green_industry_subsidy_per_zone;
    }

    // Expenses
    let expenses_transport = maint_roads + maint_rail + maint_power_lines + maint_pipes;
    let expenses_buildings = maint_power + maint_civic + maint_zones;
    let expenses = expenses_transport + expenses_buildings + expenses_policies;

    let net = revenue - expenses;
    // net_per_day matches TS `net * 0.2 * 1.5`
    let net_per_day = net * 0.3;
    let net_per_month = net_per_day * DAYS_PER_MONTH as f32;

    BudgetStats {
        revenue,
        expenses,
        net,
        net_per_day,
        net_per_month,
        revenue_base,
        revenue_pop,
        revenue_commercial,
        revenue_industrial,
        revenue_tourism,
        expenses_transport,
        expenses_buildings,
        expenses_policies,
        maint_power,
        maint_civic,
        maint_zones,
        maint_roads,
        maint_rail,
        maint_power_lines,
        maint_pipes,
        maint_power_hydro,
        maint_power_coal,
        maint_power_wind,
        maint_power_solar,
        maint_civic_park,
        maint_civic_pump,
        maint_civic_tower,
        maint_civic_school,
        maint_zones_res,
        maint_zones_com,
        maint_zones_ind,
    }
}

// ---------------------------------------------------------------------------
// record_daily_budget — append to rolling 200-day history
// ---------------------------------------------------------------------------

/// Mirror of `recordDailyBudget()` from `economy.ts`.
pub fn record_daily_budget(state: &mut GameState) {
    let day = state.day;
    if let Some(last) = state.budget_history.back() {
        if last.day >= day {
            return;
        }
    }
    let entry = BudgetHistoryEntry {
        day,
        revenue: state.budget.revenue,
        expenses: state.budget.expenses,
        net: state.budget.net,
    };
    state.budget_history.push_back(entry);
    while state.budget_history.len() > 200 {
        state.budget_history.pop_front();
    }
}

// ---------------------------------------------------------------------------
// apply_population_growth
// ---------------------------------------------------------------------------

/// Apply one fixed tick of population and job growth driven by demand.
///
/// Called once per fixed simulation tick by `Simulation::tick_fixed()`.
/// `pop_cap` and `job_cap` are the capacity totals already summed by the
/// demand pass; passing them in avoids a redundant tile scan.
///
/// Mirrors the growth block in `simulation.ts:tick()`.
pub fn apply_population_growth(state: &mut GameState, pop_cap: u32, job_cap: u32) {
    // Use float accumulation so low-demand growth (e.g. +0.1/tick) carries over
    // between ticks rather than truncating to zero — mirrors the TS engine where
    // `state.population` is a JS float64.
    let raw_pop_growth = (state.demand.residential as f64 * 0.05).clamp(-2.0, 2.0);
    state.pop_frac += raw_pop_growth;
    let whole_pop = state.pop_frac as i64;
    if whole_pop != 0 {
        state.pop_frac -= whole_pop as f64;
        state.population =
            ((state.population as i64 + whole_pop).max(0) as u64).min(pop_cap as u64) as u32;
    }

    let combined_demand = state.demand.commercial + state.demand.industrial;
    let raw_job_growth = (combined_demand as f64 * 0.05).clamp(-2.0, 2.0);
    state.jobs_frac += raw_job_growth;
    let whole_jobs = state.jobs_frac as i64;
    if whole_jobs != 0 {
        state.jobs_frac -= whole_jobs as f64;
        state.jobs = ((state.jobs as i64 + whole_jobs).max(0) as u64).min(job_cap as u64) as u32;
    }
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

    fn gs(w: u32, h: u32) -> GameState {
        GameState::new(w, h, 0)
    }

    #[test]
    fn empty_city_has_base_income_only() {
        let s = gs(4, 4);
        let b = compute_daily_budget(&s);
        // No zones or buildings → revenue = BASE_INCOME + pop*1.5, expenses = 0
        let expected_revenue = BASE_INCOME + s.population as f32 * 1.5;
        assert!(
            (b.revenue - expected_revenue).abs() < 0.01,
            "revenue {}",
            b.revenue
        );
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
        assert!(
            (b.maint_roads).abs() < 0.001,
            "occupied tile should not contribute"
        );
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
        assert!((b.maint_zones - 1.0).abs() < 0.001, "res maintenance");
        assert!((b.maint_civic - 0.05).abs() < 0.001, "park maintenance");
        assert!((b.maint_power - 150.0).abs() < 0.001, "hydro maintenance");
        assert!((b.expenses_buildings - (1.0 + 0.05 + 150.0)).abs() < 0.001);
    }

    #[test]
    fn power_plant_maintenance_per_day_overrides_template() {
        let mut s = gs(4, 4);
        // Coal plant: maintenance_per_day = 300 (template value is 150 for HydroPlant)
        let mut coal = BuildingInstance::new(1, TileKind::HydroPlant, (0, 0));
        coal.status = BuildingStatus::Active;
        coal.maintenance_per_day = 300.0;
        s.buildings.push(coal);
        let b = compute_daily_budget(&s);
        assert!(
            (b.maint_power - 300.0).abs() < 0.001,
            "coal plant must use maintenance_per_day=300, got {}",
            b.maint_power
        );
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
        assert_eq!(
            s.budget_history.len(),
            1,
            "should not record same day twice"
        );
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
        s.demand.residential = 60.0; // positive demand → growth
        apply_population_growth(&mut s, 100, 50);
        assert!(s.population > 0, "population should grow toward capacity");
    }

    #[test]
    fn apply_population_growth_clamps_at_capacity() {
        let mut s = gs(2, 2);
        s.population = 10;
        s.demand.residential = 100.0;
        // at capacity — growth clamped to 0
        apply_population_growth(&mut s, 10, 0);
        assert_eq!(s.population, 10);
    }

    #[test]
    fn residential_tax_scales_population_revenue() {
        let mut s = gs(4, 4);
        s.population = 100;
        let neutral = compute_daily_budget(&s).revenue_pop;
        s.policies.budget.tax_residential = 18; // double the neutral 9%
        let taxed = compute_daily_budget(&s).revenue_pop;
        assert!(
            (taxed - neutral * 2.0).abs() < 0.001,
            "18% tax should double residential revenue"
        );
        s.policies.budget.tax_residential = 0;
        assert_eq!(
            compute_daily_budget(&s).revenue_pop,
            0.0,
            "0% tax → no residential revenue"
        );
    }

    #[test]
    fn transport_funding_scales_road_maintenance() {
        let mut s = gs(3, 1);
        s.tile_at_mut(0, 0).unwrap().kind = TileKind::Road;
        s.tile_at_mut(1, 0).unwrap().kind = TileKind::Road;
        let full = compute_daily_budget(&s).maint_roads;
        s.policies.budget.fund_transport = 50;
        let half = compute_daily_budget(&s).maint_roads;
        assert!(
            (half - full * 0.5).abs() < 0.0001,
            "50% funding should halve road upkeep"
        );
    }

    #[test]
    fn power_maintenance_breaks_down_by_plant_type() {
        let mut s = gs(8, 8);
        let mut hydro = BuildingInstance::new(1, TileKind::HydroPlant, (0, 0));
        hydro.status = BuildingStatus::Active;
        hydro.maintenance_per_day = 150.0;
        s.buildings.push(hydro);
        let mut coal = BuildingInstance::new(2, TileKind::CoalPlant, (2, 0));
        coal.status = BuildingStatus::Active;
        coal.maintenance_per_day = 300.0;
        s.buildings.push(coal);
        let mut wind = BuildingInstance::new(3, TileKind::WindTurbine, (4, 0));
        wind.status = BuildingStatus::Active;
        wind.maintenance_per_day = 30.0;
        s.buildings.push(wind);
        let b = compute_daily_budget(&s);
        assert!((b.maint_power_hydro - 150.0).abs() < 0.001);
        assert!((b.maint_power_coal - 300.0).abs() < 0.001);
        assert!((b.maint_power_wind - 30.0).abs() < 0.001);
        assert!((b.maint_power_solar).abs() < 0.001);
        assert!(
            (b.maint_power - (150.0 + 300.0 + 30.0)).abs() < 0.001,
            "per-type rows must sum to the power total"
        );
    }

    #[test]
    fn neutral_policy_is_bit_exact_with_prepolicy_budget() {
        let mut s = gs(4, 4);
        s.population = 37;
        s.tile_at_mut(0, 0).unwrap().kind = TileKind::Road;
        s.tile_at_mut(1, 0).unwrap().kind = TileKind::Commercial;
        let b = compute_daily_budget(&s);
        // Reproduce the pre-policy formulas literally.
        assert_eq!(b.revenue_pop, 37.0_f32 * 1.5);
        assert_eq!(b.revenue_commercial, 6.0);
        assert_eq!(b.maint_roads, 0.1);
    }

    #[test]
    fn wilderness_programmes_cost_money() {
        use crate::wilderness::WildernessTunables;
        use city_sim_protocol::commands::WildernessPolicy;

        let mut s = gs(4, 4);
        s.tile_at_mut(0, 0).unwrap().kind = TileKind::Industrial;
        s.tile_at_mut(1, 0).unwrap().kind = TileKind::Industrial;
        let t = WildernessTunables::default();

        let before = compute_daily_budget(&s);
        assert_eq!(before.expenses_policies, 0.0);

        s.policies.wilderness = WildernessPolicy {
            nature_reserve: true,
            green_industry: true,
        };
        let after = compute_daily_budget(&s);
        let expected = t.reserve_cost_per_day + 2.0 * t.green_industry_subsidy_per_zone;
        assert!((after.expenses_policies - expected).abs() < 0.001);
        assert!(
            (after.expenses - (before.expenses + expected)).abs() < 0.001,
            "programme costs must flow into total expenses"
        );
    }

    #[test]
    fn apply_money_tick_increases_money_on_positive_net() {
        let mut s = gs(2, 2);
        let before = s.money;
        s.budget.net_per_day = 100.0;
        apply_money_tick(&mut s, 1.0);
        assert!(
            s.money > before,
            "money should increase with positive net_per_day"
        );
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
