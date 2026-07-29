// commands.rs — player tool application; maps SimCommand to tile mutations.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use crate::buildings::{
    get_building_template, BuildingInstance, COAL_PLANT_MW, HYDRO_PLANT_MW, SOLAR_FARM_MW,
    WIND_TURBINE_MW,
};
use crate::occupants::{
    iter_set, pair_conflicts, Occupant, OccupantSet, Stratum, Terrain, ZONE_MASK,
};
use crate::state::{GameState, Tile, FLAG_ABANDONED};
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
// Placement guards, asked of the occupant set
// ---------------------------------------------------------------------------
//
// Step 2 of #177. Every guard below used to enumerate `kind`s and structural
// flags by hand, which is how they came to disagree: `place_footprint_building`
// rejected `kind == PowerLine` but never asked `has_power_overlay()`, so a line
// recorded in the flag — which is every line strung across a zone, and every
// line that has since been terraformed — was invisible to it. The guards ask
// `Tile::occupants` and consult `pair_conflicts` instead, and since step 3
// there is only one spelling for them to see.

/// The first occupant standing on `tile` that refuses `incoming`, in bit order.
///
/// `OCCUPANT_DEFS` says which pairs cannot share a tile; it does not say what
/// happens when the player asks for one anyway, and both answers are legitimate.
/// A hydro line ploughs straight through forest — utilities trim canopy away
/// from conductors — while a park refuses a tile with a road on it. Only
/// refusal needs a guard, so each caller names the conflicts it resolves by
/// *displacement* in `displaces` and everything left over is refused.
///
/// Reads `tile.occupants` directly. It used to have to filter out a *ghost*
/// structure first — a structure `kind` [`remove_building`] left standing over
/// a cleared `building_id` — because letting one refuse a placement stranded
/// every bulldozed park behind a second bulldoze. Ghosts no longer exist:
/// `remove_building` clears the tag with the id, since with `Structure` being
/// one flat tag there is nowhere for a tagless structure's identity to live.
///
/// The real question — *is something built here?* — is `building_id`, the
/// design note's `development`, and it stays a separate check. It has to be: a
/// developed residential lot carries a `building_id` while its occupant stays a
/// zone tag, so it has no `Structure` bit to find.
fn refused_by(tile: &Tile, incoming: Occupant, displaces: OccupantSet) -> Option<Occupant> {
    let standing = tile.occupants & !displaces;
    iter_set(standing).find(|&o| pair_conflicts(o, incoming))
}

/// Why a regrade must refuse this tile, if it must.
///
/// The terrain brushes rewrite the ground itself, and until now they did it
/// with no guard whatsoever — a bare `tiles[idx].kind = …`. That made them the
/// only tools that could take a live building off the map without removing it:
/// `CoalPlant` then `TerraformLower` left `kind = Water` while `building_id`,
/// `power_plant_mw` and the `BuildingInstance` all stayed exactly where they
/// were. The plant went on producing 80 MW and billing $300/day from a tile
/// whose occupant set was now empty — and since `compute_wilderness` reads
/// that set, ten credits of regrading permanently bought off
/// `structure_eco(CoalPlant)`.
///
/// **A live building, and nothing else.** Development is the one thing a
/// regrade cannot wipe on the player's behalf, because wiping it is not what a
/// regrade does — it would leave the `BuildingInstance` running with no tile
/// under it. Every other tool here that meets built ground says "Bulldoze
/// first." for the same reason, and a ten-credit misclick must not be able to
/// demolish a 25,000-credit plant either.
///
/// Roads, rails and zone tags are *not* refused. Terraforming has always wiped
/// what stood on the ground — it never read `kind` at all, only wrote it — and
/// `Tool::Bulldoze` costs 1 against terraform's 10, so refusing them would
/// close no exploit and would only make the brush weaker than it has ever
/// been. What the surface *does* need is [`regrade_at`], so that the wipe takes
/// the whole stratum rather than one slot of it.
fn regrade_refusal(tile: &Tile) -> Option<&'static str> {
    if tile.building_id.is_some() {
        return Some("A building occupies this tile. Bulldoze first.");
    }
    None
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

        // Terraforming regrades the ground: it wipes the surface and rewrites
        // the terrain under it. The one thing it will not wipe is a live
        // building — see `regrade_refusal`.
        //
        // What it does NOT touch is the overhead and underground strata:
        //
        //   - a hydro line spans the tile whatever the ground does under it,
        //     and over water it is the pylon span `docs/tile-model.md` names as
        //     a legitimate variant of the line;
        //   - a buried pipe is at depth, not on the surface.
        //
        // So a line really is preserved across a regrade, and the sweep's
        // `PowerLine → TerraformRaise → HydroPlant` route was never a
        // terraforming bug. What it exposed is that the regrade moves the line
        // out of `kind` and into `FLAG_POWER_OVERLAY`, and the old placement
        // guard could only see the first spelling. Asking the occupant set
        // closes the route where the defect actually is.
        Tool::TerraformRaise | Tool::TerraformLower | Tool::Water => {
            // The water brush is `TerraformLower` at a different price — same
            // `kind = Water`, same missing guard, same dangling building — so
            // it is regraded through the same gate rather than left one click
            // away from the defect the terraform tools just closed.
            let idx = state.tile_index(x, y).unwrap();
            if let Some(why) = regrade_refusal(&state.tiles[idx]) {
                return CommandResult::fail(why);
            }
            state.money -= cost;
            let ground = if tool == Tool::TerraformRaise {
                Terrain::Land
            } else {
                Terrain::Water
            };
            regrade_at(state, x, y, ground);
            CommandResult::ok()
        }
        Tool::Tree => {
            // Planting clears the ground it plants on — a canopy shares the
            // tile with a road only in the target model, and `Tool::Tree` still
            // overwrites one. That is a gameplay decision of its own, preserved
            // exactly: `regrade_at` takes the surface stratum with it.
            //
            // The hydro span is deliberately left standing: a tree planted over
            // a live line still produces `{Trees, PowerLine}`, which is
            // `known_defect_trees_are_planted_through_a_live_hydro_line`.
            //
            // The one refusal here is against stranding a live building,
            // because a tree planted over a coal plant erased the `Structure`
            // occupant and its wilderness penalty while the plant kept running.
            let idx = state.tile_index(x, y).unwrap();
            if state.tiles[idx].building_id.is_some() {
                return CommandResult::fail("A building occupies this tile. Bulldoze first.");
            }
            state.money -= cost;
            regrade_at(state, x, y, Terrain::Land);
            state.tiles[idx].set_occupant(Occupant::Trees, true);
            CommandResult::ok()
        }

        // Road, rail and the hydro line refuse only a developed tile. Their
        // remaining conflicts — the three zone tags for road and rail, tree
        // canopy for the line — are all resolved by displacement, so there is
        // nothing further for `refused_by` to find: paving over a zone and
        // stringing a line through forest are both ordinary play.
        Tool::Road => {
            let idx = state.tile_index(x, y).unwrap();
            if state.tiles[idx].building_id.is_some() {
                return CommandResult::fail("A building occupies this tile. Bulldoze first.");
            }
            let had_rail = state.tiles[idx].has_occupant(Occupant::Rail);
            clear_building_at(state, x, y);
            state.money -= cost;
            // A hydro line survives a road laid across it, exactly as a rail
            // does — the overhead stratum is not the surface, so there is
            // nothing left to arbitrate. Build order cannot change the outcome
            // any more: it is not expressible.
            //
            // The regrade is what takes the zone tag, the canopy and the water
            // under the carriageway, all of which `kind = Road` used to
            // overwrite by occupying the same slot.
            regrade_at(state, x, y, Terrain::Land);
            let idx = state.tile_index(x, y).unwrap();
            state.tiles[idx].set_occupant(Occupant::Road, true);
            state.tiles[idx].set_occupant(Occupant::Rail, had_rail);
            CommandResult::ok()
        }
        Tool::Rail => {
            let idx = state.tile_index(x, y).unwrap();
            if state.tiles[idx].building_id.is_some() {
                return CommandResult::fail("A building occupies this tile. Bulldoze first.");
            }
            let had_road = state.tiles[idx].has_occupant(Occupant::Road);
            clear_building_at(state, x, y);
            state.money -= cost;
            // Mirrors `Tool::Road` above.
            regrade_at(state, x, y, Terrain::Land);
            let idx = state.tile_index(x, y).unwrap();
            state.tiles[idx].set_occupant(Occupant::Rail, true);
            state.tiles[idx].set_occupant(Occupant::Road, had_road);
            CommandResult::ok()
        }
        Tool::PowerLine => {
            let idx = state.tile_index(x, y).unwrap();
            if state.tiles[idx].building_id.is_some() {
                return CommandResult::fail("A building occupies this tile. Bulldoze first.");
            }
            clear_building_at(state, x, y);
            state.money -= cost;
            let idx = state.tile_index(x, y).unwrap();
            // The surface is untouched: a line strung across a zone, a road or
            // a rail leaves all of them standing. The `zoned` special case this
            // replaces existed only to arbitrate the `kind` slot — with the
            // strata there is no slot to arbitrate, so it goes.
            //
            // The canopy does not survive, because `kind = PowerLine` used to
            // destroy it. Utilities trim trees away from conductors, which is
            // also what `Occupant::PowerLine`'s conflict set says.
            let tile = &mut state.tiles[idx];
            tile.terrain = Terrain::Land;
            tile.set_occupant(Occupant::PowerLine, true);
            tile.set_occupant(Occupant::Trees, false);
            state.tile_revision += 1;
            CommandResult::ok()
        }

        Tool::WaterPipe => {
            state.money -= cost;
            let idx = state.tile_index(x, y).unwrap();
            state.tiles[idx].set_occupant(Occupant::Pipe, true);
            // tile_revision not bumped — underground doesn't affect zone cache
            CommandResult::ok()
        }

        // Zone tools — cannot place over road, rail, or existing buildings.
        // A hydro line is *not* in the way: a zone and a line share a tile
        // happily, in either build order, because they are in different strata.
        Tool::Residential | Tool::Commercial | Tool::Industrial => {
            let zone_occupant = match tool {
                Tool::Residential => Occupant::ZoneResidential,
                Tool::Commercial => Occupant::ZoneCommercial,
                _ => Occupant::ZoneIndustrial,
            };
            let t = &state.tiles[state.tile_index(x, y).unwrap()];
            // Re-zoning is a replacement, so the zone tags are displaced rather
            // than refused. What is left of a zone's conflict set is road, rail
            // and structure.
            if let Some(blocker) = refused_by(t, zone_occupant, ZONE_MASK) {
                return CommandResult::fail(match blocker {
                    Occupant::Structure => "Cannot zone over a building. Bulldoze first.",
                    _ => "Cannot zone over roads or rail. Bulldoze first.",
                });
            }
            if t.building_id.is_some() {
                return CommandResult::fail("Cannot zone over a building. Bulldoze first.");
            }
            state.money -= cost;
            // Re-zoning replaces the old tag, and zoning over forest or water
            // takes both — `kind = Residential` overwrote either. Everything
            // conflicting that is left was refused above, so the regrade only
            // ever clears what the zone displaces.
            regrade_at(state, x, y, Terrain::Land);
            let idx = state.tile_index(x, y).unwrap();
            state.tiles[idx].set_occupant(zone_occupant, true);
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

/// Rewrite the ground at (x, y): set the terrain, and clear everything the old
/// single-valued `kind` write used to destroy by occupying its slot.
///
/// **What goes:** the whole surface stratum — road, rail, the zone tag, a
/// structure — and the tree canopy. The canopy is overhead but it lived in
/// `kind` all the same (`TileKind::Tree`), so `kind = Land` / `Water` / `Road`
/// / `Residential` all removed it, and a `clear_stratum(Surface)` alone would
/// silently start leaving forests standing under new construction.
///
/// **What stays:** the hydro span and anything buried. A line crosses the tile
/// whatever happens beneath it — over water it is the pylon span the design
/// note names as a legitimate variant — and a pipe is at depth.
/// `terraforming_regrades_the_ground_and_leaves_the_strata_above_and_below`
/// pins that, and it is why `PowerLine` → `TerraformRaise` is legal play.
///
/// Every tool that builds calls this first, which is also why terrain is not
/// yet durable in behaviour: they all pass `Terrain::Land`.
fn regrade_at(state: &mut GameState, x: u32, y: u32, terrain: Terrain) {
    let idx = state.tile_index(x, y).unwrap();
    let tile = &mut state.tiles[idx];
    tile.terrain = terrain;
    tile.clear_stratum(Stratum::Surface);
    tile.set_occupant(Occupant::Trees, false);
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
///
/// **The `Structure` tag goes with the development.** It used to stay behind —
/// the comment read "keep the tile kind so the zone lot can regrow" — and for a
/// zone lot that is exactly right and still happens: a lot's occupant is its
/// zone tag, which this function never touches, so the lot regrows as it always
/// did. For a *structure* it was a ghost: `kind` stayed `Park` with nothing
/// behind it, so a bulldozed park went on scoring +4.0 of wilderness for ever
/// and took a second click to clear.
///
/// Under the strata a ghost is not merely wrong, it is unrepresentable —
/// `Occupant::Structure` is one flat tag and the `BuildingInstance` is the only
/// thing that knows which structure it is, so a tag with no id behind it has no
/// identity to score. Clearing it is what makes `StructureLookup` total.
pub fn remove_building(state: &mut GameState, building_id: u32) {
    // Remove the BuildingInstance
    state.buildings.retain(|b| b.id != building_id);
    // Clear all tiles that reference this building
    for tile in &mut state.tiles {
        if tile.building_id == Some(building_id as u16) {
            tile.building_id = None;
            tile.power_plant_mw = 0;
            tile.water_output = 0;
            tile.set_occupant(Occupant::Structure, false);
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

    // Overlap check — reject developed tiles, and anything the structure
    // conflicts with that it does not simply displace.
    //
    // The zone tags are displaced: a park stamped over a residential lot is
    // ordinary play, and so is the tree canopy a building clears to make room.
    // What is left of `Occupant::Structure`'s conflict set is road, rail and
    // the hydro line.
    //
    // The line is the fix. This guard used to enumerate `kind == Road | Rail |
    // PowerLine` plus the two underlay flags and never asked
    // `has_power_overlay()`, so it saw only one of a line's two spellings.
    // Every line strung across a *zone* wears the other one — the zone keeps
    // `kind`, the line takes the flag — and so does every line that has since
    // been terraformed. Three clicks (zone, line, park) therefore stamped a
    // structure straight over live conductors that went on drawing, conducting
    // and billing `MAINT_POWER_LINE`, unreachable by the bulldozer except
    // through the building on top of them. `Tool::PowerLine` has always
    // refused the converse — a tile that already carries a building — so the
    // rule existed, it was just enforced from one side only.
    for dy in 0..fh {
        for dx in 0..fw {
            let idx = state.tile_index(x + dx, y + dy).unwrap();
            let t = &state.tiles[idx];
            if t.building_id.is_some() {
                return CommandResult::fail("Cannot overlap another building. Bulldoze first.");
            }
            if refused_by(t, Occupant::Structure, ZONE_MASK).is_some() {
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
            // The footprint stamp used to be `kind = <structure>`, which took
            // the zone tag, the canopy and the water with it. `regrade_at` is
            // that same displacement written out.
            regrade_at(state, x + dx, y + dy, Terrain::Land);
            let idx = state.tile_index(x + dx, y + dy).unwrap();
            state.tiles[idx].set_occupant(Occupant::Structure, true);
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
    } else if state.tiles[idx].occupants_in(Stratum::Underground) != 0 {
        state.tiles[idx].clear_stratum(Stratum::Underground);
    } else {
        // The bulldozer works on what you can see: surface and overhead
        // together. Underground is reached on its own click, above, because it
        // is only editable from the underground view.
        //
        // The terrain goes back to `Land` rather than to what was there
        // before. That is today's behaviour preserved, not a modelling
        // statement — restoring water is the point of making terrain durable
        // and it belongs to step 4.
        let tile = &mut state.tiles[idx];
        tile.terrain = Terrain::Land;
        tile.clear_stratum(Stratum::Surface);
        tile.clear_stratum(Stratum::Overhead);
        // FLAG_POWERED / FLAG_WATERED are recomputed by the utility passes;
        // ABANDONED describes a lot that no longer exists.
        tile.set_flag(FLAG_ABANDONED, false);
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
    use crate::display::{wire_flags_at, wire_kind_at};
    use crate::migrate::set_v4_kind;
    use city_sim_protocol::tile_buffer::flags;

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
        assert_eq!(wire_kind_at(&s, 1, 1), TileKind::Road);
        assert_eq!(s.money, before - tool_cost(Tool::Road));
    }

    /// A level crossing carries both occupants whichever way round it was
    /// built, and — since step 3 of #177 — is spelled on the wire exactly one
    /// way: `Rail` + `ROAD_UNDERLAY`.
    ///
    /// **This is the one wire byte the flip could not reproduce.** Build order
    /// was the only thing distinguishing `Road` + `RAIL_UNDERLAY` from `Rail` +
    /// `ROAD_UNDERLAY`, and build order is not stored, so `{Road, Rail}` had to
    /// normalise onto one of them. Rail wins because dragging a railway across
    /// an existing road network is far commoner than the reverse, so it is the
    /// spelling most saves already hold. The sprite is unaffected —
    /// `resolveBaseTileSprite` tests `(Rail && roadUnderlay) || (Road &&
    /// railUnderlay)` and `pickRailCrossingTexture` orients off the rail axis
    /// either way — and so are the renderer's debug labels. The single
    /// user-visible delta is the minimap base colour of a road-last crossing,
    /// which goes rail-brown instead of road-grey (`minimap.ts` checks
    /// `railUnderlay` before `roadUnderlay`).
    #[test]
    fn a_level_crossing_has_one_spelling_in_both_build_orders() {
        for order in [[Tool::Rail, Tool::Road], [Tool::Road, Tool::Rail]] {
            let mut s = gs(4, 4);
            for tool in order {
                assert!(apply_tool(&mut s, tool, 0, 0).success);
            }
            let t = s.tile_at(0, 0).unwrap();
            assert!(t.has_occupant(Occupant::Road), "{order:?}: the road");
            assert!(t.has_occupant(Occupant::Rail), "{order:?}: the rail");
            assert_eq!(wire_kind_at(&s, 0, 0), TileKind::Rail, "{order:?}");
            assert_eq!(wire_flags_at(&s, 0, 0), flags::ROAD_UNDERLAY, "{order:?}");
        }
    }

    #[test]
    fn zone_tool_charges_and_sets_kind() {
        let mut s = gs(4, 4);
        let before = s.money;
        let r = apply_tool(&mut s, Tool::Residential, 2, 2);
        assert!(r.success);
        assert_eq!(wire_kind_at(&s, 2, 2), TileKind::Residential);
        assert_eq!(s.money, before - tool_cost(Tool::Residential));
    }

    #[test]
    fn zone_over_road_fails() {
        let mut s = gs(4, 4);
        set_v4_kind(s.tile_at_mut(0, 0).unwrap(), TileKind::Road);
        let r = apply_tool(&mut s, Tool::Residential, 0, 0);
        assert!(!r.success);
        assert_eq!(
            wire_kind_at(&s, 0, 0),
            TileKind::Road,
            "tile should not change"
        );
    }

    #[test]
    fn water_pipe_sets_underground() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::WaterPipe, 1, 1);
        assert!(s.tile_at(1, 1).unwrap().has_occupant(Occupant::Pipe));
    }

    #[test]
    fn place_1x1_building_stamps_tile_and_charges() {
        let mut s = gs(4, 4);
        let before = s.money;
        let r = apply_tool(&mut s, Tool::WaterPump, 0, 0);
        assert!(r.success);
        assert_eq!(wire_kind_at(&s, 0, 0), TileKind::WaterPump);
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
                assert_eq!(wire_kind_at(&s, dx, dy), TileKind::WaterTower);
                assert_eq!(s.tile_at(dx, dy).unwrap().building_id, Some(bid));
            }
        }
    }

    #[test]
    fn place_building_fails_out_of_bounds() {
        let mut s = gs(3, 3);
        // WaterTower is 2×2; placing at (2,2) would go to (3,3) which is out of bounds
        let r = apply_tool(&mut s, Tool::WaterTower, 2, 2);
        assert!(!r.success);
        assert_eq!(wire_kind_at(&s, 2, 2), TileKind::Land);
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
        assert_eq!(wire_kind_at(&s, 0, 0), TileKind::Land);
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
        assert!(s.tile_at(0, 0).unwrap().has_occupant(Occupant::Pipe));
        apply_tool(&mut s, Tool::Bulldoze, 0, 0);
        assert!(!s.tile_at(0, 0).unwrap().has_occupant(Occupant::Pipe));
    }

    #[test]
    fn road_and_rail_carry_a_hydro_line_rather_than_severing_it() {
        // Road preserves rail and rail preserves road, both deliberately, so
        // that level crossings work. Power used to be the odd one out: paving
        // under a line destroyed it silently, with no warning and no refund,
        // while doing the same two things in the other order gave a crossing.
        for tool in [Tool::Road, Tool::Rail] {
            let mut s = gs(4, 4);
            apply_tool(&mut s, Tool::PowerLine, 1, 1);
            apply_tool(&mut s, tool, 1, 1);

            assert_eq!(
                wire_kind_at(&s, 1, 1),
                TileKind::PowerLine,
                "{tool:?} severed the line"
            );
            let t = s.tile_at(1, 1).unwrap();
            assert!(
                t.has_occupant(Occupant::PowerLine),
                "{tool:?} cleared the span"
            );
            let beneath = match tool {
                Tool::Road => t.has_occupant(Occupant::Road),
                _ => t.has_occupant(Occupant::Rail),
            };
            assert!(beneath, "{tool:?} did not record itself beneath the line");
        }
    }

    #[test]
    fn build_order_does_not_change_the_tile() {
        // The whole point: the same two actions in either order must produce
        // the same tile, bit for bit. Two spellings of one situation is how
        // the renderer ended up with a pole standing in the middle of a road.
        for (first, second) in [
            (Tool::Road, Tool::PowerLine),
            (Tool::Rail, Tool::PowerLine),
            (Tool::Residential, Tool::PowerLine),
            (Tool::Commercial, Tool::PowerLine),
        ] {
            let mut forward = gs(4, 4);
            apply_tool(&mut forward, first, 1, 1);
            apply_tool(&mut forward, second, 1, 1);

            let mut reverse = gs(4, 4);
            apply_tool(&mut reverse, second, 1, 1);
            apply_tool(&mut reverse, first, 1, 1);

            assert_eq!(
                (wire_kind_at(&forward, 1, 1), wire_flags_at(&forward, 1, 1)),
                (wire_kind_at(&reverse, 1, 1), wire_flags_at(&reverse, 1, 1)),
                "{first:?} then {second:?} disagreed on the wire bytes"
            );
            assert_eq!(
                forward.tile_at(1, 1).unwrap().occupants,
                reverse.tile_at(1, 1).unwrap().occupants,
                "{first:?} then {second:?} disagreed on the occupant set"
            );
        }
    }

    /// The rail must not appear as its own underlay on the wire. An underlay
    /// bit means "present, but not the kind byte"; a rail that is the kind byte
    /// and sets `RAIL_UNDERLAY` too is a tile spelled twice.
    #[test]
    fn rail_over_road_keeps_the_road_but_not_a_stale_rail_underlay() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::Road, 1, 1);
        apply_tool(&mut s, Tool::Rail, 1, 1);
        assert!(
            s.tile_at(1, 1).unwrap().has_occupant(Occupant::Road),
            "the road under the rail was lost"
        );
        assert_eq!(wire_kind_at(&s, 1, 1), TileKind::Rail);
        assert_eq!(wire_flags_at(&s, 1, 1), flags::ROAD_UNDERLAY);
    }

    #[test]
    fn bulldoze_clears_structural_flags() {
        // A hydro line laid over a road sets both the road underlay and the
        // power overlay. Bulldozing must clear them, or the tile keeps
        // rendering a road and wires that are no longer there.
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::Road, 1, 1);
        apply_tool(&mut s, Tool::PowerLine, 1, 1);
        assert!(s.tile_at(1, 1).unwrap().has_occupant(Occupant::Road));
        assert!(s.tile_at(1, 1).unwrap().has_occupant(Occupant::PowerLine));

        apply_tool(&mut s, Tool::Bulldoze, 1, 1);
        assert_eq!(wire_kind_at(&s, 1, 1), TileKind::Land);
        assert_eq!(wire_flags_at(&s, 1, 1), 0, "a structural bit survived");
        assert_eq!(
            s.tile_at(1, 1).unwrap().visible_occupants(),
            0,
            "the bulldozer clears everything you can see"
        );
    }

    #[test]
    fn power_line_sets_power_overlay_flag() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::PowerLine, 0, 0);
        assert_eq!(wire_kind_at(&s, 0, 0), TileKind::PowerLine);
        assert!(s.tile_at(0, 0).unwrap().has_occupant(Occupant::PowerLine));
    }

    #[test]
    fn place_elementary_school_2x2() {
        let mut s = gs(4, 4);
        let r = apply_tool(&mut s, Tool::ElementarySchool, 0, 0);
        assert!(r.success);
        assert_eq!(wire_kind_at(&s, 0, 0), TileKind::ElementarySchool);
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
                wire_kind_at(&s, 1, 1),
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
        assert_eq!(wire_kind_at(&s, 1, 1), TileKind::Road, "road should remain");
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
    fn building_over_a_line_hidden_in_the_overlay_flag_fails() {
        // The step-2 fix (#177). A line strung across a zone keeps `kind` on
        // the zone and records itself in `FLAG_POWER_OVERLAY`, so the old
        // `kind`-enumerating guard could not see it and let a park land on live
        // conductors — which went on drawing, conducting and billing.
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::Residential, 1, 1);
        apply_tool(&mut s, Tool::PowerLine, 1, 1);
        let t = s.tile_at(1, 1).unwrap();
        assert_eq!(t.zone_occupant(), Some(Occupant::ZoneResidential));
        assert!(t.has_occupant(Occupant::PowerLine));

        let before_money = s.money;
        let r = apply_tool(&mut s, Tool::Park, 1, 1);
        assert!(!r.success, "a park was stamped over a live hydro line");
        assert_eq!(s.money, before_money, "must not charge on rejection");
        assert!(s.buildings.is_empty());
        assert_eq!(wire_kind_at(&s, 1, 1), TileKind::Residential);
    }

    #[test]
    fn building_over_a_terraformed_line_fails() {
        // The other route to the same tile: a regrade rewrites the ground and
        // leaves the span standing overhead, which is correct — but in v4 it
        // also moved the line out of `kind`, and the old guard read only
        // `kind`. There is no `kind` to move out of any more, which is the
        // point of the flip; the guard reads the occupant set either way.
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::PowerLine, 1, 1);
        apply_tool(&mut s, Tool::TerraformRaise, 1, 1);
        let t = s.tile_at(1, 1).unwrap();
        assert_eq!(t.occupants_in(Stratum::Surface), 0, "the ground is bare");
        assert!(t.has_occupant(Occupant::PowerLine));
        // …and the wire now spells it the same as any other bare hydro line.
        assert_eq!(wire_kind_at(&s, 1, 1), TileKind::PowerLine);

        let r = apply_tool(&mut s, Tool::HydroPlant, 1, 1);
        assert!(!r.success, "a plant was stamped over a terraformed line");
    }

    #[test]
    fn terraforming_regrades_the_ground_and_leaves_the_strata_above_and_below() {
        // Terrain is not an occupant: a span crosses the tile whatever the
        // ground does under it, and a buried pipe is at depth. Both terraform
        // tools must therefore leave the overhead and underground strata alone
        // — which is also why the sweep's `PowerLine → TerraformRaise` route
        // was never a terraforming bug, only a guard that read `kind`.
        for (tool, expected) in [
            (Tool::TerraformRaise, Terrain::Land),
            (Tool::TerraformLower, Terrain::Water),
        ] {
            let mut s = gs(4, 4);
            apply_tool(&mut s, Tool::PowerLine, 1, 1);
            apply_tool(&mut s, Tool::WaterPipe, 1, 1);
            apply_tool(&mut s, tool, 1, 1);

            let t = s.tile_at(1, 1).unwrap();
            assert_eq!(t.terrain(), expected, "{tool:?} did not regrade the ground");
            assert!(
                t.has_occupant(Occupant::PowerLine),
                "{tool:?} took down the span"
            );
            assert!(t.has_occupant(Occupant::Pipe), "{tool:?} dug up the pipe");
            assert_eq!(
                t.occupants_in(Stratum::Surface),
                0,
                "{tool:?} left something standing on the regraded ground"
            );
        }
    }

    /// **The wilderness exploit.** Terraforming wrote `kind` with no guard at
    /// all, so lowering the ground under a coal plant left `kind = Water`,
    /// `building_id = Some(1)`, `power_plant_mw = 80` and the
    /// `BuildingInstance` all in place — but an *empty* occupant set. The
    /// plant kept producing 80 MW and billing $300/day while
    /// `compute_wilderness`, which scores the occupant set, could no longer
    /// see it: ten credits permanently bought off `structure_eco(CoalPlant)`.
    #[test]
    fn terraforming_refuses_a_tile_carrying_a_live_building() {
        use crate::wilderness::{compute_wilderness, WildernessTunables};

        for tool in [Tool::TerraformRaise, Tool::TerraformLower, Tool::Water] {
            let mut s = gs(8, 8);
            assert!(apply_tool(&mut s, Tool::CoalPlant, 5, 5).success);
            let before_money = s.money;
            let before_score = compute_wilderness(&s, &WildernessTunables::default()).score;

            let r = apply_tool(&mut s, tool, 5, 5);
            assert!(
                !r.success,
                "{tool:?} regraded the ground under a live plant"
            );
            assert_eq!(s.money, before_money, "{tool:?} charged on rejection");

            assert_eq!(
                wire_kind_at(&s, 5, 5),
                TileKind::CoalPlant,
                "{tool:?} moved the plant"
            );
            let t = s.tile_at(5, 5).unwrap();
            assert_eq!(t.building_id, Some(1));
            assert_eq!(t.power_plant_mw, COAL_PLANT_MW as i32);
            assert!(
                t.has_occupant(Occupant::Structure),
                "{tool:?} left a plant that is still running, billed and \
                 producing with nothing on the tile to score"
            );
            assert_eq!(s.buildings.len(), 1);
            assert_eq!(
                compute_wilderness(&s, &WildernessTunables::default()).score,
                before_score,
                "{tool:?} bought off the plant's wilderness penalty"
            );
        }
    }

    /// The same hole, reached through a zone rather than a footprint building:
    /// a developed residential lot carries a `building_id` under `kind =
    /// Residential`, and a regrade used to drown the lot while its household
    /// stayed in `state.buildings`.
    #[test]
    fn terraforming_refuses_a_developed_zone_lot() {
        let mut s = gs(8, 8);
        apply_tool(&mut s, Tool::Road, 1, 1);
        apply_tool(&mut s, Tool::Residential, 2, 1);
        crate::zones::place_zone_building(&mut s, 2, 1);
        assert!(s.tile_at(2, 1).unwrap().building_id.is_some(), "lot grew");

        let r = apply_tool(&mut s, Tool::TerraformLower, 2, 1);
        assert!(!r.success, "a regrade drowned a developed lot");
        assert_eq!(
            r.message.as_deref(),
            Some("A building occupies this tile. Bulldoze first.")
        );
        assert_eq!(wire_kind_at(&s, 2, 1), TileKind::Residential);
        assert_eq!(s.buildings.len(), 1);
    }

    /// A regrade wipes what stood on the ground — it always has — and it must
    /// wipe it the same however the surface occupant happens to be spelled. In
    /// v4 a bare road lived in `kind` and a road under a line lived in
    /// `FLAG_ROAD_UNDERLAY`, and the plain `kind` write erased the first while
    /// preserving the second: whether terraforming destroyed your road, silently
    /// and with no refund, depended on whether you had strung a line over it
    /// first. There is one spelling now, and `regrade_at` clears the stratum it
    /// lives in.
    ///
    /// The line itself is *not* wiped in either spelling — it is overhead.
    #[test]
    fn terraforming_clears_a_road_or_rail_in_either_spelling() {
        use crate::occupants::{OVERHEAD_MASK, SURFACE_MASK};

        for surface in [Tool::Road, Tool::Rail] {
            for line_first in [false, true] {
                let mut s = gs(4, 4);
                assert!(apply_tool(&mut s, surface, 1, 1).success);
                if line_first {
                    assert!(apply_tool(&mut s, Tool::PowerLine, 1, 1).success);
                }
                let before = s.tile_at(1, 1).unwrap().clone();
                assert!(
                    before.occupants & SURFACE_MASK != 0,
                    "{surface:?} (line_first={line_first}): nothing on the ground \
                     to clear — the premise of this test"
                );
                let before_money = s.money;

                let r = apply_tool(&mut s, Tool::TerraformRaise, 1, 1);
                assert!(
                    r.success,
                    "{surface:?} (line_first={line_first}) was refused: {:?}",
                    r.message
                );
                assert_eq!(
                    s.money,
                    before_money - tool_cost(Tool::TerraformRaise),
                    "{surface:?} (line_first={line_first}): not charged"
                );

                let after = s.tile_at(1, 1).unwrap();
                assert_eq!(
                    after.terrain(),
                    Terrain::Land,
                    "{surface:?} (line_first={line_first}): ground not regraded"
                );
                assert_eq!(
                    after.occupants & SURFACE_MASK,
                    0,
                    "{surface:?} (line_first={line_first}): the {} spelling \
                     survived a regrade that erased the other",
                    if line_first { "underlay" } else { "kind" }
                );
                assert!(!after.has_occupant(Occupant::Road) && !after.has_occupant(Occupant::Rail));
                assert_eq!(
                    after.occupants & OVERHEAD_MASK,
                    before.occupants & OVERHEAD_MASK,
                    "{surface:?} (line_first={line_first}): the span crosses the \
                     tile whatever the ground does"
                );
            }
        }
    }

    /// Zoned land is surface too, and the brush wipes it exactly as it wipes a
    /// road: terraforming an old district into a lake is a click that has always
    /// worked, and `Tool::Bulldoze` costs 1 against terraform's 10, so there is
    /// no cheap-clearance exploit to close by refusing. Open ground is still
    /// open ground.
    #[test]
    fn a_regrade_wipes_zoned_land_and_still_works_on_open_ground() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::Residential, 1, 1);
        let before_money = s.money;
        let r = apply_tool(&mut s, Tool::TerraformLower, 1, 1);
        assert!(r.success, "a regrade was refused over an undeveloped zone");
        assert_eq!(s.money, before_money - tool_cost(Tool::TerraformLower));
        assert_eq!(wire_kind_at(&s, 1, 1), TileKind::Water);
        assert_eq!(
            s.tile_at(1, 1).unwrap().occupants,
            0,
            "the zone tag outlived the regrade"
        );

        for (tool, expected) in [
            (Tool::TerraformLower, TileKind::Water),
            (Tool::TerraformRaise, TileKind::Land),
            (Tool::Water, TileKind::Water),
        ] {
            let before_money = s.money;
            let r = apply_tool(&mut s, tool, 3, 3);
            assert!(r.success, "{tool:?} refused open ground");
            assert_eq!(wire_kind_at(&s, 3, 3), expected);
            assert_eq!(s.money, before_money - tool_cost(tool));
        }
    }

    /// `Tool::Tree` carried the regrade's asymmetry at 8 credits rather than 10.
    /// A bare road at `kind = Road` was erased by the canopy — it stopped being
    /// billed `MAINT_ROAD`, and `compute_wilderness` credited the tile +6.0
    /// forest in place of −2.0 transport — while the same physical tile with a
    /// line strung over it first kept its road in `FLAG_ROAD_UNDERLAY`, still
    /// billed and still scored −2.0. Whether planting destroyed your road came
    /// down to build order. Now it always does.
    #[test]
    fn planting_clears_a_road_or_rail_in_either_spelling() {
        use crate::occupants::{OVERHEAD_MASK, SURFACE_MASK};
        use crate::wilderness::{compute_wilderness, WildernessTunables};

        for surface in [Tool::Road, Tool::Rail] {
            for line_first in [false, true] {
                let mut s = gs(4, 4);
                assert!(apply_tool(&mut s, surface, 1, 1).success);
                if line_first {
                    assert!(apply_tool(&mut s, Tool::PowerLine, 1, 1).success);
                }
                let before = s.tile_at(1, 1).unwrap().clone();
                let before_money = s.money;

                let r = apply_tool(&mut s, Tool::Tree, 1, 1);
                assert!(r.success, "{surface:?} (line_first={line_first}) refused");
                assert_eq!(s.money, before_money - tool_cost(Tool::Tree));

                assert_eq!(wire_kind_at(&s, 1, 1), TileKind::Tree);
                let after = s.tile_at(1, 1).unwrap();
                assert_eq!(
                    after.occupants & SURFACE_MASK,
                    0,
                    "{surface:?} (line_first={line_first}): the {} spelling \
                     survived a planting that erased the other",
                    if line_first { "underlay" } else { "kind" }
                );
                assert_eq!(
                    after.occupants
                        & OVERHEAD_MASK
                        & !crate::occupants::occupant_bit(Occupant::Trees),
                    before.occupants & OVERHEAD_MASK,
                    "{surface:?} (line_first={line_first}): the span crosses the \
                     tile whatever grows under it"
                );
                // The wilderness ledger agrees: a forest, and a line if one was
                // strung, but never a road or a rail.
                let b = compute_wilderness(&s, &WildernessTunables::default()).breakdown;
                assert_eq!(b.transport, 0.0, "a road or rail is still being scored");
                assert_eq!(b.power, if line_first { -1.0 } else { 0.0 });
            }
        }
    }

    /// Planting shares the tile with a road or a zone in the target model, so
    /// `Tool::Tree` keeps displacing them — that blindness is
    /// `known_defect_trees_are_planted_through_a_live_hydro_line`, a gameplay
    /// decision of its own. The half that is *not* a gameplay decision is a
    /// canopy stranding a live plant, which erased the `Structure` occupant
    /// and its penalty exactly as the regrade did.
    #[test]
    fn planting_refuses_a_tile_carrying_a_live_building() {
        let mut s = gs(8, 8);
        assert!(apply_tool(&mut s, Tool::CoalPlant, 5, 5).success);
        let before_money = s.money;

        let r = apply_tool(&mut s, Tool::Tree, 5, 5);
        assert!(!r.success, "a canopy was planted over a live plant");
        assert_eq!(s.money, before_money, "charged on rejection");
        assert_eq!(wire_kind_at(&s, 5, 5), TileKind::CoalPlant);
        assert_eq!(s.buildings.len(), 1);

        // Open ground still takes a tree.
        assert!(apply_tool(&mut s, Tool::Tree, 0, 0).success);
        assert_eq!(wire_kind_at(&s, 0, 0), TileKind::Tree);
    }

    #[test]
    fn a_structure_still_displaces_a_zone_and_a_tree() {
        // The guard refuses what a structure *conflicts* with; a zone and a
        // tree are displaced instead, and stamping over either is ordinary
        // play. Converting the guard to the occupant set must not turn a
        // displacement into a refusal.
        for tool in [
            Tool::Residential,
            Tool::Commercial,
            Tool::Industrial,
            Tool::Tree,
        ] {
            let mut s = gs(4, 4);
            assert!(apply_tool(&mut s, tool, 1, 1).success);
            let r = apply_tool(&mut s, Tool::Park, 1, 1);
            assert!(r.success, "a park was refused over {tool:?}");
            assert_eq!(wire_kind_at(&s, 1, 1), TileKind::Park);
        }
    }

    #[test]
    fn a_zone_still_shares_its_tile_with_a_line_in_either_order() {
        // The converse of the fix, and the property 55de254 established: a zone
        // and a line coexist. Tightening the *structure* guard must not have
        // tightened this one by association.
        for (first, second) in [
            (Tool::Residential, Tool::PowerLine),
            (Tool::PowerLine, Tool::Residential),
        ] {
            let mut s = gs(4, 4);
            assert!(apply_tool(&mut s, first, 1, 1).success);
            assert!(
                apply_tool(&mut s, second, 1, 1).success,
                "{first:?} then {second:?} was refused"
            );
            let t = s.tile_at(1, 1).unwrap();
            assert!(
                t.has_occupant(Occupant::PowerLine),
                "{first:?} then {second:?} lost the line"
            );
            assert_eq!(
                t.zone_occupant(),
                Some(Occupant::ZoneResidential),
                "{first:?} then {second:?} lost the zone"
            );
        }
    }

    #[test]
    fn a_line_still_ploughs_through_forest() {
        // Displacement, not refusal: utilities trim canopy away from conductors
        // and the map generator grows forests, so routing a line through trees
        // must not need a bulldozer. (The converse — planting a tree *under* a
        // live line — is still the open defect tracked in `occupants.rs`.)
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::Tree, 1, 1);
        let r = apply_tool(&mut s, Tool::PowerLine, 1, 1);
        assert!(r.success, "a line was refused over a tree");
        assert_eq!(wire_kind_at(&s, 1, 1), TileKind::PowerLine);
    }

    #[test]
    /// **Behaviour change, step 3 of #177 — see `remove_building`.** A
    /// bulldozed park used to leave its `kind` standing with no building
    /// behind it: a ghost that still scored +4.0 of wilderness and took a
    /// second click to clear. The tag goes with the development now, so the
    /// tile is bare ground on the wire and on the ledger.
    fn a_bulldozed_park_leaves_bare_ground() {
        for tool in [Tool::Residential, Tool::Road, Tool::Rail, Tool::PowerLine] {
            let mut s = gs(4, 4);
            apply_tool(&mut s, Tool::Park, 1, 1);
            let bid = s.tile_at(1, 1).unwrap().building_id.unwrap();
            remove_building(&mut s, bid as u32);
            assert_eq!(wire_kind_at(&s, 1, 1), TileKind::Land);
            assert_eq!(s.tile_at(1, 1).unwrap().occupants, 0);
            assert!(s.tile_at(1, 1).unwrap().building_id.is_none());

            let r = apply_tool(&mut s, tool, 1, 1);
            assert!(r.success, "{tool:?} was refused by a demolished park");
        }
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
                wire_kind_at(&s, 0, 0),
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
