// durableStorage.ts — best-effort request for durable (eviction-resistant) browser storage.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// Fired once, after the first successful save write (see `saveStore.putSave`).
// `navigator.storage.persist()` only reduces — never eliminates — the chance
// the browser evicts IndexedDB under storage pressure, but it's cheap to ask
// and cheap to skip where unsupported.

export interface StorageManagerLike {
  persisted: () => Promise<boolean>;
  persist: () => Promise<boolean>;
}

let requested = false;

/** Test-only: clears the once-guard between cases. */
export function resetDurableStorageRequestForTests(): void {
  requested = false;
}

/**
 * Fire-and-forget: no-op after the first call (module-level guard), and a
 * no-op wherever `navigator.storage` (or an injected equivalent) is absent.
 */
export function requestDurableStorage(manager?: StorageManagerLike | null): void {
  if (requested) return;
  requested = true;
  const mgr = manager ?? (typeof navigator === 'undefined' ? undefined : navigator.storage);
  if (!mgr) return;
  void (async () => {
    try {
      if (await mgr.persisted()) {
        console.info('[storage] durable storage already granted');
        return;
      }
      const granted = await mgr.persist();
      console.info(`[storage] durable storage ${granted ? 'granted' : 'declined'}`);
    } catch (err) {
      console.error('[storage] durable storage request failed', err);
    }
  })();
}
