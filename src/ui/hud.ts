import { GameState, getTile } from '../game/gameState';
import { BuildingStatus, getBuildingTemplate } from '../game/buildings';
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
    const building =
      tile.buildingId !== undefined
        ? state.buildings.find((b) => b.id === tile.buildingId)
        : undefined;
    const template = building ? getBuildingTemplate(building.templateId) : undefined;
    const buildingStatus = building
      ? building.state.status
      : template?.requiresPower === false || tile.powered
        ? BuildingStatus.Active
        : BuildingStatus.InactiveNoPower;
    const statusLabel =
      buildingStatus === BuildingStatus.Active
        ? 'Active'
        : buildingStatus === BuildingStatus.InactiveNoPower
          ? 'No Power'
          : 'Damaged';
    const powerUse =
      template && template.powerUse !== undefined ? `${template.powerUse.toFixed(1)} MW` : null;
    const waterUse =
      template && template.waterUse !== undefined ? `${template.waterUse.toFixed(1)} m³` : null;
    const waterOut =
      template && template.waterOutput !== undefined
        ? `${template.waterOutput.toFixed(1)} m³`
        : null;
    const popCap =
      template && template.populationCapacity !== undefined
        ? `${template.populationCapacity} pop cap`
        : null;
    const jobCap =
      template && template.jobsCapacity !== undefined ? `${template.jobsCapacity} jobs cap` : null;
    const maintenance =
      template && template.maintenance !== undefined
        ? `$${template.maintenance.toLocaleString()} / day`
        : null;
    overlayDiv.innerHTML = `
      <div class="info-box">
        <div class="status-line"><span>Tile</span><strong>${selected.x},${selected.y}</strong></div>
        <div class="status-line"><span>Type</span><strong>${tile.kind}</strong></div>
        <div class="status-line"><span>Happy</span><strong>${tile.happiness.toFixed(2)}</strong></div>
        <div class="status-line"><span>Power</span><strong>${tile.powered ? 'On' : 'Off'}</strong></div>
        ${
          building || template
            ? `<div class="divider"></div>
        <div class="status-line"><span>Building</span><strong>${template?.name ?? 'Unknown'}</strong></div>
        <div class="status-line"><span>Status</span><strong>${statusLabel}</strong></div>
        ${
          maintenance
            ? `<div class="status-line"><span>Maintenance</span><strong>${maintenance}</strong></div>`
            : ''
        }
        ${
          powerUse || waterUse || waterOut
            ? `<div class="status-line"><span>Utilities</span><strong>${[
                powerUse && `⚡ ${powerUse}`,
                waterUse && `💧 ${waterUse}`,
                waterOut && `↥ ${waterOut}`
              ]
                .filter(Boolean)
                .join(' • ')}</strong></div>`
            : ''
        }
        ${
          popCap || jobCap
            ? `<div class="status-line"><span>Capacity</span><strong>${[popCap, jobCap]
                .filter(Boolean)
                .join(' • ')}</strong></div>`
            : ''
        }`
            : ''
        }
        <div class="map-stats">Utilities are modeled globally; keep power and water above zero to grow.</div>
      </div>
    `;
  };

  return { update, renderSelectionInfo };
}
