import { downloadState, loadFromBrowser, saveToBrowser, uploadState } from '../game/persistence';
import { GameState } from '../game/gameState';

export function showToast(message: string) {
  const div = document.createElement('div');
  div.textContent = message;
  div.style.position = 'absolute';
  div.style.right = '12px';
  div.style.top = '12px';
  div.style.padding = '10px 12px';
  div.style.background = '#1f2c4b';
  div.style.border = '1px solid #7bffb7';
  div.style.borderRadius = '10px';
  div.style.color = '#e8f1ff';
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 1400);
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

  modal.appendChild(closeBtn);
  modal.appendChild(frame);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const cleanup = () => backdrop.remove();
  closeBtn.addEventListener('click', cleanup);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) cleanup();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cleanup();
  });
}
