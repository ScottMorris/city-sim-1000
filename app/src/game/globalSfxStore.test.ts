// @vitest-environment jsdom
// Unit tests for the localStorage-backed global SFX override store
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceParams } from '@liminal-hq/undertone';
import { loadGlobalSfxOverrides, saveGlobalSfxOverrides } from './globalSfxStore';
import type { SfxOverrides } from './sfxOverrides';

function makeParams(): VoiceParams {
  return {
    soundType: 'sine',
    gainLevel: 0.8,
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

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('loadGlobalSfxOverrides', () => {
  it('returns an empty object when nothing has been saved', () => {
    expect(loadGlobalSfxOverrides()).toEqual({});
  });

  it('round-trips whatever saveGlobalSfxOverrides wrote', () => {
    const overrides: SfxOverrides = { bulldoze: [makeParams()] };
    saveGlobalSfxOverrides(overrides);
    expect(loadGlobalSfxOverrides()).toEqual(overrides);
  });

  it('falls back to empty rather than throwing on corrupt stored JSON', () => {
    localStorage.setItem('city-sim-1000:global-sfx-overrides', '{not json');
    expect(loadGlobalSfxOverrides()).toEqual({});
  });
});

describe('saveGlobalSfxOverrides', () => {
  it('does not throw when localStorage.setItem fails (storage disabled/full)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => saveGlobalSfxOverrides({ error: [makeParams()] })).not.toThrow();
  });
});
