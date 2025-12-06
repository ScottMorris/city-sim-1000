import { getOrthogonalNeighbourCoords, isZone } from './adjacency';
import { BuildingCategory, BuildingStatus, getBuildingTemplate } from './buildings';
import type { GameState, Tile } from './gameState';
import { getTile, TileKind } from './gameState';
import { ServiceId } from './services';

export const DEFAULT_WORKER_SHARE = 0.55;

export type ZoneLoadMap = {
  population: Map<number, number>;
  jobs: Map<number, number>;
};

function isRoadish(tile: Tile | undefined): boolean {
  if (!tile) return false;
  return tile.kind === TileKind.Road || tile.roadUnderlay === true;
}

/**
 * Precompute per-zone population and job load shares so service allocators
 * can consume them without re-walking buildings.
 */
export function computeZoneLoads(state: GameState, workerShare = DEFAULT_WORKER_SHARE): ZoneLoadMap {
  const population = new Map<number, number>();
  const jobs = new Map<number, number>();

  let totalPopCap = 0;
  let totalComCap = 0;
  let totalIndCap = 0;

  for (const building of state.buildings) {
    const template = getBuildingTemplate(building.templateId);
    if (!template) continue;
    if (building.state.status !== BuildingStatus.Active) continue;
    if (template.category !== BuildingCategory.Zone) continue;
    if (template.populationCapacity) totalPopCap += template.populationCapacity;
    if (template.jobsCapacity) {
      if (template.tileKind === TileKind.Commercial) totalComCap += template.jobsCapacity;
      if (template.tileKind === TileKind.Industrial) totalIndCap += template.jobsCapacity;
    }
  }

  const totalJobCap = totalComCap + totalIndCap;
  const jobsInCommercial = totalJobCap > 0 ? (totalComCap / totalJobCap) * state.jobs : 0;
  const jobsInIndustrial = totalJobCap > 0 ? (totalIndCap / totalJobCap) * state.jobs : 0;

  for (const building of state.buildings) {
    const template = getBuildingTemplate(building.templateId);
    if (!template) continue;
    if (building.state.status !== BuildingStatus.Active) continue;
    if (template.category !== BuildingCategory.Zone) continue;
    const idx = building.origin.y * state.width + building.origin.x;

    if (template.populationCapacity) {
      const share =
        totalPopCap > 0 ? (template.populationCapacity / totalPopCap) * state.population : 0;
      population.set(idx, share);
    }

    if (template.jobsCapacity) {
      if (template.tileKind === TileKind.Commercial) {
        const share = totalComCap > 0 ? (template.jobsCapacity / totalComCap) * jobsInCommercial : 0;
        jobs.set(idx, share);
      } else if (template.tileKind === TileKind.Industrial) {
        const share = totalIndCap > 0 ? (template.jobsCapacity / totalIndCap) * jobsInIndustrial : 0;
        jobs.set(idx, share);
      } else if (template.populationCapacity) {
        // Jobs not yet placed; fall back to workers from this population slice.
        const popShare = population.get(idx) ?? 0;
        jobs.set(idx, popShare * workerShare);
      }
    } else if (template.populationCapacity) {
      const popShare = population.get(idx) ?? 0;
      jobs.set(idx, popShare * workerShare);
    }
  }

  return { population, jobs };
}

export function estimateZoneLoad(
  idx: number,
  tile: Tile | undefined,
  serviceId: ServiceId,
  loads: ZoneLoadMap
): number {
  if (!tile || !isZone(tile)) return 0;
  if (serviceId === ServiceId.EducationElementary) {
    return loads.population.get(idx) ?? 0;
  }
  if (serviceId === ServiceId.EducationHigh) {
    const jobLoad = loads.jobs.get(idx);
    if (jobLoad !== undefined) return jobLoad;
    const popLoad = loads.population.get(idx);
    return popLoad !== undefined ? popLoad * DEFAULT_WORKER_SHARE : 0;
  }
  return 0;
}

export type ReachableZoneCandidates = Array<[index: number, distance: number]>;

/**
 * Walk roads/zones out from a service footprint to find reachable zone indices,
 * recording distance for capacity allocation ordering.
 */
export function getReachableZoneCandidates(
  state: GameState,
  origin: { x: number; y: number },
  footprint: { width: number; height: number },
  radius: number
): ReachableZoneCandidates {
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

  return Array.from(reachable.entries()).sort((a, b) => a[1] - b[1]);
}
