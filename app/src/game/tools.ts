// tools.ts — applyTool: cost, placement rules, and per-tool handlers.
//
// Mirrors `apply_tool` in `crates/city-sim-core/src/commands.rs` — occupant-
// native, like the Rust it is a test oracle for, since Phase 7 of the strata
// migration. `applyTool` itself is not reachable from production: the
// browser/desktop clients send `SimCommand`s to the real Rust engine over
// the WASM/Tauri bridge (see `CLAUDE.md`'s "SimBridge" section) and this
// file's only caller is the test suite.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { BUILD_COST, PowerPlantType } from './constants';
import { type BuildingTemplate, getBuildingTemplate, getPowerPlantTemplate } from './buildings/templates';
import { placeBuilding, removeBuilding } from './buildings/manager';
import { GameState, Tile, TileKind, bumpTileRevision, getTile } from './gameState';
import { resyncLegacyFromStrata } from './protocol/legacyProjection';
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
} from './protocol/occupants';
import { Tool } from './toolTypes';

export interface ChangeResult {
  success: boolean;
  message?: string;
}

export interface ToolContext {
  state: GameState;
  tile: Tile;
  x: number;
  y: number;
}

export type ToolHandler = (ctx: ToolContext, cost: number) => ChangeResult;

export type ToolRegistry = Record<Tool, ToolHandler>;

export function getToolCost(tool: Tool): number {
  const templateCost = getBuildingTemplate(tool)?.cost;
  if (templateCost !== undefined) return templateCost;
  return BUILD_COST[tool] ?? 0;
}

function structureKindOf(state: GameState, buildingId: number): TileKind | undefined {
  const instance = state.buildings.find((b) => b.id === buildingId);
  return instance ? getBuildingTemplate(instance.templateId)?.tileKind : undefined;
}

/** Bring `tile`'s shim fields back in sync after an occupant-native mutation. */
function syncLegacy(state: GameState, tile: Tile): void {
  resyncLegacyFromStrata(tile, (buildingId) => structureKindOf(state, buildingId));
}

/**
 * The first occupant standing on `tile` that refuses `incoming`, in bit
 * order. Mirrors `refused_by` in `crates/city-sim-core/src/commands.rs`.
 *
 * `OCCUPANT_DEFS`'s conflict table says which pairs cannot share a tile; it
 * does not say what happens when the player asks for one anyway. Only
 * refusal needs a guard, so each caller names the conflicts it resolves by
 * *displacement* in `displaces` and everything left over is refused.
 */
function refusedBy(tile: Tile, incoming: Occupant, displaces: number): Occupant | undefined {
  const standing = tileOccupants(tile.underground, tile.surface, tile.overhead) & ~displaces;
  return iterSet(standing).find((o) => pairConflicts(o, incoming));
}

/**
 * Why a regrade must refuse this tile, if it must. Mirrors `regrade_refusal`.
 * A live building is the one thing a regrade cannot wipe on the player's
 * behalf — doing so would leave the `BuildingInstance` running with no tile
 * under it.
 */
function regradeRefusal(tile: Tile | undefined): string | undefined {
  if (tile?.buildingId !== undefined) return 'A building occupies this tile. Bulldoze first.';
  return undefined;
}

/**
 * Rewrite the ground at (x, y): set the terrain, and clear the surface
 * stratum and the tree canopy — leaving the hydro span and anything buried
 * standing. Mirrors `regrade_at`.
 */
function regradeAt(state: GameState, x: number, y: number, terrain: Terrain): void {
  const tile = getTile(state, x, y);
  if (!tile) return;
  tile.terrain = terrain;
  clearTileStratum(tile, Stratum.Surface);
  setTileOccupant(tile, Occupant.Trees, false);
  bumpTileRevision(state);
}

/** Remove any building whose footprint covers (x, y). Mirrors `clear_building_at`. */
function clearBuildingAt(state: GameState, x: number, y: number): void {
  const tile = getTile(state, x, y);
  if (tile?.buildingId !== undefined) {
    removeBuilding(state, tile.buildingId);
  }
}

/**
 * Place a multi-tile civic/power building at (x, y). Mirrors
 * `place_footprint_building`. The overlap check refuses a developed tile,
 * and anything the structure conflicts with that it does not simply
 * displace — the zone tags are displaced (a park stamped over a residential
 * lot is ordinary play), so what is left of `Occupant::Structure`'s
 * conflict set is road, rail and the hydro line, all caught by one
 * `refusedBy` call.
 */
function placeFootprintBuilding(
  state: GameState,
  template: BuildingTemplate | undefined,
  x: number,
  y: number,
  cost: number
): ChangeResult {
  if (!template) return { success: false, message: 'Unknown building type' };
  const { width, height } = template.footprint;
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      const tile = getTile(state, x + dx, y + dy);
      if (!tile) return { success: false, message: 'Invalid tile location' };
      if (tile.buildingId !== undefined) {
        return { success: false, message: 'Cannot overlap another building. Bulldoze first.' };
      }
      if (refusedBy(tile, Occupant.Structure, ZONE_MASK) !== undefined) {
        return { success: false, message: 'Cannot build here — clear roads and powerlines first.' };
      }
    }
  }
  const result = placeBuilding(state, template, x, y, (tile, buildingId) => {
    if (template.power) {
      tile.powerPlantType = template.power.type;
      tile.powerPlantId = buildingId;
    }
  });
  if (!result.success) return result;
  state.money -= cost;
  return result;
}

/**
 * The three zone brushes, which differ only in the tag they lay down.
 * Mirrors the `Tool::Residential | Tool::Commercial | Tool::Industrial` arm
 * of `apply_tool`. Re-zoning is a replacement, so the zone tags are
 * displaced rather than refused — what is left of a zone's conflict set is
 * road, rail and structure. A developed lot is refused separately:
 * `refusedBy` cannot see it, since a developed zone lot's occupant is its
 * zone tag, not `Structure` (see `occupants.ts`'s own note on this).
 */
function zone({ state, x, y }: ToolContext, cost: number, zoneOccupant: Occupant): ChangeResult {
  const tile = getTile(state, x, y);
  if (!tile) return { success: false };
  const blocker = refusedBy(tile, zoneOccupant, ZONE_MASK);
  if (blocker !== undefined) {
    return {
      success: false,
      message:
        blocker === Occupant.Structure
          ? 'Cannot zone over a building. Bulldoze first.'
          : 'Cannot zone over roads or rail. Bulldoze first.'
    };
  }
  if (tile.buildingId !== undefined) {
    return { success: false, message: 'Cannot zone over a building. Bulldoze first.' };
  }
  state.money -= cost;
  regradeAt(state, x, y, Terrain.Land);
  const updated = getTile(state, x, y)!;
  setTileOccupant(updated, zoneOccupant, true);
  syncLegacy(state, updated);
  return { success: true };
}

const registry: ToolRegistry = {
  [Tool.Inspect]: (_ctx, _cost) => ({ success: true }),

  // The three terrain brushes regrade the ground through one gate — see
  // `regradeRefusal` and `regradeAt`. The water brush is `TerraformLower` at
  // a different price, regraded through the same gate.
  [Tool.TerraformRaise]: ({ state, x, y }, cost) => {
    const refusal = regradeRefusal(getTile(state, x, y));
    if (refusal) return { success: false, message: refusal };
    state.money -= cost;
    regradeAt(state, x, y, Terrain.Land);
    syncLegacy(state, getTile(state, x, y)!);
    return { success: true };
  },
  [Tool.TerraformLower]: ({ state, x, y }, cost) => {
    const refusal = regradeRefusal(getTile(state, x, y));
    if (refusal) return { success: false, message: refusal };
    state.money -= cost;
    regradeAt(state, x, y, Terrain.Water);
    syncLegacy(state, getTile(state, x, y)!);
    return { success: true };
  },
  [Tool.Water]: ({ state, x, y }, cost) => {
    const refusal = regradeRefusal(getTile(state, x, y));
    if (refusal) return { success: false, message: refusal };
    state.money -= cost;
    regradeAt(state, x, y, Terrain.Water);
    syncLegacy(state, getTile(state, x, y)!);
    return { success: true };
  },
  [Tool.Tree]: ({ state, x, y }, cost) => {
    // Planting clears the ground it plants on and leaves the hydro span
    // standing — a tree planted over a live line still produces
    // `{Trees, PowerLine}` (`known_defect_trees_are_planted_through_a_live_hydro_line`
    // in `commands.rs`). The one refusal is against stranding a live building.
    const tile = getTile(state, x, y);
    if (tile?.buildingId !== undefined) {
      return { success: false, message: 'A building occupies this tile. Bulldoze first.' };
    }
    state.money -= cost;
    regradeAt(state, x, y, Terrain.Land);
    const updated = getTile(state, x, y)!;
    setTileOccupant(updated, Occupant.Trees, true);
    syncLegacy(state, updated);
    return { success: true };
  },
  [Tool.Road]: ({ state, x, y }, cost) => {
    const tile = getTile(state, x, y);
    if (tile?.buildingId !== undefined) return { success: false, message: 'Bulldoze the building first.' };
    const hadRail = tile !== undefined && hasOccupant(tile.surface, Occupant.Rail);
    clearBuildingAt(state, x, y);
    state.money -= cost;
    // A hydro line survives a road laid across it, exactly as a rail does —
    // the overhead stratum is not the surface, so there is nothing left to
    // arbitrate. `regradeAt` is what takes the zone tag, the canopy and the
    // water under the carriageway.
    regradeAt(state, x, y, Terrain.Land);
    const updated = getTile(state, x, y)!;
    setTileOccupant(updated, Occupant.Road, true);
    setTileOccupant(updated, Occupant.Rail, hadRail);
    syncLegacy(state, updated);
    return { success: true };
  },
  [Tool.Rail]: ({ state, x, y }, cost) => {
    const tile = getTile(state, x, y);
    if (tile?.buildingId !== undefined) return { success: false, message: 'Bulldoze the building first.' };
    const hadRoad = tile !== undefined && hasOccupant(tile.surface, Occupant.Road);
    clearBuildingAt(state, x, y);
    state.money -= cost;
    // Mirrors `Tool::Road` above.
    regradeAt(state, x, y, Terrain.Land);
    const updated = getTile(state, x, y)!;
    setTileOccupant(updated, Occupant.Rail, true);
    setTileOccupant(updated, Occupant.Road, hadRoad);
    syncLegacy(state, updated);
    return { success: true };
  },
  [Tool.PowerLine]: ({ state, x, y }, cost) => {
    const tile = getTile(state, x, y);
    if (tile?.buildingId !== undefined) return { success: false, message: 'Bulldoze the building first.' };
    clearBuildingAt(state, x, y);
    state.money -= cost;
    const updated = getTile(state, x, y)!;
    // The surface is untouched: a line strung across a zone, a road or a
    // rail leaves all of them standing — there is no `kind` slot left to
    // arbitrate. The canopy does not survive: utilities trim trees away from
    // conductors, which is also what `Occupant::PowerLine`'s conflict set
    // says.
    updated.terrain = Terrain.Land;
    setTileOccupant(updated, Occupant.PowerLine, true);
    setTileOccupant(updated, Occupant.Trees, false);
    bumpTileRevision(state);
    syncLegacy(state, updated);
    return { success: true };
  },
  [Tool.HydroPlant]: ({ state, x, y }, cost) =>
    placeFootprintBuilding(state, getPowerPlantTemplate(PowerPlantType.Hydro), x, y, cost),
  [Tool.CoalPlant]: ({ state, x, y }, cost) =>
    placeFootprintBuilding(state, getPowerPlantTemplate(PowerPlantType.Coal), x, y, cost),
  [Tool.WindTurbine]: ({ state, x, y }, cost) =>
    placeFootprintBuilding(state, getPowerPlantTemplate(PowerPlantType.Wind), x, y, cost),
  [Tool.SolarFarm]: ({ state, x, y }, cost) =>
    placeFootprintBuilding(state, getPowerPlantTemplate(PowerPlantType.Solar), x, y, cost),
  [Tool.WaterPump]: ({ state, x, y }, cost) =>
    placeFootprintBuilding(state, getBuildingTemplate(TileKind.WaterPump), x, y, cost),
  [Tool.WaterTower]: ({ state, x, y }, cost) =>
    placeFootprintBuilding(state, getBuildingTemplate(TileKind.WaterTower), x, y, cost),
  [Tool.WaterPipe]: ({ state, x, y }, cost) => {
    state.money -= cost;
    const tile = getTile(state, x, y);
    if (tile) {
      // Underground doesn't affect the zone-growth cache, so — mirroring
      // `Tool::WaterPipe` in `commands.rs` — this deliberately does not bump
      // `tileRevision`.
      setTileOccupant(tile, Occupant.Pipe, true);
      syncLegacy(state, tile);
    }
    return { success: true };
  },
  [Tool.ElementarySchool]: ({ state, x, y }, cost) =>
    placeFootprintBuilding(state, getBuildingTemplate(TileKind.ElementarySchool), x, y, cost),
  [Tool.HighSchool]: ({ state, x, y }, cost) =>
    placeFootprintBuilding(state, getBuildingTemplate(TileKind.HighSchool), x, y, cost),
  [Tool.Residential]: (ctx, cost) => zone(ctx, cost, Occupant.ZoneResidential),
  [Tool.Commercial]: (ctx, cost) => zone(ctx, cost, Occupant.ZoneCommercial),
  [Tool.Industrial]: (ctx, cost) => zone(ctx, cost, Occupant.ZoneIndustrial),
  [Tool.Park]: ({ state, x, y }, cost) =>
    placeFootprintBuilding(state, getBuildingTemplate(TileKind.Park), x, y, cost),
  [Tool.ParkLarge]: ({ state, x, y }, cost) =>
    placeFootprintBuilding(state, getBuildingTemplate(TileKind.ParkLarge), x, y, cost),
  [Tool.Bulldoze]: ({ state, x, y }, cost) => {
    // Mirrors `bulldoze` in `commands.rs`: a live building goes first: then
    // the buried pipe, reached from either view — the engine has no notion
    // of which minimap mode is open; then what stands on the ground —
    // surface and overhead together — leaving the ground itself exactly as
    // it was (terrain is deliberately absent from this list, see #177 step 4).
    const tile = getTile(state, x, y);
    if (!tile) return { success: false };
    state.money -= cost;
    if (tile.buildingId !== undefined) {
      removeBuilding(state, tile.buildingId);
    } else if (tile.underground !== 0) {
      clearTileStratum(tile, Stratum.Underground);
      syncLegacy(state, tile);
    } else {
      clearTileStratum(tile, Stratum.Surface);
      clearTileStratum(tile, Stratum.Overhead);
      tile.abandoned = false;
      bumpTileRevision(state);
      syncLegacy(state, tile);
    }
    return { success: true };
  }
};

export function applyTool(state: GameState, tool: Tool, x: number, y: number): ChangeResult {
  const tile = getTile(state, x, y);
  if (!tile) return { success: false };
  const cost = getToolCost(tool);
  if (state.money < cost) {
    return { success: false, message: 'Not enough funds' };
  }

  const handler = registry[tool];
  if (!handler) return { success: false };
  return handler({ state, tile, x, y }, cost);
}
