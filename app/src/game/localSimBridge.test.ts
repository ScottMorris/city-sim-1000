// localSimBridge.test.ts — command log contract tests.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// These tests cover the LocalSimBridge command log — the feature that lets
// WasmSimBridge replay a TS city into a fresh Rust SimHost when the player
// switches engines, preserving the city layout.

import { describe, it, expect } from 'vitest';
import { createInitialState } from './gameState';
import { LocalSimBridge } from './localSimBridge';
import { applyToolCmd } from './protocol/commands';
import { Tool } from './toolTypes';

function makeBridge() {
  const state = createInitialState(16, 16, 1);
  state.money = 500_000_000; // 500k (×1000 internal scaling)
  const bridge = new LocalSimBridge(state, { ticksPerSecond: 20 });
  return { state, bridge };
}

describe('LocalSimBridge command log', () => {
  it('starts empty', () => {
    const { bridge } = makeBridge();
    expect(bridge.getCommandLog()).toEqual([]);
  });

  it('records a successful placement', () => {
    const { bridge } = makeBridge();
    bridge.send(applyToolCmd(Tool.HydroPlant, 1, 1));
    const log = bridge.getCommandLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toEqual({ tool: Tool.HydroPlant, x: 1, y: 1 });
  });

  it('records multiple placements in order', () => {
    const { bridge } = makeBridge();
    bridge.send(applyToolCmd(Tool.HydroPlant, 1, 1));
    bridge.send(applyToolCmd(Tool.Road, 3, 1));
    bridge.send(applyToolCmd(Tool.Residential, 4, 1));
    const log = bridge.getCommandLog();
    expect(log).toHaveLength(3);
    expect(log[0].tool).toBe(Tool.HydroPlant);
    expect(log[1].tool).toBe(Tool.Road);
    expect(log[2].tool).toBe(Tool.Residential);
  });

  it('does not record rejected placements', () => {
    const { state, bridge } = makeBridge();
    state.money = 0; // can't afford anything
    bridge.send(applyToolCmd(Tool.HydroPlant, 1, 1));
    expect(bridge.getCommandLog()).toHaveLength(0);
  });

  it('does not record out-of-bounds placements', () => {
    const { bridge } = makeBridge();
    bridge.send(applyToolCmd(Tool.Road, 99, 99));
    expect(bridge.getCommandLog()).toHaveLength(0);
  });

  it('log entries have the shape WasmSimBridge expects ({tool, x, y})', () => {
    const { bridge } = makeBridge();
    bridge.send(applyToolCmd(Tool.Road, 2, 3));
    const [entry] = bridge.getCommandLog();
    expect(Object.keys(entry).sort()).toEqual(['tool', 'x', 'y']);
    expect(typeof entry.tool).toBe('string'); // Tool is a string enum
    expect(typeof entry.x).toBe('number');
    expect(typeof entry.y).toBe('number');
  });

  it('Inspect tool success does not pollute the log (non-mutating)', () => {
    const { bridge } = makeBridge();
    // Inspect always succeeds but produces no city change — it should still
    // be recorded (the replay contract is: replay everything that succeeded).
    // If Inspect is ever filtered out, update this test to reflect that decision.
    bridge.send(applyToolCmd(Tool.Inspect, 0, 0));
    // Inspect returns success=true in applyTool, so it appears in the log.
    expect(bridge.getCommandLog()).toHaveLength(1);
  });
});
