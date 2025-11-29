import { TileKind } from './gameState';
import { Tool } from './toolTypes';

export const BUILD_COST: Record<Tool, number> = {
  [Tool.Inspect]: 0,
  [Tool.TerraformRaise]: 10,
  [Tool.TerraformLower]: 10,
  [Tool.Water]: 12,
  [Tool.Tree]: 8,
  [Tool.Road]: 5,
  [Tool.Rail]: 15,
  [Tool.PowerLine]: 6,
  [Tool.HydroPlant]: 600,
  [Tool.WaterPump]: 400,
  [Tool.Residential]: 40,
  [Tool.Commercial]: 60,
  [Tool.Industrial]: 80,
  [Tool.Bulldoze]: 1,
  [Tool.Park]: 10
};

export const MAINTENANCE: Partial<Record<TileKind, number>> = {
  [TileKind.Road]: 0.1,
  [TileKind.Rail]: 0.2,
  [TileKind.PowerLine]: 0.08,
  [TileKind.HydroPlant]: 3,
  [TileKind.WaterPump]: 2,
  [TileKind.Park]: 0.05
};

export const BASE_INCOME = 120;

export const LOCAL_STORAGE_KEY = 'city-sim-1000-save';
