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
import type { SimCommand, CommandResult } from './protocol/commands';
import type { FromSim } from './protocol/events';
import type { SimStats } from '../workers/wasmSim.worker';
import { tileBufferOffsets, decodeHappiness, FLAGS } from './protocol/tileBuffer';
import { tileKindFromU8 } from './protocol/tileKind';
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

type WorkerToMain =
  | { type: 'ready' }
  | { type: 'step_result';  bytes: Uint8Array; stats: SimStats }
  | { type: 'apply_result'; success: boolean }
  | { type: 'undo_result';  happened: false }
  | { type: 'undo_result';  happened: true; bytes: Uint8Array; stats: SimStats };

export interface WasmSimBridgeConfig {
  ticksPerSecond?: number;
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
  private cmdLog: { tool: Tool; x: number; y: number }[] = [];
  // Natural terrain snapshot taken at engine-swap time. Rust starts with
  // all-land, so without this, natural water/tree tiles would disappear after
  // the first tile-buffer update.
  private naturalTileKinds: TileKind[] | null = null;
  // Tile indices the player has explicitly modified — exempt from natural override.
  private modifiedTiles = new Set<number>();

  constructor(state: GameState, _config: WasmSimBridgeConfig = {}, preloadCommands?: WasmInitCommand[]) {
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
      this.cmdLog = [...preloadCommands];
      // Every replayed command position is player-modified — don't override those.
      for (const cmd of preloadCommands) {
        this.modifiedTiles.add(cmd.y * state.width + cmd.x);
      }
    }
    this.worker = new Worker(
      new URL('../workers/wasmSim.worker.ts', import.meta.url),
      { type: 'module' },
    );
    this.worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
      this.handleWorkerMsg(e.data);
    };
    this.worker.postMessage({
      type: 'init',
      payload: {
        width: state.width,
        height: state.height,
        seed: state.seed,
        commands: preloadCommands?.map(c => ({ tool: TOOL_TO_U8[c.tool], x: c.x, y: c.y })),
        money: preloadCommands ? state.money : undefined,
        targetTick: preloadCommands ? state.tick : undefined,
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
          this.cmdLog.push({ tool: cmd.tool, x: cmd.x, y: cmd.y });
          this.modifiedTiles.add(cmd.y * this.state.width + cmd.x);
          this.worker.postMessage({
            type: 'apply_tool',
            payload: { tool: TOOL_TO_U8[cmd.tool], x: cmd.x, y: cmd.y },
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
            payload: { width: this.state.width, height: this.state.height, seed: cmd.seed },
          });
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
    // Re-snapshot natural terrain from the loaded state so water/tree tiles survive
    // the first tile-buffer update from the replayed WASM.
    this.naturalTileKinds = state.tiles.map(t => t.kind);
    if (cmdLog?.length && this.ready) {
      this.cmdLog = [...cmdLog];
      this.modifiedTiles = new Set(cmdLog.map(c => c.y * state.width + c.x));
      this.worker.postMessage({
        type: 'load',
        payload: {
          width: state.width,
          height: state.height,
          seed: state.seed,
          commands: cmdLog.map(c => ({ tool: TOOL_TO_U8[c.tool], x: c.x, y: c.y })),
          money: state.money,
          targetTick: state.tick,
        },
      });
    } else {
      this.cmdLog = [];
      this.modifiedTiles = new Set();
      if (this.ready) {
        this.worker.postMessage({
          type: 'reset',
          payload: { width: state.width, height: state.height, seed: state.seed },
        });
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

  getCommandLog() { return this.cmdLog; }

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
        if (this.speedMult !== 1) {
          this.worker.postMessage({ type: 'set_speed', payload: { multiplier: this.speedMult } });
        }
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
        break;
      case 'undo_result':
        // Discard any pending step_result — it was computed before the undo
        // and would overwrite the rolled-back state on the next frame.
        this.pendingTileBuffer = null;
        this.pendingStats = null;
        if (msg.happened) {
          // Keep cmdLog in sync with Rust's CommandLog so the next bridge swap
          // or save-load doesn't replay the undone command.
          const undone = this.cmdLog.pop();
          if (undone !== undefined) {
            this.modifiedTiles.delete(undone.y * this.state.width + undone.x);
          }
          this.applyTileBuffer(msg.bytes);
          this.updateStats(msg.stats);
        }
        this.pendingUndo?.(msg.happened);
        this.pendingUndo = null;
        break;
    }
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
    b.breakdown.expenses.transport  = stats.budgetExpensesTransport;
    b.breakdown.expenses.buildings  = stats.budgetExpensesBuildings;
    b.breakdown.details.transport.roads      = stats.budgetMaintRoads;
    b.breakdown.details.transport.rail       = stats.budgetMaintRail;
    b.breakdown.details.transport.powerLines = stats.budgetMaintPowerLines;
    b.breakdown.details.transport.waterPipes = stats.budgetMaintPipes;
    b.breakdown.details.buildings.power      = stats.budgetMaintPower;
    b.breakdown.details.buildings.civic      = stats.budgetMaintCivic;
    b.breakdown.details.buildings.zones      = stats.budgetMaintZones;
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
        // Rust GameState::new starts with all-land; restore natural Water/Tree
        // for tiles the player never explicitly placed on.
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
