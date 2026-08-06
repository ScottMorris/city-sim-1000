// persistence.test.ts — legacy JSON save transcode into the frozen v4 wire buffer.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { transcodeLegacySave } from './persistence';
import { TileKind } from './gameState';
import { SeededRng } from './rng';
import { createDefaultBudgetPolicy } from './protocol/commands';
import { LEGACY_FLAGS, legacyTileBufferOffsets } from './protocol/legacyTileBuffer';

const WIDTH = 8;
const HEIGHT = 8;
const N = WIDTH * HEIGHT;

/** A raw legacy JSON save payload — the shape `transcodeLegacySave` reads directly, no back-fill. */
function rawSave(overrides: Record<string, unknown> = {}) {
  const tiles = Array.from({ length: N }, () => ({ kind: TileKind.Land }));
  return {
    width: WIDTH,
    height: HEIGHT,
    seed: 42,
    tiles,
    money: 100000,
    day: 1,
    tick: 0,
    population: 12,
    jobs: 4,
    ...overrides
  };
}

function transcode(overrides: Record<string, unknown> = {}) {
  return transcodeLegacySave(JSON.stringify(rawSave(overrides)));
}

const o = legacyTileBufferOffsets(N);

describe('client passthrough', () => {
  it('passes settings/bylaws through untouched — ensureSettingsShape/applyClientState do the back-fill', () => {
    const result = transcode({ settings: { pendingPenaltyEnabled: false }, bylaws: { lighting: true } });
    expect(result.client).toEqual({
      settings: { pendingPenaltyEnabled: false },
      bylaws: { lighting: true }
    });
  });

  it('carries absent settings/bylaws through as undefined', () => {
    const raw = rawSave();
    delete (raw as any).settings;
    delete (raw as any).bylaws;
    const result = transcodeLegacySave(JSON.stringify(raw));
    expect(result.client.settings).toBeUndefined();
    expect(result.client.bylaws).toBeUndefined();
  });
});

describe('seed and RNG', () => {
  it('assigns seed 0 and a fresh rngState when both are absent', () => {
    const raw = rawSave();
    delete (raw as any).seed;
    const result = transcodeLegacySave(JSON.stringify(raw));
    expect(result.engine.seed).toBe(0);
    expect(result.engine.rngState).toEqual(new SeededRng(0).toJSON());
  });

  it('re-derives rngState from the seed when the saved array is malformed', () => {
    const result = transcode({ seed: 9, rngState: [1, 2] });
    expect(result.engine.rngState).toEqual(new SeededRng(9).toJSON());
  });

  it('preserves a valid 4-word rngState untouched', () => {
    const rngState = new SeededRng(9).toJSON();
    const result = transcode({ seed: 9, rngState });
    expect(result.engine.rngState).toEqual(rngState);
  });
});

describe('scalars', () => {
  it('floors day/population/jobs and passes tick/money/width/height through', () => {
    const result = transcode({ money: 555, day: 3.7, tick: 40, population: 12.9, jobs: 4.2 });
    expect(result.engine.money).toBe(555);
    expect(result.engine.day).toBe(3);
    expect(result.engine.tick).toBe(40);
    expect(result.engine.population).toBe(12);
    expect(result.engine.jobs).toBe(4);
    expect(result.engine.width).toBe(WIDTH);
    expect(result.engine.height).toBe(HEIGHT);
  });

  it('defaults day/tick/population/jobs to 0 when absent', () => {
    const raw = rawSave();
    delete (raw as any).day;
    delete (raw as any).tick;
    delete (raw as any).population;
    delete (raw as any).jobs;
    const result = transcodeLegacySave(JSON.stringify(raw));
    expect(result.engine.day).toBe(0);
    expect(result.engine.tick).toBe(0);
    expect(result.engine.population).toBe(0);
    expect(result.engine.jobs).toBe(0);
  });
});

describe('policy fold and clamp', () => {
  it('back-fills the neutral policy when absent', () => {
    const result = transcode();
    expect(result.policies.budget).toEqual(createDefaultBudgetPolicy());
    expect(result.engine.policies).toEqual(result.policies);
  });

  it('folds legacy flat budgetPolicy/wildernessPolicy keys into policies', () => {
    const result = transcode({
      budgetPolicy: { ...createDefaultBudgetPolicy(), taxResidential: 14 },
      wildernessPolicy: { natureReserve: true, greenIndustry: false }
    });
    expect(result.policies.budget.taxResidential).toBe(14);
    expect(result.policies.wilderness.natureReserve).toBe(true);
  });

  it('clamps out-of-range policy values on load', () => {
    const result = transcode({
      policies: { budget: { ...createDefaultBudgetPolicy(), taxResidential: 99, fundPower: 900 }, wilderness: {} }
    });
    expect(result.policies.budget.taxResidential).toBe(20);
    expect(result.policies.budget.fundPower).toBe(100);
  });
});

describe('tile flags byte', () => {
  it('packs powered/watered/abandoned/underlay/overlay bits verbatim, with no normalisation', () => {
    const tiles = Array.from({ length: N }, () => ({ kind: TileKind.Land }));
    tiles[0] = {
      kind: TileKind.Land,
      powered: true,
      watered: true,
      abandoned: true,
      roadUnderlay: true,
      railUnderlay: true,
      powerOverlay: true
    } as any;
    const result = transcode({ tiles });
    expect(result.engine.tiles[o.flags + 0]).toBe(
      LEGACY_FLAGS.POWERED |
        LEGACY_FLAGS.WATERED |
        LEGACY_FLAGS.ABANDONED |
        LEGACY_FLAGS.ROAD_UNDERLAY |
        LEGACY_FLAGS.RAIL_UNDERLAY |
        LEGACY_FLAGS.POWER_OVERLAY
    );
  });

  it('defaults every flag bit to 0 on a tile with no flag fields at all', () => {
    const result = transcode();
    expect(result.engine.tiles[o.flags + 0]).toBe(0);
  });

  it('an unrecognised kind string encodes as Land (0), matching the old fall-through', () => {
    const tiles = Array.from({ length: N }, () => ({ kind: TileKind.Land }));
    tiles[0] = { kind: 'not_a_real_kind' } as any;
    const result = transcode({ tiles });
    expect(result.engine.tiles[o.kind + 0]).toBe(0);
  });
});

describe('civic back-fill: minted building ids', () => {
  it('mints an id for a pump/water_tower/park tile with no buildingId, and writes it little-endian', () => {
    const idx = 3 * WIDTH + 4;
    const tiles = Array.from({ length: N }, () => ({ kind: TileKind.Land }));
    tiles[idx] = { kind: TileKind.WaterPump } as any;
    const result = transcode({ tiles, buildings: [], nextBuildingId: 0 });
    const lo = result.engine.tiles[o.buildingId + idx * 2];
    const hi = result.engine.tiles[o.buildingId + idx * 2 + 1];
    const mintedId = lo | (hi << 8);
    expect(mintedId).toBeGreaterThan(0);
    expect(result.engine.tiles[o.kind + idx]).toBe(10); // TileKind.WaterPump's u8
  });

  it('does not touch a pump/water_tower/park tile that already has a buildingId', () => {
    const idx = 5;
    const tiles = Array.from({ length: N }, () => ({ kind: TileKind.Land }));
    tiles[idx] = { kind: TileKind.Park, buildingId: 7 } as any;
    const result = transcode({ tiles });
    const lo = result.engine.tiles[o.buildingId + idx * 2];
    const hi = result.engine.tiles[o.buildingId + idx * 2 + 1];
    expect(lo | (hi << 8)).toBe(7);
  });

  it('mints ids in row-major tile order, continuing from the highest existing id', () => {
    const idxA = 1;
    const idxB = 2;
    const tiles = Array.from({ length: N }, () => ({ kind: TileKind.Land }));
    tiles[idxA] = { kind: TileKind.WaterPump } as any;
    tiles[idxB] = { kind: TileKind.Park } as any;
    const result = transcode({
      tiles,
      buildings: [{ id: 10, templateId: 'hydro', origin: { x: 0, y: 0 } }],
      nextPowerPlantId: 3
    });
    const readId = (idx: number) =>
      result.engine.tiles[o.buildingId + idx * 2] | (result.engine.tiles[o.buildingId + idx * 2 + 1] << 8);
    expect(readId(idxA)).toBe(11);
    expect(readId(idxB)).toBe(12);
  });

  it('a non-civic structure kind (e.g. hydro) with no buildingId is left unminted (id byte stays 0)', () => {
    const idx = 6;
    const tiles = Array.from({ length: N }, () => ({ kind: TileKind.Land }));
    tiles[idx] = { kind: TileKind.HydroPlant } as any;
    const result = transcode({ tiles });
    expect(result.engine.tiles[o.buildingId + idx * 2]).toBe(0);
    expect(result.engine.tiles[o.buildingId + idx * 2 + 1]).toBe(0);
  });
});

describe('underground byte', () => {
  it('encodes a buried water pipe as the WaterPipe kind byte', () => {
    const idx = 9;
    const tiles = Array.from({ length: N }, () => ({ kind: TileKind.Land }));
    tiles[idx] = { kind: TileKind.Land, underground: TileKind.WaterPipe } as any;
    const result = transcode({ tiles });
    expect(result.engine.tiles[o.undergroundKind + idx]).toBe(12); // TileKind.WaterPipe's u8
  });

  it('encodes 0xFF for no underground, including an unrecognised underground string', () => {
    const idx = 9;
    const tiles = Array.from({ length: N }, () => ({ kind: TileKind.Land }));
    tiles[idx] = { kind: TileKind.Land, underground: 'coal' } as any;
    const result = transcode({ tiles });
    expect(result.engine.tiles[o.undergroundKind + idx]).toBe(0xff);
    expect(result.engine.tiles[o.undergroundKind + 0]).toBe(0xff);
  });
});

describe('happiness and elevation', () => {
  it('encodes happiness/elevation, defaulting both to 0 when absent', () => {
    const idx = 2;
    const tiles = Array.from({ length: N }, () => ({ kind: TileKind.Land }));
    tiles[idx] = { kind: TileKind.Land, happiness: 2, elevation: 200 } as any;
    const result = transcode({ tiles });
    expect(result.engine.tiles[o.happiness + idx]).toBe(255); // encodeHappiness(2) = floor(2*127.5)
    expect(result.engine.tiles[o.elevation + idx]).toBe(200);
    expect(result.engine.tiles[o.happiness + 0]).toBe(0);
    expect(result.engine.tiles[o.elevation + 0]).toBe(0);
  });
});
