// autosave.test.ts — timing/trigger logic for the browser autosave.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initAutosave,
  type AutosaveController,
  type AutosaveDocument,
  type AutosaveWindow
} from './autosave';
import { pickNewestSave, type SaveRecord } from './saveStore';

/** Minimal event-target fakes so the timing logic tests run in plain node. */
class FakeDoc implements AutosaveDocument {
  visibilityState: DocumentVisibilityState = 'visible';
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string) {
    this.listeners.get(type)?.forEach((l) => l());
  }
}
class FakeWin extends FakeDoc implements AutosaveWindow {}

describe('initAutosave', () => {
  let controller: AutosaveController | null = null;
  let doc: FakeDoc;
  let win: FakeWin;

  beforeEach(() => {
    vi.useFakeTimers();
    doc = new FakeDoc();
    win = new FakeWin();
  });

  afterEach(() => {
    controller?.dispose();
    controller = null;
    vi.useRealTimers();
  });

  it('saves on the interval while the tick advances', async () => {
    let tick = 0;
    const save = vi.fn(() => Promise.resolve());
    controller = initAutosave({ intervalMs: 1000, getTick: () => tick, save, doc, win });
    tick = 10;
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    tick = 20;
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('skips when the tick has not advanced since the last save', async () => {
    const save = vi.fn(() => Promise.resolve());
    controller = initAutosave({ intervalMs: 1000, getTick: () => 42, save, doc, win });
    await vi.advanceTimersByTimeAsync(3000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('does not stack a second save while one is in flight', async () => {
    let tick = 0;
    let resolveSave!: () => void;
    const save = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    controller = initAutosave({ intervalMs: 1000, getTick: () => (tick += 1), save, doc, win });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    resolveSave();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('flushes when the document becomes hidden and on pagehide', async () => {
    let tick = 0;
    const save = vi.fn(() => Promise.resolve());
    controller = initAutosave({ intervalMs: 60_000, getTick: () => (tick += 1), save, doc, win });
    doc.visibilityState = 'hidden';
    doc.emit('visibilitychange');
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    win.emit('pagehide');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('reports errors and keeps running', async () => {
    let tick = 0;
    const onError = vi.fn();
    const save = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('quota'))
      .mockResolvedValue(undefined);
    controller = initAutosave({ intervalMs: 1000, getTick: () => (tick += 1), save, onError, doc, win });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('dispose stops the timer and listeners', async () => {
    let tick = 0;
    const save = vi.fn(() => Promise.resolve());
    controller = initAutosave({ intervalMs: 1000, getTick: () => (tick += 1), save, doc, win });
    controller.dispose();
    controller = null;
    await vi.advanceTimersByTimeAsync(5000);
    win.emit('pagehide');
    expect(save).not.toHaveBeenCalled();
  });
});

describe('pickNewestSave', () => {
  const record = (id: 'manual' | 'autosave', savedAt: string): SaveRecord => ({
    id,
    meta: {
      savedAt, kind: id, width: 8, height: 8, seed: 1,
      tick: 0, day: 1, population: 0, money: 0
    },
    container: new ArrayBuffer(0)
  });

  it('prefers the newer record', () => {
    const manual = record('manual', '2026-07-22T10:00:00.000Z');
    const autosave = record('autosave', '2026-07-22T11:00:00.000Z');
    expect(pickNewestSave(manual, autosave)?.id).toBe('autosave');
    expect(pickNewestSave(record('manual', '2026-07-22T12:00:00.000Z'), autosave)?.id).toBe('manual');
  });

  it('handles missing slots and favours manual on ties or bad timestamps', () => {
    const manual = record('manual', '2026-07-22T10:00:00.000Z');
    expect(pickNewestSave(null, null)).toBeNull();
    expect(pickNewestSave(manual, null)?.id).toBe('manual');
    expect(pickNewestSave(null, record('autosave', '2026-07-22T10:00:00.000Z'))?.id).toBe('autosave');
    expect(pickNewestSave(manual, record('autosave', manual.meta.savedAt))?.id).toBe('manual');
    expect(pickNewestSave(manual, record('autosave', 'not-a-date'))?.id).toBe('manual');
  });
});
