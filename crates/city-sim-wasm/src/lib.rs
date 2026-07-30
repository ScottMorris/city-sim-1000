// lib.rs — WASM cdylib wrapper bridging sim_core to the browser Worker.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use city_sim_core::{
    commands::apply_tool,
    history::{History, HistoryConfig},
    import::{from_tile_buffer, ImportStats},
    sim::Simulation,
    snapshot,
    wire::encode_tile_buffer,
};
use city_sim_protocol::{
    commands::{Policies, Tool},
    tile_buffer::BYTES_PER_TILE,
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// Git revision this binary was compiled from, `-dirty` when the tree was not
/// clean; `unknown` where git was unavailable at build time.
///
/// [`version`] cannot answer "which engine am I running": it returns
/// `CARGO_PKG_VERSION`, which does not move between releases, so a browser
/// holding a WASM module from hours ago reports the same string as a fresh
/// one. This does move, and it is directly comparable with the app bundle's own
/// SHA in the debug overlay — when the two differ, the engine and the UI were
/// built from different commits.
#[wasm_bindgen]
pub fn build_sha() -> String {
    env!("CITY_SIM_GIT_SHA").to_owned()
}

/// Production simulation host for the browser Worker.
///
/// Wraps `city-sim-core::Simulation` and a snapshot-stack `History`, wiring
/// the full Rust sim engine to the WASM cdylib surface for `WasmSimBridge`.
#[wasm_bindgen]
pub struct SimHost {
    sim: Simulation,
    history: History,
}

impl SimHost {
    /// Swap in a restored snapshot, carrying the live policies across — undo
    /// applies to tools, never to taxes or programmes. Speed lives on
    /// `Simulation` (not in `GameState`), so `load_state` already keeps it.
    fn restore(&mut self, restored: city_sim_core::state::GameState) {
        let live_policies = self.sim.state.policies;
        self.sim.load_state(restored);
        self.sim.state.policies = live_policies;
    }
}

#[wasm_bindgen]
impl SimHost {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32, seed: u32) -> SimHost {
        SimHost {
            sim: Simulation::new(width, height, seed),
            history: History::new(HistoryConfig::default()),
        }
    }

    pub fn tick_count(&self) -> u32 {
        self.sim.state.tick as u32
    }
    pub fn width(&self) -> u32 {
        self.sim.state.width
    }
    pub fn height(&self) -> u32 {
        self.sim.state.height
    }
    pub fn money(&self) -> f64 {
        self.sim.state.money as f64
    }
    pub fn population(&self) -> u32 {
        self.sim.state.population
    }
    pub fn jobs(&self) -> u32 {
        self.sim.state.jobs
    }
    pub fn power_balance(&self) -> i32 {
        self.sim.state.utilities.power
    }
    pub fn power_produced(&self) -> i32 {
        self.sim.state.utilities.power_produced
    }
    pub fn power_used(&self) -> i32 {
        self.sim.state.utilities.power_used
    }
    pub fn water_balance(&self) -> i32 {
        self.sim.state.utilities.water
    }
    pub fn water_produced(&self) -> i32 {
        self.sim.state.utilities.water_produced
    }
    pub fn water_used(&self) -> i32 {
        self.sim.state.utilities.water_used
    }
    pub fn day(&self) -> u32 {
        self.sim.state.day
    }
    pub fn demand_residential(&self) -> f32 {
        self.sim.state.demand.residential
    }
    pub fn demand_commercial(&self) -> f32 {
        self.sim.state.demand.commercial
    }
    pub fn demand_industrial(&self) -> f32 {
        self.sim.state.demand.industrial
    }
    pub fn budget_net_per_day(&self) -> f32 {
        self.sim.state.budget.net_per_day
    }
    pub fn budget_net_per_month(&self) -> f32 {
        self.sim.state.budget.net_per_month
    }
    pub fn budget_revenue(&self) -> f32 {
        self.sim.state.budget.revenue
    }
    pub fn budget_expenses(&self) -> f32 {
        self.sim.state.budget.expenses
    }
    pub fn budget_revenue_base(&self) -> f32 {
        self.sim.state.budget.revenue_base
    }
    pub fn budget_revenue_pop(&self) -> f32 {
        self.sim.state.budget.revenue_pop
    }
    pub fn budget_revenue_commercial(&self) -> f32 {
        self.sim.state.budget.revenue_commercial
    }
    pub fn budget_revenue_industrial(&self) -> f32 {
        self.sim.state.budget.revenue_industrial
    }
    pub fn budget_expenses_transport(&self) -> f32 {
        self.sim.state.budget.expenses_transport
    }
    pub fn budget_expenses_buildings(&self) -> f32 {
        self.sim.state.budget.expenses_buildings
    }
    pub fn budget_maint_power(&self) -> f32 {
        self.sim.state.budget.maint_power
    }
    pub fn budget_maint_civic(&self) -> f32 {
        self.sim.state.budget.maint_civic
    }
    pub fn budget_maint_zones(&self) -> f32 {
        self.sim.state.budget.maint_zones
    }
    pub fn budget_maint_roads(&self) -> f32 {
        self.sim.state.budget.maint_roads
    }
    pub fn budget_maint_rail(&self) -> f32 {
        self.sim.state.budget.maint_rail
    }
    pub fn budget_maint_power_lines(&self) -> f32 {
        self.sim.state.budget.maint_power_lines
    }
    pub fn budget_maint_pipes(&self) -> f32 {
        self.sim.state.budget.maint_pipes
    }
    pub fn budget_maint_power_hydro(&self) -> f32 {
        self.sim.state.budget.maint_power_hydro
    }
    pub fn budget_maint_power_coal(&self) -> f32 {
        self.sim.state.budget.maint_power_coal
    }
    pub fn budget_maint_power_wind(&self) -> f32 {
        self.sim.state.budget.maint_power_wind
    }
    pub fn budget_maint_power_solar(&self) -> f32 {
        self.sim.state.budget.maint_power_solar
    }
    pub fn budget_maint_civic_park(&self) -> f32 {
        self.sim.state.budget.maint_civic_park
    }
    pub fn budget_maint_civic_pump(&self) -> f32 {
        self.sim.state.budget.maint_civic_pump
    }
    pub fn budget_maint_civic_tower(&self) -> f32 {
        self.sim.state.budget.maint_civic_tower
    }
    pub fn budget_maint_civic_school(&self) -> f32 {
        self.sim.state.budget.maint_civic_school
    }
    pub fn budget_maint_zones_res(&self) -> f32 {
        self.sim.state.budget.maint_zones_res
    }
    pub fn budget_maint_zones_com(&self) -> f32 {
        self.sim.state.budget.maint_zones_com
    }
    pub fn budget_maint_zones_ind(&self) -> f32 {
        self.sim.state.budget.maint_zones_ind
    }
    pub fn budget_revenue_tourism(&self) -> f32 {
        self.sim.state.budget.revenue_tourism
    }
    pub fn budget_expenses_policies(&self) -> f32 {
        self.sim.state.budget.expenses_policies
    }
    pub fn wilderness_score(&self) -> f32 {
        self.sim.state.wilderness.score
    }
    pub fn wilderness_trend(&self) -> f32 {
        self.sim.state.wilderness.trend
    }
    pub fn wilderness_forests(&self) -> f32 {
        self.sim.state.wilderness.breakdown.forests
    }
    pub fn wilderness_parks(&self) -> f32 {
        self.sim.state.wilderness.breakdown.parks
    }
    pub fn wilderness_open_land(&self) -> f32 {
        self.sim.state.wilderness.breakdown.open_land
    }
    pub fn wilderness_water_edge(&self) -> f32 {
        self.sim.state.wilderness.breakdown.water_edge
    }
    pub fn wilderness_patch(&self) -> f32 {
        self.sim.state.wilderness.breakdown.patch
    }
    pub fn wilderness_fragmentation(&self) -> f32 {
        self.sim.state.wilderness.breakdown.fragmentation
    }
    pub fn wilderness_zones(&self) -> f32 {
        self.sim.state.wilderness.breakdown.zones
    }
    pub fn wilderness_industry(&self) -> f32 {
        self.sim.state.wilderness.breakdown.industry
    }
    pub fn wilderness_transport(&self) -> f32 {
        self.sim.state.wilderness.breakdown.transport
    }
    pub fn wilderness_power(&self) -> f32 {
        self.sim.state.wilderness.breakdown.power
    }
    pub fn wilderness_civic(&self) -> f32 {
        self.sim.state.wilderness.breakdown.civic
    }
    /// Replace the full set of player policies from a camelCase JSON object
    /// (see `Policies` in `city-sim-protocol` — `{ budget: {...}, wilderness: {...} }`).
    /// Missing families keep their serde defaults; out-of-range values are
    /// clamped. Applies from the next tick / wilderness recompute.
    pub fn set_policies(&mut self, json: &str) -> Result<(), JsError> {
        let policies: Policies =
            serde_json::from_str(json).map_err(|e| JsError::new(&e.to_string()))?;
        self.sim.state.policies = policies.clamped();
        Ok(())
    }

    /// Seed the natural terrain baseline (row-major `TileKind` u8 per tile).
    ///
    /// Only `Water`/`Tree` kinds are applied — see
    /// `GameState::seed_natural_terrain`. Call once, after construction and
    /// before any commands. Terrain lives inside the state, so undo snapshots
    /// and save snapshots carry it automatically.
    pub fn set_natural_terrain(&mut self, kinds: &[u8]) {
        self.sim.state.seed_natural_terrain(kinds);
    }

    /// Advance the simulation by `dt` seconds (real time). The speed
    /// multiplier is applied internally by `Simulation::tick`.
    pub fn step(&mut self, dt: f64) {
        self.sim.step(dt);
    }

    /// Apply a player tool at tile (x, y).
    ///
    /// `tool_idx` is the `Tool` discriminant (0 = Inspect … 21 = Bulldoze),
    /// matching `#[repr(u8)]` in `city-sim-protocol`. `stroke_id` groups the
    /// many calls of one drag-paint gesture into a single undo step — the
    /// history captures one pre-stroke snapshot per id. Returns `true` on
    /// success; `false` if the tool could not be applied (out-of-bounds,
    /// insufficient funds, invalid placement).
    pub fn apply_tool(&mut self, tool_idx: u8, x: u32, y: u32, stroke_id: u32) -> bool {
        let Ok(tool) = Tool::try_from(tool_idx) else {
            return false;
        };
        let pending = self.history.prepare(&self.sim.state, stroke_id as u64);
        let result = apply_tool(&mut self.sim.state, tool, x, y);
        if result.success {
            if let Some(bytes) = pending {
                self.history.commit(bytes, stroke_id as u64);
            }
        }
        result.success
    }

    /// Set the simulation speed multiplier (0.0 = paused, 1.0 = normal).
    pub fn set_speed(&mut self, multiplier: f32) {
        self.sim.set_speed(multiplier);
    }

    /// Undo the most recent player stroke by restoring its pre-stroke
    /// snapshot — tiles, stats, RNG, and the clock all rewind. Returns `true`
    /// if a stroke was undone, `false` if the history was empty.
    pub fn undo(&mut self) -> bool {
        let Some(restored) = self.history.undo(&self.sim.state) else {
            return false;
        };
        self.restore(restored);
        true
    }

    /// Redo the most recently undone stroke, returning to the exact moment
    /// undo was pressed. Returns `false` if there is nothing to redo.
    pub fn redo(&mut self) -> bool {
        let Some(restored) = self.history.redo(&self.sim.state) else {
            return false;
        };
        self.restore(restored);
        true
    }

    pub fn can_undo(&self) -> bool {
        self.history.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.history.can_redo()
    }

    /// Serialise the full engine state to a `CSIM` snapshot blob (the byte
    /// format shared with the Tauri plugin's `get_snapshot`). A pure read —
    /// saving never touches the undo history.
    pub fn get_snapshot(&self) -> Result<Vec<u8>, JsError> {
        snapshot::to_bytes(&self.sim.state).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Replace the engine state with a previously captured snapshot and clear
    /// the undo history — the loaded city is the new undo floor. The
    /// snapshot's own policies become live (a save restores its taxes and
    /// programmes).
    pub fn load_snapshot(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        let state = snapshot::from_bytes(bytes).map_err(|e| JsError::new(&e.to_string()))?;
        self.sim.load_state(state);
        self.history.clear();
        Ok(())
    }

    /// One-time import of a legacy JSON save (see `city_sim_core::import`):
    /// wire-layout SoA tile buffer + headline scalars + camelCase policies
    /// JSON. Clears the undo history — the imported city is the undo floor.
    #[allow(clippy::too_many_arguments)]
    pub fn import_legacy(
        &mut self,
        width: u32,
        height: u32,
        seed: u32,
        rng_state: &[u32],
        buffer: &[u8],
        money: f64,
        day: u32,
        tick: f64,
        population: u32,
        jobs: u32,
        policies_json: &str,
    ) -> Result<(), JsError> {
        let rng: [u32; 4] = rng_state
            .try_into()
            .map_err(|_| JsError::new("rng_state must have exactly 4 elements"))?;
        let policies: Policies =
            serde_json::from_str(policies_json).map_err(|e| JsError::new(&e.to_string()))?;
        let state = from_tile_buffer(
            width,
            height,
            seed,
            rng,
            buffer,
            ImportStats {
                money: money as i64,
                day,
                tick: tick as u64,
                population,
                jobs,
                policies,
            },
        )
        .map_err(|e| JsError::new(&e.to_string()))?;
        self.sim.load_state(state);
        self.history.clear();
        Ok(())
    }

    /// The live `Policies` as camelCase JSON — read after a snapshot load so
    /// the display mirror can adopt the save's policies.
    pub fn policies_json(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.sim.state.policies).map_err(|e| JsError::new(&e.to_string()))
    }

    pub fn seed(&self) -> u32 {
        self.sim.state.seed
    }

    /// Drop all undo/redo history. Called after bulk preload on init/load so
    /// the loaded city is the undo floor — undo can never corrupt it.
    pub fn clear_history(&mut self) {
        self.history.clear();
    }

    /// Total byte length of the SoA tile buffer (width × height × `BYTES_PER_TILE`).
    pub fn tile_buffer_byte_len(&self) -> usize {
        self.sim.state.tiles.len() * BYTES_PER_TILE
    }

    /// Serialise current tile state as a flat SoA buffer.
    ///
    /// Layout: `underground[N] | surface[N] | overhead[N] | status[N] | happiness[N] | elevation[N] | building_id[N×2] | wilderness[N]`
    ///
    /// Delegates to `city_sim_core::wire::encode_tile_buffer` — the same
    /// encoder the Tauri plugin's tick event uses, so the two transports
    /// cannot silently drift onto different byte layouts.
    pub fn tile_buffer(&self) -> Vec<u8> {
        encode_tile_buffer(&self.sim.state)
    }

    /// The building list as JSON (`Vec<WireBuilding>`) — `id`, template
    /// `kind` (as the `TileKind` u8, matching every other wire use of
    /// `TileKind`), and footprint origin.
    ///
    /// The live tile buffer's `Structure` occupant bit says only that a
    /// building stands on a tile, not which one — since #177's TS/wire
    /// follow-up, a structure's `TileKind` lives on its `BuildingInstance`,
    /// not on the tile. TS needs this list to resolve `building_id` to a
    /// template; call it alongside `tile_buffer()`. Status/health/trouble are
    /// deliberately not carried here — TS derives building status locally
    /// from the tile's `POWERED`/`WATERED` flags, as it already did before
    /// this method existed.
    pub fn buildings_json(&self) -> String {
        let wire: Vec<WireBuilding> = self
            .sim
            .state
            .buildings
            .iter()
            .map(|b| WireBuilding {
                id: b.id,
                kind: b.kind as u8,
                origin_x: b.origin.0,
                origin_y: b.origin.1,
            })
            .collect();
        serde_json::to_string(&wire).unwrap_or_default()
    }
}

/// One row of [`SimHost::buildings_json`]'s wire shape.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WireBuilding {
    id: u32,
    /// `TileKind as u8` — decode with `tileKindFromU8` in TS, matching every
    /// other wire use of `TileKind`.
    kind: u8,
    origin_x: u32,
    origin_y: u32,
}
