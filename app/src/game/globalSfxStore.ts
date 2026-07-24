// Cross-city sound-effect overrides, persisted globally in localStorage
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// Every other real persistence in this app goes through saveStore.ts's IndexedDB —
// localStorage is otherwise only used for the legacy pre-IndexedDB save format and
// a debug flag. This is a deliberate first: SFX overrides a player wants applied to
// every city are small, genuinely global (not per-save), and non-critical if lost,
// which is exactly the case localStorage fits and IndexedDB's save-slot model doesn't.

import { createDefaultSfxOverrides, type SfxOverrides } from './sfxOverrides';

const STORAGE_KEY = 'city-sim-1000:global-sfx-overrides';

export function loadGlobalSfxOverrides(): SfxOverrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : createDefaultSfxOverrides();
  } catch {
    return createDefaultSfxOverrides();
  }
}

export function saveGlobalSfxOverrides(overrides: SfxOverrides): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Storage disabled or full — silently no-op rather than crash the editor.
  }
}
