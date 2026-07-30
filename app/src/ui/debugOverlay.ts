import { getBuildInfo, isEngineStale } from '../buildInfo';
import { DemandDetails, getSimulationDebugStats } from '../game/debugStats';
import { GameState } from '../game/gameState';
import { DAYS_PER_MONTH, getCalendarPosition } from '../game/time';
import { showToast } from './dialogs';
import { DEFAULT_COMPACT_BREAKPOINT_PX, DEFAULT_COMPACT_HEIGHT_BREAKPOINT_PX } from './deviceMode';

type DebugOverlayMode = 'mini' | 'full';

interface HeapSnapshot {
  available: boolean;
  usedMB?: number;
  limitMB?: number;
  allocatedMB?: number;
  reason?: string;
}

type PerformanceWithMemory = Performance & {
  memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
  measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
};

const heapSampler = {
  snapshot: { available: false, reason: 'Sampling…' } as HeapSnapshot,
  lastSample: 0,
  sampling: false
};

const FPS_WINDOW_MS = 5000;
const fpsTracker = {
  ema: 0,
  windowMin: Infinity,
  windowStart: 0,
  lastWindowMin: null as number | null
};

/** Feed each frame's delta in; cheap enough to call unconditionally regardless of overlay visibility. */
function recordFrame(deltaSeconds: number) {
  if (deltaSeconds <= 0) return;
  const instantFps = 1 / deltaSeconds;
  fpsTracker.ema = fpsTracker.ema === 0 ? instantFps : fpsTracker.ema * 0.9 + instantFps * 0.1;
  fpsTracker.windowMin = Math.min(fpsTracker.windowMin, instantFps);
  const now = performance.now();
  if (fpsTracker.windowStart === 0) fpsTracker.windowStart = now;
  if (now - fpsTracker.windowStart >= FPS_WINDOW_MS) {
    fpsTracker.lastWindowMin = fpsTracker.windowMin;
    fpsTracker.windowMin = Infinity;
    fpsTracker.windowStart = now;
  }
}

async function sampleHeap(force = false) {
  const now = performance.now();
  if (!force && (heapSampler.sampling || now - heapSampler.lastSample < 1500)) return;
  heapSampler.sampling = true;
  try {
    const perf = performance as PerformanceWithMemory;
    if (typeof perf.measureUserAgentSpecificMemory === 'function') {
      const result = await perf.measureUserAgentSpecificMemory();
      const toMB = (bytes: number) => bytes / (1024 * 1024);
      heapSampler.snapshot = {
        available: true,
        usedMB: toMB(result.bytes)
      };
    } else if (perf.memory) {
      const { usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit } = perf.memory;
      const toMB = (bytes: number) => bytes / (1024 * 1024);
      heapSampler.snapshot = {
        available: true,
        usedMB: toMB(usedJSHeapSize),
        allocatedMB: toMB(totalJSHeapSize),
        limitMB: toMB(jsHeapSizeLimit)
      };
    } else {
      heapSampler.snapshot = {
        available: false,
        reason: 'Browser hides JS heap. Try Chrome or enable Firefox memory prefs.'
      };
    }
  } catch (err) {
    console.error('Heap sample failed', err);
    heapSampler.snapshot = {
      available: false,
      reason: 'Memory probe failed. See console.'
    };
  } finally {
    heapSampler.lastSample = performance.now();
    heapSampler.sampling = false;
  }
}

function getHeapSnapshot() {
  void sampleHeap();
  return heapSampler.snapshot;
}

interface DebugOverlayOptions {
  root: HTMLElement;
  toggleBtn: HTMLButtonElement;
  copyBtn: HTMLButtonElement;
  getState: () => GameState;
}

export function initDebugOverlay(options: DebugOverlayOptions) {
  const { root, toggleBtn, copyBtn, getState } = options;
  const overlay = document.createElement('div');
  overlay.id = 'debug-overlay';
  overlay.className = 'debug-overlay hidden';
  root.appendChild(overlay);
  // The overlay lives inside canvas-wrapper (for positioning), whose delegated
  // pointerdown handler treats any tap as a map interaction regardless of
  // target — stop it here so tapping the overlay doesn't also paint/inspect
  // the tile underneath. Matches minimap.ts/hud.ts's existing overlay guard.
  // The overlay sits inside `#canvas-wrapper`, whose delegated handlers treat
  // any pointer activity as map interaction regardless of target — so every
  // event that can *start or continue* a map action has to stop here, or the
  // panel paints, bulldozes and pans the tiles it is covering.
  //
  // `pointerdown` alone was not enough. Press on the map, drag across the
  // panel, and `pointermove` kept painting the hidden tiles underneath;
  // `contextmenu` still reached the wrapper's quick-bulldoze; and a `wheel`
  // over the panel zoomed the map out from under it.
  //
  // **`pointerup` and `pointercancel` are deliberately absent from this list.**
  // They are bound on both `wrapper` and `window` (see `stopPainting` in
  // `main.ts`) precisely so a drag can always end, whatever it ends over.
  // `stopPropagation` on the overlay would stop the event bubbling to *either*,
  // leaving `isPainting` stuck on and the next mouse move painting a stripe
  // across the map. Letting them through is the whole point: they only ever
  // finish an interaction, never begin one.
  for (const type of ['pointerdown', 'pointermove', 'click', 'dblclick', 'contextmenu'] as const) {
    overlay.addEventListener(type, (e) => e.stopPropagation());
  }
  overlay.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

  // Kept as stable, persistent elements rather than part of the per-frame
  // innerHTML rebuild below — recreating an interactive button every frame
  // makes it a moving target for a real tap (the element can be swapped out
  // mid-gesture), not just an automated-test flakiness risk.
  const modeToggleBtn = document.createElement('button');
  modeToggleBtn.type = 'button';
  modeToggleBtn.className = 'debug-mode-toggle';
  overlay.appendChild(modeToggleBtn);
  const contentEl = document.createElement('div');
  contentEl.className = 'debug-content';
  overlay.appendChild(contentEl);

  let visible = false;
  // Mini defaults on phone-sized viewports (matches the same breakpoint every
  // other compact-mode CSS override in this codebase uses) — the full,
  // everything-included panel is the original desktop-oriented view, sized
  // for a mouse+keyboard session where it never needed to compete with the
  // map for screen space the way it does on a phone.
  const compactQuery = window.matchMedia(
    `(max-width: ${DEFAULT_COMPACT_BREAKPOINT_PX}px), (max-height: ${DEFAULT_COMPACT_HEIGHT_BREAKPOINT_PX}px)`
  );
  let mode: DebugOverlayMode = compactQuery.matches ? 'mini' : 'full';

  /**
   * Which build is actually running — the app bundle and the engine binary,
   * separately, because they are built by different commands and go stale
   * independently.
   *
   * The load-bearing row is **Engine**: a WASM module is instantiated once and
   * lives for the tab's lifetime, so `bun run build:wasm` does nothing to an
   * open page and no amount of reloading the *source* helps. When the binary on
   * disk is newer than this page, the panel says so in as many words.
   */
  const buildSection = () => {
    const b = getBuildInfo();
    const stale = isEngineStale(b);
    const clock = (iso: string | null) =>
      iso ? new Date(iso).toLocaleTimeString(undefined, { hour12: false }) : '—';
    const staleRow =
      stale === true
        ? `<div class="debug-hint debug-warn">Engine is STALE — the WASM on disk is newer than this page. Reload.</div>`
        : stale === null
          ? `<div class="debug-hint">Engine freshness unknown (no build timestamp).</div>`
          : '';
    return `
    <div class="debug-section">
      <div class="debug-heading">Build</div>
      <div class="debug-row"><span>App</span><strong>${b.sha}</strong></div>
      <div class="debug-hint">Bundle built ${clock(b.builtAt)} · page loaded ${clock(b.pageLoadedAt)}</div>
      <div class="debug-row"><span>Engine</span><strong>${b.engineVersion ?? '—'}</strong></div>
      <div class="debug-hint">WASM built ${clock(b.wasmLastModified ?? b.wasmBuiltAtBundleTime)}</div>
      ${staleRow}
    </div>`;
  };

  const perfAndMemorySections = (heap: HeapSnapshot) => `
    <div class="debug-section">
      <div class="debug-heading">Performance</div>
      <div class="debug-row"><span>FPS</span><strong>${fpsTracker.ema.toFixed(0)}</strong></div>
      <div class="debug-hint">Min last 5s: ${
        fpsTracker.lastWindowMin === null ? '—' : fpsTracker.lastWindowMin.toFixed(0)
      }</div>
    </div>
    <div class="debug-section">
      <div class="debug-heading">Memory</div>
      ${
        heap.available
          ? `
        <div class="debug-row"><span>JS heap</span><strong>${heap.usedMB?.toFixed(1)}${
             heap.limitMB ? ` / ${heap.limitMB.toFixed(0)}` : ''
           } MB</strong></div>
        ${
          heap.allocatedMB
            ? `<div class="debug-hint">Allocated ${heap.allocatedMB.toFixed(0)} MB</div>`
            : ''
        }
      `
          : `<div class="debug-row"><span>Status</span><strong>${heap.reason}</strong></div>`
      }
    </div>
  `;

  const renderStats = (state: GameState) => {
    if (!visible) return;
    modeToggleBtn.textContent = mode === 'mini' ? '⤢ Full' : '⤡ Mini';
    try {
      const heap = getHeapSnapshot();

      if (mode === 'mini') {
        contentEl.innerHTML = perfAndMemorySections(heap);
        return;
      }

      const stats = getSimulationDebugStats(state);
      const calendar = getCalendarPosition(stats.day);
      const totalDays = Math.floor(stats.day);
      const formatDemandHint = (details: DemandDetails) =>
        details.seeded
          ? 'Starter seed'
          : `${details.base}×(1 - fill ${Math.round(details.fillFraction * 100)}%) = ${details.fillTerm.toFixed(
              1
            )}, workforce term ${details.workforceTerm.toFixed(1)}, labour term ${details.labourTerm.toFixed(
              1
            )}, pending ${details.pendingZones} → -${details.pendingPenaltyApplied.toFixed(
              1
            )} (cap ${details.pendingPenaltyCapped.toFixed(1)}, relief ${details.pressureRelief.toFixed(
              1
            )})${details.floorApplied ? ', floor active' : ''}${
              details.utilityPenalty ? `, power penalty -${details.utilityPenalty.toFixed(1)}` : ''
            }`;

      contentEl.innerHTML = `
        <div class="debug-section">
          <div class="debug-heading">Tick ${stats.tick} • Day ${totalDays} (Month ${calendar.month}, Day ${calendar.dayOfMonth}/${DAYS_PER_MONTH})</div>
          <div class="debug-row"><span>Population</span><strong>${Math.floor(stats.population)} / ${Math.floor(stats.capacities.population)}</strong></div>
          <div class="debug-row"><span>Jobs</span><strong>${Math.floor(stats.jobs)} / ${Math.floor(stats.capacities.jobs)}</strong></div>
          <div class="debug-row"><span>Workers</span><strong>${stats.labour.employed.toFixed(
            0
          )} / ${stats.labour.workers.toFixed(0)}</strong></div>
          <div class="debug-hint">Unemployment ${(stats.labour.unemploymentRate * 100).toFixed(
            1
          )}% • Vacancy ${(stats.labour.vacancyRate * 100).toFixed(1)}% • Job cap ${stats.labour.jobCapacity.toFixed(0)}</div>
        </div>
        <div class="debug-section">
          <div class="debug-heading">Zones</div>
          <div class="debug-row"><span>Residential</span><strong>${stats.zones.residential}</strong></div>
          <div class="debug-row"><span>Commercial</span><strong>${stats.zones.commercial}</strong></div>
          <div class="debug-row"><span>Industrial</span><strong>${stats.zones.industrial}</strong></div>
        </div>
        <div class="debug-section">
          <div class="debug-heading">Education</div>
          <div class="debug-row"><span>Score</span><strong>${(stats.education.score * 100).toFixed(0)}%</strong></div>
          <div class="debug-row"><span>Elementary</span><strong>${(stats.education.elementaryCoverage * 100).toFixed(0)}%</strong></div>
          <div class="debug-row"><span>High School</span><strong>${(stats.education.highCoverage * 100).toFixed(0)}%</strong></div>
        </div>
        <div class="debug-section">
          <div class="debug-heading">Demand</div>
          <div class="debug-hint">Over-zoning penalty: ${state.settings?.pendingPenaltyEnabled ?? true ? 'On' : 'Off'}</div>
          <div class="debug-row"><span>Residential</span><strong>${stats.demand.residential.toFixed(1)}%</strong></div>
          <div class="debug-hint">${formatDemandHint(stats.demandDetails.residential)}</div>
          <div class="debug-row"><span>Commercial</span><strong>${stats.demand.commercial.toFixed(1)}%</strong></div>
          <div class="debug-hint">${formatDemandHint(stats.demandDetails.commercial)}</div>
          <div class="debug-row"><span>Industrial</span><strong>${stats.demand.industrial.toFixed(1)}%</strong></div>
          <div class="debug-hint">${formatDemandHint(stats.demandDetails.industrial)}</div>
        </div>
        <div class="debug-section">
          <div class="debug-heading">Utilities</div>
          <div class="debug-row"><span>Power</span><strong>${stats.utilities.powerProduced.toFixed(
            1
          )} prod / ${stats.utilities.powerUsed.toFixed(1)} use</strong></div>
          <div class="debug-hint">Balance ${stats.utilities.powerBalance.toFixed(1)} MW</div>
          <div class="debug-row"><span>Water</span><strong>${stats.utilities.waterOutput.toFixed(
            1
          )} out / ${stats.utilities.waterUse.toFixed(1)} use</strong></div>
          <div class="debug-hint">Balance ${stats.utilities.waterBalance.toFixed(1)} m³</div>
        </div>
        ${perfAndMemorySections(heap)}
        ${buildSection()}
      `;
    } catch (err) {
      console.error('Debug overlay render failed', err);
      contentEl.innerHTML = `<div class="debug-section"><div class="debug-heading">Debug overlay</div><div class="debug-row"><span>Status</span><strong>Render error</strong></div><div class="debug-hint">${(err as Error)?.message ?? err}</div></div>`;
    }
  };

  modeToggleBtn.addEventListener('click', () => {
    mode = mode === 'mini' ? 'full' : 'mini';
    overlay.classList.toggle('mode-mini', mode === 'mini');
    renderStats(getState());
  });
  overlay.classList.toggle('mode-mini', mode === 'mini');

  toggleBtn.addEventListener('click', () => {
    visible = !visible;
    overlay.classList.toggle('hidden', !visible);
    overlay.classList.toggle('visible', visible);
    toggleBtn.textContent = visible ? 'Hide overlay' : 'Show overlay';
    if (visible) void sampleHeap(true);
    renderStats(getState());
  });

  copyBtn.addEventListener('click', async () => {
    const snapshot = getState();
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
      showToast('Copied debug snapshot');
    } catch (err) {
      console.error('Clipboard unavailable', err);
      showToast('Clipboard blocked');
    }
  });

  return {
    update(state: GameState) {
      renderStats(state);
    },
    recordFrame
  };
}
