import { describe, it, expect } from 'vitest';
import { createInitialState, getTile, TileKind } from './gameState';
import {
  BuildingCategory,
  BuildingStatus,
  BuildingTemplate,
  placeBuilding,
  registerBuildingTemplate,
  updateBuildingStates
} from './buildings';
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

  it('rebuilds legacy civic tiles into building instances on load', () => {
    const state = createInitialState(4, 4);
    const tile = getTile(state, 1, 1)!;
    tile.kind = TileKind.WaterPump;
    const restored = deserialize(serialize(state));
    const pumpTile = getTile(restored, 1, 1)!;
    expect(pumpTile.buildingId).toBeDefined();
    const building = restored.buildings.find((b) => b.id === pumpTile.buildingId);
    expect(building?.templateId).toBe(TileKind.WaterPump);
  });
});
