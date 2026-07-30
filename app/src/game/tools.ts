// tools.ts — applyTool: cost, placement rules, and per-tool handlers.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { BUILD_COST, PowerPlantType } from './constants';
import { type BuildingTemplate, getBuildingTemplate, getPowerPlantTemplate } from './buildings/templates';
import { placeBuilding, removeBuilding } from './buildings/manager';
import { GameState, Tile, TileKind, getTile, setTile } from './gameState';
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

/**
 * Refuse a footprint that would be stamped over a live hydro line.
 *
 * Mirrors the `Occupant::PowerLine` half of `place_footprint_building`'s
 * overlap check in `crates/city-sim-core/src/commands.rs`. `placeBuilding`
 * already refuses the `kind === PowerLine` spelling, but a line strung across a
 * *zone* wears `powerOverlay` instead — the zone keeps `kind` — and so does
 * every line that has since been regraded. Three clicks (zone, line, park)
 * therefore stamped a structure straight over live conductors that went on
 * drawing, conducting and billing under it, unreachable by the bulldozer except
 * through the building on top.
 *
 * It lives here rather than in `placeBuilding` because that function is also
 * the zone-growth path, and a lot under a line must still develop.
 */
function refuseHydroSpan(
  state: GameState,
  template: BuildingTemplate,
  x: number,
  y: number
): ChangeResult | undefined {
  const { width, height } = template.footprint;
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      if (getTile(state, x + dx, y + dy)?.powerOverlay) {
        return { success: false, message: 'Cannot build here — clear roads and powerlines first.' };
      }
    }
  }
  return undefined;
}

function placeTemplatedBuilding(
  state: GameState,
  template: BuildingTemplate | undefined,
  x: number,
  y: number,
  cost: number
): ChangeResult {
  if (!template) return { success: false, message: 'Unknown building type' };
  const refusal = refuseHydroSpan(state, template, x, y);
  if (refusal) return refusal;
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

function placePowerPlant(
  state: GameState,
  x: number,
  y: number,
  type: PowerPlantType,
  cost: number
): ChangeResult {
  const template = getPowerPlantTemplate(type);
  return placeTemplatedBuilding(state, template, x, y, cost);
}

function clearBuildingAt(state: GameState, x: number, y: number) {
  const tile = getTile(state, x, y);
  if (tile?.buildingId !== undefined) {
    removeBuilding(state, tile.buildingId);
  }
}

/**
 * Why a regrade must refuse this tile, if it must.
 *
 * Mirrors `regrade_refusal` in `crates/city-sim-core/src/commands.rs`. A live
 * building is the one thing a regrade cannot wipe on the player's behalf: doing
 * so would leave the `BuildingInstance` running with no tile under it, so a
 * ten-credit misclick could take a 25,000-credit plant off the map while it
 * kept producing and billing.
 */
function regradeRefusal(tile: Tile | undefined): string | undefined {
  if (tile?.buildingId !== undefined) return 'A building occupies this tile. Bulldoze first.';
  return undefined;
}

/**
 * Rewrite the ground at (x, y), taking the surface stratum and the tree canopy
 * with it and leaving the strata above and below standing.
 *
 * Mirrors `regrade_at` in `crates/city-sim-core/src/commands.rs`. `setTile`
 * clears everything indiscriminately, including the overhead hydro line and —
 * were it ever asked to — the buried pipe; the engine keeps both, because a
 * line spans the tile whatever the ground does under it (over water it is the
 * pylon span `docs/tile-model.md` names) and a pipe is at depth. Restoring them
 * afterwards is how this file says `clear_stratum(Surface)` without a stratum
 * of its own to clear.
 */
function regradeAt(state: GameState, x: number, y: number, spelling: TileKind) {
  const before = getTile(state, x, y);
  if (!before) return;
  const hadLine = before.kind === TileKind.PowerLine || before.powerOverlay === true;
  const underground = before.legacyUnderground;
  setTile(state, x, y, spelling);
  const tile = getTile(state, x, y);
  if (!tile) return;
  tile.legacyUnderground = underground;
  if (hadLine) tile.powerOverlay = true;
}

/**
 * The three zone brushes, which differ only in the tag they lay down.
 *
 * Mirrors the `Tool::Residential | Tool::Commercial | Tool::Industrial` arm of
 * `apply_tool`. Road, rail and a building are refused; the tree canopy, the
 * water and any previous zone tag are displaced by the regrade; and a hydro
 * line is *not* in the way — a zone and a line share a tile happily in either
 * build order, because they are in different strata.
 */
function zone({ state, x, y }: ToolContext, cost: number, tag: TileKind): ChangeResult {
  const tile = getTile(state, x, y);
  if (tile && (tile.kind === TileKind.Road || tile.kind === TileKind.Rail || tile.roadUnderlay || tile.railUnderlay)) {
    return { success: false, message: 'Cannot zone over roads or rail. Bulldoze first.' };
  }
  if (tile?.buildingId !== undefined) {
    return { success: false, message: 'Cannot zone over a building. Bulldoze first.' };
  }
  state.money -= cost;
  regradeAt(state, x, y, tag);
  return { success: true };
}

const registry: ToolRegistry = {
  [Tool.Inspect]: (_ctx, _cost) => ({ success: true }),
  // The three terrain brushes regrade the ground through one gate — see
  // `regradeRefusal` and `regradeAt`. They used to be a bare `setTile`, which
  // made them the only tools that could take a live building off the map
  // without removing it, and which erased the hydro span overhead.
  [Tool.TerraformRaise]: ({ state, x, y }, cost) => {
    const refusal = regradeRefusal(getTile(state, x, y));
    if (refusal) return { success: false, message: refusal };
    state.money -= cost;
    regradeAt(state, x, y, TileKind.Land);
    return { success: true };
  },
  [Tool.TerraformLower]: ({ state, x, y }, cost) => {
    const refusal = regradeRefusal(getTile(state, x, y));
    if (refusal) return { success: false, message: refusal };
    state.money -= cost;
    regradeAt(state, x, y, TileKind.Water);
    return { success: true };
  },
  [Tool.Water]: ({ state, x, y }, cost) => {
    const refusal = regradeRefusal(getTile(state, x, y));
    if (refusal) return { success: false, message: refusal };
    state.money -= cost;
    regradeAt(state, x, y, TileKind.Water);
    return { success: true };
  },
  [Tool.Tree]: ({ state, x, y }, cost) => {
    // Planting clears the ground it plants on and leaves the hydro span
    // standing — `known_defect_trees_are_planted_through_a_live_hydro_line`
    // in `commands.rs`. The one refusal is against stranding a live building.
    const tile = getTile(state, x, y);
    if (tile?.buildingId !== undefined) {
      return { success: false, message: 'A building occupies this tile. Bulldoze first.' };
    }
    state.money -= cost;
    regradeAt(state, x, y, TileKind.Tree);
    return { success: true };
  },
  [Tool.Road]: ({ state, x, y }, cost) => {
    const tile = getTile(state, x, y);
    if (tile?.buildingId !== undefined) return { success: false, message: 'Bulldoze the building first.' };
    state.money -= cost;
    const hadRail = tile?.kind === TileKind.Rail || tile?.railUnderlay;
    // A hydro line survives a road laid across it, exactly as a rail does, and
    // the tile is recorded the one canonical way — kind `PowerLine` with the
    // road beneath, identical to building them in the other order. Mirrors
    // `Tool::Road` in `crates/city-sim-core/src/commands.rs`.
    const hadLine = tile?.kind === TileKind.PowerLine || tile?.powerOverlay;
    setTile(state, x, y, hadLine ? TileKind.PowerLine : TileKind.Road);
    const updated = getTile(state, x, y);
    if (updated && hadRail) updated.railUnderlay = true; // remember rail for render/crossing
    if (updated && hadLine) {
      updated.roadUnderlay = true;
      updated.powerOverlay = true;
    }
    return { success: true };
  },
  [Tool.Rail]: ({ state, x, y }, cost) => {
    const tile = getTile(state, x, y);
    if (tile?.buildingId !== undefined) return { success: false, message: 'Bulldoze the building first.' };
    state.money -= cost;
    const hadRoad = tile?.kind === TileKind.Road || tile?.roadUnderlay;
    const hadLine = tile?.kind === TileKind.PowerLine || tile?.powerOverlay;
    setTile(state, x, y, hadLine ? TileKind.PowerLine : TileKind.Rail);
    const updated = getTile(state, x, y);
    if (updated && hadRoad) updated.roadUnderlay = true; // rail over road
    if (updated && hadLine) {
      updated.railUnderlay = true;
      updated.powerOverlay = true;
    }
    return { success: true };
  },
  [Tool.PowerLine]: ({ state, x, y }, cost) => {
    const tile = getTile(state, x, y);
    if (tile?.buildingId !== undefined) return { success: false, message: 'Bulldoze the building first.' };
    state.money -= cost;
    // Powerlines pass through zones as an overlay — zone tiles keep their kind.
    if (tile?.kind === TileKind.Residential || tile?.kind === TileKind.Commercial || tile?.kind === TileKind.Industrial) {
      tile.powerOverlay = true;
      return { success: true };
    }
    const hadRoad = tile?.kind === TileKind.Road || tile?.roadUnderlay;
    const hadRail = tile?.kind === TileKind.Rail || tile?.railUnderlay;
    setTile(state, x, y, TileKind.PowerLine);
    const updated = getTile(state, x, y);
    if (updated && hadRoad) updated.roadUnderlay = true;
    if (updated && hadRail) updated.railUnderlay = true;
    if (updated) updated.powerOverlay = true;
    return { success: true };
  },
  [Tool.HydroPlant]: ({ state, x, y }, cost) =>
    placePowerPlant(state, x, y, PowerPlantType.Hydro, cost),
  [Tool.CoalPlant]: ({ state, x, y }, cost) =>
    placePowerPlant(state, x, y, PowerPlantType.Coal, cost),
  [Tool.WindTurbine]: ({ state, x, y }, cost) =>
    placePowerPlant(state, x, y, PowerPlantType.Wind, cost),
  [Tool.SolarFarm]: ({ state, x, y }, cost) =>
    placePowerPlant(state, x, y, PowerPlantType.Solar, cost),
  [Tool.WaterPump]: ({ state, x, y }, cost) =>
    placeTemplatedBuilding(state, getBuildingTemplate(TileKind.WaterPump), x, y, cost),
  [Tool.WaterTower]: ({ state, x, y }, cost) =>
    placeTemplatedBuilding(state, getBuildingTemplate(TileKind.WaterTower), x, y, cost),
  [Tool.WaterPipe]: ({ state, x, y }, cost) => {
    state.money -= cost;
    const tile = getTile(state, x, y);
    if (tile) {
      tile.legacyUnderground = TileKind.WaterPipe;
    }
    return { success: true };
  },
  [Tool.ElementarySchool]: ({ state, x, y }, cost) =>
    placeTemplatedBuilding(state, getBuildingTemplate(TileKind.ElementarySchool), x, y, cost),
  [Tool.HighSchool]: ({ state, x, y }, cost) =>
    placeTemplatedBuilding(state, getBuildingTemplate(TileKind.HighSchool), x, y, cost),
  [Tool.Residential]: (ctx, cost) => zone(ctx, cost, TileKind.Residential),
  [Tool.Commercial]: (ctx, cost) => zone(ctx, cost, TileKind.Commercial),
  [Tool.Industrial]: (ctx, cost) => zone(ctx, cost, TileKind.Industrial),
  [Tool.Park]: ({ state, x, y }, cost) =>
    placeTemplatedBuilding(state, getBuildingTemplate(TileKind.Park), x, y, cost),
  [Tool.ParkLarge]: ({ state, x, y }, cost) =>
    placeTemplatedBuilding(state, getBuildingTemplate(TileKind.ParkLarge), x, y, cost),
  [Tool.Bulldoze]: ({ state, x, y }, cost) => {
    const tile = getTile(state, x, y);
    if (!tile) return { success: false };

    if (state.settings.minimap.mode === 'underground') {
      if (tile.legacyUnderground) {
        state.money -= cost;
        tile.legacyUnderground = undefined;
        return { success: true };
      }
      return { success: true }; // Nothing to bulldoze underground
    }

    state.money -= cost;
    if (tile.buildingId !== undefined) {
      removeBuilding(state, tile.buildingId);
    } else if (tile.legacyUnderground !== undefined) {
      // The engine reaches the buried pipe *before* the surface — `bulldoze`
      // in `commands.rs` tests `building_id`, then `underground`, then the
      // surface, and it has no notion of which minimap view is open. So a
      // click on a road with a pipe under it takes the pipe and leaves the
      // road. Mirrored here rather than corrected: `commands.rs` is canonical.
      tile.legacyUnderground = undefined;
    } else {
      // The bulldozer clears what stands on the ground — surface and overhead
      // together — and leaves the ground itself exactly as it was (#177 step
      // 4). It used to write `Land` unconditionally, so one credit filled in a
      // lake that cost twelve to dig: the cheapest tool on the palette was
      // also the most powerful terraformer.
      setTile(state, x, y, tile.kind === TileKind.Water ? TileKind.Water : TileKind.Land);
      // `abandoned` describes a lot that no longer exists.
      getTile(state, x, y)!.abandoned = false;
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
