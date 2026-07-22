// durableStorage.test.ts — the once-only persist() request.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requestDurableStorage,
  resetDurableStorageRequestForTests,
  type StorageManagerLike
} from './durableStorage';

describe('requestDurableStorage', () => {
  beforeEach(() => {
    resetDurableStorageRequestForTests();
  });

  afterEach(() => {
    resetDurableStorageRequestForTests();
  });

  it('skips persist() when already persisted, and logs it', async () => {
    const manager: StorageManagerLike = {
      persisted: vi.fn().mockResolvedValue(true),
      persist: vi.fn().mockResolvedValue(true)
    };
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    requestDurableStorage(manager);
    await vi.waitFor(() => expect(manager.persisted).toHaveBeenCalledTimes(1));
    expect(manager.persist).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('already granted'));
    info.mockRestore();
  });

  it('requests persist() and logs the granted result', async () => {
    const manager: StorageManagerLike = {
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockResolvedValue(true)
    };
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    requestDurableStorage(manager);
    await vi.waitFor(() => expect(manager.persist).toHaveBeenCalledTimes(1));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('granted'));
    info.mockRestore();
  });

  it('logs the declined result', async () => {
    const manager: StorageManagerLike = {
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockResolvedValue(false)
    };
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    requestDurableStorage(manager);
    await vi.waitFor(() => expect(manager.persist).toHaveBeenCalledTimes(1));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('declined'));
    info.mockRestore();
  });

  it('is a no-op when navigator.storage is absent', () => {
    expect(() => requestDurableStorage(undefined)).not.toThrow();
  });

  it('only fires once, subsequent calls are no-ops', async () => {
    const manager: StorageManagerLike = {
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockResolvedValue(true)
    };
    requestDurableStorage(manager);
    requestDurableStorage(manager);
    requestDurableStorage(manager);
    await vi.waitFor(() => expect(manager.persist).toHaveBeenCalledTimes(1));
    expect(manager.persisted).toHaveBeenCalledTimes(1);
  });

  it('reports errors without throwing', async () => {
    const manager: StorageManagerLike = {
      persisted: vi.fn().mockRejectedValue(new Error('denied')),
      persist: vi.fn()
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => requestDurableStorage(manager)).not.toThrow();
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(manager.persist).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
