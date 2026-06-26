/**
 * WasmSimBridge — implements SimBridge by routing through a Web Worker that
 * owns a WASM SimHost.
 *
 * Phase 2 (stub): the WASM SimHost flips tile (1,1) on each step; no real sim
 * logic runs. Activating this bridge with `?bridge=wasm` proves the full
 * Worker → WASM → tile-buffer → renderer pipe works end-to-end.
 *
 * Phase 3: replace the stub SimHost with the ported sim_core engine; remove
 * the LocalSimBridge entirely.
 *
 * Tile-buffer transport: transferable ArrayBuffer (one copy per step).
 * Phase 4: upgrade to SharedArrayBuffer when COOP/COEP headers are confirmed.
 */

import type { GameState } from './gameState';
import type { SimBridge } from './simBridge';
import type { SimCommand, CommandResult } from './protocol/commands';
import type { FromSim } from './protocol/events';
import { tileBufferOffsets } from './protocol/tileBuffer';
import { tileKindFromU8 } from './protocol/tileKind';

type WorkerToMain =
  | { type: 'ready' }
  | { type: 'tile_buffer'; bytes: Uint8Array }
  | { type: 'cmd_result'; bytes: Uint8Array };

export interface WasmSimBridgeConfig {
  ticksPerSecond?: number;
}

export class WasmSimBridge implements SimBridge {
  private state: GameState;
  private worker: Worker;
  private ready = false;
  private handler: ((msg: FromSim) => void) | null = null;
  private speedMult = 1;
  private pendingTileBuffer: Uint8Array | null = null;
  private tickNum = 0;

  constructor(state: GameState, _config: WasmSimBridgeConfig = {}) {
    this.state = structuredClone(state);
    this.worker = new Worker(
      new URL('../workers/wasmSim.worker.ts', import.meta.url),
      { type: 'module' },
    );
    this.worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
      this.handleWorkerMsg(e.data);
    };
    this.worker.postMessage({
      type: 'init',
      payload: { width: state.width, height: state.height },
    });
  }

  step(dt: number): void {
    // Apply tile kinds received from the previous step before advancing.
    if (this.pendingTileBuffer !== null) {
      this.applyTileBuffer(this.pendingTileBuffer);
      this.pendingTileBuffer = null;
    }
    if (!this.ready) return;
    this.tickNum++;
    this.worker.postMessage({ type: 'step', payload: { dt: dt * this.speedMult } });
    // Emit TickStats so the handler contract is symmetric with LocalSimBridge.
    this.handler?.({
      type: 'TickStats',
      data: {
        tick: this.tickNum,
        day: 0,
        money: this.state.money,
        population: this.state.population,
        jobs: this.state.jobs,
        powerBalance: this.state.utilities.power,
        waterBalance: this.state.utilities.water,
      },
    });
  }

  send(cmd: SimCommand): CommandResult {
    // Phase 2 stub: fire-and-forget; return optimistic success.
    // TODO(P3): encode cmd to postcard bytes and await the result.
    void cmd;
    if (this.ready) {
      this.worker.postMessage({ type: 'send', payload: { bytes: new Uint8Array(0) } });
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
    this.state = structuredClone(state);
    // TODO(P3): notify worker to reinitialise with new state.
  }

  setSpeed(multiplier: number): void {
    this.speedMult = multiplier;
  }

  undo(): Promise<boolean> {
    // Undo is not yet implemented for the WASM path — the SimHost is still a
    // stub that does not track a CommandLog. Returns false so the UI shows no
    // "Undone" notification.
    return Promise.resolve(false);
  }

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
        break;
      case 'tile_buffer':
        // Buffer was transferred from the Worker — stash for next step().
        this.pendingTileBuffer = msg.bytes;
        break;
      case 'cmd_result':
        // TODO(P3): surface result to pending send() callers.
        break;
    }
  }

  private applyTileBuffer(bytes: Uint8Array): void {
    const n = this.state.tiles.length;
    const o = tileBufferOffsets(n);
    for (let i = 0; i < n; i++) {
      const kind = tileKindFromU8(bytes[o.kind + i]);
      if (kind !== undefined) {
        this.state.tiles[i].kind = kind;
      }
    }
  }
}
