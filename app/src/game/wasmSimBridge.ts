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

import { recordEngineBuild } from '../buildInfo';
import type { GameState, UtilityComponentStats, ViewStratum } from './gameState';
import { TileKind } from './gameState';
import { BuildingStatus, createBuildingState } from './buildings/state';
import { BuildingKind, getBuildingTemplate } from './buildings/templates';
import { createTileServiceState } from './services';
import type { LegacyEngineImport, SimBridge } from './simBridge';
import type { BudgetPolicy, SimCommand, CommandResult } from './protocol/commands';
import type { BudgetHistoryEntry } from './economy';
import type { FromSim } from './protocol/events';
import type { SimStats, SimAlertWire } from '../workers/wasmSim.worker';
import { deriveNarrativeEventFromAlert } from './protocol/deficitNarrative';
import { decodeTileBuffer } from './protocol/tileBuffer';
import { buildingKindFromU8 } from './protocol/buildingKind';
import { Occupant, Terrain, ZoneDensity, hasOccupant } from './protocol/occupants';
import { Tool } from './toolTypes';
import { footprintTouchesWater } from './adjacency';

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
  [Tool.ParkLarge]:        22,
};

// Mapping from the TS string-valued ViewStratum ('surface' | 'underground',
// gameState.ts) → the Rust ViewStratum's #[repr(u8)] discriminant
// (city-sim-protocol/src/commands.rs). Deliberately a distinct concept from
// tile-internal Stratum — this one describes which layer the *player* is
// looking at, not a tile occupant bitset — see that enum's doc comment.
const STRATUM_TO_U8: Record<ViewStratum, number> = {
  surface: 0,
  underground: 1,
};

interface WorkerHistoryFlags {
  canUndo: boolean;
  canRedo: boolean;
}

type WorkerToMain =
  | {
      type: 'ready';
      history: WorkerHistoryFlags;
      /** Absent on an older worker bundle; the overlay then reports "unknown". */
      build?: { version: string | null; sha: string | null; lastModified: string | null };
    }
  /** Posted only when the WASM's `Last-Modified` changes under a live page. */
  | { type: 'build_update'; build: { lastModified: string | null } }
  | { type: 'init_error';   message: string }
  | { type: 'step_result';  bytes: Uint8Array; stats: SimStats; buildingsJson: string; powerComponentsJson: string; waterComponentsJson: string; educationJson: string; educationSeatsUsedJson: string; budgetHistoryJson: string; mutationSeq: number; alerts: SimAlertWire[] }
  | { type: 'apply_result'; success: boolean; message: string | null; history: WorkerHistoryFlags }
  | { type: 'undo_result';  happened: false; history: WorkerHistoryFlags }
  | { type: 'undo_result';  happened: true; bytes: Uint8Array; stats: SimStats; buildingsJson: string; powerComponentsJson: string; waterComponentsJson: string; educationJson: string; educationSeatsUsedJson: string; budgetHistoryJson: string; mutationSeq: number; history: WorkerHistoryFlags }
  | { type: 'redo_result';  happened: false; history: WorkerHistoryFlags }
  | { type: 'redo_result';  happened: true; bytes: Uint8Array; stats: SimStats; buildingsJson: string; powerComponentsJson: string; waterComponentsJson: string; educationJson: string; educationSeatsUsedJson: string; budgetHistoryJson: string; mutationSeq: number; history: WorkerHistoryFlags }
  | { type: 'snapshot_result'; requestId: number; bytes: Uint8Array }
  | { type: 'load_result'; requestId: number; ok: false; error?: string }
  | {
      type: 'load_result'; requestId: number; ok: true;
      width: number; height: number; seed: number;
      policies: GameState['policies'];
      bytes: Uint8Array; stats: SimStats; buildingsJson: string; powerComponentsJson: string; waterComponentsJson: string; educationJson: string; educationSeatsUsedJson: string; budgetHistoryJson: string; mutationSeq: number; history: WorkerHistoryFlags;
    };

/** One entry decoded from a `buildingsJson` payload — see `SimHost::buildings_json` (Rust). */
interface WireBuilding {
  id: number;
  kind: number;
  originX: number;
  originY: number;
}

/** One entry decoded from an `educationSeatsUsedJson` payload — see `SimHost::education_seats_used_json` (Rust). */
interface WireEducationSeatsUsed {
  buildingId: number;
  used: number;
}

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
  private pendingBuildingsJson = '';
  private pendingPowerComponentsJson = '';
  private pendingWaterComponentsJson = '';
  private pendingEducationJson = '';
  private pendingEducationSeatsUsedJson = '';
  private pendingBudgetHistoryJson = '';
  private pendingStats: SimStats | null = null;
  private pendingMutationSeq = 0;
  /**
   * Alerts from step_results not yet flushed by step() — staged the same way
   * as pendingStats/pendingTileBuffer rather than dispatched on arrival, so
   * an undo/redo/load that discards a stale step_result (see those handlers
   * below) discards its alerts too. Without this, an alert raised by a
   * step_result that predates a rollback could reach the player as a
   * permanent sticky toast for a state transition the rollback undid, with
   * no restore alert ever following it — the Rust-side latch resyncs
   * silently on load_state, so nothing else would ever correct it.
   */
  private pendingAlerts: SimAlertWire[] = [];
  private pendingUndo: ((happened: boolean) => void) | null = null;
  private pendingRedo: ((happened: boolean) => void) | null = null;
  private canUndoFlag = false;
  private canRedoFlag = false;
  /**
   * Tick number last actually applied to the mirror. The worker posts a
   * fresh step_result every 50ms regardless of sim speed (paused included —
   * see wasmSim.worker.ts's step loop), so when the incoming tick matches
   * this, nothing meaningful could have changed and the expensive
   * applyTileBuffer/updateStats work is skipped — UNLESS mutationSeq (below)
   * also matches.
   */
  private lastAppliedTick: number | null = null;
  /**
   * Mirrors the worker's `mutationSeq` counter (see wasmSim.worker.ts) as of
   * the last buffer actually applied. `apply_tool` mutates tiles directly and
   * is NOT gated by the speed-scaled tick accumulator — a tool placed while
   * paused changes the tile buffer without bumping tick_count, so tick
   * equality alone can't detect it. mutationSeq is bumped synchronously
   * inside the worker's apply_tool handler, so any step_result gathered
   * afterwards is guaranteed to carry the post-mutation value — unlike a
   * main-thread "a command was just sent" flag, which can't distinguish a
   * stale in-flight step_result (queued before the worker processed the
   * command) from a fresh post-mutation one.
   */
  private lastAppliedMutationSeq = 0;
  /**
   * True whenever the mirror was actually mutated since the last `step()`
   * call — set both by the in-`step()` apply path and by the out-of-band
   * undo/redo/load handlers (which apply immediately on message arrival,
   * not gated by `step()`). Read and cleared by `step()`'s return value so
   * `main.ts`'s gameLoop can know whether a redraw is needed even when the
   * mutation landed between two rAF frames.
   */
  private dirtySinceLastStep = false;
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
    // Catches worker-thread failures the 'init' handler's own try/catch
    // can't (a syntax error, the module failing to load at all) — without
    // this, such a failure is silent and 'Ready' simply never arrives.
    this.worker.onerror = (event: ErrorEvent) => {
      this.handler?.({ type: 'InitError', message: event.message || 'Worker failed to start' });
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

  step(_dt: number): boolean {
    // The worker drives the simulation clock itself (20 Hz interval, alive
    // even in hidden tabs) — this per-frame call only flushes the latest
    // engine update into the display mirror the renderer reads.
    //
    // The worker posts a step_result every 50ms regardless of sim speed —
    // even paused (multiplier 0) — because its setInterval clock never
    // stops. When the posted tick AND mutationSeq both match what's already
    // applied, nothing meaningful could have changed and the buffer is
    // byte-identical to what's already applied, so skip the full tile-array
    // rebuild + building-list rebuild + education JSON parse.
    if (
      this.pendingStats !== null &&
      this.pendingStats.tick === this.lastAppliedTick &&
      this.pendingMutationSeq === this.lastAppliedMutationSeq
    ) {
      this.pendingTileBuffer = null;
      this.pendingStats = null;
      this.pendingAlerts = [];
      return this.consumeDirty();
    }
    if (this.pendingTileBuffer !== null) {
      this.applyTileBuffer(
        this.pendingTileBuffer,
        this.pendingBuildingsJson,
        this.pendingPowerComponentsJson,
        this.pendingWaterComponentsJson,
        this.pendingEducationJson,
        this.pendingEducationSeatsUsedJson,
        this.pendingBudgetHistoryJson,
      );
      this.pendingTileBuffer = null;
      this.dirtySinceLastStep = true;
    }
    if (this.pendingStats !== null) {
      this.updateStats(this.pendingStats);
      this.lastAppliedTick = this.pendingStats.tick;
      this.lastAppliedMutationSeq = this.pendingMutationSeq;
      this.pendingStats = null;
      this.dirtySinceLastStep = true;
    }
    if (this.pendingAlerts.length > 0) {
      this.dispatchAlerts(this.pendingAlerts);
      this.pendingAlerts = [];
    }
    return this.consumeDirty();
  }

  /** Read-and-clear `dirtySinceLastStep` — see its field doc. */
  private consumeDirty(): boolean {
    const dirty = this.dirtySinceLastStep;
    this.dirtySinceLastStep = false;
    return dirty;
  }

  send(cmd: SimCommand): CommandResult {
    switch (cmd.type) {
      case 'ApplyTool':
        if (this.ready) {
          this.worker.postMessage({
            type: 'apply_tool',
            payload: {
              tool: TOOL_TO_U8[cmd.tool],
              x: cmd.x,
              y: cmd.y,
              strokeId: cmd.strokeId,
              stratum: STRATUM_TO_U8[cmd.stratum],
            },
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

  /** One-time import of a legacy JSON save — see `transcodeLegacySave`. */
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
      case 'build_update':
        // The binary changed under a page that is already running. Nothing to
        // reload here — the overlay reads this and tells the player to.
        recordEngineBuild(msg.build);
        break;

      case 'ready':
        this.ready = true;
        if (msg.build) recordEngineBuild(msg.build);
        this.resolveReady();
        if (this.speedMult !== 1) {
          this.worker.postMessage({ type: 'set_speed', payload: { multiplier: this.speedMult } });
        }
        // Policies may have changed while the worker was still booting.
        this.worker.postMessage({ type: 'set_policies', payload: this.state.policies });
        this.syncHistoryFlags(msg.history);
        this.handler?.({ type: 'Ready' });
        break;
      case 'init_error':
        this.handler?.({ type: 'InitError', message: msg.message });
        break;
      case 'step_result':
        this.pendingTileBuffer = msg.bytes;
        this.pendingBuildingsJson = msg.buildingsJson;
        this.pendingPowerComponentsJson = msg.powerComponentsJson;
        this.pendingWaterComponentsJson = msg.waterComponentsJson;
        this.pendingEducationJson = msg.educationJson;
        this.pendingEducationSeatsUsedJson = msg.educationSeatsUsedJson;
        this.pendingBudgetHistoryJson = msg.budgetHistoryJson;
        this.pendingStats = msg.stats;
        this.pendingMutationSeq = msg.mutationSeq;
        // Staged, not dispatched here — see pendingAlerts' field doc. Concat
        // rather than replace: if two step_results arrive before the next
        // step() flush (a delayed rAF frame), neither's alerts are lost.
        this.pendingAlerts = this.pendingAlerts.concat(msg.alerts);
        break;
      case 'apply_result':
        this.handler?.({ type: 'CommandResult', success: msg.success, message: msg.message ?? undefined });
        this.syncHistoryFlags(msg.history);
        break;
      case 'undo_result':
        // Discard any pending step_result — it was computed before the undo
        // and would overwrite the rolled-back state on the next frame. Its
        // alerts go with it: the engine resyncs the deficit latches to the
        // restored balance silently (see sim.rs's load_state), so an alert
        // from a pre-undo step_result describes a transition the undo just
        // erased, and no correcting alert will ever arrive to cancel it.
        this.pendingTileBuffer = null;
        this.pendingStats = null;
        this.pendingAlerts = [];
        if (msg.happened) {
          this.applyTileBuffer(msg.bytes, msg.buildingsJson, msg.powerComponentsJson, msg.waterComponentsJson, msg.educationJson, msg.educationSeatsUsedJson, msg.budgetHistoryJson);
          this.updateStats(msg.stats);
          this.lastAppliedTick = msg.stats.tick;
          this.lastAppliedMutationSeq = msg.mutationSeq;
          this.dirtySinceLastStep = true;
        }
        this.syncHistoryFlags(msg.history);
        this.pendingUndo?.(msg.happened);
        this.pendingUndo = null;
        break;
      case 'redo_result':
        // Same reasoning as undo_result above.
        this.pendingTileBuffer = null;
        this.pendingStats = null;
        this.pendingAlerts = [];
        if (msg.happened) {
          this.applyTileBuffer(msg.bytes, msg.buildingsJson, msg.powerComponentsJson, msg.waterComponentsJson, msg.educationJson, msg.educationSeatsUsedJson, msg.budgetHistoryJson);
          this.updateStats(msg.stats);
          this.lastAppliedTick = msg.stats.tick;
          this.lastAppliedMutationSeq = msg.mutationSeq;
          this.dirtySinceLastStep = true;
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
        // the caller's promise resolves — same reasoning as undo_result above.
        this.pendingTileBuffer = null;
        this.pendingStats = null;
        this.pendingAlerts = [];
        this.adoptDimensions(msg.width, msg.height, msg.seed);
        this.state.policies = msg.policies;
        this.applyTileBuffer(msg.bytes, msg.buildingsJson, msg.powerComponentsJson, msg.waterComponentsJson, msg.educationJson, msg.educationSeatsUsedJson, msg.budgetHistoryJson);
        this.updateStats(msg.stats);
        this.lastAppliedTick = msg.stats.tick;
        this.lastAppliedMutationSeq = msg.mutationSeq;
        this.dirtySinceLastStep = true;
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
      terrain: Terrain.Land,
      underground: 0,
      surface: 0,
      overhead: 0,
      density: ZoneDensity.Low,
    }));
  }

  /** Forward each alert as `FromSim::Alert`, plus its paired narrative event if any. */
  private dispatchAlerts(alerts: SimAlertWire[]): void {
    for (const alert of alerts) {
      this.handler?.({ type: 'Alert', data: alert });
      const narrative = deriveNarrativeEventFromAlert(alert, Date.now());
      if (narrative) {
        this.handler?.({ type: 'Narrative', data: { kind: 'Alert', payload: narrative } });
      }
    }
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

  private applyTileBuffer(
    bytes: Uint8Array,
    buildingsJson: string,
    powerComponentsJson: string,
    waterComponentsJson: string,
    educationJson: string,
    educationSeatsUsedJson: string,
    budgetHistoryJson: string,
  ): void {
    const n = this.state.tiles.length;

    // The live wire no longer carries a resolved kind byte per tile (#177's
    // TS/wire follow-up) — a `Structure` occupant says only that a building
    // stands here, not which one. `buildings_json` is the only source for
    // that now.
    const wireBuildings: WireBuilding[] = buildingsJson ? JSON.parse(buildingsJson) : [];
    // `#230` — one entry per physically-connected segment; unrounded on the
    // wire, matching the engine (`UtilityComponent`'s doc comment).
    this.state.utilities.powerComponents = powerComponentsJson
      ? (JSON.parse(powerComponentsJson) as UtilityComponentStats[])
      : [];
    this.state.utilities.waterComponents = waterComponentsJson
      ? (JSON.parse(waterComponentsJson) as UtilityComponentStats[])
      : [];
    // `#228` — Rust-computed, replaces the old client-side recompute.
    if (educationJson) {
      this.state.education = JSON.parse(educationJson) as GameState['education'];
    }
    const seatsUsed: WireEducationSeatsUsed[] = educationSeatsUsedJson
      ? JSON.parse(educationSeatsUsedJson)
      : [];
    // `#229` — Rust-computed, replaces the old client-side reconstruction.
    if (budgetHistoryJson) {
      this.state.budgetHistory = JSON.parse(budgetHistoryJson) as BudgetHistoryEntry[];
    }

    decodeTileBuffer(this.state.tiles, bytes);

    // Rebuild state.buildings directly from the parsed list — Rust is
    // authoritative; TS state.buildings is a display mirror only. No more
    // scanning tiles for first-occurrence origins: `buildings_json` already
    // carries id, kind and origin.
    // Mirror of the engine's water opt-in gate (`GameState::has_water_system`):
    // until a pump, tower, or pipe exists, buildings don't require water.
    let hasWaterSystem = wireBuildings.some((b) => {
      const kind = buildingKindFromU8(b.kind);
      return kind === BuildingKind.WaterPump || kind === BuildingKind.WaterTower;
    });
    for (let i = 0; i < n && !hasWaterSystem; i++) {
      if (hasOccupant(this.state.tiles[i].underground, Occupant.Pipe)) hasWaterSystem = true;
    }
    const seatsUsedByBuildingId = new Map(seatsUsed.map((e) => [e.buildingId, e.used]));
    this.state.buildings = wireBuildings.map((b) => {
      // `b.kind` decodes via `BUILDING_KIND_BY_U8` — an unrecognised byte
      // (should never happen against a matching engine build) falls back to
      // the empty string, which `getBuildingTemplate` returns `undefined`
      // for, same as the old `TileKind.Land` fallback did (Land has no
      // building template either).
      const kind: string = buildingKindFromU8(b.kind) ?? '';
      // Status is derived from the tile flags the Rust buffer already set —
      // `hasWaterSystem` gates the water check so buildings in cities without
      // water infrastructure aren't misread as unwatered.
      const originTile = this.state.tiles[b.originY * this.state.width + b.originX];
      const template = getBuildingTemplate(kind);
      const bstate = createBuildingState();
      const needsPower = template ? template.requiresPower !== false : false;
      const needsWater =
        hasWaterSystem && template !== undefined && template.waterUse !== undefined && template.waterUse > 0;
      // A pump only produces when its footprint touches water terrain (#200)
      // — distinct from needsWater above, which gates a *consumer* on
      // network coverage; a pump doesn't consume water.
      const needsSource = kind === BuildingKind.WaterPump;
      const origin = { x: b.originX, y: b.originY };
      if (needsPower && !originTile?.powered) {
        bstate.status = BuildingStatus.InactiveNoPower;
      } else if (needsSource && template && !footprintTouchesWater(this.state, origin, template.footprint)) {
        bstate.status = BuildingStatus.InactiveNoSource;
      } else if (needsWater && !originTile?.watered) {
        bstate.status = BuildingStatus.InactiveNoWater;
      }
      // `#228` — seats consumed, from the wire; only schools currently have
      // an entry (Rust's `ServiceKind` has no other service ported yet).
      const used = template?.service ? seatsUsedByBuildingId.get(b.id) : undefined;
      if (template?.service && used !== undefined) {
        bstate.serviceLoad.slotsUsed[template.service.id] = used;
      }
      return {
        id: b.id,
        templateId: kind,
        origin,
        state: bstate
      };
    });
  }
}

/** A state's terrain as `Terrain` u8 bytes (`Land` = 0, `Water` = 1), for
 *  engine natural-terrain seeding. */
function terrainBytes(state: GameState): Uint8Array {
  const bytes = new Uint8Array(state.tiles.length);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = state.tiles[i].terrain === Terrain.Water ? Terrain.Water : Terrain.Land;
  }
  return bytes;
}
