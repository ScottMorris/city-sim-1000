// localSimBridge.ts — SimBridge backed by the TypeScript simulation engine.
//
// Used as a debug/parity toggle alongside WasmSimBridge. Not imported from
// production code paths; only activated via the in-game "Sim: TS/WASM" toggle.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { GameState } from './gameState';
import type { SimBridge } from './simBridge';
import type { SimCommand, CommandResult } from './protocol/commands';
import type { FromSim, AlertKind, NarrativeKind } from './protocol/events';
import type { BuildingTemplate } from './buildings/templates';
import { POWER_PLANT_TEMPLATES, CIVIC_BUILDING_TEMPLATES, ZONE_BUILDING_TEMPLATES } from './buildings/templates';
import { Simulation, type SimulationConfig, type SimulationAlert } from './simulation';
import type { SimEvent, SimEventType } from './narrative/types';
import { applyTool } from './tools';
import type { Tool } from './toolTypes';

export interface LocalSimBridgeConfig {
  ticksPerSecond: number;
}

// Merged, deduplicated template catalogue — built once at module load.
const ALL_TEMPLATES: BuildingTemplate[] = [
  ...Object.values(POWER_PLANT_TEMPLATES),
  ...Object.values(CIVIC_BUILDING_TEMPLATES),
  ...Object.values(ZONE_BUILDING_TEMPLATES),
];

export class LocalSimBridge implements SimBridge {
  private simulation: Simulation;
  private state: GameState;
  private handler: ((msg: FromSim) => void) | null = null;
  private cmdLog: { tool: Tool; x: number; y: number }[] = [];

  constructor(state: GameState, config: LocalSimBridgeConfig) {
    this.state = state;

    const simConfig: SimulationConfig = {
      ticksPerSecond: config.ticksPerSecond,
      notify: (alert: SimulationAlert) => this.forwardAlert(alert),
      onNarrativeEvent: (event: SimEvent) => this.forwardNarrative(event),
    };

    this.simulation = new Simulation(state, simConfig);
  }

  step(dt: number): void {
    this.simulation.update(dt);
    if (this.handler) {
      const s = this.state;
      this.handler({
        type: 'TickStats',
        data: {
          tick: s.tick,
          day: s.day,
          money: s.money,
          population: s.population,
          jobs: s.jobs,
          powerBalance: s.utilities.power,
          waterBalance: s.utilities.water,
        },
      });
    }
  }

  send(cmd: SimCommand): CommandResult {
    switch (cmd.type) {
      case 'ApplyTool': {
        const result = applyTool(this.state, cmd.tool, cmd.x, cmd.y);
        if (result.success) {
          this.cmdLog.push({ tool: cmd.tool, x: cmd.x, y: cmd.y });
        }
        this.handler?.({
          type: 'CommandResult',
          success: result.success,
          message: result.message,
        });
        return result;
      }
      case 'SetSpeed':
        this.simulation.setSpeed(cmd.multiplier);
        return { success: true };
      case 'LoadState':
        return { success: false, message: 'Use loadState(GameState) for LocalSimBridge' };
    }
  }

  onMessage(handler: (msg: FromSim) => void): void {
    this.handler = handler;
    // TS sim is ready synchronously; fire Ready in a microtask so the caller's
    // wireBridge() finishes setting up before the handler is invoked.
    queueMicrotask(() => handler({ type: 'Ready' }));
  }

  getState(): GameState {
    return this.state;
  }

  loadState(state: GameState): void {
    this.state = state;
    this.simulation.setState(state);
  }

  setSpeed(multiplier: number): void {
    this.simulation.setSpeed(multiplier);
  }

  // TS sim does not support command-log undo; resolves false so callers degrade gracefully.
  undo(): Promise<boolean> {
    return Promise.resolve(false);
  }

  getCommandLog(): { tool: Tool; x: number; y: number }[] {
    return this.cmdLog;
  }

  getMetadata(): BuildingTemplate[] {
    return ALL_TEMPLATES;
  }

  dispose(): void {
    // No resources to release for the local in-process bridge.
  }

  // ---------------------------------------------------------------------------
  // Internal forwarding helpers
  // ---------------------------------------------------------------------------

  private forwardAlert(alert: SimulationAlert): void {
    if (!this.handler) return;
    this.handler({
      type: 'Alert',
      data: {
        kind: alertIdToKind(alert.id),
        message: alert.message,
        sticky: alert.sticky ?? false,
      },
    });
  }

  private forwardNarrative(event: SimEvent): void {
    if (!this.handler) return;
    this.handler({
      type: 'Narrative',
      data: {
        kind: simEventTypeToNarrativeKind(event.type),
        payload: event,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers (module-private)
// ---------------------------------------------------------------------------

function alertIdToKind(id: string): AlertKind {
  if (id.startsWith('power-deficit'))  return 'PowerDeficit';
  if (id.startsWith('power-restored')) return 'PowerRestored';
  if (id.startsWith('water-deficit'))  return 'WaterDeficit';
  if (id.startsWith('water-restored')) return 'WaterRestored';
  if (id.startsWith('budget'))         return 'BudgetWarning';
  if (id.startsWith('abandon'))        return 'Abandonment';
  return 'Info';
}

function simEventTypeToNarrativeKind(type: SimEventType): NarrativeKind {
  switch (type) {
    case 'power_deficit_start':
    case 'power_deficit_end':
    case 'water_deficit_start':
    case 'water_deficit_end':
    case 'runway_low':
    case 'runway_recovered':
    case 'abandonment_wave':
    case 'net_flip':
      return 'Alert';
    case 'player_action':
      return 'Milestone';
  }
}
