// Tile, road, school, and building texture path constants and async asset loader.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import * as PIXI from 'pixi.js';
import { PowerPlantType } from '../game/constants';
import { Terrain } from '../game/protocol/occupants';
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

export const ROAD_VARIANT_NAMES: readonly RoadVariant[] = [
  'ns', 'ew',
  'corner-ne', 'corner-nw', 'corner-se', 'corner-sw',
  't-nes', 't-new', 't-nsw', 't-esw',
  'cross',
  'end-n', 'end-e', 'end-s', 'end-w'
];

/** Hydro has one more case than road: a pole with nothing attached. */
export type HydroVariant = RoadVariant | 'isolated';

/** What a hydro tile was laid over, named for the CARRIAGEWAY's axis rather
 *  than the line's — `along-ns` is a road or rail running north-south. A tile
 *  carrying both axes (a 4-way, or a level crossing) is a `junction`. */
export type CarriagewayClass = 'along-ns' | 'along-ew' | 'junction';

export interface TileTextures {
  /** Keyed by the sim's own `Terrain` enum (`game/protocol/occupants.ts`),
   *  not a UI-only vocabulary — the ground sprite for a tile IS its terrain,
   *  one texture per `Terrain` member. */
  terrain: Partial<Record<Terrain, PIXI.Texture>>;
  /** Tree canopy is a ground-cover sprite too (it replaces the terrain
   *  texture beneath it, same as `terrain`'s two entries), but it's an
   *  `Occupant.Trees` bit, not a `Terrain` value, so it isn't indexed
   *  alongside them. */
  treeCanopy?: PIXI.Texture;
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
  /** A pole with nothing attached, for a tile with no wire neighbours. */
  powerLineIsolated?: PIXI.Texture;
  powerLineIsolatedOverlay?: PIXI.Texture;
  /** Kerbside twins, keyed by carriageway situation then connectivity: the
   *  pole stands clear of the traffic lane rather than in it. */
  powerLineKerbside: Record<CarriagewayClass, Partial<Record<HydroVariant, PIXI.Texture>>>;
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

const terrainTexturePaths: Record<Terrain, string> = {
  [Terrain.Land]:  assetPath('assets/tiles/terrain/grass.png'),
  [Terrain.Water]: assetPath('assets/tiles/terrain/water.png')
};

const treeCanopyTexturePath = assetPath('assets/tiles/terrain/tree.png');

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

const powerLineIsolatedPath = assetPath('assets/tiles/power/power-line-isolated.png');
const powerLineIsolatedOverlayPath = assetPath('assets/tiles/power/power-line-isolated-overlay.png');

export const HYDRO_VARIANTS: readonly HydroVariant[] = [...ROAD_VARIANT_NAMES, 'isolated'];
export const CARRIAGEWAY_CLASSES: readonly CarriagewayClass[] = ['along-ns', 'along-ew', 'junction'];

/** A straight line square across the carriageway is carried on two poles, so
 *  it has no kerbside twin — `powerLineCrossing` serves it instead. */
export function isSquareCrossing(cls: CarriagewayClass, variant: HydroVariant): boolean {
  if (variant !== 'ns' && variant !== 'ew') return false;
  return cls === 'junction' || (cls === 'along-ns') === (variant === 'ew');
}

// Kerbside twins: the same variants again, once per carriageway situation,
// with the pole moved off the traffic lane and the legs rebuilt to reach it.
// Overlay-only — they never occur on open ground (issue #169).
const powerLineKerbsideTexturePaths = Object.fromEntries(
  CARRIAGEWAY_CLASSES.map((cls) => [
    cls,
    Object.fromEntries(
      HYDRO_VARIANTS.filter((v) => !isSquareCrossing(cls, v)).map((v) => [
        v,
        assetPath(`assets/tiles/power/power-line-${v}-${cls}.png`)
      ])
    ) as Partial<Record<HydroVariant, string>>
  ])
) as Record<CarriagewayClass, Partial<Record<HydroVariant, string>>>;

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
  const terrainEntries = await Promise.all(
    (Object.entries(terrainTexturePaths) as unknown as [Terrain, string][]).map(async ([key, path]) => {
      const texture = await PIXI.Assets.load<PIXI.Texture>(path);
      return [key, texture] as const;
    })
  );
  const treeCanopy = await PIXI.Assets.load<PIXI.Texture>(treeCanopyTexturePath);

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

  const powerLineKerbsideEntries = await Promise.all(
    CARRIAGEWAY_CLASSES.map(async (cls) => {
      const variants = await Promise.all(
        Object.entries(powerLineKerbsideTexturePaths[cls]).map(async ([variant, path]) => {
          const texture = await PIXI.Assets.load<PIXI.Texture>(path);
          return [variant, texture] as const;
        })
      );
      return [cls, Object.fromEntries(variants)] as const;
    })
  );

  const [powerLineIsolated, powerLineIsolatedOverlay] = await Promise.all([
    PIXI.Assets.load<PIXI.Texture>(powerLineIsolatedPath),
    PIXI.Assets.load<PIXI.Texture>(powerLineIsolatedOverlayPath)
  ]);

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
    terrain:                Object.fromEntries(terrainEntries),
    treeCanopy,
    road:                   Object.fromEntries(roadEntries),
    rail:                   Object.fromEntries(railEntries),
    railCrossing:           Object.fromEntries(railCrossingEntries),
    powerPlant:             Object.fromEntries(powerPlantEntries),
    powerLine:              Object.fromEntries(powerLineEntries),
    powerLineOverlay:       Object.fromEntries(powerLineOverlayEntries),
    powerLineCrossing:      Object.fromEntries(powerLineCrossingEntries),
    powerLineIsolated,
    powerLineIsolatedOverlay,
    powerLineKerbside:      Object.fromEntries(powerLineKerbsideEntries) as
      Record<CarriagewayClass, Partial<Record<HydroVariant, PIXI.Texture>>>,
    residentialHouses,
    commercialBuildings,
    commercialGeminiBuildings,
    industrialBuildings,
    schools:                Object.fromEntries(schoolEntries),
    parks:                  Object.fromEntries(parkEntries),
    indicators:             Object.fromEntries(indicatorEntries)
  };
}
