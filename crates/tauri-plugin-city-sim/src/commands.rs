// commands.rs — Tauri plugin command handlers and simulation thread management.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use std::sync::mpsc::RecvTimeoutError;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use city_sim_core::commands::apply_tool as sim_apply_tool;
use city_sim_core::history::{History, HistoryConfig};
use city_sim_core::import::{from_tile_buffer, ImportStats};
use city_sim_core::sim::Simulation;
use city_sim_core::snapshot;
use city_sim_core::state::GameState;
use city_sim_core::wire::encode_tile_buffer;
use city_sim_protocol::commands::{Policies, Tool};
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
    /// Wilderness score 0–100 (see `city_sim_core::wilderness`).
    pub wilderness_score: f32,
    /// Fast EMA − slow EMA of the score; sign gives the HUD trend arrow.
    pub wilderness_trend: f32,
    pub width: u32,
    pub height: u32,
    /// The exact SoA wire buffer `city_sim_protocol::tile_buffer` describes —
    /// `underground[N] | surface[N] | overhead[N] | status[N] | happiness[N]
    /// | elevation[N] | building_id[N×2] | wilderness[N]`, encoded by
    /// `city_sim_core::wire::encode_tile_buffer`, the same function the WASM
    /// host's `tile_buffer()` calls. Per-tile `building_id` lets the desktop
    /// client read `tile.buildingId` straight off the wire, the same as WASM,
    /// instead of re-deriving tile coverage from `buildings` below and a TS
    /// template footprint that could disagree with the engine's own.
    pub tiles: Vec<u8>,
    /// The building list — `Structure` occupant tiles carry a `building_id`
    /// but not a template kind (since #177's TS/wire follow-up, that lives
    /// here, not on the tile). Mirrors `SimHost::buildings_json` on the WASM
    /// path, sent as real values rather than a JSON string since Tauri IPC
    /// serialises the whole `TickEvent` natively. No longer used to derive
    /// per-tile coverage — only to resolve a `building_id` to its template
    /// kind (power/water gating, the HUD inspector's building name).
    pub buildings: Vec<WireBuilding>,
    /// Whether an undo/redo step is currently available — drives button state.
    pub can_undo: bool,
    pub can_redo: bool,
}

/// One entry in [`TickEvent::buildings`].
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireBuilding {
    pub id: u32,
    /// `TileKind as u8` — decode with `tileKindFromU8` in TS, matching every
    /// other wire use of `TileKind`.
    pub kind: u8,
    pub origin_x: u32,
    pub origin_y: u32,
}

// ── Internal command sent from invoke handlers to the sim thread ──────────────

pub enum SimCmd {
    ApplyTool(Tool, u32, u32, u64),
    SetSpeed(f32),
    SetPolicies(Policies),
    SetNaturalTerrain(Vec<u8>),
    GetSnapshot(mpsc::SyncSender<Result<Vec<u8>, String>>),
    LoadSnapshot(Box<GameState>),
    GetMapSeed(mpsc::SyncSender<MapSeed>),
    Undo(mpsc::SyncSender<bool>),
    Redo(mpsc::SyncSender<bool>),
    Stop,
}

// ── Map seed ──────────────────────────────────────────────────────────────────

/// The three parameters that uniquely identify a city's starting conditions.
///
/// Pass all three back to `start()` to recreate an empty city on the same map.
/// Serialises to `{ "width": N, "height": N, "seed": N }` via Tauri IPC.
#[derive(Clone, Serialize)]
pub struct MapSeed {
    pub width: u32,
    pub height: u32,
    pub seed: u32,
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

fn build_tick_event(sim: &Simulation, history: &History) -> TickEvent {
    let s = &sim.state;
    // Same encoder the WASM host's `tile_buffer()` calls — one wire format,
    // shared, so this transport cannot silently drift from that one.
    let tiles = encode_tile_buffer(s);
    let buildings: Vec<WireBuilding> = s
        .buildings
        .iter()
        .map(|b| WireBuilding {
            id: b.id,
            kind: b.kind as u8,
            origin_x: b.origin.0,
            origin_y: b.origin.1,
        })
        .collect();
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
        wilderness_score: s.wilderness.score,
        wilderness_trend: s.wilderness.trend,
        width: s.width,
        height: s.height,
        tiles,
        buildings,
        can_undo: history.can_undo(),
        can_redo: history.can_redo(),
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
        let mut history = History::new(HistoryConfig::default());

        // Swap in a restored snapshot, carrying the live policies across —
        // undo applies to tools, never to taxes or programmes.
        fn restore(sim: &mut Simulation, restored: city_sim_core::state::GameState) {
            let live_policies = sim.state.policies;
            let prev_speed = sim.speed();
            sim.load_state(restored);
            sim.set_speed(prev_speed);
            sim.state.policies = live_policies;
        }
        let dt = 1.0_f64 / 20.0;
        let frame = Duration::from_micros(50_000); // 50 ms ≈ 20 Hz

        loop {
            let t0 = Instant::now();

            // Drain all pending commands before ticking
            loop {
                match rx.try_recv() {
                    Ok(SimCmd::ApplyTool(tool, x, y, stroke)) => {
                        let pending = history.prepare(&sim.state, stroke);
                        let result = sim_apply_tool(&mut sim.state, tool, x, y);
                        if result.success {
                            if let Some(bytes) = pending {
                                history.commit(bytes, stroke);
                            }
                        }
                    }
                    Ok(SimCmd::SetSpeed(m)) => {
                        sim.set_speed(m);
                    }
                    Ok(SimCmd::SetPolicies(policies)) => {
                        sim.state.policies = policies.clamped();
                    }
                    Ok(SimCmd::SetNaturalTerrain(kinds)) => {
                        sim.state.seed_natural_terrain(&kinds);
                    }
                    Ok(SimCmd::GetSnapshot(tx)) => {
                        let result = snapshot::to_bytes(&sim.state).map_err(|e| e.to_string());
                        let _ = tx.send(result);
                    }
                    Ok(SimCmd::LoadSnapshot(gs)) => {
                        // The loaded city is the new undo floor.
                        history.clear();
                        sim.load_state(*gs);
                    }
                    Ok(SimCmd::GetMapSeed(tx)) => {
                        let _ = tx.send(MapSeed {
                            width: sim.state.width,
                            height: sim.state.height,
                            seed: sim.state.seed,
                        });
                    }
                    Ok(SimCmd::Undo(tx)) => {
                        let happened = match history.undo(&sim.state) {
                            Some(restored) => {
                                restore(&mut sim, restored);
                                true
                            }
                            None => false,
                        };
                        let _ = tx.send(happened);
                    }
                    Ok(SimCmd::Redo(tx)) => {
                        let happened = match history.redo(&sim.state) {
                            Some(restored) => {
                                restore(&mut sim, restored);
                                true
                            }
                            None => false,
                        };
                        let _ = tx.send(happened);
                    }
                    Ok(SimCmd::Stop) => return,
                    Err(_) => break,
                }
            }

            sim.step(dt);

            if on_tick.send(build_tick_event(&sim, &history)).is_err() {
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
pub fn apply_tool(
    state: State<'_, SimState>,
    tool: u8,
    x: u32,
    y: u32,
    stroke_id: u32,
) -> Result<(), Error> {
    let tool = Tool::try_from(tool).map_err(|_| Error::InvalidTool(tool))?;
    state.send(SimCmd::ApplyTool(tool, x, y, stroke_id as u64))
}

/// Adjust simulation speed. `multiplier` is relative to the base 20 Hz rate.
#[tauri::command]
pub fn set_speed(state: State<'_, SimState>, multiplier: f32) -> Result<(), Error> {
    state.send(SimCmd::SetSpeed(multiplier))
}

/// Replace the full set of player policies (budget, wilderness, ...).
/// The payload is the camelCase-serialised `Policies` struct from
/// `city-sim-protocol`; missing families keep their defaults and
/// out-of-range values are clamped on the sim thread.
#[tauri::command]
pub fn set_policies(state: State<'_, SimState>, policies: Policies) -> Result<(), Error> {
    state.send(SimCmd::SetPolicies(policies))
}

/// Seed the natural terrain baseline (row-major `TileKind` u8 per tile).
///
/// Only `Water`/`Tree` kinds are applied onto untouched `Land` tiles — see
/// `GameState::seed_natural_terrain`. Call once, right after `start`.
#[tauri::command]
pub fn set_natural_terrain(state: State<'_, SimState>, kinds: Vec<u8>) -> Result<(), Error> {
    state.send(SimCmd::SetNaturalTerrain(kinds))
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

/// One-time import of a legacy JSON save: rebuild an exact `GameState` from
/// the wire-layout SoA tile buffer + headline scalars (see
/// `city_sim_core::import`) and load it like a snapshot — the imported city
/// becomes the undo floor.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn import_legacy(
    state: State<'_, SimState>,
    width: u32,
    height: u32,
    seed: u32,
    rng_state: [u32; 4],
    tiles: Vec<u8>,
    money: i64,
    day: u32,
    tick: u64,
    population: u32,
    jobs: u32,
    policies: Policies,
) -> Result<(), Error> {
    let imported = from_tile_buffer(
        width,
        height,
        seed,
        rng_state,
        &tiles,
        ImportStats {
            money,
            day,
            tick,
            population,
            jobs,
            policies,
        },
    )
    .map_err(|e| Error::Snapshot(e.to_string()))?;
    state.send(SimCmd::LoadSnapshot(Box::new(imported)))
}

/// Return the width, height, and seed that identify this city's starting map.
///
/// The returned `MapSeed` can be passed back to `start()` to create a fresh
/// city on the same grid with the same RNG seed — useful for sharing a blank
/// canvas or starting a new run on a known map.
#[tauri::command]
pub fn get_map_seed(state: State<'_, SimState>) -> Result<MapSeed, Error> {
    let (tx, rx) = mpsc::sync_channel(0);
    state.send(SimCmd::GetMapSeed(tx))?;
    // Reuses SnapshotTimeout — both paths mean "sim thread did not respond
    // within 2 s"; the message is slightly imprecise but acceptable.
    rx.recv_timeout(Duration::from_secs(2))
        .map_err(|e| match e {
            RecvTimeoutError::Timeout => Error::SnapshotTimeout,
            RecvTimeoutError::Disconnected => Error::ChannelClosed,
        })
}

/// Undo the most recent player stroke by restoring its pre-stroke snapshot —
/// tiles, stats, RNG, and the clock all rewind. Returns `true` if a stroke was
/// undone, `false` if the history was empty.
///
/// Blocks until the sim thread responds (max 2 s).
#[tauri::command]
pub fn undo(state: State<'_, SimState>) -> Result<bool, Error> {
    let (tx, rx) = mpsc::sync_channel(0);
    state.send(SimCmd::Undo(tx))?;
    rx.recv_timeout(Duration::from_secs(2))
        .map_err(|e| match e {
            RecvTimeoutError::Timeout => Error::SnapshotTimeout,
            RecvTimeoutError::Disconnected => Error::ChannelClosed,
        })
}

/// Redo the most recently undone stroke, returning to the exact moment undo
/// was pressed. Returns `false` if there is nothing to redo.
///
/// Blocks until the sim thread responds (max 2 s).
#[tauri::command]
pub fn redo(state: State<'_, SimState>) -> Result<bool, Error> {
    let (tx, rx) = mpsc::sync_channel(0);
    state.send(SimCmd::Redo(tx))?;
    rx.recv_timeout(Duration::from_secs(2))
        .map_err(|e| match e {
            RecvTimeoutError::Timeout => Error::SnapshotTimeout,
            RecvTimeoutError::Disconnected => Error::ChannelClosed,
        })
}
