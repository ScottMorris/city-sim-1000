import { describe, it, expect } from 'vitest';
import { BUILD_COST, POWER_PLANT_CONFIGS, PowerPlantType } from './constants';
import { createInitialState, getTile, setTile, TileKind } from './gameState';
import { recomputePowerNetwork } from './power';
import { applyTool } from './tools';
import { Tool } from './toolTypes';
import { Simulation } from './simulation';
import { BuildingStatus, getBuildingTemplate, placeBuilding } from './buildings';
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
    expect(getTile(state, 0, 0)?.kind).toBe(TileKind.Road);
    expect(state.money).toBe(before - BUILD_COST[Tool.Road]);
  });

  it('supports terraform raise/lower tools', () => {
    const state = createInitialState(4, 4);
    state.money = 100;
    setTile(state, 1, 1, TileKind.Water);
    applyTool(state, Tool.TerraformRaise, 1, 1);
    expect(getTile(state, 1, 1)?.kind).toBe(TileKind.Land);
    applyTool(state, Tool.TerraformLower, 1, 1);
    expect(getTile(state, 1, 1)?.kind).toBe(TileKind.Water);
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

  it('places pumps as building instances with template-driven costs and output', () => {
    const state = createInitialState(6, 6);
    const template = getBuildingTemplate(TileKind.WaterPump)!;
    const initialMoney =
      template.cost + 200 + BUILD_COST[Tool.WindTurbine] + BUILD_COST[Tool.PowerLine] * 3;
    state.money = initialMoney;
    applyTool(state, Tool.WindTurbine, 2, 0);
    applyTool(state, Tool.PowerLine, 1, 0);
    applyTool(state, Tool.PowerLine, 1, 1);
    applyTool(state, Tool.PowerLine, 0, 1);
    const result = applyTool(state, Tool.WaterPump, 0, 0);
    expect(result.success).toBe(true);
    const pump = state.buildings.find((b) => b.templateId === template.id);
    expect(pump).toBeDefined();
    const spent = initialMoney - state.money;
    expect(spent).toBeCloseTo(
      BUILD_COST[Tool.WindTurbine] + BUILD_COST[Tool.PowerLine] * 3 + template.cost
    );
    const pumpTile = getTile(state, 0, 0)!;
    expect(pumpTile.buildingId).toBe(pump?.id);
    const sim = new Simulation(state, { ticksPerSecond: 1 });
    sim.update(1);
    expect(state.utilities.water).toBeGreaterThan(0);
  });

  it('adds a water tower with a 2x2 footprint that supplies water even without power', () => {
    const state = createInitialState(8, 8);
    const template = getBuildingTemplate(TileKind.WaterTower)!;
    state.money = template.cost + 500;
    const result = applyTool(state, Tool.WaterTower, 3, 3);
    expect(result.success).toBe(true);
    expect(state.buildings.length).toBe(1);
    const ids = new Set<number>();
    const footprint: Array<[number, number]> = [
      [3, 3],
      [4, 3],
      [3, 4],
      [4, 4]
    ];
    footprint.forEach(([x, y]) => {
      const tile = getTile(state, x, y)!;
      expect(tile.kind).toBe(TileKind.WaterTower);
      ids.add(tile.buildingId ?? -1);
    });
    expect(ids.size).toBe(1);
    const sim = new Simulation(state, { ticksPerSecond: 1 });
    sim.update(1);
    expect(state.buildings[0].state.status).toBe(BuildingStatus.Active);
    expect(state.utilities.water).toBeGreaterThan(0);
  });

  it('blocks zoning over transport tiles', () => {
    const state = createInitialState(5, 5);
    const cost = BUILD_COST[Tool.Commercial];
    state.money = cost + 50;
    applyTool(state, Tool.Road, 2, 2);
    const before = state.money;
    const result = applyTool(state, Tool.Commercial, 2, 2);
    expect(result.success).toBe(false);
    expect(getTile(state, 2, 2)?.kind).toBe(TileKind.Road);
    expect(state.money).toBe(before); // no charge on failure
  });

  it('clears existing buildings when placing transport tools over them', () => {
    const state = createInitialState(6, 6);
    const template = getBuildingTemplate(TileKind.Residential)!;
    // seed a zone building manually
    setTile(state, 3, 3, TileKind.Residential);
    placeBuilding(state, template, 3, 3);
    expect(state.buildings.length).toBe(1);
    const buildingId = state.buildings[0].id;
    const moneyBefore = state.money;
    applyTool(state, Tool.Road, 3, 3);
    expect(state.buildings.find((b) => b.id === buildingId)).toBeUndefined();
    expect(getTile(state, 3, 3)?.buildingId).toBeUndefined();
    expect(getTile(state, 3, 3)?.kind).toBe(TileKind.Road);
    expect(state.money).toBeLessThan(moneyBefore); // cost applied
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
      expect(tile.kind).toBe(TileKind.Land);
      expect(tile.buildingId).toBeUndefined();
      expect(tile.powerPlantType).toBeUndefined();
    });
  });
});

describe('simulation', () => {
  it('advances ticks and day in fixed steps', () => {
    const state = createInitialState(4, 4);
    const sim = new Simulation(state, { ticksPerSecond: 20 });
    sim.update(1); // 1 second = 20 ticks
    expect(state.tick).toBe(20);
    expect(state.day).toBeGreaterThan(1);
  });

  it('accumulates partial frames before ticking', () => {
    const state = createInitialState(4, 4);
    const sim = new Simulation(state, { ticksPerSecond: 20 });
    sim.update(0.02); // less than dt (0.05)
    expect(state.tick).toBe(0);
    sim.update(0.03);
    expect(state.tick).toBe(1);
  });

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

  it('spawns zone buildings that consume utilities and provide capacity', () => {
    const state = createInitialState(6, 6);
    state.money = 100000;
    applyTool(state, Tool.WindTurbine, 0, 0);
    applyTool(state, Tool.PowerLine, 2, 0);
    applyTool(state, Tool.PowerLine, 2, 1);
    applyTool(state, Tool.PowerLine, 2, 2);
    applyTool(state, Tool.Road, 3, 1);
    applyTool(state, Tool.Residential, 3, 2);
    state.demand.residential = 80;
    const sim = new Simulation(state, { ticksPerSecond: 1 });
    sim.update(2.5);
    const zoneBuilding = state.buildings.find((b) => b.templateId === 'zone-residential');
    expect(zoneBuilding).toBeDefined();
    const template = getBuildingTemplate(zoneBuilding!.templateId)!;
    expect(state.utilities.powerUsed).toBeCloseTo(template.powerUse ?? 0);
    expect(state.utilities.water).toBeGreaterThanOrEqual(0);
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
    expect(getTile(state, 4, 3)?.kind).toBe(TileKind.PowerLine);
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
    // power source on the left
    applyTool(state, Tool.WindTurbine, 1, 3);
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
    // draw a road across it, creating a rail underlay
    applyTool(state, Tool.Road, 2, 3);
    applyTool(state, Tool.Road, 3, 3);
    applyTool(state, Tool.Road, 4, 3);
    const crossing = getTile(state, 3, 3)!;
    expect(crossing.kind).toBe(TileKind.Road);
    expect(crossing.railUnderlay).toBe(true);

    applyTool(state, Tool.Bulldoze, 3, 3);

    const cleared = getTile(state, 3, 3)!;
    expect(cleared.kind).toBe(TileKind.Land);
    expect(cleared.railUnderlay).toBeUndefined();
    expect(cleared.roadUnderlay).toBeUndefined();
    expect(cleared.powerOverlay).toBeUndefined();
  });

  it('grows frontier zones even without roads, but roads still trigger growth', () => {
    const state = createInitialState(6, 6);
    state.money = 50000;
    applyTool(state, Tool.Residential, 3, 3);
    state.demand.residential = 80;
    const sim = new Simulation(state, { ticksPerSecond: 1 });
    sim.update(2.5);
    expect(hasRoadAccess(state, 3, 3)).toBe(false);
    expect(state.buildings.find((b) => b.templateId === 'zone-residential')).toBeDefined();

    // Second tile grows once road is added (still valid path)
    applyTool(state, Tool.Residential, 4, 3);
    applyTool(state, Tool.Road, 4, 2);
    sim.update(2.5);
    const secondZone = state.buildings.filter((b) => b.templateId === 'zone-residential');
    expect(secondZone.length).toBeGreaterThan(1);
  });

  it('allows frontier zones to grow without roads but blocks fully enclosed interiors', () => {
    const state = createInitialState(8, 8);
    state.money = 50000;
    // 3x3 block of zones with no roads
    for (let y = 2; y <= 4; y++) {
      for (let x = 2; x <= 4; x++) {
        applyTool(state, Tool.Residential, x, y);
      }
    }
    state.demand.residential = 80;
    const sim = new Simulation(state, { ticksPerSecond: 1 });
    sim.update(2.5);
    const built = state.buildings.filter((b) => b.templateId === 'zone-residential');
    expect(built.length).toBeGreaterThan(0);
    const centerTile = getTile(state, 3, 3)!;
    expect(centerTile.buildingId).toBeUndefined();
  });

  it('provides starter demand when city is empty', () => {
    const state = createInitialState(6, 6);
    state.money = 50000;
    applyTool(state, Tool.Residential, 2, 2);
    const sim = new Simulation(state, { ticksPerSecond: 1 });
    sim.update(0.1);
    expect(state.demand.residential).toBeGreaterThan(0);
  });

  it('allows interior zone tiles to grow when adjacent to a road-served zone', () => {
    const state = createInitialState(8, 8);
    state.money = 50000;
    applyTool(state, Tool.Road, 2, 2);
    applyTool(state, Tool.Residential, 2, 3); // edge tile with road access
    applyTool(state, Tool.Residential, 3, 3); // interior tile with no road access
    state.demand.residential = 80;
    const sim = new Simulation(state, { ticksPerSecond: 1 });
    sim.update(2.5);
    const firstZone = state.buildings.find((b) => b.templateId === 'zone-residential');
    expect(firstZone).toBeDefined();
    sim.update(2.5);
    const secondZone = state.buildings.filter((b) => b.templateId === 'zone-residential');
    expect(secondZone.length).toBeGreaterThan(1);
  });
});
