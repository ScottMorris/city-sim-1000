// autosave.ts — periodic browser autosave plus save-on-hide.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// Timing and trigger logic only — the caller supplies the actual save (an
// async write of a CSAV container into the dedicated `'autosave'` IndexedDB
// slot). Saving is a pure read of the engine, so an autosave can never touch
// the undo history; the manual save slot is never written by this module.

/** The slice of `document` the autosave listens to — injectable for tests. */
export interface AutosaveDocument {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  readonly visibilityState: DocumentVisibilityState;
}

/** The slice of `window` the autosave listens to — injectable for tests. */
export interface AutosaveWindow {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

export interface AutosaveOptions {
  /** Milliseconds between periodic attempts. Default 60 000. */
  intervalMs?: number;
  /** Current sim tick — attempts are skipped while it hasn't advanced. */
  getTick: () => number;
  /** Perform the save (encode + write to the `'autosave'` slot). */
  save: () => Promise<void>;
  /** Called on save failure (the interval keeps running). */
  onError?: (err: unknown) => void;
  /** Injectable for tests; defaults to the real `document`/`window`. */
  doc?: AutosaveDocument;
  win?: AutosaveWindow;
}

export interface AutosaveController {
  /** Fire an attempt now (also used by the hide/pagehide listeners). */
  flush: () => void;
  dispose: () => void;
}

export function initAutosave(options: AutosaveOptions): AutosaveController {
  const intervalMs = options.intervalMs ?? 60_000;
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  let lastSavedTick = -1;
  let inFlight = false;

  const attempt = () => {
    if (inFlight) return;
    const tick = options.getTick();
    // Paused or idle since the last write — nothing new to preserve.
    if (tick === lastSavedTick) return;
    inFlight = true;
    options
      .save()
      .then(() => {
        lastSavedTick = tick;
      })
      .catch((err) => options.onError?.(err))
      .finally(() => {
        inFlight = false;
      });
  };

  const timer = setInterval(attempt, intervalMs);
  // Tab hidden or being unloaded — the moments a refresh/crash would
  // otherwise lose everything since the last periodic write.
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') attempt();
  };
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', attempt);

  return {
    flush: attempt,
    dispose() {
      clearInterval(timer);
      doc.removeEventListener('visibilitychange', onVisibility);
      win.removeEventListener('pagehide', attempt);
    }
  };
}
