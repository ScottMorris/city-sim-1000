// Built-in default sound effects (ported from @liminal-hq/undertone's own tuned demo presets)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { note, sound, Voice, type VoiceParams } from '@liminal-hq/undertone';
import type { SfxEffectId } from '../game/sfxOverrides';

export const DEFAULT_SFX_VOICES: Record<SfxEffectId, VoiceParams[]> = {
  placeBuilding: [
    note('c2')
      .sound('triangle')
      .attack(0.001)
      .decay(0.1)
      .sustain(0)
      .release(0.05)
      .gain(0.9)
      .lpf(220)
      .lpenv(5)
      .lpa(0.001)
      .lpd(0.08)
      .lps(0)
      .lpr(0.05)
      .slide(0.07)
      .getParams(),
    note('c6')
      .sound('sine')
      .attack(0.001)
      .decay(0.15)
      .sustain(0)
      .release(0.1)
      .gain(0.3)
      .lpf(2000)
      .lpenv(8)
      .lpa(0.001)
      .lpd(0.06)
      .lps(0)
      .lpr(0.1)
      .nudge(0.02)
      .getParams(),
    sound('white').attack(0).decay(0.02).sustain(0).release(0.01).gain(0.4).lpf(4000).lpenv(0).getParams()
  ],
  bulldoze: [
    note('a1')
      .sound('sawtooth')
      .attack(0.001)
      .decay(0.14)
      .sustain(0)
      .release(0.08)
      .gain(0.7)
      .lpf(180)
      .lpenv(3)
      .lpa(0.001)
      .lpd(0.1)
      .lps(0)
      .lpr(0.08)
      .slide(0.12)
      .getParams(),
    sound('brown').attack(0.001).decay(0.1).sustain(0.1).release(0.12).gain(0.5).lpf(900).lpenv(0).getParams()
  ],
  error: [
    note('a2')
      .sound('square')
      .attack(0.001)
      .decay(0.12)
      .sustain(0)
      .release(0.08)
      .gain(0.5)
      .lpf(600)
      .lpenv(0)
      .slide(0.15)
      .getParams()
  ],
  undo: [
    note('a4')
      .sound('square')
      .attack(0.001)
      .decay(0.08)
      .sustain(0)
      .release(0.04)
      .gain(0.35)
      .lpf(2200)
      .slide(0.05)
      .getParams()
  ]
};

/** Mechanically reconstructs a Voice from a raw params object — every field maps to one setter. */
export function voiceFromParams(params: VoiceParams): Voice {
  const base = params.pitch !== undefined ? note(params.pitch) : sound(params.soundType);
  let voice = base
    .sound(params.soundType)
    .attack(params.attack)
    .decay(params.decay)
    .sustain(params.sustain)
    .release(params.release)
    .gain(params.gainLevel)
    .lpenv(params.filterEnvAmount)
    .lpa(params.filterAttack)
    .lpd(params.filterDecay)
    .lps(params.filterSustain)
    .lpr(params.filterRelease)
    .slide(params.slideTime)
    .nudge(params.nudgeTime);
  if (params.filterCutoff !== undefined) {
    voice = voice.lpf(params.filterCutoff);
  }
  return voice;
}
