import { BuildingStatus, getBuildingTemplate } from './buildings';
import { getOrthogonalNeighbourCoords, isZone } from './adjacency';
import type { GameState, Tile } from './gameState';
import { getTile, TileKind } from './gameState';
import { ServiceId } from './services';

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

const WORKER_SHARE = 0.55;

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

function isRoadish(tile: Tile | undefined): boolean {
  if (!tile) return false;
  return tile.kind === TileKind.Road || tile.roadUnderlay === true;
}

function estimateEducationLoad(tile: Tile | undefined, serviceId: ServiceId): number {
  if (!tile || !isZone(tile)) return 0;
  const template = getBuildingTemplate(tile.kind);
  if (!template) return 0;
  if (serviceId === ServiceId.EducationElementary) {
    return template.populationCapacity ?? 0;
  }
  if (serviceId === ServiceId.EducationHigh) {
    if (template.jobsCapacity !== undefined) return template.jobsCapacity;
    if (template.populationCapacity !== undefined) return template.populationCapacity * WORKER_SHARE;
  }
  return 0;
}

function gatherReachableZones(
  state: GameState,
  origin: { x: number; y: number },
  footprint: { width: number; height: number },
  radius: number
): Map<number, number> {
  const reachable = new Map<number, number>();
  const queue: Array<{ x: number; y: number; d: number }> = [];
  const visited = new Set<number>();

  for (let dy = 0; dy < footprint.height; dy++) {
    for (let dx = 0; dx < footprint.width; dx++) {
      queue.push({ x: origin.x + dx, y: origin.y + dy, d: 0 });
    }
  }

  const toIndex = (x: number, y: number) => y * state.width + x;

  while (queue.length) {
    const { x, y, d } = queue.shift()!;
    if (d > radius) continue;
    const idx = toIndex(x, y);
    if (visited.has(idx)) continue;
    visited.add(idx);
    const tile = getTile(state, x, y);
    const isRoad = isRoadish(tile);
    const isServedZone = isZone(tile);

    if (isServedZone) {
      const existing = reachable.get(idx);
      reachable.set(idx, existing !== undefined ? Math.min(existing, d) : d);
    }

    // Travel along roads and through zones so interior lots can be served inside a radius.
    if (!isRoad && !isServedZone && d > 0) continue;

    for (const [nx, ny] of getOrthogonalNeighbourCoords(state, x, y)) {
      const nd = d + 1;
      if (nd > radius) continue;
      const neighbour = getTile(state, nx, ny);
      if (isRoadish(neighbour) || isZone(neighbour)) {
        queue.push({ x: nx, y: ny, d: nd });
      }
    }
  }

  return reachable;
}

export function recomputeEducation(state: GameState): EducationStats {
  let elementaryLoad = 0;
  let highLoad = 0;
  let elementaryServed = 0;
  let highServed = 0;
  let elementaryCapacity = 0;
  let highCapacity = 0;

  state.tiles.forEach((tile) => {
    tile.services.served[ServiceId.EducationElementary] = false;
    tile.services.served[ServiceId.EducationHigh] = false;
    tile.services.scores[ServiceId.EducationElementary] = 0;
    tile.services.scores[ServiceId.EducationHigh] = 0;
    elementaryLoad += estimateEducationLoad(tile, ServiceId.EducationElementary);
    highLoad += estimateEducationLoad(tile, ServiceId.EducationHigh);
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

    const reachable = gatherReachableZones(state, building.origin, template.footprint, template.service.coverageRadius);
    const candidates = Array.from(reachable.entries()).sort((a, b) => a[1] - b[1]);
    let used = 0;

    for (const [idx] of candidates) {
      if (used >= capacity) break;
      const x = idx % state.width;
      const y = Math.floor(idx / state.width);
      const tile = getTile(state, x, y);
      if (!tile) continue;
      const load = estimateEducationLoad(tile, template.service.id);
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
  const reachable = gatherReachableZones(state, origin, template.footprint, template.service.coverageRadius);
  return new Set(reachable.keys());
}
