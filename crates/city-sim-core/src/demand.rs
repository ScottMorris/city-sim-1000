// demand.rs — residential, commercial, and industrial demand simulation.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use crate::buildings::{get_building_template, BuildingStatus};
use crate::occupants::Occupant;
use crate::state::{DemandStats, GameState};
use crate::wilderness::{demand_delta, WildernessTunables};
use city_sim_protocol::building_kind::BuildingKind;

/// Population and job capacity totals — extracted from the city count so
/// the simulation driver can use them for population growth without a second
/// pass through all tiles and buildings.
pub struct CityCapacity {
    pub population: u32,
    pub jobs: u32,
}

/// Compute current capacity totals from active/pending zone buildings.
pub fn count_city_capacity(state: &GameState) -> CityCapacity {
    let c = count_city(state);
    CityCapacity {
        population: c.population_capacity,
        jobs: c.job_capacity,
    }
}

// ---------------------------------------------------------------------------
// Constants (from `app/src/game/demand.ts` and `constants.ts`)
// ---------------------------------------------------------------------------

const PENDING_PENALTY_MAX: f32 = 35.0;
const PENDING_PENALTY_BASE_FRACTION: f32 = 0.6;
const DEMAND_FLOOR: f32 = 8.0;
const FLOOR_FILL_THRESHOLD: f32 = 0.92;
const PRESSURE_THRESHOLD: f32 = 60.0;
const PRESSURE_RELIEF_FACTOR: f32 = 0.5;
const DEFAULT_WORKER_SHARE: f32 = 0.55;

// ---------------------------------------------------------------------------
// Labour stats (mirrors `computeLabourStats.ts`)
// ---------------------------------------------------------------------------

pub struct LabourStats {
    pub population: f32,
    pub res_capacity: f32,
    pub job_capacity: f32,
    pub workers: f32,
    pub employed: f32,
    pub unemployed: f32,
    pub unemployment_rate: f32,
    pub vacancy_rate: f32,
}

pub fn compute_labour_stats(population: f32, res_capacity: f32, job_capacity: f32) -> LabourStats {
    let workers = (population * DEFAULT_WORKER_SHARE).max(0.0);
    let employed = workers.min(job_capacity);
    let unemployed = (workers - job_capacity).max(0.0);
    let unemployment_rate = if workers == 0.0 {
        0.0
    } else {
        unemployed / workers
    };
    let vacancy_rate = if job_capacity == 0.0 {
        1.0
    } else {
        ((job_capacity - employed) / job_capacity).max(0.0)
    };
    LabourStats {
        population,
        res_capacity,
        job_capacity,
        workers,
        employed,
        unemployed,
        unemployment_rate,
        vacancy_rate,
    }
}

// ---------------------------------------------------------------------------
// DemandInput / compute_demand (mirrors `demand.ts`)
// ---------------------------------------------------------------------------

pub struct DemandInput {
    pub base: f32,
    pub fill_fraction: f32,
    pub workforce_term: f32,
    pub labour_term: f32,
    pub pending_zones: f32,
    pub pending_slope: f32,
    pub utility_penalty: f32,
    pub seeded: bool,
    pub seeded_value: f32,
    pub pending_penalty_enabled: bool,
    pub floor_override: Option<f32>,
}

pub fn compute_demand(i: &DemandInput) -> f32 {
    if i.seeded {
        return i.seeded_value;
    }

    let fill_term = i.base * (1.0 - i.fill_fraction);
    let base_demand = fill_term + i.workforce_term + i.labour_term;

    let pending_penalty_raw = if i.pending_penalty_enabled {
        i.pending_zones * i.pending_slope
    } else {
        0.0
    };
    let pending_penalty_capped = if i.pending_penalty_enabled {
        pending_penalty_raw
            .min(base_demand * PENDING_PENALTY_BASE_FRACTION)
            .min(PENDING_PENALTY_MAX)
    } else {
        0.0
    };
    let pressure_relief = (base_demand - PRESSURE_THRESHOLD).max(0.0) * PRESSURE_RELIEF_FACTOR;
    let pending_penalty_applied = (pending_penalty_capped - pressure_relief).max(0.0);
    let demand_after_penalty = base_demand - pending_penalty_applied;

    let demand_before_utilities = match i.floor_override {
        Some(fo) => demand_after_penalty.max(fo),
        None => {
            if i.fill_fraction < FLOOR_FILL_THRESHOLD {
                demand_after_penalty.max(DEMAND_FLOOR)
            } else {
                demand_after_penalty
            }
        }
    };

    (demand_before_utilities - i.utility_penalty).clamp(0.0, 100.0)
}

// ---------------------------------------------------------------------------
// compute_city_demand — assembles inputs from GameState and calls the above
// ---------------------------------------------------------------------------

/// Zone & capacity counters accumulated from one tile+building pass.
struct CityCounters {
    residential_zones: u32,
    developed_residential_zones: u32,
    commercial_zones: u32,
    developed_commercial_zones: u32,
    industrial_zones: u32,
    developed_industrial_zones: u32,
    population_capacity: u32,
    job_capacity: u32,
    commercial_job_capacity: u32,
    industrial_job_capacity: u32,
}

fn count_city(state: &GameState) -> CityCounters {
    let mut c = CityCounters {
        residential_zones: 0,
        developed_residential_zones: 0,
        commercial_zones: 0,
        developed_commercial_zones: 0,
        industrial_zones: 0,
        developed_industrial_zones: 0,
        population_capacity: 0,
        job_capacity: 0,
        commercial_job_capacity: 0,
        industrial_job_capacity: 0,
    };

    // Zones are mutually exclusive, so "which zone is this?" has one answer —
    // but it is answered through `zone_occupant()` rather than off `kind` so
    // step 3 of #177 can narrow `kind` to terrain without silently zeroing the
    // demand inputs.
    for tile in &state.tiles {
        let (zoned, developed) = match tile.zone_occupant() {
            Some(Occupant::ZoneResidential) => {
                (&mut c.residential_zones, &mut c.developed_residential_zones)
            }
            Some(Occupant::ZoneCommercial) => {
                (&mut c.commercial_zones, &mut c.developed_commercial_zones)
            }
            Some(Occupant::ZoneIndustrial) => {
                (&mut c.industrial_zones, &mut c.developed_industrial_zones)
            }
            _ => continue,
        };
        *zoned += 1;
        if tile.building_id.is_some() {
            *developed += 1;
        }
    }

    for building in &state.buildings {
        let Some(tmpl) = get_building_template(building.kind) else {
            continue;
        };
        // Capacity counts when active OR when inactive due to power/water (still occupies slot)
        let contributes = building.status == BuildingStatus::Active
            || (tmpl.is_zone
                && matches!(
                    building.status,
                    BuildingStatus::InactiveNoPower | BuildingStatus::InactiveNoWater
                ));
        if !contributes {
            continue;
        }
        c.population_capacity += tmpl.population_capacity;
        c.job_capacity += tmpl.jobs_capacity;
        if building.kind == BuildingKind::Commercial {
            c.commercial_job_capacity += tmpl.jobs_capacity;
        }
        if building.kind == BuildingKind::Industrial {
            c.industrial_job_capacity += tmpl.jobs_capacity;
        }
    }

    c
}

/// Compute `DemandStats` from the current `GameState` — matches the demand
/// assembly block in `simulation.ts:tick()`.
///
/// Education is stubbed to 0 until P3-8 (score=0, high_coverage=0).
pub fn compute_city_demand(state: &GameState) -> DemandStats {
    let c = count_city(state);

    let pop = state.population as f32;
    let jobs = state.jobs as f32;
    let pop_cap = c.population_capacity as f32;
    let job_cap = c.job_capacity as f32;
    let com_cap = c.commercial_job_capacity as f32;
    let ind_cap = c.industrial_job_capacity as f32;

    let labour = compute_labour_stats(pop, pop_cap, job_cap);

    let seeded = state.population == 0 && state.jobs == 0;

    let education_score = state.education.score;
    let high_coverage = state.education.high_coverage;
    let education_demand_delta = education_score * 4.0 - (1.0 - education_score) * 12.0;
    let workforce_penalty = (1.0 - high_coverage) * 20.0;

    let utility_penalty = (if state.utilities.power < 0 { 15.0 } else { 0.0 })
        + (if state.utilities.water < 0 { 15.0 } else { 0.0 });

    // Fill fractions
    let fill_residential = if pop_cap > 0.0 {
        (pop / pop_cap).min(1.0)
    } else {
        0.0
    };
    let jobs_in_commercial = if job_cap > 0.0 {
        (com_cap / job_cap.max(1.0)) * jobs
    } else {
        0.0
    };
    let jobs_in_industrial = if job_cap > 0.0 {
        (ind_cap / job_cap.max(1.0)) * jobs
    } else {
        0.0
    };
    let fill_commercial = if com_cap > 0.0 {
        (jobs_in_commercial / com_cap).min(1.0)
    } else {
        1.0
    };
    let fill_industrial = if ind_cap > 0.0 {
        (jobs_in_industrial / ind_cap).min(1.0)
    } else {
        1.0
    };

    // Pending (undeveloped) zones
    let pending_residential = (c
        .residential_zones
        .saturating_sub(c.developed_residential_zones)) as f32;
    let pending_commercial = (c
        .commercial_zones
        .saturating_sub(c.developed_commercial_zones)) as f32;
    let pending_industrial = (c
        .industrial_zones
        .saturating_sub(c.developed_industrial_zones)) as f32;

    // pendingPenaltyEnabled is stored in GameSettings — not yet ported (P3-9+);
    // default to true matching createDefaultSettings().
    let pending_penalty_enabled = true;

    // Fiscal policy pressure — taxes above the 9% neutral rate suppress that
    // zone class's demand (2 points per percentage point, and a matching
    // boost below 9%); underfunded transport frustrates commuters and drags
    // all three classes (up to 8 points at 0% funding). All terms are exactly
    // 0.0 at the neutral defaults.
    const NEUTRAL_TAX: f32 = 9.0;
    const TAX_DEMAND_SLOPE: f32 = 2.0;
    const TRANSPORT_DRAG_SLOPE: f32 = 0.08;
    let tax_penalty_res =
        (state.policies.budget.tax_residential as f32 - NEUTRAL_TAX) * TAX_DEMAND_SLOPE;
    let tax_penalty_com =
        (state.policies.budget.tax_commercial as f32 - NEUTRAL_TAX) * TAX_DEMAND_SLOPE;
    let tax_penalty_ind =
        (state.policies.budget.tax_industrial as f32 - NEUTRAL_TAX) * TAX_DEMAND_SLOPE;
    let transport_drag =
        (100.0 - state.policies.budget.fund_transport as f32) * TRANSPORT_DRAG_SLOPE;

    // Wilderness pull — a green city attracts residents, a paved one repels
    // them (±demand_weight at the score extremes, 0 at the neutral 50).
    let wilderness_pull = demand_delta(state.wilderness.score, &WildernessTunables::default());

    let residential = compute_demand(&DemandInput {
        base: 70.0,
        fill_fraction: fill_residential,
        workforce_term: 0.0,
        labour_term: labour.vacancy_rate * 60.0 - labour.unemployment_rate * 80.0
            + education_demand_delta
            + wilderness_pull
            - tax_penalty_res
            - transport_drag,
        pending_zones: pending_residential,
        pending_slope: 0.45,
        utility_penalty,
        seeded,
        seeded_value: 50.0,
        pending_penalty_enabled,
        floor_override: None,
    });

    let commercial = compute_demand(&DemandInput {
        base: 50.0,
        fill_fraction: fill_commercial,
        workforce_term: labour.unemployment_rate * 30.0 + (pop / pop_cap.max(1.0)).min(1.0) * 20.0
            - workforce_penalty * 0.6
            - tax_penalty_com
            - transport_drag,
        labour_term: 0.0,
        pending_zones: pending_commercial,
        pending_slope: 0.35,
        utility_penalty: utility_penalty * 0.5,
        seeded,
        seeded_value: 30.0,
        pending_penalty_enabled,
        floor_override: None,
    });

    let industrial = compute_demand(&DemandInput {
        base: 55.0,
        fill_fraction: fill_industrial,
        workforce_term: labour.unemployment_rate * 80.0
            + (0.95_f32 - fill_industrial).max(0.0) * 20.0
            - workforce_penalty
            - tax_penalty_ind
            - transport_drag,
        labour_term: labour.vacancy_rate * -5.0,
        pending_zones: pending_industrial,
        pending_slope: 0.35,
        utility_penalty: utility_penalty * 0.5,
        seeded,
        seeded_value: 30.0,
        pending_penalty_enabled,
        floor_override: if fill_industrial >= 0.95 {
            Some(5.0)
        } else {
            None
        },
    });

    DemandStats {
        residential,
        commercial,
        industrial,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn input(base: f32, fill: f32, pending: f32) -> DemandInput {
        DemandInput {
            base,
            fill_fraction: fill,
            workforce_term: 0.0,
            labour_term: 0.0,
            pending_zones: pending,
            pending_slope: 0.35,
            utility_penalty: 0.0,
            seeded: false,
            seeded_value: 50.0,
            pending_penalty_enabled: true,
            floor_override: None,
        }
    }

    #[test]
    fn seeded_returns_seeded_value() {
        let i = DemandInput {
            seeded: true,
            seeded_value: 42.0,
            ..input(70.0, 0.5, 0.0)
        };
        assert_eq!(compute_demand(&i), 42.0);
    }

    #[test]
    fn empty_city_fills_from_base() {
        // 0% fill → fill_term = base; no pending penalty; should be near base (clamped)
        let v = compute_demand(&input(70.0, 0.0, 0.0));
        // fill_term = 70*(1-0) = 70; no labour/pending → demand = max(70, floor=8) = 70
        assert!((v - 70.0).abs() < 0.01, "expected ~70, got {v}");
    }

    #[test]
    fn full_city_has_low_demand() {
        // 100% fill → fill_term = 0; demand should hit the floor (8) or lower
        let i = input(70.0, 1.0, 0.0);
        let v = compute_demand(&i);
        // fill >= FLOOR_FILL_THRESHOLD → no floor applied; demand could be 0
        assert!(
            v <= DEMAND_FLOOR,
            "demand {v} should be at most floor {DEMAND_FLOOR}"
        );
    }

    #[test]
    fn pending_zones_reduce_demand() {
        let without = compute_demand(&input(70.0, 0.0, 0.0));
        let with_pending = compute_demand(&input(70.0, 0.0, 20.0));
        assert!(with_pending < without, "pending zones should reduce demand");
    }

    #[test]
    fn utility_penalty_reduces_demand() {
        let without = compute_demand(&input(70.0, 0.5, 0.0));
        let with_penalty = DemandInput {
            utility_penalty: 15.0,
            ..input(70.0, 0.5, 0.0)
        };
        let v = compute_demand(&with_penalty);
        assert!(v < without, "utility penalty should reduce demand");
    }

    #[test]
    fn demand_clamped_to_zero_to_hundred() {
        let high = DemandInput {
            base: 200.0,
            ..input(0.0, 0.0, 0.0)
        };
        assert!(compute_demand(&high) <= 100.0);
        let low = DemandInput {
            utility_penalty: 200.0,
            ..input(70.0, 0.5, 0.0)
        };
        assert!(compute_demand(&low) >= 0.0);
    }

    #[test]
    fn compute_city_demand_on_empty_state() {
        let s = GameState::new(4, 4, 0);
        let d = compute_city_demand(&s);
        // New city: pop=12, jobs=4, no zones, no buildings → seeded=false;
        // residential base=70, fill=0 → demand high; commercial/industrial less so
        assert!(d.residential > 0.0, "residential demand should be positive");
        assert!(d.commercial >= 0.0);
        assert!(d.industrial >= 0.0);
    }

    #[test]
    fn labour_stats_basic() {
        let l = compute_labour_stats(100.0, 100.0, 40.0);
        assert_eq!(l.workers, 55.0); // 100 * 0.55
        assert_eq!(l.employed, 40.0); // min(55, 40)
        assert!((l.unemployment_rate - 15.0 / 55.0).abs() < 0.001);
    }

    #[test]
    fn labour_stats_no_jobs() {
        let l = compute_labour_stats(50.0, 100.0, 0.0);
        assert_eq!(l.vacancy_rate, 1.0, "vacancy is 1 when job_capacity=0");
        assert_eq!(l.unemployment_rate, 1.0);
    }

    #[test]
    fn labour_stats_no_workers() {
        let l = compute_labour_stats(0.0, 0.0, 10.0);
        assert_eq!(l.unemployment_rate, 0.0, "unemployment=0 when no workers");
    }
}
