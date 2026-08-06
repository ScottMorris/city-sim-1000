// mcpBridge.test.ts — unit coverage for mcpBridge.ts's pure helpers.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { stratumParam, createCommandResultQueue, summarizeApplyResults } from './mcpBridge';
import { Tool } from './toolTypes';

describe('stratumParam', () => {
  it('defaults to surface when the param is absent', () => {
    expect(stratumParam({})).toBe('surface');
  });

  it('reads an explicit "underground" override', () => {
    expect(stratumParam({ stratum: 'underground' })).toBe('underground');
  });

  it('falls back to surface for an explicit "surface" or any unrecognised value', () => {
    expect(stratumParam({ stratum: 'surface' })).toBe('surface');
    expect(stratumParam({ stratum: 'sideways' })).toBe('surface');
    expect(stratumParam({ stratum: 42 })).toBe('surface');
  });

  it('defaults water_pipe to underground, since the engine refuses it anywhere else', () => {
    expect(stratumParam({ tool: Tool.WaterPipe })).toBe('underground');
  });

  it('still honours an explicit "surface" override on water_pipe (the engine will refuse it)', () => {
    expect(stratumParam({ tool: Tool.WaterPipe, stratum: 'surface' })).toBe('surface');
  });
});

describe('createCommandResultQueue', () => {
  it('resolves pending entries in FIFO order, matching send order to arrival order', async () => {
    const queue = createCommandResultQueue();
    const first = queue.expectNext().promise;
    const second = queue.expectNext().promise;
    const third = queue.expectNext().promise;
    // Arrival order mirrors send order (the worker is single-threaded and
    // processes ApplyTool messages in the order it received them) — the
    // queue doesn't need to see any id to match these correctly.
    queue.resolveNext({ success: true });
    queue.resolveNext({ success: false, message: 'no funds' });
    queue.resolveNext({ success: true });
    await expect(first).resolves.toEqual({ success: true });
    await expect(second).resolves.toEqual({ success: false, message: 'no funds' });
    await expect(third).resolves.toEqual({ success: true });
  });

  it('cancel() drops the entry so a later result skips it, not misattributes to it', async () => {
    const queue = createCommandResultQueue();
    const { promise: dropped, cancel } = queue.expectNext();
    const next = queue.expectNext().promise;
    cancel();
    // Only one real result arrives (as if `dropped`'s send timed out and was
    // cancelled) — it must resolve `next`, not the already-abandoned `dropped`.
    queue.resolveNext({ success: true });
    await expect(next).resolves.toEqual({ success: true });
    // `dropped` never resolves — proven indirectly: if resolveNext had
    // matched it instead of `next`, the assertion above would have failed
    // (there would be nothing left to resolve `next`).
    void dropped;
  });

  it('resolveNext with nothing pending is a no-op, not a throw', () => {
    const queue = createCommandResultQueue();
    expect(() => queue.resolveNext({ success: true })).not.toThrow();
  });
});

describe('summarizeApplyResults', () => {
  it('counts an all-success batch as fully placed, with no failure message', () => {
    expect(summarizeApplyResults([{ success: true }, { success: true }])).toEqual({
      placed: 2, attempted: 2, firstFailureMessage: null,
    });
  });

  it('counts failures out of the placed total and surfaces the first failure message', () => {
    const results = [
      { success: true },
      { success: false, message: 'wrong stratum' },
      { success: false, message: 'insufficient funds' },
    ];
    expect(summarizeApplyResults(results)).toEqual({
      placed: 1, attempted: 3, firstFailureMessage: 'wrong stratum',
    });
  });

  it('handles an empty batch', () => {
    expect(summarizeApplyResults([])).toEqual({ placed: 0, attempted: 0, firstFailureMessage: null });
  });
});
