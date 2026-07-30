// deficitNarrative.ts — derives the narrative-ticker event that pairs with a
// utility deficit/restore alert.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { SimAlert, AlertKind } from './events';
import type { SimEvent, SimEventType } from '../narrative/types';

const EVENT_TYPE_BY_ALERT_KIND: Partial<Record<AlertKind, SimEventType>> = {
  PowerDeficit: 'power_deficit_start',
  PowerRestored: 'power_deficit_end',
  WaterDeficit: 'water_deficit_start',
  WaterRestored: 'water_deficit_end',
};

/**
 * Derives the ticker/insights `SimEvent` that pairs with a deficit/restore
 * `SimAlert`, or `null` for alert kinds with no narrative counterpart (e.g.
 * `BudgetWarning`/`Abandonment`/`Info`, none of which the engine raises yet).
 *
 * Shared by `wasmSimBridge.ts` and `tauriSimBridge.ts` deliberately: the
 * mapping from `AlertKind` to `SimEventType` and the wall-clock `timestamp`
 * are display/narrative concerns, not simulation truth, so they stay out of
 * Rust (see `sim.rs`'s `handle_resource_alerts`, which raises only the
 * alert) — kept in exactly one TS place instead of two independently
 * maintained copies, one per bridge.
 */
export function deriveNarrativeEventFromAlert(alert: SimAlert, now: number): SimEvent | null {
  const type = EVENT_TYPE_BY_ALERT_KIND[alert.kind];
  if (!type) return null;
  const starting = type.endsWith('_start');
  return {
    id: `${type}-${now}`,
    type,
    timestamp: now,
    category: 'utilities',
    severity: starting ? 'alert' : 'info',
    message: alert.message,
  };
}
