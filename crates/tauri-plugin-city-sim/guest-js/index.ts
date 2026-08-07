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
//
// `TickEvent` and the `Wire*` shapes below are `ts-rs`-generated mirrors of
// `tauri-plugin-city-sim::commands::TickEvent` and
// `city_sim_protocol::wire_types` — see `tests/export_bindings.rs` (this
// crate) for how `generated/` is produced, and its doc comment for why this
// package carries its own copy rather than importing `app/`'s. Hand-mirrored
// copies of these shapes drifted three times in this repo's history before
// codegen replaced them; do not reintroduce a hand-written copy.

export type { TickEvent } from './generated/TickEvent'
export type { SimAlert } from './generated/SimAlert'
export type { WireBuilding } from './generated/WireBuilding'
export type { WireUtilityComponent } from './generated/WireUtilityComponent'
export type { WireEducationStats } from './generated/WireEducationStats'
export type { WireEducationSeatsUsed } from './generated/WireEducationSeatsUsed'
export type { WireBudgetHistoryEntry } from './generated/WireBudgetHistoryEntry'
export type { CommandResult } from './generated/CommandResult'
export type { Policies } from './generated/Policies'

import type { TickEvent } from './generated/TickEvent'
import type { CommandResult } from './generated/CommandResult'
import type { Policies } from './generated/Policies'

/**
 * Tool u8 discriminant map — mirrors `city_sim_protocol::commands::Tool as u8`.
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
  ParkLarge:        22,
} as const

export type ToolId = typeof TOOL_ID[keyof typeof TOOL_ID]

/**
 * ViewStratum u8 discriminant map — mirrors `city_sim_protocol::commands::ViewStratum as u8`.
 *
 * Pass one of these as the `stratum` argument to `applyTool`. TauriSimBridge maps
 * the game's string `ViewStratum` type ('surface' | 'underground') to these IDs.
 */
export const VIEW_STRATUM_ID = {
  Surface:     0,
  Underground: 1,
} as const

export type ViewStratumId = typeof VIEW_STRATUM_ID[keyof typeof VIEW_STRATUM_ID]

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
 * Resolves once the sim thread has actually processed the command (not just
 * enqueued it) — the sim thread drains all pending commands before ticking,
 * so this normally resolves within one frame (≤50 ms).
 *
 * @param tool     A `TOOL_ID` value — the u8 discriminant from `city_sim_protocol::commands::Tool`.
 * @param x        Tile column (0-indexed from left).
 * @param y        Tile row (0-indexed from top).
 * @param strokeId Groups the calls of one drag-paint gesture into a single
 *                 undo step; bump it on every new gesture.
 * @param stratum  A `VIEW_STRATUM_ID` value — which layer the player was
 *                 looking at when they clicked, so stratum-aware tools (the
 *                 bulldozer) know what the player actually meant to clear.
 */
export async function applyTool(
  tool: ToolId,
  x: number,
  y: number,
  strokeId: number,
  stratum: ViewStratumId,
): Promise<CommandResult> {
  return await invoke('plugin:city-sim|apply_tool', { tool, x, y, strokeId, stratum })
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
 * Replace the full set of player policies (budget, wilderness, ...).
 *
 * Budget values apply from the next tick; wilderness programmes from the next
 * wilderness recompute (~10 sim ticks). Out-of-range values are clamped on the
 * sim thread.
 */
export async function setPolicies(policies: Policies): Promise<void> {
  await invoke('plugin:city-sim|set_policies', { policies })
}

/**
 * Seed the natural terrain baseline (row-major `Terrain` u8 byte per tile —
 * `Land` = 0, `Water` = 1).
 *
 * Only Water is applied onto untouched Land tiles, so player-built terrain
 * present in a display snapshot can never leak into the engine. Call once,
 * right after `start()`.
 */
export async function setNaturalTerrain(terrainBytes: Uint8Array): Promise<void> {
  await invoke('plugin:city-sim|set_natural_terrain', { terrainBytes: Array.from(terrainBytes) })
}

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

/**
 * One-time import of a legacy JSON save: wire-layout SoA tile buffer +
 * headline scalars (see `city_sim_core::import`). The imported city becomes
 * the undo floor.
 */
export async function importLegacy(imp: {
  width: number
  height: number
  seed: number
  rngState: [number, number, number, number]
  tiles: Uint8Array
  money: number
  day: number
  tick: number
  population: number
  jobs: number
  policies: Policies
}): Promise<void> {
  await invoke('plugin:city-sim|import_legacy', {
    width: imp.width,
    height: imp.height,
    seed: imp.seed,
    rngState: imp.rngState,
    tiles: Array.from(imp.tiles),
    money: imp.money,
    day: imp.day,
    tick: imp.tick,
    population: imp.population,
    jobs: imp.jobs,
    policies: imp.policies,
  })
}

// ── Undo ──────────────────────────────────────────────────────────────────────

/**
 * Undo the most recent player stroke by restoring its pre-stroke snapshot —
 * tiles, stats, RNG stream, and the clock all rewind to the moment before the
 * stroke's first successful command.
 *
 * Returns `true` if a stroke was undone, `false` if the history was empty
 * (no player strokes since `start()` or the last `loadSnapshot`).
 *
 * Blocks until the sim thread responds (max 2 s).
 */
export async function undo(): Promise<boolean> {
  return await invoke<boolean>('plugin:city-sim|undo', {})
}

/**
 * Redo the most recently undone stroke, returning to the exact moment undo
 * was pressed. Returns `false` if there is nothing to redo (a new stroke
 * clears the redo stack).
 *
 * Blocks until the sim thread responds (max 2 s).
 */
export async function redo(): Promise<boolean> {
  return await invoke<boolean>('plugin:city-sim|redo', {})
}
