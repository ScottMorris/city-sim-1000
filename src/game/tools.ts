import { BUILD_COST, PowerPlantType } from './constants';
import {
  type BuildingTemplate,
  getBuildingTemplate,
  getPowerPlantTemplate,
  placeBuilding,
  removeBuilding
} from './buildings';
import { GameState, Tile, TileKind, getTile, setTile } from './gameState';
import { Tool } from './toolTypes';

export interface ChangeResult {
  success: boolean;
  message?: string;
}

export interface ToolContext {
  state: GameState;
  tile: Tile;
  x: number;
  y: number;
}

export type ToolHandler = (ctx: ToolContext, cost: number) => ChangeResult;

export type ToolRegistry = Record<Tool, ToolHandler>;

function getToolCost(tool: Tool): number {
  const templateCost = getBuildingTemplate(tool)?.cost;
  if (templateCost !== undefined) return templateCost;
  return BUILD_COST[tool] ?? 0;
}

function placeTemplatedBuilding(
  state: GameState,
  template: BuildingTemplate | undefined,
  x: number,
  y: number,
  cost: number
): ChangeResult {
  if (!template) return { success: false, message: 'Unknown building type' };
  const result = placeBuilding(state, template, x, y, (tile, buildingId) => {
    if (template.power) {
      tile.powerPlantType = template.power.type;
      tile.powerPlantId = buildingId;
    }
  });
  if (!result.success) return result;
  state.money -= cost;
  return result;
}

function placePowerPlant(
  state: GameState,
  x: number,
  y: number,
  type: PowerPlantType,
  cost: number
): ChangeResult {
  const template = getPowerPlantTemplate(type);
  return placeTemplatedBuilding(state, template, x, y, cost);
}

const registry: ToolRegistry = {
  [Tool.Inspect]: (_ctx, _cost) => ({ success: true }),
  [Tool.TerraformRaise]: ({ state, x, y }, cost) => {
    console.log('Terraform raise at', x, y);
    state.money -= cost;
    setTile(state, x, y, TileKind.Land);
    return { success: true };
  },
  [Tool.TerraformLower]: ({ state, x, y }, cost) => {
    console.log('Terraform lower at', x, y);
    state.money -= cost;
    setTile(state, x, y, TileKind.Water);
    return { success: true };
  },
  [Tool.Water]: ({ state, x, y }, cost) => {
    state.money -= cost;
    setTile(state, x, y, TileKind.Water);
    return { success: true };
  },
  [Tool.Tree]: ({ state, x, y }, cost) => {
    state.money -= cost;
    setTile(state, x, y, TileKind.Tree);
    return { success: true };
  },
  [Tool.Road]: ({ state, x, y }, cost) => {
    state.money -= cost;
    const tile = getTile(state, x, y);
    const hadRail = tile?.kind === TileKind.Rail || tile?.railUnderlay;
    setTile(state, x, y, TileKind.Road);
    const updated = getTile(state, x, y);
    if (updated && hadRail) updated.railUnderlay = true; // remember rail for render/crossing
    return { success: true };
  },
  [Tool.Rail]: ({ state, x, y }, cost) => {
    state.money -= cost;
    const tile = getTile(state, x, y);
    const hadRoad = tile?.kind === TileKind.Road || tile?.roadUnderlay;
    setTile(state, x, y, TileKind.Rail);
    const updated = getTile(state, x, y);
    if (updated && hadRoad) updated.roadUnderlay = true; // rail over road
    return { success: true };
  },
  [Tool.PowerLine]: ({ state, x, y }, cost) => {
    state.money -= cost;
    const tile = getTile(state, x, y);
    const hadRoad = tile?.kind === TileKind.Road || tile?.roadUnderlay;
    const hadRail = tile?.kind === TileKind.Rail || tile?.railUnderlay;
    setTile(state, x, y, TileKind.PowerLine);
    const updated = getTile(state, x, y);
    if (updated && hadRoad) updated.roadUnderlay = true;
    if (updated && hadRail) updated.railUnderlay = true;
    if (updated) updated.powerOverlay = true;
    return { success: true };
  },
  [Tool.HydroPlant]: ({ state, x, y }, cost) =>
    placePowerPlant(state, x, y, PowerPlantType.Hydro, cost),
  [Tool.CoalPlant]: ({ state, x, y }, cost) =>
    placePowerPlant(state, x, y, PowerPlantType.Coal, cost),
  [Tool.WindTurbine]: ({ state, x, y }, cost) =>
    placePowerPlant(state, x, y, PowerPlantType.Wind, cost),
  [Tool.SolarFarm]: ({ state, x, y }, cost) =>
    placePowerPlant(state, x, y, PowerPlantType.Solar, cost),
  [Tool.WaterPump]: ({ state, x, y }, cost) =>
    placeTemplatedBuilding(state, getBuildingTemplate(TileKind.WaterPump), x, y, cost),
  [Tool.WaterTower]: ({ state, x, y }, cost) =>
    placeTemplatedBuilding(state, getBuildingTemplate(TileKind.WaterTower), x, y, cost),
  [Tool.WaterPipe]: () => ({
    success: false,
    message: 'Underground pipes view is coming soon.'
  }),
  [Tool.Residential]: ({ state, x, y }, cost) => {
    const tile = getTile(state, x, y);
    if (tile && (tile.kind === TileKind.Road || tile.kind === TileKind.Rail || tile.roadUnderlay || tile.railUnderlay)) {
      return { success: false, message: 'Cannot zone over roads or rail. Bulldoze first.' };
    }
    state.money -= cost;
    setTile(state, x, y, TileKind.Residential);
    return { success: true };
  },
  [Tool.Commercial]: ({ state, x, y }, cost) => {
    const tile = getTile(state, x, y);
    if (tile && (tile.kind === TileKind.Road || tile.kind === TileKind.Rail || tile.roadUnderlay || tile.railUnderlay)) {
      return { success: false, message: 'Cannot zone over roads or rail. Bulldoze first.' };
    }
    state.money -= cost;
    setTile(state, x, y, TileKind.Commercial);
    return { success: true };
  },
  [Tool.Industrial]: ({ state, x, y }, cost) => {
    const tile = getTile(state, x, y);
    if (tile && (tile.kind === TileKind.Road || tile.kind === TileKind.Rail || tile.roadUnderlay || tile.railUnderlay)) {
      return { success: false, message: 'Cannot zone over roads or rail. Bulldoze first.' };
    }
    state.money -= cost;
    setTile(state, x, y, TileKind.Industrial);
    return { success: true };
  },
  [Tool.Park]: ({ state, x, y }, cost) =>
    placeTemplatedBuilding(state, getBuildingTemplate(TileKind.Park), x, y, cost),
  [Tool.Bulldoze]: ({ state, x, y }, cost) => {
    state.money -= cost;
    const tile = getTile(state, x, y);
    if (tile) {
      if (tile.buildingId !== undefined) {
        removeBuilding(state, tile.buildingId);
      } else {
        tile.kind = TileKind.Land;
        tile.powerPlantType = undefined;
        tile.powerPlantId = undefined;
        tile.buildingId = undefined;
        tile.happiness = Math.min(1.5, tile.happiness + 0.05);
      }
    }
    return { success: true };
  }
};

export function applyTool(state: GameState, tool: Tool, x: number, y: number): ChangeResult {
  const tile = getTile(state, x, y);
  if (!tile) return { success: false };
  const cost = getToolCost(tool);
  if (state.money < cost) {
    return { success: false, message: 'Not enough funds' };
  }

  const handler = registry[tool];
  if (!handler) return { success: false };
  return handler({ state, tile, x, y }, cost);
}
