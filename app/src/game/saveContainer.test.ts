// saveContainer.test.ts — CSAV codec, legacy sniffing/import, and the IDB store.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, expect, it, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  SaveFormatError,
  buildLegacyEngineImport,
  buildSaveMeta,
  decodeSave,
  encodeSave,
  isLegacyJsonSave,
  serialize,
  type SaveContainer
} from './persistence';
import { createInitialState } from './gameState';
import { extractClientState } from './clientState';
import { applyTool } from './tools';
import { Tool } from './toolTypes';
import { deleteSave, getSave, listSaveMetas, putSave, setIdbFactory } from './saveStore';
import { BYTES_PER_TILE, FLAGS, tileBufferOffsets } from './protocol/tileBuffer';
import { tileKindToU8 } from './protocol/tileKind';

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
    const legacy = new TextEncoder().encode(`  \n${serialize(createInitialState(4, 4, 1))}`);
    expect(isLegacyJsonSave(legacy)).toBe(true);
    expect(isLegacyJsonSave(encodeSave(makeContainer()))).toBe(false);
  });
});

describe('buildLegacyEngineImport', () => {
  it('re-encodes tiles into the wire SoA layout with packed flags', () => {
    const state = createInitialState(8, 8, 3);
    applyTool(state, Tool.Road, 3, 3);
    state.tiles[10].powered = true;
    state.tiles[10].watered = true;
    state.tiles[10].roadUnderlay = true;
    const imp = buildLegacyEngineImport(state);
    const n = 64;
    const o = tileBufferOffsets(n);
    expect(imp.tiles).toHaveLength(n * BYTES_PER_TILE);
    expect(imp.tiles[o.kind + 3 * 8 + 3]).toBe(tileKindToU8(state.tiles[3 * 8 + 3].kind));
    expect(imp.tiles[o.flags + 10]).toBe(FLAGS.POWERED | FLAGS.WATERED | FLAGS.ROAD_UNDERLAY);
    expect(imp.rngState).toEqual(state.rngState);
    expect(imp.seed).toBe(3);
    expect(imp.policies).toEqual(state.policies);
  });

  it('writes building ids little-endian and 0xFF for no underground', () => {
    const state = createInitialState(8, 8, 3);
    state.tiles[5].buildingId = 0x1234;
    state.tiles[6].underground = state.tiles[6].kind; // any kind round-trips
    const imp = buildLegacyEngineImport(state);
    const o = tileBufferOffsets(64);
    expect(imp.tiles[o.buildingId + 5 * 2]).toBe(0x34);
    expect(imp.tiles[o.buildingId + 5 * 2 + 1]).toBe(0x12);
    expect(imp.tiles[o.undergroundKind + 7]).toBe(0xff);
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
