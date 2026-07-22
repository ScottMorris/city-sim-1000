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
 *   • Tile buffer carries TileKind only — per-tile power/water/happiness
 *     stats are absent until the Rust sim serialises them (P3+).
 */

import type { GameState, Tile } from './gameState';
import type { SimBridge } from './simBridge';
import type { SimCommand, CommandResult } from './protocol/commands';
import type { FromSim } from './protocol/events';
import { tileKindFromU8, tileKindToU8 } from './protocol/tileKind';
import { Tool } from './toolTypes';
import {
  start as pluginStart,
  applyTool as pluginApplyTool,
  setSpeed as pluginSetSpeed,
  setPolicies as pluginSetPolicies,
  setNaturalTerrain as pluginSetNaturalTerrain,
  stop as pluginStop,
  undoLastCommand as pluginUndoLastCommand,
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
};

// ---------------------------------------------------------------------------
// TauriSimBridge
// ---------------------------------------------------------------------------

export class TauriSimBridge implements SimBridge {
  private state: GameState;
  private handler: ((msg: FromSim) => void) | null = null;

  constructor(state: GameState) {
    this.state = structuredClone(state);
    void this.startPlugin(this.state);
  }

  // step() is a no-op: the Rust thread runs at its own 20 Hz cadence and
  // pushes TickEvents asynchronously. The main loop still calls step() each
  // rAF frame so the SimBridge contract is satisfied.
  step(_dt: number): void {}

  send(cmd: SimCommand): CommandResult {
    switch (cmd.type) {
      case 'ApplyTool': {
        const id = TOOL_TO_ID[cmd.tool];
        void pluginApplyTool(id, cmd.x, cmd.y);
        // Optimistic: the Rust side will reject invalid placements silently;
        // a proper async result is deferred to P5 when we wire CommandResult
        // events back through the Channel.
        return { success: true };
      }
      case 'SetSpeed':
        void pluginSetSpeed(cmd.multiplier);
        return { success: true };
      case 'LoadState':
        // Seed-only restart; full GameState load arrives in P5-1.
        void this.restartPlugin(this.state.width, this.state.height, cmd.seed);
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

  loadState(state: GameState): void {
    this.state = structuredClone(state);
    void this.restartPlugin(state.width, state.height, state.seed);
  }

  setSpeed(multiplier: number): void {
    void pluginSetSpeed(multiplier);
  }

  undo(): Promise<boolean> {
    return pluginUndoLastCommand();
  }

  dispose(): void {
    void pluginStop();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  // Tauri bridge is not swappable, so no command log is needed.
  getCommandLog() { return null; }

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
      terrain[i] = tileKindToU8(state.tiles[i].kind);
    }
    await pluginSetNaturalTerrain(terrain);
    await pluginSetPolicies(state.policies);
  }

  private onTick(event: TickEvent): void {
    const s = this.state;

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

    // Tile kinds — resize the tiles array if dimensions changed
    const n = event.width * event.height;
    if (s.tiles.length !== n) {
      s.width  = event.width;
      s.height = event.height;
      const fallback = s.tiles[0]?.kind ?? 'land';
      s.tiles = Array.from({ length: n }, () => ({ kind: fallback } as Tile));
    }
    for (let i = 0; i < n; i++) {
      const kind = tileKindFromU8(event.tiles[i]);
      if (kind !== undefined) {
        s.tiles[i].kind = kind;
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
