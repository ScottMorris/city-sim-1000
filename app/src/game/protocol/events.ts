// events.ts — FromSim and re-exports of the generated AlertKind/SimAlert.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/**
 * FromSim — messages emitted by the sim back to the UI layer.
 *
 * Not a mirror of any Rust type: `crates/city-sim-protocol`'s own `FromSim`
 * was never constructed anywhere in the engine and was deleted as dead code.
 * `AlertKind` and `SimAlert` below are re-exports of the `ts-rs`-generated
 * mirrors of the same names in `crates/city-sim-protocol/src/events.rs`
 * (`./generated/`) — see `crates/city-sim-protocol/tests/export_bindings.rs`.
 */

export type { AlertKind } from './generated/AlertKind';
export type { SimAlert } from './generated/SimAlert';
import type { SimAlert } from './generated/SimAlert';

export type NarrativeKind = 'MonthEnd' | 'Milestone' | 'Alert';

export interface NarrativeEvent {
  kind: NarrativeKind;
  payload: unknown;
}

/** Undo/redo availability — emitted whenever either flag changes. */
export interface HistoryFlags {
  canUndo: boolean;
  canRedo: boolean;
}

export interface TickStats {
  tick: number;
  day: number;
  money: number;
  population: number;
  jobs: number;
  powerBalance: number;
  waterBalance: number;
}

export type FromSim =
  | { type: 'Ready' }
  | { type: 'Alert'; data: SimAlert }
  | { type: 'Narrative'; data: NarrativeEvent }
  /**
   * `strokeId` correlates this result back to the `ApplyTool` send that
   * produced it (mirrors the wire `CommandResult.strokeId` — see
   * `city_sim_protocol::commands::CommandResult`'s doc comment). Both
   * bridges always populate it now: `mcpBridge.ts`'s result queue keys
   * pending sends by it instead of assuming FIFO/arrival-order matching.
   */
  | { type: 'CommandResult'; success: boolean; message?: string; strokeId: number }
  | { type: 'TickStats'; data: TickStats }
  | { type: 'HistoryChanged'; data: HistoryFlags }
  /**
   * TS/worker-only — not mirrored from the Rust side. The engine can't have
   * emitted anything yet if this fires: it means the WASM module itself
   * failed to load/instantiate/boot, so `Ready` will never arrive.
   */
  | { type: 'InitError'; message: string };
