// commands.rs — player tool application; maps SimCommand to tile mutations.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use crate::buildings::{
    get_building_template, BuildingInstance, COAL_PLANT_MW, HYDRO_PLANT_MW, SOLAR_FARM_MW,
    WIND_TURBINE_MW,
};
use crate::state::{
    GameState, FLAG_ABANDONED, FLAG_POWER_OVERLAY, FLAG_RAIL_UNDERLAY, FLAG_ROAD_UNDERLAY,
};
use city_sim_protocol::{
    commands::{CommandResult, Tool},
    tile_kind::TileKind,
};

// ---------------------------------------------------------------------------
// Build costs (from `app/src/game/constants.ts` BUILD_COST)
// ---------------------------------------------------------------------------

pub fn tool_cost(tool: Tool) -> i64 {
    match tool {
        Tool::Inspect => 0,
        Tool::TerraformRaise => 10,
        Tool::TerraformLower => 10,
        Tool::Water => 12,
        Tool::Tree => 8,
        Tool::Road => 5,
        Tool::Rail => 15,
        Tool::PowerLine => 6,
        Tool::HydroPlant => 20_000,
        Tool::CoalPlant => 25_000,
        Tool::WindTurbine => 5_000,
        Tool::SolarFarm => 4_000,
        Tool::WaterPump => 400,
        Tool::WaterTower => 1_200,
        Tool::WaterPipe => 4,
        Tool::ElementarySchool => 4_500,
        Tool::HighSchool => 7_000,
        Tool::Residential => 40,
        Tool::Commercial => 60,
        Tool::Industrial => 80,
        Tool::Park => 10,
        Tool::Bulldoze => 1,
        Tool::ParkLarge => 32,
    }
}

// ---------------------------------------------------------------------------
// apply_tool — main entry point (mirrors `applyTool` in tools.ts)
// ---------------------------------------------------------------------------

/// Apply a player tool at tile (x, y) on `state`.
///
/// Validates funds and placement rules, modifies state on success, and returns
/// a `CommandResult` indicating success or a human-readable failure reason.
pub fn apply_tool(state: &mut GameState, tool: Tool, x: u32, y: u32) -> CommandResult {
    // Bounds check
    if state.tile_index(x, y).is_none() {
        return CommandResult::fail("Out of bounds");
    }

    // Funds check
    let cost = tool_cost(tool);
    if state.money < cost {
        return CommandResult::fail("Not enough funds");
    }

    match tool {
        Tool::Inspect => CommandResult::ok(),

        Tool::TerraformRaise => {
            state.money -= cost;
            let idx = state.tile_index(x, y).unwrap();
            state.tiles[idx].kind = TileKind::Land;
            state.tile_revision += 1;
            CommandResult::ok()
        }
        Tool::TerraformLower => {
            state.money -= cost;
            let idx = state.tile_index(x, y).unwrap();
            state.tiles[idx].kind = TileKind::Water;
            state.tile_revision += 1;
            CommandResult::ok()
        }
        Tool::Water => {
            state.money -= cost;
            set_kind(state, x, y, TileKind::Water);
            CommandResult::ok()
        }
        Tool::Tree => {
            state.money -= cost;
            set_kind(state, x, y, TileKind::Tree);
            CommandResult::ok()
        }

        Tool::Road => {
            let idx = state.tile_index(x, y).unwrap();
            if state.tiles[idx].building_id.is_some() {
                return CommandResult::fail("A building occupies this tile. Bulldoze first.");
            }
            let had_rail =
                state.tiles[idx].kind == TileKind::Rail || state.tiles[idx].has_rail_underlay();
            clear_building_at(state, x, y);
            state.money -= cost;
            let idx = state.tile_index(x, y).unwrap();
            state.tiles[idx].kind = TileKind::Road;
            if had_rail {
                state.tiles[idx].set_flag(FLAG_RAIL_UNDERLAY, true);
            }
            state.tile_revision += 1;
            CommandResult::ok()
        }
        Tool::Rail => {
            let idx = state.tile_index(x, y).unwrap();
            if state.tiles[idx].building_id.is_some() {
                return CommandResult::fail("A building occupies this tile. Bulldoze first.");
            }
            let had_road =
                state.tiles[idx].kind == TileKind::Road || state.tiles[idx].has_road_underlay();
            clear_building_at(state, x, y);
            state.money -= cost;
            let idx = state.tile_index(x, y).unwrap();
            state.tiles[idx].kind = TileKind::Rail;
            if had_road {
                state.tiles[idx].set_flag(FLAG_ROAD_UNDERLAY, true);
            }
            state.tile_revision += 1;
            CommandResult::ok()
        }
        Tool::PowerLine => {
            let idx = state.tile_index(x, y).unwrap();
            if state.tiles[idx].building_id.is_some() {
                return CommandResult::fail("A building occupies this tile. Bulldoze first.");
            }
            let had_road =
                state.tiles[idx].kind == TileKind::Road || state.tiles[idx].has_road_underlay();
            let had_rail =
                state.tiles[idx].kind == TileKind::Rail || state.tiles[idx].has_rail_underlay();
            clear_building_at(state, x, y);
            state.money -= cost;
            let idx = state.tile_index(x, y).unwrap();
            state.tiles[idx].kind = TileKind::PowerLine;
            state.tiles[idx].set_flag(FLAG_ROAD_UNDERLAY, had_road);
            state.tiles[idx].set_flag(FLAG_RAIL_UNDERLAY, had_rail);
            state.tiles[idx].set_flag(FLAG_POWER_OVERLAY, true);
            state.tile_revision += 1;
            CommandResult::ok()
        }

        Tool::WaterPipe => {
            state.money -= cost;
            let idx = state.tile_index(x, y).unwrap();
            state.tiles[idx].underground = Some(TileKind::WaterPipe);
            // tile_revision not bumped — underground doesn't affect zone cache
            CommandResult::ok()
        }

        // Zone tools — cannot place over road, rail, or existing buildings
        Tool::Residential | Tool::Commercial | Tool::Industrial => {
            let zone_kind = match tool {
                Tool::Residential => TileKind::Residential,
                Tool::Commercial => TileKind::Commercial,
                _ => TileKind::Industrial,
            };
            let idx = state.tile_index(x, y).unwrap();
            let t = &state.tiles[idx];
            if t.kind == TileKind::Road
                || t.kind == TileKind::Rail
                || t.has_road_underlay()
                || t.has_rail_underlay()
            {
                return CommandResult::fail("Cannot zone over roads or rail. Bulldoze first.");
            }
            if t.building_id.is_some() {
                return CommandResult::fail("Cannot zone over a building. Bulldoze first.");
            }
            state.money -= cost;
            set_kind(state, x, y, zone_kind);
            CommandResult::ok()
        }

        // Power plants — each uses its own TileKind; per-type MW output and
        // maintenance are stored in BuildingInstance for the budget and power BFS.
        Tool::HydroPlant => place_footprint_building(
            state,
            TileKind::HydroPlant,
            x,
            y,
            cost,
            HYDRO_PLANT_MW,
            150.0,
        ),
        Tool::CoalPlant => {
            place_footprint_building(state, TileKind::CoalPlant, x, y, cost, COAL_PLANT_MW, 300.0)
        }
        Tool::WindTurbine => place_footprint_building(
            state,
            TileKind::WindTurbine,
            x,
            y,
            cost,
            WIND_TURBINE_MW,
            30.0,
        ),
        Tool::SolarFarm => {
            place_footprint_building(state, TileKind::SolarFarm, x, y, cost, SOLAR_FARM_MW, 20.0)
        }
        Tool::WaterPump => place_footprint_building(state, TileKind::WaterPump, x, y, cost, 0, 0.0),
        Tool::WaterTower => {
            place_footprint_building(state, TileKind::WaterTower, x, y, cost, 0, 0.0)
        }
        Tool::ElementarySchool => {
            place_footprint_building(state, TileKind::ElementarySchool, x, y, cost, 0, 0.0)
        }
        Tool::HighSchool => {
            place_footprint_building(state, TileKind::HighSchool, x, y, cost, 0, 0.0)
        }
        Tool::Park => place_footprint_building(state, TileKind::Park, x, y, cost, 0, 0.0),
        Tool::ParkLarge => place_footprint_building(state, TileKind::ParkLarge, x, y, cost, 0, 0.0),

        Tool::Bulldoze => bulldoze(state, x, y, cost),
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn set_kind(state: &mut GameState, x: u32, y: u32, kind: TileKind) {
    let idx = state.tile_index(x, y).unwrap();
    state.tiles[idx].kind = kind;
    state.tile_revision += 1;
}

/// Remove any building whose footprint covers (x, y).
fn clear_building_at(state: &mut GameState, x: u32, y: u32) {
    let idx = state.tile_index(x, y).unwrap();
    if let Some(bid) = state.tiles[idx].building_id {
        remove_building(state, bid as u32);
    }
}

/// Remove a building by id: delete from `state.buildings`, clear tile fields.
pub fn remove_building(state: &mut GameState, building_id: u32) {
    // Remove the BuildingInstance
    state.buildings.retain(|b| b.id != building_id);
    // Clear all tiles that reference this building
    for tile in &mut state.tiles {
        if tile.building_id == Some(building_id as u16) {
            tile.building_id = None;
            tile.power_plant_mw = 0;
            tile.water_output = 0;
            // Keep the tile kind so the zone lot can regrow
        }
    }
    state.tile_revision += 1;
}

/// Place a multi-tile civic/power building at (x, y).
/// Validates footprint bounds and overlap, then stamps tiles and pushes to buildings.
///
/// `power_output_mw`: MW each tile contributes as a power source (0 = not a power
/// plant).  Power plants pass their per-type constant; all other buildings pass 0.
///
/// `maintenance_per_day`: stored on the `BuildingInstance` so each power plant type
/// can carry its own cost without needing a separate `TileKind`.  Pass 0.0 to fall
/// back to the template's `maintenance` field at budget time.
fn place_footprint_building(
    state: &mut GameState,
    kind: TileKind,
    x: u32,
    y: u32,
    cost: i64,
    power_output_mw: u32,
    maintenance_per_day: f32,
) -> CommandResult {
    let tmpl = match get_building_template(kind) {
        Some(t) => t,
        None => return CommandResult::fail("Unknown building type"),
    };
    let (fw, fh) = tmpl.footprint;
    let water_out = tmpl.water_output;

    // Bounds check
    if x + fw > state.width || y + fh > state.height {
        return CommandResult::fail(format!("Needs {fw}×{fh} tiles in-bounds"));
    }

    // Overlap check — reject existing buildings and transport tiles
    for dy in 0..fh {
        for dx in 0..fw {
            let idx = state.tile_index(x + dx, y + dy).unwrap();
            let t = &state.tiles[idx];
            if t.building_id.is_some() {
                return CommandResult::fail("Cannot overlap another building. Bulldoze first.");
            }
            let k = t.kind;
            if k == TileKind::Road
                || k == TileKind::Rail
                || k == TileKind::PowerLine
                || t.has_road_underlay()
                || t.has_rail_underlay()
            {
                return CommandResult::fail(
                    "Cannot build here — clear roads and powerlines first.",
                );
            }
        }
    }

    let bid = state.next_building_id;
    state.next_building_id += 1;
    state.money -= cost;

    for dy in 0..fh {
        for dx in 0..fw {
            let idx = state.tile_index(x + dx, y + dy).unwrap();
            state.tiles[idx].kind = kind;
            state.tiles[idx].building_id = Some(bid as u16);
            state.tiles[idx].set_flag(FLAG_ABANDONED, false);
            state.tiles[idx].happiness = (state.tiles[idx].happiness + 0.05).min(1.5);
            if power_output_mw > 0 {
                state.tiles[idx].power_plant_mw = power_output_mw as i32;
            }
            if water_out > 0 {
                state.tiles[idx].water_output = water_out;
            }
        }
    }

    let mut instance = BuildingInstance::new(bid, kind, (x, y));
    instance.maintenance_per_day = maintenance_per_day;
    state.buildings.push(instance);
    state.tile_revision += 1;
    CommandResult::ok()
}

/// Bulldoze the tile at (x, y): remove any building, or revert to Land.
fn bulldoze(state: &mut GameState, x: u32, y: u32, cost: i64) -> CommandResult {
    state.money -= cost;
    let idx = state.tile_index(x, y).unwrap();
    if let Some(bid) = state.tiles[idx].building_id {
        remove_building(state, bid as u32);
    } else if state.tiles[idx].underground.is_some() {
        state.tiles[idx].underground = None;
    } else {
        state.tiles[idx].kind = TileKind::Land;
        // Clear the structural flags with the tile. They describe what was
        // built here, not what the simulation derived: leaving them set makes
        // a bulldozed tile keep rendering the thing that was removed. In
        // particular FLAG_POWER_OVERLAY was set when a line was strung and
        // never cleared anywhere, so hydro survived its own demolition once
        // the renderer started drawing overlays. FLAG_POWERED / FLAG_WATERED
        // are recomputed by the utility passes, so they are cleared too rather
        // than left describing a tile that no longer exists.
        state.tiles[idx].set_flag(
            FLAG_ROAD_UNDERLAY | FLAG_RAIL_UNDERLAY | FLAG_POWER_OVERLAY | FLAG_ABANDONED,
            false,
        );
        state.tile_revision += 1;
    }
    CommandResult::ok()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn gs(w: u32, h: u32) -> GameState {
        GameState::new(w, h, 0)
    }

    #[test]
    fn inspect_always_succeeds() {
        let mut s = gs(4, 4);
        let r = apply_tool(&mut s, Tool::Inspect, 0, 0);
        assert!(r.success);
        assert_eq!(s.money, 100_000);
    }

    #[test]
    fn out_of_bounds_fails() {
        let mut s = gs(4, 4);
        let r = apply_tool(&mut s, Tool::Road, 10, 10);
        assert!(!r.success);
    }

    #[test]
    fn no_funds_fails() {
        let mut s = gs(4, 4);
        s.money = 0;
        let r = apply_tool(&mut s, Tool::Road, 0, 0);
        assert!(!r.success);
        assert_eq!(r.message.as_deref(), Some("Not enough funds"));
    }

    #[test]
    fn road_places_road_and_charges_money() {
        let mut s = gs(4, 4);
        let before = s.money;
        let r = apply_tool(&mut s, Tool::Road, 1, 1);
        assert!(r.success);
        assert_eq!(s.tile_at(1, 1).unwrap().kind, TileKind::Road);
        assert_eq!(s.money, before - tool_cost(Tool::Road));
    }

    #[test]
    fn road_over_rail_keeps_rail_underlay() {
        let mut s = gs(4, 4);
        s.tile_at_mut(0, 0).unwrap().kind = TileKind::Rail;
        apply_tool(&mut s, Tool::Road, 0, 0);
        let t = s.tile_at(0, 0).unwrap();
        assert_eq!(t.kind, TileKind::Road);
        assert!(t.has_rail_underlay(), "rail underlay should be preserved");
    }

    #[test]
    fn rail_over_road_keeps_road_underlay() {
        let mut s = gs(4, 4);
        s.tile_at_mut(0, 0).unwrap().kind = TileKind::Road;
        apply_tool(&mut s, Tool::Rail, 0, 0);
        let t = s.tile_at(0, 0).unwrap();
        assert_eq!(t.kind, TileKind::Rail);
        assert!(t.has_road_underlay(), "road underlay should be preserved");
    }

    #[test]
    fn zone_tool_charges_and_sets_kind() {
        let mut s = gs(4, 4);
        let before = s.money;
        let r = apply_tool(&mut s, Tool::Residential, 2, 2);
        assert!(r.success);
        assert_eq!(s.tile_at(2, 2).unwrap().kind, TileKind::Residential);
        assert_eq!(s.money, before - tool_cost(Tool::Residential));
    }

    #[test]
    fn zone_over_road_fails() {
        let mut s = gs(4, 4);
        s.tile_at_mut(0, 0).unwrap().kind = TileKind::Road;
        let r = apply_tool(&mut s, Tool::Residential, 0, 0);
        assert!(!r.success);
        assert_eq!(
            s.tile_at(0, 0).unwrap().kind,
            TileKind::Road,
            "tile should not change"
        );
    }

    #[test]
    fn water_pipe_sets_underground() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::WaterPipe, 1, 1);
        assert_eq!(
            s.tile_at(1, 1).unwrap().underground,
            Some(TileKind::WaterPipe)
        );
    }

    #[test]
    fn place_1x1_building_stamps_tile_and_charges() {
        let mut s = gs(4, 4);
        let before = s.money;
        let r = apply_tool(&mut s, Tool::WaterPump, 0, 0);
        assert!(r.success);
        assert_eq!(s.tile_at(0, 0).unwrap().kind, TileKind::WaterPump);
        assert!(s.tile_at(0, 0).unwrap().building_id.is_some());
        assert_eq!(s.buildings.len(), 1);
        assert_eq!(s.money, before - tool_cost(Tool::WaterPump));
    }

    #[test]
    fn place_2x2_building_fills_footprint() {
        let mut s = gs(4, 4);
        let r = apply_tool(&mut s, Tool::WaterTower, 0, 0);
        assert!(r.success);
        let bid = s.tile_at(0, 0).unwrap().building_id.unwrap();
        for dy in 0..2 {
            for dx in 0..2 {
                let t = s.tile_at(dx, dy).unwrap();
                assert_eq!(t.kind, TileKind::WaterTower);
                assert_eq!(t.building_id, Some(bid));
            }
        }
    }

    #[test]
    fn place_building_fails_out_of_bounds() {
        let mut s = gs(3, 3);
        // WaterTower is 2×2; placing at (2,2) would go to (3,3) which is out of bounds
        let r = apply_tool(&mut s, Tool::WaterTower, 2, 2);
        assert!(!r.success);
        assert_eq!(s.tile_at(2, 2).unwrap().kind, TileKind::Land);
    }

    #[test]
    fn place_building_fails_on_overlap() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::WaterPump, 0, 0);
        let r = apply_tool(&mut s, Tool::WaterPump, 0, 0);
        assert!(!r.success);
        assert_eq!(s.buildings.len(), 1, "only one building should exist");
    }

    #[test]
    fn bulldoze_removes_road() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::Road, 0, 0);
        apply_tool(&mut s, Tool::Bulldoze, 0, 0);
        assert_eq!(s.tile_at(0, 0).unwrap().kind, TileKind::Land);
    }

    #[test]
    fn bulldoze_removes_building_and_clears_tiles() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::WaterTower, 0, 0);
        assert_eq!(s.buildings.len(), 1);
        apply_tool(&mut s, Tool::Bulldoze, 0, 0);
        assert!(s.buildings.is_empty());
        for dy in 0..2 {
            for dx in 0..2 {
                assert!(s.tile_at(dx, dy).unwrap().building_id.is_none());
            }
        }
    }

    #[test]
    fn bulldoze_removes_underground_pipe() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::WaterPipe, 0, 0);
        assert_eq!(
            s.tile_at(0, 0).unwrap().underground,
            Some(TileKind::WaterPipe)
        );
        apply_tool(&mut s, Tool::Bulldoze, 0, 0);
        assert_eq!(s.tile_at(0, 0).unwrap().underground, None);
    }

    #[test]
    fn bulldoze_clears_structural_flags() {
        // A hydro line laid over a road sets both the road underlay and the
        // power overlay. Bulldozing must clear them, or the tile keeps
        // rendering a road and wires that are no longer there.
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::Road, 1, 1);
        apply_tool(&mut s, Tool::PowerLine, 1, 1);
        assert!(s.tile_at(1, 1).unwrap().has_road_underlay());
        assert!(s.tile_at(1, 1).unwrap().has_power_overlay());

        apply_tool(&mut s, Tool::Bulldoze, 1, 1);
        let t = s.tile_at(1, 1).unwrap();
        assert_eq!(t.kind, TileKind::Land);
        assert!(!t.has_road_underlay(), "road underlay survived bulldoze");
        assert!(!t.has_rail_underlay(), "rail underlay survived bulldoze");
        assert!(!t.has_power_overlay(), "power overlay survived bulldoze");
    }

    #[test]
    fn power_line_sets_power_overlay_flag() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::PowerLine, 0, 0);
        assert_eq!(s.tile_at(0, 0).unwrap().kind, TileKind::PowerLine);
        assert!(s.tile_at(0, 0).unwrap().has_power_overlay());
    }

    #[test]
    fn place_elementary_school_2x2() {
        let mut s = gs(4, 4);
        let r = apply_tool(&mut s, Tool::ElementarySchool, 0, 0);
        assert!(r.success);
        assert_eq!(s.tile_at(0, 0).unwrap().kind, TileKind::ElementarySchool);
        assert_eq!(s.buildings.len(), 1);
    }

    #[test]
    fn water_pump_placement_sets_water_output_on_tile() {
        // Regression: place_footprint_building must propagate water_output from
        // the building template onto the tile so the water BFS sees it as a source.
        let mut s = gs(4, 4);
        let r = apply_tool(&mut s, Tool::WaterPump, 0, 0);
        assert!(r.success);
        assert!(
            s.tile_at(0, 0).unwrap().water_output > 0,
            "water pump tile must have water_output > 0 after placement"
        );
    }

    #[test]
    fn transport_tools_reject_placement_over_buildings() {
        // Road, Rail, and PowerLine must refuse to overwrite an existing building.
        // The player must Bulldoze first — matches the TS tools.ts guard.
        for tool in [Tool::Road, Tool::Rail, Tool::PowerLine] {
            let mut s = gs(4, 4);
            apply_tool(&mut s, Tool::WaterPump, 1, 1);
            assert!(s.tile_at(1, 1).unwrap().building_id.is_some());

            let before_money = s.money;
            let r = apply_tool(&mut s, tool, 1, 1);
            assert!(!r.success, "{tool:?} should be rejected over a building");
            assert_eq!(
                s.money, before_money,
                "{tool:?} must not charge on rejection"
            );
            assert!(
                s.tile_at(1, 1).unwrap().building_id.is_some(),
                "{tool:?} must not remove the building on rejection",
            );
        }
    }

    #[test]
    fn zone_over_building_fails() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::WaterPump, 1, 1);
        let before_money = s.money;
        for tool in [Tool::Residential, Tool::Commercial, Tool::Industrial] {
            let r = apply_tool(&mut s, tool, 1, 1);
            assert!(!r.success, "{tool:?} should be rejected over a building");
            assert_eq!(
                s.money, before_money,
                "{tool:?} must not charge on rejection"
            );
            assert_eq!(
                s.tile_at(1, 1).unwrap().kind,
                TileKind::WaterPump,
                "tile should not change"
            );
        }
    }

    #[test]
    fn building_over_road_fails() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::Road, 1, 1);
        let before_money = s.money;
        let r = apply_tool(&mut s, Tool::WaterPump, 1, 1);
        assert!(!r.success, "building should be rejected over a road");
        assert_eq!(s.money, before_money, "must not charge on rejection");
        assert_eq!(
            s.tile_at(1, 1).unwrap().kind,
            TileKind::Road,
            "road should remain"
        );
    }

    #[test]
    fn building_over_powerline_fails() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::PowerLine, 1, 1);
        let before_money = s.money;
        let r = apply_tool(&mut s, Tool::WaterPump, 1, 1);
        assert!(!r.success, "building should be rejected over a powerline");
        assert_eq!(s.money, before_money, "must not charge on rejection");
    }

    #[test]
    fn all_power_plants_place_with_correct_tile_kind() {
        // Regression: before the BUG-30 fix, CoalPlant/WindTurbine/SolarFarm all
        // wrote TileKind::HydroPlant. After the fix their TileKinds were added to
        // the protocol but get_building_template was not updated, so placement
        // failed with "Unknown building type" for every non-hydro plant.
        let cases = [
            (Tool::HydroPlant, TileKind::HydroPlant, HYDRO_PLANT_MW),
            (Tool::CoalPlant, TileKind::CoalPlant, COAL_PLANT_MW),
            (Tool::WindTurbine, TileKind::WindTurbine, WIND_TURBINE_MW),
            (Tool::SolarFarm, TileKind::SolarFarm, SOLAR_FARM_MW),
        ];
        for (tool, expected_kind, expected_mw) in cases {
            let mut s = gs(6, 6);
            s.money = 200_000;
            let r = apply_tool(&mut s, tool, 0, 0);
            assert!(
                r.success,
                "{tool:?} placement should succeed: {:?}",
                r.message
            );
            assert_eq!(
                s.tile_at(0, 0).unwrap().kind,
                expected_kind,
                "{tool:?} should stamp {expected_kind:?}"
            );
            // All four tiles of the 2×2 footprint must carry power_plant_mw
            for dy in 0..2u32 {
                for dx in 0..2u32 {
                    assert_eq!(
                        s.tile_at(dx, dy).unwrap().power_plant_mw,
                        expected_mw as i32,
                        "{tool:?} tile ({dx},{dy}) has wrong power_plant_mw"
                    );
                }
            }
            assert_eq!(s.buildings.len(), 1);
        }
    }

    #[test]
    fn tool_cost_matches_ts_constants() {
        assert_eq!(tool_cost(Tool::Road), 5);
        assert_eq!(tool_cost(Tool::Rail), 15);
        assert_eq!(tool_cost(Tool::WaterPipe), 4);
        assert_eq!(tool_cost(Tool::Residential), 40);
        assert_eq!(tool_cost(Tool::Commercial), 60);
        assert_eq!(tool_cost(Tool::Industrial), 80);
        assert_eq!(tool_cost(Tool::HydroPlant), 20_000);
        assert_eq!(tool_cost(Tool::ElementarySchool), 4_500);
    }
}
