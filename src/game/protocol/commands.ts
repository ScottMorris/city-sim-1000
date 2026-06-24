/**
 * SimCommand — TS mirror of crates/sim_protocol/src/commands.rs.
 *
 * Commands flow from the UI into the SimBridge. LocalSimBridge executes them
 * against the TS Simulation; WasmSimBridge posts them to the Worker.
 */

import { Tool } from '../toolTypes';

export type SimCommand =
  | { type: 'ApplyTool'; tool: Tool; x: number; y: number }
  | { type: 'SetSpeed'; multiplier: number }
  | { type: 'LoadState'; seed: number };

export interface CommandResult {
  success: boolean;
  message?: string;
}

export function applyToolCmd(tool: Tool, x: number, y: number): SimCommand {
  return { type: 'ApplyTool', tool, x, y };
}
