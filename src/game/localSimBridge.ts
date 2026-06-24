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
import type { FromSim } from './protocol/events';
import { Simulation, type SimulationConfig, type SimulationAlert } from './simulation';
import type { SimEvent } from './narrative/types';
import { applyTool } from './tools';
import { Tool } from './toolTypes';

// Map from TS tool enum to the string the Rust Tool enum would send.
// Both sets share the same values — this is identity for now.
const TOOL_PASSTHROUGH: ReadonlySet<Tool> = new Set(Object.values(Tool) as Tool[]);

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
  }

  send(cmd: SimCommand): CommandResult {
    switch (cmd.type) {
      case 'ApplyTool': {
        if (!TOOL_PASSTHROUGH.has(cmd.tool)) {
          return { success: false, message: `Unknown tool: ${cmd.tool}` };
        }
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
        // LoadState by seed only is for the Rust path; TS uses loadState(state).
        return { success: false, message: 'LoadState by seed not supported in LocalSimBridge' };
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
        kind: alertKind(alert.id),
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
        kind: 'Alert',
        payload: event,
      },
    });
  }
}

/** Map a SimulationAlert id prefix to a FromSim AlertKind. */
function alertKind(id: string): import('./protocol/events').AlertKind {
  if (id.startsWith('power-deficit'))   return 'PowerDeficit';
  if (id.startsWith('power-restored'))  return 'PowerRestored';
  if (id.startsWith('water-deficit'))   return 'WaterDeficit';
  if (id.startsWith('water-restored'))  return 'WaterRestored';
  if (id.startsWith('budget'))          return 'BudgetWarning';
  if (id.startsWith('abandon'))         return 'Abandonment';
  return 'Info';
}
