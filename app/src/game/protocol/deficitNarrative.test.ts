// deficitNarrative.test.ts — AlertKind → narrative SimEvent derivation.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { deriveNarrativeEventFromAlert } from './deficitNarrative';
import type { SimAlert } from './events';

describe('deriveNarrativeEventFromAlert', () => {
  it.each([
    ['PowerDeficit', 'power_deficit_start', 'alert'],
    ['PowerRestored', 'power_deficit_end', 'info'],
    ['WaterDeficit', 'water_deficit_start', 'alert'],
    ['WaterRestored', 'water_deficit_end', 'info'],
  ] as const)('maps %s to a %s narrative event with %s severity', (kind, type, severity) => {
    const alert: SimAlert = { kind, message: 'msg', sticky: kind.endsWith('Deficit') };
    const event = deriveNarrativeEventFromAlert(alert, 12345);
    expect(event).toMatchObject({ type, category: 'utilities', severity, message: 'msg', timestamp: 12345 });
    expect(event?.id).toBe(`${type}-12345`);
  });

  it('returns null for alert kinds with no narrative counterpart', () => {
    const alert: SimAlert = { kind: 'BudgetWarning', message: 'msg', sticky: false };
    expect(deriveNarrativeEventFromAlert(alert, 1)).toBeNull();
  });
});
