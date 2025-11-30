import { getSimulationDebugStats } from '../game/debugStats';
import { GameState } from '../game/gameState';
import { showToast } from './dialogs';

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

    overlay.innerHTML = `
      <div class="debug-section">
        <div class="debug-heading">Tick ${stats.tick} • Day ${Math.floor(stats.day)}</div>
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
        <div class="debug-row"><span>Residential</span><strong>${stats.demand.residential.toFixed(1)}%</strong></div>
        <div class="debug-hint">60 - 2x${stats.zones.residential} + max(0, jobs - pop = ${Math.max(
          0,
          Math.floor(stats.jobs - stats.population)
        )}) ${stats.demandDetails.residential.utilityPenalty ? `- penalty ${stats.demandDetails.residential.utilityPenalty}` : ''}</div>
        <div class="debug-row"><span>Commercial</span><strong>${stats.demand.commercial.toFixed(1)}%</strong></div>
        <div class="debug-hint">50 - 3x${stats.zones.commercial} + pop*0.2 = ${stats.demandDetails.commercial.final.toFixed(1)}</div>
        <div class="debug-row"><span>Industrial</span><strong>${stats.demand.industrial.toFixed(1)}%</strong></div>
        <div class="debug-hint">50 - 3x${stats.zones.industrial} + pop*0.15 = ${stats.demandDetails.industrial.final.toFixed(1)}</div>
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
    `;
  };

  toggleBtn.addEventListener('click', () => {
    visible = !visible;
    overlay.classList.toggle('hidden', !visible);
    overlay.classList.toggle('visible', visible);
    toggleBtn.textContent = visible ? 'Hide overlay' : 'Show overlay';
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
