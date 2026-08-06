// tileLabel.ts — dominantOccupantLabel: a tile's current display kind, computed live from strata.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { TileKind } from '../gameState';
import type { GameState, Tile } from '../gameState';
import { getBuildingTemplate } from '../buildings/templates';
import { legacyKind } from './legacyProjection';
import { Occupant, iterSet } from './occupants';

function structureKindOf(state: GameState, buildingId: number | undefined): TileKind | undefined {
  if (buildingId === undefined) return undefined;
  const instance = state.buildings.find((b) => b.id === buildingId);
  return instance ? getBuildingTemplate(instance.templateId)?.tileKind : undefined;
}

/**
 * The tile's dominant occupant, as a display/query string — used by the HUD
 * tile inspector, the minimap, and `mcpBridge.ts`'s `get_tile`/
 * `get_tiles_where` handlers. Deliberately separate from `legacyKind`, even
 * though today's derivation is identical: this one only needs to stay
 * human-readable and current, `legacyKind` needs to stay byte-exact with old
 * saves forever, and nothing here should have to care if those two
 * requirements ever pull apart.
 */
export function dominantOccupantLabel(state: GameState, tile: Tile): string {
  return legacyKind({
    terrain: tile.terrain,
    surface: tile.surface,
    overhead: tile.overhead,
    buildingId: tile.buildingId,
    structureKindOf: (buildingId) => structureKindOf(state, buildingId)
  });
}

/** One occupant's label — same `TileKind` vocabulary `dominantOccupantLabel` uses, so a
 * script filtering on either agrees on spelling. `Structure` resolves through the building
 * instance the same way `dominantOccupantLabel` does; `undefined` covers the two reserved
 * occupants (`Subway`/`Fibre`) with no `TileKind` yet — see `occupants.ts`. */
function occupantLabel(state: GameState, tile: Tile, occupant: Occupant): string | undefined {
  switch (occupant) {
    case Occupant.Pipe: return TileKind.WaterPipe;
    case Occupant.Road: return TileKind.Road;
    case Occupant.Rail: return TileKind.Rail;
    case Occupant.ZoneResidential: return TileKind.Residential;
    case Occupant.ZoneCommercial: return TileKind.Commercial;
    case Occupant.ZoneIndustrial: return TileKind.Industrial;
    case Occupant.Structure: return structureKindOf(state, tile.buildingId);
    case Occupant.PowerLine: return TileKind.PowerLine;
    case Occupant.Trees: return TileKind.Tree;
    case Occupant.Subway:
    case Occupant.Fibre:
      return undefined;
  }
}

/**
 * Every occupant on `tile`, grouped by stratum and labelled — the detail
 * `dominantOccupantLabel` deliberately collapses away by design (it picks
 * one winner per the legacy display precedence: structure > zone > trees >
 * power line > rail > road). A tile can carry a road on the surface *and* a
 * power line overhead *and* a pipe underground at once; a caller that only
 * reads `dominantOccupantLabel`'s single string can't tell the difference
 * between "no road here" and "there's a road, but a power line is winning
 * the display slot" — this is what `get_tile` needs to answer that.
 */
export function occupantsByStratum(state: GameState, tile: Tile): Record<'underground' | 'surface' | 'overhead', string[]> {
  // Each field already only ever carries its own stratum's bits — see
  // `Tile.underground`/`.surface`/`.overhead`'s doc comments and
  // `setTileOccupant`, the sole write path, which routes by the occupant's
  // own declared stratum rather than trusting the caller.
  const labelsIn = (bits: number) =>
    iterSet(bits)
      .map(o => occupantLabel(state, tile, o))
      .filter((label): label is string => label !== undefined);
  return {
    underground: labelsIn(tile.underground),
    surface: labelsIn(tile.surface),
    overhead: labelsIn(tile.overhead),
  };
}
