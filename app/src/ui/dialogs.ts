// dialogs.ts — save/load persistence controls, toasts, and the manual modal.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import {
  SaveFormatError,
  buildSaveFile,
  buildSaveMeta,
  decodeLegacySave,
  decodeSave,
  downloadSave,
  encodeSave,
  isLegacyJsonSave,
  type LegacySaveTranscode,
  type SaveContainer
} from '../game/persistence';
import { extractClientState } from '../game/clientState';
import { getSave, putSave } from '../game/saveStore';
import { GameState } from '../game/gameState';
import type { InputMode } from './deviceMode';

let toastRoot: HTMLDivElement | null = null;
const toastsById = new Map<string, HTMLDivElement>();

type ToastSeverity = 'info' | 'warning' | 'success';

export interface ToastOptions {
  severity?: ToastSeverity;
  sticky?: boolean;
  id?: string;
  durationMs?: number;
}

function removeToast(div: HTMLDivElement, id?: string) {
  if (div.dataset.closing === 'true') return;
  div.dataset.closing = 'true';
  div.style.opacity = '0';
  div.style.transform = 'translateY(-6px)';
  setTimeout(() => {
    div.remove();
    if (id) toastsById.delete(id);
    if (toastRoot && toastRoot.childElementCount === 0) {
      toastRoot.remove();
      toastRoot = null;
    }
  }, 200);
}

export function dismissToast(id: string) {
  const existing = toastsById.get(id);
  if (existing) {
    removeToast(existing, id);
  }
}

export function showToast(message: string, options: ToastOptions = {}) {
  const { severity = 'info', sticky = false, id, durationMs = 1400 } = options;
  if (!toastRoot) {
    toastRoot = document.createElement('div');
    toastRoot.style.position = 'fixed';
    toastRoot.style.right = '12px';
    toastRoot.style.top = '12px';
    toastRoot.style.display = 'flex';
    toastRoot.style.flexDirection = 'column';
    toastRoot.style.gap = '8px';
    toastRoot.style.alignItems = 'flex-end';
    toastRoot.style.pointerEvents = 'none';
    toastRoot.style.zIndex = '3000';
    document.body.appendChild(toastRoot);
  }

  if (id && toastsById.has(id)) {
    dismissToast(id);
  }

  const div = document.createElement('div');
  div.textContent = message;
  div.style.padding = '10px 12px';
  // Some toasts now carry longer tap-revealed info (e.g. the wilderness
  // score breakdown) rather than a short one-line confirmation — keep those
  // from running edge-to-edge/off-screen on a narrow phone.
  div.style.maxWidth = 'min(320px, calc(100vw - 24px))';
  const severityStyles: Record<ToastSeverity, { background: string; border: string }> = {
    info: { background: '#1f2c4b', border: '#7bffb7' },
    success: { background: '#1f2c4b', border: '#7bffb7' },
    warning: { background: '#2a1f0f', border: '#f08c42' }
  };
  const palette = severityStyles[severity] ?? severityStyles.info;
  div.style.background = palette.background;
  div.style.border = `1px solid ${palette.border}`;
  div.style.borderRadius = '10px';
  div.style.color = '#e8f1ff';
  div.style.boxShadow = '0 6px 12px rgba(0,0,0,0.35)';
  div.style.pointerEvents = 'auto';
  div.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
  div.style.position = 'relative';

  if (sticky) {
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.position = 'absolute';
    closeBtn.style.top = '4px';
    closeBtn.style.right = '6px';
    closeBtn.style.background = 'transparent';
    closeBtn.style.border = 'none';
    closeBtn.style.color = '#e8f1ff';
    closeBtn.style.fontSize = '14px';
    closeBtn.style.cursor = 'pointer';
    closeBtn.addEventListener('click', () => removeToast(div, id));
    div.appendChild(closeBtn);
  }

  if (id) {
    toastsById.set(id, div);
  }
  toastRoot.appendChild(div);

  if (!sticky) {
    setTimeout(() => removeToast(div, id), durationMs);
  }
}

interface PersistenceOptions {
  saveBtn: HTMLButtonElement;
  loadBtn: HTMLButtonElement;
  downloadBtn: HTMLButtonElement;
  uploadBtn: HTMLButtonElement;
  fileInput: HTMLInputElement;
  getState: () => GameState;
  /** Serialise the engine state — `SimBridge.getSnapshot`. */
  getEngineSnapshot: () => Promise<Uint8Array>;
  /** Restore a decoded CSAV container into the engine + display mirror. */
  onContainerLoaded: (container: SaveContainer) => Promise<void>;
  /** One-time import of a legacy JSON save (pre-CSAV upload). */
  onLegacyLoaded: (imp: LegacySaveTranscode) => Promise<void>;
  /** Current touch/mouse input mode — gates the Web Share export path to touch devices; desktop always downloads. */
  getInputMode: () => InputMode;
}

type ShareOutcome = 'shared' | 'cancelled' | 'unsupported' | 'failed';

/** Attempt to export a save via the Web Share API (Android's share sheet, etc). Never throws — an unsupported browser or a real rejection both resolve to a fallback outcome for the caller to handle. */
async function attemptShareSave(file: File): Promise<ShareOutcome> {
  if (!navigator.share || !navigator.canShare) return 'unsupported';
  if (!navigator.canShare({ files: [file] })) return 'unsupported';
  try {
    await navigator.share({ files: [file], title: 'City Sim save', text: file.name });
    return 'shared';
  } catch (err) {
    // DOMException's prototype chain isn't reliably `instanceof Error` across
    // environments (Node's built-in DOMException vs. a browser's), so check
    // `.name` directly rather than gating on `instanceof Error` first.
    if (err && typeof err === 'object' && 'name' in err && err.name === 'AbortError') return 'cancelled';
    return 'failed';
  }
}

export function bindPersistenceControls(options: PersistenceOptions) {
  const {
    saveBtn, loadBtn, downloadBtn, uploadBtn, fileInput,
    getState, getEngineSnapshot, onContainerLoaded, onLegacyLoaded, getInputMode
  } = options;

  const buildContainer = async (): Promise<Uint8Array> => {
    const state = getState();
    const engineSnapshot = await getEngineSnapshot();
    return encodeSave({
      meta: buildSaveMeta(state, 'manual', new Date().toISOString()),
      engineSnapshot,
      client: extractClientState(state)
    });
  };

  saveBtn.addEventListener('click', () => {
    void buildContainer()
      .then(bytes => putSave('manual', decodeSave(bytes).meta, bytes))
      .then(() => showToast('Saved to browser'))
      .catch(() => showToast('Save failed — try Download instead', { severity: 'warning' }));
  });

  loadBtn.addEventListener('click', () => {
    void getSave('manual')
      .then(async record => {
        if (!record) {
          showToast('No save found');
          return;
        }
        await onContainerLoaded(decodeSave(new Uint8Array(record.container)));
        showToast('Loaded from browser');
      })
      .catch(() => showToast('Load failed — the save may be corrupt', { severity: 'warning' }));
  });

  downloadBtn.addEventListener('click', () => {
    void buildContainer()
      .then(async bytes => {
        const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
        const filename = `city-sim-${stamp}.citysim`;
        // Touch devices get a share-sheet-first export (Android's "Download"
        // menu item is awkward to reach from a share sheet-native OS); mouse
        // input keeps the exact `<a download>` behaviour unchanged.
        if (getInputMode() === 'touch') {
          const outcome = await attemptShareSave(buildSaveFile(bytes, filename));
          if (outcome === 'shared' || outcome === 'cancelled') return;
          // 'unsupported' or 'failed' fall through to the download path below.
        }
        downloadSave(bytes, filename);
      })
      .catch(() => showToast('Download failed', { severity: 'warning' }));
  });

  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;
    fileInput.value = '';
    void (async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (isLegacyJsonSave(bytes)) {
        await onLegacyLoaded(decodeLegacySave(new TextDecoder().decode(bytes)));
      } else {
        await onContainerLoaded(decodeSave(bytes));
      }
      showToast('Save loaded');
    })().catch(err => {
      const message = err instanceof SaveFormatError ? err.message : 'Could not load that file';
      showToast(message, { severity: 'warning' });
    });
  });
}

export function showManualModal(url = 'manual.html') {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.className = 'secondary modal-close';

  const frame = document.createElement('iframe');
  frame.src = url;
  frame.title = 'Manual';
  frame.loading = 'lazy';

  const handleEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') cleanup();
  };

  modal.appendChild(closeBtn);
  modal.appendChild(frame);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const cleanup = () => backdrop.remove();
  closeBtn.addEventListener('click', cleanup);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) cleanup();
  });
  window.addEventListener('keydown', handleEsc);
  frame.addEventListener('load', () => {
    try {
      frame.contentWindow?.addEventListener('keydown', handleEsc);
    } catch {
      // ignore cross-origin issues (should not happen for local manual)
    }
  });
}
