/**
 * LocalSimBridge — implements SimBridge by wrapping the existing TS Simulation
 * in-process. The game works exactly as before; the bridge is a thin seam.
 *
 * When WasmSimBridge lands (Phase 2) this class either gets swapped out or
 * demoted to a test-only oracle. Until then it is the production path.
 */

import type { GameState } from './gameState';
import type { SimBridge } from './simBridge';
import type { SimCommand, CommandResult } from './protocol/commands';
import type { FromSim, AlertKind, NarrativeKind } from './protocol/events';
import { Simulation, type SimulationConfig, type SimulationAlert } from './simulation';
import type { SimEvent, SimEventType } from './narrative/types';
import { applyTool } from './tools';

export interface LocalSimBridgeConfig {
  ticksPerSecond: number;
}

export class LocalSimBridge implements SimBridge {
  private simulation: Simulation;
  private state: GameState;
  private handler: ((msg: FromSim) => void) | null = null;

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
    // Emit TickStats so the interface contract is symmetric with WasmSimBridge.
    // The main loop currently reads GameState directly, but future bridges won't
    // have that option — establishing the pattern here avoids a breaking change.
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
        // Seed-only load is a Rust-path concern; TS uses loadState(GameState).
        return { success: false, message: 'Use loadState(GameState) for LocalSimBridge' };
    }
  }

  onMessage(handler: (msg: FromSim) => void): void {
    this.handler = handler;
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

/** Map a SimulationAlert id prefix to a protocol AlertKind. */
function alertIdToKind(id: string): AlertKind {
  if (id.startsWith('power-deficit'))  return 'PowerDeficit';
  if (id.startsWith('power-restored')) return 'PowerRestored';
  if (id.startsWith('water-deficit'))  return 'WaterDeficit';
  if (id.startsWith('water-restored')) return 'WaterRestored';
  if (id.startsWith('budget'))         return 'BudgetWarning';
  if (id.startsWith('abandon'))        return 'Abandonment';
  return 'Info';
}

/** Map a SimEventType to the coarser NarrativeKind used on the wire. */
function simEventTypeToNarrativeKind(type: SimEventType): NarrativeKind {
  // Month-end snapshots arrive via onMonthEnd(), not onNarrativeEvent(),
  // so no SimEventType maps to MonthEnd here.
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
