// mcpBridge.test.ts — unit coverage for mcpBridge.ts's pure helpers.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { stratumParam, createCommandResultQueue, summariseApplyResults, terrainLabel, tileMatchesKind } from './mcpBridge';
import { Tool } from './toolTypes';
import { createInitialState, getTile, setTile, TileKind } from './gameState';
import { Occupant, Terrain, setTileOccupant } from './protocol/occupants';

describe('terrainLabel', () => {
  it('spells Terrain.Land as "land" and Terrain.Water as "water"', () => {
    expect(terrainLabel(Terrain.Land)).toBe('land');
    expect(terrainLabel(Terrain.Water)).toBe('water');
  });
});

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
  it('a batch sharing one strokeId (a line/rect stroke) resolves every send, in order, not just the last', async () => {
    const queue = createCommandResultQueue();
    // apply_tool_line/_rect send every tile under a single stroke id — the
    // queue must hold one slot per send, not one per id.
    // Three DISTINCT results — with any two equal, an order-scrambling bug
    // (e.g. LIFO instead of FIFO) could slip through unseen.
    const a = queue.expectNext(7).promise;
    const b = queue.expectNext(7).promise;
    const c = queue.expectNext(7).promise;
    queue.resolveNext({ success: true, message: null, strokeId: 7 });
    queue.resolveNext({ success: false, message: 'no funds', strokeId: 7 });
    queue.resolveNext({ success: false, message: 'wrong stratum', strokeId: 7 });
    await expect(a).resolves.toEqual({ success: true, message: null, strokeId: 7 });
    await expect(b).resolves.toEqual({ success: false, message: 'no funds', strokeId: 7 });
    await expect(c).resolves.toEqual({ success: false, message: 'wrong stratum', strokeId: 7 });
  });

  it('cancelling one send in a shared-id batch drops only that slot', async () => {
    const queue = createCommandResultQueue();
    const a = queue.expectNext(9);
    const b = queue.expectNext(9).promise;
    a.cancel();
    queue.resolveNext({ success: false, message: 'wrong stratum', strokeId: 9 });
    await expect(b).resolves.toEqual({ success: false, message: 'wrong stratum', strokeId: 9 });
  });

  it('resolves each pending entry by its own strokeId, even when results arrive out of send order', async () => {
    const queue = createCommandResultQueue();
    const first = queue.expectNext(1).promise;
    const second = queue.expectNext(2).promise;
    const third = queue.expectNext(3).promise;
    // Deliberately scrambled arrival order — Tauri's IPC gives no ordering
    // guarantee across concurrent invoke() calls, and a human clicking the
    // same tab can interleave their own sends. A queue that only tracked
    // send order (the old FIFO design) would misattribute these.
    queue.resolveNext({ success: false, message: 'no funds', strokeId: 2 });
    queue.resolveNext({ success: true, message: null, strokeId: 3 });
    queue.resolveNext({ success: true, message: null, strokeId: 1 });
    await expect(first).resolves.toEqual({ success: true, message: null, strokeId: 1 });
    await expect(second).resolves.toEqual({ success: false, message: 'no funds', strokeId: 2 });
    await expect(third).resolves.toEqual({ success: true, message: null, strokeId: 3 });
  });

  it('cancel() drops the entry so a later result for a different id is unaffected', async () => {
    const queue = createCommandResultQueue();
    const { promise: dropped, cancel } = queue.expectNext(1);
    const next = queue.expectNext(2).promise;
    cancel();
    // Only one real result arrives (as if `dropped`'s send timed out and was
    // cancelled) — it must resolve `next`, not the already-abandoned `dropped`.
    queue.resolveNext({ success: true, message: null, strokeId: 2 });
    await expect(next).resolves.toEqual({ success: true, message: null, strokeId: 2 });
    // `dropped` never resolves — proven indirectly: if resolveNext had
    // matched it instead of `next`, the assertion above would have failed
    // (there would be nothing left to resolve `next`).
    void dropped;
  });

  it('resolveNext for an unknown strokeId is a no-op, not a throw', () => {
    const queue = createCommandResultQueue();
    expect(() => queue.resolveNext({ success: true, message: null, strokeId: 99 })).not.toThrow();
  });

  it('resolveNext for an already-resolved strokeId is a no-op — it does not resolve a later reuse of the same id', async () => {
    const queue = createCommandResultQueue();
    queue.resolveNext({ success: true, message: null, strokeId: 1 }); // nothing pending yet — no-op
    const late = queue.expectNext(1).promise;
    queue.resolveNext({ success: false, message: 'the real one', strokeId: 1 });
    await expect(late).resolves.toEqual({ success: false, message: 'the real one', strokeId: 1 });
  });
});

describe('summariseApplyResults', () => {
  it('counts an all-success batch as fully placed, with no failure message', () => {
    expect(summariseApplyResults([{ success: true, message: null }, { success: true, message: null }])).toEqual({
      placed: 2, attempted: 2, firstFailureMessage: null,
    });
  });

  it('counts failures out of the placed total and surfaces the first failure message', () => {
    const results = [
      { success: true, message: null },
      { success: false, message: 'wrong stratum' },
      { success: false, message: 'insufficient funds' },
    ];
    expect(summariseApplyResults(results)).toEqual({
      placed: 1, attempted: 3, firstFailureMessage: 'wrong stratum',
    });
  });

  it('handles an empty batch', () => {
    expect(summariseApplyResults([])).toEqual({ placed: 0, attempted: 0, firstFailureMessage: null });
  });
});

describe('tileMatchesKind', () => {
  it('matches a kind present in any stratum — a road hidden under a power line still matches "road"', () => {
    const state = createInitialState(3, 3);
    setTile(state, 1, 1, TileKind.Road);
    const tile = getTile(state, 1, 1)!;
    setTileOccupant(tile, Occupant.PowerLine, true);
    setTileOccupant(tile, Occupant.Pipe, true);

    expect(tileMatchesKind(state, tile, TileKind.PowerLine)).toBe(true);
    expect(tileMatchesKind(state, tile, TileKind.Road)).toBe(true);
    expect(tileMatchesKind(state, tile, TileKind.WaterPipe)).toBe(true);
    expect(tileMatchesKind(state, tile, TileKind.Rail)).toBe(false);
  });

  it('"land"/"water" match the tile\'s terrain, independent of any occupant on it', () => {
    const state = createInitialState(3, 3);
    setTile(state, 1, 1, TileKind.Road); // setTile forces terrain to Land
    const tile = getTile(state, 1, 1)!;

    expect(tileMatchesKind(state, tile, TileKind.Land)).toBe(true); // a road built on land still matches "land"
    expect(tileMatchesKind(state, tile, TileKind.Water)).toBe(false);
    // "land"/"water" describe terrain, not an occupant, so they never appear
    // in `occupantsByStratum` — the terrain check must not fall through to
    // an occupant-list match that would always say false for every tile.
    tile.terrain = Terrain.Water;
    expect(tileMatchesKind(state, tile, TileKind.Water)).toBe(true);
    expect(tileMatchesKind(state, tile, TileKind.Land)).toBe(false);
  });
});
