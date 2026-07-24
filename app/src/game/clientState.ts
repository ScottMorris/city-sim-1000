// clientState.ts — the TS-owned slice of a save: settings and bylaws.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// Everything else in the TS `GameState` is either engine-owned (tiles, stats,
// budget, policies — all inside the CSAV engine snapshot) or derived display
// state that refills within a few ticks of load. This module owns the
// extraction/merge of the client slice for the CSAV container's client JSON.

import {
  createDefaultAccessibilitySettings,
  createDefaultAudioSettings,
  createDefaultCosmeticSettings,
  createDefaultInputSettings,
  createDefaultMinimapSettings,
  createDefaultNarrativeSettings,
  createDefaultUiSettings,
  type GameSettings,
  type GameState
} from './gameState';
import { DEFAULT_BYLAWS, type BylawState } from './bylaws';
import { defaultHotkeys } from '../ui/hotkeys';
import { createDefaultSfxOverrides } from './sfxOverrides';

/** The TS-owned surface of a save — serialised as the CSAV client JSON. */
export interface ClientState {
  settings: GameSettings;
  bylaws: BylawState;
}

/**
 * Merge possibly-partial settings (from an old save or a newer/older client
 * JSON) over the current defaults, so new settings fields never break loads.
 */
export function ensureSettingsShape(settings?: Partial<GameSettings>): GameSettings {
  const minimapDefaults = createDefaultMinimapSettings();
  const minimapSettings = {
    ...minimapDefaults,
    ...(settings?.minimap ?? {})
  };
  if (!['base', 'power', 'water', 'alerts', 'education', 'underground'].includes(minimapSettings.mode)) {
    minimapSettings.mode = 'base';
  }
  const inputDefaults = createDefaultInputSettings();
  const accessibilityDefaults = createDefaultAccessibilitySettings();
  const audioDefaults = createDefaultAudioSettings();
  const cosmeticDefaults = createDefaultCosmeticSettings();
  const narrativeDefaults = createDefaultNarrativeSettings();
  const uiDefaults = createDefaultUiSettings();
  const sfxOverridesDefaults = createDefaultSfxOverrides();
  const uiSettings = { ...uiDefaults, ...(settings?.ui ?? {}) };
  if (!['auto', 'desktop', 'mobile'].includes(uiSettings.mode)) {
    uiSettings.mode = 'auto';
  }
  return {
    pendingPenaltyEnabled: settings?.pendingPenaltyEnabled ?? true,
    minimap: minimapSettings,
    input: { ...inputDefaults, ...(settings?.input ?? {}) },
    accessibility: { ...accessibilityDefaults, ...(settings?.accessibility ?? {}) },
    audio: { ...audioDefaults, ...(settings?.audio ?? {}) },
    hotkeys: { ...defaultHotkeys, ...(settings?.hotkeys ?? {}) },
    cosmetics: { ...cosmeticDefaults, ...(settings?.cosmetics ?? {}) },
    narrative: { ...narrativeDefaults, ...(settings?.narrative ?? {}) },
    ui: uiSettings,
    sfxOverrides: { ...sfxOverridesDefaults, ...(settings?.sfxOverrides ?? {}) }
  };
}

/** Extract the client slice of `state` for saving. */
export function extractClientState(state: GameState): ClientState {
  return { settings: state.settings, bylaws: state.bylaws };
}

/** Merge a loaded client slice onto the live display mirror. */
export function applyClientState(state: GameState, client?: Partial<ClientState>): void {
  state.settings = ensureSettingsShape(client?.settings);
  state.bylaws = { ...DEFAULT_BYLAWS, ...(client?.bylaws ?? {}) };
  if (!state.bylaws.lighting) {
    state.bylaws.lighting = DEFAULT_BYLAWS.lighting;
  }
}
