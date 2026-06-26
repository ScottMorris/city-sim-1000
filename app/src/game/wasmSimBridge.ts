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

  constructor(state: GameState, _config: WasmSimBridgeConfig = {}, preloadCommands?: WasmInitCommand[]) {
    // Hold the same reference as main.ts so updateStats / applyTileBuffer
    // mutate the object main.ts renders from. No clone — the Rust sim owns
    // sim state; this.state is only a display mirror.
    this.state = state;
    // Seed the log with the replayed history so subsequent swaps carry the
    // full command history, not just commands added after this init.
    if (preloadCommands) this.cmdLog = [...preloadCommands];
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

  loadState(state: GameState): void {
    this.state = state;
    this.pendingTileBuffer = null;
    this.pendingStats = null;
    if (this.ready) {
      this.worker.postMessage({
        type: 'reset',
        payload: { width: state.width, height: state.height, seed: state.seed },
      });
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
    this.state.budget.netPerDay   = stats.budgetNetPerDay;
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
      const kind = tileKindFromU8(bytes[o.kind + i]);
      if (kind !== undefined) tile.kind = kind;
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
    }
  }
}
