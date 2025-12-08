import { PowerPlantType } from '../constants';
import { GameState, Tile, getTile, TileKind } from '../gameState';
import { tileHasPower, tileHasWater } from '../adjacency';
import { BuildingTemplate, getBuildingTemplate, getPowerPlantTemplate } from './templates';
import { BuildingInstance, createBuildingState, BuildingStatus } from './state';

export interface BuildingPlacementResult {
  success: boolean;
  message?: string;
  instance?: BuildingInstance;
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
    tile.abandoned = false;
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

export function updateBuildingStates(state: GameState) {
  for (const instance of state.buildings) {
    const template = getBuildingTemplate(instance.templateId);
    if (!template) continue;
    if (instance.state.health <= 0) {
      instance.state.status = BuildingStatus.InactiveDamaged;
      continue;
    }
    const needsPower = template.requiresPower !== false;
    let hasPower = true;
    const { width, height } = template.footprint;

    if (needsPower) {
      let poweredTiles = 0;
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) {
          if (tileHasPower(state, instance.origin.x + dx, instance.origin.y + dy)) {
            poweredTiles++;
          }
        }
      }
      hasPower = poweredTiles === width * height;
    }

    if (!hasPower) {
      instance.state.status = BuildingStatus.InactiveNoPower;
      continue;
    }

    const needsWater = (template.waterUse ?? 0) > 0;
    if (needsWater) {
      let wateredTiles = 0;
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) {
          if (tileHasWater(state, instance.origin.x + dx, instance.origin.y + dy)) {
            wateredTiles++;
          }
        }
      }
      const fullyWatered = wateredTiles === width * height;
      instance.state.status = fullyWatered ? BuildingStatus.Active : BuildingStatus.InactiveNoWater;
    } else {
      instance.state.status = BuildingStatus.Active;
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
