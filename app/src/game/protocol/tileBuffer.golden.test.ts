// tileBuffer.golden.test.ts — cross-language golden fixture for the live SoA tile buffer.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/**
 * Decodes the same fixture `tile_buffer_golden.rs` (city-sim-core) encodes
 * and pins, and asserts a meaningful sample of what comes out —
 * per-stratum occupants on specific tiles, happiness/eco/education-score
 * decodes, `buildingId`, and the education served flags. Two hand-copied
 * offset tests (`protocol.test.ts`'s "offsets for 64×64 map" and its Rust
 * mirror) already pin the byte layout in the abstract; this pins one
 * concrete encoding of it decoded through the real TS path
 * (`decodeTileBuffer`), so an offset/codec change on either side that
 * happens to leave the abstract offsets alone still breaks something.
 *
 * **The fixture is regenerated from the Rust side only** — see
 * `crates/city-sim-core/tests/tile_buffer_golden.rs`'s module doc for how and
 * why. This file only ever reads it.
 */

import { describe, it, expect } from 'vitest';
import type { Tile } from '../gameState';
import { Terrain, ZoneDensity, Occupant, hasOccupant } from './occupants';
import { ServiceId, createTileServiceState } from '../services';
import { decodeTileBuffer } from './tileBuffer';
import fixture from '../../../../crates/city-sim-core/tests/fixtures/tile_buffer_golden.json';

function makeGrid(width: number, height: number): Tile[] {
  const tiles: Tile[] = [];
  for (let i = 0; i < width * height; i++) {
    tiles.push({
      elevation: 0,
      happiness: 1,
      powered: false,
      watered: false,
      services: createTileServiceState(),
      terrain: Terrain.Land,
      underground: 0,
      surface: 0,
      overhead: 0,
      density: ZoneDensity.Low
    });
  }
  return tiles;
}

describe('protocol: golden tile buffer (shared fixture with city-sim-core)', () => {
  const { width, height, bytes } = fixture;

  it('fixture is the 16×16 grid the Rust scenario builds', () => {
    expect(width).toBe(16);
    expect(height).toBe(16);
    expect(bytes.length).toBe(width * height * 11);
  });

  const tiles = makeGrid(width, height);
  decodeTileBuffer(tiles, bytes);
  const at = (x: number, y: number): Tile => tiles[y * width + x];

  it('the hydro plant footprint (2,2)-(3,3) decodes as one powered, watered Structure', () => {
    for (const [x, y] of [
      [2, 2],
      [3, 2],
      [2, 3],
      [3, 3]
    ]) {
      const t = at(x, y);
      expect(hasOccupant(t.surface, Occupant.Structure), `(${x},${y}) surface`).toBe(true);
      expect(t.buildingId, `(${x},${y}) buildingId`).toBe(1);
      expect(t.powered, `(${x},${y}) powered`).toBe(true);
      expect(t.watered, `(${x},${y}) watered`).toBe(true);
      expect(t.terrain).toBe(Terrain.Land);
    }
  });

  it('the water tower (4,2)-(5,3) and elementary school (6,2)-(7,3) are separate developed buildings, both powered', () => {
    const tower = at(4, 2);
    expect(tower.buildingId).toBe(2);
    expect(hasOccupant(tower.surface, Occupant.Structure)).toBe(true);
    expect(tower.powered).toBe(true);
    expect(tower.watered).toBe(true);

    const school = at(6, 2);
    expect(school.buildingId).toBe(3);
    expect(hasOccupant(school.surface, Occupant.Structure)).toBe(true);
    expect(school.powered).toBe(true);
  });

  it('the two residential lots against the school are developed and elementary-served', () => {
    for (const [x, y, buildingId] of [
      [6, 4, 6],
      [7, 4, 5]
    ]) {
      const t = at(x, y);
      expect(hasOccupant(t.surface, Occupant.ZoneResidential), `(${x},${y}) zone tag`).toBe(true);
      expect(t.buildingId, `(${x},${y}) buildingId`).toBe(buildingId);
      expect(t.powered, `(${x},${y}) powered`).toBe(true);
      expect(t.watered, `(${x},${y}) watered`).toBe(true);
      expect(t.services.served[ServiceId.EducationElementary], `(${x},${y}) elementary served`).toBe(true);
      expect(t.services.served[ServiceId.EducationHigh], `(${x},${y}) high served`).toBe(false);
      // Small city, ample capacity relative to the two lots' population — the
      // school meets the whole load, so the score decodes to (very nearly) 1.
      expect(t.services.scores[ServiceId.EducationElementary]!, `(${x},${y}) elementary score`).toBeCloseTo(1, 1);
      expect(t.happiness, `(${x},${y}) happiness`).toBeGreaterThan(0);
    }
  });

  it('the road tiles under the residential lots carry no building and no education service', () => {
    for (const [x, y] of [
      [6, 5],
      [7, 5]
    ]) {
      const t = at(x, y);
      expect(hasOccupant(t.surface, Occupant.Road), `(${x},${y}) road`).toBe(true);
      expect(t.buildingId, `(${x},${y}) buildingId`).toBeUndefined();
      expect(t.services.served[ServiceId.EducationElementary], `(${x},${y}) not served`).toBeFalsy();
    }
  });

  it('the level crossing at (10,10) carries both Road and Rail on the surface stratum', () => {
    const t = at(10, 10);
    expect(hasOccupant(t.surface, Occupant.Road)).toBe(true);
    expect(hasOccupant(t.surface, Occupant.Rail)).toBe(true);
    expect(t.buildingId).toBeUndefined();
    expect(t.powered).toBe(false);
  });

  it('the bare hydro line at (1,10) is overhead-only, on open ground', () => {
    const t = at(1, 10);
    expect(hasOccupant(t.overhead, Occupant.PowerLine)).toBe(true);
    expect(t.overhead).toBe(1 << Occupant.PowerLine);
    expect(t.surface).toBe(0);
    expect(t.underground).toBe(0);
  });

  it('the buried pipe at (1,12) is underground-only, with nothing above it', () => {
    const t = at(1, 12);
    expect(hasOccupant(t.underground, Occupant.Pipe)).toBe(true);
    expect(t.underground).toBe(1 << Occupant.Pipe);
    expect(t.surface).toBe(0);
    expect(t.overhead).toBe(0);
  });

  it('the tree at (1,14) is overhead-only', () => {
    const t = at(1, 14);
    expect(hasOccupant(t.overhead, Occupant.Trees)).toBe(true);
    expect(t.overhead).toBe(1 << Occupant.Trees);
  });

  it('the open water tile at (14,14) decodes Water terrain with no occupants', () => {
    const t = at(14, 14);
    expect(t.terrain).toBe(Terrain.Water);
    expect(t.underground).toBe(0);
    expect(t.surface).toBe(0);
    expect(t.overhead).toBe(0);
  });

  it('the park at (9,9) is an independent, unpowered civic building', () => {
    const t = at(9, 9);
    expect(hasOccupant(t.surface, Occupant.Structure)).toBe(true);
    expect(t.buildingId).toBe(4);
    // Parks draw no power/water — see `city-sim-core`'s `PARK` template.
    expect(t.powered).toBe(false);
    expect(t.watered).toBe(false);
  });

  it('an untouched tile far from every feature decodes to defaults', () => {
    const t = at(0, 0);
    expect(t.terrain).toBe(Terrain.Land);
    expect(t.underground).toBe(0);
    expect(t.surface).toBe(0);
    expect(t.overhead).toBe(0);
    expect(t.buildingId).toBeUndefined();
    expect(t.powered).toBe(false);
    expect(t.watered).toBe(false);
  });
});
