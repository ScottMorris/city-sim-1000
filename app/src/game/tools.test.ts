// tools.test.ts — placement rules and power/road-carrier behaviour for applyTool.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { BUILD_COST, POWER_PLANT_CONFIGS, PowerPlantType } from './constants';
import { createInitialState, getTile, setTile, TileKind } from './gameState';
import { recomputePowerNetwork } from './utilities/power';
import { applyTool } from './tools';
import { Tool } from './toolTypes';
import { BuildingStatus } from './buildings/state';
import { getBuildingTemplate } from './buildings/templates';
import { placeZoneBuilding } from './buildings/manager';
import { Occupant, Terrain, hasOccupant, zoneOccupant } from './protocol/occupants';
import { hasRoadAccess } from './adjacency';

describe('tools', () => {
  it('blocks tool usage when funds are insufficient', () => {
    const state = createInitialState(4, 4);
    state.money = 0;
    const result = applyTool(state, Tool.Tree, 1, 1);
    expect(result.success).toBe(false);
    expect(result.message).toBe('Not enough funds');
  });

  it('applies a tool, updates tile, and deducts cost', () => {
    const state = createInitialState(4, 4);
    state.money = 100;
    const before = state.money;
    const result = applyTool(state, Tool.Road, 0, 0);
    expect(result.success).toBe(true);
    expect(hasOccupant(getTile(state, 0, 0)!.surface, Occupant.Road)).toBe(true);
    expect(state.money).toBe(before - BUILD_COST[Tool.Road]);
  });

  it('supports terraform raise/lower tools', () => {
    const state = createInitialState(4, 4);
    state.money = 100;
    setTile(state, 1, 1, TileKind.Water);
    applyTool(state, Tool.TerraformRaise, 1, 1);
    expect(getTile(state, 1, 1)?.terrain).toBe(Terrain.Land);
    applyTool(state, Tool.TerraformLower, 1, 1);
    expect(getTile(state, 1, 1)?.terrain).toBe(Terrain.Water);
  });

  it('places power plants as 2x2 footprints with a shared id and single cost', () => {
    const state = createInitialState(6, 6);
    const template = getBuildingTemplate(PowerPlantType.Hydro)!;
    state.money = template.cost + 1000;
    const before = state.money;
    const result = applyTool(state, Tool.HydroPlant, 2, 2);
    expect(result.success).toBe(true);
    expect(state.buildings.length).toBe(1);
    expect(state.buildings[0].state.status).toBe(BuildingStatus.Active);
    const coords: Array<[number, number]> = [
      [2, 2],
      [3, 2],
      [2, 3],
      [3, 3]
    ];
    const ids = new Set<number>();
    coords.forEach(([x, y]) => {
      const tile = getTile(state, x, y)!;
      expect(tile.powerPlantType).toBe(PowerPlantType.Hydro);
      ids.add(tile.buildingId ?? -1);
    });
    expect(ids.size).toBe(1);
    expect(state.money).toBe(before - template.cost);
  });

  it('prevents overlapping building footprints and preserves funds', () => {
    const state = createInitialState(6, 6);
    const coalCost = getBuildingTemplate(PowerPlantType.Coal)!.cost;
    const hydroCost = getBuildingTemplate(PowerPlantType.Hydro)!.cost;
    state.money = coalCost + hydroCost;
    const first = applyTool(state, Tool.CoalPlant, 1, 1);
    expect(first.success).toBe(true);
    const moneyAfterFirst = state.money;
    const second = applyTool(state, Tool.HydroPlant, 2, 2);
    expect(second.success).toBe(false);
    expect(state.money).toBe(moneyAfterFirst);
  });

  it('blocks zoning over transport tiles', () => {
    const state = createInitialState(5, 5);
    const cost = BUILD_COST[Tool.Commercial];
    state.money = cost + 50;
    applyTool(state, Tool.Road, 2, 2);
    const before = state.money;
    const result = applyTool(state, Tool.Commercial, 2, 2);
    expect(result.success).toBe(false);
    expect(hasOccupant(getTile(state, 2, 2)!.surface, Occupant.Road)).toBe(true);
    expect(state.money).toBe(before); // no charge on failure
  });

  it('rejects placing transport tools over existing buildings', () => {
    const state = createInitialState(6, 6);
    // seed a developed zone lot manually
    setTile(state, 3, 3, TileKind.Residential);
    placeZoneBuilding(state, TileKind.Residential, 3, 3);
    expect(state.buildings.length).toBe(1);
    const buildingId = state.buildings[0].id;
    const moneyBefore = state.money;
    const result = applyTool(state, Tool.Road, 3, 3);
    expect(result.success).toBe(false); // building protection — must bulldoze first
    expect(state.buildings.find((b) => b.id === buildingId)).toBeDefined();
    expect(getTile(state, 3, 3)?.buildingId).toBeDefined();
    expect(zoneOccupant(getTile(state, 3, 3)!.surface)).toBe(Occupant.ZoneResidential); // tile unchanged
    expect(state.money).toBe(moneyBefore); // no charge on failure
  });

  it('bulldozes an entire building footprint and removes the instance', () => {
    const state = createInitialState(6, 6);
    const windCost = getBuildingTemplate(PowerPlantType.Wind)!.cost;
    state.money = windCost + 1000;
    applyTool(state, Tool.WindTurbine, 1, 1);
    expect(state.buildings.length).toBe(1);
    applyTool(state, Tool.Bulldoze, 1, 2); // inside the footprint
    expect(state.buildings.length).toBe(0);
    const clearedTiles: Array<[number, number]> = [
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2]
    ];
    clearedTiles.forEach(([x, y]) => {
      const tile = getTile(state, x, y)!;
      expect(tile.terrain).toBe(Terrain.Land);
      expect(tile.surface).toBe(0);
      expect(tile.overhead).toBe(0);
      expect(tile.buildingId).toBeUndefined();
      expect(tile.powerPlantType).toBeUndefined();
    });
  });
});

describe('simulation', () => {
  it('counts a multi-tile power plant once when computing production', () => {
    const state = createInitialState(6, 6);
    const template = getBuildingTemplate(PowerPlantType.Hydro)!;
    state.money = template.cost + 1000;
    applyTool(state, Tool.HydroPlant, 1, 1);
    recomputePowerNetwork(state);
    expect(state.utilities.powerProduced).toBe(
      POWER_PLANT_CONFIGS[PowerPlantType.Hydro].outputMw
    );
  });

  it('propagates power across contiguous zone tiles', () => {
    const state = createInitialState(6, 6);
    state.money = 20000;
    applyTool(state, Tool.WindTurbine, 0, 0);
    applyTool(state, Tool.PowerLine, 2, 0);
    applyTool(state, Tool.Residential, 3, 0);
    applyTool(state, Tool.Residential, 3, 1);
    recomputePowerNetwork(state);
    expect(getTile(state, 3, 0)?.powered).toBe(true);
    expect(getTile(state, 3, 1)?.powered).toBe(true);
  });

  it('propagates power along roads and rail as carriers', () => {
    const state = createInitialState(8, 4);
    state.money = 20000;
    applyTool(state, Tool.WindTurbine, 0, 1);
    // road chain to the right
    for (let x = 2; x <= 5; x++) {
      applyTool(state, Tool.Road, x, 1);
    }
    applyTool(state, Tool.Commercial, 6, 1);
    recomputePowerNetwork(state);
    expect(getTile(state, 6, 1)?.powered).toBe(true);

    // rail should also carry
    applyTool(state, Tool.Rail, 2, 2);
    applyTool(state, Tool.Rail, 3, 2);
    applyTool(state, Tool.Rail, 4, 2);
    applyTool(state, Tool.Commercial, 5, 2);
    recomputePowerNetwork(state);
    expect(getTile(state, 5, 2)?.powered).toBe(true);
  });

  it('keeps road access when a segment is converted to a power line', () => {
    const state = createInitialState(8, 6);
    state.money = 50000;
    applyTool(state, Tool.Residential, 5, 3);
    // road on both sides of the future powerline crossing
    for (let x = 2; x <= 6; x++) {
      applyTool(state, Tool.Road, x, 3);
    }
    // drop a power line on the middle tile to simulate an over-road line
    applyTool(state, Tool.PowerLine, 4, 3);
    expect(hasOccupant(getTile(state, 4, 3)!.overhead, Occupant.PowerLine)).toBe(true);
    expect(hasRoadAccess(state, 5, 3)).toBe(true);
  });

  it('lets rail cross roads while keeping road access and power flow', () => {
    const state = createInitialState(10, 6);
    state.money = 50000;
    // road spine
    for (let x = 2; x <= 7; x++) {
      applyTool(state, Tool.Road, x, 3);
    }
    applyTool(state, Tool.Residential, 8, 3);
    // rail crossing
    applyTool(state, Tool.Rail, 5, 2);
    applyTool(state, Tool.Rail, 5, 3);
    applyTool(state, Tool.Rail, 5, 4);
    // power source on the left — turbine is 2×2; (0,3) keeps its footprint clear of the road at (2,3)
    applyTool(state, Tool.WindTurbine, 0, 3);
    recomputePowerNetwork(state);
    expect(hasRoadAccess(state, 8, 3)).toBe(true);
    expect(getTile(state, 8, 3)?.powered).toBe(true);
  });

  it('removes transport underlays when bulldozing a crossing', () => {
    const state = createInitialState(8, 8);
    state.money = 50000;
    // lay a rail spine
    applyTool(state, Tool.Rail, 3, 2);
    applyTool(state, Tool.Rail, 3, 3);
    applyTool(state, Tool.Rail, 3, 4);
    // draw a road across it — both occupy the same surface stratum
    // regardless of build order, so there is no "underlay" spelling to pin,
    // only the two bits.
    applyTool(state, Tool.Road, 2, 3);
    applyTool(state, Tool.Road, 3, 3);
    applyTool(state, Tool.Road, 4, 3);
    const crossing = getTile(state, 3, 3)!;
    expect(hasOccupant(crossing.surface, Occupant.Rail)).toBe(true);
    expect(hasOccupant(crossing.surface, Occupant.Road)).toBe(true);

    applyTool(state, Tool.Bulldoze, 3, 3);

    const cleared = getTile(state, 3, 3)!;
    expect(cleared.surface).toBe(0);
    expect(cleared.overhead).toBe(0);
  });
});
