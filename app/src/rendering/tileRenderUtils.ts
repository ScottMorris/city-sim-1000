// tileRenderUtils.ts — resolveTileSprite: maps a tile to its texture/footprint for the renderer.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { Texture } from 'pixi.js';

import { POWER_PLANT_CONFIGS, PowerPlantType } from '../game/constants';
import { getBuildingTemplate } from '../game/buildings/templates';
import { getTile, TileKind, type GameState } from '../game/gameState';
import { Occupant, Terrain, hasOccupant, zoneOccupant } from '../game/protocol/occupants';
import type { CarriagewayClass, HydroVariant, RoadVariant, TileTextures } from './tileAtlas';

export type BuildingLookupEntry = {
  template: ReturnType<typeof getBuildingTemplate>;
  origin: { x: number; y: number };
};

export type BuildingLookup = Map<number, BuildingLookupEntry>;

export type TileSpriteInfo =
  | {
      texture: Texture;
      widthTiles: number;
      heightTiles: number;
      borderWidth?: number;
      /** Drawn on top of `texture`, for infrastructure that crosses rather
       *  than replaces what is beneath it (hydro over a road, rail or zone). */
      overlayTexture?: Texture;
    }
  | { skip: true }
  /** No base texture resolved (e.g. an undeveloped zoned lot, drawn as a flat
   *  colour) but hydro still crosses the tile — draw this over the flat fill
   *  instead of leaving nothing but a debug label. */
  | { overlayOnly: Texture }
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

/** A developed zone lot — the one case a live `PowerLine` occupant and a
 *  `buildingId` can coexist (a `Structure` occupant refuses to place over a
 *  line, so a plant/school/park with a buildingId never carries one). */
function isDevelopedZone(tile: NonNullable<ReturnType<typeof getTile>>): boolean {
  return zoneOccupant(tile.surface) !== undefined && tile.buildingId !== undefined;
}

/** True when hydro is strung over this tile and must be drawn as a separate
 *  layer, rather than being the tile's own opaque wire sprite.
 *
 *  A bare `PowerLine` on otherwise-empty land is excluded — its opaque
 *  sprite already includes the wires, and compositing again would
 *  double-draw them — which is exactly the case where nothing else occupies
 *  the tile: no road/rail/zone on the surface, no tree canopy overhead
 *  (`Occupant::Trees` conflicts with `Occupant::PowerLine` in principle, but
 *  the tree tool's documented defect can still leave both set), and the
 *  ground itself isn't water (a line spanning water is a pylon span, always
 *  drawn over the water sprite).
 *
 *  A developed zone lot severs the overlay entirely, regardless of what else
 *  is on the tile — this is the fix for the pole rendered through a built
 *  house: once a lot develops, the line is severed at that tile and only
 *  visibly continues from the neighbour's side (see `carriesWires`). */
function carriesHydroOverlay(tile: NonNullable<ReturnType<typeof getTile>>): boolean {
  if (!hasOccupant(tile.overhead, Occupant.PowerLine)) return false;
  if (isDevelopedZone(tile)) return false;
  const bareLine =
    tile.terrain === Terrain.Land && tile.surface === 0 && !hasOccupant(tile.overhead, Occupant.Trees);
  return !bareLine;
}

export function resolveTileSprite(
  state: GameState,
  tile: ReturnType<typeof getTile>,
  x: number,
  y: number,
  tileTextures: TileTextures,
  buildingLookup: BuildingLookup
): TileSpriteInfo {
  const base = resolveBaseTileSprite(state, tile, x, y, tileTextures, buildingLookup);
  if (!tile) return base;
  if (base && 'skip' in base) return base;
  if (!carriesHydroOverlay(tile)) return base;
  const overlayTexture =
    pickHydroCrossingTexture(state, tile, x, y, tileTextures) ??
    pickHydroKerbsideTexture(state, tile, x, y, tileTextures) ??
    pickPowerLineTexture(state, x, y, tileTextures, true);
  if (!overlayTexture) return base;
  // No base texture resolved — an undeveloped zoned lot, drawn as a flat
  // colour fill — but hydro crosses it. Composite the overlay over that
  // fill instead of falling through to a debug label with nothing drawn.
  if (!base) return { overlayOnly: overlayTexture };
  return { ...base, overlayTexture };
}

/** Is there a road or rail on this tile? A direct occupant read — the old
 *  two-spellings problem this used to guard against (a line built before its
 *  road versus after leaving different `kind`/underlay combinations) doesn't
 *  exist for an occupant bit: `Occupant.Road` is either set or it isn't, no
 *  matter which order the tools ran in. */
function carriagewayBeneath(tile: NonNullable<ReturnType<typeof getTile>>) {
  return {
    road: hasOccupant(tile.surface, Occupant.Road),
    rail: hasOccupant(tile.surface, Occupant.Rail)
  };
}

/** Which carriageway situation a tile presents to the line above it, or
 *  undefined if there is nothing beneath. Road and rail are the same problem
 *  — both are full-width and neither wants a pole in it — so they're merged
 *  by axis rather than kept apart by kind. */
function carriagewayClass(
  state: GameState,
  tile: NonNullable<ReturnType<typeof getTile>>,
  x: number,
  y: number
): CarriagewayClass | undefined {
  const { road, rail } = carriagewayBeneath(tile);
  if (!road && !rail) return undefined;
  let ns = false;
  let ew = false;
  for (const flags of [
    road ? roadNeighbourFlags(state, x, y) : undefined,
    rail ? railNeighbourFlags(state, x, y) : undefined
  ]) {
    if (!flags) continue;
    const [bn, be, bs, bw] = flags;
    ns ||= bn || bs;
    ew ||= be || bw;
  }
  if (ns && ew) return 'junction';
  if (ns) return 'along-ns';
  if (ew) return 'along-ew';
  // A stub with no neighbours at all still has an axis in its own sprite, but
  // nothing here can tell which; treat it as a north-south lane so the pole at
  // least moves sideways off it rather than staying planted in the middle.
  return 'along-ns';
}

/** The pole moved out to the kerb, for every case a two-pole crossing doesn't
 *  cover: a line running along a carriageway, dead-ending on one, or turning
 *  or branching on one. Without this the single-pole sprite was drawn as-is
 *  and the pole stood in the traffic lane — 103 of the 128 (variant,
 *  substrate) combinations, which is most of them. */
function pickHydroKerbsideTexture(
  state: GameState,
  tile: NonNullable<ReturnType<typeof getTile>>,
  x: number,
  y: number,
  tileTextures: TileTextures
): Texture | undefined {
  const cls = carriagewayClass(state, tile, x, y);
  if (!cls) return undefined;
  const variant: HydroVariant = hasAnyWireNeighbour(state, x, y)
    ? hydroVariant(state, x, y)
    : 'isolated';
  return tileTextures.powerLineKerbside?.[cls]?.[variant];
}

/** A line crossing a carriageway is carried by poles standing either side of
 *  it, not by one planted in the middle. Only applies when the line runs
 *  straight and square across what's beneath — a line turning a corner or
 *  branching inside a road tile has no clean "either side", and a line
 *  running *along* a road still needs its own pole or the wires float
 *  unsupported for the whole stretch. */
function pickHydroCrossingTexture(
  state: GameState,
  tile: NonNullable<ReturnType<typeof getTile>>,
  x: number,
  y: number,
  tileTextures: TileTextures
): Texture | undefined {
  const { road, rail } = carriagewayBeneath(tile);
  if (!road && !rail) return undefined;
  const hydro = hydroVariant(state, x, y);
  if (hydro !== 'ns' && hydro !== 'ew') return undefined;
  // Test the AXIS of what's beneath, not its exact variant. Matching variant
  // names ('ew', 'end-e', ...) silently missed T-junctions and 4-ways, so a
  // line crossing a busy junction fell back to a pole in the carriageway
  // while the plain stretch either side got two — visibly inconsistent.
  //
  // Test BOTH substrates, not whichever one happens to be checked first. On a
  // level crossing the road and the rail run on different axes by definition,
  // so a line squarely crossing one runs along the other; picking rail and
  // ignoring the road planted a pole in the roadway at every such tile.
  const crossesBeneath =
    (rail ? crossesAxis(hydro, railNeighbourFlags(state, x, y)) : false) ||
    (road ? crossesAxis(hydro, roadNeighbourFlags(state, x, y)) : false);
  return crossesBeneath ? tileTextures.powerLineCrossing[hydro] : undefined;
}

/** Does a line on `hydro`'s axis run square across something laid out along
 *  these N/E/S/W flags? */
function crossesAxis(hydro: 'ns' | 'ew', [bn, be, bs, bw]: [boolean, boolean, boolean, boolean]): boolean {
  return hydro === 'ns' ? be || bw : bn || bs;
}

/** The road or rail a hydro tile was laid over, if any. */
function pickPowerUnderlayTexture(
  state: GameState,
  tile: NonNullable<ReturnType<typeof getTile>>,
  x: number,
  y: number,
  tileTextures: TileTextures
): Texture | undefined {
  const { road, rail } = carriagewayBeneath(tile);
  if (road && rail) {
    return pickRailCrossingTexture(state, x, y, tileTextures);
  }
  if (rail) return tileTextures.rail[roadVariant(...railNeighbourFlags(state, x, y))];
  if (road) return pickRoadTexture(state, x, y, tileTextures);
  return undefined;
}

function railNeighbourFlags(state: GameState, x: number, y: number): [boolean, boolean, boolean, boolean] {
  const { n, e, s, w } = railNeighbours(state, x, y);
  return [n, e, s, w];
}

function resolveBaseTileSprite(
  state: GameState,
  tile: ReturnType<typeof getTile>,
  x: number,
  y: number,
  tileTextures: TileTextures,
  buildingLookup: BuildingLookup
): TileSpriteInfo {
  if (!tile) return undefined;
  const zone = zoneOccupant(tile.surface);
  if (zone === Occupant.ZoneResidential && tile.buildingId !== undefined) {
    const houseTextures = tileTextures.residentialHouses ?? [];
    if (houseTextures.length > 0) {
      const texture = houseTextures[(tile.buildingId - 1) % houseTextures.length];
      if (texture) {
        return { texture, widthTiles: 1, heightTiles: 1 };
      }
    }
  }
  if (zone === Occupant.ZoneCommercial && tile.buildingId !== undefined) {
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
  if (zone === Occupant.ZoneIndustrial && tile.buildingId !== undefined) {
    const factoryTextures = tileTextures.industrialBuildings ?? [];
    if (factoryTextures.length > 0) {
      const texture = factoryTextures[(tile.buildingId - 1) % factoryTextures.length];
      if (texture) {
        return { texture, widthTiles: 1, heightTiles: 1 };
      }
    }
  }
  const buildingEntry = tile.buildingId !== undefined ? buildingLookup.get(tile.buildingId) : undefined;
  const plantType = tile.powerPlantType ?? buildingEntry?.template?.power?.type;
  if (plantType) {
    const footprint = buildingEntry?.template?.footprint ?? POWER_PLANT_CONFIGS[plantType]?.footprint;
    const origin = buildingEntry?.origin ?? (footprint ? { x, y } : undefined);
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
  // `template.tileKind` — the building-template key, not the per-tile shim —
  // is the sanctioned surviving use of `TileKind` (see `occupants.ts`).
  const templateKind = buildingEntry?.template?.tileKind;
  if (
    (templateKind === TileKind.ElementarySchool || templateKind === TileKind.HighSchool) &&
    tile.buildingId !== undefined
  ) {
    const template = buildingEntry?.template;
    const origin = buildingEntry?.origin;
    if (template && origin) {
      const width = template.footprint.width;
      const height = template.footprint.height;
      if (x === origin.x && y === origin.y) {
        const texture =
          templateKind === TileKind.ElementarySchool
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
    (templateKind === TileKind.Park || templateKind === TileKind.ParkLarge) &&
    tile.buildingId !== undefined
  ) {
    const template = buildingEntry?.template;
    const origin = buildingEntry?.origin;
    if (template && origin) {
      const width = template.footprint.width;
      const height = template.footprint.height;
      if (x === origin.x && y === origin.y) {
        const texture = templateKind === TileKind.Park ? tileTextures.parks?.small : tileTextures.parks?.large;
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
  // A zone tag (developed or not), a `Structure` occupant with no dedicated
  // branch above (e.g. a water pump/tower), or tree canopy always wins the
  // ground beneath it — mirrors the deleted `display.rs` precedence ladder's
  // zone/Structure/Trees tiers, all of which outrank hydro/rail/road. An
  // undeveloped zoned lot has no base texture of its own (`tileTextures.tiles`
  // has no entry for a bare zone kind), so it still falls through to the
  // `undefined` return below — the caller composites hydro as an
  // `overlayOnly` layer in that case rather than this function drawing a
  // wire sprite as if the lot were open ground.
  const groundEncumbered =
    zone !== undefined ||
    hasOccupant(tile.surface, Occupant.Structure) ||
    hasOccupant(tile.overhead, Occupant.Trees) ||
    tile.terrain === Terrain.Water;
  if (!groundEncumbered) {
    const { road, rail } = carriagewayBeneath(tile);
    // Level crossing: a tile carrying both rail and road (either order of
    // construction) draws the crossing sprite, oriented by the rail axis.
    if (road && rail) {
      const crossingTexture = pickRailCrossingTexture(state, x, y, tileTextures);
      if (crossingTexture) return { texture: crossingTexture, widthTiles: 1, heightTiles: 1 };
    }
    if (hasOccupant(tile.overhead, Occupant.PowerLine)) {
      // Hydro crosses infrastructure rather than replacing it. When the tile
      // also carries a road or rail, draw that here and let the caller
      // composite the transparent wire twin on top; the opaque wire sprite is
      // only correct on open ground.
      const underlay = pickPowerUnderlayTexture(state, tile, x, y, tileTextures);
      if (underlay) return { texture: underlay, widthTiles: 1, heightTiles: 1 };
      const powerTexture = pickPowerLineTexture(state, x, y, tileTextures);
      if (powerTexture) return { texture: powerTexture, widthTiles: 1, heightTiles: 1 };
    } else if (rail) {
      const railTexture = pickRailTexture(state, x, y, tileTextures);
      if (railTexture) return { texture: railTexture, widthTiles: 1, heightTiles: 1 };
    } else if (road) {
      const roadTexture = pickRoadTexture(state, x, y, tileTextures);
      if (roadTexture) return { texture: roadTexture, widthTiles: 1, heightTiles: 1 };
    }
  }
  const baseTexture = tileTextures.tiles[tile.kind];
  if (baseTexture) return { texture: baseTexture, widthTiles: 1, heightTiles: 1 };
  return undefined;
}

export function getTileColour(tile: ReturnType<typeof getTile>, palette: Record<TileKind, number>) {
  if (!tile) return 0x000000;
  const base = palette[tile.kind];
  const isPowerTile =
    hasOccupant(tile.overhead, Occupant.PowerLine) || !!tile.powerPlantType || tileKindToPowerPlantType(tile.kind) !== undefined;
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
    return !!neighbour && hasOccupant(neighbour.surface, Occupant.Road);
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
  return !!neighbour && hasOccupant(neighbour.surface, Occupant.Rail);
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

/** Does this neighbour visibly carry wires?
 *
 *  Deliberately NOT `isPowerCarrier`. That predicate answers a *simulation*
 *  question — power flows through roads, rails, zones and buildings — and
 *  using it to choose a sprite made every hydro tile grow a leg toward any
 *  adjacent road, so a line running beside a road reached out and touched it
 *  on every tile. Wires should only be drawn between things that actually
 *  string wires: other hydro tiles, zones with a line over them, and plants.
 *
 *  A developed zone lot is excluded even though the line survives there in
 *  the simulation (the lot's `PowerLine` occupant is unaffected) — visually
 *  the pole is severed at that tile (see `carriesHydroOverlay`), so a
 *  neighbour reaching toward it draws a dead-end stub rather than a wire
 *  running across the roof. */
function carriesWires(tile: ReturnType<typeof getTile>): boolean {
  if (!tile) return false;
  if (isDevelopedZone(tile)) return false;
  if (hasOccupant(tile.overhead, Occupant.PowerLine)) return true;
  return (tile.powerPlantType ?? tileKindToPowerPlantType(tile.kind)) !== undefined;
}

function hasAnyWireNeighbour(state: GameState, x: number, y: number): boolean {
  return (
    (y > 0 && carriesWires(getTile(state, x, y - 1))) ||
    (x < state.width - 1 && carriesWires(getTile(state, x + 1, y))) ||
    (y < state.height - 1 && carriesWires(getTile(state, x, y + 1))) ||
    (x > 0 && carriesWires(getTile(state, x - 1, y)))
  );
}

function hydroVariant(state: GameState, x: number, y: number): RoadVariant {
  const connects = (tx: number, ty: number) => carriesWires(getTile(state, tx, ty));
  return roadVariant(
    y > 0 && connects(x, y - 1),
    x < state.width - 1 && connects(x + 1, y),
    y < state.height - 1 && connects(x, y + 1),
    x > 0 && connects(x - 1, y)
  );
}

function roadNeighbourFlags(state: GameState, x: number, y: number): [boolean, boolean, boolean, boolean] {
  const connects = (tx: number, ty: number) => {
    const n = getTile(state, tx, ty);
    return !!n && hasOccupant(n.surface, Occupant.Road);
  };
  return [
    y > 0 && connects(x, y - 1),
    x < state.width - 1 && connects(x + 1, y),
    y < state.height - 1 && connects(x, y + 1),
    x > 0 && connects(x - 1, y)
  ];
}

function pickPowerLineTexture(
  state: GameState,
  x: number,
  y: number,
  tileTextures: TileTextures,
  overlay = false
): Texture | undefined {

  // Hydro reuses the road set's 15-variant connectivity mapping. Previously
  // only straight runs and dead ends resolved, so corners, T-junctions and
  // crossings returned undefined and the renderer fell back to a flat colour
  // rect.
  if (!hasAnyWireNeighbour(state, x, y)) {
    // A lone tile used to fall back to the 4-way cross, sprouting wires in
    // every direction that reached to nothing.
    return overlay ? tileTextures.powerLineIsolatedOverlay : tileTextures.powerLineIsolated;
  }
  const set = overlay ? tileTextures.powerLineOverlay : tileTextures.powerLine;
  return set[hydroVariant(state, x, y)];
}
