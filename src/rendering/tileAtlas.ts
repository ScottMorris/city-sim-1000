import * as PIXI from 'pixi.js';
import { TileKind } from '../game/gameState';
import { PowerPlantType } from '../game/configs';
import { withBasePath } from '../utils/assetPaths';

export interface TileTextures {
  tiles: Partial<Record<TileKind, PIXI.Texture>>;
  road: Partial<Record<'north' | 'east' | 'south' | 'west', PIXI.Texture>>;
  powerPlant: Partial<Record<PowerPlantType, PIXI.Texture>>;
  powerLine: Partial<Record<'north' | 'east' | 'south' | 'west', PIXI.Texture>>;
  residentialHouses: PIXI.Texture[];
  commercialBuildings: PIXI.Texture[];
  commercialGeminiBuildings: PIXI.Texture[];
  schools: Partial<Record<'elementary' | 'high', PIXI.Texture>>;
}

const assetPath = (path: string) => withBasePath(path);

export async function loadPaletteTexture(): Promise<PIXI.Texture> {
  return PIXI.Assets.load(assetPath('assets/palette.png'));
}

const tileTexturePaths: Partial<Record<TileKind, string>> = {
  [TileKind.Land]: assetPath('assets/tiles/grass.png'),
  [TileKind.Water]: assetPath('assets/tiles/water.png'),
  [TileKind.Tree]: assetPath('assets/tiles/tree.png')
};

const roadTexturePaths: TileTextures['road'] = {
  north: assetPath('assets/tiles/road-north.png'),
  east: assetPath('assets/tiles/road-east.png'),
  south: assetPath('assets/tiles/road-sud.png'),
  west: assetPath('assets/tiles/road-ouest.png')
};

const powerPlantTexturePaths: Partial<Record<PowerPlantType, string>> = {
  [PowerPlantType.Hydro]: assetPath('assets/tiles/power-plant-hydro.png'),
  [PowerPlantType.Coal]: assetPath('assets/tiles/power-plant-coal.png'),
  [PowerPlantType.Solar]: assetPath('assets/tiles/power-plant-solar.png'),
  [PowerPlantType.Wind]: assetPath('assets/tiles/power-plant-wind.png')
};

const powerLineTexturePaths = {
  horizontal: assetPath('assets/tiles/power-line-horizontal.png'),
  vertical: assetPath('assets/tiles/power-line-vertical.png')
} as const;

const residentialHouseTexturePaths = [
  assetPath('assets/tiles/res-house-1.png'),
  assetPath('assets/tiles/res-house-2.png'),
  assetPath('assets/tiles/res-house-3.png')
];

const commercialBuildingTexturePaths = [
  assetPath('assets/tiles/com-shop-1.png'),
  assetPath('assets/tiles/com-shop-2.png'),
  assetPath('assets/tiles/com-shop-3.png')
];

const geminiCommercialTexturePaths = [assetPath('assets/tiles/com-1.png')];

const schoolTexturePaths: TileTextures['schools'] = {
  elementary: assetPath('assets/tiles/school-elementary.png'),
  high: assetPath('assets/tiles/school-high.png')
};

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
  const commercialGeminiBuildings = await Promise.all(
    geminiCommercialTexturePaths.map(async (path) => PIXI.Assets.load<PIXI.Texture>(path))
  );

  const schoolEntries = await Promise.all(
    Object.entries(schoolTexturePaths).map(async ([key, path]) => {
      const texture = await PIXI.Assets.load<PIXI.Texture>(path!);
      return [key as 'elementary' | 'high', texture] as const;
    })
  );

  return {
    tiles: Object.fromEntries(tileEntries),
    road: Object.fromEntries(roadEntries),
    powerPlant: Object.fromEntries(powerPlantEntries),
    powerLine: powerLineTextures,
    residentialHouses,
    commercialBuildings,
    commercialGeminiBuildings,
    schools: Object.fromEntries(schoolEntries)
  };
}
