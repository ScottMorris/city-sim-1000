// Unit tests for the SFX editor's code-view serializer/compiler
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { VoiceParams } from '@liminal-hq/undertone';
import { paramsToCode, codeToParams } from './sfxCode';
import { DEFAULT_SFX_VOICES } from './sfxDefinitions';

describe('paramsToCode / codeToParams round-trip', () => {
  it('round-trips every built-in default effect exactly', () => {
    for (const params of Object.values(DEFAULT_SFX_VOICES)) {
      const code = paramsToCode(params);
      const parsed = codeToParams(code);
      expect(parsed).toEqual(params);
    }
  });

  it('round-trips a numeric (raw Hz) pitch', () => {
    const params: VoiceParams[] = [{
      soundType: 'sine', pitch: 440, gainLevel: 0.5,
      attack: 0.01, decay: 0.1, sustain: 0, release: 0.05,
      filterCutoff: undefined, filterEnvAmount: 0, filterAttack: 0,
      filterDecay: 0, filterSustain: 1, filterRelease: 0,
      slideTime: 0, nudgeTime: 0
    }];
    expect(codeToParams(paramsToCode(params))).toEqual(params);
  });

  it('round-trips a noise voice with no pitch and no filter', () => {
    const params: VoiceParams[] = [{
      soundType: 'brown', pitch: undefined, gainLevel: 0.4,
      attack: 0, decay: 0.1, sustain: 0.1, release: 0.12,
      filterCutoff: undefined, filterEnvAmount: 0, filterAttack: 0,
      filterDecay: 0, filterSustain: 1, filterRelease: 0,
      slideTime: 0, nudgeTime: 0
    }];
    const code = paramsToCode(params);
    expect(code).not.toContain('.lpf(');
    expect(codeToParams(code)).toEqual(params);
  });

  it('preserves a defined filterCutoff and its envelope fields', () => {
    const params: VoiceParams[] = [{
      soundType: 'square', pitch: 'a2', gainLevel: 0.5,
      attack: 0.001, decay: 0.12, sustain: 0, release: 0.08,
      filterCutoff: 600, filterEnvAmount: 50, filterAttack: 0.01,
      filterDecay: 0.02, filterSustain: 0.3, filterRelease: 0.05,
      slideTime: 0.15, nudgeTime: 0
    }];
    expect(codeToParams(paramsToCode(params))).toEqual(params);
  });
});

describe('codeToParams trailing-semicolon tolerance', () => {
  it('tolerates a trailing semicolon (the most natural thing to type after an array literal)', () => {
    const code = "[note(60).sound('sine').attack(0.01).decay(0.1).sustain(0).release(0.05).gain(0.8)];";
    expect(() => codeToParams(code)).not.toThrow();
  });

  it('tolerates trailing semicolon plus surrounding whitespace/newlines', () => {
    const code = "\n  [note(60).sound('sine').attack(0.01).decay(0.1).sustain(0).release(0.05).gain(0.8)]  ;\n\n";
    expect(() => codeToParams(code)).not.toThrow();
  });
});

describe('codeToParams error handling', () => {
  it('throws a descriptive error on a syntax error', () => {
    expect(() => codeToParams('[note(60).attack(')).toThrow(/Couldn't parse/);
  });

  it('throws when the code does not evaluate to an array', () => {
    expect(() => codeToParams('note(60)')).toThrow(/non-empty array/);
  });

  it('throws when the array is empty', () => {
    expect(() => codeToParams('[]')).toThrow(/non-empty array/);
  });

  it('throws when an array element is not a Voice', () => {
    expect(() => codeToParams('[note(60), 42]')).toThrow(/isn't a voice/);
  });
});
