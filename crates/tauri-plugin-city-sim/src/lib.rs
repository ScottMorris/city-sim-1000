// lib.rs — Tauri v2 plugin that runs sim_core natively for the desktop target.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// Plugin name: "city-sim"
// JS invoke path: `invoke('plugin:city-sim|<command>', args)`
//
// Commands:
//   start(width, height, seed, onTick: Channel<TickEvent>)
//   apply_tool(tool: u8, x: u32, y: u32, stroke_id: u32, stratum: u8)
//   set_speed(multiplier: f32)
//   set_policies(policies: { budget: {...}, wilderness: {...} })
//   set_natural_terrain(terrain_bytes: Vec<u8>)
//   stop()
//   get_snapshot() -> Vec<u8>
//   load_snapshot(bytes: Vec<u8>)
//   get_map_seed() -> MapSeed
//   undo() -> bool
//   redo() -> bool

pub mod commands;
mod error;

pub use commands::{SimState, TickEvent};
pub use error::Error;

use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    Manager, Runtime,
};

/// Initialise the city-sim Tauri plugin.
///
/// Call this in the Tauri app's `main.rs`:
/// ```ignore
/// tauri::Builder::default()
///     .plugin(sim_tauri::init())
///     .run(tauri::generate_context!())
///     .expect("error running tauri app");
/// ```
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::<R>::new("city-sim")
        .invoke_handler(tauri::generate_handler![
            commands::start,
            commands::apply_tool,
            commands::set_speed,
            commands::set_policies,
            commands::set_natural_terrain,
            commands::stop,
            commands::get_snapshot,
            commands::load_snapshot,
            commands::import_legacy,
            commands::get_map_seed,
            commands::undo,
            commands::redo,
        ])
        .setup(|app, _api| {
            app.manage(SimState::default());
            Ok(())
        })
        .build()
}
