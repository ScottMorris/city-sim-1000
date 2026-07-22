// wasmSimBridge.ts — SimBridge backed by the real city-sim-core Rust engine
// running inside a Web Worker via WASM.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// Phase 3: SimHost wraps city-sim-core::Simulation + CommandLog. Tool
// placement, ticking, and Ctrl+Z undo all run through the Rust engine.
//
// Tile-buffer transport: transferable ArrayBuffer (one copy per step).

import type { GameState } from './gameState';
import { TileKind } from './gameState';
import { BuildingStatus, createBuildingState } from './buildings/state';
import { getBuildingTemplate } from './buildings/templates';
import { recomputeEducation } from './education';
import type { SimBridge } from './simBridge';
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
  | { type: 'redo_result';  happened: true; bytes: Uint8Array; stats: SimStats; history: WorkerHistoryFlags };

export interface WasmSimBridgeConfig {
  ticksPerSecond?: number;
  /**
   * Factory for the sim Worker — injectable so tests can substitute a fake.
   * Defaults to the real `wasmSim.worker.ts` module Worker.
   */
  createWorker?: () => Worker;
}

export interface WasmInitCommand {
  tool: Tool;
  x: number;
  y: number;
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
  private cmdLog: { tool: Tool; x: number; y: number; strokeId: number }[] = [];
  // Strokes removed from cmdLog by undo, oldest-undone last — so redo can
  // re-append them and a save taken mid-undo replays the right history.
  private redoStrokes: { tool: Tool; x: number; y: number; strokeId: number }[][] = [];
  // Natural terrain snapshot taken at engine-swap time. Rust starts with
  // all-land, so without this, natural water/tree tiles would disappear after
  // the first tile-buffer update.
  private naturalTileKinds: TileKind[] | null = null;
  // Tile indices the player has explicitly modified — exempt from natural override.
  private modifiedTiles = new Set<number>();

  constructor(state: GameState, config: WasmSimBridgeConfig = {}, preloadCommands?: WasmInitCommand[]) {
    // Hold the same reference as main.ts so updateStats / applyTileBuffer
    // mutate the object main.ts renders from. No clone — the Rust sim owns
    // sim state; this.state is only a display mirror.
    this.state = state;
    // Snapshot current tile kinds as the natural terrain baseline. Rust
    // GameState::new starts all-land, so the first tile-buffer update would
    // erase any Water/Tree tiles from the TS terrain generator. We preserve
    // them for all tiles the player hasn't explicitly touched.
    this.naturalTileKinds = state.tiles.map(t => t.kind);
    // Seed the log with the replayed history so subsequent swaps carry the
    // full command history, not just commands added after this init.
    if (preloadCommands) {
      // Preloaded history predates this session's strokes — stroke 0.
      this.cmdLog = preloadCommands.map(c => ({ ...c, strokeId: 0 }));
      // Every replayed command position is player-modified — don't override those.
      for (const cmd of preloadCommands) {
        this.modifiedTiles.add(cmd.y * state.width + cmd.x);
      }
    }
    this.worker =
      config.createWorker?.() ??
      new Worker(new URL('../workers/wasmSim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
      this.handleWorkerMsg(e.data);
    };
    this.worker.postMessage({
      type: 'init',
      payload: {
        width: state.width,
        height: state.height,
        seed: state.seed,
        terrain: this.terrainBytes(),
        commands: preloadCommands?.map(c => ({ tool: TOOL_TO_U8[c.tool], x: c.x, y: c.y })),
        money: preloadCommands ? state.money : undefined,
        targetTick: preloadCommands ? state.tick : undefined,
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
          this.cmdLog.push({ tool: cmd.tool, x: cmd.x, y: cmd.y, strokeId: cmd.strokeId });
          this.redoStrokes = [];
          this.modifiedTiles.add(cmd.y * this.state.width + cmd.x);
          this.worker.postMessage({
            type: 'apply_tool',
            payload: { tool: TOOL_TO_U8[cmd.tool], x: cmd.x, y: cmd.y, strokeId: cmd.strokeId },
          });
        }
        break;
      case 'SetSpeed':
        this.setSpeed(cmd.multiplier);
        break;
      case 'LoadState':
        if (this.ready) {
          this.worker.postMessage({
            type: 'reset',
            payload: {
              width: this.state.width,
              height: this.state.height,
              seed: cmd.seed,
              terrain: this.terrainBytes(),
            },
          });
        }
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

  loadState(state: GameState, cmdLog?: { tool: import('./toolTypes').Tool; x: number; y: number }[]): void {
    this.state = state;
    this.pendingTileBuffer = null;
    this.pendingStats = null;
    // The loaded save is the new undo floor — session history does not
    // survive a load (the worker clears the engine history too).
    this.redoStrokes = [];
    this.syncHistoryFlags({ canUndo: false, canRedo: false });
    // Re-snapshot natural terrain from the loaded state so water/tree tiles survive
    // the first tile-buffer update from the replayed WASM.
    this.naturalTileKinds = state.tiles.map(t => t.kind);
    if (cmdLog?.length && this.ready) {
      // Loaded history predates this session's strokes — stroke 0.
      this.cmdLog = cmdLog.map(c => ({ ...c, strokeId: 0 }));
      this.modifiedTiles = new Set(cmdLog.map(c => c.y * state.width + c.x));
      this.worker.postMessage({
        type: 'load',
        payload: {
          width: state.width,
          height: state.height,
          seed: state.seed,
          terrain: this.terrainBytes(),
          commands: cmdLog.map(c => ({ tool: TOOL_TO_U8[c.tool], x: c.x, y: c.y })),
          money: state.money,
          targetTick: state.tick,
          policies: state.policies,
        },
      });
    } else {
      this.cmdLog = [];
      this.modifiedTiles = new Set();
      if (this.ready) {
        this.worker.postMessage({
          type: 'reset',
          payload: {
            width: state.width,
            height: state.height,
            seed: state.seed,
            terrain: this.terrainBytes(),
          },
        });
        this.worker.postMessage({ type: 'set_policies', payload: state.policies });
      }
    }
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

  getCommandLog() {
    return this.cmdLog.map(({ tool, x, y }) => ({ tool, x, y }));
  }

  // Returns null until Option B (Rust building_metadata() export) is implemented.
  getMetadata() { return null; }

  dispose(): void {
    this.worker.terminate();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Natural terrain baseline as TileKind u8 bytes for the worker payloads. */
  private terrainBytes(): Uint8Array | undefined {
    if (this.naturalTileKinds === null) return undefined;
    const bytes = new Uint8Array(this.naturalTileKinds.length);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = tileKindToU8(this.naturalTileKinds[i]);
    }
    return bytes;
  }

  private handleWorkerMsg(msg: WorkerToMain): void {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
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
          // Rust undoes a whole stroke at once — mirror that by moving every
          // trailing cmdLog entry of the last stroke onto the redo pile, so a
          // save/engine-swap replays exactly the surviving history.
          this.redoStrokes.push(this.popLastStroke());
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
          const stroke = this.redoStrokes.pop() ?? [];
          for (const entry of stroke) {
            this.cmdLog.push(entry);
            this.modifiedTiles.add(entry.y * this.state.width + entry.x);
          }
          this.applyTileBuffer(msg.bytes);
          this.updateStats(msg.stats);
        }
        this.syncHistoryFlags(msg.history);
        this.pendingRedo?.(msg.happened);
        this.pendingRedo = null;
        break;
    }
  }

  /** Remove and return the trailing cmdLog entries sharing the last stroke id. */
  private popLastStroke(): { tool: Tool; x: number; y: number; strokeId: number }[] {
    const stroke: { tool: Tool; x: number; y: number; strokeId: number }[] = [];
    const last = this.cmdLog[this.cmdLog.length - 1];
    if (last === undefined) return stroke;
    while (this.cmdLog.length > 0 && this.cmdLog[this.cmdLog.length - 1].strokeId === last.strokeId) {
      const entry = this.cmdLog.pop()!;
      this.modifiedTiles.delete(entry.y * this.state.width + entry.x);
      stroke.unshift(entry);
    }
    return stroke;
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
        // The engine is seeded with natural terrain at init, so Rust normally
        // reports Water/Tree itself now. This override remains as a fallback
        // for any path where terrain seeding was missed.
        if (
          rustKind === TileKind.Land &&
          this.naturalTileKinds !== null &&
          !this.modifiedTiles.has(i)
        ) {
          const natural = this.naturalTileKinds[i];
          tile.kind = (natural === TileKind.Water || natural === TileKind.Tree)
            ? natural
            : rustKind;
        } else {
          tile.kind = rustKind;
        }
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
    for (let i = 0; i < n; i++) {
      const tile = this.state.tiles[i];
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
      const needsWater = template ? (template.waterUse !== undefined && template.waterUse > 0) : false;
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
