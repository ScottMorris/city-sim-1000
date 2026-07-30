import { describe, it, expect } from 'vitest';
import { createInitialState, getTile, TileKind } from '../gameState';
import { placeBuilding, updateBuildingStates } from '../buildings/manager';
import { recomputeWaterNetwork } from './water';
import { getBuildingTemplate } from '../buildings/templates';

describe('water network', () => {
  it('propagates water from tower to pipes', () => {
    const state = createInitialState(10, 10);
    const towerTemplate = getBuildingTemplate(TileKind.WaterTower)!;

    // Place Water Tower at 1,1 (2x2). Occupies (1,1), (2,1), (1,2), (2,2)
    placeBuilding(state, towerTemplate, 1, 1);
    [
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2]
    ].forEach(([x, y]) => {
      const tile = getTile(state, x, y)!;
      tile.powered = true;
    });

    // Place Pipe at 3,1 (adjacent to tower at 2,1)
    const pipeTile = getTile(state, 3, 1)!;
    pipeTile.legacyUnderground = TileKind.WaterPipe;

    // Ensure building status is active (towers need power)
    updateBuildingStates(state);

    recomputeWaterNetwork(state);

    expect(pipeTile.watered).toBe(true);
  });

  it('propagates water through pipe chain', () => {
    const state = createInitialState(10, 10);
    const towerTemplate = getBuildingTemplate(TileKind.WaterTower)!;

    placeBuilding(state, towerTemplate, 1, 1);
    [
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2]
    ].forEach(([x, y]) => {
      const tile = getTile(state, x, y)!;
      tile.powered = true;
    });

    getTile(state, 3, 1)!.legacyUnderground = TileKind.WaterPipe;
    getTile(state, 4, 1)!.legacyUnderground = TileKind.WaterPipe;

    updateBuildingStates(state);
    recomputeWaterNetwork(state);

    expect(getTile(state, 4, 1)!.watered).toBe(true);
  });

  it('ignores unconnected water towers when tallying supply', () => {
    const state = createInitialState(10, 10);
    const towerTemplate = getBuildingTemplate(TileKind.WaterTower)!;

    placeBuilding(state, towerTemplate, 1, 1);
    [
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2]
    ].forEach(([x, y]) => {
      const tile = getTile(state, x, y)!;
      tile.powered = true;
    });

    updateBuildingStates(state);
    recomputeWaterNetwork(state);

    expect(state.utilities.waterProduced).toBe(0);
  });
});
