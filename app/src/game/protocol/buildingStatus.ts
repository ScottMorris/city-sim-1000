// buildingStatus.ts — BuildingStatus ↔ u8 wire mapping, TS mirror of the Rust protocol crate.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/**
 * BuildingStatus ↔ u8 wire mapping — TS mirror of the `#[repr(u8)]`
 * discriminants on `crates/city-sim-core/src/buildings.rs`'s `BuildingStatus`.
 *
 * `WireBuilding.status` (`#200`'s wire-adoption follow-up) carries this exact
 * u8; both bridges decode it here instead of reconstructing a status from
 * tile power/water flags client-side.
 */

import { BuildingStatus } from '../buildings/state';

/** Dense array, not a `Map` — the Rust discriminants are 0..4 with no gaps.
 *  Exported for `wireParity.test.ts`, which pins it against `wireParity.json`;
 *  every runtime caller goes through `buildingStatusFromU8` below. */
export const BUILDING_STATUS_TABLE: readonly BuildingStatus[] = [
  BuildingStatus.Active,
  BuildingStatus.InactiveNoPower,
  BuildingStatus.InactiveNoWater,
  BuildingStatus.InactiveNoSource,
  BuildingStatus.InactiveDamaged
];

/** `undefined` on an unrecognised byte (should never happen against a matching engine build) — callers decide the fallback explicitly, and are expected to warn. */
export function buildingStatusFromU8(u8: number): BuildingStatus | undefined {
  return BUILDING_STATUS_TABLE[u8];
}
