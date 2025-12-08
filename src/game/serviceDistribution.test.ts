import { describe, it, expect } from 'vitest';
import { createInitialState, setTile, TileKind } from './gameState';
import { getBuildingTemplate } from './buildings/templates';
import { placeBuilding } from './buildings/manager';
import {
  computeZoneLoads,
  estimateZoneLoad,
  getReachableZoneCandidates,
  DEFAULT_WORKER_SHARE
} from './serviceDistribution';
import { ServiceId } from './services';

describe('serviceDistribution', () => {
  it('computes population and job loads proportional to capacity with worker fallback', () => {
    const state = createInitialState(6, 6);
    state.population = 28;
    state.jobs = 40;

    const resTemplate = getBuildingTemplate(TileKind.Residential)!;
    const comTemplate = getBuildingTemplate(TileKind.Commercial)!;
    const indTemplate = getBuildingTemplate(TileKind.Industrial)!;

    placeBuilding(state, resTemplate, 0, 0);
    placeBuilding(state, resTemplate, 1, 0);
    placeBuilding(state, comTemplate, 3, 0);
    placeBuilding(state, indTemplate, 4, 0);

    const loads = computeZoneLoads(state);

    const resShare = state.population / 2; // equal split: 14 each
    expect(loads.population.get(0)).toBeCloseTo(resShare);
    expect(loads.population.get(1)).toBeCloseTo(resShare);
    expect(loads.jobs.get(0)).toBeCloseTo(resShare * DEFAULT_WORKER_SHARE);

    // Commercial and industrial split jobs proportionally to capacity (8 vs 12 of 20)
    expect(loads.jobs.get(3)).toBeCloseTo(16); // 40 * (8/20)
    expect(loads.jobs.get(4)).toBeCloseTo(24); // 40 * (12/20)

    // Education load estimators use these shares
    expect(
      estimateZoneLoad(0, state.tiles[0], ServiceId.EducationElementary, loads)
    ).toBeCloseTo(resShare);
    expect(
      estimateZoneLoad(1, state.tiles[1], ServiceId.EducationHigh, loads)
    ).toBeCloseTo(resShare * DEFAULT_WORKER_SHARE);
  });

  it('finds reachable zones through roads within a radius and sorts by distance', () => {
    const state = createInitialState(5, 5);
    // service origin at (1,1)
    setTile(state, 1, 1, TileKind.Road);
    setTile(state, 1, 2, TileKind.Road);
    setTile(state, 1, 3, TileKind.Residential); // reachable via road chain, distance 2
    setTile(state, 2, 1, TileKind.Road);
    setTile(state, 3, 1, TileKind.Commercial); // reachable via road chain, distance 2
    setTile(state, 4, 4, TileKind.Industrial); // outside radius / no path

    const candidates = getReachableZoneCandidates(
      state,
      { x: 1, y: 1 },
      { width: 1, height: 1 },
      2
    );
    const toIndex = (x: number, y: number) => y * state.width + x;
    const reachable = candidates.map(([idx]) => idx);

    expect(reachable).toContain(toIndex(1, 3));
    expect(reachable).toContain(toIndex(3, 1));
    expect(reachable).not.toContain(toIndex(4, 4));
    // All returned distances should be <= radius and sorted
    const distances = candidates.map(([, d]) => d);
    expect(distances.every((d, i, arr) => d <= 2 && (i === 0 || d >= arr[i - 1]))).toBe(true);
  });
});
