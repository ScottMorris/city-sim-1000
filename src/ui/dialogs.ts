import { downloadState, loadFromBrowser, saveToBrowser, uploadState } from '../game/persistence';
import { GameState } from '../game/gameState';

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
    toastRoot.style.zIndex = '40';
    document.body.appendChild(toastRoot);
  }

  if (id && toastsById.has(id)) {
    dismissToast(id);
  }

  const div = document.createElement('div');
  div.textContent = message;
  div.style.padding = '10px 12px';
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
  onStateLoaded: (state: GameState) => void;
}

export function bindPersistenceControls(options: PersistenceOptions) {
  const { saveBtn, loadBtn, downloadBtn, uploadBtn, fileInput, getState, onStateLoaded } = options;

  saveBtn.addEventListener('click', () => {
    saveToBrowser(getState());
    showToast('Saved to browser');
  });

  loadBtn.addEventListener('click', () => {
    const loaded = loadFromBrowser();
    if (!loaded) {
      showToast('No save found');
      return;
    }
    onStateLoaded(loaded);
    showToast('Loaded from browser');
  });

  downloadBtn.addEventListener('click', () => {
    downloadState(getState());
  });

  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;
    uploadState(file).then((state) => {
      onStateLoaded(state);
      showToast('Save loaded');
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
