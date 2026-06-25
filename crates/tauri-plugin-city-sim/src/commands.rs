use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use city_sim_core::commands::apply_tool as sim_apply_tool;
use city_sim_core::sim::Simulation;
use city_sim_protocol::commands::Tool;
use tauri::{ipc::Channel, State};

use crate::error::Error;

// ── Tick event pushed to JS on every simulation tick ─────────────────────────

/// Snapshot of simulation state streamed to the JS bridge each tick.
///
/// camelCase because it is consumed directly by TypeScript.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TickEvent {
    pub tick:                 u64,
    pub day:                  u32,
    pub population:           u32,
    pub jobs:                 u32,
    pub money:                i64,
    pub power:                i32,
    pub water:                i32,
    pub power_produced:       i32,
    pub water_produced:       i32,
    pub demand_residential:   f32,
    pub demand_commercial:    f32,
    pub demand_industrial:    f32,
    pub width:                u32,
    pub height:               u32,
    /// Tile kinds, one byte per tile, row-major. Values match `TileKind` u8 discriminants.
    pub tiles:                Vec<u8>,
}

// ── Internal command sent from invoke handlers to the sim thread ──────────────

pub enum SimCmd {
    ApplyTool(Tool, u32, u32),
    SetSpeed(f32),
    Stop,
}

// ── Managed plugin state ──────────────────────────────────────────────────────

pub struct SimState {
    pub sender: Mutex<Option<mpsc::SyncSender<SimCmd>>>,
}

impl Default for SimState {
    fn default() -> Self {
        Self { sender: Mutex::new(None) }
    }
}

impl SimState {
    fn send(&self, cmd: SimCmd) -> Result<(), Error> {
        let guard = self.sender.lock().unwrap();
        match guard.as_ref() {
            Some(tx) => tx.try_send(cmd).map_err(|_| Error::ChannelClosed),
            None     => Err(Error::NotStarted),
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn tool_from_u8(v: u8) -> Option<Tool> {
    match v {
         0 => Some(Tool::Inspect),
         1 => Some(Tool::TerraformRaise),
         2 => Some(Tool::TerraformLower),
         3 => Some(Tool::Water),
         4 => Some(Tool::Tree),
         5 => Some(Tool::Road),
         6 => Some(Tool::Rail),
         7 => Some(Tool::PowerLine),
         8 => Some(Tool::HydroPlant),
         9 => Some(Tool::CoalPlant),
        10 => Some(Tool::WindTurbine),
        11 => Some(Tool::SolarFarm),
        12 => Some(Tool::WaterPump),
        13 => Some(Tool::WaterTower),
        14 => Some(Tool::WaterPipe),
        15 => Some(Tool::ElementarySchool),
        16 => Some(Tool::HighSchool),
        17 => Some(Tool::Residential),
        18 => Some(Tool::Commercial),
        19 => Some(Tool::Industrial),
        20 => Some(Tool::Park),
        21 => Some(Tool::Bulldoze),
        _  => None,
    }
}

fn build_tick_event(sim: &Simulation) -> TickEvent {
    let s = &sim.state;
    let tiles: Vec<u8> = s.tiles.iter().map(|t| t.kind as u8).collect();
    TickEvent {
        tick:               s.tick,
        day:                s.day,
        population:         s.population,
        jobs:               s.jobs,
        money:              s.money,
        power:              s.utilities.power,
        water:              s.utilities.water,
        power_produced:     s.utilities.power_produced,
        water_produced:     s.utilities.water_produced,
        demand_residential: s.demand.residential,
        demand_commercial:  s.demand.commercial,
        demand_industrial:  s.demand.industrial,
        width:              s.width,
        height:             s.height,
        tiles,
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Start (or restart) the simulation engine.
///
/// Spawns a background thread running at ~20 Hz that pushes `TickEvent`s over
/// `on_tick`. Calling `start` while a sim is already running stops the previous
/// thread first.
#[tauri::command]
pub fn start(
    state: State<'_, SimState>,
    width: u32,
    height: u32,
    seed: u32,
    on_tick: Channel<TickEvent>,
) -> Result<(), Error> {
    // Stop any running sim first
    {
        let mut guard = state.sender.lock().unwrap();
        if let Some(tx) = guard.take() {
            let _ = tx.try_send(SimCmd::Stop);
        }
    }

    // Bounded channel: 64 command slots; backpressure if JS sends faster than ticks
    let (tx, rx) = mpsc::sync_channel::<SimCmd>(64);
    *state.sender.lock().unwrap() = Some(tx);

    std::thread::spawn(move || {
        let mut sim = Simulation::new(width, height, seed);
        let dt          = 1.0_f64 / 20.0;
        let frame       = Duration::from_micros(50_000); // 50 ms ≈ 20 Hz

        loop {
            let t0 = Instant::now();

            // Drain all pending commands before ticking
            loop {
                match rx.try_recv() {
                    Ok(SimCmd::ApplyTool(tool, x, y)) => { sim_apply_tool(&mut sim.state, tool, x, y); }
                    Ok(SimCmd::SetSpeed(m))            => { sim.set_speed(m); }
                    Ok(SimCmd::Stop)                   => return,
                    Err(_)                             => break,
                }
            }

            sim.tick(dt);

            if on_tick.send(build_tick_event(&sim)).is_err() {
                break; // JS side closed the channel
            }

            if let Some(rem) = frame.checked_sub(t0.elapsed()) {
                std::thread::sleep(rem);
            }
        }
    });

    Ok(())
}

/// Apply a player tool at tile (x, y). `tool` is the `Tool` u8 discriminant
/// (matching `city_sim_protocol::commands::Tool as u8`).
#[tauri::command]
pub fn apply_tool(state: State<'_, SimState>, tool: u8, x: u32, y: u32) -> Result<(), Error> {
    let tool = tool_from_u8(tool).ok_or(Error::InvalidTool(tool))?;
    state.send(SimCmd::ApplyTool(tool, x, y))
}

/// Adjust simulation speed. `multiplier` is relative to the base 20 Hz rate.
#[tauri::command]
pub fn set_speed(state: State<'_, SimState>, multiplier: f32) -> Result<(), Error> {
    state.send(SimCmd::SetSpeed(multiplier))
}

/// Stop the simulation thread. The `on_tick` channel will stop receiving events.
#[tauri::command]
pub fn stop(state: State<'_, SimState>) -> Result<(), Error> {
    let mut guard = state.sender.lock().unwrap();
    if let Some(tx) = guard.take() {
        let _ = tx.try_send(SimCmd::Stop);
    }
    Ok(())
}
