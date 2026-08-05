// tauriSimBridge.test.ts — bridge-level tick decode and command routing against a fake plugin.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { createInitialState, TileKind } from './gameState';
import { applyToolCmd, nextStrokeId } from './protocol/commands';
import { Occupant, Terrain, ZoneDensity } from './protocol/occupants';
import { BYTES_PER_TILE, STATUS, encodeHappiness, tileBufferOffsets } from './protocol/tileBuffer';
import { tileKindToU8 } from './protocol/tileKind';
import type { FromSim } from './protocol/events';
import { Tool } from './toolTypes';
import { TauriSimBridge, type TauriPluginBindings } from './tauriSimBridge';

// `tauri-plugin-city-sim`'s real bindings go through `@tauri-apps/api`'s
// `invoke`/`Channel`, unusable outside a Tauri shell (and require its
// `dist-js/` to be built, which CI's test job doesn't do) — so this file
// never imports that package at all. It injects a fake `TauriPluginBindings`
// through the same constructor seam `WasmSimBridgeConfig.createWorker` uses
// for the sibling bridge, instead of `vi.mock`-ing the module specifier
// (which would force Vite to resolve the real package regardless of the
// mock). `TOOL_ID` and the tick-payload shapes below are local mirrors of the
// real ones, not re-exports.
const TOOL_ID = {
  Inspect: 0, TerraformRaise: 1, TerraformLower: 2, Water: 3, Tree: 4,
  Road: 5, Rail: 6, PowerLine: 7, HydroPlant: 8, CoalPlant: 9,
  WindTurbine: 10, SolarFarm: 11, WaterPump: 12, WaterTower: 13,
  WaterPipe: 14, ElementarySchool: 15, HighSchool: 16, Residential: 17,
  Commercial: 18, Industrial: 19, Park: 20, Bulldoze: 21, ParkLarge: 22
} as const;

// Local mirror of `VIEW_STRATUM_ID` from `tauri-plugin-city-sim`'s guest-js,
// for the same reason `TOOL_ID` is mirrored above rather than imported.
const VIEW_STRATUM_ID = { Surface: 0, Underground: 1 } as const;

interface WireBuilding {
  id: number;
  kind: number;
  originX: number;
  originY: number;
}

interface WireUtilityComponent {
  id: number;
  produced: number;
  used: number;
  sourceCount: number;
  utilisation: number;
}

interface SimAlert {
  kind: 'PowerDeficit' | 'PowerRestored' | 'WaterDeficit' | 'WaterRestored' | 'BudgetWarning' | 'Abandonment' | 'Info';
  message: string;
  sticky: boolean;
}

interface TickEvent {
  tick: number; day: number; population: number; jobs: number; money: number;
  power: number; water: number; powerProduced: number; waterProduced: number;
  powerComponents: WireUtilityComponent[]; waterComponents: WireUtilityComponent[];
  demandResidential: number; demandCommercial: number; demandIndustrial: number;
  wildernessScore: number; wildernessTrend: number;
  width: number; height: number;
  tiles: number[];
  buildings: WireBuilding[];
  canUndo: boolean; canRedo: boolean;
  alerts: SimAlert[];
}

const GRID_TILES = 8 * 8;

function baseTickEvent(overrides: Partial<TickEvent> = {}): TickEvent {
  return {
    tick: 0, day: 0, population: 0, jobs: 0, money: 0,
    power: 0, water: 0, powerProduced: 0, waterProduced: 0,
    powerComponents: [], waterComponents: [],
    demandResidential: 0, demandCommercial: 0, demandIndustrial: 0,
    wildernessScore: 0, wildernessTrend: 0,
    width: 8, height: 8,
    tiles: new Array(GRID_TILES * BYTES_PER_TILE).fill(0),
    buildings: [],
    canUndo: false, canRedo: false,
    alerts: [],
    ...overrides
  };
}

function makeFakePlugin(): TauriPluginBindings {
  return {
    start: vi.fn(),
    applyTool: vi.fn().mockResolvedValue({ success: true, message: null }),
    setSpeed: vi.fn(),
    setPolicies: vi.fn(),
    setNaturalTerrain: vi.fn(),
    stop: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    getSnapshot: vi.fn(),
    loadSnapshot: vi.fn(),
    importLegacy: vi.fn()
  };
}

/** Constructs the bridge and flushes the async startPlugin/seedEngine/Ready chain. */
async function makeBridge(width = 8, height = 8, seed = 1) {
  const plugin = makeFakePlugin();

  let onTick: ((event: TickEvent) => void) | undefined;
  vi.mocked(plugin.start).mockImplementation(async (_w, _h, _s, cb) => {
    onTick = cb as (event: TickEvent) => void;
  });

  const state = createInitialState(width, height, seed);
  const events: FromSim[] = [];
  const bridge = new TauriSimBridge(state, { plugin });
  bridge.onMessage((msg) => events.push(msg));
  // Let the constructor's startPlugin()/seedEngine()/Ready chain resolve.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  return { bridge, events, plugin, emit: (event: TickEvent) => onTick!(event) };
}

describe('TauriSimBridge command routing', () => {
  it('maps every Tool to its TOOL_ID discriminant when sending ApplyTool', async () => {
    const { bridge, plugin } = await makeBridge();
    for (const tool of Object.values(Tool)) {
      vi.mocked(plugin.applyTool).mockClear();
      const stroke = nextStrokeId();
      bridge.send(applyToolCmd(tool, 3, 4, stroke, 'surface'));
      expect(plugin.applyTool).toHaveBeenCalledWith(TOOL_ID[toolIdKey(tool)], 3, 4, stroke, VIEW_STRATUM_ID.Surface);
    }
  });

  it('maps an \'underground\' stratum to VIEW_STRATUM_ID.Underground when sending ApplyTool', async () => {
    const { bridge, plugin } = await makeBridge();
    const stroke = nextStrokeId();
    bridge.send(applyToolCmd(Tool.Bulldoze, 3, 4, stroke, 'underground'));
    expect(plugin.applyTool).toHaveBeenCalledWith(
      TOOL_ID.Bulldoze,
      3,
      4,
      stroke,
      VIEW_STRATUM_ID.Underground
    );
  });

  it('delegates SetSpeed and SetPolicies to the plugin', async () => {
    const { bridge, plugin } = await makeBridge();
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
    const { bridge, plugin } = await makeBridge();

    vi.mocked(plugin.undo).mockResolvedValueOnce(true);
    await expect(bridge.undo()).resolves.toBe(true);

    vi.mocked(plugin.redo).mockResolvedValueOnce(false);
    await expect(bridge.redo()).resolves.toBe(false);

    const blob = new Uint8Array([1, 2, 3]);
    vi.mocked(plugin.getSnapshot).mockResolvedValueOnce(blob);
    await expect(bridge.getSnapshot()).resolves.toBe(blob);

    vi.mocked(plugin.loadSnapshot).mockResolvedValueOnce(undefined);
    await bridge.loadSnapshot(new Uint8Array([9]));
    expect(plugin.loadSnapshot).toHaveBeenCalledWith(new Uint8Array([9]));

    bridge.dispose();
    expect(plugin.stop).toHaveBeenCalled();
  });

  it('forwards a refused ApplyTool\'s message as a CommandResult once the plugin resolves', async () => {
    const { bridge, plugin, events } = await makeBridge();
    vi.mocked(plugin.applyTool).mockResolvedValueOnce({ success: false, message: 'Not enough funds' });

    bridge.send(applyToolCmd(Tool.Road, 3, 4, nextStrokeId(), 'surface'));
    // send() itself must still answer synchronously and optimistically —
    // the real result arrives later, over the resolved promise.
    await Promise.resolve();
    await Promise.resolve();

    const result = events.find((e) => e.type === 'CommandResult');
    expect(result).toEqual({ type: 'CommandResult', success: false, message: 'Not enough funds' });
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

  it('decodes every field from its SoA wire offset, matching the WASM path exactly', async () => {
    const { bridge, emit } = await makeBridge();
    const n = GRID_TILES;
    const o = tileBufferOffsets(n);
    const tiles = new Array(n * BYTES_PER_TILE).fill(0);
    const targetIndex = 5;
    tiles[o.underground + targetIndex] = 1 << Occupant.Pipe; // underground: absolute bits, no shift
    tiles[o.surface + targetIndex] = 1 << (Occupant.Road - 3); // surface byte is Occupant bits rebased by -3
    tiles[o.overhead + targetIndex] = 1 << (Occupant.PowerLine - 9); // overhead byte rebased by -9
    tiles[o.status + targetIndex] =
      STATUS.POWERED | STATUS.WATERED | STATUS.WATER_TERRAIN | (ZoneDensity.High << STATUS.DENSITY_SHIFT);
    tiles[o.happiness + targetIndex] = encodeHappiness(1.5);
    tiles[o.elevation + targetIndex] = 200;
    const bidBase = o.buildingId + targetIndex * 2;
    tiles[bidBase] = 42 & 0xff;
    tiles[bidBase + 1] = (42 >> 8) & 0xff;
    tiles[o.wilderness + targetIndex] = 64;

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
    expect(tile.happiness).toBeCloseTo(1.5, 1);
    expect(tile.elevation).toBe(200);
    expect(tile.buildingId).toBe(42);
    expect(tile.wilderness).toBeCloseTo(64 / 255, 5);
  });

  it('decodes buildingId directly from the wire, independent of event.buildings, and clears it when the wire says none', async () => {
    const { bridge, emit } = await makeBridge();
    const n = GRID_TILES;
    const o = tileBufferOffsets(n);
    const coalPlant: WireBuilding = { id: 7, kind: tileKindToU8(TileKind.CoalPlant), originX: 0, originY: 0 };

    // CoalPlant's real 2x2 footprint, written straight onto the wire — no TS
    // template footprint is consulted for tile coverage any more.
    const tiles = new Array(n * BYTES_PER_TILE).fill(0);
    for (const idx of [0, 1, 8, 9]) {
      const base = o.buildingId + idx * 2;
      tiles[base] = 7;
      tiles[base + 1] = 0;
    }
    emit(baseTickEvent({ tiles, buildings: [coalPlant] }));
    const s1 = bridge.getState();
    expect(s1.tiles[0].buildingId).toBe(7);
    expect(s1.tiles[1].buildingId).toBe(7);
    expect(s1.tiles[8].buildingId).toBe(7);
    expect(s1.tiles[9].buildingId).toBe(7);
    expect(s1.buildings).toHaveLength(1);
    expect(s1.buildings[0]).toMatchObject({ id: 7, templateId: TileKind.CoalPlant, origin: { x: 0, y: 0 } });

    // Razed: the next TickEvent's wire carries building_id 0 everywhere, and no buildings.
    emit(baseTickEvent({ buildings: [] }));
    const s2 = bridge.getState();
    expect(s2.tiles[0].buildingId).toBeUndefined();
    expect(s2.tiles[1].buildingId).toBeUndefined();
    expect(s2.tiles[8].buildingId).toBeUndefined();
    expect(s2.tiles[9].buildingId).toBeUndefined();
    expect(s2.buildings).toHaveLength(0);
  });

  it('marks a power-requiring building InactiveNoPower until its origin tile reads powered', async () => {
    const { bridge, emit } = await makeBridge();
    // WaterTower, not WaterPump: it requires power like a pump, but (unlike
    // a pump) doesn't need its footprint to touch water terrain, so this
    // stays a pure power-gating test rather than tripping the #200 source
    // gate covered separately below.
    const tower: WireBuilding = { id: 1, kind: tileKindToU8(TileKind.WaterTower), originX: 2, originY: 2 };
    const o = tileBufferOffsets(GRID_TILES);
    const originIndex = 2 * 8 + 2;

    emit(baseTickEvent({ buildings: [tower] }));
    expect(bridge.getState().buildings[0].state.status).toBe('inactive_no_power');

    const tiles = new Array(GRID_TILES * BYTES_PER_TILE).fill(0);
    tiles[o.status + originIndex] = STATUS.POWERED;
    emit(baseTickEvent({ tiles, buildings: [tower] }));
    expect(bridge.getState().buildings[0].state.status).toBe('active');
  });

  it('marks a water pump InactiveNoSource until its footprint touches water terrain', async () => {
    const { bridge, emit } = await makeBridge();
    const pump: WireBuilding = { id: 3, kind: tileKindToU8(TileKind.WaterPump), originX: 2, originY: 2 };
    const o = tileBufferOffsets(GRID_TILES);
    const originIndex = 2 * 8 + 2;
    const neighbourIndex = 2 * 8 + 3; // (3,2), orthogonally east of the pump

    const tiles = new Array(GRID_TILES * BYTES_PER_TILE).fill(0);
    tiles[o.status + originIndex] = STATUS.POWERED;

    // Powered, but nowhere near water: no source to draw from.
    emit(baseTickEvent({ tiles, buildings: [pump] }));
    expect(bridge.getState().buildings[0].state.status).toBe('inactive_no_source');

    // A water-terrain neighbour appears: the pump comes online.
    const tilesWithWater = tiles.slice();
    tilesWithWater[o.status + neighbourIndex] = STATUS.WATER_TERRAIN;
    emit(baseTickEvent({ tiles: tilesWithWater, buildings: [pump] }));
    expect(bridge.getState().buildings[0].state.status).toBe('active');
  });

  it('marks a water-consuming building InactiveNoWater only once a water system exists and it is unwatered', async () => {
    const { bridge, emit } = await makeBridge();
    const house: WireBuilding = { id: 2, kind: tileKindToU8(TileKind.Residential), originX: 5, originY: 5 };
    const o = tileBufferOffsets(GRID_TILES);
    const originIndex = 5 * 8 + 5;
    const tiles = new Array(GRID_TILES * BYTES_PER_TILE).fill(0);
    tiles[o.status + originIndex] = STATUS.POWERED; // powered, but not watered

    // No water system yet (no pump/tower building, no buried pipe) — water need is not evaluated.
    emit(baseTickEvent({ tiles, buildings: [house] }));
    expect(bridge.getState().buildings[0].state.status).toBe('active');

    // A buried pipe brings the water system online; the same unwatered tile now reads InactiveNoWater.
    const tilesWithPipe = tiles.slice();
    tilesWithPipe[o.underground] = 1 << Occupant.Pipe;
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

  it('forwards each alert as FromSim::Alert plus its paired narrative event', async () => {
    const { emit, events } = await makeBridge();
    emit(baseTickEvent({
      alerts: [{ kind: 'PowerDeficit', message: 'Power deficit detected.', sticky: true }],
    }));

    const alert = events.find((e) => e.type === 'Alert');
    expect(alert).toMatchObject({
      type: 'Alert',
      data: { kind: 'PowerDeficit', message: 'Power deficit detected.', sticky: true },
    });

    const narrative = events.find((e) => e.type === 'Narrative');
    expect(narrative).toMatchObject({
      type: 'Narrative',
      data: { kind: 'Alert', payload: { type: 'power_deficit_start', category: 'utilities', severity: 'alert' } },
    });
  });

  it('emits Ready once the plugin has started and the engine is seeded', async () => {
    const { events, plugin } = await makeBridge();
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
