// education.ts — client-side education helpers.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// `#228`: education coverage is computed by `city-sim-core`'s
// `recompute_education` and reaches the client over the wire — see
// `wasmSimBridge.ts`/`tauriSimBridge.ts`. What remains here is a build-preview
// helper that has no engine equivalent to call (it previews a school that
// hasn't been placed yet) plus small readers over `state.education`.

import { getBuildingTemplate } from './buildings/templates';
import type { GameState } from './gameState';
import { ServiceId } from './services';
import { getReachableZoneCandidates } from './serviceDistribution';

export interface EducationStats {
  elementaryServed: number;
  elementaryCapacity: number;
  elementaryLoad: number;
  highServed: number;
  highCapacity: number;
  highLoad: number;
  score: number;
  elementaryCoverage: number;
  highCoverage: number;
}

export function getEducationScore(state: GameState): number {
  return state.education?.score ?? 1;
}

/**
 * Defaults for a city with no schools: no load anywhere means full coverage,
 * not zero — matches `city_sim_core::state::EducationStats::default()`. Used
 * before the first wire update lands (initial state, legacy-save back-fill).
 */
export function createEmptyEducationStats(): EducationStats {
  return {
    elementaryServed: 0,
    elementaryCapacity: 0,
    elementaryLoad: 0,
    highServed: 0,
    highCapacity: 0,
    highLoad: 0,
    score: 1,
    elementaryCoverage: 1,
    highCoverage: 1
  };
}

export function computeEducationReach(
  state: GameState,
  origin: { x: number; y: number },
  templateId: string
): Set<number> {
  const template = getBuildingTemplate(templateId);
  if (!template?.service) return new Set();
  if (
    template.service.id !== ServiceId.EducationElementary &&
    template.service.id !== ServiceId.EducationHigh
  )
    return new Set();
  const candidates = getReachableZoneCandidates(
    state,
    origin,
    template.footprint,
    template.service.coverageRadius
  );
  return new Set(candidates.map(([idx]) => idx));
}
