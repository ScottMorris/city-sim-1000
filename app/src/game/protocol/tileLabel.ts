// tileLabel.ts — occupantsByStratum: a tile's occupants, labelled and grouped by stratum, computed live from strata.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { GameState, Tile } from '../gameState';
import { BuildingKind, getBuildingTemplate } from '../buildings/templates';
import { Occupant, iterSet } from './occupants';

/**
 * The three strata a tile's occupants are grouped by. Mirrors Rust's
 * `Stratum` (`crates/city-sim-core/src/occupants.rs`) — depth order
 * underground → surface → overhead — but stays a plain lowercase string
 * union rather than importing that enum, since the JSON shape (the object
 * keys `occupantsByStratum` returns) must not move.
 */
export type StratumKey = 'underground' | 'surface' | 'overhead';

/**
 * Infrastructure labels (not `BuildingKind`-backed) plus every `BuildingKind`
 * — the full vocabulary `occupantLabel`/`occupantsByStratum` can return.
 */
export type OccupantLabel = 'water_pipe' | 'road' | 'rail' | 'powerline' | 'tree' | BuildingKind;

/**
 * Display/wire labels for the occupants that are infrastructure rather than
 * buildings — nothing behind them carries a `BuildingKind`, so they own
 * their vocabulary here. Values are the spellings `get_tile`/the HUD tile
 * inspector have always used (formerly read off `TileKind`'s members; the
 * strings must not move — MCP scripts filter on them). The two reserved
 * occupants (`Subway`/`Fibre`) have no label yet — see `occupants.ts`.
 */
const OCCUPANT_LABELS: Partial<Record<Occupant, OccupantLabel>> = {
  [Occupant.Pipe]: 'water_pipe',
  [Occupant.Road]: 'road',
  [Occupant.Rail]: 'rail',
  [Occupant.PowerLine]: 'powerline',
  [Occupant.Trees]: 'tree'
};

function structureKindOf(state: GameState, buildingId: number | undefined): BuildingKind | undefined {
  if (buildingId === undefined) return undefined;
  const instance = state.buildings.find((b) => b.id === buildingId);
  return instance ? getBuildingTemplate(instance.templateId)?.kind : undefined;
}

/**
 * One occupant's label. `Structure` resolves through the building instance
 * to its `BuildingKind` — a live buildable identity; zone tags label as the
 * `BuildingKind` their grown lot would carry; plain infrastructure reads
 * `OCCUPANT_LABELS`. `undefined` covers the two reserved occupants
 * (`Subway`/`Fibre`) with no label yet — see `occupants.ts`.
 */
function occupantLabel(state: GameState, tile: Tile, occupant: Occupant): OccupantLabel | undefined {
  switch (occupant) {
    case Occupant.Pipe:
    case Occupant.Road:
    case Occupant.Rail:
    case Occupant.PowerLine:
    case Occupant.Trees:
      return OCCUPANT_LABELS[occupant];
    case Occupant.ZoneResidential: return BuildingKind.Residential;
    case Occupant.ZoneCommercial: return BuildingKind.Commercial;
    case Occupant.ZoneIndustrial: return BuildingKind.Industrial;
    case Occupant.Structure: return structureKindOf(state, tile.buildingId);
    case Occupant.Subway:
    case Occupant.Fibre:
      return undefined;
  }
}

/**
 * Every occupant on `tile`, grouped by stratum and labelled. A tile can
 * carry a road on the surface *and* a power line overhead *and* a pipe
 * underground all at once — this lists every one of them rather than
 * picking a single winner by some display precedence, which is what
 * `get_tile`/`get_tiles_where` (`mcpBridge.ts`) and the HUD tile inspector
 * (`ui/hud.ts`) need it for.
 */
export function occupantsByStratum(state: GameState, tile: Tile): Record<StratumKey, OccupantLabel[]> {
  // Each field already only ever carries its own stratum's bits — see
  // `Tile.underground`/`.surface`/`.overhead`'s doc comments and
  // `setTileOccupant`, the sole write path, which routes by the occupant's
  // own declared stratum rather than trusting the caller.
  const labelsIn = (bits: number) =>
    iterSet(bits)
      .map(o => occupantLabel(state, tile, o))
      .filter((label): label is OccupantLabel => label !== undefined);
  return {
    underground: labelsIn(tile.underground),
    surface: labelsIn(tile.surface),
    overhead: labelsIn(tile.overhead),
  };
}
