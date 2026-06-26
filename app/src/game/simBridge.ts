// simBridge.ts — transport-agnostic interface between the UI and the simulation.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// Implementations:
//   LocalSimBridge  — TS sim in-process (?bridge=ts or debug toggle)
//   WasmSimBridge   (P2-3) — Rust sim in a Web Worker via WASM
//   TauriSimBridge  (P4-2) — native Rust sim via Tauri IPC Channel

import type { GameState } from './gameState';
import type { SimCommand, CommandResult } from './protocol/commands';
import type { FromSim } from './protocol/events';
import type { BuildingTemplate } from './buildings/templates';

export type { SimCommand, CommandResult, FromSim };

// BuildingTemplate re-exported so callers of getMetadata() don't need a
// separate import from buildings/templates.
export type { BuildingTemplate };

export interface SimBridge {
  /**
   * Advance the simulation by `dt` seconds (real time, not sim time).
   * The implementation applies its own speed multiplier internally.
   */
  step(dt: number): void;

  /**
   * Submit a player command. Returns optimistically — the CommandResult
   * arrives via onMessage for async bridges.
   */
  send(cmd: SimCommand): CommandResult;

  /**
   * Register a handler for messages emitted by the sim (alerts, narrative
   * events, tick stats). Only one handler is active at a time; calling this
   * again replaces the previous handler.
   */
  onMessage(handler: (msg: FromSim) => void): void;

  /**
   * Direct read access to the current GameState. Treat it as read-only —
   * mutations go through send().
   */
  getState(): GameState;

  /**
   * Replace the active GameState (used after a save-file load). The bridge
   * resets all internal sim state to match.
   */
  loadState(state: GameState): void;

  /**
   * Adjust simulation speed as a multiplier of the base tick rate.
   */
  setSpeed(multiplier: number): void;

  /**
   * Undo the most recent player tool action by removing it from the command log
   * and replaying from the city seed. Resolves to `true` if an action was
   * undone, `false` if the log was already empty.
   *
   * Bridges that do not yet support undo resolve immediately with `false`.
   */
  undo(): Promise<boolean>;

  /**
   * Return all building templates known to this bridge, or null if the bridge
   * has not yet exported metadata.  LocalSimBridge returns data immediately
   * (from templates.ts); WASM and Tauri bridges return null until Option B
   * (Rust metadata export) is implemented.
   */
  getMetadata(): BuildingTemplate[] | null;

  /**
   * Return the ordered list of tool placements made through this bridge, for
   * use when swapping engines — the new bridge replays these to reconstruct
   * the city. Returns null for bridges that don't support replay (Tauri).
   */
  getCommandLog(): { tool: import('./toolTypes').Tool; x: number; y: number }[] | null;

  /**
   * Tear down the bridge (terminate Worker, release SharedArrayBuffer, etc.).
   */
  dispose(): void;
}
