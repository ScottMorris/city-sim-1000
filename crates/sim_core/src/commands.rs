use sim_protocol::{
    commands::{CommandResult, Tool},
    tile_kind::TileKind,
};
use crate::buildings::{get_building_template, BuildingInstance};
use crate::state::{GameState, FLAG_ABANDONED, FLAG_POWER_OVERLAY, FLAG_RAIL_UNDERLAY, FLAG_ROAD_UNDERLAY};

// ---------------------------------------------------------------------------
// Build costs (from `app/src/game/constants.ts` BUILD_COST)
// ---------------------------------------------------------------------------

pub fn tool_cost(tool: Tool) -> i64 {
    match tool {
        Tool::Inspect          => 0,
        Tool::TerraformRaise   => 10,
        Tool::TerraformLower   => 10,
        Tool::Water            => 12,
        Tool::Tree             => 8,
        Tool::Road             => 5,
        Tool::Rail             => 15,
        Tool::PowerLine        => 6,
        Tool::HydroPlant       => 20_000,
        Tool::CoalPlant        => 25_000,
        Tool::WindTurbine      => 5_000,
        Tool::SolarFarm        => 4_000,
        Tool::WaterPump        => 400,
        Tool::WaterTower       => 1_200,
        Tool::WaterPipe        => 4,
        Tool::ElementarySchool => 4_500,
        Tool::HighSchool       => 7_000,
        Tool::Residential      => 40,
        Tool::Commercial       => 60,
        Tool::Industrial       => 80,
        Tool::Park             => 10,
        Tool::Bulldoze         => 1,
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
            let had_rail = state.tiles[idx].kind == TileKind::Rail
                || state.tiles[idx].has_rail_underlay();
            clear_building_at(state, x, y);
            state.money -= cost;
            let idx = state.tile_index(x, y).unwrap();
            state.tiles[idx].kind = TileKind::Road;
            if had_rail { state.tiles[idx].set_flag(FLAG_RAIL_UNDERLAY, true); }
            state.tile_revision += 1;
            CommandResult::ok()
        }
        Tool::Rail => {
            let idx = state.tile_index(x, y).unwrap();
            let had_road = state.tiles[idx].kind == TileKind::Road
                || state.tiles[idx].has_road_underlay();
            clear_building_at(state, x, y);
            state.money -= cost;
            let idx = state.tile_index(x, y).unwrap();
            state.tiles[idx].kind = TileKind::Rail;
            if had_road { state.tiles[idx].set_flag(FLAG_ROAD_UNDERLAY, true); }
            state.tile_revision += 1;
            CommandResult::ok()
        }
        Tool::PowerLine => {
            let idx = state.tile_index(x, y).unwrap();
            let had_road = state.tiles[idx].kind == TileKind::Road
                || state.tiles[idx].has_road_underlay();
            let had_rail = state.tiles[idx].kind == TileKind::Rail
                || state.tiles[idx].has_rail_underlay();
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

        // Zone tools — cannot place over road or rail
        Tool::Residential | Tool::Commercial | Tool::Industrial => {
            let zone_kind = match tool {
                Tool::Residential => TileKind::Residential,
                Tool::Commercial  => TileKind::Commercial,
                _                 => TileKind::Industrial,
            };
            let idx = state.tile_index(x, y).unwrap();
            let t = &state.tiles[idx];
            if t.kind == TileKind::Road || t.kind == TileKind::Rail
                || t.has_road_underlay() || t.has_rail_underlay()
            {
                return CommandResult::fail("Cannot zone over roads or rail. Bulldoze first.");
            }
            state.money -= cost;
            set_kind(state, x, y, zone_kind);
            CommandResult::ok()
        }

        // Footprint buildings — place via place_building helper
        Tool::HydroPlant | Tool::CoalPlant | Tool::WindTurbine | Tool::SolarFarm => {
            // All power plant tools use HydroPlant tile kind for now (matches TS)
            place_footprint_building(state, TileKind::HydroPlant, x, y, cost, true)
        }
        Tool::WaterPump =>
            place_footprint_building(state, TileKind::WaterPump, x, y, cost, false),
        Tool::WaterTower =>
            place_footprint_building(state, TileKind::WaterTower, x, y, cost, false),
        Tool::ElementarySchool =>
            place_footprint_building(state, TileKind::ElementarySchool, x, y, cost, false),
        Tool::HighSchool =>
            place_footprint_building(state, TileKind::HighSchool, x, y, cost, false),
        Tool::Park =>
            place_footprint_building(state, TileKind::Park, x, y, cost, false),

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
            tile.building_id    = None;
            tile.power_plant_mw = 0;
            tile.water_output   = 0;
            // Keep the tile kind so the zone lot can regrow
        }
    }
    state.tile_revision += 1;
}

/// Place a multi-tile civic/power building at (x, y).
/// Validates footprint bounds and overlap, then stamps tiles and pushes to buildings.
fn place_footprint_building(
    state:       &mut GameState,
    kind:        TileKind,
    x:           u32,
    y:           u32,
    cost:        i64,
    is_power:    bool,
) -> CommandResult {
    let tmpl = match get_building_template(kind) {
        Some(t) => t,
        None    => return CommandResult::fail("Unknown building type"),
    };
    let (fw, fh) = tmpl.footprint;

    // Bounds check
    if x + fw > state.width || y + fh > state.height {
        return CommandResult::fail(format!("Needs {fw}×{fh} tiles in-bounds"));
    }

    // Overlap check
    for dy in 0..fh {
        for dx in 0..fw {
            let idx = state.tile_index(x + dx, y + dy).unwrap();
            if state.tiles[idx].building_id.is_some() {
                return CommandResult::fail("Cannot overlap another building");
            }
        }
    }

    let bid = state.next_building_id;
    state.next_building_id += 1;
    state.money -= cost;

    for dy in 0..fh {
        for dx in 0..fw {
            let idx = state.tile_index(x + dx, y + dy).unwrap();
            state.tiles[idx].kind         = kind;
            state.tiles[idx].building_id  = Some(bid as u16);
            state.tiles[idx].set_flag(FLAG_ABANDONED, false);
            state.tiles[idx].happiness    = (state.tiles[idx].happiness + 0.05).min(1.5);
            if is_power {
                // Power plant mw will be set by the power BFS at next tick
                state.tiles[idx].power_plant_mw = 1; // non-zero = is a source
            }
        }
    }

    state.buildings.push(BuildingInstance::new(bid, kind, (x, y)));
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

    fn gs(w: u32, h: u32) -> GameState { GameState::new(w, h, 0) }

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
        assert_eq!(s.tile_at(0, 0).unwrap().kind, TileKind::Road, "tile should not change");
    }

    #[test]
    fn water_pipe_sets_underground() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::WaterPipe, 1, 1);
        assert_eq!(s.tile_at(1, 1).unwrap().underground, Some(TileKind::WaterPipe));
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
        for dy in 0..2 { for dx in 0..2 {
            let t = s.tile_at(dx, dy).unwrap();
            assert_eq!(t.kind, TileKind::WaterTower);
            assert_eq!(t.building_id, Some(bid));
        }}
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
        for dy in 0..2 { for dx in 0..2 {
            assert!(s.tile_at(dx, dy).unwrap().building_id.is_none());
        }}
    }

    #[test]
    fn bulldoze_removes_underground_pipe() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::WaterPipe, 0, 0);
        assert_eq!(s.tile_at(0, 0).unwrap().underground, Some(TileKind::WaterPipe));
        apply_tool(&mut s, Tool::Bulldoze, 0, 0);
        assert_eq!(s.tile_at(0, 0).unwrap().underground, None);
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
    fn tool_cost_matches_ts_constants() {
        assert_eq!(tool_cost(Tool::Road),            5);
        assert_eq!(tool_cost(Tool::Rail),            15);
        assert_eq!(tool_cost(Tool::WaterPipe),       4);
        assert_eq!(tool_cost(Tool::Residential),     40);
        assert_eq!(tool_cost(Tool::Commercial),      60);
        assert_eq!(tool_cost(Tool::Industrial),      80);
        assert_eq!(tool_cost(Tool::HydroPlant),      20_000);
        assert_eq!(tool_cost(Tool::ElementarySchool), 4_500);
    }
}
