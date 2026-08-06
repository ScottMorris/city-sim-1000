// alertSeverity.ts — shared display-policy ladder for the "alerts" overlay.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// `renderer.ts` (main map) and `minimap.ts` used to each carry their own copy
// of this exact ladder — a display-layer judgement call (which building/zone
// conditions count as a "problem", and how bad), not simulation state, so it
// belongs here rather than on the wire. One function so the two views cannot
// silently drift onto different severities for the same tile.

import type { Tile } from '../game/gameState';
import { BuildingStatus } from '../game/buildings/state';

/** 0 = no issue, 1 = warning (amber), 2 = critical (red). */
export type AlertSeverity = 0 | 1 | 2;

/** Below this happiness, a powered/watered zone still reads as a (mild) problem. */
const UNHAPPY_ZONE_THRESHOLD = 0.55;

/**
 * The "alerts" overlay's per-tile severity — shared by `renderer.ts`'s map
 * overlay and `minimap.ts`'s heatmap, each of which only differ in how they
 * turn a severity into a colour (PixiJS tint vs. CSS `rgba()`).
 */
export function computeAlertSeverity(
  tile: Pick<Tile, 'abandoned' | 'powered' | 'happiness'>,
  buildingStatus: BuildingStatus | undefined,
  zone: boolean
): AlertSeverity {
  let severity: AlertSeverity = 0;
  if (tile.abandoned) severity = 2;
  if (buildingStatus === BuildingStatus.InactiveNoPower) severity = Math.max(severity, 2) as AlertSeverity;
  if (buildingStatus === BuildingStatus.InactiveNoWater) severity = Math.max(severity, 2) as AlertSeverity;
  if (buildingStatus === BuildingStatus.InactiveNoSource) severity = Math.max(severity, 2) as AlertSeverity;
  if (buildingStatus === BuildingStatus.InactiveDamaged) severity = Math.max(severity, 1) as AlertSeverity;
  if (zone && !tile.powered) severity = Math.max(severity, 2) as AlertSeverity;
  if (zone && tile.happiness < UNHAPPY_ZONE_THRESHOLD) severity = Math.max(severity, 1) as AlertSeverity;
  return severity;
}
