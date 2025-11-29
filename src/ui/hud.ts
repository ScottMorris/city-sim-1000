import { GameState, getTile } from '../game/gameState';
import { Position } from '../rendering/renderer';

export interface HudElements {
  moneyEl: HTMLElement;
  powerEl: HTMLElement;
  waterEl: HTMLElement;
  resBar: HTMLElement;
  comBar: HTMLElement;
  indBar: HTMLElement;
  popEl: HTMLElement;
  jobsEl: HTMLElement;
  dayEl: HTMLElement;
  overlayRoot: HTMLElement;
}

export function createHud(elements: HudElements) {
  let overlayDiv: HTMLDivElement | null = null;

  const update = (state: GameState) => {
    elements.moneyEl.textContent = `$${Math.floor(state.money).toLocaleString()}`;
    elements.powerEl.textContent = `⚡ ${state.utilities.power.toFixed(1)} MW`;
    elements.waterEl.textContent = `💧 ${state.utilities.water.toFixed(1)} m³`;
    elements.resBar.style.width = `${state.demand.residential}%`;
    elements.comBar.style.width = `${state.demand.commercial}%`;
    elements.indBar.style.width = `${state.demand.industrial}%`;
    elements.popEl.textContent = `Population ${Math.floor(state.population)}`;
    elements.jobsEl.textContent = `Jobs ${Math.floor(state.jobs)}`;
    elements.dayEl.textContent = `Day ${Math.floor(state.day)}`;
  };

  const renderSelectionInfo = (state: GameState, selected: Position | null) => {
    if (!selected) {
      overlayDiv?.remove();
      overlayDiv = null;
      return;
    }
    const tile = getTile(state, selected.x, selected.y);
    if (!tile) return;
    if (!overlayDiv) {
      overlayDiv = document.createElement('div');
      overlayDiv.className = 'overlay';
      elements.overlayRoot.appendChild(overlayDiv);
    }
    overlayDiv.innerHTML = `
      <div class="info-box">
        <div class="status-line"><span>Tile</span><strong>${selected.x},${selected.y}</strong></div>
        <div class="status-line"><span>Type</span><strong>${tile.kind}</strong></div>
        <div class="status-line"><span>Happy</span><strong>${tile.happiness.toFixed(2)}</strong></div>
        <div class="map-stats">Utilities are modeled globally; keep power and water above zero to grow.</div>
      </div>
    `;
  };

  return { update, renderSelectionInfo };
}
