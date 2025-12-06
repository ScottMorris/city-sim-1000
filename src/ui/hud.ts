import { BuildingStatus, getBuildingTemplate } from '../game/buildings';
import { GameState, getTile } from '../game/gameState';
import { Position } from '../rendering/renderer';
import { Tool } from '../game/toolTypes';
import { getToolDetails } from './toolInfo';
import { DAYS_PER_MONTH, getCalendarPosition } from '../game/time';
import { ServiceId } from '../game/services';

export interface HudElements {
  moneyEl: HTMLElement;
  budgetNetEl: HTMLElement;
  powerEl: HTMLElement;
  waterEl: HTMLElement;
  resBar: HTMLElement;
  comBar: HTMLElement;
  indBar: HTMLElement;
  popEl: HTMLElement;
  jobsEl: HTMLElement;
  monthEl: HTMLElement;
  dayEl: HTMLElement;
  overlayRoot: HTMLElement;
}

export function createHud(elements: HudElements) {
  let overlayContainer: HTMLDivElement | null = null;
  let toolInfoPinned = false;
  let overlayFrozen = false;

  const ensureOverlayContainer = () => {
    if (!overlayContainer) {
      overlayContainer = document.createElement('div');
      overlayContainer.className = 'overlay';
      // Prevent overlay clicks from triggering canvas interactions.
      overlayContainer.addEventListener('pointerdown', (e) => {
        overlayFrozen = true;
        e.stopPropagation();
      });
      overlayContainer.addEventListener('pointerup', () => {
        overlayFrozen = false;
      });
      overlayContainer.addEventListener('pointerleave', () => {
        overlayFrozen = false;
      });
      overlayContainer.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
      elements.overlayRoot.appendChild(overlayContainer);
    }
  };

  const cleanupOverlayContainer = () => {
    if (overlayContainer && overlayContainer.childElementCount === 0) {
      overlayContainer.remove();
      overlayContainer = null;
      overlayFrozen = false;
    }
  };

  const update = (state: GameState) => {
    elements.moneyEl.textContent = `$${Math.floor(state.money).toLocaleString()}`;
    const net = state.budget?.netPerMonth ?? 0;
    const netClass = net > 0 ? 'positive' : net < 0 ? 'negative' : 'neutral';
    const netPrefix = net > 0 ? '+$' : net < 0 ? '-$' : '$';
    elements.budgetNetEl.textContent = `${netPrefix}${Math.round(Math.abs(net)).toLocaleString()} / month`;
    elements.budgetNetEl.className = `budget-net ${netClass}`;
    elements.powerEl.textContent = `⚡ ${state.utilities.power.toFixed(1)} MW`;
    elements.waterEl.textContent = `💧 ${state.utilities.water.toFixed(1)} m³`;
    elements.resBar.style.width = `${state.demand.residential}%`;
    elements.comBar.style.width = `${state.demand.commercial}%`;
    elements.indBar.style.width = `${state.demand.industrial}%`;
    elements.popEl.textContent = `Population ${Math.floor(state.population)}`;
    elements.jobsEl.textContent = `Jobs ${Math.floor(state.jobs)}`;
    const calendar = getCalendarPosition(state.day);
    elements.monthEl.textContent = `Month ${calendar.month}`;
    elements.dayEl.textContent = `Day ${calendar.dayOfMonth} of ${DAYS_PER_MONTH}`;
  };

  const renderOverlays = (state: GameState, selected: Position | null, activeTool: Tool) => {
    if (overlayFrozen) return;
    const hasTileSelection = activeTool === Tool.Inspect && selected ? getTile(state, selected.x, selected.y) : null;
    const showToolInfo = toolInfoPinned || activeTool !== Tool.Inspect;

    if (!showToolInfo && !hasTileSelection) {
      overlayContainer?.remove();
      overlayContainer = null;
      return;
    }

    ensureOverlayContainer();
    const infoBox = overlayContainer?.querySelector<HTMLDivElement>('.info-box') ?? document.createElement('div');

    const toolSection = showToolInfo
      ? (() => {
          const details = getToolDetails(activeTool);
          const rowsHtml = details.rows
            .map((row) => `<div class="status-line"><span>${row.label}</span><strong>${row.value}</strong></div>`)
            .join('');
          const hintsHtml =
            details.hints.length > 0
              ? `<div class="tool-hints">${details.hints.map((hint) => `<div>${hint}</div>`).join('')}</div>`
              : '';
          const pinLabel = toolInfoPinned ? '📌 Pinned' : '📍 Pin';
          return `
            <div class="info-section">
              <div class="info-header">
                <div class="info-title">
                  <div class="info-label">Tool</div>
                  <div class="info-name">${details.name}</div>
                  <div class="info-meta">${details.hotkey ? `Hotkey: ${details.hotkey}` : 'Select a tool'}</div>
                </div>
                <button class="chip-button ${toolInfoPinned ? 'active' : ''}" data-pin="true">${pinLabel}</button>
              </div>
              <div class="tool-rows">
                ${rowsHtml}
              </div>
              ${hintsHtml}
              ${
                details.unavailable
                  ? `<div class="tool-hints warning">Coming soon: pipes and underground view.</div>`
                  : '<div class="tool-hints subtle">Press Esc to cancel the active tool.</div>'
              }
            </div>
          `;
        })()
      : '';

    const tileSection =
      hasTileSelection && selected
        ? (() => {
            const building =
              hasTileSelection.buildingId !== undefined
                ? state.buildings.find((b) => b.id === hasTileSelection.buildingId)
                : undefined;
            const template = building ? getBuildingTemplate(building.templateId) : undefined;
            const buildingStatus = building
              ? building.state.status
              : template?.requiresPower === false || hasTileSelection.powered
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
            const buildingBlock =
              building || template
                ? `<div class="info-subtitle">Building</div>
              <div class="status-line"><span>Name</span><strong>${template?.name ?? 'Unknown'}</strong></div>
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
                : '';
            const educationServed =
              hasTileSelection.services?.served[ServiceId.EducationElementary] ||
              hasTileSelection.services?.served[ServiceId.EducationHigh];
            const educationScore = Math.max(
              hasTileSelection.services?.scores[ServiceId.EducationElementary] ?? 0,
              hasTileSelection.services?.scores[ServiceId.EducationHigh] ?? 0
            );
            const educationLine =
              educationServed || educationScore > 0
                ? `<div class="status-line"><span>Education</span><strong>${educationServed ? 'Served' : 'Underserved'}${educationScore > 0 ? ` • ${(educationScore * 100).toFixed(0)}%` : ''}</strong></div>`
                : '';
            const serviceBlock =
              educationLine || (template?.service && building)
                ? `<div class="info-subtitle">Services</div>
                    ${educationLine}
                    ${
                      template?.service && building?.state.serviceLoad?.slotsUsed[template.service.id] !== undefined
                        ? `<div class="status-line"><span>${template.name} load</span><strong>${building.state.serviceLoad.slotsUsed[template.service.id]} / ${template.service.capacity}</strong></div>`
                        : ''
                    }`
                : '';

            return `
              <div class="info-section">
                <div class="info-title">
                  <div class="info-label">Tile</div>
                  <div class="info-name">${selected.x},${selected.y}</div>
                </div>
                <div class="status-line"><span>Type</span><strong>${hasTileSelection.kind}</strong></div>
                <div class="status-line"><span>Happy</span><strong>${hasTileSelection.happiness.toFixed(2)}</strong></div>
                <div class="status-line"><span>Power</span><strong>${hasTileSelection.powered ? 'On' : 'Off'}</strong></div>
                ${educationLine ? educationLine : ''}
                ${buildingBlock ? `<div class="divider"></div>${buildingBlock}` : ''}
                ${serviceBlock ? `<div class="divider"></div>${serviceBlock}` : ''}
                <div class="map-stats">Utilities are modeled globally; keep power and water above zero to grow.</div>
              </div>
            `;
          })()
        : '';

    if (!infoBox.parentElement) {
      overlayContainer?.appendChild(infoBox);
    }

    const unavailableClass =
      showToolInfo && getToolDetails(activeTool).unavailable ? ' muted' : '';
    infoBox.className = `info-box${unavailableClass}`;
    infoBox.innerHTML = `
      ${toolSection}
      ${toolSection && tileSection ? '<div class="divider"></div>' : ''}
      ${tileSection}
    `;

    const pinButton = infoBox.querySelector<HTMLButtonElement>('button[data-pin="true"]');
    pinButton?.addEventListener('click', () => {
      toolInfoPinned = !toolInfoPinned;
      renderOverlays(state, selected, activeTool);
    });

    cleanupOverlayContainer();
  };

  return { update, renderOverlays };
}
