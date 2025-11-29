import { describe, it, expect } from 'vitest';
import { BUILD_COST, POWER_PLANT_CONFIGS, PowerPlantType } from './constants';
import { createInitialState, getTile, setTile, TileKind } from './gameState';
import { recomputePowerNetwork } from './power';
import { applyTool } from './tools';
import { Tool } from './toolTypes';
import { Simulation } from './simulation';
import { BuildingStatus, getBuildingTemplate } from './buildings';

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
    expect(state.utilities.water).toBeCloseTo(template.waterOutput ?? 0);
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
    applyTool(state, Tool.Residential, 3, 2);
    state.demand.residential = 80;
    const sim = new Simulation(state, { ticksPerSecond: 1 });
    sim.update(1);
    const zoneBuilding = state.buildings.find((b) => b.templateId === 'zone-residential');
    expect(zoneBuilding).toBeDefined();
    const template = getBuildingTemplate(zoneBuilding!.templateId)!;
    expect(state.utilities.powerUsed).toBeCloseTo(template.powerUse ?? 0);
    expect(state.utilities.water).toBeCloseTo(
      (template.waterOutput ?? 0) - (template.waterUse ?? 0)
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
});
