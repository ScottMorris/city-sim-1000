// education.rs — school coverage and zone education stat updates.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use crate::buildings::{get_building_template, BuildingStatus};
use crate::occupants::Occupant;
use crate::state::{EducationStats, GameState, ServiceKind};
use city_sim_protocol::tile_kind::TileKind;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};

// ---------------------------------------------------------------------------
// Zone load maps (mirrors `computeZoneLoads` in serviceDistribution.ts)
// ---------------------------------------------------------------------------

const DEFAULT_WORKER_SHARE: f32 = 0.55;

struct ZoneLoads {
    population: HashMap<usize, f32>,
    jobs: HashMap<usize, f32>,
}

fn compute_zone_loads(state: &GameState) -> ZoneLoads {
    let mut total_pop_cap = 0_u32;
    let mut total_com_cap = 0_u32;
    let mut total_ind_cap = 0_u32;

    for b in &state.buildings {
        let Some(tmpl) = get_building_template(b.kind) else {
            continue;
        };
        if b.status != BuildingStatus::Active || !tmpl.is_zone {
            continue;
        }
        total_pop_cap += tmpl.population_capacity;
        match b.kind {
            TileKind::Commercial => total_com_cap += tmpl.jobs_capacity,
            TileKind::Industrial => total_ind_cap += tmpl.jobs_capacity,
            _ => {}
        }
    }

    let total_job_cap = total_com_cap + total_ind_cap;
    let jobs_in_commercial = if total_job_cap > 0 {
        (total_com_cap as f32 / total_job_cap as f32) * state.jobs as f32
    } else {
        0.0
    };
    let jobs_in_industrial = if total_job_cap > 0 {
        (total_ind_cap as f32 / total_job_cap as f32) * state.jobs as f32
    } else {
        0.0
    };

    let mut population = HashMap::new();
    let mut jobs = HashMap::new();

    for b in &state.buildings {
        let Some(tmpl) = get_building_template(b.kind) else {
            continue;
        };
        if b.status != BuildingStatus::Active || !tmpl.is_zone {
            continue;
        }
        let idx = (b.origin.1 * state.width + b.origin.0) as usize;

        if tmpl.population_capacity > 0 {
            let share = if total_pop_cap > 0 {
                (tmpl.population_capacity as f32 / total_pop_cap as f32) * state.population as f32
            } else {
                0.0
            };
            population.insert(idx, share);
        }

        if tmpl.jobs_capacity > 0 {
            let share = match b.kind {
                TileKind::Commercial => {
                    if total_com_cap > 0 {
                        (tmpl.jobs_capacity as f32 / total_com_cap as f32) * jobs_in_commercial
                    } else {
                        0.0
                    }
                }
                TileKind::Industrial => {
                    if total_ind_cap > 0 {
                        (tmpl.jobs_capacity as f32 / total_ind_cap as f32) * jobs_in_industrial
                    } else {
                        0.0
                    }
                }
                _ => {
                    // Residential with jobs_capacity (rare): use worker share of pop slice
                    population.get(&idx).copied().unwrap_or(0.0) * DEFAULT_WORKER_SHARE
                }
            };
            jobs.insert(idx, share);
        } else if tmpl.population_capacity > 0 {
            // Residential: derive job load from worker share of population slice
            let pop_share = population.get(&idx).copied().unwrap_or(0.0);
            jobs.insert(idx, pop_share * DEFAULT_WORKER_SHARE);
        }
    }

    ZoneLoads { population, jobs }
}

// ---------------------------------------------------------------------------
// Reachable zone candidates BFS (mirrors `getReachableZoneCandidates`)
// ---------------------------------------------------------------------------

/// BFS from a school's footprint, travelling along roads and zones up to
/// `radius` steps.  Returns candidates sorted closest-first.
fn reachable_zone_candidates(
    state: &GameState,
    ox: u32,
    oy: u32,
    fw: u32,
    fh: u32,
    radius: u32,
) -> Vec<(usize, u32)> {
    // (distance, tile_index) — min-heap by distance
    let mut heap: BinaryHeap<Reverse<(u32, usize)>> = BinaryHeap::new();
    let mut visited: HashSet<usize> = HashSet::new();
    let mut reachable: HashMap<usize, u32> = HashMap::new();

    // Seed from all footprint tiles
    for dy in 0..fh {
        for dx in 0..fw {
            if let Some(idx) = state.tile_index(ox + dx, oy + dy) {
                heap.push(Reverse((0, idx)));
            }
        }
    }

    while let Some(Reverse((d, idx))) = heap.pop() {
        if !visited.insert(idx) {
            continue;
        }
        if d > radius {
            continue;
        }

        let x = (idx as u32) % state.width;
        let y = (idx as u32) / state.width;
        let tile = &state.tiles[idx];

        // "Is there a road here?" is a multi-valued question — a level
        // crossing and a road under a hydro line both carry one without owning
        // `kind` — so it goes through the occupant set. The BFS already asked
        // it correctly by hand; the accessor is what keeps it correct once
        // step 3 of #177 narrows `kind` to terrain.
        let is_road = tile.has_occupant(Occupant::Road);
        let is_zone = tile.zone_occupant().is_some();

        if is_zone {
            reachable
                .entry(idx)
                .and_modify(|e| *e = (*e).min(d))
                .or_insert(d);
        }

        // Travel through roads and zones only (not plain land/other tile kinds)
        if !is_road && !is_zone && d > 0 {
            continue;
        }

        // Orthogonal neighbours
        let nd = d + 1;
        if nd > radius {
            continue;
        }
        for (nx, ny) in neighbours(state, x, y) {
            let nidx = (ny * state.width + nx) as usize;
            if visited.contains(&nidx) {
                continue;
            }
            let ntile = &state.tiles[nidx];
            let n_road = ntile.has_occupant(Occupant::Road);
            let n_zone = ntile.zone_occupant().is_some();
            if n_road || n_zone {
                heap.push(Reverse((nd, nidx)));
            }
        }
    }

    let mut out: Vec<(usize, u32)> = reachable.into_iter().collect();
    out.sort_by_key(|&(idx, d)| (d, idx));
    out
}

fn neighbours(state: &GameState, x: u32, y: u32) -> Vec<(u32, u32)> {
    let mut v = Vec::with_capacity(4);
    if x > 0 {
        v.push((x - 1, y));
    }
    if x + 1 < state.width {
        v.push((x + 1, y));
    }
    if y > 0 {
        v.push((x, y - 1));
    }
    if y + 1 < state.height {
        v.push((x, y + 1));
    }
    v
}

// ---------------------------------------------------------------------------
// recompute_education (mirrors `recomputeEducation` in education.ts)
// ---------------------------------------------------------------------------

/// Recompute education coverage and write per-tile served/score flags.
///
/// Call after `update_building_states` each tick (so school status is current).
/// Updates `state.education` in place.
pub fn recompute_education(state: &mut GameState) {
    // --- reset tile service flags ---
    for tile in &mut state.tiles {
        tile.elementary_served = false;
        tile.high_served = false;
        tile.elementary_score = 0.0;
        tile.high_score = 0.0;
    }

    let loads = compute_zone_loads(state);

    // --- accumulate total loads ---
    let mut elementary_load = 0.0_f32;
    let mut high_load = 0.0_f32;
    for (idx, tile) in state.tiles.iter().enumerate() {
        if tile.zone_occupant().is_none() {
            continue;
        }
        elementary_load += loads.population.get(&idx).copied().unwrap_or(0.0);
        high_load += loads
            .jobs
            .get(&idx)
            .copied()
            .or_else(|| {
                loads
                    .population
                    .get(&idx)
                    .map(|&p| p * DEFAULT_WORKER_SHARE)
            })
            .unwrap_or(0.0);
    }

    // --- service pass for each active school building ---
    let mut elementary_served_total = 0.0_f32;
    let mut elementary_capacity = 0.0_f32;
    let mut high_served_total = 0.0_f32;
    let mut high_capacity = 0.0_f32;

    let n_buildings = state.buildings.len();
    for i in 0..n_buildings {
        if state.buildings[i].status != BuildingStatus::Active {
            continue;
        }
        let kind = state.buildings[i].kind;
        let Some(tmpl) = get_building_template(kind) else {
            continue;
        };
        if tmpl.service == ServiceKind::None || tmpl.service_capacity == 0 {
            continue;
        }
        let (ox, oy) = state.buildings[i].origin;
        let (fw, fh) = tmpl.footprint;
        let svc = tmpl.service;
        // Underfunded civic departments crowd the schools: capacity scales
        // with the civic funding level (100% → full capacity, exact).
        let capacity = tmpl.service_capacity as f32
            * city_sim_protocol::commands::BudgetPolicy::funding_multiplier(
                state.policies.budget.fund_civic,
            );
        let radius = tmpl.service_coverage;

        if svc == ServiceKind::EducationElementary {
            elementary_capacity += capacity;
        }
        if svc == ServiceKind::EducationHigh {
            high_capacity += capacity;
        }

        let candidates = reachable_zone_candidates(state, ox, oy, fw, fh, radius);

        let mut used = 0.0_f32;
        for (cidx, _dist) in candidates {
            if used >= capacity {
                break;
            }
            // Redundant — `reachable_zone_candidates` files only zoned tiles —
            // but kept because `education.ts` re-checks here too and the two
            // are held to parity.
            if state.tiles[cidx].zone_occupant().is_none() {
                continue;
            }
            let load = if svc == ServiceKind::EducationElementary {
                loads.population.get(&cidx).copied().unwrap_or(0.0)
            } else {
                loads
                    .jobs
                    .get(&cidx)
                    .copied()
                    .or_else(|| {
                        loads
                            .population
                            .get(&cidx)
                            .map(|&p| p * DEFAULT_WORKER_SHARE)
                    })
                    .unwrap_or(0.0)
            };
            if load <= 0.0 {
                continue;
            }
            let remaining = (capacity - used).max(0.0);
            if remaining <= 0.0 {
                break;
            }
            let applied = load.min(remaining);
            used += applied;
            let score = applied / load;
            if svc == ServiceKind::EducationElementary {
                state.tiles[cidx].elementary_served = true;
                state.tiles[cidx].elementary_score = score;
                elementary_served_total += applied;
            } else {
                state.tiles[cidx].high_served = true;
                state.tiles[cidx].high_score = score;
                high_served_total += applied;
            }
        }
    }

    let elementary_coverage = if elementary_load > 0.0 {
        (elementary_served_total / elementary_load).clamp(0.0, 1.0)
    } else {
        1.0
    };
    let high_coverage = if high_load > 0.0 {
        (high_served_total / high_load).clamp(0.0, 1.0)
    } else {
        1.0
    };
    let score = (elementary_coverage * 0.6 + high_coverage * 0.4).clamp(0.0, 1.0);

    state.education = EducationStats {
        elementary_served: elementary_served_total,
        elementary_capacity,
        elementary_load,
        high_served: high_served_total,
        high_capacity,
        high_load,
        score,
        elementary_coverage,
        high_coverage,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buildings::{update_building_states, BuildingInstance};
    use crate::state::FLAG_POWERED;

    fn gs(w: u32, h: u32) -> GameState {
        GameState::new(w, h, 0)
    }

    fn place_building(s: &mut GameState, kind: TileKind, ox: u32, oy: u32) -> u32 {
        let id = s.next_building_id;
        let tmpl = get_building_template(kind).unwrap();
        let (fw, fh) = tmpl.footprint;
        for dy in 0..fh {
            for dx in 0..fw {
                let tile = s.tile_at_mut(ox + dx, oy + dy).unwrap();
                tile.kind = kind;
                tile.building_id = Some(id as u16);
                tile.set_flag(FLAG_POWERED, true);
            }
        }
        s.buildings.push(BuildingInstance::new(id, kind, (ox, oy)));
        s.next_building_id += 1;
        id
    }

    #[test]
    fn no_schools_gives_full_coverage_by_default() {
        let mut s = gs(4, 4);
        s.tile_at_mut(0, 0).unwrap().kind = TileKind::Residential;
        s.population = 50;
        recompute_education(&mut s);
        // No schools → load = 0 → coverage = 1 (TS behaviour)
        assert_eq!(s.education.elementary_coverage, 1.0);
        assert_eq!(s.education.high_coverage, 1.0);
        assert!((s.education.score - 1.0).abs() < 0.001);
    }

    #[test]
    fn active_school_covers_adjacent_zone() {
        // Layout: [School(0,0)(1,0)] [Road(2,0)] [Res(3,0)]
        //         [School(0,1)(1,1)] ...
        let mut s = gs(6, 2);
        place_building(&mut s, TileKind::ElementarySchool, 0, 0);
        s.tile_at_mut(2, 0).unwrap().kind = TileKind::Road;
        s.tile_at_mut(3, 0).unwrap().kind = TileKind::Residential;
        s.tile_at_mut(3, 0).unwrap().set_flag(FLAG_POWERED, true);
        // Place a residential zone building so it has load
        place_building(&mut s, TileKind::Residential, 3, 0);
        s.population = 14;
        update_building_states(&mut s, false);
        recompute_education(&mut s);
        // The residential tile should be reached (school radius=8)
        let tile = s.tile_at(3, 0).unwrap();
        assert!(
            tile.elementary_served,
            "residential should be served by nearby school"
        );
        assert!(s.education.elementary_coverage > 0.0);
    }

    #[test]
    fn inactive_school_does_not_serve() {
        let mut s = gs(4, 4);
        place_building(&mut s, TileKind::ElementarySchool, 0, 0);
        // Make school inactive (no power)
        for dx in 0..2 {
            for dy in 0..2 {
                s.tile_at_mut(dx, dy).unwrap().set_flag(FLAG_POWERED, false);
            }
        }
        update_building_states(&mut s, false);
        s.tile_at_mut(3, 0).unwrap().kind = TileKind::Residential;
        place_building(&mut s, TileKind::Residential, 3, 0);
        s.population = 14;
        recompute_education(&mut s);
        // School is inactive → no coverage (but load=0 still gives coverage=1 if no active buildings)
        // After placing a zone building, load > 0 but school is inactive
        let tile = s.tile_at(3, 0).unwrap();
        assert!(!tile.elementary_served, "inactive school should not serve");
    }

    #[test]
    fn score_formula_matches_ts() {
        // score = elementary_coverage * 0.6 + high_coverage * 0.4
        let mut s = gs(2, 2);
        recompute_education(&mut s);
        // No load → both coverages = 1.0 → score = 1.0
        assert!((s.education.score - 1.0).abs() < 0.001);
    }

    #[test]
    fn zone_load_is_zero_without_buildings() {
        let mut s = gs(4, 4);
        s.tile_at_mut(0, 0).unwrap().kind = TileKind::Residential;
        s.population = 50;
        let loads = compute_zone_loads(&s);
        // No active zone buildings → no load entries
        assert!(loads.population.is_empty());
        assert!(loads.jobs.is_empty());
    }

    #[test]
    fn high_school_covers_commercial() {
        // Layout: [HighSchool(0,0)(1,0)] [Road(2,0)] [Com(3,0)]
        //         [HighSchool(0,1)(1,1)]
        let mut s = gs(6, 2);
        place_building(&mut s, TileKind::HighSchool, 0, 0);
        s.tile_at_mut(2, 0).unwrap().kind = TileKind::Road;
        s.tile_at_mut(3, 0).unwrap().kind = TileKind::Commercial;
        s.tile_at_mut(3, 0).unwrap().set_flag(FLAG_POWERED, true);
        place_building(&mut s, TileKind::Commercial, 3, 0);
        s.jobs = 8;
        update_building_states(&mut s, false);
        recompute_education(&mut s);
        let tile = s.tile_at(3, 0).unwrap();
        assert!(
            tile.high_served,
            "commercial should be served by high school"
        );
        assert!(s.education.high_coverage > 0.0);
    }
}
