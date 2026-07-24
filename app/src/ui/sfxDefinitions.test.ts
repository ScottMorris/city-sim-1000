// Unit tests for the built-in default SFX voice definitions and params<->Voice reconstruction
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { note, sound } from '@liminal-hq/undertone';
import { DEFAULT_SFX_VOICES, voiceFromParams } from './sfxDefinitions';
import { SFX_EFFECT_IDS } from '../game/sfxOverrides';

describe('DEFAULT_SFX_VOICES', () => {
  it('defines a non-empty voice stack for every known effect id', () => {
    for (const id of SFX_EFFECT_IDS) {
      expect(DEFAULT_SFX_VOICES[id].length).toBeGreaterThan(0);
    }
  });

  it('placeBuilding has three layers (thunk, sparkle, click)', () => {
    expect(DEFAULT_SFX_VOICES.placeBuilding).toHaveLength(3);
  });
});

describe('voiceFromParams', () => {
  it('round-trips a pitched voice: params -> Voice -> getParams() matches', () => {
    const original = note('c2').sound('triangle').attack(0.001).decay(0.1).lpf(220).getParams();
    const rebuilt = voiceFromParams(original).getParams();
    expect(rebuilt).toEqual(original);
  });

  it('round-trips a noise voice with no pitch', () => {
    const original = sound('white').attack(0).decay(0.02).gain(0.4).getParams();
    const rebuilt = voiceFromParams(original).getParams();
    expect(rebuilt).toEqual(original);
    expect(rebuilt.pitch).toBeUndefined();
  });

  it('round-trips every built-in default voice exactly', () => {
    for (const id of SFX_EFFECT_IDS) {
      for (const params of DEFAULT_SFX_VOICES[id]) {
        expect(voiceFromParams(params).getParams()).toEqual(params);
      }
    }
  });

  it('omits the filter entirely when filterCutoff is undefined', () => {
    const original = note('a4').getParams();
    expect(original.filterCutoff).toBeUndefined();
    const rebuilt = voiceFromParams(original).getParams();
    expect(rebuilt.filterCutoff).toBeUndefined();
  });
});
