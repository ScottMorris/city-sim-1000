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
 *
 * The tick payload (`TickEvent.tiles` in `guest-js/index.ts`) is the exact
 * SoA wire buffer `city_sim_protocol::tile_buffer` describes — the same
 * format and decode helpers (`protocol/tileBuffer.ts`'s `decodeTileBuffer`)
 * the WASM path uses, including per-tile `building_id`. No client-side
 * derivation: `tile.buildingId` is read straight off the wire, the same as
 * WASM, not re-painted from `event.buildings` and a TS template footprint
 * that could disagree with the engine's own.
 */

import type { GameState, Tile, ViewStratum } from './gameState';
import { TileKind } from './gameState';
import { BuildingStatus, createBuildingState } from './buildings/state';
import { getBuildingTemplate } from './buildings/templates';
import { recomputeEducation } from './education';
import type { SimBridge } from './simBridge';
import type { SimCommand, CommandResult } from './protocol/commands';
import type { FromSim } from './protocol/events';
import { tileKindFromU8, tileKindToU8 } from './protocol/tileKind';
import { Occupant, Terrain, ZoneDensity, hasOccupant } from './protocol/occupants';
import { decodeTileBuffer } from './protocol/tileBuffer';
import { deriveNarrativeEventFromAlert } from './protocol/deficitNarrative';
import { createTileServiceState } from './services';
import { Tool } from './toolTypes';
import { footprintTouchesWater } from './adjacency';
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
  VIEW_STRATUM_ID,
  type ViewStratumId,
  type TickEvent,
} from 'tauri-plugin-city-sim';

/**
 * Every plugin call `TauriSimBridge` makes, as one injectable bundle.
 *
 * Mirrors `WasmSimBridgeConfig`'s `createWorker` seam: the real plugin
 * bindings go through Tauri's `invoke`/`Channel`, unusable outside a Tauri
 * shell (and requiring `dist-js/` to be built), so tests substitute fakes
 * here directly instead of mocking the `tauri-plugin-city-sim` module
 * specifier — which would otherwise force every test runner to resolve the
 * real package regardless of the substitution.
 */
export interface TauriPluginBindings {
  start: typeof pluginStart;
  applyTool: typeof pluginApplyTool;
  setSpeed: typeof pluginSetSpeed;
  setPolicies: typeof pluginSetPolicies;
  setNaturalTerrain: typeof pluginSetNaturalTerrain;
  stop: typeof pluginStop;
  undo: typeof pluginUndo;
  redo: typeof pluginRedo;
  getSnapshot: typeof pluginGetSnapshot;
  loadSnapshot: typeof pluginLoadSnapshot;
  importLegacy: typeof pluginImportLegacy;
}

export interface TauriSimBridgeConfig {
  /** Defaults to the real `tauri-plugin-city-sim` bindings. */
  plugin?: TauriPluginBindings;
}

const REAL_PLUGIN: TauriPluginBindings = {
  start: pluginStart,
  applyTool: pluginApplyTool,
  setSpeed: pluginSetSpeed,
  setPolicies: pluginSetPolicies,
  setNaturalTerrain: pluginSetNaturalTerrain,
  stop: pluginStop,
  undo: pluginUndo,
  redo: pluginRedo,
  getSnapshot: pluginGetSnapshot,
  loadSnapshot: pluginLoadSnapshot,
  importLegacy: pluginImportLegacy,
};

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
// Stratum mapping: TS ViewStratum string union → plugin u8 discriminant
// ---------------------------------------------------------------------------

const STRATUM_TO_ID: Record<ViewStratum, ViewStratumId> = {
  surface:     VIEW_STRATUM_ID.Surface,
  underground: VIEW_STRATUM_ID.Underground,
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
  private plugin: TauriPluginBindings;

  constructor(state: GameState, config: TauriSimBridgeConfig = {}) {
    this.plugin = config.plugin ?? REAL_PLUGIN;
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
        // Optimistic return: `send()` must answer synchronously (SimBridge's
        // interface contract), but the real result comes back from the sim
        // thread over IPC. Forward it once it lands, correlated to this exact
        // call by promise identity ("keyed by stroke" in practice, since each
        // call already carries its own strokeId).
        void this.plugin.applyTool(id, cmd.x, cmd.y, cmd.strokeId, STRATUM_TO_ID[cmd.stratum]).then((result) => {
          this.handler?.({ type: 'CommandResult', success: result.success, message: result.message ?? undefined });
        });
        return { success: true };
      }
      case 'SetSpeed':
        void this.plugin.setSpeed(cmd.multiplier);
        return { success: true };
      case 'SetPolicies':
        this.state.policies = cmd.policies;
        void this.plugin.setPolicies(cmd.policies);
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
    return this.plugin.getSnapshot();
  }

  async loadSnapshot(bytes: Uint8Array): Promise<void> {
    await this.plugin.loadSnapshot(bytes);
  }

  async importLegacy(imp: import('./simBridge').LegacyEngineImport): Promise<void> {
    await this.plugin.importLegacy(imp);
  }

  async newCity(fresh: GameState): Promise<void> {
    this.state = structuredClone(fresh);
    await this.restartPlugin(fresh.width, fresh.height, fresh.seed);
  }

  setSpeed(multiplier: number): void {
    void this.plugin.setSpeed(multiplier);
  }

  undo(): Promise<boolean> {
    return this.plugin.undo();
  }

  redo(): Promise<boolean> {
    return this.plugin.redo();
  }

  canUndo(): boolean { return this.canUndoFlag; }

  canRedo(): boolean { return this.canRedoFlag; }

  dispose(): void {
    void this.plugin.stop();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  // Returns null until Option B (Rust building_metadata() export) is implemented.
  getMetadata() { return null; }

  private async startPlugin(state: GameState): Promise<void> {
    await this.plugin.start(state.width, state.height, state.seed, (event) =>
      this.onTick(event),
    );
    await this.seedEngine(state);
    this.handler?.({ type: 'Ready' });
  }

  private async restartPlugin(width: number, height: number, seed: number): Promise<void> {
    await this.plugin.start(width, height, seed, (event) => this.onTick(event));
    await this.seedEngine(this.state);
  }

  /** Push natural terrain and both policies into a freshly started engine. */
  private async seedEngine(state: GameState): Promise<void> {
    const terrain = new Uint8Array(state.tiles.length);
    for (let i = 0; i < terrain.length; i++) {
      terrain[i] = tileKindToU8(state.tiles[i].terrain === Terrain.Water ? TileKind.Water : TileKind.Land);
    }
    await this.plugin.setNaturalTerrain(terrain);
    await this.plugin.setPolicies(state.policies);
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
    s.utilities.powerComponents = event.powerComponents;
    s.utilities.waterComponents = event.waterComponents;

    // Demand
    s.demand.residential = event.demandResidential;
    s.demand.commercial  = event.demandCommercial;
    s.demand.industrial  = event.demandIndustrial;

    // Aggregate wilderness — the per-category breakdown still stays zeroed
    // on desktop; TickEvent doesn't carry it (matching the loadState()
    // limitation above). Per-tile wilderness is decoded below with the rest
    // of the tile buffer.
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

    // Tile strata, status, happiness, elevation, buildingId and wilderness —
    // one decode shared with the WASM path (`wasmSimBridge.ts`), off the
    // exact same wire buffer `city_sim_core::wire::encode_tile_buffer` writes
    // for both transports.
    decodeTileBuffer(s.tiles, event.tiles);

    // Buildings — rebuild the display mirror from the wire list, mirroring
    // `applyTileBuffer` in `wasmSimBridge.ts`. Tile coverage came from the
    // wire buffer above; `event.buildings` only resolves each `building_id`
    // to its template kind (status gating, the HUD inspector's name).
    // Mirror of the engine's water opt-in gate (`GameState::has_water_system`):
    // until a pump, tower, or pipe exists, buildings don't require water.
    let hasWaterSystem = event.buildings.some((b) => {
      const kind = tileKindFromU8(b.kind);
      return kind === TileKind.WaterPump || kind === TileKind.WaterTower;
    });
    for (let i = 0; i < n && !hasWaterSystem; i++) {
      if (hasOccupant(s.tiles[i].underground, Occupant.Pipe)) hasWaterSystem = true;
    }
    s.buildings = event.buildings.map((b) => {
      const kind = tileKindFromU8(b.kind) ?? TileKind.Land;
      // Derive status from the tile flags the status byte already set —
      // same derivation as the WASM path, for the same reason.
      const originTile = s.tiles[b.originY * s.width + b.originX];
      const template = getBuildingTemplate(kind as string);
      const bstate = createBuildingState();
      const needsPower = template ? template.requiresPower !== false : false;
      const needsWater =
        hasWaterSystem && template !== undefined && template.waterUse !== undefined && template.waterUse > 0;
      // A pump only produces when its footprint touches water terrain (#200)
      // — distinct from needsWater above, which gates a *consumer* on
      // network coverage; a pump doesn't consume water.
      const needsSource = kind === TileKind.WaterPump;
      const origin = { x: b.originX, y: b.originY };
      if (needsPower && !originTile?.powered) {
        bstate.status = BuildingStatus.InactiveNoPower;
      } else if (needsSource && template && !footprintTouchesWater(s, origin, template.footprint)) {
        bstate.status = BuildingStatus.InactiveNoSource;
      } else if (needsWater && !originTile?.watered) {
        bstate.status = BuildingStatus.InactiveNoWater;
      }
      return {
        id: b.id,
        templateId: kind as string,
        origin,
        state: bstate
      };
    });

    // Education coverage keys off the rebuilt buildings list.
    s.education = recomputeEducation(s);

    // Forward any deficit/restore alerts raised this tick, plus each one's
    // paired narrative event — same derivation `wasmSimBridge.ts` uses, kept
    // in one shared helper so the two bridges can't independently drift.
    for (const alert of event.alerts) {
      this.handler?.({ type: 'Alert', data: alert });
      const narrative = deriveNarrativeEventFromAlert(alert, Date.now());
      if (narrative) {
        this.handler?.({ type: 'Narrative', data: { kind: 'Alert', payload: narrative } });
      }
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
