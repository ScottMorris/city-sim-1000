// wasmSimBridge.ts — SimBridge backed by the real city-sim-core Rust engine
// running inside a Web Worker via WASM.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// SimHost wraps city-sim-core::Simulation + a snapshot-stack History. Tool
// placement, ticking, undo/redo, and save/load all run through the Rust
// engine; saves carry the engine's own CSIM snapshot (no command replay).
//
// Tile-buffer transport: transferable ArrayBuffer (one copy per step).

import type { GameState } from './gameState';
import { TileKind } from './gameState';
import { BuildingStatus, createBuildingState } from './buildings/state';
import { getBuildingTemplate } from './buildings/templates';
import { recomputeEducation } from './education';
import { createTileServiceState } from './services';
import type { LegacyEngineImport, SimBridge } from './simBridge';
import type { BudgetPolicy, SimCommand, CommandResult } from './protocol/commands';
import { recordDailyBudget } from './economy';
import type { FromSim } from './protocol/events';
import type { SimStats } from '../workers/wasmSim.worker';
import { tileBufferOffsets, decodeHappiness, FLAGS } from './protocol/tileBuffer';
import { tileKindFromU8, tileKindToU8 } from './protocol/tileKind';
import { Tool } from './toolTypes';

// Mapping from TS string-valued Tool enum → Rust #[repr(u8)] discriminant.
// Must remain in sync with city-sim-protocol/src/commands.rs Tool enum.
const TOOL_TO_U8: Record<Tool, number> = {
  [Tool.Inspect]:          0,
  [Tool.TerraformRaise]:   1,
  [Tool.TerraformLower]:   2,
  [Tool.Water]:            3,
  [Tool.Tree]:             4,
  [Tool.Road]:             5,
  [Tool.Rail]:             6,
  [Tool.PowerLine]:        7,
  [Tool.HydroPlant]:       8,
  [Tool.CoalPlant]:        9,
  [Tool.WindTurbine]:      10,
  [Tool.SolarFarm]:        11,
  [Tool.WaterPump]:        12,
  [Tool.WaterTower]:       13,
  [Tool.WaterPipe]:        14,
  [Tool.ElementarySchool]: 15,
  [Tool.HighSchool]:       16,
  [Tool.Residential]:      17,
  [Tool.Commercial]:       18,
  [Tool.Industrial]:       19,
  [Tool.Park]:             20,
  [Tool.Bulldoze]:         21,
};

interface WorkerHistoryFlags {
  canUndo: boolean;
  canRedo: boolean;
}

type WorkerToMain =
  | { type: 'ready';        history: WorkerHistoryFlags }
  | { type: 'step_result';  bytes: Uint8Array; stats: SimStats }
  | { type: 'apply_result'; success: boolean; history: WorkerHistoryFlags }
  | { type: 'undo_result';  happened: false; history: WorkerHistoryFlags }
  | { type: 'undo_result';  happened: true; bytes: Uint8Array; stats: SimStats; history: WorkerHistoryFlags }
  | { type: 'redo_result';  happened: false; history: WorkerHistoryFlags }
  | { type: 'redo_result';  happened: true; bytes: Uint8Array; stats: SimStats; history: WorkerHistoryFlags }
  | { type: 'snapshot_result'; requestId: number; bytes: Uint8Array }
  | { type: 'load_result'; requestId: number; ok: false; error?: string }
  | {
      type: 'load_result'; requestId: number; ok: true;
      width: number; height: number; seed: number;
      policies: GameState['policies'];
      bytes: Uint8Array; stats: SimStats; history: WorkerHistoryFlags;
    };

export interface WasmSimBridgeConfig {
  ticksPerSecond?: number;
  /**
   * Factory for the sim Worker — injectable so tests can substitute a fake.
   * Defaults to the real `wasmSim.worker.ts` module Worker.
   */
  createWorker?: () => Worker;
}

export class WasmSimBridge implements SimBridge {
  private state: GameState;
  private worker: Worker;
  private ready = false;
  private handler: ((msg: FromSim) => void) | null = null;
  private speedMult = 1;
  private pendingTileBuffer: Uint8Array | null = null;
  private pendingStats: SimStats | null = null;
  private pendingUndo: ((happened: boolean) => void) | null = null;
  private pendingRedo: ((happened: boolean) => void) | null = null;
  private canUndoFlag = false;
  private canRedoFlag = false;
  private nextRequestId = 1;
  private pendingSnapshots = new Map<number, (bytes: Uint8Array) => void>();
  private pendingLoads = new Map<number, { resolve: () => void; reject: (err: Error) => void }>();
  private resolveReady!: () => void;
  private readyPromise = new Promise<void>(resolve => { this.resolveReady = resolve; });

  constructor(state: GameState, config: WasmSimBridgeConfig = {}) {
    // Hold the same reference as main.ts so updateStats / applyTileBuffer
    // mutate the object main.ts renders from. No clone — the Rust sim owns
    // sim state; this.state is only a display mirror.
    this.state = state;
    this.worker =
      config.createWorker?.() ??
      new Worker(new URL('../workers/wasmSim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
      this.handleWorkerMsg(e.data);
    };
    // Seed the engine with the mirror's natural terrain (water/trees from the
    // TS generator) — from here on the engine is the single source of truth
    // for tiles; saves and undo snapshots carry the terrain in-state.
    this.worker.postMessage({
      type: 'init',
      payload: {
        width: state.width,
        height: state.height,
        seed: state.seed,
        terrain: terrainBytes(state),
        policies: state.policies,
      },
    });
  }

  step(dt: number): void {
    // Apply tile state and stats received from the previous tick before advancing.
    if (this.pendingTileBuffer !== null) {
      this.applyTileBuffer(this.pendingTileBuffer);
      this.pendingTileBuffer = null;
    }
    if (this.pendingStats !== null) {
      this.updateStats(this.pendingStats);
      this.pendingStats = null;
    }
    if (!this.ready) return;
    // Pass raw dt — the speed multiplier is applied inside Simulation::tick.
    this.worker.postMessage({ type: 'step', payload: { dt } });
  }

  send(cmd: SimCommand): CommandResult {
    switch (cmd.type) {
      case 'ApplyTool':
        if (this.ready) {
          this.worker.postMessage({
            type: 'apply_tool',
            payload: { tool: TOOL_TO_U8[cmd.tool], x: cmd.x, y: cmd.y, strokeId: cmd.strokeId },
          });
        }
        break;
      case 'SetSpeed':
        this.setSpeed(cmd.multiplier);
        break;
      case 'SetPolicies':
        this.state.policies = cmd.policies;
        if (this.ready) {
          this.worker.postMessage({ type: 'set_policies', payload: cmd.policies });
        }
        break;
    }
    return { success: true };
  }

  onMessage(handler: (msg: FromSim) => void): void {
    this.handler = handler;
  }

  getState(): GameState {
    return this.state;
  }

  /** Serialise the engine's full state to a CSIM snapshot blob (pure read). */
  async getSnapshot(): Promise<Uint8Array> {
    await this.readyPromise;
    return new Promise(resolve => {
      const requestId = this.nextRequestId++;
      this.pendingSnapshots.set(requestId, resolve);
      this.worker.postMessage({ type: 'get_snapshot', payload: { requestId } });
    });
  }

  /**
   * Replace the engine state with a CSIM snapshot. The mirror is resized and
   * refreshed (tiles, stats, policies) before the promise resolves; rejects on
   * a corrupt/incompatible snapshot, leaving the running city untouched.
   */
  async loadSnapshot(bytes: Uint8Array): Promise<void> {
    await this.readyPromise;
    return this.requestLoad(requestId => {
      this.worker.postMessage({ type: 'load_snapshot', payload: { requestId, bytes } });
    });
  }

  /** One-time import of a legacy JSON save — see `buildLegacyEngineImport`. */
  async importLegacy(imp: LegacyEngineImport): Promise<void> {
    await this.readyPromise;
    return this.requestLoad(requestId => {
      this.worker.postMessage({ type: 'import_legacy', payload: { requestId, ...imp } });
    });
  }

  /** Start a fresh city from a newly generated mirror state. */
  async newCity(fresh: GameState): Promise<void> {
    await this.readyPromise;
    this.state = fresh;
    return this.requestLoad(requestId => {
      this.worker.postMessage({
        type: 'new_city',
        payload: {
          requestId,
          width: fresh.width,
          height: fresh.height,
          seed: fresh.seed,
          terrain: terrainBytes(fresh),
        },
      });
    });
  }

  private requestLoad(post: (requestId: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const requestId = this.nextRequestId++;
      this.pendingLoads.set(requestId, { resolve, reject });
      post(requestId);
    });
  }

  setSpeed(multiplier: number): void {
    this.speedMult = multiplier;
    if (this.ready) {
      this.worker.postMessage({ type: 'set_speed', payload: { multiplier } });
    }
  }

  undo(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.ready) {
        resolve(false);
        return;
      }
      this.pendingUndo = resolve;
      this.worker.postMessage({ type: 'undo' });
    });
  }

  redo(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.ready) {
        resolve(false);
        return;
      }
      this.pendingRedo = resolve;
      this.worker.postMessage({ type: 'redo' });
    });
  }

  canUndo(): boolean { return this.canUndoFlag; }

  canRedo(): boolean { return this.canRedoFlag; }

  // Returns null until Option B (Rust building_metadata() export) is implemented.
  getMetadata() { return null; }

  dispose(): void {
    this.worker.terminate();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private handleWorkerMsg(msg: WorkerToMain): void {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.resolveReady();
        if (this.speedMult !== 1) {
          this.worker.postMessage({ type: 'set_speed', payload: { multiplier: this.speedMult } });
        }
        // Policies may have changed while the worker was still booting.
        this.worker.postMessage({ type: 'set_policies', payload: this.state.policies });
        this.syncHistoryFlags(msg.history);
        this.handler?.({ type: 'Ready' });
        break;
      case 'step_result':
        this.pendingTileBuffer = msg.bytes;
        this.pendingStats = msg.stats;
        break;
      case 'apply_result':
        if (!msg.success) {
          console.warn('[WasmSimBridge] apply_tool rejected by Rust sim');
        }
        this.syncHistoryFlags(msg.history);
        break;
      case 'undo_result':
        // Discard any pending step_result — it was computed before the undo
        // and would overwrite the rolled-back state on the next frame.
        this.pendingTileBuffer = null;
        this.pendingStats = null;
        if (msg.happened) {
          this.applyTileBuffer(msg.bytes);
          this.updateStats(msg.stats);
        }
        this.syncHistoryFlags(msg.history);
        this.pendingUndo?.(msg.happened);
        this.pendingUndo = null;
        break;
      case 'redo_result':
        this.pendingTileBuffer = null;
        this.pendingStats = null;
        if (msg.happened) {
          this.applyTileBuffer(msg.bytes);
          this.updateStats(msg.stats);
        }
        this.syncHistoryFlags(msg.history);
        this.pendingRedo?.(msg.happened);
        this.pendingRedo = null;
        break;
      case 'snapshot_result': {
        const resolve = this.pendingSnapshots.get(msg.requestId);
        this.pendingSnapshots.delete(msg.requestId);
        resolve?.(msg.bytes);
        break;
      }
      case 'load_result': {
        const pending = this.pendingLoads.get(msg.requestId);
        this.pendingLoads.delete(msg.requestId);
        if (!msg.ok) {
          pending?.reject(new Error(msg.error ?? 'Engine rejected the save'));
          break;
        }
        // Discard pre-load frames and refresh the mirror atomically before
        // the caller's promise resolves.
        this.pendingTileBuffer = null;
        this.pendingStats = null;
        this.adoptDimensions(msg.width, msg.height, msg.seed);
        this.state.policies = msg.policies;
        this.applyTileBuffer(msg.bytes);
        this.updateStats(msg.stats);
        this.syncHistoryFlags(msg.history);
        pending?.resolve();
        break;
      }
    }
  }

  /** Resize the mirror's tile array when a load changes map dimensions. */
  private adoptDimensions(width: number, height: number, seed: number): void {
    this.state.seed = seed;
    if (this.state.width === width && this.state.height === height) return;
    this.state.width = width;
    this.state.height = height;
    this.state.tiles = Array.from({ length: width * height }, () => ({
      kind: TileKind.Land,
      elevation: 0,
      happiness: 1,
      powered: false,
      watered: false,
      services: createTileServiceState(),
    }));
  }

  private syncHistoryFlags(flags: WorkerHistoryFlags): void {
    if (flags.canUndo === this.canUndoFlag && flags.canRedo === this.canRedoFlag) return;
    this.canUndoFlag = flags.canUndo;
    this.canRedoFlag = flags.canRedo;
    this.handler?.({ type: 'HistoryChanged', data: { canUndo: flags.canUndo, canRedo: flags.canRedo } });
  }

  private updateStats(stats: SimStats): void {
    this.state.tick = stats.tick;
    this.state.day = stats.day;
    this.state.money = stats.money;
    this.state.population = stats.population;
    this.state.jobs = stats.jobs;
    this.state.utilities.power         = stats.powerBalance;
    this.state.utilities.powerProduced = stats.powerProduced;
    this.state.utilities.powerUsed     = stats.powerUsed;
    this.state.utilities.water         = stats.waterBalance;
    this.state.utilities.waterProduced = stats.waterProduced;
    this.state.utilities.waterUsed     = stats.waterUsed;
    this.state.demand.residential = stats.demandResidential;
    this.state.demand.commercial  = stats.demandCommercial;
    this.state.demand.industrial  = stats.demandIndustrial;
    const b = this.state.budget;
    b.netPerDay   = stats.budgetNetPerDay;
    b.netPerMonth = stats.budgetNetPerMonth;
    b.revenue     = stats.budgetRevenue;
    b.expenses    = stats.budgetExpenses;
    b.net         = stats.budgetRevenue - stats.budgetExpenses;
    b.breakdown.revenue.base        = stats.budgetRevenueBase;
    b.breakdown.revenue.residents   = stats.budgetRevenuePop;
    b.breakdown.revenue.commercial  = stats.budgetRevenueCommercial;
    b.breakdown.revenue.industrial  = stats.budgetRevenueIndustrial;
    b.breakdown.revenue.tourism     = stats.budgetRevenueTourism;
    b.breakdown.expenses.transport  = stats.budgetExpensesTransport;
    b.breakdown.expenses.buildings  = stats.budgetExpensesBuildings;
    b.breakdown.expenses.policies   = stats.budgetExpensesPolicies;
    b.breakdown.details.transport.roads      = stats.budgetMaintRoads;
    b.breakdown.details.transport.rail       = stats.budgetMaintRail;
    b.breakdown.details.transport.powerLines = stats.budgetMaintPowerLines;
    b.breakdown.details.transport.waterPipes = stats.budgetMaintPipes;
    b.breakdown.details.buildings.power      = stats.budgetMaintPower;
    b.breakdown.details.buildings.civic      = stats.budgetMaintCivic;
    b.breakdown.details.buildings.zones      = stats.budgetMaintZones;
    b.breakdown.details.buildings.powerByType = {
      hydro: stats.budgetMaintPowerHydro,
      coal:  stats.budgetMaintPowerCoal,
      wind:  stats.budgetMaintPowerWind,
      solar: stats.budgetMaintPowerSolar,
    };
    b.breakdown.details.buildings.civicByType = {
      park:        stats.budgetMaintCivicPark,
      pump:        stats.budgetMaintCivicPump,
      water_tower: stats.budgetMaintCivicTower,
      school:      stats.budgetMaintCivicSchool,
    };
    b.breakdown.details.buildings.zonesByType = {
      residential: stats.budgetMaintZonesRes,
      commercial:  stats.budgetMaintZonesCom,
      industrial:  stats.budgetMaintZonesInd,
    };
    const wild = this.state.wilderness;
    wild.score = stats.wildernessScore;
    wild.trend = stats.wildernessTrend;
    wild.breakdown.forests       = stats.wildernessForests;
    wild.breakdown.parks         = stats.wildernessParks;
    wild.breakdown.openLand      = stats.wildernessOpenLand;
    wild.breakdown.waterEdge     = stats.wildernessWaterEdge;
    wild.breakdown.patch         = stats.wildernessPatch;
    wild.breakdown.fragmentation = stats.wildernessFragmentation;
    wild.breakdown.zones         = stats.wildernessZones;
    wild.breakdown.industry      = stats.wildernessIndustry;
    wild.breakdown.transport     = stats.wildernessTransport;
    wild.breakdown.power         = stats.wildernessPower;
    wild.breakdown.civic         = stats.wildernessCivic;
    // Record the daily budget history TS-side so the quarterly panel works
    // on the WASM path (the Rust sim keeps its own history internally but it
    // isn't carried over the stats wire).
    recordDailyBudget(this.state);
    this.handler?.({
      type: 'TickStats',
      data: {
        tick: stats.tick,
        day: stats.day,
        money: stats.money,
        population: stats.population,
        jobs: stats.jobs,
        powerBalance: stats.powerBalance,
        waterBalance: stats.waterBalance,
      },
    });
  }

  private applyTileBuffer(bytes: Uint8Array): void {
    const n = this.state.tiles.length;
    const o = tileBufferOffsets(n);
    for (let i = 0; i < n; i++) {
      const tile = this.state.tiles[i];
      const rustKind = tileKindFromU8(bytes[o.kind + i]);
      if (rustKind !== undefined) {
        // The engine is seeded with natural terrain at init and every load
        // path restores full state, so the buffer is the single source of
        // truth for tile kinds — no display-side override.
        tile.kind = rustKind;
      }
      const flags = bytes[o.flags + i];
      tile.powered      = (flags & FLAGS.POWERED)       !== 0;
      tile.watered      = (flags & FLAGS.WATERED)        !== 0;
      tile.abandoned    = (flags & FLAGS.ABANDONED)      !== 0;
      tile.roadUnderlay = (flags & FLAGS.ROAD_UNDERLAY)  !== 0;
      tile.railUnderlay = (flags & FLAGS.RAIL_UNDERLAY)  !== 0;
      tile.powerOverlay = (flags & FLAGS.POWER_OVERLAY)  !== 0;
      tile.happiness = decodeHappiness(bytes[o.happiness + i]);
      tile.elevation = bytes[o.elevation + i];
      const bidBase = o.buildingId + i * 2;
      const bid = bytes[bidBase] | (bytes[bidBase + 1] << 8);
      tile.buildingId = bid === 0 ? undefined : bid;
      const ugByte = bytes[o.undergroundKind + i];
      tile.underground = ugByte === 0xFF ? undefined : tileKindFromU8(ugByte);
      // Normalised 0–1 (0.5 = neutral) for the overlay heatmap.
      tile.wilderness = bytes[o.wilderness + i] / 255;
    }

    // Rebuild state.buildings so multi-tile sprite rendering has correct origins.
    // Rust is authoritative; TS state.buildings is a display mirror only.
    // Scanning in row-major order means the first occurrence of each buildingId
    // is always the top-left (origin) tile of its footprint.
    const seen = new Map<number, { kind: TileKind; x: number; y: number }>();
    // Mirror of the engine's water opt-in gate (`GameState::has_water_system`):
    // until a pump, tower, or pipe exists, buildings don't require water.
    let hasWaterSystem = false;
    for (let i = 0; i < n; i++) {
      const tile = this.state.tiles[i];
      if (
        tile.kind === TileKind.WaterPump ||
        tile.kind === TileKind.WaterTower ||
        tile.underground === TileKind.WaterPipe
      ) {
        hasWaterSystem = true;
      }
      if (tile.buildingId === undefined || seen.has(tile.buildingId)) continue;
      seen.set(tile.buildingId, {
        kind: tile.kind,
        x: i % this.state.width,
        y: Math.floor(i / this.state.width),
      });
    }
    this.state.buildings = Array.from(seen.entries()).map(([id, { kind, x, y }]) => {
      // Derive status from the tile flags the Rust buffer already set.
      // Avoids calling updateBuildingStates, which misreads water status for
      // zones in cities without water infrastructure.
      const originTile = this.state.tiles[y * this.state.width + x];
      const template = getBuildingTemplate(kind as string);
      const bstate = createBuildingState();
      const needsPower = template ? template.requiresPower !== false : false;
      const needsWater =
        hasWaterSystem && template !== undefined && template.waterUse !== undefined && template.waterUse > 0;
      if (needsPower && !originTile?.powered) {
        bstate.status = BuildingStatus.InactiveNoPower;
      } else if (needsWater && !originTile?.watered) {
        bstate.status = BuildingStatus.InactiveNoWater;
      }
      return { id, templateId: kind as string, origin: { x, y }, state: bstate };
    });

    // Recompute education coverage so the debug overlay and HUD stay current.
    this.state.education = recomputeEducation(this.state);
  }
}

/** A state's tile kinds as `TileKind` u8 bytes, for engine terrain seeding. */
function terrainBytes(state: GameState): Uint8Array {
  const bytes = new Uint8Array(state.tiles.length);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = tileKindToU8(state.tiles[i].kind);
  }
  return bytes;
}
