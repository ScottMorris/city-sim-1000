// buildingKind.test.ts — BuildingKind ↔ u8 wire mapping round-trips and the
// pinned Rust discriminant table.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import {
  BUILDING_KIND_BY_U8,
  BUILDING_KIND_COUNT,
  buildingKindFromU8,
  buildingKindToU8
} from './buildingKind';
import { BuildingKind } from '../buildings/templates';

// Hand-copied from the approved table in crates/city-sim-protocol/src/building_kind.rs
// (`BuildingKind::ALL` / `from_u8`) — a real assertion against the Rust discriminants,
// not a copy of the table under test. If this drifts from the Rust side, the wire
// silently decodes the wrong building; keep the two in lockstep by hand until a
// generated parity fixture exists (`TileKind`'s `tileKindParity.json` pattern is not
// wired up for `BuildingKind` because this alphabet is still pre-release/mutable).
const RUST_DISCRIMINANTS: ReadonlyArray<readonly [number, BuildingKind]> = [
  [0x10, BuildingKind.Residential],
  [0x11, BuildingKind.Commercial],
  [0x12, BuildingKind.Industrial],
  [0x20, BuildingKind.HydroPlant],
  [0x21, BuildingKind.CoalPlant],
  [0x22, BuildingKind.WindTurbine],
  [0x23, BuildingKind.SolarFarm],
  [0x30, BuildingKind.WaterPump],
  [0x31, BuildingKind.WaterTower],
  [0x40, BuildingKind.ElementarySchool],
  [0x41, BuildingKind.HighSchool],
  [0x50, BuildingKind.Park],
  [0x51, BuildingKind.ParkLarge]
];

describe('BUILDING_KIND_BY_U8', () => {
  it('matches the Rust discriminant table exactly, byte for byte', () => {
    expect(BUILDING_KIND_BY_U8.size).toBe(RUST_DISCRIMINANTS.length);
    for (const [u8, kind] of RUST_DISCRIMINANTS) {
      expect(BUILDING_KIND_BY_U8.get(u8)).toBe(kind);
    }
  });

  it('covers every BuildingKind member exactly once', () => {
    const values = Array.from(BUILDING_KIND_BY_U8.values());
    const allKinds = Object.values(BuildingKind);
    expect(values.length).toBe(allKinds.length);
    for (const kind of allKinds) {
      expect(values.filter((v) => v === kind)).toHaveLength(1);
    }
  });

  it('has no valid entry at 0x00', () => {
    expect(BUILDING_KIND_BY_U8.has(0x00)).toBe(false);
  });

  it('BUILDING_KIND_COUNT matches the table size', () => {
    expect(BUILDING_KIND_COUNT).toBe(BUILDING_KIND_BY_U8.size);
  });
});

describe('buildingKindFromU8 / buildingKindToU8', () => {
  it('round-trips every member', () => {
    for (const [u8, kind] of RUST_DISCRIMINANTS) {
      expect(buildingKindFromU8(u8)).toBe(kind);
      expect(buildingKindToU8(kind)).toBe(u8);
    }
  });

  it('returns undefined for an unassigned byte', () => {
    expect(buildingKindFromU8(0x00)).toBeUndefined();
    expect(buildingKindFromU8(0x99)).toBeUndefined();
  });

  it('throws for a value with no BuildingKind (defensive; not reachable through the enum type)', () => {
    expect(() => buildingKindToU8('not-a-kind' as BuildingKind)).toThrow();
  });
});
