import { POWER_PLANT_CONFIGS, PowerPlantType } from './constants';
import type { GameState, Tile } from './gameState';
import { getTile, TileKind } from './gameState';

export enum BuildingCategory {
  Power = 'power'
}

export enum BuildingStatus {
  Active = 'active',
  Inactive = 'inactive'
}

export interface BuildingState {
  status: BuildingStatus;
}

export interface BuildingTemplate {
  id: string;
  name: string;
  category: BuildingCategory;
  footprint: { width: number; height: number };
  cost: number;
  maintenance: number;
  tileKind: TileKind;
  spriteKey?: string;
  power?: { type: PowerPlantType; outputMw: number };
}

export interface BuildingInstance {
  id: number;
  templateId: string;
  origin: { x: number; y: number };
  state: BuildingState;
}

export interface BuildingPlacementResult {
  success: boolean;
  message?: string;
  instance?: BuildingInstance;
}

export const POWER_PLANT_TEMPLATES: Record<PowerPlantType, BuildingTemplate> = {
  [PowerPlantType.Hydro]: {
    id: PowerPlantType.Hydro,
    name: POWER_PLANT_CONFIGS[PowerPlantType.Hydro].name,
    category: BuildingCategory.Power,
    footprint: POWER_PLANT_CONFIGS[PowerPlantType.Hydro].footprint,
    cost: POWER_PLANT_CONFIGS[PowerPlantType.Hydro].buildCost,
    maintenance: POWER_PLANT_CONFIGS[PowerPlantType.Hydro].maintenancePerDay,
    tileKind: TileKind.HydroPlant,
    power: { type: PowerPlantType.Hydro, outputMw: POWER_PLANT_CONFIGS[PowerPlantType.Hydro].outputMw }
  },
  [PowerPlantType.Coal]: {
    id: PowerPlantType.Coal,
    name: POWER_PLANT_CONFIGS[PowerPlantType.Coal].name,
    category: BuildingCategory.Power,
    footprint: POWER_PLANT_CONFIGS[PowerPlantType.Coal].footprint,
    cost: POWER_PLANT_CONFIGS[PowerPlantType.Coal].buildCost,
    maintenance: POWER_PLANT_CONFIGS[PowerPlantType.Coal].maintenancePerDay,
    tileKind: TileKind.HydroPlant,
    power: { type: PowerPlantType.Coal, outputMw: POWER_PLANT_CONFIGS[PowerPlantType.Coal].outputMw }
  },
  [PowerPlantType.Wind]: {
    id: PowerPlantType.Wind,
    name: POWER_PLANT_CONFIGS[PowerPlantType.Wind].name,
    category: BuildingCategory.Power,
    footprint: POWER_PLANT_CONFIGS[PowerPlantType.Wind].footprint,
    cost: POWER_PLANT_CONFIGS[PowerPlantType.Wind].buildCost,
    maintenance: POWER_PLANT_CONFIGS[PowerPlantType.Wind].maintenancePerDay,
    tileKind: TileKind.HydroPlant,
    power: { type: PowerPlantType.Wind, outputMw: POWER_PLANT_CONFIGS[PowerPlantType.Wind].outputMw }
  },
  [PowerPlantType.Solar]: {
    id: PowerPlantType.Solar,
    name: POWER_PLANT_CONFIGS[PowerPlantType.Solar].name,
    category: BuildingCategory.Power,
    footprint: POWER_PLANT_CONFIGS[PowerPlantType.Solar].footprint,
    cost: POWER_PLANT_CONFIGS[PowerPlantType.Solar].buildCost,
    maintenance: POWER_PLANT_CONFIGS[PowerPlantType.Solar].maintenancePerDay,
    tileKind: TileKind.HydroPlant,
    power: { type: PowerPlantType.Solar, outputMw: POWER_PLANT_CONFIGS[PowerPlantType.Solar].outputMw }
  }
};

export function getBuildingTemplate(templateId: string): BuildingTemplate | undefined {
  const powerTemplate = (POWER_PLANT_TEMPLATES as Record<string, BuildingTemplate>)[templateId];
  if (powerTemplate) return powerTemplate;
  return undefined;
}

export function getPowerPlantTemplate(type: PowerPlantType): BuildingTemplate {
  return POWER_PLANT_TEMPLATES[type];
}

export function createBuildingState(): BuildingState {
  return { status: BuildingStatus.Active };
}

export function placeBuilding(
  state: GameState,
  template: BuildingTemplate,
  x: number,
  y: number,
  decorateTile?: (tile: Tile, buildingId: number) => void
): BuildingPlacementResult {
  const { width, height } = template.footprint;
  if (x + width > state.width || y + height > state.height) {
    return { success: false, message: `${template.name} needs ${width}x${height} tiles in-bounds` };
  }

  const tiles: Tile[] = [];
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      const tile = getTile(state, x + dx, y + dy);
      if (!tile) {
        return { success: false, message: 'Invalid tile location' };
      }
      if (tile.buildingId !== undefined || tile.powerPlantType) {
        return { success: false, message: 'Cannot overlap another building' };
      }
      tiles.push(tile);
    }
  }

  const buildingId = state.nextBuildingId ?? 1;
  const instance: BuildingInstance = {
    id: buildingId,
    templateId: template.id,
    origin: { x, y },
    state: createBuildingState()
  };
  state.buildings.push(instance);

  for (const tile of tiles) {
    tile.kind = template.tileKind;
    tile.buildingId = buildingId;
    tile.powerPlantId = undefined;
    tile.happiness = Math.min(1.5, tile.happiness + 0.05);
    decorateTile?.(tile, buildingId);
  }

  state.nextBuildingId = buildingId + 1;
  return { success: true, instance };
}

export function removeBuilding(state: GameState, buildingId: number) {
  state.buildings = (state.buildings || []).filter((b) => b.id !== buildingId);
  for (const tile of state.tiles) {
    if (tile.buildingId === buildingId) {
      tile.kind = TileKind.Land;
      tile.buildingId = undefined;
      tile.powerPlantType = undefined;
      tile.powerPlantId = undefined;
      tile.happiness = Math.min(1.5, tile.happiness + 0.05);
    }
  }
}

export interface PowerPlantInfo {
  id: number;
  type: PowerPlantType;
  template?: BuildingTemplate;
  instance?: BuildingInstance;
}

export function listPowerPlants(state: GameState): PowerPlantInfo[] {
  const plants = new Map<number, PowerPlantInfo>();
  for (const instance of state.buildings || []) {
    const template = getBuildingTemplate(instance.templateId);
    if (template?.power) {
      plants.set(instance.id, {
        id: instance.id,
        type: template.power.type,
        template,
        instance
      });
    }
  }

  state.tiles.forEach((tile, index) => {
    if (!tile.powerPlantType) return;
    const id = tile.buildingId ?? tile.powerPlantId ?? index;
    if (plants.has(id)) return;
    plants.set(id, {
      id,
      type: tile.powerPlantType,
      template: getPowerPlantTemplate(tile.powerPlantType)
    });
  });

  return Array.from(plants.values());
}
