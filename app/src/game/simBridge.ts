// simBridge.ts — transport-agnostic interface between the UI and the simulation.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// Implementations:
//   WasmSimBridge   — Rust sim in a Web Worker via WASM (default browser path)
//   TauriSimBridge  — native Rust sim via Tauri IPC Channel (desktop)

import type { GameState } from './gameState';
import type { SimCommand, CommandResult } from './protocol/commands';
import type { FromSim } from './protocol/events';
import type { BuildingTemplate } from './buildings/templates';
import type { LegacyEngineImport } from '../workers/wasmSim.worker';

export type { LegacyEngineImport };

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
   * Serialise the engine's full state to an opaque CSIM snapshot blob — the
   * payload of a CSAV save. A pure read: saving never touches undo history.
   */
  getSnapshot(): Promise<Uint8Array>;

  /**
   * Replace the engine state with a CSIM snapshot (save/load, upload). The
   * display mirror is resized and refreshed before the promise resolves; the
   * loaded city becomes the undo floor. Rejects on a corrupt snapshot,
   * leaving the running city untouched.
   */
  loadSnapshot(bytes: Uint8Array): Promise<void>;

  /**
   * One-time import of a legacy JSON save (pre-CSAV) into exact engine
   * state — see `buildLegacyEngineImport` in `persistence.ts`.
   */
  importLegacy(imp: LegacyEngineImport): Promise<void>;

  /**
   * Start a fresh city from a newly generated display state (New Game, MCP
   * debug reset). Clears undo history.
   */
  newCity(fresh: GameState): Promise<void>;

  /**
   * Adjust simulation speed as a multiplier of the base tick rate.
   */
  setSpeed(multiplier: number): void;

  /**
   * Undo the most recent player stroke by restoring its pre-stroke engine
   * snapshot — tiles, stats, RNG, and the clock all rewind to the moment
   * before the stroke. Resolves to `true` if a stroke was undone, `false` if
   * the history was empty (e.g. right after a load — the loaded save is the
   * undo floor).
   *
   * Bridges that do not support undo resolve immediately with `false`.
   */
  undo(): Promise<boolean>;

  /**
   * Redo the most recently undone stroke, returning to the exact moment undo
   * was pressed. Resolves to `false` if there is nothing to redo (any new
   * stroke clears the redo stack).
   */
  redo(): Promise<boolean>;

  /**
   * Whether an undo/redo step is currently available — synchronous reads of
   * the flags carried by the latest `HistoryChanged` event, for button state.
   */
  canUndo(): boolean;
  canRedo(): boolean;

  /**
   * Return all building templates known to this bridge, or null if the bridge
   * has not yet exported metadata. WASM and Tauri bridges return null until
   * Option B (Rust metadata export) is implemented; UI callers fall back to
   * the TS `templates.ts` table.
   */
  getMetadata(): BuildingTemplate[] | null;

  /**
   * Tear down the bridge (terminate Worker, release SharedArrayBuffer, etc.).
   */
  dispose(): void;
}
