import { BuildingCategory, BuildingStatus, getBuildingTemplate } from './buildings';
import type { GameState } from './gameState';
import { getTile } from './gameState';
import { ServiceId } from './services';
import {
  computeZoneLoads,
  estimateZoneLoad,
  getReachableZoneCandidates,
  DEFAULT_WORKER_SHARE
} from './serviceDistribution';

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

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}
export function recomputeEducation(state: GameState): EducationStats {
  let elementaryLoad = 0;
  let highLoad = 0;
  let elementaryServed = 0;
  let highServed = 0;
  let elementaryCapacity = 0;
  let highCapacity = 0;
  const loads = computeZoneLoads(state, DEFAULT_WORKER_SHARE);

  state.tiles.forEach((tile, idx) => {
    tile.services.served[ServiceId.EducationElementary] = false;
    tile.services.served[ServiceId.EducationHigh] = false;
    tile.services.scores[ServiceId.EducationElementary] = 0;
    tile.services.scores[ServiceId.EducationHigh] = 0;
    elementaryLoad += estimateZoneLoad(idx, tile, ServiceId.EducationElementary, loads);
    highLoad += estimateZoneLoad(idx, tile, ServiceId.EducationHigh, loads);
  });

  for (const building of state.buildings) {
    const template = getBuildingTemplate(building.templateId);
    if (!template?.service) continue;
    if (
      template.service.id !== ServiceId.EducationElementary &&
      template.service.id !== ServiceId.EducationHigh
    )
      continue;
    if (building.state.status !== BuildingStatus.Active) continue;
    const capacity = template.service.capacity ?? 0;
    if (capacity <= 0) continue;

    if (template.service.id === ServiceId.EducationElementary) elementaryCapacity += capacity;
    if (template.service.id === ServiceId.EducationHigh) highCapacity += capacity;

    const candidates = getReachableZoneCandidates(
      state,
      building.origin,
      template.footprint,
      template.service.coverageRadius
    );
    let used = 0;

    for (const [idx] of candidates) {
      if (used >= capacity) break;
      const x = idx % state.width;
      const y = Math.floor(idx / state.width);
      const tile = getTile(state, x, y);
      if (!tile) continue;
      const load = estimateZoneLoad(idx, tile, template.service.id, loads);
      if (load <= 0) continue;
      const remaining = Math.max(0, capacity - used);
      if (remaining <= 0) break;
      const applied = Math.min(load, remaining);
      if (applied <= 0) continue;
      used += applied;
      tile.services.served[template.service.id] = true;
      tile.services.scores[template.service.id] = applied / load;
      if (template.service.id === ServiceId.EducationElementary) {
        elementaryServed += applied;
      } else {
        highServed += applied;
      }
    }

    building.state.serviceLoad.slotsUsed[template.service.id] = used;
  }

  const elementaryCoverage =
    elementaryLoad > 0 ? clamp(elementaryServed / elementaryLoad, 0, 1) : 1;
  const highCoverage = highLoad > 0 ? clamp(highServed / highLoad, 0, 1) : 1;
  const score = clamp(elementaryCoverage * 0.6 + highCoverage * 0.4, 0, 1);

  return {
    elementaryServed,
    elementaryCapacity,
    elementaryLoad,
    highServed,
    highCapacity,
    highLoad,
    score,
    elementaryCoverage,
    highCoverage
  };
}

export function getEducationScore(state: GameState): number {
  return state.education?.score ?? 0;
}

export function createEmptyEducationStats(): EducationStats {
  return {
    elementaryServed: 0,
    elementaryCapacity: 0,
    elementaryLoad: 0,
    highServed: 0,
    highCapacity: 0,
    highLoad: 0,
    score: 0,
    elementaryCoverage: 0,
    highCoverage: 0
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
