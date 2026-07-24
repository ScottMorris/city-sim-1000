// loadingScreen.ts — animated engine-loading overlay.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// Shows while the WASM worker initialises (or the Tauri plugin starts).
// A bridge may fire Ready almost immediately; the screen barely flickers then.
//
// Visual elements:
//   • Pixel-art skyline silhouette — buildings rise in with staggered delays
//   • Chunky progress bar — CSS steps() animation, fills to ~85%, snaps to
//     100% on Ready then the overlay fades out
//   • Rotating stage labels — cycle through five loading messages

const STAGES = [
  'Compiling simulation engine…',
  'Initialising city grid…',
  'Laying foundations…',
  'Connecting power grid…',
  'Opening city hall…',
];

// Each building: [leftOffset%, heightPct%] within the skyline container.
// Widths alternate narrow/wide to create rhythm.
const BUILDINGS: Array<[number, number, number]> = [
  //  x%  h%  w(px)
  [  0, 38, 14],
  [ 16, 60,  8],
  [ 26, 48, 12],
  [ 40, 80,  7],
  [ 49, 35, 16],
  [ 67, 65,  9],
  [ 78, 52, 13],
  [ 93, 90,  7],
  [102, 42, 18],
  [122, 72, 10],
  [134, 58, 12],
  [148, 84,  7],
  [157, 30, 14],
  [173, 95,  8],
  [183, 62, 11],
  [196, 45, 13],
  [211, 78,  8],
  [221, 50, 15],
  [238, 88,  7],
  [247, 40, 12],
  [261, 68, 10],
  [273, 55, 14],
  [289, 92,  7],
  [298, 38, 16],
  [316, 75,  9],
  [327, 60, 12],
  [341, 85,  7],
  [350, 44, 15],
  [367, 70,  8],
  [377, 52, 13],
];

// Pixel-art windows: a few lit squares punched into each building.
// Returns an array of [leftPx, bottomPx] relative to the building.
function buildingWindows(width: number, height: number): Array<[number, number]> {
  const cols = Math.max(1, Math.floor(width / 5) - 1);
  const rows = Math.max(1, Math.floor(height / 14));
  const wins: Array<[number, number]> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // deterministic "some lit, some dark" via simple hash
      if ((r * 3 + c * 7) % 5 !== 0) {
        wins.push([c * 5 + 2, r * 14 + 4]);
      }
    }
  }
  return wins;
}

function buildSkylineHtml(): string {
  return BUILDINGS.map(([x, hPct, w], i) => {
    const delay = i * 60;
    const wins = buildingWindows(w, hPct).map(
      ([wx, wy]) =>
        `<span class="ls-win" style="left:${wx}px;bottom:${wy}px"></span>`,
    ).join('');
    return `<div class="ls-bld" style="left:${x}px;height:${hPct}%;width:${w}px;animation-delay:${delay}ms">${wins}</div>`;
  }).join('');
}

export interface LoadingScreen {
  /** Call this when the bridge fires { type: 'Ready' }. */
  complete(): void;
  /**
   * Shows a persistent, on-screen error and stops the stage-label rotation —
   * for failures that mean 'Ready' will never arrive (WASM init failure, an
   * uncaught worker error). No devtools access on a phone means an error that
   * only reaches the console is invisible; this is the one place a player
   * stuck on this screen is guaranteed to be looking at.
   */
  showError(message: string): void;
}

export function initLoadingScreen(root: HTMLElement): LoadingScreen {
  const overlay = document.createElement('div');
  overlay.id = 'loading-screen';
  overlay.innerHTML = `
    <div class="ls-inner">
      <div class="ls-title">CITY SIM <span class="ls-title-accent">1000</span></div>
      <div class="ls-skyline-wrap">
        <div class="ls-skyline">${buildSkylineHtml()}</div>
        <div class="ls-horizon"></div>
      </div>
      <div class="ls-bar-wrap">
        <div class="ls-bar">
          <div class="ls-bar-fill" id="ls-bar-fill"></div>
        </div>
      </div>
      <div class="ls-stage" id="ls-stage">${STAGES[0]}</div>
      <div class="ls-elapsed" id="ls-elapsed">0s</div>
      <div class="ls-error" id="ls-error" hidden></div>
    </div>
  `;
  root.appendChild(overlay);

  // Rotate stage labels every 700 ms.
  let stageIdx = 0;
  const stageEl = overlay.querySelector<HTMLElement>('#ls-stage')!;
  const stageInterval = setInterval(() => {
    stageIdx = (stageIdx + 1) % STAGES.length;
    stageEl.textContent = STAGES[stageIdx];
  }, 700);

  // A live elapsed-time counter is the one piece of "what is it currently
  // doing" a player stuck here (often with no devtools access, e.g. on a
  // phone) can always read: it distinguishes a genuine hang from just being
  // slow, without needing anything from the actual boot sequence.
  const startedAt = Date.now();
  const elapsedEl = overlay.querySelector<HTMLElement>('#ls-elapsed')!;
  const elapsedInterval = setInterval(() => {
    elapsedEl.textContent = `${Math.round((Date.now() - startedAt) / 1000)}s`;
  }, 1000);

  const teardown = () => {
    clearInterval(stageInterval);
    clearInterval(elapsedInterval);
  };

  return {
    complete() {
      teardown();
      stageEl.textContent = 'Ready!';

      const fill = overlay.querySelector<HTMLElement>('#ls-bar-fill')!;
      fill.style.transition = 'width 120ms steps(4)';
      fill.style.width = '100%';

      // Brief pause so the "Ready!" and full bar are visible, then fade out.
      overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
      setTimeout(() => {
        overlay.style.transition = 'opacity 350ms ease';
        overlay.style.opacity = '0';
      }, 250);
    },
    showError(message: string) {
      if (!overlay.isConnected) return; // Already completed/removed — nothing to show this on.
      teardown();
      stageEl.textContent = 'Failed to start';
      const errorEl = overlay.querySelector<HTMLElement>('#ls-error')!;
      errorEl.textContent = message;
      errorEl.hidden = false;
    },
  };
}
