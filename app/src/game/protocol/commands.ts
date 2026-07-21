/**
 * SimCommand — TS mirror of crates/sim_protocol/src/commands.rs.
 *
 * Commands flow from the UI into the SimBridge:
 *   WasmSimBridge  — posts them to the Worker
 *   TauriSimBridge — invokes the native plugin
 */

import { Tool } from '../toolTypes';

/**
 * SimCity-style fiscal policy — TS mirror of `BudgetPolicy` in
 * `crates/city-sim-protocol/src/commands.rs`.
 *
 * Tax rates are whole percentages (0–20, neutral default 9 — revenue scales
 * by `rate / 9`). Funding levels are whole percentages (0–100, default 100);
 * underfunding trims upkeep but causes brownouts, crowded schools, and
 * commuter frustration.
 */
export interface BudgetPolicy {
  taxResidential: number;
  taxCommercial: number;
  taxIndustrial: number;
  fundTransport: number;
  fundPower: number;
  fundCivic: number;
}

export const NEUTRAL_TAX_RATE = 9;
export const MAX_TAX_RATE = 20;
export const MAX_FUNDING = 100;

export function createDefaultBudgetPolicy(): BudgetPolicy {
  return {
    taxResidential: NEUTRAL_TAX_RATE,
    taxCommercial: NEUTRAL_TAX_RATE,
    taxIndustrial: NEUTRAL_TAX_RATE,
    fundTransport: MAX_FUNDING,
    fundPower: MAX_FUNDING,
    fundCivic: MAX_FUNDING
  };
}

export function clampBudgetPolicy(policy: BudgetPolicy): BudgetPolicy {
  const clampInt = (value: number, max: number) =>
    Math.max(0, Math.min(max, Math.round(value)));
  return {
    taxResidential: clampInt(policy.taxResidential, MAX_TAX_RATE),
    taxCommercial: clampInt(policy.taxCommercial, MAX_TAX_RATE),
    taxIndustrial: clampInt(policy.taxIndustrial, MAX_TAX_RATE),
    fundTransport: clampInt(policy.fundTransport, MAX_FUNDING),
    fundPower: clampInt(policy.fundPower, MAX_FUNDING),
    fundCivic: clampInt(policy.fundCivic, MAX_FUNDING)
  };
}

/** Revenue multiplier for a tax rate (`rate / 9`, so 9% → 1.0). */
export function taxMultiplier(rate: number): number {
  return rate / NEUTRAL_TAX_RATE;
}

/** Cost/effect multiplier for a funding level (`level / 100`). */
export function fundingMultiplier(level: number): number {
  return level / MAX_FUNDING;
}

export type SimCommand =
  | { type: 'ApplyTool'; tool: Tool; x: number; y: number }
  | { type: 'SetSpeed'; multiplier: number }
  | { type: 'LoadState'; seed: number }
  | { type: 'SetBudgetPolicy'; policy: BudgetPolicy };

export interface CommandResult {
  success: boolean;
  message?: string;
}

export function applyToolCmd(tool: Tool, x: number, y: number): SimCommand {
  return { type: 'ApplyTool', tool, x, y };
}

export function setBudgetPolicyCmd(policy: BudgetPolicy): SimCommand {
  return { type: 'SetBudgetPolicy', policy: clampBudgetPolicy(policy) };
}
