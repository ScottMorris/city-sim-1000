// saveContainer.test.ts — CSAV codec, legacy sniffing/import, and the IDB store.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  SaveFormatError,
  buildSaveMeta,
  decodeSave,
  encodeSave,
  isLegacyJsonSave,
  transcodeLegacySave,
  type SaveContainer
} from './persistence';
import { createInitialState, TileKind } from './gameState';
import { extractClientState } from './clientState';
import { deleteSave, getSave, listSaveMetas, putSave, setIdbFactory } from './saveStore';
import { LEGACY_BYTES_PER_TILE, LEGACY_FLAGS, legacyTileBufferOffsets } from './protocol/legacyTileBuffer';

/** A minimal hand-spelled raw legacy JSON save — the shape `transcodeLegacySave` reads. */
function rawLegacySave(overrides: Record<string, unknown> = {}) {
  const width = 8;
  const height = 8;
  const tiles = Array.from({ length: width * height }, () => ({ kind: TileKind.Land }));
  return JSON.stringify({
    width,
    height,
    seed: 5,
    tiles,
    money: 100000,
    day: 1,
    tick: 0,
    population: 12,
    jobs: 4,
    ...overrides
  });
}

function makeContainer(name?: string): SaveContainer {
  const state = createInitialState(8, 8, 5);
  const meta = buildSaveMeta(state, 'manual', '2026-07-22T12:00:00.000Z');
  if (name !== undefined) meta.name = name;
  return {
    meta,
    engineSnapshot: new Uint8Array([0x43, 0x53, 0x49, 0x4d, 4, 0, 0, 0, 42, 99]),
    client: extractClientState(state)
  };
}

describe('CSAV container codec', () => {
  it('round-trips meta, engine snapshot, and client state', () => {
    const container = makeContainer();
    const decoded = decodeSave(encodeSave(container));
    expect(decoded.meta).toEqual(container.meta);
    expect(Array.from(decoded.engineSnapshot)).toEqual(Array.from(container.engineSnapshot));
    expect(decoded.client).toEqual(container.client);
  });

  it('round-trips non-ASCII city names (UTF-8 section lengths)', () => {
    const container = makeContainer('Ville de Montréal 🏙️');
    const decoded = decodeSave(encodeSave(container));
    expect(decoded.meta.name).toBe('Ville de Montréal 🏙️');
  });

  it('rejects a truncated container', () => {
    const bytes = encodeSave(makeContainer());
    expect(() => decodeSave(bytes.subarray(0, bytes.length - 5))).toThrow(SaveFormatError);
    expect(() => decodeSave(bytes.subarray(0, 6))).toThrow(SaveFormatError);
  });

  it('rejects bad magic and unknown versions', () => {
    const bytes = encodeSave(makeContainer());
    const badMagic = bytes.slice();
    badMagic[0] = 0x58;
    expect(() => decodeSave(badMagic)).toThrow(/magic/i);
    const badVersion = bytes.slice();
    badVersion[4] = 99;
    expect(() => decodeSave(badVersion)).toThrow(/version/i);
  });

  it('sniffs legacy JSON saves apart from CSAV blobs', () => {
    const legacy = new TextEncoder().encode(`  \n${rawLegacySave()}`);
    expect(isLegacyJsonSave(legacy)).toBe(true);
    expect(isLegacyJsonSave(encodeSave(makeContainer()))).toBe(false);
  });
});

describe('transcodeLegacySave', () => {
  it('re-encodes raw tile fields into the wire SoA layout with packed flags', () => {
    const n = 64;
    const tiles = Array.from({ length: n }, () => ({ kind: TileKind.Land }));
    tiles[3 * 8 + 3] = { kind: TileKind.Road } as any;
    // A road-underlay flag on a tile whose `kind` is something else entirely
    // — the raw flags/kind are transcoded verbatim, with no re-derivation.
    const flagsIdx = 4 * 8 + 4;
    tiles[flagsIdx] = {
      kind: TileKind.Rail,
      powered: true,
      watered: true,
      roadUnderlay: true
    } as any;
    const raw = rawLegacySave({ seed: 3, tiles });
    const imp = transcodeLegacySave(raw).engine;
    const o = legacyTileBufferOffsets(n);

    expect(imp.tiles).toHaveLength(n * LEGACY_BYTES_PER_TILE);
    expect(imp.tiles[o.kind + 3 * 8 + 3]).toBe(3); // TileKind.Road's u8
    expect(imp.tiles[o.kind + flagsIdx]).toBe(4); // TileKind.Rail's u8
    expect(imp.tiles[o.flags + flagsIdx]).toBe(LEGACY_FLAGS.POWERED | LEGACY_FLAGS.WATERED | LEGACY_FLAGS.ROAD_UNDERLAY);
    expect(imp.seed).toBe(3);
  });

  it('writes building ids little-endian and 0xFF for no underground', () => {
    const n = 64;
    const tiles = Array.from({ length: n }, () => ({ kind: TileKind.Land }));
    tiles[5] = { kind: TileKind.HydroPlant, buildingId: 0x1234 } as any;
    const raw = rawLegacySave({ seed: 3, tiles });
    const imp = transcodeLegacySave(raw).engine;
    const o = legacyTileBufferOffsets(n);
    expect(imp.tiles[o.buildingId + 5 * 2]).toBe(0x34);
    expect(imp.tiles[o.buildingId + 5 * 2 + 1]).toBe(0x12);
    expect(imp.tiles[o.undergroundKind + 7]).toBe(0xff);
  });

  it('writes the WaterPipe kind byte for a buried pipe, and 0xFF otherwise', () => {
    const n = 64;
    const tiles = Array.from({ length: n }, () => ({ kind: TileKind.Land }));
    tiles[9] = { kind: TileKind.Land, underground: TileKind.WaterPipe } as any;
    const raw = rawLegacySave({ seed: 3, tiles });
    const imp = transcodeLegacySave(raw).engine;
    const o = legacyTileBufferOffsets(n);
    expect(imp.tiles[o.undergroundKind + 9]).toBe(12); // TileKind.WaterPipe's u8
    expect(imp.tiles[o.undergroundKind + 0]).toBe(0xff);
  });
});

describe('saveStore (IndexedDB)', () => {
  beforeEach(() => {
    setIdbFactory(new IDBFactory());
  });

  it('put/get round-trips a save record', async () => {
    const container = encodeSave(makeContainer('Testville'));
    const meta = decodeSave(container).meta;
    await putSave('manual', meta, container);
    const record = await getSave('manual');
    expect(record).not.toBeNull();
    expect(record!.meta.name).toBe('Testville');
    expect(Array.from(new Uint8Array(record!.container))).toEqual(Array.from(container));
  });

  it('returns null for an empty slot and lists stored metas', async () => {
    expect(await getSave('autosave')).toBeNull();
    const container = encodeSave(makeContainer());
    await putSave('manual', decodeSave(container).meta, container);
    const metas = await listSaveMetas();
    expect(metas).toHaveLength(1);
    expect(metas[0].id).toBe('manual');
  });

  it('deleteSave empties the slot', async () => {
    const container = encodeSave(makeContainer());
    await putSave('manual', decodeSave(container).meta, container);
    await deleteSave('manual');
    expect(await getSave('manual')).toBeNull();
  });
});
