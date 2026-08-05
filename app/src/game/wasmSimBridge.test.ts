// wasmSimBridge.test.ts — bridge-level undo/redo behaviour against a fake Worker.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { WasmSimBridge } from './wasmSimBridge';
import { createInitialState, TileKind } from './gameState';
import { applyToolCmd, nextStrokeId } from './protocol/commands';
import { tileKindToU8 } from './protocol/tileKind';
import { ServiceId } from './services';
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
  onerror: ((e: ErrorEvent) => void) | null = null;
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
    bridge.send(applyToolCmd(Tool.Road, 2, 3, stroke, 'surface'));
    expect(worker.sent).toHaveLength(1);
    expect(worker.sent[0].type).toBe('apply_tool');
    expect(worker.sent[0].payload).toMatchObject({ x: 2, y: 3, strokeId: stroke });
  });

  it('encodes the ViewStratum onto the apply_tool payload as a 0/1 discriminant', () => {
    // The only observable behaviour change in this PR: everything else is
    // pure plumbing (the engine still ignores stratum until PR 2's bulldoze()
    // implementation lands), but the wire encoding itself is worth pinning.
    const { worker, bridge } = makeBridge();
    const stroke = nextStrokeId();
    bridge.send(applyToolCmd(Tool.Bulldoze, 4, 5, stroke, 'underground'));
    expect(worker.sent).toHaveLength(1);
    expect(worker.sent[0].payload).toMatchObject({ x: 4, y: 5, strokeId: stroke, stratum: 1 });
  });

  it('resolves undo with false when the worker reports nothing to undo', async () => {
    const { worker, bridge } = makeBridge();
    const pending = bridge.undo();
    worker.emit({ type: 'undo_result', happened: false, history: flags(false, false) });
    await expect(pending).resolves.toBe(false);
  });

  it('undo/redo round-trip resolves true and tracks history flags', async () => {
    const { worker, bridge } = makeBridge();
    const drag = nextStrokeId();
    bridge.send(applyToolCmd(Tool.Road, 1, 0, drag, 'surface'));

    const pendingUndo = bridge.undo();
    worker.emit({
      type: 'undo_result', happened: true,
      bytes: emptyTileBuffer(), stats: zeroStats(), history: flags(false, true)
    });
    await expect(pendingUndo).resolves.toBe(true);
    expect(bridge.canUndo()).toBe(false);
    expect(bridge.canRedo()).toBe(true);

    const pendingRedo = bridge.redo();
    worker.emit({
      type: 'redo_result', happened: true,
      bytes: emptyTileBuffer(), stats: zeroStats(), history: flags(true, false)
    });
    await expect(pendingRedo).resolves.toBe(true);
    expect(bridge.canUndo()).toBe(true);
    expect(bridge.canRedo()).toBe(false);
  });

  it('getSnapshot resolves with the worker snapshot bytes', async () => {
    const { worker, bridge } = makeBridge();
    const pending = bridge.getSnapshot();
    await Promise.resolve(); // let the readyPromise chain post the message
    const sent = worker.sent.find(m => m.type === 'get_snapshot');
    expect(sent).toBeDefined();
    const requestId = (sent!.payload as { requestId: number }).requestId;
    const blob = new Uint8Array([1, 2, 3]);
    worker.emit({ type: 'snapshot_result', requestId, bytes: blob });
    await expect(pending).resolves.toBe(blob);
  });

  it('loadSnapshot refreshes the mirror (dimensions, policies) before resolving', async () => {
    const { worker, state, bridge } = makeBridge();
    const pending = bridge.loadSnapshot(new Uint8Array([9, 9]));
    await Promise.resolve(); // let the readyPromise chain post the message
    const sent = worker.sent.find(m => m.type === 'load_snapshot');
    expect(sent).toBeDefined();
    const requestId = (sent!.payload as { requestId: number }).requestId;
    const policies = {
      budget: {
        taxResidential: 14, taxCommercial: 9, taxIndustrial: 9,
        fundTransport: 100, fundPower: 100, fundCivic: 100
      },
      wilderness: { natureReserve: true, greenIndustry: false }
    };
    worker.emit({
      type: 'load_result', requestId, ok: true,
      width: 4, height: 4, seed: 77, policies,
      bytes: new Uint8Array(4 * 4 * 8), stats: { ...zeroStats(), money: 555 },
      history: flags(false, false)
    });
    await expect(pending).resolves.toBeUndefined();
    expect(state.width).toBe(4);
    expect(state.tiles).toHaveLength(16);
    expect(state.seed).toBe(77);
    expect(state.policies.budget.taxResidential).toBe(14);
    expect(state.money).toBe(555);
  });

  it('loadSnapshot rejects on an engine error, leaving the mirror untouched', async () => {
    const { worker, state, bridge } = makeBridge();
    const before = state.tiles.length;
    const pending = bridge.loadSnapshot(new Uint8Array([0]));
    await Promise.resolve();
    const sent = worker.sent.find(m => m.type === 'load_snapshot');
    const requestId = (sent!.payload as { requestId: number }).requestId;
    worker.emit({ type: 'load_result', requestId, ok: false, error: 'bad magic' });
    await expect(pending).rejects.toThrow('bad magic');
    expect(state.tiles).toHaveLength(before);
  });

  it('emits HistoryChanged only on flag transitions', () => {
    const { worker, bridge, events } = makeBridge();
    const historyEvents = () => events.filter(e => e.type === 'HistoryChanged');
    const before = historyEvents().length;
    bridge.send(applyToolCmd(Tool.Road, 1, 0, nextStrokeId(), 'surface'));
    worker.emit({ type: 'apply_result', success: true, message: null, history: flags(true, false) });
    worker.emit({ type: 'apply_result', success: true, message: null, history: flags(true, false) });
    const after = historyEvents();
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]).toMatchObject({ data: { canUndo: true, canRedo: false } });
  });

  it('discards a pending step_result when an undo lands', async () => {
    const { worker, state, bridge } = makeBridge();
    const staleStats = { ...zeroStats(), money: 424242 };
    worker.emit({ type: 'step_result', bytes: emptyTileBuffer(), stats: staleStats, alerts: [] });
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

  it('forwards a refused apply_result as a CommandResult with the message', () => {
    const { worker, bridge, events } = makeBridge();
    bridge.send(applyToolCmd(Tool.Road, 1, 0, nextStrokeId(), 'surface'));
    worker.emit({ type: 'apply_result', success: false, message: 'Not enough funds', history: flags(false, false) });

    const result = events.find(e => e.type === 'CommandResult');
    expect(result).toEqual({ type: 'CommandResult', success: false, message: 'Not enough funds' });
  });

  it('forwards each step_result alert as FromSim::Alert plus its paired narrative event, once step() flushes it', () => {
    const { worker, bridge, events } = makeBridge();
    worker.emit({
      type: 'step_result', bytes: emptyTileBuffer(), stats: zeroStats(), mutationSeq: 0,
      alerts: [{ kind: 'WaterDeficit', message: 'Water deficit detected.', sticky: true }],
    });
    // Alerts are staged like pendingStats/pendingTileBuffer, not dispatched
    // on arrival — see pendingAlerts' field doc for why (undo/redo/load must
    // be able to discard a stale one before it ever reaches the player).
    expect(events.find(e => e.type === 'Alert')).toBeUndefined();

    bridge.step(1 / 20);

    const alert = events.find(e => e.type === 'Alert');
    expect(alert).toMatchObject({
      type: 'Alert',
      data: { kind: 'WaterDeficit', message: 'Water deficit detected.', sticky: true },
    });

    const narrative = events.find(e => e.type === 'Narrative');
    expect(narrative).toMatchObject({
      type: 'Narrative',
      data: { kind: 'Alert', payload: { type: 'water_deficit_start', category: 'utilities', severity: 'alert' } },
    });
  });

  it('decodes powerComponentsJson/waterComponentsJson into state.utilities on step() flush', () => {
    const { worker, bridge, state } = makeBridge();
    worker.emit({
      type: 'step_result', bytes: emptyTileBuffer(), stats: zeroStats(), mutationSeq: 0, alerts: [],
      buildingsJson: '[]',
      powerComponentsJson: JSON.stringify([{ id: 1, produced: 60, used: 30, sourceCount: 1, utilisation: 0.5 }]),
      waterComponentsJson: '[]',
    });

    bridge.step(1 / 20);

    expect(state.utilities.powerComponents).toEqual([
      { id: 1, produced: 60, used: 30, sourceCount: 1, utilisation: 0.5 },
    ]);
    expect(state.utilities.waterComponents).toEqual([]);
  });

  it('decodes educationJson into state.education and educationSeatsUsedJson into a building\'s slotsUsed, on step() flush', () => {
    const { worker, bridge, state } = makeBridge();
    const educationStats = {
      elementaryServed: 12, elementaryCapacity: 180, elementaryLoad: 20,
      highServed: 0, highCapacity: 0, highLoad: 0,
      score: 0.6, elementaryCoverage: 0.6, highCoverage: 1,
    };
    worker.emit({
      type: 'step_result', bytes: emptyTileBuffer(), stats: zeroStats(), mutationSeq: 0, alerts: [],
      buildingsJson: JSON.stringify([{ id: 7, kind: tileKindToU8(TileKind.ElementarySchool), originX: 0, originY: 0 }]),
      powerComponentsJson: '[]', waterComponentsJson: '[]',
      educationJson: JSON.stringify(educationStats),
      educationSeatsUsedJson: JSON.stringify([{ buildingId: 7, used: 12 }]),
    });

    bridge.step(1 / 20);

    expect(state.education).toEqual(educationStats);
    expect(state.buildings[0].state.serviceLoad.slotsUsed[ServiceId.EducationElementary]).toBe(12);
  });

  it('discards a pending alert when an undo lands before step() flushes it', () => {
    const { worker, bridge, events } = makeBridge();
    worker.emit({
      type: 'step_result', bytes: emptyTileBuffer(), stats: zeroStats(), mutationSeq: 0,
      alerts: [{ kind: 'PowerDeficit', message: 'Power deficit detected.', sticky: true }],
    });

    const pending = bridge.undo();
    worker.emit({
      type: 'undo_result', happened: true,
      bytes: emptyTileBuffer(), stats: zeroStats(), history: flags(false, true)
    });

    return pending.then(() => {
      bridge.step(1 / 20);
      // The undo happened before the deficit-carrying step_result was ever
      // flushed — since the Rust engine resyncs its latch silently on
      // restore, no alert (deficit or restore) should surface for it.
      expect(events.find(e => e.type === 'Alert')).toBeUndefined();
    });
  });

  it('translates a worker init_error message into an InitError event', () => {
    const { worker, events } = makeBridge();
    worker.emit({ type: 'init_error', message: 'WASM instantiation failed' });
    const initErrors = events.filter(e => e.type === 'InitError');
    expect(initErrors).toHaveLength(1);
    expect(initErrors[0]).toMatchObject({ type: 'InitError', message: 'WASM instantiation failed' });
  });

  it('translates a worker onerror into an InitError event', () => {
    const { worker, events } = makeBridge();
    worker.onerror?.({ message: 'script error' } as ErrorEvent);
    const initErrors = events.filter(e => e.type === 'InitError');
    expect(initErrors).toHaveLength(1);
    expect(initErrors[0]).toMatchObject({ type: 'InitError', message: 'script error' });
  });

  it('falls back to a generic message when worker onerror has no message', () => {
    const { worker, events } = makeBridge();
    worker.onerror?.({ message: '' } as ErrorEvent);
    const initErrors = events.filter(e => e.type === 'InitError');
    expect(initErrors).toHaveLength(1);
    expect(initErrors[0]).toMatchObject({ type: 'InitError', message: 'Worker failed to start' });
  });

  it('reports InitError without Ready ever having arrived, matching a real boot failure', () => {
    // Unlike makeBridge(), this never emits 'ready' first — reproducing the
    // actual ordering a WASM instantiation failure produces on a real boot.
    const worker = new FakeWorker();
    const state = createInitialState(8, 8, 1);
    const events: FromSim[] = [];
    new WasmSimBridge(state, { createWorker: () => worker as unknown as Worker }).onMessage(msg => events.push(msg));
    worker.emit({ type: 'init_error', message: 'WASM instantiation failed' });
    expect(events).toEqual([{ type: 'InitError', message: 'WASM instantiation failed' }]);
  });
});
