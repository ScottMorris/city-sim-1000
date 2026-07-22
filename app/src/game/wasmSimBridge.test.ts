// wasmSimBridge.test.ts — bridge-level undo/redo behaviour against a fake Worker.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { WasmSimBridge } from './wasmSimBridge';
import { createInitialState } from './gameState';
import { applyToolCmd, nextStrokeId } from './protocol/commands';
import type { FromSim } from './protocol/events';
import type { SimStats } from '../workers/wasmSim.worker';
import { Tool } from './toolTypes';

/**
 * Minimal stand-in for the wasm Worker: records every posted message and lets
 * tests emit worker→main responses through the bridge's onmessage handler.
 */
class FakeWorker {
  sent: { type: string; payload?: Record<string, unknown> }[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror = null;
  postMessage(msg: { type: string; payload?: Record<string, unknown> }): void {
    this.sent.push(msg);
  }
  terminate(): void {}
  emit(msg: unknown): void {
    this.onmessage?.({ data: msg } as MessageEvent);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }
}

const flags = (canUndo: boolean, canRedo: boolean) => ({ canUndo, canRedo });

/** All-zero stats object — the bridge only assigns these onto the mirror. */
function zeroStats(): SimStats {
  const stats: Record<string, number> = {};
  for (const key of [
    'tick', 'day', 'money', 'population', 'jobs',
    'powerBalance', 'powerProduced', 'powerUsed',
    'waterBalance', 'waterProduced', 'waterUsed',
    'demandResidential', 'demandCommercial', 'demandIndustrial',
    'budgetNetPerDay', 'budgetNetPerMonth', 'budgetRevenue', 'budgetExpenses',
    'budgetRevenueBase', 'budgetRevenuePop', 'budgetRevenueCommercial',
    'budgetRevenueIndustrial', 'budgetExpensesTransport', 'budgetExpensesBuildings',
    'budgetMaintPower', 'budgetMaintCivic', 'budgetMaintZones', 'budgetMaintRoads',
    'budgetMaintRail', 'budgetMaintPowerLines', 'budgetMaintPipes',
    'budgetMaintPowerHydro', 'budgetMaintPowerCoal', 'budgetMaintPowerWind',
    'budgetMaintPowerSolar', 'budgetMaintCivicPark', 'budgetMaintCivicPump',
    'budgetMaintCivicTower', 'budgetMaintCivicSchool', 'budgetMaintZonesRes',
    'budgetMaintZonesCom', 'budgetMaintZonesInd', 'budgetRevenueTourism',
    'budgetExpensesPolicies', 'wildernessScore', 'wildernessTrend',
    'wildernessForests', 'wildernessParks', 'wildernessOpenLand',
    'wildernessWaterEdge', 'wildernessPatch', 'wildernessFragmentation',
    'wildernessZones', 'wildernessIndustry', 'wildernessTransport',
    'wildernessPower', 'wildernessCivic'
  ]) {
    stats[key] = 0;
  }
  return stats as unknown as SimStats;
}

function makeBridge() {
  const worker = new FakeWorker();
  const state = createInitialState(8, 8, 1);
  const events: FromSim[] = [];
  const bridge = new WasmSimBridge(state, { createWorker: () => worker as unknown as Worker });
  bridge.onMessage(msg => events.push(msg));
  worker.emit({ type: 'ready', history: flags(false, false) });
  worker.sent = []; // drop init/boot traffic; tests assert on what follows
  return { worker, state, bridge, events };
}

/** An 8×8 all-Land SoA tile buffer (kind 0 everywhere is TileKind.Land). */
const emptyTileBuffer = () => new Uint8Array(8 * 8 * 8);

describe('WasmSimBridge undo/redo', () => {
  it('threads strokeId through apply_tool worker messages', () => {
    const { worker, bridge } = makeBridge();
    const stroke = nextStrokeId();
    bridge.send(applyToolCmd(Tool.Road, 2, 3, stroke));
    expect(worker.sent).toHaveLength(1);
    expect(worker.sent[0].type).toBe('apply_tool');
    expect(worker.sent[0].payload).toMatchObject({ x: 2, y: 3, strokeId: stroke });
  });

  it('resolves undo with false when the worker reports nothing to undo', async () => {
    const { worker, bridge } = makeBridge();
    const pending = bridge.undo();
    worker.emit({ type: 'undo_result', happened: false, history: flags(false, false) });
    await expect(pending).resolves.toBe(false);
  });

  it('undo pops the whole stroke from the command log; redo restores it', async () => {
    const { worker, bridge } = makeBridge();
    const drag = nextStrokeId();
    bridge.send(applyToolCmd(Tool.Road, 1, 0, drag));
    bridge.send(applyToolCmd(Tool.Road, 2, 0, drag));
    bridge.send(applyToolCmd(Tool.Road, 3, 0, drag));
    expect(bridge.getCommandLog()).toHaveLength(3);

    const pendingUndo = bridge.undo();
    worker.emit({
      type: 'undo_result', happened: true,
      bytes: emptyTileBuffer(), stats: zeroStats(), history: flags(false, true)
    });
    await expect(pendingUndo).resolves.toBe(true);
    expect(bridge.getCommandLog()).toHaveLength(0);
    expect(bridge.canRedo()).toBe(true);

    const pendingRedo = bridge.redo();
    worker.emit({
      type: 'redo_result', happened: true,
      bytes: emptyTileBuffer(), stats: zeroStats(), history: flags(true, false)
    });
    await expect(pendingRedo).resolves.toBe(true);
    expect(bridge.getCommandLog()).toHaveLength(3);
    expect(bridge.canUndo()).toBe(true);
  });

  it('a new stroke clears the redo pile', async () => {
    const { worker, bridge } = makeBridge();
    bridge.send(applyToolCmd(Tool.Road, 1, 0, nextStrokeId()));
    const pending = bridge.undo();
    worker.emit({
      type: 'undo_result', happened: true,
      bytes: emptyTileBuffer(), stats: zeroStats(), history: flags(false, true)
    });
    await pending;
    bridge.send(applyToolCmd(Tool.Tree, 4, 4, nextStrokeId()));
    const pendingRedo = bridge.redo();
    worker.emit({ type: 'redo_result', happened: false, history: flags(true, false) });
    await expect(pendingRedo).resolves.toBe(false);
    // The undone road stroke must not resurface in the log.
    expect(bridge.getCommandLog()).toEqual([{ tool: Tool.Tree, x: 4, y: 4 }]);
  });

  it('emits HistoryChanged only on flag transitions', () => {
    const { worker, bridge, events } = makeBridge();
    const historyEvents = () => events.filter(e => e.type === 'HistoryChanged');
    const before = historyEvents().length;
    bridge.send(applyToolCmd(Tool.Road, 1, 0, nextStrokeId()));
    worker.emit({ type: 'apply_result', success: true, history: flags(true, false) });
    worker.emit({ type: 'apply_result', success: true, history: flags(true, false) });
    const after = historyEvents();
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]).toMatchObject({ data: { canUndo: true, canRedo: false } });
  });

  it('discards a pending step_result when an undo lands', async () => {
    const { worker, state, bridge } = makeBridge();
    const staleStats = { ...zeroStats(), money: 424242 };
    worker.emit({ type: 'step_result', bytes: emptyTileBuffer(), stats: staleStats });
    const pending = bridge.undo();
    const undoneStats = { ...zeroStats(), money: 1111 };
    worker.emit({
      type: 'undo_result', happened: true,
      bytes: emptyTileBuffer(), stats: undoneStats, history: flags(false, true)
    });
    await pending;
    // step() would normally apply the pending buffers — the stale pre-undo
    // step_result must be gone, leaving the undone stats in place.
    bridge.step(1 / 20);
    expect(state.money).toBe(1111);
  });
});
