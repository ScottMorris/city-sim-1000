// lib.rs — WASM cdylib wrapper bridging sim_core to the browser Worker.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use city_sim_core::{command_log::CommandLog, commands::apply_tool, sim::Simulation};
use city_sim_protocol::{
    commands::Tool,
    tile_buffer::{encode_happiness, TileBufferOffsets, BYTES_PER_TILE},
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// Production simulation host for the browser Worker.
///
/// Wraps `city-sim-core::Simulation` and a `CommandLog`, wiring the full Rust
/// sim engine to the WASM cdylib surface for `WasmSimBridge`.
#[wasm_bindgen]
pub struct SimHost {
    sim: Simulation,
    log: CommandLog,
}

#[wasm_bindgen]
impl SimHost {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32, seed: u32) -> SimHost {
        SimHost {
            sim: Simulation::new(width, height, seed),
            log: CommandLog::new(width, height, seed),
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
    pub fn water_balance(&self) -> i32 {
        self.sim.state.utilities.water
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

    /// Advance the simulation by `dt` seconds (real time). The speed
    /// multiplier is applied internally by `Simulation::tick`.
    pub fn step(&mut self, dt: f64) {
        self.sim.step(dt);
    }

    /// Apply a player tool at tile (x, y).
    ///
    /// `tool_idx` is the `Tool` discriminant (0 = Inspect … 21 = Bulldoze),
    /// matching `#[repr(u8)]` in `city-sim-protocol`. Returns `true` on
    /// success; `false` if the tool could not be applied (out-of-bounds,
    /// insufficient funds, invalid placement).
    pub fn apply_tool(&mut self, tool_idx: u8, x: u32, y: u32) -> bool {
        let Ok(tool) = Tool::try_from(tool_idx) else {
            return false;
        };
        // Record before apply; pop if rejected so the log stays clean.
        self.log.record(self.sim.state.tick, tool, x, y);
        let result = apply_tool(&mut self.sim.state, tool, x, y);
        if !result.success {
            self.log.pop();
        }
        result.success
    }

    /// Set the simulation speed multiplier (0.0 = paused, 1.0 = normal).
    pub fn set_speed(&mut self, multiplier: f32) {
        self.sim.set_speed(multiplier);
    }

    /// Undo the most recent player action by popping the command log and
    /// replaying from seed. Returns `true` if an action was undone, `false`
    /// if the log was already empty.
    pub fn undo_last(&mut self) -> bool {
        if !self.log.pop() {
            return false;
        }
        let prev_speed = self.sim.speed();
        self.sim = self.log.replay();
        self.sim.set_speed(prev_speed);
        true
    }

    /// Total byte length of the SoA tile buffer (width × height × 6).
    pub fn tile_buffer_byte_len(&self) -> usize {
        self.sim.state.tiles.len() * BYTES_PER_TILE
    }

    /// Serialise current tile state as a flat SoA buffer.
    ///
    /// Layout: `kind[N] | flags[N] | happiness[N] | elevation[N] | building_id[N×2]`
    pub fn tile_buffer(&self) -> Vec<u8> {
        let tiles = &self.sim.state.tiles;
        let n = tiles.len();
        let o = TileBufferOffsets::for_size(n);
        let mut buf = vec![0u8; n * BYTES_PER_TILE];
        for (i, tile) in tiles.iter().enumerate() {
            buf[o.kind + i] = tile.kind as u8;
            buf[o.flags + i] = tile.flags;
            buf[o.happiness + i] = encode_happiness(tile.happiness);
            buf[o.elevation + i] = tile.elevation;
            let bid = tile.building_id.unwrap_or(0);
            let base = o.building_id + i * 2;
            buf[base] = (bid & 0xFF) as u8;
            buf[base + 1] = ((bid >> 8) & 0xFF) as u8;
        }
        buf
    }
}
