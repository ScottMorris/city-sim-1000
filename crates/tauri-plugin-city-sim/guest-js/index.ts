// index.ts — guest-JS bindings for the city-sim Tauri plugin.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/**
 * Guest-JS bindings for the `city-sim` Tauri plugin.
 *
 * Wraps `invoke` and `Channel` from `@tauri-apps/api/core` into typed async
 * functions. Import these in the desktop `TauriSimBridge` instead of calling
 * `invoke` directly.
 *
 * @module
 */

import { invoke, Channel } from '@tauri-apps/api/core'

// ── Shared types ─────────────────────────────────────────────────────────────

/**
 * Stats and tile buffer streamed from the sim engine each tick (~20 Hz).
 * Field names are camelCase (Rust side uses `#[serde(rename_all = "camelCase")]`).
 */
export interface TickEvent {
  tick:               number   // u64 — safe as number up to ~450 trillion ticks
  day:                number   // u32
  population:         number   // u32
  jobs:               number   // u32
  money:              number   // i64 — loses precision beyond ±2^53; fine for city budgets
  power:              number   // i32 (net = produced − used)
  water:              number   // i32 (net = produced − used)
  powerProduced:      number   // i32
  waterProduced:      number   // i32
  demandResidential:  number   // f32 [0, 100]
  demandCommercial:   number   // f32 [0, 100]
  demandIndustrial:   number   // f32 [0, 100]
  width:              number   // u32 — grid width in tiles
  height:             number   // u32 — grid height in tiles
  /** One byte per tile, row-major. Values are `TileKind` u8 discriminants. */
  tiles:              number[]
}

/**
 * Tool u8 discriminant map — mirrors `sim_protocol::commands::Tool as u8`.
 *
 * Pass these values as the `tool` argument to `applyTool`. TauriSimBridge maps
 * the game's string `Tool` enum to these IDs.
 */
export const TOOL_ID = {
  Inspect:          0,
  TerraformRaise:   1,
  TerraformLower:   2,
  Water:            3,
  Tree:             4,
  Road:             5,
  Rail:             6,
  PowerLine:        7,
  HydroPlant:       8,
  CoalPlant:        9,
  WindTurbine:      10,
  SolarFarm:        11,
  WaterPump:        12,
  WaterTower:       13,
  WaterPipe:        14,
  ElementarySchool: 15,
  HighSchool:       16,
  Residential:      17,
  Commercial:       18,
  Industrial:       19,
  Park:             20,
  Bulldoze:         21,
} as const

export type ToolId = typeof TOOL_ID[keyof typeof TOOL_ID]

// ── Plugin commands ───────────────────────────────────────────────────────────

/**
 * Start (or restart) the simulation engine.
 *
 * Spawns a background native thread running at ~20 Hz that pushes `TickEvent`s
 * to `onTick`. Calling `start` again while a sim is running stops the previous
 * thread first.
 *
 * @param width  Grid width in tiles.
 * @param height Grid height in tiles.
 * @param seed   Deterministic RNG seed.
 * @param onTick Callback fired each sim tick with the latest state snapshot.
 */
export async function start(
  width: number,
  height: number,
  seed: number,
  onTick: (event: TickEvent) => void,
): Promise<void> {
  const channel = new Channel<TickEvent>()
  channel.onmessage = onTick
  await invoke('plugin:city-sim|start', { width, height, seed, onTick: channel })
}

/**
 * Apply a player tool at tile coordinates (x, y).
 *
 * Fire-and-forget: the command is queued into the sim thread and applied
 * before the next tick. Returns once the command is enqueued (not applied).
 *
 * @param tool A `TOOL_ID` value — the u8 discriminant from `sim_protocol::commands::Tool`.
 * @param x    Tile column (0-indexed from left).
 * @param y    Tile row (0-indexed from top).
 */
export async function applyTool(tool: ToolId, x: number, y: number): Promise<void> {
  await invoke('plugin:city-sim|apply_tool', { tool, x, y })
}

/**
 * Adjust simulation speed.
 *
 * @param multiplier Speed multiplier relative to the base 20 Hz tick rate.
 *                   1.0 = normal, 2.0 = double, 0.0 = paused.
 */
export async function setSpeed(multiplier: number): Promise<void> {
  await invoke('plugin:city-sim|set_speed', { multiplier })
}

/**
 * Stop the simulation thread.
 *
 * The `onTick` callback supplied to `start` will stop receiving events.
 * Safe to call even if no sim is running.
 */
export async function stop(): Promise<void> {
  await invoke('plugin:city-sim|stop', {})
}

// ── Map seed ──────────────────────────────────────────────────────────────────

/**
 * The three parameters that uniquely identify a city's starting conditions.
 *
 * Pass all three back to `start()` to recreate an empty city on the same map.
 * Can be serialised to JSON for sharing: `JSON.stringify(seed)`.
 */
export interface MapSeed {
  width: number
  height: number
  seed: number
}

/**
 * Return the width, height, and seed that identify this city's starting map.
 *
 * To recreate an empty city on the same map:
 * `const s = await getMapSeed(); start(s.width, s.height, s.seed, onTick)`
 */
export async function getMapSeed(): Promise<MapSeed> {
  return await invoke<MapSeed>('plugin:city-sim|get_map_seed', {})
}

// ── Snapshots ─────────────────────────────────────────────────────────────────

/**
 * Serialise the current simulation state to a compact postcard snapshot.
 *
 * Returns raw bytes that can be stored to disk and later passed to
 * `loadSnapshot`. The format is opaque: a 8-byte header (`CSIM` magic + u32
 * version) followed by a postcard-encoded `GameState`.
 *
 * Blocks until the sim thread responds (max 2 s); rejects if the sim is not
 * running or the round-trip times out.
 */
export async function getSnapshot(): Promise<Uint8Array> {
  const bytes = await invoke<number[]>('plugin:city-sim|get_snapshot', {})
  return new Uint8Array(bytes)
}

/**
 * Replace the running simulation state with the one encoded in `bytes`.
 *
 * `bytes` must be a snapshot previously returned by `getSnapshot`. The sim
 * thread swaps state in-place; the next `TickEvent` reflects the restored city.
 *
 * Rejects if `bytes` is not a valid CSIM snapshot or if the sim is not running.
 */
export async function loadSnapshot(bytes: Uint8Array): Promise<void> {
  await invoke('plugin:city-sim|load_snapshot', { bytes: Array.from(bytes) })
}
