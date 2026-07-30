import { PowerPlantType } from '../constants';
import { GameState, Tile, TileKind, bumpTileRevision, getTile } from '../gameState';
import { tileHasPower, tileHasWater } from '../adjacency';
import {
  Occupant,
  Stratum,
  Terrain,
  ZONE_MASK,
  clearTileStratum,
  hasOccupant,
  iterSet,
  pairConflicts,
  setTileOccupant,
  tileOccupants
} from '../protocol/occupants';

/** The zone tag a lot must carry to develop into `kind`. Mirrors `zone_template_kind`'s inverse in `occupants.rs`. */
const ZONE_OCCUPANT_FOR_KIND: Partial<Record<TileKind, Occupant>> = {
  [TileKind.Residential]: Occupant.ZoneResidential,
  [TileKind.Commercial]: Occupant.ZoneCommercial,
  [TileKind.Industrial]: Occupant.ZoneIndustrial
};
import { BuildingTemplate, getBuildingTemplate, getPowerPlantTemplate } from './templates';
import { BuildingInstance, createBuildingState, BuildingStatus } from './state';

export interface BuildingPlacementResult {
  success: boolean;
  message?: string;
  instance?: BuildingInstance;
}

/**
 * The first occupant standing on `tile` that refuses `incoming`, in bit
 * order. Mirrors `refused_by` in `crates/city-sim-core/src/commands.rs` —
 * same helper `tools.ts` ports for its own placement guards.
 */
function refusedBy(tile: Tile, incoming: Occupant, displaces: number): Occupant | undefined {
  const standing = tileOccupants(tile.underground, tile.surface, tile.overhead) & ~displaces;
  return iterSet(standing).find((o) => pairConflicts(o, incoming));
}

/**
 * Place a multi-tile civic/power building's footprint. Mirrors
 * `place_footprint_building` in `commands.rs`: regrades every covered tile
 * to `Terrain::Land` with an empty surface, then stamps `Occupant::Structure`
 * and the shared `buildingId` — the zone tags are displaced (a park stamped
 * over a residential lot is ordinary play), so what's left of `Structure`'s
 * conflict set is road, rail and a hydro line, all caught by one
 * `refusedBy` call.
 *
 * Not for zone growth: a developed zone lot's occupant is its zone tag, not
 * `Structure` (`occupants.ts`'s own note on this) — see `placeZoneBuilding`.
 */
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
      if (tile.buildingId !== undefined) {
        return { success: false, message: 'Cannot overlap another building. Bulldoze first.' };
      }
      if (refusedBy(tile, Occupant.Structure, ZONE_MASK) !== undefined) {
        return { success: false, message: 'Cannot build here — clear roads and powerlines first.' };
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
    tile.terrain = Terrain.Land;
    clearTileStratum(tile, Stratum.Surface);
    setTileOccupant(tile, Occupant.Trees, false);
    setTileOccupant(tile, Occupant.Structure, true);
    tile.buildingId = buildingId;
    tile.abandoned = false;
    tile.powerPlantId = undefined;
    tile.happiness = Math.min(1.5, tile.happiness + 0.05);
    decorateTile?.(tile, buildingId);
  }
  bumpTileRevision(state);

  state.nextBuildingId = buildingId + 1;
  return { success: true, instance };
}

/**
 * Develop an already-zoned lot into a building. Mirrors `place_zone_building`
 * in `crates/city-sim-core/src/zones.rs` — the zone-growth counterpart to
 * `placeBuilding`, and deliberately much smaller: unlike a footprint
 * building, developing a lot touches no occupant bit at all. The zone tag
 * a player painted stays exactly as it was; only `buildingId` changes, which
 * is why a developed lot's occupant is still its zone tag and not
 * `Structure`.
 */
export function placeZoneBuilding(state: GameState, kind: TileKind, x: number, y: number): BuildingPlacementResult {
  const tile = getTile(state, x, y);
  if (!tile) return { success: false, message: 'Invalid tile location' };
  if (tile.buildingId !== undefined) {
    return { success: false, message: 'Cannot overlap another building. Bulldoze first.' };
  }
  const zoneOccupant = ZONE_OCCUPANT_FOR_KIND[kind];
  if (zoneOccupant === undefined || !hasOccupant(tile.surface, zoneOccupant)) {
    return { success: false, message: 'Tile is not zoned for this building type' };
  }
  const template = getBuildingTemplate(kind);
  if (!template) return { success: false, message: 'Unknown building type' };

  const buildingId = state.nextBuildingId ?? 1;
  const instance: BuildingInstance = {
    id: buildingId,
    templateId: template.id,
    origin: { x, y },
    state: createBuildingState()
  };
  state.buildings.push(instance);

  tile.buildingId = buildingId;
  tile.abandoned = false;
  bumpTileRevision(state);

  state.nextBuildingId = buildingId + 1;
  return { success: true, instance };
}

export function removeBuilding(state: GameState, buildingId: number) {
  state.buildings = (state.buildings || []).filter((b) => b.id !== buildingId);
  for (const tile of state.tiles) {
    if (tile.buildingId === buildingId) {
      // The `Structure` tag goes with the development — it is unrepresentable
      // without a `buildingId` behind it (`occupants.ts`'s own note). A
      // developed zone lot has no `Structure` bit to clear in the first
      // place, so this is a no-op for it: the zone tag survives untouched
      // and the lot regrows, mirroring `remove_building` in `commands.rs`.
      setTileOccupant(tile, Occupant.Structure, false);
      tile.buildingId = undefined;
      tile.powerPlantType = undefined;
      tile.powerPlantId = undefined;
      tile.happiness = Math.min(1.5, tile.happiness + 0.05);
    }
  }
  bumpTileRevision(state);
}

export function updateBuildingStates(state: GameState, options: { waterEnabled?: boolean } = {}) {
  const waterEnabled = options.waterEnabled ?? true;
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

    const needsWater = waterEnabled && template.requiresWater !== false && (template.waterUse ?? 0) > 0;
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
