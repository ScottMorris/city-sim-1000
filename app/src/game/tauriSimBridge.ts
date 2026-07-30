// tauriSimBridge.ts — SimBridge backed by the native Rust simulation via Tauri IPC.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/**
 * TauriSimBridge — implements SimBridge by routing through the native Rust
 * simulation via the `tauri-plugin-city-sim` Tauri v2 plugin (P4-1).
 *
 * The Rust sim runs in a background thread at 20 Hz and streams TickEvents
 * over a Tauri IPC Channel. This bridge:
 *   • Maintains a local GameState mirror updated on each TickEvent.
 *   • Translates SimCommands to plugin invoke calls (fire-and-forget).
 *   • Emits TickStats FromSim messages so the UI contract is symmetric.
 *
 * Activation: `?bridge=tauri` in the URL, or when running inside a Tauri
 * shell (window.__TAURI_INTERNALS__ present).
 *
 * Limitations (Phase 4; lifted in Phase 5):
 *   • loadState() restarts the sim from scratch (seed-only); full GameState
 *     serialisation arrives in P5-1.
 *   • The tick payload carries terrain/occupants/POWERED/WATERED/ABANDONED
 *     per tile (see `TickEvent.tiles` in `guest-js/index.ts`), but not
 *     happiness, elevation, wilderness or per-tile `building_id` — those
 *     still need the Rust sim to serialise them (P3+).
 *   • Because per-tile `building_id` is absent, `tile.buildingId` is never
 *     set on this path — anything keyed off it (a developed zone lot's
 *     `isDevelopedZone` check, the HUD tile inspector) silently sees an
 *     undeveloped tile. `event.buildings` (id/kind/origin, no footprint)
 *     isn't enough on its own to fix this; it would need `building_id` on
 *     the wire too.
 */

import type { GameState, Tile } from './gameState';
import { TileKind } from './gameState';
import type { SimBridge } from './simBridge';
import type { SimCommand, CommandResult } from './protocol/commands';
import type { FromSim } from './protocol/events';
import { tileKindToU8 } from './protocol/tileKind';
import { Terrain, ZoneDensity } from './protocol/occupants';
import { STATUS } from './protocol/tileBuffer';
import { createTileServiceState } from './services';
import { Tool } from './toolTypes';
import {
  start as pluginStart,
  applyTool as pluginApplyTool,
  setSpeed as pluginSetSpeed,
  setPolicies as pluginSetPolicies,
  setNaturalTerrain as pluginSetNaturalTerrain,
  stop as pluginStop,
  undo as pluginUndo,
  redo as pluginRedo,
  getSnapshot as pluginGetSnapshot,
  loadSnapshot as pluginLoadSnapshot,
  importLegacy as pluginImportLegacy,
  TOOL_ID,
  type ToolId,
  type TickEvent,
} from 'tauri-plugin-city-sim';

// ---------------------------------------------------------------------------
// Tool mapping: TS Tool string enum → plugin u8 discriminant
// ---------------------------------------------------------------------------

const TOOL_TO_ID: Record<Tool, ToolId> = {
  [Tool.Inspect]:          TOOL_ID.Inspect,
  [Tool.TerraformRaise]:   TOOL_ID.TerraformRaise,
  [Tool.TerraformLower]:   TOOL_ID.TerraformLower,
  [Tool.Water]:            TOOL_ID.Water,
  [Tool.Tree]:             TOOL_ID.Tree,
  [Tool.Road]:             TOOL_ID.Road,
  [Tool.Rail]:             TOOL_ID.Rail,
  [Tool.PowerLine]:        TOOL_ID.PowerLine,
  [Tool.HydroPlant]:       TOOL_ID.HydroPlant,
  [Tool.CoalPlant]:        TOOL_ID.CoalPlant,
  [Tool.WindTurbine]:      TOOL_ID.WindTurbine,
  [Tool.SolarFarm]:        TOOL_ID.SolarFarm,
  [Tool.WaterPump]:        TOOL_ID.WaterPump,
  [Tool.WaterTower]:       TOOL_ID.WaterTower,
  [Tool.WaterPipe]:        TOOL_ID.WaterPipe,
  [Tool.ElementarySchool]: TOOL_ID.ElementarySchool,
  [Tool.HighSchool]:       TOOL_ID.HighSchool,
  [Tool.Residential]:      TOOL_ID.Residential,
  [Tool.Commercial]:       TOOL_ID.Commercial,
  [Tool.Industrial]:       TOOL_ID.Industrial,
  [Tool.Park]:             TOOL_ID.Park,
  [Tool.Bulldoze]:         TOOL_ID.Bulldoze,
  [Tool.ParkLarge]:        TOOL_ID.ParkLarge,
};

// ---------------------------------------------------------------------------
// TauriSimBridge
// ---------------------------------------------------------------------------

export class TauriSimBridge implements SimBridge {
  private state: GameState;
  private handler: ((msg: FromSim) => void) | null = null;
  private canUndoFlag = false;
  private canRedoFlag = false;
  // Set on every onTick — the native thread pushes TickEvents at its own
  // 20 Hz cadence regardless of pause state (mirrors the WASM worker), so
  // this doesn't distinguish "paused, nothing changed" from "just ticked";
  // it's a conservative "always redraw" signal for this bridge rather than
  // the finer-grained tick/mutationSeq check WasmSimBridge does. Correct,
  // just without the render-skip's savings on this path.
  private dirty = false;

  constructor(state: GameState) {
    this.state = structuredClone(state);
    void this.startPlugin(this.state);
  }

  // The Rust thread runs at its own 20 Hz cadence and pushes TickEvents
  // asynchronously (onTick, below) — this per-frame call just reports
  // whether the mirror changed since the last call, via the `dirty` flag
  // onTick sets.
  step(_dt: number): boolean {
    const changed = this.dirty;
    this.dirty = false;
    return changed;
  }

  send(cmd: SimCommand): CommandResult {
    switch (cmd.type) {
      case 'ApplyTool': {
        const id = TOOL_TO_ID[cmd.tool];
        void pluginApplyTool(id, cmd.x, cmd.y, cmd.strokeId);
        // Optimistic: the Rust side will reject invalid placements silently;
        // a proper async result is deferred to P5 when we wire CommandResult
        // events back through the Channel.
        return { success: true };
      }
      case 'SetSpeed':
        void pluginSetSpeed(cmd.multiplier);
        return { success: true };
      case 'SetPolicies':
        this.state.policies = cmd.policies;
        void pluginSetPolicies(cmd.policies);
        return { success: true };
    }
  }

  onMessage(handler: (msg: FromSim) => void): void {
    this.handler = handler;
  }

  getState(): GameState {
    return this.state;
  }

  getSnapshot(): Promise<Uint8Array> {
    return pluginGetSnapshot();
  }

  async loadSnapshot(bytes: Uint8Array): Promise<void> {
    await pluginLoadSnapshot(bytes);
  }

  async importLegacy(imp: import('./simBridge').LegacyEngineImport): Promise<void> {
    await pluginImportLegacy(imp);
  }

  async newCity(fresh: GameState): Promise<void> {
    this.state = structuredClone(fresh);
    await this.restartPlugin(fresh.width, fresh.height, fresh.seed);
  }

  setSpeed(multiplier: number): void {
    void pluginSetSpeed(multiplier);
  }

  undo(): Promise<boolean> {
    return pluginUndo();
  }

  redo(): Promise<boolean> {
    return pluginRedo();
  }

  canUndo(): boolean { return this.canUndoFlag; }

  canRedo(): boolean { return this.canRedoFlag; }

  dispose(): void {
    void pluginStop();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  // Returns null until Option B (Rust building_metadata() export) is implemented.
  getMetadata() { return null; }

  private async startPlugin(state: GameState): Promise<void> {
    await pluginStart(state.width, state.height, state.seed, (event) =>
      this.onTick(event),
    );
    await this.seedEngine(state);
    this.handler?.({ type: 'Ready' });
  }

  private async restartPlugin(width: number, height: number, seed: number): Promise<void> {
    await pluginStart(width, height, seed, (event) => this.onTick(event));
    await this.seedEngine(this.state);
  }

  /** Push natural terrain and both policies into a freshly started engine. */
  private async seedEngine(state: GameState): Promise<void> {
    const terrain = new Uint8Array(state.tiles.length);
    for (let i = 0; i < terrain.length; i++) {
      terrain[i] = tileKindToU8(state.tiles[i].terrain === Terrain.Water ? TileKind.Water : TileKind.Land);
    }
    await pluginSetNaturalTerrain(terrain);
    await pluginSetPolicies(state.policies);
  }

  private onTick(event: TickEvent): void {
    const s = this.state;
    this.dirty = true;

    // Stats
    s.tick       = event.tick;
    s.day        = event.day;
    s.population = event.population;
    s.jobs       = event.jobs;
    s.money      = event.money;

    // Utility balances
    s.utilities.power         = event.power;
    s.utilities.water         = event.water;
    s.utilities.powerProduced = event.powerProduced;
    s.utilities.waterProduced = event.waterProduced;
    // Derived consumed = produced - balance
    s.utilities.powerUsed = event.powerProduced - event.power;
    s.utilities.waterUsed = event.waterProduced - event.water;

    // Demand
    s.demand.residential = event.demandResidential;
    s.demand.commercial  = event.demandCommercial;
    s.demand.industrial  = event.demandIndustrial;

    // Wilderness (breakdown stays zeroed on desktop until TickEvent carries it,
    // matching the budget breakdown limitation above)
    s.wilderness.score = event.wildernessScore;
    s.wilderness.trend = event.wildernessTrend;

    // Undo/redo availability — emit HistoryChanged on transitions only.
    if (event.canUndo !== this.canUndoFlag || event.canRedo !== this.canRedoFlag) {
      this.canUndoFlag = event.canUndo;
      this.canRedoFlag = event.canRedo;
      this.handler?.({
        type: 'HistoryChanged',
        data: { canUndo: event.canUndo, canRedo: event.canRedo }
      });
    }

    // Tiles — resize the array if dimensions changed
    const n = event.width * event.height;
    if (s.tiles.length !== n) {
      s.width  = event.width;
      s.height = event.height;
      s.tiles = Array.from({ length: n }, () => makeBlankTile());
    }

    for (let i = 0; i < n; i++) {
      const tile = s.tiles[i];
      const base = i * 4;
      tile.underground = event.tiles[base];
      tile.surface = event.tiles[base + 1] << 3;
      tile.overhead = event.tiles[base + 2] << 9;
      const status = event.tiles[base + 3];
      tile.terrain = (status & STATUS.WATER_TERRAIN) !== 0 ? Terrain.Water : Terrain.Land;
      tile.powered = (status & STATUS.POWERED) !== 0;
      tile.watered = (status & STATUS.WATERED) !== 0;
      tile.abandoned = (status & STATUS.ABANDONED) !== 0;
      tile.density = ((status & STATUS.DENSITY_MASK) >> STATUS.DENSITY_SHIFT) as ZoneDensity;
    }

    // Forward TickStats to the UI handler
    this.handler?.({
      type: 'TickStats',
      data: {
        tick:         event.tick,
        day:          event.day,
        money:        event.money,
        population:   event.population,
        jobs:         event.jobs,
        powerBalance: event.power,
        waterBalance: event.water,
      },
    });
  }
}

/** A bare land tile, for growing the mirror array when dimensions change — immediately overwritten by the decode loop. */
function makeBlankTile(): Tile {
  return {
    elevation: 0,
    happiness: 1,
    powered: false,
    watered: false,
    services: createTileServiceState(),
    terrain: Terrain.Land,
    underground: 0,
    surface: 0,
    overhead: 0,
    density: ZoneDensity.Low
  };
}
