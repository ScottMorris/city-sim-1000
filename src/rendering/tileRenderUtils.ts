import type { Texture } from 'pixi.js';
import { isPowerCarrier } from '../game/adjacency';
import { POWER_PLANT_CONFIGS } from '../game/constants';
import { getBuildingTemplate } from '../game/buildings';
import { getTile, TileKind, type GameState } from '../game/gameState';
import type { TileTextures } from './tileAtlas';

export type BuildingLookupEntry = {
  template: ReturnType<typeof getBuildingTemplate>;
  origin: { x: number; y: number };
};

export type BuildingLookup = Map<number, BuildingLookupEntry>;

export type TileSpriteInfo =
  | { texture: Texture; widthTiles: number; heightTiles: number; borderWidth?: number }
  | { skip: true }
  | undefined;

const BUILDING_BORDER_WIDTH = 1;

export function createBuildingLookup(state: GameState) {
  const buildingLookup: BuildingLookup = new Map();
  const multiTileCoverage = new Int32Array(state.width * state.height);

  for (const building of state.buildings) {
    const template = getBuildingTemplate(building.templateId);
    if (!template) continue;
    buildingLookup.set(building.id, { template, origin: building.origin });
    const { width, height } = template.footprint;
    if (width <= 1 && height <= 1) continue;
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const tx = building.origin.x + dx;
        const ty = building.origin.y + dy;
        if (tx >= 0 && tx < state.width && ty >= 0 && ty < state.height) {
          const idx = ty * state.width + tx;
          multiTileCoverage[idx] = building.id;
        }
      }
    }
  }

  return { buildingLookup, multiTileCoverage };
}

export function resolveTileSprite(
  state: GameState,
  tile: ReturnType<typeof getTile>,
  x: number,
  y: number,
  tileTextures: TileTextures,
  buildingLookup: BuildingLookup
): TileSpriteInfo {
  if (!tile) return undefined;
  if (tile.kind === TileKind.Residential && tile.buildingId !== undefined) {
    const houseTextures = tileTextures.residentialHouses ?? [];
    if (houseTextures.length > 0) {
      const texture = houseTextures[(tile.buildingId - 1) % houseTextures.length];
      if (texture) {
        return { texture, widthTiles: 1, heightTiles: 1 };
      }
    }
  }
  if (tile.kind === TileKind.Commercial && tile.buildingId !== undefined) {
    const baseTextures = tileTextures.commercialBuildings ?? [];
    const geminiEnabled = state.settings?.cosmetics?.geminiBuildingsEnabled ?? false;
    const geminiTextures = geminiEnabled ? tileTextures.commercialGeminiBuildings ?? [] : [];
    const comTextures = [...baseTextures, ...geminiTextures];
    if (comTextures.length > 0) {
      const texture = comTextures[(tile.buildingId - 1) % comTextures.length];
      if (texture) {
        return { texture, widthTiles: 1, heightTiles: 1 };
      }
    }
  }
  if (tile.kind === TileKind.HydroPlant && tile.powerPlantType) {
    const footprint =
      (tile.buildingId && buildingLookup.get(tile.buildingId)?.template?.footprint) ??
      POWER_PLANT_CONFIGS[tile.powerPlantType]?.footprint;
    const origin =
      (tile.buildingId && buildingLookup.get(tile.buildingId)?.origin) ??
      (footprint ? { x, y } : undefined);
    if (footprint && origin) {
      const { width, height } = footprint;
      if (x === origin.x && y === origin.y) {
        const powerTexture = tileTextures.powerPlant[tile.powerPlantType];
        if (powerTexture) {
            return { texture: powerTexture, widthTiles: width, heightTiles: height, borderWidth: BUILDING_BORDER_WIDTH };
          }
        } else if (x >= origin.x && x < origin.x + width && y >= origin.y && y < origin.y + height) {
          return { skip: true };
        }
      }
    const fallbackTexture = tileTextures.powerPlant[tile.powerPlantType];
    if (fallbackTexture)
      return { texture: fallbackTexture, widthTiles: 1, heightTiles: 1, borderWidth: BUILDING_BORDER_WIDTH };
  }
  if (
    (tile.kind === TileKind.ElementarySchool || tile.kind === TileKind.HighSchool) &&
    tile.buildingId !== undefined
  ) {
    const entry = buildingLookup.get(tile.buildingId);
    const template = entry?.template;
    const origin = entry?.origin;
    if (template && origin) {
      const width = template.footprint.width;
      const height = template.footprint.height;
      if (x === origin.x && y === origin.y) {
        const texture =
          tile.kind === TileKind.ElementarySchool
            ? tileTextures.schools?.elementary
            : tileTextures.schools?.high;
        if (texture) {
          return { texture, widthTiles: width, heightTiles: height, borderWidth: BUILDING_BORDER_WIDTH };
        }
      } else if (x >= origin.x && x < origin.x + width && y >= origin.y && y < origin.y + height) {
        return { skip: true };
      }
    }
  }
  if (tile.kind === TileKind.Road) {
    const roadTexture = pickRoadTexture(state, x, y, tileTextures);
    if (roadTexture) return { texture: roadTexture, widthTiles: 1, heightTiles: 1 };
  }
  if (tile.kind === TileKind.PowerLine) {
    const powerTexture = pickPowerLineTexture(state, x, y, tileTextures);
    if (powerTexture) return { texture: powerTexture, widthTiles: 1, heightTiles: 1 };
  }
  const baseTexture = tileTextures.tiles[tile.kind];
  if (baseTexture) return { texture: baseTexture, widthTiles: 1, heightTiles: 1 };
  return undefined;
}

export function getTileColour(tile: ReturnType<typeof getTile>, palette: Record<TileKind, number>) {
  if (!tile) return 0x000000;
  const base = palette[tile.kind];
  const isPowerTile = tile.kind === TileKind.PowerLine || !!tile.powerPlantType;
  if (!isPowerTile) return base;
  const factor = tile.powered ? 1.35 : 0.7;
  return scaleColor(base, factor);
}

export function scaleColor(color: number, factor: number): number {
  const r = Math.max(0, Math.min(255, ((color >> 16) & 0xff) * factor));
  const g = Math.max(0, Math.min(255, ((color >> 8) & 0xff) * factor));
  const b = Math.max(0, Math.min(255, (color & 0xff) * factor));
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

function pickRoadTexture(state: GameState, x: number, y: number, tileTextures: TileTextures): Texture | undefined {
  const connectsToRoad = (tx: number, ty: number) => {
    const neighbour = getTile(state, tx, ty);
    return neighbour?.kind === TileKind.Road || neighbour?.roadUnderlay === true;
  };

  const north = y > 0 && connectsToRoad(x, y - 1);
  const south = y < state.height - 1 && connectsToRoad(x, y + 1);
  const east = x < state.width - 1 && connectsToRoad(x + 1, y);
  const west = x > 0 && connectsToRoad(x - 1, y);

  const roadTextures = tileTextures.road;
  const neighbours = [north, east, south, west].filter(Boolean).length;

  // Only render sprites for straights/endcaps; leave corners/crossings as grey to flag missing art.
  if (neighbours === 2 && north && south && !east && !west) {
    return roadTextures.north ?? roadTextures.south;
  }
  if (neighbours === 2 && east && west && !north && !south) {
    return roadTextures.east ?? roadTextures.west;
  }
  if (neighbours === 1) {
    if (north) return roadTextures.north;
    if (east) return roadTextures.east;
    if (south) return roadTextures.south;
    if (west) return roadTextures.west;
  }

  return undefined;
}

function pickPowerLineTexture(state: GameState, x: number, y: number, tileTextures: TileTextures): Texture | undefined {
  const connectsToPower = (tx: number, ty: number) => {
    const neighbour = getTile(state, tx, ty);
    return isPowerCarrier(neighbour);
  };

  const north = y > 0 && connectsToPower(x, y - 1);
  const south = y < state.height - 1 && connectsToPower(x, y + 1);
  const east = x < state.width - 1 && connectsToPower(x + 1, y);
  const west = x > 0 && connectsToPower(x - 1, y);

  const powerTextures = tileTextures.powerLine;
  const neighbours = [north, east, south, west].filter(Boolean).length;

  if (neighbours === 2 && north && south && !east && !west) {
    return powerTextures.north ?? powerTextures.south;
  }
  if (neighbours === 2 && east && west && !north && !south) {
    return powerTextures.east ?? powerTextures.west;
  }
  if (neighbours === 1) {
    if (north || south) return powerTextures.north ?? powerTextures.south;
    if (east || west) return powerTextures.east ?? powerTextures.west;
  }

  return undefined;
}
