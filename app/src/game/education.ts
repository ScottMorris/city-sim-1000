// education.ts — client-side education helpers.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// `#228`: education coverage is computed by `city-sim-core`'s
// `recompute_education` and reaches the client over the wire — see
// `wasmSimBridge.ts`/`tauriSimBridge.ts`. What remains here: small readers
// over `state.education`, `servedZoneTiles` (reads the wire's per-tile
// answer for an already-placed school), and `computeEducationReach`, a
// build-preview BFS kept only for the not-yet-placed ghost case, which has
// no engine equivalent to call (`#200`'s wire-adoption follow-up).

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

/**
 * Ghost-preview reach for a school that ISN'T PLACED YET — a client BFS out
 * from the hovered footprint along roads/zones, matching `#228`'s coverage
 * radius. This has no engine equivalent to call: the engine only ever
 * computes coverage for schools that actually exist in `state.buildings`, so
 * a not-yet-placed tool preview is the one case this PR's wire-adoption
 * (`#200`) can't remove — keep it BFS-only. For an ALREADY-PLACED school, use
 * `servedZoneTiles` instead, which reads the engine's own real,
 * capacity-adjusted answer off the wire.
 */
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

/**
 * Tiles the wire already marks as served by `templateId`'s education service
 * — the engine's own, capacity-adjusted answer (`tile.services.served`,
 * `#228`), for an ALREADY-PLACED school. Costs one tile scan, not a BFS, and
 * (unlike `computeEducationReach`) reflects real capacity/overlap between
 * schools, not raw radius reachability. City-wide, not per-building: with
 * more than one school of the same level, this shows every tile education
 * is currently reaching, not just the selected school's own share — the wire
 * has no per-building reach set to narrow it further.
 */
export function servedZoneTiles(state: GameState, templateId: string): Set<number> {
  const template = getBuildingTemplate(templateId);
  const serviceId = template?.service?.id;
  if (serviceId !== ServiceId.EducationElementary && serviceId !== ServiceId.EducationHigh) {
    return new Set();
  }
  const out = new Set<number>();
  for (let i = 0; i < state.tiles.length; i++) {
    if (state.tiles[i].services.served[serviceId]) out.add(i);
  }
  return out;
}
