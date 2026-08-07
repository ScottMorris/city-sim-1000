// hud.ts — live top-bar ribbon values and the tool/tile info overlay.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { BuildingStatus } from '../game/buildings/state';
import { getBuildingTemplate } from '../game/buildings/templates';
import { GameState, getTile, ViewStratum } from '../game/gameState';
import { Terrain } from '../game/protocol/occupants';
import { occupantsByStratum } from '../game/protocol/tileLabel';
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
  wildernessEl: HTMLElement;
  wildernessChip: HTMLElement;
  stratumBadge: HTMLElement;
  overlayRoot: HTMLElement;
}

/** Human labels for the wilderness breakdown categories, tooltip order. */
const WILDERNESS_LABELS: [keyof import('../game/gameState').WildernessBreakdown, string][] = [
  ['forests', 'Forests'],
  ['parks', 'Parks'],
  ['openLand', 'Open land'],
  ['waterEdge', 'Water edge'],
  ['patch', 'Patch bonus'],
  ['fragmentation', 'Fragmentation'],
  ['zones', 'Zoning'],
  ['industry', 'Industry'],
  ['transport', 'Roads & rail'],
  ['power', 'Power'],
  ['civic', 'Civic']
];

export type ToolInfoMode = 'auto' | 'forced' | 'hidden';

export function createHud(elements: HudElements) {
  let overlayContainer: HTMLDivElement | null = null;
  let toolInfoPinned = false;
  let overlayFrozen = false;
  // In compact layout the tool-info card and the tile inspector share one
  // small floating panel (tabbed) instead of each getting their own. Desktop
  // ('auto') keeps the original pin-vs-Inspect precedence; compact mode
  // instead has its own dedicated "Tool" tab (see main.ts's
  // compactInfoTabs), so while that tab is open the card must show
  // unconditionally ('forced') — the Inspect precedence doesn't apply, since
  // the tabs already give Inspect its own separate home. While any other
  // compact tab is open the card is fully hidden ('hidden') so the shared
  // panel is free for the minimap/tile inspector instead.
  let toolInfoMode: ToolInfoMode = 'auto';
  // Tile-inspect results (tap a tile with the Inspect tool) previously
  // showed whenever that tool was active with a selection, regardless of
  // which compact tab was open — so they'd leak into the "Tool" tab too,
  // since activeTool being Tool.Inspect has nothing to do with which tab
  // the player tapped. Mirrors toolInfoMode: 'hidden' on any compact tab
  // other than "Inspect" itself; 'auto'/'forced' both just mean "show it if
  // there's actually a selection" — there's no pin-style precedence to
  // choose between for tile results the way there is for the tool card.
  let tileInspectMode: ToolInfoMode = 'auto';

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

  const update = (state: GameState, stratum: ViewStratum) => {
    // A loud, always-on badge — not tucked inside the (pinnable/hideable)
    // tool-info card — since the active stratum determines what the
    // bulldozer destroys. Timberborn's players demolishing the wrong layer
    // while a view mode was active, with no on-screen warning, is the
    // cautionary tale (see docs/features/view-layers.md).
    elements.stratumBadge.classList.toggle('stratum-badge-hidden', stratum !== 'underground');
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
    const population = Math.floor(state.population).toLocaleString();
    const jobs = Math.floor(state.jobs).toLocaleString();
    elements.popEl.textContent = `👥 ${population}`;
    elements.popEl.title = `Population ${population}`;
    elements.jobsEl.textContent = `💼 ${jobs}`;
    elements.jobsEl.title = `Jobs ${jobs}`;
    const calendar = getCalendarPosition(state.day);
    elements.monthEl.textContent = `Month ${calendar.month}`;
    elements.dayEl.textContent = `Day ${calendar.dayOfMonth}/${DAYS_PER_MONTH}`;

    const wild = state.wilderness;
    const arrow = wild.trend > 0.5 ? '↑' : wild.trend < -0.5 ? '↓' : '→';
    elements.wildernessEl.textContent = `🌲 ${Math.round(wild.score)} ${arrow}`;
    // Tooltip: the strongest contributors, positive or negative, largest first.
    const contributors = WILDERNESS_LABELS
      .map(([key, label]) => ({ label, value: wild.breakdown[key] }))
      .filter((c) => Math.abs(c.value) >= 0.5)
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, 6)
      .map((c) => `${c.label} ${c.value > 0 ? '+' : '−'}${Math.abs(Math.round(c.value))}`)
      .join(' · ');
    elements.wildernessChip.title = contributors
      ? `Wilderness ${Math.round(wild.score)}/100 — ${contributors}`
      : 'Wilderness score — how much of the map is thriving nature';
  };

  const renderOverlays = (state: GameState, selected: Position | null, activeTool: Tool) => {
    if (overlayFrozen) return;
    const hasTileSelection =
      tileInspectMode !== 'hidden' && activeTool === Tool.Inspect && selected
        ? getTile(state, selected.x, selected.y)
        : null;
    const showToolInfo =
      toolInfoMode === 'forced' ? true :
      toolInfoMode === 'hidden' ? false :
      (toolInfoPinned || activeTool !== Tool.Inspect);

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
              <div class="tool-hints subtle">Press Esc to cancel the active tool.</div>
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
                  : buildingStatus === BuildingStatus.InactiveNoWater
                    ? 'No Water'
                    : buildingStatus === BuildingStatus.InactiveNoSource
                      ? 'No Water Source — build next to water'
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

            // Per-stratum listing rather than a single collapsed "Type" label
            // (the old `dominantOccupantLabel`) — a tile can carry, say, a
            // road on the surface and a power line overhead at once, and the
            // old single line only ever showed the winner. `Terrain` is
            // always shown; each stratum line only appears once it has
            // something to say.
            const terrainLabel = hasTileSelection.terrain === Terrain.Water ? 'water' : 'land';
            const strata = occupantsByStratum(state, hasTileSelection);
            const strataLines = (
              [
                ['Under', strata.underground],
                ['Surface', strata.surface],
                ['Overhead', strata.overhead]
              ] as const
            )
              .filter(([, values]) => values.length > 0)
              .map(([label, values]) => `<div class="status-line"><span>${label}</span><strong>${values.join(' · ')}</strong></div>`)
              .join('');

            return `
              <div class="info-section">
                <div class="info-title">
                  <div class="info-label">Tile</div>
                  <div class="info-name">${selected.x},${selected.y}</div>
                </div>
                <div class="status-line"><span>Terrain</span><strong>${terrainLabel}</strong></div>
                ${strataLines}
                <div class="status-line"><span>Happy</span><strong>${hasTileSelection.happiness.toFixed(2)}</strong></div>
                <div class="status-line"><span>Power</span><strong>${hasTileSelection.powered ? 'On' : 'Off'}</strong></div>
                <div class="status-line"><span>Water</span><strong>${hasTileSelection.watered ? 'Wet' : 'Dry'}</strong></div>
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

    infoBox.className = 'info-box';
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

  const setToolInfoMode = (mode: ToolInfoMode) => {
    toolInfoMode = mode;
  };

  const setTileInspectMode = (mode: ToolInfoMode) => {
    tileInspectMode = mode;
  };

  return { update, renderOverlays, setToolInfoMode, setTileInspectMode };
}
