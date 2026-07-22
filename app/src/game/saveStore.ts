// saveStore.ts — IndexedDB persistence for CSAV save containers.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// Binary-native storage for browser saves: no base64 bloat, no 5 MB
// localStorage ceiling, async writes off the frame budget — and ready for the
// planned periodic autosave (M3) plus `navigator.storage.persist()`.
//
// One record per slot (`'manual'` now; `'autosave'` later). The whole CSAV
// blob is stored verbatim alongside its decoded meta, so save pickers can
// list cities without decoding postcard.

import type { SaveMeta } from './persistence';

const DB_NAME = 'city-sim-1000';
const DB_VERSION = 1;
const STORE = 'saves';

export type SaveSlotId = 'manual' | 'autosave';

export interface SaveRecord {
  id: SaveSlotId;
  meta: SaveMeta;
  container: ArrayBuffer;
}

/** Injectable for tests (`fake-indexeddb`); defaults to the browser's. */
let idbFactory: IDBFactory | null = null;

export function setIdbFactory(factory: IDBFactory): void {
  idbFactory = factory;
}

function openDb(): Promise<IDBDatabase> {
  const factory = idbFactory ?? globalThis.indexedDB;
  if (!factory) {
    return Promise.reject(new Error('IndexedDB is not available'));
  }
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb();
  try {
    return await requestToPromise(fn(db.transaction(STORE, mode).objectStore(STORE)));
  } finally {
    db.close();
  }
}

/** Store a CSAV blob (with its decoded meta) under a slot id. */
export async function putSave(id: SaveSlotId, meta: SaveMeta, container: Uint8Array): Promise<void> {
  const copy = container.slice().buffer as ArrayBuffer;
  await withStore('readwrite', store => store.put({ id, meta, container: copy } satisfies SaveRecord));
}

/** Fetch a slot's record, or null when the slot is empty. */
export async function getSave(id: SaveSlotId): Promise<SaveRecord | null> {
  const record = await withStore<SaveRecord | undefined>('readonly', store => store.get(id) as IDBRequest<SaveRecord | undefined>);
  return record ?? null;
}

/** Metas of every stored save, for save pickers. */
export async function listSaveMetas(): Promise<{ id: SaveSlotId; meta: SaveMeta }[]> {
  const records = await withStore<SaveRecord[]>('readonly', store => store.getAll() as IDBRequest<SaveRecord[]>);
  return records.map(({ id, meta }) => ({ id, meta }));
}

export async function deleteSave(id: SaveSlotId): Promise<void> {
  await withStore('readwrite', store => store.delete(id));
}

/**
 * The record to restore on boot: whichever of the two slots has the later
 * `savedAt`. Ties (or an invalid timestamp on one side) favour the manual
 * save — the deliberate one.
 */
export function pickNewestSave(
  manual: SaveRecord | null,
  autosave: SaveRecord | null
): SaveRecord | null {
  if (!manual) return autosave;
  if (!autosave) return manual;
  const manualAt = Date.parse(manual.meta.savedAt);
  const autoAt = Date.parse(autosave.meta.savedAt);
  return Number.isFinite(autoAt) && autoAt > manualAt ? autosave : manual;
}
