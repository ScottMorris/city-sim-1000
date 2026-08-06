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
    building_kind::BuildingKind,
    commands::{CommandResult, Tool, ViewStratum},
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
// `Tile::occupants()` and consult `pair_conflicts` instead, and since step 3
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
/// Reads `tile.occupants()` directly. It used to have to filter out a *ghost*
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
    let standing = tile.occupants() & !displaces;
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
/// `stratum` names the layer the player is looking at, filled from the
/// client's active view. Only `Tool::Bulldoze` (see `bulldoze`) and
/// `Tool::WaterPipe` (refuses outright unless `Underground`) read it today —
/// every other tool ignores it, but it is threaded through every call site so
/// the field travels on the wire for every command, not just the ones that
/// currently read it (`docs/features/layer-scoped-bulldozer.md`).
///
/// Validates funds and placement rules, modifies state on success, and returns
/// a `CommandResult` indicating success or a human-readable failure reason.
pub fn apply_tool(
    state: &mut GameState,
    tool: Tool,
    x: u32,
    y: u32,
    stratum: ViewStratum,
) -> CommandResult {
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
            // Belt-and-suspenders: `#197`'s client-side click-guard already
            // switches the view to Underground the moment this tool is
            // selected and refuses a click if the player manually toggles
            // away before placing (`SPEC.md`'s Utilities section), so this
            // should be unreachable from the ordinary UI. It is reachable
            // from `mcpBridge.ts`/the MCP server, though, which have no view
            // state and default `stratum` to `Surface` — so the engine needs
            // its own refusal rather than trusting the client entirely.
            if stratum != ViewStratum::Underground {
                return CommandResult::fail("Water pipes must be laid from the Underground view.");
            }
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

        // Power plants — each uses its own BuildingKind; per-type MW output and
        // maintenance are stored in BuildingInstance for the budget and power BFS.
        Tool::HydroPlant => place_footprint_building(
            state,
            BuildingKind::HydroPlant,
            x,
            y,
            cost,
            HYDRO_PLANT_MW,
            150.0,
        ),
        Tool::CoalPlant => place_footprint_building(
            state,
            BuildingKind::CoalPlant,
            x,
            y,
            cost,
            COAL_PLANT_MW,
            300.0,
        ),
        Tool::WindTurbine => place_footprint_building(
            state,
            BuildingKind::WindTurbine,
            x,
            y,
            cost,
            WIND_TURBINE_MW,
            30.0,
        ),
        Tool::SolarFarm => place_footprint_building(
            state,
            BuildingKind::SolarFarm,
            x,
            y,
            cost,
            SOLAR_FARM_MW,
            20.0,
        ),
        Tool::WaterPump => {
            place_footprint_building(state, BuildingKind::WaterPump, x, y, cost, 0, 0.0)
        }
        Tool::WaterTower => {
            place_footprint_building(state, BuildingKind::WaterTower, x, y, cost, 0, 0.0)
        }
        Tool::ElementarySchool => {
            place_footprint_building(state, BuildingKind::ElementarySchool, x, y, cost, 0, 0.0)
        }
        Tool::HighSchool => {
            place_footprint_building(state, BuildingKind::HighSchool, x, y, cost, 0, 0.0)
        }
        Tool::Park => place_footprint_building(state, BuildingKind::Park, x, y, cost, 0, 0.0),
        Tool::ParkLarge => {
            place_footprint_building(state, BuildingKind::ParkLarge, x, y, cost, 0, 0.0)
        }

        Tool::Bulldoze => bulldoze(state, x, y, cost, stratum),
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
/// Every tool that builds calls this first, and they all pass `Terrain::Land`
/// — so construction still fills in water. That is the one place terrain is
/// not durable, and it is deliberate: building over water is bridges and
/// docks, a feature of its own. [`bulldoze`] is the other side of it and does
/// not come through here at all, because clearing a tile is not a regrade.
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
/// can carry its own cost without needing a separate `BuildingKind`.  Pass 0.0 to
/// fall back to the template's `maintenance` field at budget time.
fn place_footprint_building(
    state: &mut GameState,
    kind: BuildingKind,
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
            state.tiles[idx].set_building_id(bid);
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

/// Bulldoze the tile at (x, y): clear `stratum` — and nothing else — leaving
/// the ground itself, and every other stratum, exactly as it was.
///
/// **Layer-scoped, not view-blind (`#198`).** Until now this function ignored
/// which layer the player was looking at and applied a fixed precedence —
/// building, then underground, then surface+overhead — so a surface click on
/// a tile with only a buried pipe silently destroyed the pipe, and an
/// underground click on a tile with an empty underground stratum fell through
/// and razed the dimmed surface. `docs/tile-model.md` has said "underground
/// occupants are only removable from the underground view" since the strata
/// model was designed; `stratum` (threaded onto `ApplyTool` in the prior PR)
/// is what finally lets the engine honour it. `stratum: Surface` never
/// touches `underground`; `stratum: Underground` never touches
/// `building_id`/surface/overhead. Buildings are surface-stratum objects
/// (`docs/features/layer-scoped-bulldozer.md`), so `stratum: Surface` is what
/// removes one, exactly as every click did before this existed.
///
/// **Free no-op (also `#198`).** The cost used to be deducted unconditionally
/// before the branch, so bulldozing bare land — or, since this fix, the empty
/// half of a tile carrying something in the other stratum — charged a credit
/// for nothing. `Tool::Bulldoze` now costs money only when it actually clears
/// something; an empty-stratum click is `CommandResult::fail`, not `ok`, so
/// the demolition SFX and "Demolition crews active" narrative event — both
/// gated on `success` — stay truthful about whether anything happened.
///
/// **Terrain is not the bulldozer's to change (#177 step 4).** A bulldozed
/// lake stays a lake — clearing `Surface` never touches `terrain` — and the
/// terrain brushes (`TerraformRaise`, `TerraformLower`, `Tool::Water`) are the
/// only tools *for* changing what the ground is; that is what they charge 10,
/// 10 and 12 for. They are not the only tools that *move* it, though:
/// [`regrade_at`] writes `Terrain::Land`, and every building tool calls it to
/// wipe the surface before it lays anything down, so a lake is still
/// drainable — pave it, raze the pavement, and the ground stays where the
/// road left it, 6 credits under either brush. See
/// `tests::building_over_water_and_razing_it_is_the_cheapest_regrade`.
///
/// A tile carrying water *and* something built on it is therefore a real
/// arrangement, reached in two ordinary clicks: `regrade_at` takes the
/// surface stratum and the canopy but deliberately leaves the overhead line
/// and the buried pipe standing, so `PowerLine` then `Tool::Water` — or
/// `WaterPipe` then `Tool::Water` — is water with something on it. The rule
/// reads correctly on those: what stands goes, the water stays. Water
/// carrying a *road* is the unreachable case, because the brush clears the
/// stratum a road lives in; a `Surface` bulldoze still has to be total over
/// it, because [`set_v4`] can build one out of a loaded save and `Tile` can
/// hold one.
///
/// [`set_v4`]: crate::migrate::set_v4
fn bulldoze(
    state: &mut GameState,
    x: u32,
    y: u32,
    cost: i64,
    stratum: ViewStratum,
) -> CommandResult {
    let idx = state.tile_index(x, y).unwrap();
    match stratum {
        ViewStratum::Surface => {
            if let Some(bid) = state.tiles[idx].building_id {
                state.money -= cost;
                remove_building(state, bid as u32);
                CommandResult::ok()
            } else if !state.tiles[idx].surface.is_empty() || !state.tiles[idx].overhead.is_empty()
            {
                state.money -= cost;
                let tile = &mut state.tiles[idx];
                tile.clear_stratum(Stratum::Surface);
                tile.clear_stratum(Stratum::Overhead);
                // FLAG_POWERED / FLAG_WATERED are recomputed by the utility
                // passes; ABANDONED describes a lot that no longer exists.
                tile.set_flag(FLAG_ABANDONED, false);
                state.tile_revision += 1;
                CommandResult::ok()
            } else {
                CommandResult::fail("Nothing to demolish here")
            }
        }
        ViewStratum::Underground => {
            if state.tiles[idx].underground.is_empty() {
                CommandResult::fail("Nothing to demolish here")
            } else {
                state.money -= cost;
                state.tiles[idx].clear_stratum(Stratum::Underground);
                CommandResult::ok()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrate::set_v4_kind;
    use city_sim_protocol::legacy_tile_buffer::legacy_flags as flags;
    use city_sim_protocol::tile_kind::TileKind;

    fn gs(w: u32, h: u32) -> GameState {
        GameState::new(w, h, 0)
    }

    /// The `BuildingKind` of the `BuildingInstance` covering (x,y), if any —
    /// the one place a specific structure kind still lives since #177 step 3
    /// (`Occupant::Structure` is one flat tag; the structure's own kind is on
    /// its `BuildingInstance`, not the tile).
    fn structure_kind_at(s: &GameState, x: u32, y: u32) -> Option<BuildingKind> {
        let id = s.tile_at(x, y)?.building_id? as u32;
        s.buildings.iter().find(|b| b.id == id).map(|b| b.kind)
    }

    #[test]
    fn inspect_always_succeeds() {
        let mut s = gs(4, 4);
        let r = apply_tool(&mut s, Tool::Inspect, 0, 0, ViewStratum::Surface);
        assert!(r.success);
        assert_eq!(s.money, 100_000);
    }

    #[test]
    fn out_of_bounds_fails() {
        let mut s = gs(4, 4);
        let r = apply_tool(&mut s, Tool::Road, 10, 10, ViewStratum::Surface);
        assert!(!r.success);
    }

    #[test]
    fn no_funds_fails() {
        let mut s = gs(4, 4);
        s.money = 0;
        let r = apply_tool(&mut s, Tool::Road, 0, 0, ViewStratum::Surface);
        assert!(!r.success);
        assert_eq!(r.message.as_deref(), Some("Not enough funds"));
    }

    #[test]
    fn road_places_road_and_charges_money() {
        let mut s = gs(4, 4);
        let before = s.money;
        let r = apply_tool(&mut s, Tool::Road, 1, 1, ViewStratum::Surface);
        assert!(r.success);
        assert!(s.tile_at(1, 1).unwrap().has_occupant(Occupant::Road));
        assert_eq!(s.money, before - tool_cost(Tool::Road));
    }

    /// A level crossing carries both occupants whichever way round it was
    /// built. There is no collision to normalise any more — `Road` and `Rail`
    /// are two independent bits in the same surface stratum, not two
    /// candidates for one `kind` slot — so build-order independence now falls
    /// out of the occupant set being a set, rather than needing a precedence
    /// rule to manufacture it.
    #[test]
    fn a_level_crossing_has_one_spelling_in_both_build_orders() {
        for order in [[Tool::Rail, Tool::Road], [Tool::Road, Tool::Rail]] {
            let mut s = gs(4, 4);
            for tool in order {
                assert!(apply_tool(&mut s, tool, 0, 0, ViewStratum::Surface).success);
            }
            let t = s.tile_at(0, 0).unwrap();
            assert!(t.has_occupant(Occupant::Road), "{order:?}: the road");
            assert!(t.has_occupant(Occupant::Rail), "{order:?}: the rail");
        }
    }

    #[test]
    fn zone_tool_charges_and_sets_kind() {
        let mut s = gs(4, 4);
        let before = s.money;
        let r = apply_tool(&mut s, Tool::Residential, 2, 2, ViewStratum::Surface);
        assert!(r.success);
        assert_eq!(
            s.tile_at(2, 2).unwrap().zone_occupant(),
            Some(Occupant::ZoneResidential)
        );
        assert_eq!(s.money, before - tool_cost(Tool::Residential));
    }

    #[test]
    fn zone_over_road_fails() {
        let mut s = gs(4, 4);
        set_v4_kind(s.tile_at_mut(0, 0).unwrap(), TileKind::Road);
        let r = apply_tool(&mut s, Tool::Residential, 0, 0, ViewStratum::Surface);
        assert!(!r.success);
        assert!(
            s.tile_at(0, 0).unwrap().has_occupant(Occupant::Road),
            "tile should not change"
        );
    }

    #[test]
    fn water_pipe_sets_underground() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::WaterPipe, 1, 1, ViewStratum::Underground);
        assert!(s.tile_at(1, 1).unwrap().has_occupant(Occupant::Pipe));
    }

    /// **`#198`'s engine-side belt-and-suspenders.** The client-side click
    /// guard (`#197`) already keeps this unreachable from the ordinary UI —
    /// selecting `Tool::WaterPipe` switches the view to Underground, and a
    /// manual toggle away refuses the click before it's ever sent — but
    /// `mcpBridge.ts`/the MCP server have no view state and default `stratum`
    /// to `Surface`, so the engine needs its own refusal too.
    #[test]
    fn water_pipe_refuses_from_the_surface_view() {
        let mut s = gs(4, 4);
        let before = s.money;
        let r = apply_tool(&mut s, Tool::WaterPipe, 1, 1, ViewStratum::Surface);
        assert!(!r.success);
        assert_eq!(
            r.message.as_deref(),
            Some("Water pipes must be laid from the Underground view.")
        );
        assert!(!s.tile_at(1, 1).unwrap().has_occupant(Occupant::Pipe));
        assert_eq!(s.money, before, "a refused pipe must not charge");
    }

    #[test]
    fn place_1x1_building_stamps_tile_and_charges() {
        let mut s = gs(4, 4);
        let before = s.money;
        let r = apply_tool(&mut s, Tool::WaterPump, 0, 0, ViewStratum::Surface);
        assert!(r.success);
        assert_eq!(structure_kind_at(&s, 0, 0), Some(BuildingKind::WaterPump));
        assert!(s.tile_at(0, 0).unwrap().building_id.is_some());
        assert_eq!(s.buildings.len(), 1);
        assert_eq!(s.money, before - tool_cost(Tool::WaterPump));
    }

    #[test]
    fn place_2x2_building_fills_footprint() {
        let mut s = gs(4, 4);
        let r = apply_tool(&mut s, Tool::WaterTower, 0, 0, ViewStratum::Surface);
        assert!(r.success);
        let bid = s.tile_at(0, 0).unwrap().building_id.unwrap();
        for dy in 0..2 {
            for dx in 0..2 {
                assert_eq!(
                    structure_kind_at(&s, dx, dy),
                    Some(BuildingKind::WaterTower)
                );
                assert_eq!(s.tile_at(dx, dy).unwrap().building_id, Some(bid));
            }
        }
    }

    #[test]
    fn place_building_fails_out_of_bounds() {
        let mut s = gs(3, 3);
        // WaterTower is 2×2; placing at (2,2) would go to (3,3) which is out of bounds
        let r = apply_tool(&mut s, Tool::WaterTower, 2, 2, ViewStratum::Surface);
        assert!(!r.success);
        assert_eq!(s.tile_at(2, 2).unwrap().occupants(), 0);
    }

    #[test]
    fn place_building_fails_on_overlap() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::WaterPump, 0, 0, ViewStratum::Surface);
        let r = apply_tool(&mut s, Tool::WaterPump, 0, 0, ViewStratum::Surface);
        assert!(!r.success);
        assert_eq!(s.buildings.len(), 1, "only one building should exist");
    }

    #[test]
    fn bulldoze_removes_road() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::Road, 0, 0, ViewStratum::Surface);
        apply_tool(&mut s, Tool::Bulldoze, 0, 0, ViewStratum::Surface);
        assert_eq!(s.tile_at(0, 0).unwrap().occupants(), 0);
    }

    /// **The bulldozer clears the tile and leaves the ground (#177 step 4).**
    ///
    /// Both directions, because "restores the tile to its terrain" is only a
    /// rule if it holds for water as well as for land — a bulldozer that
    /// always leaves `Land` is not restoring anything, it is terraforming for
    /// 1 credit.
    ///
    /// The water half is built through [`set_v4`], because water carrying a
    /// *road* is the one arrangement `apply_tool` cannot reach: every tool
    /// that builds calls `regrade_at(.., Terrain::Land)` first, and the road
    /// lives in the very stratum the water brush clears, so laying a road
    /// across a lake fills the lake in as it goes. `bulldoze` still has to be
    /// total over the tile, because `Tile` can hold one and [`set_v4`] builds
    /// one out of what loads. The rule reads correctly on it: the road goes,
    /// the water stays.
    ///
    /// Water carrying an overhead line or a buried pipe *is* reachable, in two
    /// ordinary clicks — that half is
    /// `the_water_brush_leaves_the_line_and_the_pipe_standing_over_the_lake`.
    #[test]
    fn the_bulldozer_clears_the_tile_and_leaves_the_ground_alone() {
        // Dry land, built on through the tools.
        let mut s = gs(4, 4);
        assert!(apply_tool(&mut s, Tool::Road, 1, 1, ViewStratum::Surface).success);
        assert!(apply_tool(&mut s, Tool::PowerLine, 1, 1, ViewStratum::Surface).success);
        assert!(apply_tool(&mut s, Tool::Bulldoze, 1, 1, ViewStratum::Surface).success);
        let t = s.tile_at(1, 1).unwrap();
        assert_eq!(t.terrain(), Terrain::Land, "bulldozing land drowned it");
        assert_eq!(t.occupants(), 0, "something outlived the bulldozer");

        // Water, carrying the road a v4 save could leave standing on it.
        let mut s = gs(4, 4);
        crate::migrate::set_v4(
            s.tile_at_mut(2, 2).unwrap(),
            TileKind::Water,
            flags::ROAD_UNDERLAY,
            None,
        );
        assert!(s.tile_at(2, 2).unwrap().has_occupant(Occupant::Road));
        assert!(apply_tool(&mut s, Tool::Bulldoze, 2, 2, ViewStratum::Surface).success);
        let t = s.tile_at(2, 2).unwrap();
        assert_eq!(
            t.terrain(),
            Terrain::Water,
            "the bulldozer filled the lake in for 1 credit"
        );
        assert!(
            !t.has_occupant(Occupant::Road),
            "the road outlived the click"
        );
        assert_eq!(t.occupants(), 0);
    }

    /// The terrain brushes are the tools *for* changing what the ground is,
    /// and they are priced for it: `Tool::Water` costs 12 and `TerraformRaise`
    /// 10, against the bulldozer's 1. While `bulldoze` wrote `Terrain::Land`
    /// the cheapest tool on the palette was also the most powerful
    /// terraformer — it undid a 12-credit dig for a twelfth of the price, on a
    /// tile with nothing on it to bulldoze.
    ///
    /// A *builder* plus a bulldozer still regrades, for 6; that is
    /// `building_over_water_and_razing_it_is_the_cheapest_regrade`. What this
    /// test pins is narrower and is the thing step 4 changed: the bulldozer
    /// alone, on open water, no longer moves the ground at all. Since `#198`
    /// the click does not even succeed — open water carries nothing in any
    /// stratum, so it is a free no-op — but the point step 4 made still
    /// holds either way: terrain is not the bulldozer's to touch.
    #[test]
    fn bulldozing_open_water_is_not_a_cheap_regrade() {
        let mut s = gs(4, 4);
        assert!(apply_tool(&mut s, Tool::Water, 1, 1, ViewStratum::Surface).success);
        assert!(!apply_tool(&mut s, Tool::Bulldoze, 1, 1, ViewStratum::Surface).success);
        assert_eq!(s.tile_at(1, 1).unwrap().terrain(), Terrain::Water);

        // …and the brush that *is* priced for it still works.
        assert!(apply_tool(&mut s, Tool::TerraformRaise, 1, 1, ViewStratum::Surface).success);
        assert_eq!(s.tile_at(1, 1).unwrap().terrain(), Terrain::Land);
        assert!(
            tool_cost(Tool::TerraformRaise) > tool_cost(Tool::Bulldoze),
            "raising ground must cost more than clearing it"
        );
    }

    /// **Construction is a terraformer too, and it always was.**
    ///
    /// Step 4 stopped the *bulldozer* writing terrain. It did not — and was
    /// never meant to — stop `regrade_at`, which every building tool calls to
    /// wipe the surface before it lays anything down, and which writes
    /// `Terrain::Land` while it is there. So a lake is still drainable: pave
    /// it, then raze the pavement. The ground stays where the road left it.
    ///
    /// That pairing costs 6 credits a tile against the water brush's 12 and
    /// `TerraformRaise`'s 10, so the cheapest regrade on the palette is a road
    /// and a bulldozer, not a brush. Six times dearer than the 1-credit click
    /// step 4 removed, and one credit short of `PowerLine` + `Bulldoze` at 7 —
    /// but "the brushes are the only tools that change the ground" is not what
    /// the code says, and the docs must not say it either.
    ///
    /// Filling water in as you build over it is deliberate: it is what v4 did,
    /// it is what makes a causeway across a lake a two-click move rather than
    /// a refusal, and `regrade_at`'s own comment has described it that way from
    /// the start. This test pins the price so the claim in `SPEC.md`,
    /// `docs/game-parameters.md` and `docs/features/wilderness-score.md` stays
    /// honest about which tools move terrain.
    #[test]
    fn building_over_water_and_razing_it_is_the_cheapest_regrade() {
        let mut s = gs(4, 4);
        assert!(apply_tool(&mut s, Tool::Water, 1, 1, ViewStratum::Surface).success);
        assert_eq!(s.tile_at(1, 1).unwrap().terrain(), Terrain::Water);

        let before = s.money;
        assert!(apply_tool(&mut s, Tool::Road, 1, 1, ViewStratum::Surface).success);
        assert_eq!(
            s.tile_at(1, 1).unwrap().terrain(),
            Terrain::Land,
            "the road did not fill the lake in as it crossed it"
        );
        assert!(apply_tool(&mut s, Tool::Bulldoze, 1, 1, ViewStratum::Surface).success);

        let t = s.tile_at(1, 1).unwrap();
        assert_eq!(
            t.terrain(),
            Terrain::Land,
            "razing the road put the lake back"
        );
        assert_eq!(t.occupants(), 0, "something outlived the bulldozer");
        assert_eq!(
            before - s.money,
            tool_cost(Tool::Road) + tool_cost(Tool::Bulldoze),
            "the build-and-raze regrade is not priced as one"
        );
        assert!(
            tool_cost(Tool::Road) + tool_cost(Tool::Bulldoze) < tool_cost(Tool::TerraformRaise),
            "a builder plus a bulldozer must be documented as cheaper than the brush"
        );

        // `Tool::Road` is named in the docs as the cheap one, so check that it
        // still is: `WaterPipe` is cheaper but is not a regrade — it sets the
        // `Pipe` bit and never calls `regrade_at` — and everything else that
        // does regrade costs more than a road.
        let mut pipe = gs(4, 4);
        assert!(apply_tool(&mut pipe, Tool::Water, 1, 1, ViewStratum::Surface).success);
        assert!(apply_tool(&mut pipe, Tool::WaterPipe, 1, 1, ViewStratum::Underground).success);
        assert_eq!(
            pipe.tile_at(1, 1).unwrap().terrain(),
            Terrain::Water,
            "a buried main filled the lake in above it"
        );
        for cheaper in [Tool::Tree, Tool::PowerLine, Tool::Rail, Tool::Park] {
            assert!(
                tool_cost(cheaper) > tool_cost(Tool::Road),
                "{cheaper:?} undercuts the road as the cheapest regrade; the 6-credit \
                 figure in `SPEC.md`, `docs/game-parameters.md` and \
                 `docs/features/wilderness-score.md` needs revisiting"
            );
        }
    }

    /// **Water *and* something built on it is reachable through `apply_tool`.**
    ///
    /// [`regrade_at`] takes the surface stratum and the canopy; the overhead
    /// line and the buried pipe are deliberately left standing, because a
    /// hydro span crosses a lake on pylons and a main runs under one. So two
    /// ordinary clicks — build, then paint water — produce exactly the tile
    /// `bulldoze`'s rule has to be total over, with no legacy save involved.
    ///
    /// Road, rail and tree over water genuinely are unreachable: the brush
    /// clears the surface stratum they live in.
    #[test]
    fn the_water_brush_leaves_the_line_and_the_pipe_standing_over_the_lake() {
        let mut s = gs(4, 4);

        // Overhead: a hydro span, then a lake painted under it.
        assert!(apply_tool(&mut s, Tool::PowerLine, 2, 2, ViewStratum::Surface).success);
        assert!(apply_tool(&mut s, Tool::Water, 2, 2, ViewStratum::Surface).success);
        let t = s.tile_at(2, 2).unwrap();
        assert_eq!(t.terrain(), Terrain::Water);
        assert!(
            t.has_occupant(Occupant::PowerLine),
            "the water brush cut the span it should have crossed under"
        );

        // Underground: a main, then a lake painted over it.
        assert!(apply_tool(&mut s, Tool::WaterPipe, 3, 3, ViewStratum::Underground).success);
        assert!(apply_tool(&mut s, Tool::Water, 3, 3, ViewStratum::Surface).success);
        let t = s.tile_at(3, 3).unwrap();
        assert_eq!(t.terrain(), Terrain::Water);
        assert!(
            t.has_occupant(Occupant::Pipe),
            "the water brush dug the main up"
        );

        // And the bulldozer reads correctly on both, each from its own
        // stratum: what stands goes, the water stays. The line is overhead,
        // so a `Surface` bulldoze reaches it (charging, same as the
        // surface-nonempty branch — the shared `!surface.is_empty() ||
        // !overhead.is_empty()` check must charge on either half); the pipe
        // takes its own click from `Underground` (`#198`) — a `Surface`
        // bulldoze on (3,3) would find nothing in surface/overhead and
        // refuse (`surface_bulldoze_refuses_a_tile_with_only_underground_content`
        // pins that directly).
        let before = s.money;
        assert!(apply_tool(&mut s, Tool::Bulldoze, 2, 2, ViewStratum::Surface).success);
        let t = s.tile_at(2, 2).unwrap();
        assert_eq!(t.terrain(), Terrain::Water);
        assert_eq!(t.occupants(), 0);
        assert_eq!(s.money, before - tool_cost(Tool::Bulldoze));

        let before = s.money;
        assert!(apply_tool(&mut s, Tool::Bulldoze, 3, 3, ViewStratum::Underground).success);
        let t = s.tile_at(3, 3).unwrap();
        assert_eq!(t.terrain(), Terrain::Water);
        assert_eq!(t.occupants(), 0);
        assert_eq!(s.money, before - tool_cost(Tool::Bulldoze));
    }

    /// **Bulldozing a developed lot takes the building and nothing else.**
    ///
    /// `bulldoze` matches on `stratum` first; within the `Surface` arm, the
    /// building branch returns as soon as [`remove_building`] has run. That
    /// function clears
    /// `building_id`, the derived caches and the `Structure` tag — it never
    /// touches the zone tag, by design, because "bulldoze the house, keep the
    /// zoning, let it regrow" is the behaviour the zone tools have always had.
    /// The overhead line survives for the same reason the strata exist at all:
    /// it was never part of the lot.
    ///
    /// So one click on a developed lot leaves a vacant zone with a line over
    /// it, and a second click clears those. That is deliberate and unchanged
    /// by #177; the test exists because `SPEC.md` claimed a single click took
    /// the zone tag and the line with it.
    #[test]
    fn bulldozing_a_developed_lot_leaves_the_zone_tag_and_the_line() {
        use crate::rng::SeededRng;
        use crate::state::FLAG_POWERED;
        use crate::zones::ZoneGrowthSim;

        let mut s = gs(4, 4);
        assert!(apply_tool(&mut s, Tool::Road, 1, 0, ViewStratum::Surface).success);
        assert!(apply_tool(&mut s, Tool::Residential, 1, 1, ViewStratum::Surface).success);
        assert!(apply_tool(&mut s, Tool::PowerLine, 1, 1, ViewStratum::Surface).success);
        s.tile_at_mut(1, 0).unwrap().set_flag(FLAG_POWERED, true);
        s.tile_at_mut(1, 1).unwrap().set_flag(FLAG_POWERED, true);
        s.demand.residential = 100.0;
        s.utilities.power = 100;
        s.utilities.water = 100;

        let mut zg = ZoneGrowthSim::new();
        let mut rng = SeededRng::new(0);
        let mut grew = false;
        for _ in 0..50 {
            if zg.tick(&mut s, &mut rng, 1) {
                grew = true;
                break;
            }
        }
        assert!(grew, "the lot never developed");
        let t = s.tile_at(1, 1).unwrap();
        assert!(t.building_id.is_some());
        assert!(t.has_occupant(Occupant::ZoneResidential));
        assert!(t.has_occupant(Occupant::PowerLine));

        assert!(apply_tool(&mut s, Tool::Bulldoze, 1, 1, ViewStratum::Surface).success);
        let t = s.tile_at(1, 1).unwrap();
        assert!(t.building_id.is_none(), "the house outlived the click");
        assert!(
            !t.has_occupant(Occupant::Structure),
            "a razed lot left its `Structure` tag behind"
        );
        assert!(
            t.has_occupant(Occupant::ZoneResidential),
            "one click took the zoning as well as the house"
        );
        assert!(
            t.has_occupant(Occupant::PowerLine),
            "one click took the hydro line as well as the house"
        );

        // The second click is what clears them.
        assert!(apply_tool(&mut s, Tool::Bulldoze, 1, 1, ViewStratum::Surface).success);
        assert_eq!(s.tile_at(1, 1).unwrap().occupants(), 0);
    }

    #[test]
    fn bulldoze_removes_building_and_clears_tiles() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::WaterTower, 0, 0, ViewStratum::Surface);
        assert_eq!(s.buildings.len(), 1);
        apply_tool(&mut s, Tool::Bulldoze, 0, 0, ViewStratum::Surface);
        assert!(s.buildings.is_empty());
        for dy in 0..2 {
            for dx in 0..2 {
                assert!(s.tile_at(dx, dy).unwrap().building_id.is_none());
            }
        }
    }

    /// **Delta 3 of the three `display.rs` names, reached through the bulldozer
    /// rather than through the API.**
    ///
    /// `a_bulldozed_park_leaves_bare_ground` covers the same behaviour change
    /// by calling [`remove_building`] directly on a 1×1 park. This is the
    /// player's route to it — `Tool::Bulldoze` — and it is where the *user*
    /// consequence of the ghost lived: on the pre-strata tree — the last commit
    /// where `kind` was canonical, named in `display.rs`'s module note — one
    /// click deleted the `BuildingInstance` but left `kind` standing, so every
    /// tile of a 2×2 footprint went on emitting the structure's own kind and a
    /// second click was needed to actually clear the sprite. Verified against that tree:
    /// `Park` then `Bulldoze` emitted `Park`, `CoalPlant` then `Bulldoze`
    /// emitted `CoalPlant`. Here one click clears the whole footprint.
    ///
    /// This delta is a gameplay change, not a representation one — it moves
    /// the wilderness score, which `wilderness::tests::
    /// a_bulldozed_park_stops_scoring_as_a_park` pins. `display.rs`'s module
    /// note lists it beside the two normalisations for that reason.
    #[test]
    fn one_bulldozer_click_clears_a_whole_footprint() {
        for (tool, w, h) in [
            (Tool::Park, 1, 1),
            (Tool::CoalPlant, 2, 2),
            (Tool::ElementarySchool, 2, 2),
        ] {
            let mut s = gs(8, 8);
            assert!(
                apply_tool(&mut s, tool, 4, 4, ViewStratum::Surface).success,
                "{tool:?} refused"
            );
            assert!(
                s.tile_at(4, 4).unwrap().has_occupant(Occupant::Structure),
                "{tool:?} not built"
            );

            assert!(apply_tool(&mut s, Tool::Bulldoze, 4, 4, ViewStratum::Surface).success);
            for dy in 0..h {
                for dx in 0..w {
                    let (x, y) = (4 + dx, 4 + dy);
                    let t = s.tile_at(x, y).unwrap();
                    assert!(
                        !t.has_occupant(Occupant::Structure),
                        "{tool:?} ({x}, {y}): the tag outlived its development"
                    );
                    assert!(t.building_id.is_none(), "{tool:?} ({x}, {y}): dangling id");
                    // v4 emitted the structure's own kind on all four here.
                    assert_eq!(
                        t.occupants(),
                        0,
                        "{tool:?} ({x}, {y}): one click did not clear it"
                    );
                }
            }
            assert!(s.buildings.is_empty(), "{tool:?}: the instance survived");
        }
    }

    /// **`#198`, the whole point of the fix.** Before this, `bulldoze` applied
    /// a fixed precedence — building, then underground, then surface+overhead
    /// — with no idea which layer the player was looking at, so a surface
    /// click on a road with a buried pipe under it took the invisible pipe
    /// first and left the road standing, one credit and a second click later.
    #[test]
    fn bulldoze_clears_only_the_stratum_it_was_asked_for() {
        let mut s = gs(4, 4);
        assert!(apply_tool(&mut s, Tool::Road, 0, 0, ViewStratum::Surface).success);
        assert!(apply_tool(&mut s, Tool::WaterPipe, 0, 0, ViewStratum::Underground).success);
        let t = s.tile_at(0, 0).unwrap();
        assert!(t.has_occupant(Occupant::Road));
        assert!(t.has_occupant(Occupant::Pipe));

        // A surface click takes the road the player was aiming at and
        // nothing else — the pipe the old precedence would have destroyed
        // invisibly is still there afterwards.
        let before = s.money;
        let revision_before = s.tile_revision;
        assert!(apply_tool(&mut s, Tool::Bulldoze, 0, 0, ViewStratum::Surface).success);
        let t = s.tile_at(0, 0).unwrap();
        assert!(
            !t.has_occupant(Occupant::Road),
            "the surface click left the road standing"
        );
        assert!(
            t.has_occupant(Occupant::Pipe),
            "a surface bulldoze reached into underground"
        );
        assert_eq!(s.money, before - tool_cost(Tool::Bulldoze));
        assert_eq!(
            s.tile_revision,
            revision_before + 1,
            "a surface clear must bump tile_revision exactly once"
        );

        // An underground click on the same tile takes the pipe.
        let before = s.money;
        assert!(apply_tool(&mut s, Tool::Bulldoze, 0, 0, ViewStratum::Underground).success);
        assert!(!s.tile_at(0, 0).unwrap().has_occupant(Occupant::Pipe));
        assert_eq!(s.money, before - tool_cost(Tool::Bulldoze));

        // And with nothing left in either stratum, a third click of either
        // kind is a free no-op, not a charge for clearing nothing.
        let before = s.money;
        let r = apply_tool(&mut s, Tool::Bulldoze, 0, 0, ViewStratum::Underground);
        assert!(!r.success);
        assert_eq!(r.message.as_deref(), Some("Nothing to demolish here"));
        assert_eq!(s.money, before, "an empty-stratum bulldoze must not charge");
    }

    /// Symmetric to the surface case above: an underground click on a tile
    /// with an empty underground stratum must not fall through and reach the
    /// surface it isn't looking at.
    #[test]
    fn underground_bulldoze_never_reaches_the_surface() {
        let mut s = gs(4, 4);
        assert!(apply_tool(&mut s, Tool::Road, 0, 0, ViewStratum::Surface).success);
        let before = s.money;
        let r = apply_tool(&mut s, Tool::Bulldoze, 0, 0, ViewStratum::Underground);
        assert!(!r.success);
        assert_eq!(r.message.as_deref(), Some("Nothing to demolish here"));
        assert!(s.tile_at(0, 0).unwrap().has_occupant(Occupant::Road));
        assert_eq!(s.money, before);
    }

    /// The `Underground` arm never reads `building_id` — it only checks
    /// `tile.underground` — so a building tile (underground always empty,
    /// since no tool can place one there) must refuse an `Underground` click
    /// exactly like bare land does, leaving the building untouched. Pins that
    /// a regression which special-cased buildings there (e.g. clearing
    /// underground utilities as part of demolition) would be caught, mirroring
    /// `surface_bulldoze_refuses_a_tile_with_only_underground_content`'s
    /// coverage of the opposite arm.
    #[test]
    fn underground_bulldoze_on_a_building_tile_is_refused() {
        let mut s = gs(4, 4);
        assert!(apply_tool(&mut s, Tool::Park, 0, 0, ViewStratum::Surface).success);
        let before = s.money;
        let r = apply_tool(&mut s, Tool::Bulldoze, 0, 0, ViewStratum::Underground);
        assert!(!r.success);
        assert_eq!(r.message.as_deref(), Some("Nothing to demolish here"));
        assert!(s.tile_at(0, 0).unwrap().building_id.is_some());
        assert_eq!(s.money, before);
    }

    /// The mirror image of `bulldoze_clears_only_the_stratum_it_was_asked_for`'s
    /// first assertion: a tile whose *only* content is underground must refuse
    /// a `Surface` click rather than silently falling through. The `Surface`
    /// arm only ever inspects `building_id`/`surface`/`overhead`, so this pins
    /// that a regression which accidentally consulted `underground` there —
    /// letting a surface click reach into or clear buried content — would be
    /// caught.
    #[test]
    fn surface_bulldoze_refuses_a_tile_with_only_underground_content() {
        let mut s = gs(4, 4);
        assert!(apply_tool(&mut s, Tool::WaterPipe, 0, 0, ViewStratum::Underground).success);
        let before = s.money;
        let r = apply_tool(&mut s, Tool::Bulldoze, 0, 0, ViewStratum::Surface);
        assert!(!r.success);
        assert_eq!(r.message.as_deref(), Some("Nothing to demolish here"));
        assert!(s.tile_at(0, 0).unwrap().has_occupant(Occupant::Pipe));
        assert_eq!(s.money, before);
    }

    /// **Buildings are surface-stratum objects, even over buried infrastructure.**
    /// `place_footprint_building` never checks `underground`, so a building can
    /// legally sit over a buried pipe; `bulldoze`'s `Surface` arm must still
    /// take only the building, exactly as it does over a plain surface tile —
    /// this is the building-branch counterpart to
    /// `bulldoze_clears_only_the_stratum_it_was_asked_for`, which only covers
    /// the non-building surface-clear branch.
    #[test]
    fn surface_bulldoze_on_a_building_leaves_a_buried_pipe_untouched() {
        let mut s = gs(4, 4);
        assert!(apply_tool(&mut s, Tool::WaterPipe, 0, 0, ViewStratum::Underground).success);
        assert!(apply_tool(&mut s, Tool::Park, 0, 0, ViewStratum::Surface).success);
        assert!(s.tile_at(0, 0).unwrap().building_id.is_some());

        let before = s.money;
        assert!(apply_tool(&mut s, Tool::Bulldoze, 0, 0, ViewStratum::Surface).success);
        let t = s.tile_at(0, 0).unwrap();
        assert!(t.building_id.is_none(), "the building outlived the click");
        assert!(
            t.has_occupant(Occupant::Pipe),
            "a surface bulldoze of a building reached into underground"
        );
        assert_eq!(
            s.money,
            before - tool_cost(Tool::Bulldoze),
            "the building branch must charge exactly the bulldoze cost"
        );
    }

    /// A bare tile — nothing in any stratum — is a free no-op regardless of
    /// which view the click came from, fixing the pre-`#198` behaviour where
    /// razing bare land cost a credit for nothing (the deduction ran before
    /// the branch that discovered there was nothing to clear).
    #[test]
    fn bulldozing_bare_land_charges_nothing() {
        for stratum in [ViewStratum::Surface, ViewStratum::Underground] {
            let mut s = gs(4, 4);
            let before = s.money;
            let r = apply_tool(&mut s, Tool::Bulldoze, 0, 0, stratum);
            assert!(!r.success, "{stratum:?}: bare land must refuse");
            assert_eq!(r.message.as_deref(), Some("Nothing to demolish here"));
            assert_eq!(s.money, before, "{stratum:?}: bare land must not charge");
        }
    }

    #[test]
    fn road_and_rail_carry_a_hydro_line_rather_than_severing_it() {
        // Road preserves rail and rail preserves road, both deliberately, so
        // that level crossings work. Power used to be the odd one out: paving
        // under a line destroyed it silently, with no warning and no refund,
        // while doing the same two things in the other order gave a crossing.
        for tool in [Tool::Road, Tool::Rail] {
            let mut s = gs(4, 4);
            apply_tool(&mut s, Tool::PowerLine, 1, 1, ViewStratum::Surface);
            apply_tool(&mut s, tool, 1, 1, ViewStratum::Surface);

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
            apply_tool(&mut forward, first, 1, 1, ViewStratum::Surface);
            apply_tool(&mut forward, second, 1, 1, ViewStratum::Surface);

            let mut reverse = gs(4, 4);
            apply_tool(&mut reverse, second, 1, 1, ViewStratum::Surface);
            apply_tool(&mut reverse, first, 1, 1, ViewStratum::Surface);

            assert_eq!(
                forward.tile_at(1, 1).unwrap().occupants(),
                reverse.tile_at(1, 1).unwrap().occupants(),
                "{first:?} then {second:?} disagreed on the occupant set"
            );
        }
    }

    #[test]
    fn bulldoze_clears_structural_flags() {
        // A hydro line laid over a road sets both the road underlay and the
        // power overlay. Bulldozing must clear them, or the tile keeps
        // rendering a road and wires that are no longer there.
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::Road, 1, 1, ViewStratum::Surface);
        apply_tool(&mut s, Tool::PowerLine, 1, 1, ViewStratum::Surface);
        assert!(s.tile_at(1, 1).unwrap().has_occupant(Occupant::Road));
        assert!(s.tile_at(1, 1).unwrap().has_occupant(Occupant::PowerLine));

        apply_tool(&mut s, Tool::Bulldoze, 1, 1, ViewStratum::Surface);
        assert_eq!(
            s.tile_at(1, 1).unwrap().visible_occupants(),
            0,
            "the bulldozer clears everything you can see"
        );
    }

    #[test]
    fn power_line_sets_power_overlay_flag() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::PowerLine, 0, 0, ViewStratum::Surface);
        assert!(s.tile_at(0, 0).unwrap().has_occupant(Occupant::PowerLine));
    }

    #[test]
    fn place_elementary_school_2x2() {
        let mut s = gs(4, 4);
        let r = apply_tool(&mut s, Tool::ElementarySchool, 0, 0, ViewStratum::Surface);
        assert!(r.success);
        assert_eq!(
            structure_kind_at(&s, 0, 0),
            Some(BuildingKind::ElementarySchool)
        );
        assert_eq!(s.buildings.len(), 1);
    }

    #[test]
    fn water_pump_placement_sets_water_output_on_tile() {
        // Regression: place_footprint_building must propagate water_output from
        // the building template onto the tile so the water BFS sees it as a source.
        let mut s = gs(4, 4);
        let r = apply_tool(&mut s, Tool::WaterPump, 0, 0, ViewStratum::Surface);
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
            apply_tool(&mut s, Tool::WaterPump, 1, 1, ViewStratum::Surface);
            assert!(s.tile_at(1, 1).unwrap().building_id.is_some());

            let before_money = s.money;
            let r = apply_tool(&mut s, tool, 1, 1, ViewStratum::Surface);
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
        apply_tool(&mut s, Tool::WaterPump, 1, 1, ViewStratum::Surface);
        let before_money = s.money;
        for tool in [Tool::Residential, Tool::Commercial, Tool::Industrial] {
            let r = apply_tool(&mut s, tool, 1, 1, ViewStratum::Surface);
            assert!(!r.success, "{tool:?} should be rejected over a building");
            assert_eq!(
                s.money, before_money,
                "{tool:?} must not charge on rejection"
            );
            assert_eq!(
                structure_kind_at(&s, 1, 1),
                Some(BuildingKind::WaterPump),
                "tile should not change"
            );
        }
    }

    #[test]
    fn building_over_road_fails() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::Road, 1, 1, ViewStratum::Surface);
        let before_money = s.money;
        let r = apply_tool(&mut s, Tool::WaterPump, 1, 1, ViewStratum::Surface);
        assert!(!r.success, "building should be rejected over a road");
        assert_eq!(s.money, before_money, "must not charge on rejection");
        assert!(
            s.tile_at(1, 1).unwrap().has_occupant(Occupant::Road),
            "road should remain"
        );
    }

    #[test]
    fn building_over_powerline_fails() {
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::PowerLine, 1, 1, ViewStratum::Surface);
        let before_money = s.money;
        let r = apply_tool(&mut s, Tool::WaterPump, 1, 1, ViewStratum::Surface);
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
        apply_tool(&mut s, Tool::Residential, 1, 1, ViewStratum::Surface);
        apply_tool(&mut s, Tool::PowerLine, 1, 1, ViewStratum::Surface);
        let t = s.tile_at(1, 1).unwrap();
        assert_eq!(t.zone_occupant(), Some(Occupant::ZoneResidential));
        assert!(t.has_occupant(Occupant::PowerLine));

        let before_money = s.money;
        let r = apply_tool(&mut s, Tool::Park, 1, 1, ViewStratum::Surface);
        assert!(!r.success, "a park was stamped over a live hydro line");
        assert_eq!(s.money, before_money, "must not charge on rejection");
        assert!(s.buildings.is_empty());
        assert_eq!(
            s.tile_at(1, 1).unwrap().zone_occupant(),
            Some(Occupant::ZoneResidential)
        );
    }

    #[test]
    fn building_over_a_terraformed_line_fails() {
        // The other route to the same tile: a regrade rewrites the ground and
        // leaves the span standing overhead, which is correct — but in v4 it
        // also moved the line out of `kind`, and the old guard read only
        // `kind`. There is no `kind` to move out of any more, which is the
        // point of making the strata canonical; the guard reads the occupant
        // set either way.
        let mut s = gs(4, 4);
        apply_tool(&mut s, Tool::PowerLine, 1, 1, ViewStratum::Surface);
        apply_tool(&mut s, Tool::TerraformRaise, 1, 1, ViewStratum::Surface);
        let t = s.tile_at(1, 1).unwrap();
        assert_eq!(t.occupants_in(Stratum::Surface), 0, "the ground is bare");
        assert!(t.has_occupant(Occupant::PowerLine));

        let r = apply_tool(&mut s, Tool::HydroPlant, 1, 1, ViewStratum::Surface);
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
            apply_tool(&mut s, Tool::PowerLine, 1, 1, ViewStratum::Surface);
            apply_tool(&mut s, Tool::WaterPipe, 1, 1, ViewStratum::Underground);
            apply_tool(&mut s, tool, 1, 1, ViewStratum::Surface);

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
            assert!(apply_tool(&mut s, Tool::CoalPlant, 5, 5, ViewStratum::Surface).success);
            let before_money = s.money;
            let before_score = compute_wilderness(&s, &WildernessTunables::default()).score;

            let r = apply_tool(&mut s, tool, 5, 5, ViewStratum::Surface);
            assert!(
                !r.success,
                "{tool:?} regraded the ground under a live plant"
            );
            assert_eq!(s.money, before_money, "{tool:?} charged on rejection");

            assert_eq!(
                structure_kind_at(&s, 5, 5),
                Some(BuildingKind::CoalPlant),
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
        apply_tool(&mut s, Tool::Road, 1, 1, ViewStratum::Surface);
        apply_tool(&mut s, Tool::Residential, 2, 1, ViewStratum::Surface);
        crate::zones::place_zone_building(&mut s, 2, 1);
        assert!(s.tile_at(2, 1).unwrap().building_id.is_some(), "lot grew");

        let r = apply_tool(&mut s, Tool::TerraformLower, 2, 1, ViewStratum::Surface);
        assert!(!r.success, "a regrade drowned a developed lot");
        assert_eq!(
            r.message.as_deref(),
            Some("A building occupies this tile. Bulldoze first.")
        );
        assert_eq!(
            s.tile_at(2, 1).unwrap().zone_occupant(),
            Some(Occupant::ZoneResidential)
        );
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
        for surface in [Tool::Road, Tool::Rail] {
            for line_first in [false, true] {
                let mut s = gs(4, 4);
                assert!(apply_tool(&mut s, surface, 1, 1, ViewStratum::Surface).success);
                if line_first {
                    assert!(
                        apply_tool(&mut s, Tool::PowerLine, 1, 1, ViewStratum::Surface).success
                    );
                }
                let before = s.tile_at(1, 1).unwrap().clone();
                assert!(
                    !before.surface.is_empty(),
                    "{surface:?} (line_first={line_first}): nothing on the ground \
                     to clear — the premise of this test"
                );
                let before_money = s.money;

                let r = apply_tool(&mut s, Tool::TerraformRaise, 1, 1, ViewStratum::Surface);
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
                assert!(
                    after.surface.is_empty(),
                    "{surface:?} (line_first={line_first}): the {} spelling \
                     survived a regrade that erased the other",
                    if line_first { "underlay" } else { "kind" }
                );
                assert!(!after.has_occupant(Occupant::Road) && !after.has_occupant(Occupant::Rail));
                assert_eq!(
                    after.overhead, before.overhead,
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
        apply_tool(&mut s, Tool::Residential, 1, 1, ViewStratum::Surface);
        let before_money = s.money;
        let r = apply_tool(&mut s, Tool::TerraformLower, 1, 1, ViewStratum::Surface);
        assert!(r.success, "a regrade was refused over an undeveloped zone");
        assert_eq!(s.money, before_money - tool_cost(Tool::TerraformLower));
        assert_eq!(s.tile_at(1, 1).unwrap().terrain(), Terrain::Water);
        assert_eq!(
            s.tile_at(1, 1).unwrap().occupants(),
            0,
            "the zone tag outlived the regrade"
        );

        for (tool, expected) in [
            (Tool::TerraformLower, Terrain::Water),
            (Tool::TerraformRaise, Terrain::Land),
            (Tool::Water, Terrain::Water),
        ] {
            let before_money = s.money;
            let r = apply_tool(&mut s, tool, 3, 3, ViewStratum::Surface);
            assert!(r.success, "{tool:?} refused open ground");
            assert_eq!(s.tile_at(3, 3).unwrap().terrain(), expected);
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
        use crate::wilderness::{compute_wilderness, WildernessTunables};

        for surface in [Tool::Road, Tool::Rail] {
            for line_first in [false, true] {
                let mut s = gs(4, 4);
                assert!(apply_tool(&mut s, surface, 1, 1, ViewStratum::Surface).success);
                if line_first {
                    assert!(
                        apply_tool(&mut s, Tool::PowerLine, 1, 1, ViewStratum::Surface).success
                    );
                }
                let before = s.tile_at(1, 1).unwrap().clone();
                let before_money = s.money;

                let r = apply_tool(&mut s, Tool::Tree, 1, 1, ViewStratum::Surface);
                assert!(r.success, "{surface:?} (line_first={line_first}) refused");
                assert_eq!(s.money, before_money - tool_cost(Tool::Tree));

                assert!(s.tile_at(1, 1).unwrap().has_occupant(Occupant::Trees));
                let after = s.tile_at(1, 1).unwrap();
                assert!(
                    after.surface.is_empty(),
                    "{surface:?} (line_first={line_first}): the {} spelling \
                     survived a planting that erased the other",
                    if line_first { "underlay" } else { "kind" }
                );
                assert_eq!(
                    after.overhead.bits() & !crate::occupants::occupant_bit(Occupant::Trees),
                    before.overhead.bits(),
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
        assert!(apply_tool(&mut s, Tool::CoalPlant, 5, 5, ViewStratum::Surface).success);
        let before_money = s.money;

        let r = apply_tool(&mut s, Tool::Tree, 5, 5, ViewStratum::Surface);
        assert!(!r.success, "a canopy was planted over a live plant");
        assert_eq!(s.money, before_money, "charged on rejection");
        assert_eq!(structure_kind_at(&s, 5, 5), Some(BuildingKind::CoalPlant));
        assert_eq!(s.buildings.len(), 1);

        // Open ground still takes a tree.
        assert!(apply_tool(&mut s, Tool::Tree, 0, 0, ViewStratum::Surface).success);
        assert!(s.tile_at(0, 0).unwrap().has_occupant(Occupant::Trees));
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
            assert!(apply_tool(&mut s, tool, 1, 1, ViewStratum::Surface).success);
            let r = apply_tool(&mut s, Tool::Park, 1, 1, ViewStratum::Surface);
            assert!(r.success, "a park was refused over {tool:?}");
            assert_eq!(structure_kind_at(&s, 1, 1), Some(BuildingKind::Park));
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
            assert!(apply_tool(&mut s, first, 1, 1, ViewStratum::Surface).success);
            assert!(
                apply_tool(&mut s, second, 1, 1, ViewStratum::Surface).success,
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
        apply_tool(&mut s, Tool::Tree, 1, 1, ViewStratum::Surface);
        let r = apply_tool(&mut s, Tool::PowerLine, 1, 1, ViewStratum::Surface);
        assert!(r.success, "a line was refused over a tree");
        assert!(s.tile_at(1, 1).unwrap().has_occupant(Occupant::PowerLine));
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
            apply_tool(&mut s, Tool::Park, 1, 1, ViewStratum::Surface);
            let bid = s.tile_at(1, 1).unwrap().building_id.unwrap();
            remove_building(&mut s, bid as u32);
            assert_eq!(s.tile_at(1, 1).unwrap().occupants(), 0);
            assert!(s.tile_at(1, 1).unwrap().building_id.is_none());

            let r = apply_tool(&mut s, tool, 1, 1, ViewStratum::Surface);
            assert!(r.success, "{tool:?} was refused by a demolished park");
        }
    }

    #[test]
    fn all_power_plants_place_with_correct_tile_kind() {
        // Regression: before the BUG-30 fix, CoalPlant/WindTurbine/SolarFarm all
        // wrote BuildingKind::HydroPlant. After the fix their kinds were added to
        // the protocol but get_building_template was not updated, so placement
        // failed with "Unknown building type" for every non-hydro plant.
        let cases = [
            (Tool::HydroPlant, BuildingKind::HydroPlant, HYDRO_PLANT_MW),
            (Tool::CoalPlant, BuildingKind::CoalPlant, COAL_PLANT_MW),
            (
                Tool::WindTurbine,
                BuildingKind::WindTurbine,
                WIND_TURBINE_MW,
            ),
            (Tool::SolarFarm, BuildingKind::SolarFarm, SOLAR_FARM_MW),
        ];
        for (tool, expected_kind, expected_mw) in cases {
            let mut s = gs(6, 6);
            s.money = 200_000;
            let r = apply_tool(&mut s, tool, 0, 0, ViewStratum::Surface);
            assert!(
                r.success,
                "{tool:?} placement should succeed: {:?}",
                r.message
            );
            assert_eq!(
                structure_kind_at(&s, 0, 0),
                Some(expected_kind),
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
