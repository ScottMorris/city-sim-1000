// Tile, road, school, and building texture path constants and async asset loader.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import * as PIXI from 'pixi.js';
import { TileKind } from '../game/gameState';
import { PowerPlantType } from '../game/constants';
import { withBasePath } from '../utils/assetPaths';

/**
 * All 15 road connectivity variants (a 4-bit bitmask of N/E/S/W neighbours).
 * The isolated-road case (no neighbours) falls back to 'cross'.
 */
export type RoadVariant =
  | 'ns' | 'ew'
  | 'corner-ne' | 'corner-nw' | 'corner-se' | 'corner-sw'
  | 't-nes' | 't-new' | 't-nsw' | 't-esw'
  | 'cross'
  | 'end-n' | 'end-e' | 'end-s' | 'end-w';

export interface TileTextures {
  tiles: Partial<Record<TileKind, PIXI.Texture>>;
  road: Partial<Record<RoadVariant, PIXI.Texture>>;
  rail: Partial<Record<RoadVariant, PIXI.Texture>>;
  railCrossing: Partial<Record<'ns' | 'ew', PIXI.Texture>>;
  powerPlant: Partial<Record<PowerPlantType, PIXI.Texture>>;
  powerLine: Partial<Record<RoadVariant, PIXI.Texture>>;
  /** Transparent twins, composited over the road/rail/zone a line crosses. */
  powerLineOverlay: Partial<Record<RoadVariant, PIXI.Texture>>;
  /** Two-pole twins: a line crossing a carriageway is carried by poles either
   *  side of it, not by one planted in the middle. */
  powerLineCrossing: Partial<Record<'ns' | 'ew', PIXI.Texture>>;
  residentialHouses: PIXI.Texture[];
  commercialBuildings: PIXI.Texture[];
  commercialGeminiBuildings: PIXI.Texture[];
  industrialBuildings: PIXI.Texture[];
  schools: Partial<Record<'elementary' | 'high', PIXI.Texture>>;
  parks: Partial<Record<'small' | 'large', PIXI.Texture>>;
  indicators: Partial<Record<'noPower' | 'noWater', PIXI.Texture>>;
}

const assetPath = (path: string) => withBasePath(path);

export async function loadPaletteTexture(): Promise<PIXI.Texture> {
  return PIXI.Assets.load(assetPath('assets/palette.png'));
}

const tileTexturePaths: Partial<Record<TileKind, string>> = {
  [TileKind.Land]:  assetPath('assets/tiles/terrain/grass.png'),
  [TileKind.Water]: assetPath('assets/tiles/terrain/water.png'),
  [TileKind.Tree]:  assetPath('assets/tiles/terrain/tree.png')
};

const roadTexturePaths: Record<RoadVariant, string> = {
  'ns':         assetPath('assets/tiles/roads/road-ns.png'),
  'ew':         assetPath('assets/tiles/roads/road-ew.png'),
  'corner-ne':  assetPath('assets/tiles/roads/road-corner-ne.png'),
  'corner-nw':  assetPath('assets/tiles/roads/road-corner-nw.png'),
  'corner-se':  assetPath('assets/tiles/roads/road-corner-se.png'),
  'corner-sw':  assetPath('assets/tiles/roads/road-corner-sw.png'),
  't-nes':      assetPath('assets/tiles/roads/road-t-nes.png'),
  't-new':      assetPath('assets/tiles/roads/road-t-new.png'),
  't-nsw':      assetPath('assets/tiles/roads/road-t-nsw.png'),
  't-esw':      assetPath('assets/tiles/roads/road-t-esw.png'),
  'cross':      assetPath('assets/tiles/roads/road-cross.png'),
  'end-n':      assetPath('assets/tiles/roads/road-end-n.png'),
  'end-e':      assetPath('assets/tiles/roads/road-end-e.png'),
  'end-s':      assetPath('assets/tiles/roads/road-end-s.png'),
  'end-w':      assetPath('assets/tiles/roads/road-end-w.png')
};

// Rail shares the road set's 15-variant connectivity naming; the two level
// crossings are picked when a tile carries both rail and road.
const railTexturePaths: Record<RoadVariant, string> = {
  'ns':         assetPath('assets/tiles/rails/rail-ns.png'),
  'ew':         assetPath('assets/tiles/rails/rail-ew.png'),
  'corner-ne':  assetPath('assets/tiles/rails/rail-corner-ne.png'),
  'corner-nw':  assetPath('assets/tiles/rails/rail-corner-nw.png'),
  'corner-se':  assetPath('assets/tiles/rails/rail-corner-se.png'),
  'corner-sw':  assetPath('assets/tiles/rails/rail-corner-sw.png'),
  't-nes':      assetPath('assets/tiles/rails/rail-t-nes.png'),
  't-new':      assetPath('assets/tiles/rails/rail-t-new.png'),
  't-nsw':      assetPath('assets/tiles/rails/rail-t-nsw.png'),
  't-esw':      assetPath('assets/tiles/rails/rail-t-esw.png'),
  'cross':      assetPath('assets/tiles/rails/rail-cross.png'),
  'end-n':      assetPath('assets/tiles/rails/rail-end-n.png'),
  'end-e':      assetPath('assets/tiles/rails/rail-end-e.png'),
  'end-s':      assetPath('assets/tiles/rails/rail-end-s.png'),
  'end-w':      assetPath('assets/tiles/rails/rail-end-w.png')
};

const railCrossingTexturePaths = {
  ns: assetPath('assets/tiles/rails/rail-road-crossing-ns.png'),
  ew: assetPath('assets/tiles/rails/rail-road-crossing-ew.png')
} as const;

const powerPlantTexturePaths: Partial<Record<PowerPlantType, string>> = {
  [PowerPlantType.Hydro]: assetPath('assets/tiles/power/power-plant-hydro.png'),
  [PowerPlantType.Coal]:  assetPath('assets/tiles/power/power-plant-coal.png'),
  [PowerPlantType.Solar]: assetPath('assets/tiles/power/power-plant-solar.png'),
  [PowerPlantType.Wind]:  assetPath('assets/tiles/power/power-plant-wind.png')
};

// Hydro lines share the road set's 15-variant connectivity naming. Before
// this set existed there were only two sprites (a vertical and a horizontal
// run), so corners, T-junctions and crossings had nothing to draw and fell
// through to a flat colour rect.
const powerLineTexturePaths: Record<RoadVariant, string> = {
  'ns':         assetPath('assets/tiles/power/power-line-ns.png'),
  'ew':         assetPath('assets/tiles/power/power-line-ew.png'),
  'corner-ne':  assetPath('assets/tiles/power/power-line-corner-ne.png'),
  'corner-nw':  assetPath('assets/tiles/power/power-line-corner-nw.png'),
  'corner-se':  assetPath('assets/tiles/power/power-line-corner-se.png'),
  'corner-sw':  assetPath('assets/tiles/power/power-line-corner-sw.png'),
  't-nes':      assetPath('assets/tiles/power/power-line-t-nes.png'),
  't-new':      assetPath('assets/tiles/power/power-line-t-new.png'),
  't-nsw':      assetPath('assets/tiles/power/power-line-t-nsw.png'),
  't-esw':      assetPath('assets/tiles/power/power-line-t-esw.png'),
  'cross':      assetPath('assets/tiles/power/power-line-cross.png'),
  'end-n':      assetPath('assets/tiles/power/power-line-end-n.png'),
  'end-e':      assetPath('assets/tiles/power/power-line-end-e.png'),
  'end-s':      assetPath('assets/tiles/power/power-line-end-s.png'),
  'end-w':      assetPath('assets/tiles/power/power-line-end-w.png')
};

const residentialHouseTexturePaths = [
  assetPath('assets/tiles/buildings/res-house-1.png'),
  assetPath('assets/tiles/buildings/res-house-2.png'),
  assetPath('assets/tiles/buildings/res-house-3.png'),
  assetPath('assets/tiles/buildings/res-house-4.png'),
  // Asset Studio (rich-pixel-48) houses — studio/scenes/house.py, house2.py, house3.py.
  assetPath('assets/tiles/buildings/res-house-5.png'),
  assetPath('assets/tiles/buildings/res-house-6.png'),
  assetPath('assets/tiles/buildings/res-house-7.png')
];

const commercialBuildingTexturePaths = [
  assetPath('assets/tiles/buildings/com-shop-1.png'),
  assetPath('assets/tiles/buildings/com-shop-2.png'),
  assetPath('assets/tiles/buildings/com-shop-3.png'),
  // Asset Studio (rich-pixel-48) shops — studio/scenes/shop.py, shop2.py, shop3.py.
  assetPath('assets/tiles/buildings/com-shop-4.png'),
  assetPath('assets/tiles/buildings/com-shop-5.png'),
  assetPath('assets/tiles/buildings/com-shop-6.png')
];

const geminiCommercialTexturePaths = [assetPath('assets/tiles/buildings/com-1.png')];

const industrialBuildingTexturePaths = [
  assetPath('assets/tiles/buildings/ind-factory-1.png'),
  assetPath('assets/tiles/buildings/ind-factory-2.png'),
  assetPath('assets/tiles/buildings/ind-high-tech-1.png'),
  // Asset Studio (rich-pixel-48) buildings — studio/scenes/factory.py,
  // warehouse.py, hightech.py, factory2.py, factory3.py.
  assetPath('assets/tiles/buildings/ind-factory-3.png'),
  assetPath('assets/tiles/buildings/ind-warehouse-1.png'),
  assetPath('assets/tiles/buildings/ind-high-tech-2.png'),
  assetPath('assets/tiles/buildings/ind-factory-4.png'),
  assetPath('assets/tiles/buildings/ind-factory-5.png')
];

// Transparent twins of the hydro set. Same 15 variants, grass fill omitted,
// so the renderer can draw them over whatever the line crosses (issue #169).
const powerLineOverlayTexturePaths = Object.fromEntries(
  (Object.entries(powerLineTexturePaths) as [RoadVariant, string][]).map(([variant, p]) => [
    variant,
    p.replace(/\.png$/, '-overlay.png')
  ])
) as Record<RoadVariant, string>;

const powerLineCrossingTexturePaths = {
  ns: assetPath('assets/tiles/power/power-line-ns-crossing.png'),
  ew: assetPath('assets/tiles/power/power-line-ew-crossing.png')
} as const;

const schoolTexturePaths = {
  elementary: assetPath('assets/tiles/buildings/school-elementary.png'),
  high:       assetPath('assets/tiles/buildings/school-high.png')
};

const parkTexturePaths = {
  small: assetPath('assets/tiles/buildings/park-small.png'),
  large: assetPath('assets/tiles/buildings/park-large.png')
};

const indicatorTexturePaths = {
  noPower: assetPath('assets/tiles/indicators/indicator-no-power.png'),
  noWater: assetPath('assets/tiles/indicators/indicator-no-water.png')
};

export async function loadTileTextures(): Promise<TileTextures> {
  const tileEntries = await Promise.all(
    Object.entries(tileTexturePaths).map(async ([kind, path]) => {
      const texture = await PIXI.Assets.load<PIXI.Texture>(path);
      return [kind as TileKind, texture] as const;
    })
  );

  const roadEntries = await Promise.all(
    (Object.entries(roadTexturePaths) as [RoadVariant, string][]).map(async ([variant, path]) => {
      const texture = await PIXI.Assets.load<PIXI.Texture>(path);
      return [variant, texture] as const;
    })
  );

  const railEntries = await Promise.all(
    (Object.entries(railTexturePaths) as [RoadVariant, string][]).map(async ([variant, path]) => {
      const texture = await PIXI.Assets.load<PIXI.Texture>(path);
      return [variant, texture] as const;
    })
  );

  const railCrossingEntries = await Promise.all(
    (Object.entries(railCrossingTexturePaths) as ['ns' | 'ew', string][]).map(async ([key, path]) => {
      const texture = await PIXI.Assets.load<PIXI.Texture>(path);
      return [key, texture] as const;
    })
  );

  const powerPlantEntries = await Promise.all(
    Object.entries(powerPlantTexturePaths).map(async ([type, path]) => {
      const texture = await PIXI.Assets.load<PIXI.Texture>(path!);
      return [type as PowerPlantType, texture] as const;
    })
  );

  const powerLineEntries = await Promise.all(
    (Object.entries(powerLineTexturePaths) as [RoadVariant, string][]).map(async ([variant, path]) => {
      const texture = await PIXI.Assets.load<PIXI.Texture>(path);
      return [variant, texture] as const;
    })
  );

  const powerLineOverlayEntries = await Promise.all(
    (Object.entries(powerLineOverlayTexturePaths) as [RoadVariant, string][]).map(async ([variant, path]) => {
      const texture = await PIXI.Assets.load<PIXI.Texture>(path);
      return [variant, texture] as const;
    })
  );

  const powerLineCrossingEntries = await Promise.all(
    (Object.entries(powerLineCrossingTexturePaths) as ['ns' | 'ew', string][]).map(async ([key, path]) => {
      const texture = await PIXI.Assets.load<PIXI.Texture>(path);
      return [key, texture] as const;
    })
  );

  const residentialHouses = await Promise.all(
    residentialHouseTexturePaths.map(async (path) => PIXI.Assets.load<PIXI.Texture>(path))
  );

  const commercialBuildings = await Promise.all(
    commercialBuildingTexturePaths.map(async (path) => PIXI.Assets.load<PIXI.Texture>(path))
  );
  const commercialGeminiBuildings = await Promise.all(
    geminiCommercialTexturePaths.map(async (path) => PIXI.Assets.load<PIXI.Texture>(path))
  );

  const industrialBuildings = await Promise.all(
    industrialBuildingTexturePaths.map(async (path) => PIXI.Assets.load<PIXI.Texture>(path))
  );

  const schoolEntries = await Promise.all(
    Object.entries(schoolTexturePaths).map(async ([key, path]) => {
      const texture = await PIXI.Assets.load<PIXI.Texture>(path!);
      return [key as 'elementary' | 'high', texture] as const;
    })
  );

  const parkEntries = await Promise.all(
    Object.entries(parkTexturePaths).map(async ([key, path]) => {
      const texture = await PIXI.Assets.load<PIXI.Texture>(path);
      return [key as 'small' | 'large', texture] as const;
    })
  );

  const indicatorEntries = await Promise.all(
    (Object.entries(indicatorTexturePaths) as ['noPower' | 'noWater', string][]).map(async ([key, path]) => {
      const texture = await PIXI.Assets.load<PIXI.Texture>(path);
      texture.source.scaleMode = 'nearest';
      return [key, texture] as const;
    })
  );

  return {
    tiles:                  Object.fromEntries(tileEntries),
    road:                   Object.fromEntries(roadEntries),
    rail:                   Object.fromEntries(railEntries),
    railCrossing:           Object.fromEntries(railCrossingEntries),
    powerPlant:             Object.fromEntries(powerPlantEntries),
    powerLine:              Object.fromEntries(powerLineEntries),
    powerLineOverlay:       Object.fromEntries(powerLineOverlayEntries),
    powerLineCrossing:      Object.fromEntries(powerLineCrossingEntries),
    residentialHouses,
    commercialBuildings,
    commercialGeminiBuildings,
    industrialBuildings,
    schools:                Object.fromEntries(schoolEntries),
    parks:                  Object.fromEntries(parkEntries),
    indicators:             Object.fromEntries(indicatorEntries)
  };
}
