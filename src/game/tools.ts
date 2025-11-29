import { BUILD_COST } from './constants';
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

export type ToolHandler = (ctx: ToolContext) => ChangeResult;

export type ToolRegistry = Record<Tool, ToolHandler>;

const registry: ToolRegistry = {
  [Tool.Inspect]: () => ({ success: true }),
  [Tool.TerraformRaise]: ({ state, x, y }) => {
    console.log('Terraform raise at', x, y);
    state.money -= BUILD_COST[Tool.TerraformRaise];
    setTile(state, x, y, TileKind.Land);
    return { success: true };
  },
  [Tool.TerraformLower]: ({ state, x, y }) => {
    console.log('Terraform lower at', x, y);
    state.money -= BUILD_COST[Tool.TerraformLower];
    setTile(state, x, y, TileKind.Water);
    return { success: true };
  },
  [Tool.Water]: ({ state, x, y }) => {
    state.money -= BUILD_COST[Tool.Water];
    setTile(state, x, y, TileKind.Water);
    return { success: true };
  },
  [Tool.Tree]: ({ state, x, y }) => {
    state.money -= BUILD_COST[Tool.Tree];
    setTile(state, x, y, TileKind.Tree);
    return { success: true };
  },
  [Tool.Road]: ({ state, x, y }) => {
    state.money -= BUILD_COST[Tool.Road];
    setTile(state, x, y, TileKind.Road);
    return { success: true };
  },
  [Tool.Rail]: ({ state, x, y }) => {
    state.money -= BUILD_COST[Tool.Rail];
    setTile(state, x, y, TileKind.Rail);
    return { success: true };
  },
  [Tool.PowerLine]: ({ state, x, y }) => {
    state.money -= BUILD_COST[Tool.PowerLine];
    setTile(state, x, y, TileKind.PowerLine);
    return { success: true };
  },
  [Tool.HydroPlant]: ({ state, x, y }) => {
    state.money -= BUILD_COST[Tool.HydroPlant];
    setTile(state, x, y, TileKind.HydroPlant);
    return { success: true };
  },
  [Tool.WaterPump]: ({ state, x, y }) => {
    state.money -= BUILD_COST[Tool.WaterPump];
    setTile(state, x, y, TileKind.WaterPump);
    return { success: true };
  },
  [Tool.Residential]: ({ state, x, y }) => {
    state.money -= BUILD_COST[Tool.Residential];
    setTile(state, x, y, TileKind.Residential);
    return { success: true };
  },
  [Tool.Commercial]: ({ state, x, y }) => {
    state.money -= BUILD_COST[Tool.Commercial];
    setTile(state, x, y, TileKind.Commercial);
    return { success: true };
  },
  [Tool.Industrial]: ({ state, x, y }) => {
    state.money -= BUILD_COST[Tool.Industrial];
    setTile(state, x, y, TileKind.Industrial);
    return { success: true };
  },
  [Tool.Park]: ({ state, x, y }) => {
    state.money -= BUILD_COST[Tool.Park];
    setTile(state, x, y, TileKind.Park);
    return { success: true };
  },
  [Tool.Bulldoze]: ({ state, x, y }) => {
    state.money -= BUILD_COST[Tool.Bulldoze];
    setTile(state, x, y, TileKind.Land);
    return { success: true };
  }
};

export function applyTool(state: GameState, tool: Tool, x: number, y: number): ChangeResult {
  const tile = getTile(state, x, y);
  if (!tile) return { success: false };
  const cost = BUILD_COST[tool];
  if (state.money < cost) {
    return { success: false, message: 'Not enough funds' };
  }

  const handler = registry[tool];
  if (!handler) return { success: false };
  return handler({ state, tile, x, y });
}
