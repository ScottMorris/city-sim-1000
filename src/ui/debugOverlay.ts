import { DemandDetails, getSimulationDebugStats } from '../game/debugStats';
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
    const formatDemandHint = (details: DemandDetails) =>
      details.seeded
        ? 'Starter seed'
        : `${details.base}×(1 - fill ${Math.round(details.fillFraction * 100)}%) = ${details.fillTerm.toFixed(
            1
          )}, workforce term ${details.workforceTerm.toFixed(1)}, labour term ${details.labourTerm.toFixed(
            1
          )}, pending ${details.pendingZones} → -${details.pendingPenaltyApplied.toFixed(
            1
          )} (cap ${details.pendingPenaltyCapped.toFixed(1)}, relief ${details.pressureRelief.toFixed(1)})${
            details.floorApplied ? ', floor active' : ''
          }${
            details.utilityPenalty ? `, power penalty -${details.utilityPenalty.toFixed(1)}` : ''
          }`;

    overlay.innerHTML = `
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
