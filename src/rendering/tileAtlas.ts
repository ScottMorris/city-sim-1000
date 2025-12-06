import * as PIXI from 'pixi.js';
import { TileKind } from '../game/gameState';
import { PowerPlantType } from '../game/constants';

export interface TileTextures {
  tiles: Partial<Record<TileKind, PIXI.Texture>>;
  road: Partial<Record<'north' | 'east' | 'south' | 'west', PIXI.Texture>>;
  powerPlant: Partial<Record<PowerPlantType, PIXI.Texture>>;
  powerLine: Partial<Record<'north' | 'east' | 'south' | 'west', PIXI.Texture>>;
  residentialHouses: PIXI.Texture[];
  commercialBuildings: PIXI.Texture[];
}

export async function loadPaletteTexture(): Promise<PIXI.Texture> {
  return PIXI.Assets.load('/assets/palette.png');
}

const tileTexturePaths: Partial<Record<TileKind, string>> = {
  [TileKind.Land]: '/assets/tiles/grass.png',
  [TileKind.Water]: '/assets/tiles/water.png',
  [TileKind.Tree]: '/assets/tiles/tree.png'
};

const roadTexturePaths: TileTextures['road'] = {
  north: '/assets/tiles/road-north.png',
  east: '/assets/tiles/road-east.png',
  south: '/assets/tiles/road-sud.png',
  west: '/assets/tiles/road-ouest.png'
};

const powerPlantTexturePaths: Partial<Record<PowerPlantType, string>> = {
  [PowerPlantType.Hydro]: '/assets/tiles/power-plant-hydro.png',
  [PowerPlantType.Coal]: '/assets/tiles/power-plant-coal.png',
  [PowerPlantType.Solar]: '/assets/tiles/power-plant-solar.png',
  [PowerPlantType.Wind]: '/assets/tiles/power-plant-wind.png'
};

const powerLineTexturePaths = {
  horizontal: '/assets/tiles/power-line-horizontal.png',
  vertical: '/assets/tiles/power-line-vertical.png'
} as const;

const residentialHouseTexturePaths = [
  '/assets/tiles/res-house-1.png',
  '/assets/tiles/res-house-2.png',
  '/assets/tiles/res-house-3.png'
];

const commercialBuildingTexturePaths = ['/assets/tiles/com-1.png'];

export async function loadTileTextures(): Promise<TileTextures> {
  const tileEntries = await Promise.all(
    Object.entries(tileTexturePaths).map(async ([kind, path]) => {
      const texture = await PIXI.Assets.load<PIXI.Texture>(path);
      return [kind as TileKind, texture] as const;
    })
  );

  const roadEntries = await Promise.all(
    Object.entries(roadTexturePaths).map(async ([dir, path]) => {
      const texture = await PIXI.Assets.load<PIXI.Texture>(path!);
      return [dir, texture] as const;
    })
  );

  const powerPlantEntries = await Promise.all(
    Object.entries(powerPlantTexturePaths).map(async ([type, path]) => {
      const texture = await PIXI.Assets.load<PIXI.Texture>(path!);
      return [type as PowerPlantType, texture] as const;
    })
  );

  const [powerLineHorizontal, powerLineVertical] = await Promise.all([
    PIXI.Assets.load<PIXI.Texture>(powerLineTexturePaths.horizontal),
    PIXI.Assets.load<PIXI.Texture>(powerLineTexturePaths.vertical)
  ]);
  const powerLineTextures: TileTextures['powerLine'] = {
    east: powerLineHorizontal,
    west: powerLineHorizontal,
    north: powerLineVertical,
    south: powerLineVertical
  };

  const residentialHouses = await Promise.all(
    residentialHouseTexturePaths.map(async (path) => PIXI.Assets.load<PIXI.Texture>(path))
  );

  const commercialBuildings = await Promise.all(
    commercialBuildingTexturePaths.map(async (path) => PIXI.Assets.load<PIXI.Texture>(path))
  );

  return {
    tiles: Object.fromEntries(tileEntries),
    road: Object.fromEntries(roadEntries),
    powerPlant: Object.fromEntries(powerPlantEntries),
    powerLine: powerLineTextures,
    residentialHouses,
    commercialBuildings
  };
}
