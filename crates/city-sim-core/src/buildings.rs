// buildings.rs — building templates, placement, status updates, and decay.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use crate::adjacency::{tile_has_power, tile_has_water};
use crate::state::{GameState, ServiceKind, FLAG_ABANDONED};
use city_sim_protocol::tile_kind::TileKind;

// ---------------------------------------------------------------------------
// BuildingStatus
// ---------------------------------------------------------------------------

/// Runtime status of a building.  Mirrors `BuildingStatus` in
/// `app/src/game/buildings/state.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum BuildingStatus {
    Active,
    InactiveNoPower,
    InactiveNoWater,
    InactiveDamaged,
}

// ---------------------------------------------------------------------------
// BuildingTemplate (static per-kind data)
// ---------------------------------------------------------------------------

/// Static properties of a building kind.  Mirrors the `BuildingTemplate`
/// interface in `buildings/templates.ts`.
///
/// Values are taken directly from the TS static template objects.
pub struct BuildingTemplate {
    pub footprint: (u32, u32), // (width, height) in tiles
    pub requires_power: bool,
    pub requires_water: bool,
    pub water_use: f32,    // kL/day consumed (demand side)
    pub water_output: i32, // kL/day produced (supply side, 0 if not a source)
    pub power_use: f32,    // MW consumed when active
    pub population_capacity: u32,
    pub jobs_capacity: u32,
    pub maintenance: f32, // $/day
    pub is_zone: bool,
    pub is_power_plant: bool,
    pub is_civic: bool,
    /// Which city service this building provides (None for non-service buildings).
    pub service: ServiceKind,
    /// Maximum load units this service building can satisfy per tick.
    pub service_capacity: u32,
    /// BFS radius (tiles) along roads/zones that this service can reach.
    pub service_coverage: u32,
}

/// Look up static template data by the tile kind used when placing a building.
///
/// Returns `None` for non-building tile kinds (Land, Road, etc.).
pub fn get_building_template(kind: TileKind) -> Option<&'static BuildingTemplate> {
    use TileKind::*;
    macro_rules! tmpl {
        ($fp:expr, pwr=$p:expr, wat=$w:expr, wu=$wu:expr, wo=$wo:expr,
         pu=$pu:expr, pop=$pop:expr, jobs=$j:expr, maint=$m:expr,
         zone=$z:expr, plant=$pl:expr, civic=$cv:expr,
         svc=$svc:expr, scap=$scap:expr, scov=$scov:expr) => {
            BuildingTemplate {
                footprint: $fp,
                requires_power: $p,
                requires_water: $w,
                water_use: $wu,
                water_output: $wo,
                power_use: $pu,
                population_capacity: $pop,
                jobs_capacity: $j,
                maintenance: $m,
                is_zone: $z,
                is_power_plant: $pl,
                is_civic: $cv,
                service: $svc,
                service_capacity: $scap,
                service_coverage: $scov,
            }
        };
    }

    // Mirrors TS ZONE_BUILDING_TEMPLATES
    static RESIDENTIAL: BuildingTemplate = tmpl! {
        (1,1), pwr=true,  wat=true,  wu=1.0,  wo=0,  pu=1.5,
        pop=14, jobs=0,  maint=1.0,    zone=true,  plant=false, civic=false,
        svc=ServiceKind::None, scap=0, scov=0
    };
    static COMMERCIAL: BuildingTemplate = tmpl! {
        (1,1), pwr=true,  wat=true,  wu=1.5,  wo=0,  pu=2.5,
        pop=0,  jobs=8,  maint=1.2,    zone=true,  plant=false, civic=false,
        svc=ServiceKind::None, scap=0, scov=0
    };
    static INDUSTRIAL: BuildingTemplate = tmpl! {
        (1,1), pwr=true,  wat=true,  wu=2.0,  wo=0,  pu=3.0,
        pop=0,  jobs=12, maint=1.4,    zone=true,  plant=false, civic=false,
        svc=ServiceKind::None, scap=0, scov=0
    };
    // Mirrors TS CIVIC_BUILDING_TEMPLATES
    static WATER_PUMP: BuildingTemplate = tmpl! {
        (1,1), pwr=true,  wat=false, wu=0.0,  wo=50, pu=0.0,
        pop=0,  jobs=0,  maint=5.0,    zone=false, plant=false, civic=true,
        svc=ServiceKind::None, scap=0, scov=0
    };
    static WATER_TOWER: BuildingTemplate = tmpl! {
        (2,2), pwr=true,  wat=false, wu=0.0,  wo=120, pu=0.0,
        pop=0,  jobs=0,  maint=12.0,   zone=false, plant=false, civic=true,
        svc=ServiceKind::None, scap=0, scov=0
    };
    static PARK: BuildingTemplate = tmpl! {
        (1,1), pwr=false, wat=false, wu=0.0,  wo=0,  pu=0.0,
        pop=0,  jobs=0,  maint=0.05,   zone=false, plant=false, civic=true,
        svc=ServiceKind::None, scap=0, scov=0
    };
    // Elementary school: capacity=180, radius=8 (from services.ts DEFAULT_SERVICE_DEFINITIONS)
    static ELEM_SCHOOL: BuildingTemplate = tmpl! {
        (2,2), pwr=true,  wat=false, wu=0.0,  wo=0,  pu=4.0,
        pop=0,  jobs=0,  maint=40.0,   zone=false, plant=false, civic=true,
        svc=ServiceKind::EducationElementary, scap=180, scov=8
    };
    // High school: capacity=160, radius=9
    static HIGH_SCHOOL: BuildingTemplate = tmpl! {
        (2,2), pwr=true,  wat=false, wu=0.0,  wo=0,  pu=5.0,
        pop=0,  jobs=0,  maint=55.0,   zone=false, plant=false, civic=true,
        svc=ServiceKind::EducationHigh, scap=160, scov=9
    };
    // Mirrors TS POWER_PLANT_TEMPLATES (all share HydroPlant tile kind; per-type
    // MW output and maintenance are passed at placement time and stored in
    // BuildingInstance so they survive past the single-template lookup).
    static HYDRO_PLANT: BuildingTemplate = tmpl! {
        (2,2), pwr=false, wat=false, wu=0.0,  wo=0,  pu=0.0,
        pop=0,  jobs=0,  maint=150.0,  zone=false, plant=true,  civic=false,
        svc=ServiceKind::None, scap=0, scov=0
    };

    match kind {
        Residential => Some(&RESIDENTIAL),
        Commercial => Some(&COMMERCIAL),
        Industrial => Some(&INDUSTRIAL),
        WaterPump => Some(&WATER_PUMP),
        WaterTower => Some(&WATER_TOWER),
        Park => Some(&PARK),
        ElementarySchool => Some(&ELEM_SCHOOL),
        HighSchool => Some(&HIGH_SCHOOL),
        HydroPlant => Some(&HYDRO_PLANT),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Power plant output constants (mirrors TS POWER_PLANT_CONFIGS outputMw)
// ---------------------------------------------------------------------------

pub const HYDRO_PLANT_MW: u32 = 60;
pub const COAL_PLANT_MW: u32 = 80;
pub const WIND_TURBINE_MW: u32 = 8;
pub const SOLAR_FARM_MW: u32 = 5;

// ---------------------------------------------------------------------------
// BuildingInstance
// ---------------------------------------------------------------------------

/// A placed building in the world.  Mirrors `BuildingInstance` in
/// `app/src/game/buildings/state.ts`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BuildingInstance {
    pub id: u32,
    /// The tile kind used to identify this building (determines template lookup).
    pub kind: TileKind,
    /// Top-left corner of the building footprint.
    pub origin: (u32, u32),
    pub status: BuildingStatus,
    /// 0–100; reaches 0 → InactiveDamaged (not yet implemented in the Rust sim).
    pub health: u8,
    /// Pressure counter — see `apply_building_decay`.  Float to accumulate fractional
    /// increments matching the TS implementation.
    pub trouble_ticks: f32,
    /// Per-building maintenance override in $/day.  Used by power plants so each
    /// type (coal/wind/solar/hydro) can carry its own cost without separate tile
    /// kinds.  Zero means "use the template value".
    #[serde(default)]
    pub maintenance_per_day: f32,
}

impl BuildingInstance {
    pub fn new(id: u32, kind: TileKind, origin: (u32, u32)) -> Self {
        Self {
            id,
            kind,
            origin,
            status: BuildingStatus::Active,
            health: 100,
            trouble_ticks: 0.0,
            maintenance_per_day: 0.0,
        }
    }
}

// ---------------------------------------------------------------------------
// DecayConfig (matches `this.decayConfig` in `simulation.ts`)
// ---------------------------------------------------------------------------

pub struct DecayConfig {
    pub demand_low_threshold: f32,
    pub happiness_threshold: f32,
    pub trouble_increment: f32,
    pub trouble_power_penalty: f32,
    pub trouble_decay: f32,
    pub trouble_abandon_thresh: f32,
}

impl Default for DecayConfig {
    fn default() -> Self {
        Self {
            demand_low_threshold: 5.0,
            happiness_threshold: 0.4,
            trouble_increment: 1.0,
            trouble_power_penalty: 3.0,
            trouble_decay: 2.0,
            trouble_abandon_thresh: 12.0,
        }
    }
}

// ---------------------------------------------------------------------------
// update_building_states
// ---------------------------------------------------------------------------

/// Update `BuildingStatus` for every placed building based on power/water
/// coverage.  Mirrors `updateBuildingStates()` in `manager.ts`.
pub fn update_building_states(state: &mut GameState, water_enabled: bool) {
    for i in 0..state.buildings.len() {
        let bid = state.buildings[i].kind;
        let (ox, oy) = state.buildings[i].origin;
        let health = state.buildings[i].health;

        let Some(tmpl) = get_building_template(bid) else {
            continue;
        };

        if health == 0 {
            state.buildings[i].status = BuildingStatus::InactiveDamaged;
            continue;
        }

        let (w, h) = tmpl.footprint;

        let has_power = if tmpl.requires_power {
            let mut powered_tiles = 0u32;
            for dy in 0..h {
                for dx in 0..w {
                    if tile_has_power(state, ox + dx, oy + dy) {
                        powered_tiles += 1;
                    }
                }
            }
            powered_tiles == w * h
        } else {
            true
        };

        if !has_power {
            state.buildings[i].status = BuildingStatus::InactiveNoPower;
            continue;
        }

        let needs_water = water_enabled && tmpl.requires_water && tmpl.water_use > 0.0;
        if needs_water {
            let mut watered_tiles = 0u32;
            for dy in 0..h {
                for dx in 0..w {
                    if tile_has_water(state, ox + dx, oy + dy) {
                        watered_tiles += 1;
                    }
                }
            }
            state.buildings[i].status = if watered_tiles == w * h {
                BuildingStatus::Active
            } else {
                BuildingStatus::InactiveNoWater
            };
        } else {
            state.buildings[i].status = BuildingStatus::Active;
        }
    }
}

// ---------------------------------------------------------------------------
// apply_building_decay
// ---------------------------------------------------------------------------

/// Increment trouble ticks for zone buildings under stress; abandon those that
/// exceed the threshold.  Mirrors `applyBuildingDecay()` in `simulation.ts`.
/// Called once per fixed simulation tick by `Simulation::tick_fixed()`.
/// All increments are sized for a single tick at `ticks_per_second` (20 tps).
pub fn apply_building_decay(state: &mut GameState, cfg: &DecayConfig) {
    let mut to_abandon: Vec<u32> = Vec::new();

    for i in 0..state.buildings.len() {
        let kind = state.buildings[i].kind;
        let origin = state.buildings[i].origin;
        let status = state.buildings[i].status;

        let Some(tmpl) = get_building_template(kind) else {
            continue;
        };
        if !tmpl.is_zone {
            continue;
        }

        let (ox, oy) = origin;
        let tile_happiness = state
            .tiles
            .get((oy * state.width + ox) as usize)
            .map(|t| t.happiness)
            .unwrap_or(1.0);

        // Inline demand lookup to avoid a second borrow of `state`
        let demand: f32 = match kind {
            TileKind::Residential => state.demand.residential,
            TileKind::Commercial => state.demand.commercial,
            TileKind::Industrial => state.demand.industrial,
            _ => 0.0,
        };

        let no_power = status == BuildingStatus::InactiveNoPower;
        let no_water = status == BuildingStatus::InactiveNoWater;
        let unhappy = tile_happiness < cfg.happiness_threshold;
        // Education pressure: residential needs elementary; all zones need high school.
        let tile_idx = (oy * state.width + ox) as usize;
        let elem_served = state
            .tiles
            .get(tile_idx)
            .map(|t| t.elementary_served)
            .unwrap_or(true);
        let high_served = state
            .tiles
            .get(tile_idx)
            .map(|t| t.high_served)
            .unwrap_or(true);
        let needs_elementary = kind == TileKind::Residential;
        let needs_high = matches!(
            kind,
            TileKind::Residential | TileKind::Commercial | TileKind::Industrial
        );
        let education_unserved = (needs_elementary && !elem_served) || (needs_high && !high_served);

        let low_demand = demand < cfg.demand_low_threshold;
        let mut trouble = state.buildings[i].trouble_ticks;

        if low_demand && (unhappy || no_power || no_water) {
            trouble += cfg.trouble_increment;
        }
        if unhappy && (no_power || no_water) {
            trouble += cfg.trouble_increment;
        }
        if no_power {
            trouble += cfg.trouble_power_penalty;
        }
        if no_water {
            trouble += cfg.trouble_increment * 0.5;
        }
        if education_unserved {
            trouble += cfg.trouble_increment * 0.5;
        }

        // Bleed trouble when physically healthy (power, water, happiness ok).
        // low_demand alone does NOT block decay — see simulation.ts for rationale.
        if !unhappy && !no_power && !no_water {
            trouble = (trouble - cfg.trouble_decay).max(0.0);
            if !education_unserved {
                trouble = (trouble - cfg.trouble_decay * 0.25).max(0.0);
            }
        }

        state.buildings[i].trouble_ticks = trouble;

        if trouble >= cfg.trouble_abandon_thresh {
            to_abandon.push(state.buildings[i].id);
        }
    }

    for bid in to_abandon {
        abandon_zone_building(state, bid);
    }
}

/// Remove a zone building, clearing the tile but preserving the zone kind so
/// the lot can regrow.  Mirrors `abandonZoneBuilding()` in `simulation.ts`.
fn abandon_zone_building(state: &mut GameState, building_id: u32) {
    state.buildings.retain(|b| b.id != building_id);
    for tile in &mut state.tiles {
        if tile.building_id == Some(building_id as u16) {
            tile.building_id = None;
            tile.power_plant_mw = 0;
            tile.set_flag(FLAG_ABANDONED, true);
            tile.happiness = (tile.happiness - 0.1_f32).max(0.1);
        }
    }
    state.tile_revision += 1;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::FLAG_POWERED;

    fn gs(w: u32, h: u32) -> GameState {
        GameState::new(w, h, 0)
    }

    fn place(s: &mut GameState, kind: TileKind, x: u32, y: u32) -> u32 {
        let id = s.next_building_id;
        s.next_building_id += 1;
        let tile = s.tile_at_mut(x, y).unwrap();
        tile.kind = kind;
        tile.building_id = Some(id as u16);
        s.buildings.push(BuildingInstance::new(id, kind, (x, y)));
        s.tile_revision += 1;
        id
    }

    #[test]
    fn zone_building_active_when_powered_and_watered() {
        let mut s = gs(1, 1);
        place(&mut s, TileKind::Residential, 0, 0);
        s.tile_at_mut(0, 0).unwrap().set_flag(FLAG_POWERED, true);
        s.tile_at_mut(0, 0)
            .unwrap()
            .set_flag(crate::state::FLAG_WATERED, true);
        update_building_states(&mut s, true);
        assert_eq!(s.buildings[0].status, BuildingStatus::Active);
    }

    #[test]
    fn zone_building_inactive_no_power() {
        let mut s = gs(1, 1);
        place(&mut s, TileKind::Residential, 0, 0);
        // not powered, not watered
        update_building_states(&mut s, true);
        assert_eq!(s.buildings[0].status, BuildingStatus::InactiveNoPower);
    }

    #[test]
    fn zone_building_inactive_no_water_when_powered_but_not_watered() {
        let mut s = gs(1, 1);
        place(&mut s, TileKind::Residential, 0, 0);
        s.tile_at_mut(0, 0).unwrap().set_flag(FLAG_POWERED, true);
        // not watered
        update_building_states(&mut s, true);
        assert_eq!(s.buildings[0].status, BuildingStatus::InactiveNoWater);
    }

    #[test]
    fn park_active_without_power_or_water() {
        let mut s = gs(1, 1);
        place(&mut s, TileKind::Park, 0, 0);
        update_building_states(&mut s, true);
        assert_eq!(s.buildings[0].status, BuildingStatus::Active);
    }

    #[test]
    fn power_plant_active_without_power_input() {
        let mut s = gs(2, 2);
        let id = s.next_building_id;
        // Place 2×2 hydro plant manually
        for dy in 0..2 {
            for dx in 0..2 {
                let tile = s.tile_at_mut(dx, dy).unwrap();
                tile.kind = TileKind::HydroPlant;
                tile.building_id = Some(id as u16);
            }
        }
        s.buildings
            .push(BuildingInstance::new(id, TileKind::HydroPlant, (0, 0)));
        s.next_building_id += 1;
        update_building_states(&mut s, true);
        assert_eq!(
            s.buildings[0].status,
            BuildingStatus::Active,
            "power plants require no external power"
        );
    }

    #[test]
    fn decay_increments_trouble_on_no_power() {
        let mut s = gs(1, 1);
        place(&mut s, TileKind::Residential, 0, 0);
        s.buildings[0].status = BuildingStatus::InactiveNoPower;
        s.demand.residential = 50.0; // above low threshold — only noPower + education penalty
                                     // Mark tile as education-served so this test isolates the power penalty
        s.tile_at_mut(0, 0).unwrap().elementary_served = true;
        s.tile_at_mut(0, 0).unwrap().high_served = true;
        let cfg = DecayConfig::default();
        apply_building_decay(&mut s, &cfg);
        assert_eq!(s.buildings[0].trouble_ticks, cfg.trouble_power_penalty);
    }

    #[test]
    fn decay_abandons_building_at_threshold() {
        let mut s = gs(1, 1);
        place(&mut s, TileKind::Residential, 0, 0);
        s.buildings[0].status = BuildingStatus::InactiveNoPower;
        let cfg = DecayConfig::default();
        s.buildings[0].trouble_ticks = cfg.trouble_abandon_thresh - 1.0;
        s.demand.residential = 0.0; // low demand — extra pressure
        apply_building_decay(&mut s, &cfg);
        // Building should be abandoned
        assert!(
            s.buildings.is_empty(),
            "building should be removed on abandon"
        );
        assert!(s.tile_at(0, 0).unwrap().building_id.is_none());
        assert!(s.tile_at(0, 0).unwrap().is_abandoned());
    }

    #[test]
    fn decay_bleeds_trouble_when_conditions_are_good() {
        let mut s = gs(1, 1);
        place(&mut s, TileKind::Residential, 0, 0);
        s.buildings[0].status = BuildingStatus::Active;
        s.buildings[0].trouble_ticks = 5.0;
        s.demand.residential = 50.0;
        s.tile_at_mut(0, 0).unwrap().happiness = 1.0; // above threshold
                                                      // Mark tile as education-served so trouble bleeds at the full rate
        s.tile_at_mut(0, 0).unwrap().elementary_served = true;
        s.tile_at_mut(0, 0).unwrap().high_served = true;
        let cfg = DecayConfig::default();
        apply_building_decay(&mut s, &cfg);
        // All conditions good + education served → full bleed: trouble_decay + trouble_decay * 0.25
        let expected = (5.0_f32 - cfg.trouble_decay - cfg.trouble_decay * 0.25).max(0.0);
        assert!((s.buildings[0].trouble_ticks - expected).abs() < 0.001);
    }

    #[test]
    fn get_building_template_returns_none_for_road() {
        assert!(get_building_template(TileKind::Road).is_none());
        assert!(get_building_template(TileKind::Land).is_none());
    }

    #[test]
    fn get_building_template_zone_footprint_is_1x1() {
        for k in [
            TileKind::Residential,
            TileKind::Commercial,
            TileKind::Industrial,
        ] {
            let tmpl = get_building_template(k).unwrap();
            assert_eq!(tmpl.footprint, (1, 1));
            assert!(tmpl.is_zone);
        }
    }
}
