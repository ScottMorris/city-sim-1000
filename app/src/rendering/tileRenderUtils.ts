// tileRenderUtils.ts — resolveTileSprite: maps a tile to its texture/footprint for the renderer.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { Texture } from 'pixi.js';
import { isPowerCarrier } from '../game/adjacency';
import { POWER_PLANT_CONFIGS, PowerPlantType } from '../game/constants';
import { getBuildingTemplate } from '../game/buildings/templates';
import { getTile, TileKind, type GameState } from '../game/gameState';
import type { RoadVariant, TileTextures } from './tileAtlas';

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
  if (tile.kind === TileKind.Industrial && tile.buildingId !== undefined) {
    const factoryTextures = tileTextures.industrialBuildings ?? [];
    if (factoryTextures.length > 0) {
      const texture = factoryTextures[(tile.buildingId - 1) % factoryTextures.length];
      if (texture) {
        return { texture, widthTiles: 1, heightTiles: 1 };
      }
    }
  }
  const plantType = tile.powerPlantType ?? tileKindToPowerPlantType(tile.kind);
  if (plantType) {
    const footprint =
      (tile.buildingId && buildingLookup.get(tile.buildingId)?.template?.footprint) ??
      POWER_PLANT_CONFIGS[plantType]?.footprint;
    const origin =
      (tile.buildingId && buildingLookup.get(tile.buildingId)?.origin) ??
      (footprint ? { x, y } : undefined);
    if (footprint && origin) {
      const { width, height } = footprint;
      if (x === origin.x && y === origin.y) {
        const powerTexture = tileTextures.powerPlant[plantType];
        if (powerTexture) {
          return { texture: powerTexture, widthTiles: width, heightTiles: height, borderWidth: BUILDING_BORDER_WIDTH };
        }
      } else if (x >= origin.x && x < origin.x + width && y >= origin.y && y < origin.y + height) {
        return { skip: true };
      }
    }
    const fallbackTexture = tileTextures.powerPlant[plantType];
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
  if (
    (tile.kind === TileKind.Park || tile.kind === TileKind.ParkLarge) &&
    tile.buildingId !== undefined
  ) {
    const entry = buildingLookup.get(tile.buildingId);
    const template = entry?.template;
    const origin = entry?.origin;
    if (template && origin) {
      const width = template.footprint.width;
      const height = template.footprint.height;
      if (x === origin.x && y === origin.y) {
        const texture = tile.kind === TileKind.Park ? tileTextures.parks?.small : tileTextures.parks?.large;
        if (texture) {
          // No borderWidth: unlike schools/power plants, parks are ground-cover —
          // the source art's grass edges are designed to abut seamlessly, like Tree.
          return { texture, widthTiles: width, heightTiles: height };
        }
      } else if (x >= origin.x && x < origin.x + width && y >= origin.y && y < origin.y + height) {
        return { skip: true };
      }
    }
  }
  // Level crossing: a tile carrying both rail and road (either order of
  // construction) draws the crossing sprite, oriented by the rail axis.
  if ((tile.kind === TileKind.Rail && tile.roadUnderlay) ||
      (tile.kind === TileKind.Road && tile.railUnderlay)) {
    const crossingTexture = pickRailCrossingTexture(state, x, y, tileTextures);
    if (crossingTexture) return { texture: crossingTexture, widthTiles: 1, heightTiles: 1 };
  }
  if (tile.kind === TileKind.Rail) {
    const railTexture = pickRailTexture(state, x, y, tileTextures);
    if (railTexture) return { texture: railTexture, widthTiles: 1, heightTiles: 1 };
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
  const isPowerTile = tile.kind === TileKind.PowerLine || !!tile.powerPlantType
    || tileKindToPowerPlantType(tile.kind) !== undefined;
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

function tileKindToPowerPlantType(kind: TileKind): PowerPlantType | undefined {
  switch (kind) {
    case TileKind.HydroPlant:  return PowerPlantType.Hydro;
    case TileKind.CoalPlant:   return PowerPlantType.Coal;
    case TileKind.WindTurbine: return PowerPlantType.Wind;
    case TileKind.SolarFarm:   return PowerPlantType.Solar;
    default:                   return undefined;
  }
}

function pickRoadTexture(state: GameState, x: number, y: number, tileTextures: TileTextures): Texture | undefined {
  const connectsToRoad = (tx: number, ty: number) => {
    const neighbour = getTile(state, tx, ty);
    return neighbour?.kind === TileKind.Road || neighbour?.roadUnderlay === true;
  };

  const n = y > 0 && connectsToRoad(x, y - 1);
  const e = x < state.width  - 1 && connectsToRoad(x + 1, y);
  const s = y < state.height - 1 && connectsToRoad(x, y + 1);
  const w = x > 0 && connectsToRoad(x - 1, y);

  const variant = roadVariant(n, e, s, w);
  return tileTextures.road[variant];
}

/** Map the 4-bit N/E/S/W connectivity bitmask to the correct road tile variant. */
function roadVariant(n: boolean, e: boolean, s: boolean, w: boolean): RoadVariant {
  // Encode as 4-bit number: N=8 E=4 S=2 W=1
  const bits = (n ? 8 : 0) | (e ? 4 : 0) | (s ? 2 : 0) | (w ? 1 : 0);
  switch (bits) {
    case 0b1010: return 'ns';
    case 0b0101: return 'ew';
    case 0b1100: return 'corner-ne';
    case 0b1001: return 'corner-nw';
    case 0b0110: return 'corner-se';
    case 0b0011: return 'corner-sw';
    case 0b1110: return 't-nes';
    case 0b1101: return 't-new';
    case 0b1011: return 't-nsw';
    case 0b0111: return 't-esw';
    case 0b1111: return 'cross';
    case 0b1000: return 'end-n';
    case 0b0100: return 'end-e';
    case 0b0010: return 'end-s';
    case 0b0001: return 'end-w';
    default:     return 'cross'; // isolated tile — no neighbours
  }
}

function connectsToRail(state: GameState, tx: number, ty: number): boolean {
  const neighbour = getTile(state, tx, ty);
  return neighbour?.kind === TileKind.Rail || neighbour?.railUnderlay === true;
}

function railNeighbours(state: GameState, x: number, y: number) {
  return {
    n: y > 0 && connectsToRail(state, x, y - 1),
    e: x < state.width  - 1 && connectsToRail(state, x + 1, y),
    s: y < state.height - 1 && connectsToRail(state, x, y + 1),
    w: x > 0 && connectsToRail(state, x - 1, y)
  };
}

function pickRailTexture(state: GameState, x: number, y: number, tileTextures: TileTextures): Texture | undefined {
  const { n, e, s, w } = railNeighbours(state, x, y);
  // Rail reuses the road set's 15-variant connectivity mapping.
  return tileTextures.rail[roadVariant(n, e, s, w)];
}

function pickRailCrossingTexture(state: GameState, x: number, y: number, tileTextures: TileTextures): Texture | undefined {
  const { n, e, s, w } = railNeighbours(state, x, y);
  // The crossing sprite's rail runs along one axis; pick it from the rail
  // connectivity (road fills the other axis), defaulting isolated overlaps
  // to a north-south track.
  const axis = (n || s) ? 'ns' : (e || w) ? 'ew' : 'ns';
  return tileTextures.railCrossing[axis];
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
