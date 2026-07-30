// tileLabel.ts — dominantOccupantLabel: a tile's current display kind, computed live from strata.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { GameState, Tile } from '../gameState';
import { getBuildingTemplate } from '../buildings/templates';
import { legacyKind } from './legacyProjection';

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
    structureKindOf: (buildingId) => {
      const instance = state.buildings.find((b) => b.id === buildingId);
      return instance ? getBuildingTemplate(instance.templateId)?.tileKind : undefined;
    }
  });
}
