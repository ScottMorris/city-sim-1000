// Unit tests for SFX override resolution precedence and reset semantics
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { VoiceParams } from '@liminal-hq/undertone';
import {
  createDefaultSfxOverrides,
  resetEffect,
  resolveVoiceParams,
  type SfxEffectId,
  type SfxOverrides
} from './sfxOverrides';

function makeParams(gainLevel: number): VoiceParams {
  return {
    soundType: 'sine',
    gainLevel,
    attack: 0.01,
    decay: 0.1,
    sustain: 0,
    release: 0.05,
    filterEnvAmount: 0,
    filterAttack: 0,
    filterDecay: 0,
    filterSustain: 1,
    filterRelease: 0,
    slideTime: 0,
    nudgeTime: 0
  };
}

const DEFAULTS: Record<SfxEffectId, VoiceParams[]> = {
  placeBuilding: [makeParams(0.8)],
  bulldoze: [makeParams(0.7)],
  error: [makeParams(0.5)],
  undo: [makeParams(0.35)]
};

describe('createDefaultSfxOverrides', () => {
  it('starts empty', () => {
    expect(createDefaultSfxOverrides()).toEqual({});
  });
});

describe('resolveVoiceParams', () => {
  it('falls back to the built-in default when no override exists', () => {
    const result = resolveVoiceParams('placeBuilding', DEFAULTS, {}, {});
    expect(result).toBe(DEFAULTS.placeBuilding);
  });

  it('prefers a global override over the default', () => {
    const global: SfxOverrides = { placeBuilding: [makeParams(0.5)] };
    const result = resolveVoiceParams('placeBuilding', DEFAULTS, {}, global);
    expect(result).toBe(global.placeBuilding);
  });

  it('prefers a city override over both the global override and the default', () => {
    const city: SfxOverrides = { placeBuilding: [makeParams(0.3)] };
    const global: SfxOverrides = { placeBuilding: [makeParams(0.5)] };
    const result = resolveVoiceParams('placeBuilding', DEFAULTS, city, global);
    expect(result).toBe(city.placeBuilding);
  });
});

describe('resetEffect', () => {
  it('removes only the given effect, leaving others untouched', () => {
    const overrides: SfxOverrides = {
      placeBuilding: [makeParams(0.3)],
      bulldoze: [makeParams(0.6)]
    };
    const next = resetEffect(overrides, 'placeBuilding');
    expect(next.placeBuilding).toBeUndefined();
    expect(next.bulldoze).toBe(overrides.bulldoze);
  });

  it('does not mutate the original overrides object', () => {
    const overrides: SfxOverrides = { placeBuilding: [makeParams(0.3)] };
    resetEffect(overrides, 'placeBuilding');
    expect(overrides.placeBuilding).toBeDefined();
  });
});
