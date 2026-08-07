// alertSeverity.test.ts — the "alerts" overlay's shared severity ladder.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { computeAlertSeverity } from './alertSeverity';
import { BuildingStatus } from '../game/buildings/state';

function tile(overrides: { abandoned?: boolean; powered?: boolean; happiness?: number } = {}) {
  return { abandoned: false, powered: true, happiness: 1, ...overrides };
}

describe('computeAlertSeverity', () => {
  it('is 0 for a healthy non-zone tile', () => {
    expect(computeAlertSeverity(tile(), undefined, false)).toBe(0);
  });

  it('an abandoned tile is critical (2) regardless of anything else', () => {
    expect(computeAlertSeverity(tile({ abandoned: true }), undefined, false)).toBe(2);
  });

  it('InactiveNoPower/InactiveNoWater/InactiveNoSource are critical (2)', () => {
    expect(computeAlertSeverity(tile(), BuildingStatus.InactiveNoPower, false)).toBe(2);
    expect(computeAlertSeverity(tile(), BuildingStatus.InactiveNoWater, false)).toBe(2);
    expect(computeAlertSeverity(tile(), BuildingStatus.InactiveNoSource, false)).toBe(2);
  });

  it('an unpowered zone is critical (2), independent of building status', () => {
    expect(computeAlertSeverity(tile({ powered: false }), undefined, true)).toBe(2);
  });

  it('an unhappy but powered zone is only a warning (1)', () => {
    expect(computeAlertSeverity(tile({ happiness: 0.5 }), undefined, true)).toBe(1);
  });

  it('happiness exactly at the threshold does not trip the warning', () => {
    expect(computeAlertSeverity(tile({ happiness: 0.55 }), undefined, true)).toBe(0);
  });

  it('an unhappy non-zone tile is not a problem at all — the happiness check is zone-gated', () => {
    expect(computeAlertSeverity(tile({ happiness: 0.1 }), undefined, false)).toBe(0);
  });

  it('takes the worst of several simultaneous issues, not the last one checked', () => {
    // The unhappy-zone warning (1) is checked after `abandoned`'s critical
    // (2) in source order — the result must still be 2, proving this maxes
    // rather than overwrites.
    expect(computeAlertSeverity(tile({ abandoned: true, happiness: 0.1 }), undefined, true)).toBe(2);
  });
});
