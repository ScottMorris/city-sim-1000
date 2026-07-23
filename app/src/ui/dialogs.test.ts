import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindPersistenceControls } from './dialogs';
import * as persistence from '../game/persistence';
import { createInitialState } from '../game/gameState';
import type { SaveContainer } from '../game/persistence';
import type { InputMode } from './deviceMode';

vi.mock('../game/persistence', async () => {
  const actual = await vi.importActual<typeof persistence>('../game/persistence');
  return { ...actual, downloadSave: vi.fn() };
});

interface ShareStubs {
  share?: Navigator['share'];
  canShare?: Navigator['canShare'];
}

/** jsdom's `navigator` doesn't implement the Web Share API at all, so `share`/`canShare` aren't there to reassign — define them (and clean up after) instead. */
function stubShare(overrides: ShareStubs) {
  const nav = navigator as Navigator & Partial<ShareStubs>;
  const hadShare = Object.prototype.hasOwnProperty.call(nav, 'share');
  const hadCanShare = Object.prototype.hasOwnProperty.call(nav, 'canShare');
  const original = { share: nav.share, canShare: nav.canShare };
  Object.defineProperty(nav, 'share', { value: overrides.share, configurable: true });
  Object.defineProperty(nav, 'canShare', { value: overrides.canShare, configurable: true });
  return () => {
    if (hadShare) {
      Object.defineProperty(nav, 'share', { value: original.share, configurable: true });
    } else {
      delete (nav as unknown as Record<string, unknown>).share;
    }
    if (hadCanShare) {
      Object.defineProperty(nav, 'canShare', { value: original.canShare, configurable: true });
    } else {
      delete (nav as unknown as Record<string, unknown>).canShare;
    }
  };
}

function setup(inputMode: InputMode) {
  const saveBtn = document.createElement('button');
  const loadBtn = document.createElement('button');
  const downloadBtn = document.createElement('button');
  const uploadBtn = document.createElement('button');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';

  const state = createInitialState(4, 4, 1);

  bindPersistenceControls({
    saveBtn,
    loadBtn,
    downloadBtn,
    uploadBtn,
    fileInput,
    getState: () => state,
    getEngineSnapshot: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    onContainerLoaded: (_container: SaveContainer) => Promise.resolve(),
    onLegacyLoaded: () => Promise.resolve(),
    getInputMode: () => inputMode
  });

  return { downloadBtn };
}

/** Flush the microtask chain inside the click handler (buildContainer → share/download). */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('bindPersistenceControls — share-based export (M3-3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('shares the save on touch when canShare/share are supported and accept the file', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn().mockReturnValue(true);
    const restore = stubShare({ share, canShare });

    const { downloadBtn } = setup('touch');
    downloadBtn.click();
    await flush();

    expect(canShare).toHaveBeenCalledTimes(1);
    const canShareArg = canShare.mock.calls[0][0] as { files: File[] };
    expect(canShareArg.files).toHaveLength(1);
    expect(canShareArg.files[0]).toBeInstanceOf(File);
    expect(canShareArg.files[0].name).toMatch(/^city-sim-\d{8}\.citysim$/);

    expect(share).toHaveBeenCalledTimes(1);
    expect(persistence.downloadSave).not.toHaveBeenCalled();

    restore();
  });

  it('does not attempt Web Share on mouse/desktop input, even when the API is available', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn().mockReturnValue(true);
    const restore = stubShare({ share, canShare });

    const { downloadBtn } = setup('mouse');
    downloadBtn.click();
    await flush();

    expect(canShare).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
    expect(persistence.downloadSave).toHaveBeenCalledTimes(1);

    restore();
  });

  it('falls back to download when the Web Share API is entirely unsupported', async () => {
    const restore = stubShare({ share: undefined, canShare: undefined });

    const { downloadBtn } = setup('touch');
    downloadBtn.click();
    await flush();

    expect(persistence.downloadSave).toHaveBeenCalledTimes(1);

    restore();
  });

  it('falls back to download when canShare rejects the file', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn().mockReturnValue(false);
    const restore = stubShare({ share, canShare });

    const { downloadBtn } = setup('touch');
    downloadBtn.click();
    await flush();

    expect(share).not.toHaveBeenCalled();
    expect(persistence.downloadSave).toHaveBeenCalledTimes(1);

    restore();
  });

  it('does not fall back to download, and shows no error, when the user cancels the share sheet', async () => {
    const abortError = new DOMException('The user aborted the share.', 'AbortError');
    const share = vi.fn().mockRejectedValue(abortError);
    const canShare = vi.fn().mockReturnValue(true);
    const restore = stubShare({ share, canShare });

    const { downloadBtn } = setup('touch');
    downloadBtn.click();
    await flush();

    expect(share).toHaveBeenCalledTimes(1);
    expect(persistence.downloadSave).not.toHaveBeenCalled();

    restore();
  });

  it('falls back to download on a real (non-abort) share rejection', async () => {
    const share = vi.fn().mockRejectedValue(new Error('boom'));
    const canShare = vi.fn().mockReturnValue(true);
    const restore = stubShare({ share, canShare });

    const { downloadBtn } = setup('touch');
    downloadBtn.click();
    await flush();

    expect(share).toHaveBeenCalledTimes(1);
    expect(persistence.downloadSave).toHaveBeenCalledTimes(1);

    restore();
  });
});
