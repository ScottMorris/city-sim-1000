import { getSimulationDebugStats } from '../game/debugStats';
import { GameState } from '../game/gameState';
import { DAYS_PER_MONTH, getCalendarPosition } from '../game/time';
import { showToast } from './dialogs';

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

  let visible = false;

  const renderStats = (state: GameState) => {
    if (!visible) return;
    const stats = getSimulationDebugStats(state);
    const heap = getHeapSnapshot();
    const calendar = getCalendarPosition(stats.day);
    const totalDays = Math.floor(stats.day);

    overlay.innerHTML = `
      <div class="debug-section">
        <div class="debug-heading">Tick ${stats.tick} • Day ${totalDays} (Month ${calendar.month}, Day ${calendar.dayOfMonth}/${DAYS_PER_MONTH})</div>
        <div class="debug-row"><span>Population</span><strong>${Math.floor(stats.population)} / ${Math.floor(stats.capacities.population)}</strong></div>
        <div class="debug-row"><span>Jobs</span><strong>${Math.floor(stats.jobs)} / ${Math.floor(stats.capacities.jobs)}</strong></div>
      </div>
      <div class="debug-section">
        <div class="debug-heading">Zones</div>
        <div class="debug-row"><span>Residential</span><strong>${stats.zones.residential}</strong></div>
        <div class="debug-row"><span>Commercial</span><strong>${stats.zones.commercial}</strong></div>
        <div class="debug-row"><span>Industrial</span><strong>${stats.zones.industrial}</strong></div>
      </div>
      <div class="debug-section">
        <div class="debug-heading">Demand</div>
        <div class="debug-hint">Over-zoning penalty: ${state.settings?.pendingPenaltyEnabled ?? true ? 'On' : 'Off'}</div>
        <div class="debug-row"><span>Residential</span><strong>${stats.demand.residential.toFixed(1)}%</strong></div>
        <div class="debug-hint">${stats.demandDetails.residential.seeded ? 'Starter seed' : `${stats.demandDetails.residential.base}×(1 - fill ${Math.round(stats.demandDetails.residential.fillFraction * 100)}%) = ${stats.demandDetails.residential.fillTerm.toFixed(1)}, jobs gap term ${stats.demandDetails.residential.workforceTerm.toFixed(1)}, pending ${stats.demandDetails.residential.pendingZones} → -${stats.demandDetails.residential.pendingPenalty.toFixed(1)}${stats.demandDetails.residential.utilityPenalty ? `, power penalty -${stats.demandDetails.residential.utilityPenalty}` : ''}`}</div>
        <div class="debug-row"><span>Commercial</span><strong>${stats.demand.commercial.toFixed(1)}%</strong></div>
        <div class="debug-hint">${stats.demandDetails.commercial.seeded ? 'Starter seed' : `${stats.demandDetails.commercial.base}×(1 - fill ${Math.round(stats.demandDetails.commercial.fillFraction * 100)}%) = ${stats.demandDetails.commercial.fillTerm.toFixed(1)}, workforce gap ${stats.demandDetails.commercial.workforceTerm.toFixed(1)}, pending ${stats.demandDetails.commercial.pendingZones} → -${stats.demandDetails.commercial.pendingPenalty.toFixed(1)}${stats.demandDetails.commercial.utilityPenalty ? `, power penalty -${stats.demandDetails.commercial.utilityPenalty.toFixed(1)}` : ''}`}</div>
        <div class="debug-row"><span>Industrial</span><strong>${stats.demand.industrial.toFixed(1)}%</strong></div>
        <div class="debug-hint">${stats.demandDetails.industrial.seeded ? 'Starter seed' : `${stats.demandDetails.industrial.base}×(1 - fill ${Math.round(stats.demandDetails.industrial.fillFraction * 100)}%) = ${stats.demandDetails.industrial.fillTerm.toFixed(1)}, workforce gap ${stats.demandDetails.industrial.workforceTerm.toFixed(1)}, pending ${stats.demandDetails.industrial.pendingZones} → -${stats.demandDetails.industrial.pendingPenalty.toFixed(1)}${stats.demandDetails.industrial.utilityPenalty ? `, power penalty -${stats.demandDetails.industrial.utilityPenalty.toFixed(1)}` : ''}`}</div>
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
  };

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
    }
  };
}
