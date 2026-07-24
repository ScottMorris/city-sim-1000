// Player-customisable sound-effect voice-stack overrides: types and resolution order
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { VoiceParams } from '@liminal-hq/undertone';

export type SfxEffectId = 'placeBuilding' | 'bulldoze' | 'error' | 'undo';

export const SFX_EFFECT_IDS: SfxEffectId[] = ['placeBuilding', 'bulldoze', 'error', 'undo'];

export const SFX_EFFECT_LABELS: Record<SfxEffectId, string> = {
  placeBuilding: 'Place Building',
  bulldoze: 'Bulldoze',
  error: 'Error',
  undo: 'Undo'
};

/** Whole-voice-stack overrides, keyed by effect id. Saving replaces an effect's entire stack. */
export type SfxOverrides = Partial<Record<SfxEffectId, VoiceParams[]>>;

export function createDefaultSfxOverrides(): SfxOverrides {
  return {};
}

/** Resolution order: city override -> global override -> built-in default. */
export function resolveVoiceParams(
  id: SfxEffectId,
  defaults: Record<SfxEffectId, VoiceParams[]>,
  cityOverrides: SfxOverrides,
  globalOverrides: SfxOverrides
): VoiceParams[] {
  return cityOverrides[id] ?? globalOverrides[id] ?? defaults[id];
}

/** Removes one effect's override from both scopes, reverting it to the built-in default. */
export function resetEffect(overrides: SfxOverrides, id: SfxEffectId): SfxOverrides {
  const next = { ...overrides };
  delete next[id];
  return next;
}
