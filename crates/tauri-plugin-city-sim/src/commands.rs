// commands.rs — Tauri plugin command handlers and simulation thread management.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use std::sync::mpsc::RecvTimeoutError;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use city_sim_core::commands::apply_tool as sim_apply_tool;
use city_sim_core::sim::Simulation;
use city_sim_core::snapshot;
use city_sim_core::state::GameState;
use city_sim_protocol::commands::Tool;
use serde::Serialize;
use tauri::{ipc::Channel, State};

use crate::error::Error;

// ── Tick event pushed to JS on every simulation tick ─────────────────────────

/// Snapshot of simulation state streamed to the JS bridge each tick.
///
/// camelCase because it is consumed directly by TypeScript.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TickEvent {
    pub tick: u64,
    pub day: u32,
    pub population: u32,
    pub jobs: u32,
    pub money: i64,
    pub power: i32,
    pub water: i32,
    pub power_produced: i32,
    pub water_produced: i32,
    pub demand_residential: f32,
    pub demand_commercial: f32,
    pub demand_industrial: f32,
    pub width: u32,
    pub height: u32,
    /// Tile kinds, one byte per tile, row-major. Values match `TileKind` u8 discriminants.
    pub tiles: Vec<u8>,
}

// ── Internal command sent from invoke handlers to the sim thread ──────────────

pub enum SimCmd {
    ApplyTool(Tool, u32, u32),
    SetSpeed(f32),
    GetSnapshot(mpsc::SyncSender<Result<Vec<u8>, String>>),
    LoadSnapshot(Box<GameState>),
    Stop,
}

// ── Managed plugin state ──────────────────────────────────────────────────────

pub struct SimState {
    pub sender: Mutex<Option<mpsc::SyncSender<SimCmd>>>,
}

impl Default for SimState {
    fn default() -> Self {
        Self {
            sender: Mutex::new(None),
        }
    }
}

impl SimState {
    fn send(&self, cmd: SimCmd) -> Result<(), Error> {
        let guard = self.sender.lock().unwrap();
        match guard.as_ref() {
            Some(tx) => tx.try_send(cmd).map_err(|e| match e {
                mpsc::TrySendError::Full(_) => Error::ChannelFull,
                mpsc::TrySendError::Disconnected(_) => Error::ChannelClosed,
            }),
            None => Err(Error::NotStarted),
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn build_tick_event(sim: &Simulation) -> TickEvent {
    let s = &sim.state;
    let tiles: Vec<u8> = s.tiles.iter().map(|t| t.kind as u8).collect();
    TickEvent {
        tick: s.tick,
        day: s.day,
        population: s.population,
        jobs: s.jobs,
        money: s.money,
        power: s.utilities.power,
        water: s.utilities.water,
        power_produced: s.utilities.power_produced,
        water_produced: s.utilities.water_produced,
        demand_residential: s.demand.residential,
        demand_commercial: s.demand.commercial,
        demand_industrial: s.demand.industrial,
        width: s.width,
        height: s.height,
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
    // Stop any running sim first. The old thread exits asynchronously — it will
    // drain its own rx, see Stop, and return on its next iteration (≤50 ms).
    // The caller (TauriSimBridge) must tolerate a brief burst of stale TickEvents
    // on the old Channel after start() returns; those arrive on the previous
    // Channel object, not the new one, so they are harmless if the JS side drops
    // the old callback reference before calling start() again.
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
        let dt = 1.0_f64 / 20.0;
        let frame = Duration::from_micros(50_000); // 50 ms ≈ 20 Hz

        loop {
            let t0 = Instant::now();

            // Drain all pending commands before ticking
            loop {
                match rx.try_recv() {
                    Ok(SimCmd::ApplyTool(tool, x, y)) => {
                        sim_apply_tool(&mut sim.state, tool, x, y);
                    }
                    Ok(SimCmd::SetSpeed(m)) => {
                        sim.set_speed(m);
                    }
                    Ok(SimCmd::GetSnapshot(tx)) => {
                        let result = snapshot::to_bytes(&sim.state).map_err(|e| e.to_string());
                        let _ = tx.send(result);
                    }
                    Ok(SimCmd::LoadSnapshot(gs)) => {
                        sim.load_state(*gs);
                    }
                    Ok(SimCmd::Stop) => return,
                    Err(_) => break,
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
    let tool = Tool::try_from(tool).map_err(|_| Error::InvalidTool(tool))?;
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

/// Serialise the current simulation state to a postcard snapshot and return the
/// raw bytes. The JS side receives a `Uint8Array` via `invoke`.
///
/// Blocks until the sim thread responds (max 2 s). Returns an error if the sim
/// is not running or the round-trip times out.
#[tauri::command]
pub fn get_snapshot(state: State<'_, SimState>) -> Result<Vec<u8>, Error> {
    let (tx, rx) = mpsc::sync_channel(0);
    state.send(SimCmd::GetSnapshot(tx))?;
    rx.recv_timeout(Duration::from_secs(2))
        .map_err(|e| match e {
            RecvTimeoutError::Timeout => Error::SnapshotTimeout,
            RecvTimeoutError::Disconnected => Error::ChannelClosed,
        })?
        .map_err(Error::Snapshot)
}

/// Replace the running simulation state with the one encoded in `bytes`.
///
/// `bytes` must be a postcard snapshot produced by `get_snapshot`. The sim
/// thread swaps the state in place on its next command drain; the next
/// `TickEvent` reflects the restored state.
#[tauri::command]
pub fn load_snapshot(state: State<'_, SimState>, bytes: Vec<u8>) -> Result<(), Error> {
    let game_state = snapshot::from_bytes(&bytes).map_err(|e| Error::Snapshot(e.to_string()))?;
    state.send(SimCmd::LoadSnapshot(Box::new(game_state)))
}
