import { describe, it, expect } from 'vitest';
import { createInitialState, getTile, TileKind } from './gameState';
import { BuildingStatus } from './buildings/state';
import { BuildingCategory, BuildingTemplate, registerBuildingTemplate } from './buildings/templates';
import { placeBuilding, updateBuildingStates } from './buildings/manager';
import { deserialize, serialize } from './persistence';

const poweredTemplate: BuildingTemplate = {
  id: 'test-power-requirer',
  name: 'Needs Power',
  category: BuildingCategory.Civic,
  footprint: { width: 1, height: 1 },
  cost: 0,
  maintenance: 0,
  tileKind: TileKind.Park,
  requiresPower: true
};

const waterTemplate: BuildingTemplate = {
  id: 'test-water-requirer',
  name: 'Needs Water',
  category: BuildingCategory.Civic,
  footprint: { width: 1, height: 1 },
  cost: 0,
  maintenance: 0,
  tileKind: TileKind.Park,
  requiresPower: false,
  requiresWater: true,
  waterUse: 1
};

describe('buildings state machine', () => {
  it('marks building inactive when unpowered and reactivates when powered', () => {
    const state = createInitialState(4, 4);
    state.money = 1000;
    registerBuildingTemplate(poweredTemplate);
    const result = placeBuilding(state, poweredTemplate, 1, 1);
    expect(result.success).toBe(true);
    updateBuildingStates(state);
    expect(state.buildings[0].state.status).toBe(BuildingStatus.InactiveNoPower);

    const tile = getTile(state, 1, 1)!;
    tile.powered = true;
    updateBuildingStates(state);
    expect(state.buildings[0].state.status).toBe(BuildingStatus.Active);
  });

  it('marks building damaged when health is zero', () => {
    const state = createInitialState(4, 4);
    registerBuildingTemplate(poweredTemplate);
    placeBuilding(state, poweredTemplate, 0, 0);
    state.buildings[0].state.health = 0;
    updateBuildingStates(state);
    expect(state.buildings[0].state.status).toBe(BuildingStatus.InactiveDamaged);
  });

  it('marks building inactive when unwatered and reactivates when watered', () => {
    const state = createInitialState(4, 4);
    state.money = 1000;
    registerBuildingTemplate(waterTemplate);
    const result = placeBuilding(state, waterTemplate, 2, 2);
    expect(result.success).toBe(true);
    updateBuildingStates(state);
    expect(state.buildings[0].state.status).toBe(BuildingStatus.InactiveNoWater);

    const tile = getTile(state, 2, 2)!;
    tile.watered = true;
    updateBuildingStates(state);
    expect(state.buildings[0].state.status).toBe(BuildingStatus.Active);
  });

  it('rebuilds legacy civic tiles into building instances on load', () => {
    const state = createInitialState(4, 4);
    // Simulate a pre-migration save: `deserialize` branches on `terrain` being
    // absent to decode a v4-shaped tile, so a live `Tile` (which has no `kind`
    // field any more) can't stand in for one — spell the raw JSON directly.
    const json = JSON.parse(serialize(state));
    const idx = 1 * state.width + 1;
    delete json.tiles[idx].terrain;
    delete json.tiles[idx].underground;
    delete json.tiles[idx].surface;
    delete json.tiles[idx].overhead;
    json.tiles[idx].kind = TileKind.WaterPump;
    const restored = deserialize(JSON.stringify(json));
    const pumpTile = getTile(restored, 1, 1)!;
    expect(pumpTile.buildingId).toBeDefined();
    const building = restored.buildings.find((b) => b.id === pumpTile.buildingId);
    expect(building?.templateId).toBe(TileKind.WaterPump);
  });
});
