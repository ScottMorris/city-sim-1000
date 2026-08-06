// clientState.ts — the TS-owned slice of a save: settings.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// Everything else in the TS `GameState` is either engine-owned (tiles, stats,
// budget, policies — including the lighting bylaw, `#9` follow-up — all
// inside the CSAV engine snapshot) or derived display state that refills
// within a few ticks of load. This module owns the extraction/merge of the
// client slice for the CSAV container's client JSON. The lighting bylaw used
// to live here too (`BylawState`) — see `bylaws.ts`'s
// `extractLegacyLightingPolicy` for how an older save's stray `bylaws` field
// is migrated into engine `Policies` instead.

import {
  createDefaultAccessibilitySettings,
  createDefaultAudioSettings,
  createDefaultCosmeticSettings,
  createDefaultInputSettings,
  createDefaultMinimapSettings,
  createDefaultNarrativeSettings,
  createDefaultUiSettings,
  MINIMAP_OVERLAYS,
  type GameSettings,
  type GameState,
  type MinimapOverlay,
  type MinimapSettings
} from './gameState';
import { defaultHotkeys } from '../ui/hotkeys';
import { createDefaultSfxOverrides } from './sfxOverrides';

/** The TS-owned surface of a save — serialised as the CSAV client JSON. */
export interface ClientState {
  settings: GameSettings;
}

/**
 * Merge possibly-partial settings (from an old save or a newer/older client
 * JSON) over the current defaults, so new settings fields never break loads.
 */
export function ensureSettingsShape(settings?: Partial<GameSettings>): GameSettings {
  const minimapDefaults = createDefaultMinimapSettings();
  // A save's `minimap` may still carry an old `mode: 'underground'` key from
  // before the stratum/overlay split. Picking fields explicitly (rather than
  // spreading the incoming object) both drops that stray key — instead of
  // letting it round-trip into every future save — and drops the old
  // edit-stratum value itself rather than migrating it (stratum was never
  // meant to persist anyway).
  const incomingMinimap = settings?.minimap;
  const incomingOverlay = incomingMinimap?.overlay as MinimapOverlay | undefined;
  const minimapSettings: MinimapSettings = {
    open: incomingMinimap?.open ?? minimapDefaults.open,
    size: incomingMinimap?.size ?? minimapDefaults.size,
    overlay: incomingOverlay && MINIMAP_OVERLAYS.includes(incomingOverlay) ? incomingOverlay : minimapDefaults.overlay
  };
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
  return { settings: state.settings };
}

/**
 * Merge a loaded client slice onto the live display mirror. `client.settings`
 * may itself be partial (a legacy JSON save's raw `settings` field,
 * transcoded verbatim by `persistence.ts`'s `transcodeLegacySave` with no
 * back-fill of its own) — `ensureSettingsShape` back-fills defaults for
 * whatever is missing, at any nesting level.
 */
export function applyClientState(state: GameState, client?: { settings?: Partial<GameSettings> }): void {
  state.settings = ensureSettingsShape(client?.settings);
}
