// sim_tauri — Tauri v2 plugin that runs sim_core natively for the desktop target.
//
// Plugin name: "city-sim"
// JS invoke path: `invoke('plugin:city-sim|<command>', args)`
//
// Commands:
//   start(width, height, seed, onTick: Channel<TickEvent>)
//   apply_tool(tool: u8, x: u32, y: u32)
//   set_speed(multiplier: f32)
//   stop()

mod error;
pub mod commands;

pub use error::Error;
pub use commands::{SimState, TickEvent};

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
            commands::stop,
        ])
        .setup(|app, _api| {
            app.manage(SimState::default());
            Ok(())
        })
        .build()
}
