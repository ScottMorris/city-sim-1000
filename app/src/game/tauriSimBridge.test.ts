// tauriSimBridge.test.ts — bridge-level tick decode and command routing against a fake plugin.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { createInitialState } from './gameState';
import { applyToolCmd, nextStrokeId } from './protocol/commands';
import { Occupant, Terrain, ZoneDensity } from './protocol/occupants';
import { BYTES_PER_TILE, STATUS, decodeEco, encodeHappiness, tileBufferOffsets } from './protocol/tileBuffer';
import { buildingKindToU8 } from './protocol/buildingKind';
import { BuildingKind } from './buildings/templates';
import { ServiceId } from './services';
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
  status: number;
  health: number;
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

interface WireEducationStats {
  elementaryServed: number; elementaryCapacity: number; elementaryLoad: number;
  highServed: number; highCapacity: number; highLoad: number;
  score: number; elementaryCoverage: number; highCoverage: number;
}

interface WireEducationSeatsUsed {
  buildingId: number;
  used: number;
}

interface WireBudgetHistoryEntry {
  day: number;
  revenue: number;
  expenses: number;
  net: number;
}

// Mirrors `WireBudgetStats` (`city_sim_protocol::wire_types`) — every field
// `TickEvent.budget` carries. Zero everywhere is a legal (if uninteresting)
// budget snapshot, so `baseTickEvent`'s default below is exactly this.
interface WireBudgetStats {
  revenue: number; expenses: number; net: number; netPerDay: number; netPerMonth: number;
  revenueBase: number; revenuePop: number; revenueCommercial: number; revenueIndustrial: number; revenueTourism: number;
  expensesTransport: number; expensesBuildings: number; expensesPolicies: number;
  maintPower: number; maintCivic: number; maintZones: number;
  maintRoads: number; maintRail: number; maintPowerLines: number; maintPipes: number;
  maintPowerHydro: number; maintPowerCoal: number; maintPowerWind: number; maintPowerSolar: number;
  maintCivicPark: number; maintCivicPump: number; maintCivicTower: number; maintCivicSchool: number;
  maintZonesRes: number; maintZonesCom: number; maintZonesInd: number;
}

// Mirrors `WireWildernessBreakdown`.
interface WireWildernessBreakdown {
  forests: number; parks: number; openLand: number; waterEdge: number; patch: number;
  fragmentation: number; zones: number; industry: number; transport: number; power: number; civic: number;
}

// Mirrors `WireLabourStats`.
interface WireLabourStats {
  population: number; resCapacity: number; jobCapacity: number;
  workers: number; employed: number; unemployed: number;
  unemploymentRate: number; vacancyRate: number;
}

// Mirrors `WireDemandClassBreakdown`/`WireDemandBreakdown`.
interface WireDemandClassBreakdown {
  base: number; fillFraction: number; fillTerm: number; workforceTerm: number; labourTerm: number;
  pendingZones: number; pendingPenaltyRaw: number; pendingPenaltyCapped: number; pendingPenaltyApplied: number;
  pressureRelief: number; utilityPenalty: number; demandBeforeUtilities: number;
  floorApplied: boolean; seeded: boolean; value: number;
}
interface WireDemandBreakdown {
  residential: WireDemandClassBreakdown;
  commercial: WireDemandClassBreakdown;
  industrial: WireDemandClassBreakdown;
}

interface TickEvent {
  tick: number; day: number; population: number; jobs: number; money: number;
  power: number; water: number; powerProduced: number; waterProduced: number;
  powerUsed: number; waterUsed: number;
  budget: WireBudgetStats;
  wildernessBreakdown: WireWildernessBreakdown;
  powerComponents: WireUtilityComponent[]; waterComponents: WireUtilityComponent[];
  education: WireEducationStats; educationSeatsUsed: WireEducationSeatsUsed[];
  budgetHistory: WireBudgetHistoryEntry[];
  demandResidential: number; demandCommercial: number; demandIndustrial: number;
  demandBreakdown: WireDemandBreakdown;
  labour: WireLabourStats;
  abandonedCount: number; avgHappiness: number;
  wildernessScore: number; wildernessTrend: number;
  width: number; height: number;
  tiles: number[];
  buildings: WireBuilding[];
  canUndo: boolean; canRedo: boolean;
  alerts: SimAlert[];
}

const GRID_TILES = 8 * 8;

const ZERO_BUDGET: WireBudgetStats = {
  revenue: 0, expenses: 0, net: 0, netPerDay: 0, netPerMonth: 0,
  revenueBase: 0, revenuePop: 0, revenueCommercial: 0, revenueIndustrial: 0, revenueTourism: 0,
  expensesTransport: 0, expensesBuildings: 0, expensesPolicies: 0,
  maintPower: 0, maintCivic: 0, maintZones: 0,
  maintRoads: 0, maintRail: 0, maintPowerLines: 0, maintPipes: 0,
  maintPowerHydro: 0, maintPowerCoal: 0, maintPowerWind: 0, maintPowerSolar: 0,
  maintCivicPark: 0, maintCivicPump: 0, maintCivicTower: 0, maintCivicSchool: 0,
  maintZonesRes: 0, maintZonesCom: 0, maintZonesInd: 0,
};

const ZERO_WILDERNESS_BREAKDOWN: WireWildernessBreakdown = {
  forests: 0, parks: 0, openLand: 0, waterEdge: 0, patch: 0,
  fragmentation: 0, zones: 0, industry: 0, transport: 0, power: 0, civic: 0,
};

const ZERO_LABOUR: WireLabourStats = {
  population: 0, resCapacity: 0, jobCapacity: 0,
  workers: 0, employed: 0, unemployed: 0, unemploymentRate: 0, vacancyRate: 0,
};

function zeroDemandClass(value: number): WireDemandClassBreakdown {
  return {
    base: 0, fillFraction: 0, fillTerm: 0, workforceTerm: 0, labourTerm: 0,
    pendingZones: 0, pendingPenaltyRaw: 0, pendingPenaltyCapped: 0, pendingPenaltyApplied: 0,
    pressureRelief: 0, utilityPenalty: 0, demandBeforeUtilities: value,
    floorApplied: false, seeded: true, value,
  };
}

function baseTickEvent(overrides: Partial<TickEvent> = {}): TickEvent {
  return {
    tick: 0, day: 0, population: 0, jobs: 0, money: 0,
    power: 0, water: 0, powerProduced: 0, waterProduced: 0,
    powerUsed: 0, waterUsed: 0,
    budget: ZERO_BUDGET,
    wildernessBreakdown: ZERO_WILDERNESS_BREAKDOWN,
    powerComponents: [], waterComponents: [],
    education: {
      elementaryServed: 0, elementaryCapacity: 0, elementaryLoad: 0,
      highServed: 0, highCapacity: 0, highLoad: 0,
      score: 1, elementaryCoverage: 1, highCoverage: 1
    },
    educationSeatsUsed: [],
    budgetHistory: [],
    demandResidential: 0, demandCommercial: 0, demandIndustrial: 0,
    demandBreakdown: {
      residential: zeroDemandClass(0), commercial: zeroDemandClass(0), industrial: zeroDemandClass(0)
    },
    labour: ZERO_LABOUR,
    abandonedCount: 0, avgHappiness: 1,
    wildernessScore: 0, wildernessTrend: 0,
    width: 8, height: 8,
    tiles: new Array(GRID_TILES * BYTES_PER_TILE).fill(0),
    buildings: [],
    canUndo: false, canRedo: false,
    alerts: [],
    ...overrides
  };
}

/** A `WireBuilding` with `status`/`health` defaulted to Active/100 — override just what a test cares about. */
function wireBuilding(overrides: Partial<WireBuilding> & Pick<WireBuilding, 'id' | 'kind' | 'originX' | 'originY'>): WireBuilding {
  return { status: 0, health: 100, ...overrides };
}

function makeFakePlugin(): TauriPluginBindings {
  return {
    start: vi.fn(),
    applyTool: vi.fn().mockResolvedValue({ success: true, message: null, strokeId: 0 }),
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
      wilderness: { natureReserve: false, greenIndustry: false },
      lighting: 'mixed' as const,
      pendingPenaltyEnabled: true
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
    const strokeId = nextStrokeId();
    vi.mocked(plugin.applyTool).mockResolvedValueOnce({ success: false, message: 'Not enough funds', strokeId });

    bridge.send(applyToolCmd(Tool.Road, 3, 4, strokeId, 'surface'));
    // send() itself must still answer synchronously and optimistically —
    // the real result arrives later, over the resolved promise.
    await Promise.resolve();
    await Promise.resolve();

    const result = events.find((e) => e.type === 'CommandResult');
    expect(result).toEqual({ type: 'CommandResult', success: false, message: 'Not enough funds', strokeId });
  });

  it('forwards the plugin\'s own strokeId, not the send-time closure value, in case they ever disagree', async () => {
    const { bridge, plugin, events } = await makeBridge();
    const sentStrokeId = nextStrokeId();
    // A deliberately different id in the resolved result — proves the bridge
    // reads `result.strokeId` (the Rust-stamped value) rather than closing
    // over the id it sent, per `send()`'s doc comment.
    vi.mocked(plugin.applyTool).mockResolvedValueOnce({ success: true, message: null, strokeId: sentStrokeId + 1 });

    bridge.send(applyToolCmd(Tool.Road, 3, 4, sentStrokeId, 'surface'));
    await Promise.resolve();
    await Promise.resolve();

    const result = events.find((e) => e.type === 'CommandResult');
    expect(result).toEqual({ type: 'CommandResult', success: true, message: undefined, strokeId: sentStrokeId + 1 });
  });
});

describe('TauriSimBridge onTick decode', () => {
  it('copies stats, utility usage, demand headline, and wilderness score/trend verbatim', async () => {
    const { bridge, emit } = await makeBridge();
    emit(baseTickEvent({
      tick: 42, day: 3, population: 100, jobs: 50, money: 5000,
      power: 20, water: -5, powerProduced: 80, waterProduced: 15,
      // `powerUsed`/`waterUsed` ride the wire directly now — deliberately
      // NOT `produced - balance` here, proving the bridge no longer
      // re-derives them by subtraction.
      powerUsed: 999, waterUsed: 999,
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
    expect(s.utilities.powerUsed).toBe(999);
    expect(s.utilities.waterUsed).toBe(999);
    expect(s.demand.residential).toBe(60);
    expect(s.demand.commercial).toBe(40);
    expect(s.demand.industrial).toBe(10);
    expect(s.wilderness.score).toBe(33);
    expect(s.wilderness.trend).toBe(-1.5);
  });

  it('copies budget, wilderness breakdown, demand breakdown, labour, and map aggregates verbatim — previously all zeroed on this transport', async () => {
    const { bridge, emit } = await makeBridge();
    const budget: WireBudgetStats = { ...ZERO_BUDGET, revenue: 500, expenses: 300, net: 200, netPerDay: 40, netPerMonth: 1200 };
    const wildernessBreakdown: WireWildernessBreakdown = { ...ZERO_WILDERNESS_BREAKDOWN, forests: 12, parks: 4 };
    const labour: WireLabourStats = { ...ZERO_LABOUR, population: 100, jobCapacity: 40, unemploymentRate: 0.2, vacancyRate: 0.1 };
    const demandBreakdown: WireDemandBreakdown = {
      residential: zeroDemandClass(60), commercial: zeroDemandClass(40), industrial: zeroDemandClass(10)
    };

    emit(baseTickEvent({ budget, wildernessBreakdown, demandBreakdown, labour, abandonedCount: 7, avgHappiness: 0.42 }));

    const s = bridge.getState();
    expect(s.budget.revenue).toBe(500);
    expect(s.budget.expenses).toBe(300);
    expect(s.budget.net).toBe(200);
    expect(s.budget.netPerDay).toBe(40);
    expect(s.budget.netPerMonth).toBe(1200);
    expect(s.wilderness.breakdown.forests).toBe(12);
    expect(s.wilderness.breakdown.parks).toBe(4);
    expect(s.demand.breakdown).toEqual(demandBreakdown);
    expect(s.labour).toEqual(labour);
    expect(s.abandonedCount).toBe(7);
    expect(s.avgHappiness).toBe(0.42);
  });

  it('adopts event.budgetHistory verbatim, replacing whatever the mirror held before', async () => {
    const { bridge, emit } = await makeBridge();

    emit(baseTickEvent({ budgetHistory: [{ day: 1, revenue: 100, expenses: 40, net: 60 }] }));
    expect(bridge.getState().budgetHistory).toEqual([{ day: 1, revenue: 100, expenses: 40, net: 60 }]);

    emit(baseTickEvent({ budgetHistory: [{ day: 1, revenue: 100, expenses: 40, net: 60 }, { day: 2, revenue: 110, expenses: 45, net: 65 }] }));
    expect(bridge.getState().budgetHistory).toEqual([
      { day: 1, revenue: 100, expenses: 40, net: 60 },
      { day: 2, revenue: 110, expenses: 45, net: 65 },
    ]);
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
    expect(tile.wilderness).toBeCloseTo(decodeEco(64), 5);
  });

  it('adopts event.education verbatim and maps educationSeatsUsed onto the matching building\'s slotsUsed', async () => {
    const { bridge, emit } = await makeBridge();
    const education: WireEducationStats = {
      elementaryServed: 12, elementaryCapacity: 180, elementaryLoad: 20,
      highServed: 0, highCapacity: 0, highLoad: 0,
      score: 0.6, elementaryCoverage: 0.6, highCoverage: 1,
    };
    const school: WireBuilding = wireBuilding({ id: 7, kind: buildingKindToU8(BuildingKind.ElementarySchool), originX: 0, originY: 0 });

    emit(baseTickEvent({
      education,
      educationSeatsUsed: [{ buildingId: 7, used: 12 }],
      buildings: [school],
    }));

    const s = bridge.getState();
    expect(s.education).toEqual(education);
    const building = s.buildings.find((b) => b.id === 7);
    expect(building?.state.serviceLoad.slotsUsed[ServiceId.EducationElementary]).toBe(12);
  });

  it('decodes buildingId directly from the wire, independent of event.buildings, and clears it when the wire says none', async () => {
    const { bridge, emit } = await makeBridge();
    const n = GRID_TILES;
    const o = tileBufferOffsets(n);
    const coalPlant: WireBuilding = wireBuilding({ id: 7, kind: buildingKindToU8(BuildingKind.CoalPlant), originX: 0, originY: 0 });

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
    expect(s1.buildings[0]).toMatchObject({ id: 7, templateId: BuildingKind.CoalPlant, origin: { x: 0, y: 0 } });

    // Razed: the next TickEvent's wire carries building_id 0 everywhere, and no buildings.
    emit(baseTickEvent({ buildings: [] }));
    const s2 = bridge.getState();
    expect(s2.tiles[0].buildingId).toBeUndefined();
    expect(s2.tiles[1].buildingId).toBeUndefined();
    expect(s2.tiles[8].buildingId).toBeUndefined();
    expect(s2.tiles[9].buildingId).toBeUndefined();
    expect(s2.buildings).toHaveLength(0);
  });

  // `#200`'s wire-adoption follow-up: building status/health used to be
  // reconstructed client-side from tile power/water flags (a ~40-line
  // derivation, tested above in prior revisions of this file). The engine
  // now computes the real status and sends it directly as `WireBuilding
  // .status`/`.health` — this bridge's only remaining job is decoding the u8.
  it.each([
    [0, 'active'],
    [1, 'inactive_no_power'],
    [2, 'inactive_no_water'],
    [3, 'inactive_no_source'],
    [4, 'inactive_damaged'],
  ] as const)('decodes WireBuilding.status byte %i as %s, verbatim off the wire', async (statusByte, expected) => {
    const { bridge, emit } = await makeBridge();
    const house = wireBuilding({
      id: 1, kind: buildingKindToU8(BuildingKind.Residential), originX: 0, originY: 0, status: statusByte,
    });
    emit(baseTickEvent({ buildings: [house] }));
    expect(bridge.getState().buildings[0].state.status).toBe(expected);
  });

  it('decodes WireBuilding.health verbatim', async () => {
    const { bridge, emit } = await makeBridge();
    const house = wireBuilding({
      id: 1, kind: buildingKindToU8(BuildingKind.Residential), originX: 0, originY: 0, health: 37,
    });
    emit(baseTickEvent({ buildings: [house] }));
    expect(bridge.getState().buildings[0].state.health).toBe(37);
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
