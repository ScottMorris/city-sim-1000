/**
 * SimBridge — transport-agnostic interface between the UI and the simulation.
 *
 * Implementations:
 *   LocalSimBridge  (P1-5) — wraps the TS Simulation in-process; used today
 *   WasmSimBridge   (P2-3) — TS Simulation runs in a Worker + SharedArrayBuffer
 *   TauriSimBridge  (P4-2) — native Rust sim via Tauri IPC Channel
 *
 * The UI layer (main.ts, toolbar, minimap, narrative) only speaks to this
 * interface — never to Simulation directly.
 */

import type { GameState } from './gameState';
import type { SimCommand, CommandResult } from './protocol/commands';
import type { FromSim } from './protocol/events';

export type { SimCommand, CommandResult, FromSim };

export interface SimBridge {
  /**
   * Advance the simulation by `dt` seconds (real time, not sim time).
   * The implementation applies its own speed multiplier internally.
   */
  step(dt: number): void;

  /**
   * Submit a player command. Returns the result synchronously for
   * LocalSimBridge; async bridges should treat this as fire-and-wait
   * (the CommandResult arrives via onMessage).
   */
  send(cmd: SimCommand): CommandResult;

  /**
   * Register a handler for messages emitted by the sim (alerts, narrative
   * events, tick stats). Only one handler is active at a time; calling this
   * again replaces the previous handler.
   */
  onMessage(handler: (msg: FromSim) => void): void;

  /**
   * Direct read access to the current GameState.
   * For LocalSimBridge this is a live reference; other bridges may return a
   * snapshot. Treat it as read-only — mutations go through send().
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
   * Tear down the bridge (terminate Worker, release SharedArrayBuffer, etc.).
   */
  dispose(): void;
}
