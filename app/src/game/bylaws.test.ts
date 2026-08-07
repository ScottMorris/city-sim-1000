// bylaws.test.ts — the lighting bylaw's DISPLAY table and preview arithmetic.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { extractLegacyLightingPolicy, isLightingPolicy, previewLightingPolicy } from './bylaws';

describe('bylaws', () => {
  describe('previewLightingPolicy', () => {
    it('recovers the applied figures exactly when previewing the active policy', () => {
      // current === candidate: the rescale round-trips to the applied
      // numbers, whatever they are — no re-simulation, pure algebra.
      const projection = previewLightingPolicy('efficient', 'efficient', 12.3, 45.6);
      expect(projection.powerUse).toBeCloseTo(12.3, 5);
      expect(projection.maintenance).toBeCloseTo(45.6, 5);
      expect(projection.powerUseDelta).toBeCloseTo(0, 5);
      expect(projection.maintenanceDelta).toBeCloseTo(0, 5);
    });

    it('rescales an already-applied non-neutral baseline by the multiplier ratio', () => {
      // The engine reports figures already scaled by the *active* ('mixed',
      // multiplier 1) bylaw — previewing 'efficient' (0.82 power, 0.9
      // maintenance) must recover the unscaled baseline first, then rescale.
      const projection = previewLightingPolicy('mixed', 'efficient', 12, 60);
      expect(projection.powerUse).toBeCloseTo(12 * 0.82, 5);
      expect(projection.maintenance).toBeCloseTo(60 * 0.9, 5);
      expect(projection.powerUseDelta).toBeCloseTo(12 * 0.82 - 12, 5);
      expect(projection.maintenanceDelta).toBeCloseTo(60 * 0.9 - 60, 5);
    });

    it('accounts for a non-neutral active policy when rescaling', () => {
      // Applied figures are already under 'efficient' (0.82 / 0.9) — preview
      // 'carbonArc' (1.18 / 1.05) by first undoing 'efficient', then
      // reapplying 'carbonArc'.
      const appliedPowerUse = 12 * 0.82;
      const appliedMaintenance = 60 * 0.9;
      const projection = previewLightingPolicy('efficient', 'carbonArc', appliedPowerUse, appliedMaintenance);
      expect(projection.powerUse).toBeCloseTo(12 * 1.18, 5);
      expect(projection.maintenance).toBeCloseTo(60 * 1.05, 5);
    });
  });

  describe('isLightingPolicy', () => {
    it('accepts only the three known ids', () => {
      expect(isLightingPolicy('mixed')).toBe(true);
      expect(isLightingPolicy('efficient')).toBe(true);
      expect(isLightingPolicy('carbonArc')).toBe(true);
      expect(isLightingPolicy('carbon-arc')).toBe(false);
      expect(isLightingPolicy('')).toBe(false);
      expect(isLightingPolicy(undefined)).toBe(false);
      expect(isLightingPolicy(3)).toBe(false);
    });
  });

  describe('extractLegacyLightingPolicy', () => {
    it('extracts a legal id from a raw save-shaped object', () => {
      expect(extractLegacyLightingPolicy({ bylaws: { lighting: 'carbonArc' } })).toBe('carbonArc');
    });

    it('returns undefined when bylaws/lighting is absent or illegal', () => {
      expect(extractLegacyLightingPolicy({})).toBeUndefined();
      expect(extractLegacyLightingPolicy({ bylaws: {} })).toBeUndefined();
      expect(extractLegacyLightingPolicy({ bylaws: { lighting: 'neon' } })).toBeUndefined();
      expect(extractLegacyLightingPolicy(null)).toBeUndefined();
      expect(extractLegacyLightingPolicy(undefined)).toBeUndefined();
    });
  });
});
