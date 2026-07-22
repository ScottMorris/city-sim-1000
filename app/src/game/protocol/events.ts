/**
 * FromSim — TS mirror of crates/sim_protocol/src/events.rs.
 *
 * Messages emitted by the sim back to the UI layer.
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
  | { type: 'HistoryChanged'; data: HistoryFlags };
