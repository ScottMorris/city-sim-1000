// commands.ts — SimCommand, policy clamp/default helpers, and re-exports of the generated BudgetPolicy/WildernessPolicy/Policies/CommandResult.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/**
 * SimCommand — commands flow from the UI into the SimBridge:
 *   WasmSimBridge  — posts them to the Worker
 *   TauriSimBridge — invokes the native plugin
 *
 * Not a mirror of any Rust type: `crates/city-sim-protocol`'s own
 * `SimCommand` drifted from what both bridges actually send (its `ApplyTool`
 * never gained `strokeId`) and was deleted as dead code. `BudgetPolicy`,
 * `WildernessPolicy`, `LightingPolicy`, `Policies`, and `CommandResult` below
 * are re-exports of the `ts-rs`-generated mirrors of the same names in
 * `crates/city-sim-protocol/src/commands.rs` (`./generated/`) — see
 * `crates/city-sim-protocol/tests/export_bindings.rs`. Hand-mirrored copies
 * of these shapes drifted three times in this repo's history before codegen
 * replaced them; do not reintroduce a hand-written copy.
 */

import { Tool } from '../toolTypes';
import type { ViewStratum } from '../gameState';

export type { BudgetPolicy } from './generated/BudgetPolicy';
export type { WildernessPolicy } from './generated/WildernessPolicy';
export type { LightingPolicy } from './generated/LightingPolicy';
export type { Policies } from './generated/Policies';
export type { CommandResult } from './generated/CommandResult';

import type { BudgetPolicy } from './generated/BudgetPolicy';
import type { WildernessPolicy } from './generated/WildernessPolicy';
import type { LightingPolicy } from './generated/LightingPolicy';
import type { Policies } from './generated/Policies';

/**
 * Neutral tax rate and legal ranges for `BudgetPolicy` fields — not
 * `#[ts(export)]`-able (`ts-rs` mirrors types, not `const` values), so these
 * stay hand-mirrored against `crates/city-sim-protocol/src/commands.rs`'s
 * `NEUTRAL_TAX_RATE`/`MAX_TAX_RATE`/`MAX_FUNDING`.
 */
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

/** Wilderness score required before Nature Reserve can be enabled. */
export const NATURE_RESERVE_UNLOCK_SCORE = 60;

export function createDefaultWildernessPolicy(): WildernessPolicy {
  return { natureReserve: false, greenIndustry: false };
}

/**
 * Neutral lighting bylaw — mirrors `LightingPolicy::default()` (Rust). Kept
 * as a bare literal here (rather than importing `bylaws.ts`'s display table)
 * the same way `createDefaultWildernessPolicy` doesn't reach into a domain
 * file for its defaults.
 */
export const DEFAULT_LIGHTING_POLICY: LightingPolicy = 'mixed';

/**
 * Default-on so toggling it off is an opt-out, not an opt-in — mirrors
 * `default_pending_penalty_enabled()` in `crates/city-sim-protocol/src/commands.rs`.
 */
export const DEFAULT_PENDING_PENALTY_ENABLED = true;

export function createDefaultPolicies(): Policies {
  return {
    budget: createDefaultBudgetPolicy(),
    wilderness: createDefaultWildernessPolicy(),
    lighting: DEFAULT_LIGHTING_POLICY,
    pendingPenaltyEnabled: DEFAULT_PENDING_PENALTY_ENABLED
  };
}

/** Clamp every family into its legal ranges. */
export function clampPolicies(policies: Policies): Policies {
  return {
    budget: clampBudgetPolicy(policies.budget),
    wilderness: policies.wilderness,
    lighting: policies.lighting,
    pendingPenaltyEnabled: policies.pendingPenaltyEnabled
  };
}

export type SimCommand =
  | { type: 'ApplyTool'; tool: Tool; x: number; y: number; strokeId: number; stratum: ViewStratum }
  | { type: 'SetSpeed'; multiplier: number }
  | { type: 'SetPolicies'; policies: Policies };

/**
 * `strokeId` groups the many `ApplyTool` commands of one drag-paint gesture
 * into a single undo step — allocate a fresh id per gesture with
 * `nextStrokeId()`, not per painted tile.
 *
 * `stratum` names the layer the player is looking at (see `ViewStratum` in
 * `../gameState`) — every tool but `Tool.Bulldoze` ignores it today, but it
 * travels on every `ApplyTool` command so it is never a client-only setting
 * the engine can't see (`docs/features/layer-scoped-bulldozer.md`).
 */
export function applyToolCmd(
  tool: Tool,
  x: number,
  y: number,
  strokeId: number,
  stratum: ViewStratum
): SimCommand {
  return { type: 'ApplyTool', tool, x, y, strokeId, stratum };
}

let strokeCounter = 0;

/**
 * Allocate a fresh stroke id. Every command source (pointer input, the MCP
 * debug bridge, tests) must share this allocator so ids never collide and
 * commands from different gestures never coalesce into one undo step.
 */
export function nextStrokeId(): number {
  strokeCounter += 1;
  return strokeCounter;
}

export function setPoliciesCmd(policies: Policies): SimCommand {
  return { type: 'SetPolicies', policies: clampPolicies(policies) };
}
