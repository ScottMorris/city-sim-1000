// tauriSimBridge.test.ts — bridge-level tick decode and command routing against a fake plugin.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { createInitialState, TileKind } from './gameState';
import { applyToolCmd, nextStrokeId } from './protocol/commands';
import { Occupant, Terrain, ZoneDensity } from './protocol/occupants';
import { STATUS } from './protocol/tileBuffer';
import { tileKindToU8 } from './protocol/tileKind';
import type { FromSim } from './protocol/events';
import { Tool } from './toolTypes';
import { TauriSimBridge } from './tauriSimBridge';
import { TOOL_ID, type TickEvent, type WireBuilding } from 'tauri-plugin-city-sim';

const plugin = vi.hoisted(() => ({
  start: vi.fn(),
  applyTool: vi.fn(),
  setSpeed: vi.fn(),
  setPolicies: vi.fn(),
  setNaturalTerrain: vi.fn(),
  stop: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  getSnapshot: vi.fn(),
  loadSnapshot: vi.fn(),
  importLegacy: vi.fn()
}));

vi.mock('tauri-plugin-city-sim', () => ({
  start: plugin.start,
  applyTool: plugin.applyTool,
  setSpeed: plugin.setSpeed,
  setPolicies: plugin.setPolicies,
  setNaturalTerrain: plugin.setNaturalTerrain,
  stop: plugin.stop,
  undo: plugin.undo,
  redo: plugin.redo,
  getSnapshot: plugin.getSnapshot,
  loadSnapshot: plugin.loadSnapshot,
  importLegacy: plugin.importLegacy,
  TOOL_ID: {
    Inspect: 0, TerraformRaise: 1, TerraformLower: 2, Water: 3, Tree: 4,
    Road: 5, Rail: 6, PowerLine: 7, HydroPlant: 8, CoalPlant: 9,
    WindTurbine: 10, SolarFarm: 11, WaterPump: 12, WaterTower: 13,
    WaterPipe: 14, ElementarySchool: 15, HighSchool: 16, Residential: 17,
    Commercial: 18, Industrial: 19, Park: 20, Bulldoze: 21, ParkLarge: 22
  }
}));

function baseTickEvent(overrides: Partial<TickEvent> = {}): TickEvent {
  return {
    tick: 0, day: 0, population: 0, jobs: 0, money: 0,
    power: 0, water: 0, powerProduced: 0, waterProduced: 0,
    demandResidential: 0, demandCommercial: 0, demandIndustrial: 0,
    wildernessScore: 0, wildernessTrend: 0,
    width: 8, height: 8,
    tiles: new Array(8 * 8 * 4).fill(0),
    buildings: [],
    canUndo: false, canRedo: false,
    ...overrides
  };
}

/** Constructs the bridge and flushes the async startPlugin/seedEngine/Ready chain. */
async function makeBridge(width = 8, height = 8, seed = 1) {
  for (const fn of Object.values(plugin)) fn.mockClear();

  let onTick: ((event: TickEvent) => void) | undefined;
  plugin.start.mockImplementation(async (_w: number, _h: number, _s: number, cb: (event: TickEvent) => void) => {
    onTick = cb;
  });

  const state = createInitialState(width, height, seed);
  const events: FromSim[] = [];
  const bridge = new TauriSimBridge(state);
  bridge.onMessage((msg) => events.push(msg));
  // Let the constructor's startPlugin()/seedEngine()/Ready chain resolve.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  return { bridge, events, emit: (event: TickEvent) => onTick!(event) };
}

describe('TauriSimBridge command routing', () => {
  it('maps every Tool to its TOOL_ID discriminant when sending ApplyTool', async () => {
    const { bridge } = await makeBridge();
    for (const tool of Object.values(Tool)) {
      plugin.applyTool.mockClear();
      const stroke = nextStrokeId();
      bridge.send(applyToolCmd(tool, 3, 4, stroke));
      expect(plugin.applyTool).toHaveBeenCalledWith(TOOL_ID[toolIdKey(tool)], 3, 4, stroke);
    }
  });

  it('delegates SetSpeed and SetPolicies to the plugin', async () => {
    const { bridge } = await makeBridge();
    bridge.send({ type: 'SetSpeed', multiplier: 2 });
    expect(plugin.setSpeed).toHaveBeenCalledWith(2);

    const policies = {
      budget: {
        taxResidential: 10, taxCommercial: 10, taxIndustrial: 10,
        fundTransport: 100, fundPower: 100, fundCivic: 100
      },
      wilderness: { natureReserve: false, greenIndustry: false }
    };
    bridge.send({ type: 'SetPolicies', policies });
    expect(plugin.setPolicies).toHaveBeenCalledWith(policies);
    expect(bridge.getState().policies).toBe(policies);
  });

  it('delegates undo/redo/getSnapshot/loadSnapshot/importLegacy/dispose to the plugin', async () => {
    const { bridge } = await makeBridge();

    plugin.undo.mockResolvedValueOnce(true);
    await expect(bridge.undo()).resolves.toBe(true);

    plugin.redo.mockResolvedValueOnce(false);
    await expect(bridge.redo()).resolves.toBe(false);

    const blob = new Uint8Array([1, 2, 3]);
    plugin.getSnapshot.mockResolvedValueOnce(blob);
    await expect(bridge.getSnapshot()).resolves.toBe(blob);

    plugin.loadSnapshot.mockResolvedValueOnce(undefined);
    await bridge.loadSnapshot(new Uint8Array([9]));
    expect(plugin.loadSnapshot).toHaveBeenCalledWith(new Uint8Array([9]));

    bridge.dispose();
    expect(plugin.stop).toHaveBeenCalled();
  });
});

describe('TauriSimBridge onTick decode', () => {
  it('copies stats, derives used from produced/balance, and copies demand and wilderness', async () => {
    const { bridge, emit } = await makeBridge();
    emit(baseTickEvent({
      tick: 42, day: 3, population: 100, jobs: 50, money: 5000,
      power: 20, water: -5, powerProduced: 80, waterProduced: 15,
      demandResidential: 60, demandCommercial: 40, demandIndustrial: 10,
      wildernessScore: 33, wildernessTrend: -1.5
    }));

    const s = bridge.getState();
    expect(s.tick).toBe(42);
    expect(s.day).toBe(3);
    expect(s.population).toBe(100);
    expect(s.jobs).toBe(50);
    expect(s.money).toBe(5000);
    expect(s.utilities.power).toBe(20);
    expect(s.utilities.water).toBe(-5);
    expect(s.utilities.powerProduced).toBe(80);
    expect(s.utilities.waterProduced).toBe(15);
    // consumed = produced - balance
    expect(s.utilities.powerUsed).toBe(60);
    expect(s.utilities.waterUsed).toBe(20);
    expect(s.demand.residential).toBe(60);
    expect(s.demand.commercial).toBe(40);
    expect(s.demand.industrial).toBe(10);
    expect(s.wilderness.score).toBe(33);
    expect(s.wilderness.trend).toBe(-1.5);
  });

  it('decodes each tile stratum from its wire byte at the documented shift', async () => {
    const { bridge, emit } = await makeBridge();
    const tiles = new Array(8 * 8 * 4).fill(0);
    const targetIndex = 5;
    const base = targetIndex * 4;
    tiles[base] = 1 << Occupant.Pipe; // underground: absolute bits, no shift
    tiles[base + 1] = 1 << (Occupant.Road - 3); // surface byte is Occupant bits rebased by -3
    tiles[base + 2] = 1 << (Occupant.PowerLine - 9); // overhead byte rebased by -9
    tiles[base + 3] =
      STATUS.POWERED | STATUS.WATERED | STATUS.WATER_TERRAIN | (ZoneDensity.High << STATUS.DENSITY_SHIFT);

    emit(baseTickEvent({ tiles }));

    const tile = bridge.getState().tiles[targetIndex];
    expect(tile.underground).toBe(1 << Occupant.Pipe);
    expect(tile.surface).toBe(1 << Occupant.Road);
    expect(tile.overhead).toBe(1 << Occupant.PowerLine);
    expect(tile.terrain).toBe(Terrain.Water);
    expect(tile.powered).toBe(true);
    expect(tile.watered).toBe(true);
    expect(tile.abandoned).toBe(false);
    expect(tile.density).toBe(ZoneDensity.High);
  });

  it('paints buildingId across a multi-tile footprint from event.buildings, and clears a razed building on the next tick', async () => {
    const { bridge, emit } = await makeBridge();
    const coalPlant: WireBuilding = { id: 7, kind: tileKindToU8(TileKind.CoalPlant), originX: 0, originY: 0 };

    emit(baseTickEvent({ buildings: [coalPlant] }));
    const s1 = bridge.getState();
    // CoalPlant's footprint is 2x2 — every covered tile must carry the id.
    expect(s1.tiles[0 * 8 + 0].buildingId).toBe(7);
    expect(s1.tiles[0 * 8 + 1].buildingId).toBe(7);
    expect(s1.tiles[1 * 8 + 0].buildingId).toBe(7);
    expect(s1.tiles[1 * 8 + 1].buildingId).toBe(7);
    expect(s1.buildings).toHaveLength(1);
    expect(s1.buildings[0]).toMatchObject({ id: 7, templateId: TileKind.CoalPlant, origin: { x: 0, y: 0 } });

    // Razed: the next TickEvent carries no buildings at all.
    emit(baseTickEvent({ buildings: [] }));
    const s2 = bridge.getState();
    expect(s2.tiles[0 * 8 + 0].buildingId).toBeUndefined();
    expect(s2.tiles[0 * 8 + 1].buildingId).toBeUndefined();
    expect(s2.tiles[1 * 8 + 0].buildingId).toBeUndefined();
    expect(s2.tiles[1 * 8 + 1].buildingId).toBeUndefined();
    expect(s2.buildings).toHaveLength(0);
  });

  it('marks a power-requiring building InactiveNoPower until its origin tile reads powered', async () => {
    const { bridge, emit } = await makeBridge();
    const pump: WireBuilding = { id: 1, kind: tileKindToU8(TileKind.WaterPump), originX: 2, originY: 2 };

    emit(baseTickEvent({ buildings: [pump] }));
    expect(bridge.getState().buildings[0].state.status).toBe('inactive_no_power');

    const tiles = new Array(8 * 8 * 4).fill(0);
    tiles[(2 * 8 + 2) * 4 + 3] = STATUS.POWERED;
    emit(baseTickEvent({ tiles, buildings: [pump] }));
    expect(bridge.getState().buildings[0].state.status).toBe('active');
  });

  it('marks a water-consuming building InactiveNoWater only once a water system exists and it is unwatered', async () => {
    const { bridge, emit } = await makeBridge();
    const house: WireBuilding = { id: 2, kind: tileKindToU8(TileKind.Residential), originX: 5, originY: 5 };
    const tiles = new Array(8 * 8 * 4).fill(0);
    tiles[(5 * 8 + 5) * 4 + 3] = STATUS.POWERED; // powered, but not watered

    // No water system yet (no pump/tower building, no buried pipe) — water need is not evaluated.
    emit(baseTickEvent({ tiles, buildings: [house] }));
    expect(bridge.getState().buildings[0].state.status).toBe('active');

    // A buried pipe brings the water system online; the same unwatered tile now reads InactiveNoWater.
    const tilesWithPipe = tiles.slice();
    tilesWithPipe[(0 * 8 + 0) * 4] = 1 << Occupant.Pipe;
    emit(baseTickEvent({ tiles: tilesWithPipe, buildings: [house] }));
    expect(bridge.getState().buildings[0].state.status).toBe('inactive_no_water');
  });

  it('emits HistoryChanged only on undo/redo flag transitions', async () => {
    const { emit, events } = await makeBridge();
    const historyEvents = () => events.filter((e) => e.type === 'HistoryChanged');
    const before = historyEvents().length;

    emit(baseTickEvent({ canUndo: true, canRedo: false }));
    emit(baseTickEvent({ canUndo: true, canRedo: false })); // same flags — no second event

    const after = historyEvents();
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]).toMatchObject({ data: { canUndo: true, canRedo: false } });
  });

  it('emits Ready once the plugin has started and the engine is seeded', async () => {
    const { events } = await makeBridge();
    expect(events.filter((e) => e.type === 'Ready')).toHaveLength(1);
    expect(plugin.setNaturalTerrain).toHaveBeenCalledTimes(1);
    expect(plugin.setPolicies).toHaveBeenCalledTimes(1);
  });
});

/** `Tool` string enum value → the matching `TOOL_ID` key (same name, different casing scheme). */
function toolIdKey(tool: Tool): keyof typeof TOOL_ID {
  const map: Record<Tool, keyof typeof TOOL_ID> = {
    [Tool.Inspect]: 'Inspect',
    [Tool.TerraformRaise]: 'TerraformRaise',
    [Tool.TerraformLower]: 'TerraformLower',
    [Tool.Water]: 'Water',
    [Tool.Tree]: 'Tree',
    [Tool.Road]: 'Road',
    [Tool.Rail]: 'Rail',
    [Tool.PowerLine]: 'PowerLine',
    [Tool.HydroPlant]: 'HydroPlant',
    [Tool.CoalPlant]: 'CoalPlant',
    [Tool.WindTurbine]: 'WindTurbine',
    [Tool.SolarFarm]: 'SolarFarm',
    [Tool.WaterPump]: 'WaterPump',
    [Tool.WaterTower]: 'WaterTower',
    [Tool.WaterPipe]: 'WaterPipe',
    [Tool.ElementarySchool]: 'ElementarySchool',
    [Tool.HighSchool]: 'HighSchool',
    [Tool.Residential]: 'Residential',
    [Tool.Commercial]: 'Commercial',
    [Tool.Industrial]: 'Industrial',
    [Tool.Park]: 'Park',
    [Tool.Bulldoze]: 'Bulldoze',
    [Tool.ParkLarge]: 'ParkLarge'
  };
  return map[tool];
}
