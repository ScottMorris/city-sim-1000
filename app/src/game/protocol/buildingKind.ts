// buildingKind.ts — BuildingKind ↔ u8 wire mapping, TS mirror of the Rust protocol crate.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/**
 * BuildingKind ↔ u8 wire mapping — TS mirror of
 * `crates/city-sim-protocol/src/building_kind.rs`.
 *
 * Unlike `TileKind` (`tileKind.ts`), this alphabet is **not** frozen legacy
 * save vocabulary — pre-release, the discriminants below are free to be
 * renumbered or extended, per the maintainer-approved design in
 * `docs/tile-model.md`. They still have to match the Rust side byte-for-byte
 * today, though: `WireBuilding.kind` on the wire (`wasmSimBridge.ts`,
 * `tauriSimBridge.ts`) and `BuildingInstance.kind` in a CSIM snapshot both
 * carry this exact u8. High nibble = category, low nibble = kind within it;
 * `0x00` is reserved and never valid.
 *
 * The `BuildingKind` string values here are the `app/src/game/buildings/
 * templates.ts` enum — `getBuildingTemplate` is keyed by that string.
 */

import { BuildingKind } from '../buildings/templates';

/** Stable u8 → BuildingKind lookup. A `Map`, not a dense array, because the
 *  discriminants are sparse (0x10..0x51 with category-sized gaps) — see
 *  `BuildingKind::dense_index` on the Rust side for why the *engine's*
 *  internal tables use a separate compact index instead of this byte. */
export const BUILDING_KIND_BY_U8: ReadonlyMap<number, BuildingKind> = new Map([
  // Zone
  [0x10, BuildingKind.Residential],
  [0x11, BuildingKind.Commercial],
  [0x12, BuildingKind.Industrial],
  // Power
  [0x20, BuildingKind.HydroPlant],
  [0x21, BuildingKind.CoalPlant],
  [0x22, BuildingKind.WindTurbine],
  [0x23, BuildingKind.SolarFarm],
  // Water
  [0x30, BuildingKind.WaterPump],
  [0x31, BuildingKind.WaterTower],
  // Education
  [0x40, BuildingKind.ElementarySchool],
  [0x41, BuildingKind.HighSchool],
  // Recreation
  [0x50, BuildingKind.Park],
  [0x51, BuildingKind.ParkLarge]
]);

/** BuildingKind → u8. */
export const BUILDING_KIND_TO_U8: ReadonlyMap<BuildingKind, number> = new Map(
  Array.from(BUILDING_KIND_BY_U8, ([u8, kind]) => [kind, u8])
);

/** Total number of building kinds — must match `BuildingKind::COUNT` in Rust.
 *  Pinned against `wireParity.json`'s 13-entry `buildingKinds` table by
 *  `wireParity.test.ts`, not just this file's own comment. */
export const BUILDING_KIND_COUNT = 13;

export function buildingKindFromU8(u8: number): BuildingKind | undefined {
  return BUILDING_KIND_BY_U8.get(u8);
}

export function buildingKindToU8(kind: BuildingKind): number {
  const v = BUILDING_KIND_TO_U8.get(kind);
  if (v === undefined) throw new Error(`Unknown BuildingKind: ${kind}`);
  return v;
}
