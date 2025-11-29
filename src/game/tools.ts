import { BUILD_COST } from './constants';
import { GameState, TileKind, Tool, getTile, setTile } from './gameState';

export interface ChangeResult {
  success: boolean;
  message?: string;
}

export function applyTool(state: GameState, tool: Tool, x: number, y: number): ChangeResult {
  const tile = getTile(state, x, y);
  if (!tile) return { success: false };
  const cost = BUILD_COST[tool];
  if (state.money < cost) {
    return { success: false, message: 'Not enough funds' };
  }
  const charge = () => {
    state.money -= cost;
  };

  switch (tool) {
    case Tool.Terraform:
      charge();
      setTile(state, x, y, TileKind.Land);
      return { success: true };
    case Tool.Water:
      charge();
      setTile(state, x, y, TileKind.Water);
      return { success: true };
    case Tool.Tree:
      charge();
      setTile(state, x, y, TileKind.Tree);
      return { success: true };
    case Tool.Road:
      charge();
      setTile(state, x, y, TileKind.Road);
      return { success: true };
    case Tool.Rail:
      charge();
      setTile(state, x, y, TileKind.Rail);
      return { success: true };
    case Tool.PowerLine:
      charge();
      setTile(state, x, y, TileKind.PowerLine);
      return { success: true };
    case Tool.HydroPlant:
      charge();
      setTile(state, x, y, TileKind.HydroPlant);
      return { success: true };
    case Tool.WaterPump:
      charge();
      setTile(state, x, y, TileKind.WaterPump);
      return { success: true };
    case Tool.Residential:
      charge();
      setTile(state, x, y, TileKind.Residential);
      return { success: true };
    case Tool.Commercial:
      charge();
      setTile(state, x, y, TileKind.Commercial);
      return { success: true };
    case Tool.Industrial:
      charge();
      setTile(state, x, y, TileKind.Industrial);
      return { success: true };
    case Tool.Park:
      charge();
      setTile(state, x, y, TileKind.Park);
      return { success: true };
    case Tool.Bulldoze:
      charge();
      setTile(state, x, y, TileKind.Land);
      return { success: true };
    default:
      return { success: false };
  }
}
