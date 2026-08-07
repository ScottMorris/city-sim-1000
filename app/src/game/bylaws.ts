// bylaws.ts — the lighting bylaw's DISPLAY table (labels, ledes, preview arithmetic).
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// The lighting bylaw itself is engine-owned: `state.policies.lighting`
// (`LightingPolicy`, part of `Policies` — see `protocol/commands.ts`) is
// sent to the Rust sim via `SetPolicies`, and the sim is what actually
// applies `powerUseMultiplier`/`maintenanceMultiplier` to civic + zone power
// draw and maintenance, and `happinessMultiplier` to the wilderness-driven
// happiness-drift target (`LightingPolicy::power_use_multiplier`/
// `maintenance_multiplier`/`happiness_multiplier` in
// `crates/city-sim-protocol/src/commands.rs`). This file only carries the
// numbers back out for display — labels, ledes, and `previewLightingPolicy`'s
// display-time arithmetic for a policy that ISN'T active yet. The multipliers
// below must stay numerically identical to the Rust source of truth; nothing
// enforces that automatically (`ts-rs` mirrors types, not `const` values), so
// a change to one must be mirrored by hand in the other —
// `commands::tests::non_default_lighting_policies_are_not_neutral` pins the
// Rust side against these exact numbers.

import { DEFAULT_LIGHTING_POLICY, type LightingPolicy } from './protocol/commands';

export type { LightingPolicy };
export { DEFAULT_LIGHTING_POLICY };

const LIGHTING_POLICY_IDS: readonly LightingPolicy[] = ['mixed', 'efficient', 'carbonArc'];

/** Type guard for a value decoded from JSON (a save file) rather than the wire. */
export function isLightingPolicy(value: unknown): value is LightingPolicy {
  return typeof value === 'string' && (LIGHTING_POLICY_IDS as readonly string[]).includes(value);
}

/**
 * Migration: both the pre-CSAV legacy JSON format and CSAV client JSON saved
 * before the lighting bylaw moved into engine `Policies` carried
 * `bylaws: { lighting }`. `ClientState` no longer declares that field, but a
 * loaded save's raw parsed JSON may still carry it — extract it (if present
 * and legal) so the caller can fold it into a one-time `SetPolicies`, the
 * same way `persistence.ts`'s `transcodeLegacySave` already folds a legacy
 * `budgetPolicy`/`wildernessPolicy` into `policies`.
 */
export function extractLegacyLightingPolicy(raw: unknown): LightingPolicy | undefined {
  const bylaws = (raw as { bylaws?: { lighting?: unknown } } | null | undefined)?.bylaws;
  const lighting = bylaws?.lighting;
  return isLightingPolicy(lighting) ? lighting : undefined;
}

export interface LightingPolicyDefinition {
  id: LightingPolicy;
  label: string;
  lede: string;
  /** Mirrors `LightingPolicy::power_use_multiplier` (Rust) — display only. */
  powerUseMultiplier: number;
  /** Mirrors `LightingPolicy::maintenance_multiplier` (Rust) — display only. */
  maintenanceMultiplier: number;
  /**
   * Mirrors `LightingPolicy::happiness_multiplier` (Rust) — display only.
   * A real mechanism now: `wilderness::apply_happiness_drift` scales the
   * wilderness-driven happiness-drift target by this multiplier before
   * zone tiles drift toward it, so a non-`Mixed` bylaw shifts mood, not
   * just power draw and maintenance. These three numbers must stay
   * numerically identical to the Rust source of truth — see the module
   * doc comment at the top of this file.
   */
  happinessMultiplier: number;
}

export const LIGHTING_POLICIES: Record<LightingPolicy, LightingPolicyDefinition> = {
  mixed: {
    id: 'mixed',
    label: 'Mixed corridors',
    lede: 'Blend LED retrofits with heritage lamps to preview demand before carving districts.',
    powerUseMultiplier: 1,
    maintenanceMultiplier: 1,
    happinessMultiplier: 1
  },
  efficient: {
    id: 'efficient',
    label: 'Energy-efficient lighting',
    lede: 'LED-first rollout trims upkeep and power draw for civic and zoned lots.',
    powerUseMultiplier: 0.82,
    maintenanceMultiplier: 0.9,
    happinessMultiplier: 0.94
  },
  carbonArc: {
    id: 'carbonArc',
    label: 'Carbon-arc lamps',
    lede: 'Nostalgic lamps pull more power but add ambience in busy corridors.',
    powerUseMultiplier: 1.18,
    maintenanceMultiplier: 1.05,
    happinessMultiplier: 1.10
  }
};

export interface LightingPreview {
  powerUse: number;
  powerUseDelta: number;
  maintenance: number;
  maintenanceDelta: number;
}

/**
 * Preview what `candidate` would cost, computed at display time from the
 * engine's already-applied wire figures (`appliedPowerUse`/
 * `appliedMaintenance` — the real numbers `state.utilities.powerUsed` and
 * `state.budget.breakdown.details.buildings.civic + .zones` carry under
 * `current`) and the known multiplier ratio between `current` and
 * `candidate`. This is display-time arithmetic on wire values, never a
 * re-simulation — the engine remains the sole source of the *applied*
 * numbers; this only rescales them to preview a policy that isn't active.
 *
 * `powerUseDelta`/`maintenanceDelta` are `candidate − current` (applied), so
 * they read naturally as "what would switching to this option change" —
 * negative multipliers cancel out, so the recovered baseline before
 * rescaling is exact when `appliedPowerUse`/`appliedMaintenance` are the
 * genuine engine outputs.
 */
export function previewLightingPolicy(
  current: LightingPolicy,
  candidate: LightingPolicy,
  appliedPowerUse: number,
  appliedMaintenance: number
): LightingPreview {
  const currentDef = LIGHTING_POLICIES[current];
  const candidateDef = LIGHTING_POLICIES[candidate];
  const basePowerUse = appliedPowerUse / currentDef.powerUseMultiplier;
  const baseMaintenance = appliedMaintenance / currentDef.maintenanceMultiplier;
  const powerUse = basePowerUse * candidateDef.powerUseMultiplier;
  const maintenance = baseMaintenance * candidateDef.maintenanceMultiplier;
  return {
    powerUse,
    powerUseDelta: powerUse - appliedPowerUse,
    maintenance,
    maintenanceDelta: maintenance - appliedMaintenance
  };
}

/**
 * Wilderness programme pricing shown in the Bylaws modal — mirrors
 * `WildernessTunables::default()`'s `reserve_cost_per_day` and
 * `green_industry_subsidy_per_zone` (`crates/city-sim-core/src/wilderness.rs`).
 * Pinned against the Rust values via `wireParity.json` (`wireParity.test.ts`).
 * Named here, not left as bare literals in `bylawsModal.ts`, for the same
 * reason `NATURE_RESERVE_UNLOCK_SCORE` isn't either.
 */
export const NATURE_RESERVE_COST_PER_DAY = 100;
export const GREEN_INDUSTRY_SUBSIDY_PER_ZONE = 2;
