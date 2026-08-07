// events.ts — FromSim and the TS mirror of Rust's AlertKind/SimAlert.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/**
 * FromSim — messages emitted by the sim back to the UI layer.
 *
 * Not a mirror of any Rust type: `crates/city-sim-protocol`'s own `FromSim`
 * was never constructed anywhere in the engine and was deleted as dead code.
 * `AlertKind` and `SimAlert` below still mirror the Rust types of the same
 * names in `crates/city-sim-protocol/src/events.rs`.
 */

export type AlertKind =
  | 'PowerDeficit'
  | 'PowerRestored'
  | 'WaterDeficit'
  | 'WaterRestored'
  | 'BudgetWarning'
  | 'Abandonment'
  | 'Info';

export interface SimAlert {
  kind: AlertKind;
  message: string;
  sticky: boolean;
}

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
  | { type: 'CommandResult'; success: boolean; message?: string }
  | { type: 'TickStats'; data: TickStats }
  | { type: 'HistoryChanged'; data: HistoryFlags }
  /**
   * TS/worker-only — not mirrored from the Rust side. The engine can't have
   * emitted anything yet if this fires: it means the WASM module itself
   * failed to load/instantiate/boot, so `Ready` will never arrive.
   */
  | { type: 'InitError'; message: string };
