// toolbar.ts — tool palette, submenus, and the radio widget.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { Tool } from '../game/toolTypes';
import { getToolHotkey, primaryLabelOverrides, toolLabels } from './toolInfo';
import { initRadioWidget, type RadioWidget } from './radio';
import { fetchRadioStations, type RadioStation } from './radioStations';
import type { LayoutMode } from './deviceMode';

const powerOptions: Tool[] = [
  Tool.PowerLine,
  Tool.HydroPlant,
  Tool.CoalPlant,
  Tool.WindTurbine,
  Tool.SolarFarm
];

const waterOptions: Tool[] = [Tool.WaterPipe, Tool.WaterPump, Tool.WaterTower];
const educationOptions: Tool[] = [Tool.ElementarySchool, Tool.HighSchool];

// Maps a group's "representative" tool — the one shown collapsed on the full
// desktop shell, with the rest revealed via its anchored popup submenu — to
// the full set of tools in that submenu. The compact shell has no anchored
// popups (everything scrolls in one sheet), so it flattens these in place of
// the representative tool instead. Single source of truth: add a tool to
// groupedTools or one of these arrays and both shells pick it up.
const submenuSources: Partial<Record<Tool, Tool[]>> = {
  [Tool.PowerLine]: powerOptions,
  [Tool.WaterPipe]: waterOptions,
  [Tool.ElementarySchool]: educationOptions
};

interface ToolbarOptions {
  layoutMode?: LayoutMode;
  radioVolume?: number;
  radioStationId?: string;
  onRadioStationChange?: (stationId: string) => void;
}

// initToolbar can now be called more than once per page load (a live
// layoutMode flip re-runs it to rebuild the shell) — it always adds its
// document/window-level listeners fresh, so without this they'd accumulate
// one extra (harmless but leaked) copy per flip for the life of the page.
const toolbarCleanups = new WeakMap<HTMLElement, () => void>();

export interface ToolbarControllers {
  radio: RadioWidget;
  setRadioStation: (stationId?: string, opts?: { triggerChange?: boolean }) => void;
  getActiveStationId: () => string | undefined;
}

export function initToolbar(
  toolbar: HTMLElement,
  onSelect: (tool: Tool) => void,
  initial: Tool,
  options: ToolbarOptions = {}
): ToolbarControllers {
  toolbarCleanups.get(toolbar)?.();
  toolbar.innerHTML = '';
  const { layoutMode = 'full', radioVolume, radioStationId, onRadioStationChange } = options;
  toolbar.dataset.layoutMode = layoutMode;

  const groupedTools: Tool[][] = [
    [Tool.Inspect, Tool.TerraformRaise, Tool.TerraformLower, Tool.Water, Tool.Tree],
    [Tool.Road, Tool.Rail],
    [Tool.PowerLine, Tool.WaterPipe],
    [Tool.ElementarySchool],
    [Tool.Residential, Tool.Commercial, Tool.Industrial],
    [Tool.Park],
    [Tool.Bulldoze]
  ];

  const createToolButton = (key: Tool, className: string) => {
    const button = document.createElement('button');
    button.className = className;
    button.textContent = primaryLabelOverrides[key] ?? toolLabels[key];
    const hotkey = getToolHotkey(key);
    button.title = hotkey ? `${toolLabels[key]} (${hotkey})` : toolLabels[key];
    button.dataset.tool = key;
    button.addEventListener('click', () => {
      onSelect(key);
      updateToolbar(toolbar, key);
    });
    return button;
  };

  let radioHost: HTMLElement;
  let radioStationHost: HTMLElement;
  let closeSheetOnEscape: ((e: KeyboardEvent) => void) | null = null;

  if (layoutMode === 'compact') {
    // --- Compact shell: a thumb-zone current-tool button that opens a
    // bottom sheet listing every group, flattened (no anchored popups). ---
    const shell = document.createElement('div');
    shell.className = 'toolbar-compact';

    const sheetBackdrop = document.createElement('div');
    sheetBackdrop.className = 'tool-sheet-backdrop';

    const toolSheet = document.createElement('div');
    toolSheet.className = 'tool-sheet';
    toolSheet.setAttribute('role', 'dialog');
    toolSheet.setAttribute('aria-label', 'Tools');

    groupedTools.forEach((group) => {
      const groupEl = document.createElement('div');
      groupEl.className = 'tool-sheet-group';
      group.forEach((key) => {
        const expanded = submenuSources[key];
        if (expanded) {
          expanded.forEach((subKey) => groupEl.appendChild(createToolButton(subKey, 'tool-sheet-button')));
        } else {
          groupEl.appendChild(createToolButton(key, 'tool-sheet-button'));
        }
      });
      toolSheet.appendChild(groupEl);
    });

    const dock = document.createElement('div');
    dock.className = 'toolbar-compact-dock';

    const radioGroup = document.createElement('div');
    radioGroup.className = 'toolbar-group toolbar-group-radio';
    radioHost = document.createElement('div');
    radioHost.className = 'toolbar-radio-slot';
    radioStationHost = document.createElement('div');
    radioStationHost.className = 'toolbar-radio-station';
    radioGroup.append(radioHost, radioStationHost);

    const currentToolBtn = document.createElement('button');
    currentToolBtn.type = 'button';
    currentToolBtn.className = 'toolbar-current-tool-btn';
    currentToolBtn.setAttribute('aria-haspopup', 'true');
    currentToolBtn.setAttribute('aria-expanded', 'false');

    dock.append(radioGroup, currentToolBtn);
    shell.append(sheetBackdrop, toolSheet, dock);
    toolbar.appendChild(shell);

    const closeSheet = () => {
      toolSheet.classList.remove('open');
      sheetBackdrop.classList.remove('open');
      currentToolBtn.setAttribute('aria-expanded', 'false');
    };
    const openSheet = () => {
      toolSheet.classList.add('open');
      sheetBackdrop.classList.add('open');
      currentToolBtn.setAttribute('aria-expanded', 'true');
    };
    currentToolBtn.addEventListener('click', () => {
      if (toolSheet.classList.contains('open')) closeSheet();
      else openSheet();
    });
    sheetBackdrop.addEventListener('click', closeSheet);
    closeSheetOnEscape = (e) => {
      if (e.key === 'Escape') closeSheet();
    };
    document.addEventListener('keydown', closeSheetOnEscape);
  } else {
    // --- Full desktop shell: unchanged from before the compact shell. ---
    const primaryRow = document.createElement('div');
    primaryRow.className = 'toolbar-row';
    const powerRow = document.createElement('div');
    powerRow.className = 'toolbar-sub';
    powerRow.dataset.submenu = 'power';
    const waterRow = document.createElement('div');
    waterRow.className = 'toolbar-sub';
    waterRow.dataset.submenu = 'water';
    const educationRow = document.createElement('div');
    educationRow.className = 'toolbar-sub';
    educationRow.dataset.submenu = 'education';
    toolbar.appendChild(primaryRow);
    toolbar.appendChild(powerRow);
    toolbar.appendChild(waterRow);
    toolbar.appendChild(educationRow);

    groupedTools.forEach((group) => {
      const groupEl = document.createElement('div');
      groupEl.className = 'toolbar-group';
      group.forEach((key) => groupEl.appendChild(createToolButton(key, 'tool-button')));
      primaryRow.appendChild(groupEl);
    });

    const spacer = document.createElement('div');
    spacer.className = 'toolbar-spacer';
    primaryRow.appendChild(spacer);

    const trailingCluster = document.createElement('div');
    trailingCluster.className = 'toolbar-cluster';
    primaryRow.appendChild(trailingCluster);

    const radioGroup = document.createElement('div');
    radioGroup.className = 'toolbar-group toolbar-group-radio';
    radioHost = document.createElement('div');
    radioHost.className = 'toolbar-radio-slot';
    radioStationHost = document.createElement('div');
    radioStationHost.className = 'toolbar-radio-station';
    radioGroup.appendChild(radioHost);
    radioGroup.appendChild(radioStationHost);
    trailingCluster.appendChild(radioGroup);

    const createSubButton = (row: HTMLElement, key: Tool, labelOverride?: string) => {
      const button = document.createElement('button');
      button.className = 'tool-sub-button';
      button.textContent = labelOverride ?? toolLabels[key];
      const hotkey = getToolHotkey(key);
      button.title = hotkey ? `${toolLabels[key]} (${hotkey})` : toolLabels[key];
      button.dataset.tool = key;
      button.addEventListener('click', () => {
        onSelect(key);
        updateToolbar(toolbar, key);
      });
      row.appendChild(button);
    };

    powerOptions.forEach((key) => createSubButton(powerRow, key, key === Tool.PowerLine ? '⚡ Lines' : undefined));
    waterOptions.forEach((key) => createSubButton(waterRow, key, key === Tool.WaterPump ? '🚰 Pump' : undefined));
    educationOptions.forEach((key) =>
      createSubButton(educationRow, key, key === Tool.ElementarySchool ? '🎓 Elementary' : '🏢 High')
    );
  }

  const radio = initRadioWidget(radioHost, { initialVolume: radioVolume });

  const stationButton = document.createElement('button');
  stationButton.type = 'button';
  stationButton.className = 'radio-station-button';
  stationButton.textContent = '🎧';
  stationButton.title = 'Loading radio stations...';
  stationButton.setAttribute('aria-haspopup', 'true');
  stationButton.setAttribute('aria-expanded', 'false');
  stationButton.disabled = true;

  const stationMenu = document.createElement('div');
  stationMenu.className = 'radio-station-menu';
  stationMenu.setAttribute('role', 'menu');
  const stationList = document.createElement('div');
  stationList.className = 'radio-station-menu-list';
  stationMenu.appendChild(stationList);

  radioStationHost.append(stationButton, stationMenu);

  const updateStationButton = (station: RadioStation | null) => {
    if (!station) {
      stationButton.title = 'Select radio station';
      stationButton.setAttribute('aria-label', 'Select radio station');
      return;
    }
    stationButton.title = `Current station: ${station.name}`;
    stationButton.setAttribute('aria-label', `Select radio station (current: ${station.name})`);
  };

  let stations: RadioStation[] = [];
  let activeStationId: string | null = null;
  let pendingStationId: string | undefined = radioStationId;
  let manifestLoaded = false;

  const renderStationList = () => {
    stationList.innerHTML = '';
    if (!stations.length) {
      const empty = document.createElement('div');
      empty.className = 'radio-station-menu-empty';
      empty.textContent = manifestLoaded ? 'No radio stations available' : 'Loading radio stations...';
      stationList.appendChild(empty);
      return;
    }
    stations.forEach((station) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'radio-station-menu-item';
      item.setAttribute('role', 'menuitem');
      item.textContent = station.name;
      if (station.id === activeStationId) {
        item.classList.add('radio-station-menu-item-active');
      }
      item.addEventListener('click', () => {
        setRadioStation(station.id, { triggerChange: true });
        closeStationMenu();
      });
      stationList.appendChild(item);
      if (station.description) {
        const desc = document.createElement('div');
        desc.className = 'radio-station-menu-description';
        desc.textContent = station.description;
        stationList.appendChild(desc);
      }
    });
  };

  const closeStationMenu = () => {
    stationMenu.classList.remove('open');
    stationButton.setAttribute('aria-expanded', 'false');
    radioStationHost.closest('.toolbar-group-radio')?.classList.remove('toolbar-group-radio-open');
  };

  const positionStationMenu = () => {
    const rect = stationButton.getBoundingClientRect();
    const margin = 8;
    const menuWidth = Math.max(rect.width, 220);
    // Anchor to the button's left edge, but never let the menu run past the
    // right edge of the viewport — the radio widget sits at the trailing end
    // of the toolbar, close enough to the edge that it otherwise would.
    const maxLeft = window.innerWidth - menuWidth - margin;
    const left = Math.min(rect.left, Math.max(margin, maxLeft));
    stationMenu.style.left = `${Math.round(left + window.scrollX)}px`;
    stationMenu.style.top = `${Math.round(rect.bottom + margin + window.scrollY)}px`;
    stationMenu.style.minWidth = `${menuWidth}px`;
  };

  const openStationMenu = () => {
    if (stationButton.disabled || !stations.length) return;
    positionStationMenu();
    stationMenu.classList.add('open');
    stationButton.setAttribute('aria-expanded', 'true');
    radioStationHost.closest('.toolbar-group-radio')?.classList.add('toolbar-group-radio-open');
  };

  const toggleStationMenu = () => {
    if (stationMenu.classList.contains('open')) {
      closeStationMenu();
    } else {
      openStationMenu();
    }
  };

  const setRadioStation = (stationId?: string, opts: { triggerChange?: boolean } = {}) => {
    pendingStationId = stationId;
    if (!stations.length) return;
    const station =
      (stationId ? stations.find((entry) => entry.id === stationId) : undefined) ?? stations[0];
    if (!station) return;
    const hadChanged = activeStationId !== station.id;
    activeStationId = station.id;
    updateStationButton(station);
    radio.setPlaylistUrl(station.playlist);
    renderStationList();
    if (opts.triggerChange && hadChanged && onRadioStationChange) {
      onRadioStationChange(station.id);
    }
  };

  const loadStations = async () => {
    stationButton.disabled = true;
    stationList.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'radio-station-menu-loading';
    loading.textContent = 'Loading radio stations...';
    stationList.appendChild(loading);
    const manifest = await fetchRadioStations();
    manifestLoaded = true;
    if (!manifest || !manifest.stations.length) {
      stations = [];
      stationButton.disabled = true;
      stationList.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'radio-station-menu-empty';
      empty.textContent = manifest ? 'No radio stations available' : 'Radio stations unavailable';
      stationList.appendChild(empty);
      stationButton.title = 'Radio stations unavailable';
      stationButton.setAttribute('aria-label', 'Radio stations unavailable');
      closeStationMenu();
      return;
    }
    stations = manifest.stations;
    stationButton.disabled = false;
    setRadioStation(pendingStationId, { triggerChange: false });
  };

  const handleDocumentClick = (event: MouseEvent) => {
    if (!radioStationHost.contains(event.target as Node)) {
      closeStationMenu();
    }
  };

  const handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      closeStationMenu();
    }
  };

  stationButton.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleStationMenu();
  });

  document.addEventListener('click', handleDocumentClick);
  document.addEventListener('keydown', handleDocumentKeydown);
  window.addEventListener('resize', positionStationMenu);

  loadStations();

  updateToolbar(toolbar, initial);

  const restyleSubmenus = () => {
    const activeTool = toolbar.dataset.activeTool as Tool | undefined;
    if (activeTool) {
      updateToolbar(toolbar, activeTool);
    }
  };
  toolbar.addEventListener('scroll', restyleSubmenus);
  window.addEventListener('resize', restyleSubmenus);

  toolbarCleanups.set(toolbar, () => {
    if (closeSheetOnEscape) document.removeEventListener('keydown', closeSheetOnEscape);
    document.removeEventListener('click', handleDocumentClick);
    document.removeEventListener('keydown', handleDocumentKeydown);
    window.removeEventListener('resize', positionStationMenu);
    toolbar.removeEventListener('scroll', restyleSubmenus);
    window.removeEventListener('resize', restyleSubmenus);
  });

  return { radio, setRadioStation, getActiveStationId: () => activeStationId ?? undefined };
}

export function updateToolbar(toolbar: HTMLElement, active: Tool) {
  toolbar.dataset.activeTool = active;

  if (toolbar.dataset.layoutMode === 'compact') {
    const currentToolBtn = toolbar.querySelector<HTMLButtonElement>('.toolbar-current-tool-btn');
    if (currentToolBtn) {
      currentToolBtn.textContent = primaryLabelOverrides[active] ?? toolLabels[active];
    }
    toolbar.querySelectorAll('.tool-sheet-button').forEach((btn) => {
      const key = btn.getAttribute('data-tool');
      btn.classList.toggle('active', key === active);
    });
    toolbar.querySelector('.tool-sheet')?.classList.remove('open');
    toolbar.querySelector('.tool-sheet-backdrop')?.classList.remove('open');
    currentToolBtn?.setAttribute('aria-expanded', 'false');
    return;
  }

  toolbar.querySelectorAll('.tool-button').forEach((btn) => {
    const key = btn.getAttribute('data-tool');
    if (!key) return;
    const activePower =
      active === Tool.PowerLine ||
      active === Tool.HydroPlant ||
      active === Tool.CoalPlant ||
      active === Tool.WindTurbine ||
      active === Tool.SolarFarm;
    const activeWater = active === Tool.WaterPump || active === Tool.WaterTower || active === Tool.WaterPipe;
    const activeEducation = active === Tool.ElementarySchool || active === Tool.HighSchool;
    const isActive =
      key === active ||
      (activePower && key === Tool.PowerLine) ||
      (activeWater && key === Tool.WaterPipe) ||
      (activeEducation && key === Tool.ElementarySchool);
    btn.classList.toggle('active', isActive);
  });
  toolbar.querySelectorAll('.tool-sub-button').forEach((btn) => {
    const key = btn.getAttribute('data-tool');
    btn.classList.toggle('active', key === active);
  });
  const powerRow = toolbar.querySelector<HTMLDivElement>('.toolbar-sub[data-submenu="power"]');
  const waterRow = toolbar.querySelector<HTMLDivElement>('.toolbar-sub[data-submenu="water"]');
  const educationRow = toolbar.querySelector<HTMLDivElement>('.toolbar-sub[data-submenu="education"]');

  const allGroups = toolbar.querySelectorAll<HTMLElement>('.toolbar-group');
  allGroups.forEach((group) => group.classList.remove('toolbar-group-sub-open'));

  const positionSubmenu = (row: HTMLDivElement | null, anchorTool: Tool) => {
    if (!row) return;
    // Keep the submenu container aligned with the originating toolbar group.
    const anchorButton = toolbar.querySelector<HTMLElement>(`.tool-button[data-tool="${anchorTool}"]`);
    const anchorGroup = anchorButton?.closest<HTMLElement>('.toolbar-group');
    if (!anchorButton || !anchorGroup) return;
    const anchorRect = anchorGroup.getBoundingClientRect();
    row.style.left = `${anchorRect.left}px`;
    row.style.minWidth = `${anchorRect.width}px`;
    row.style.top = `${anchorRect.bottom - 2}px`;
    anchorGroup.classList.add('toolbar-group-sub-open');
  };

  if (powerRow) {
    const open = powerOptions.includes(active);
    powerRow.style.display = open ? 'flex' : 'none';
    powerRow.style.left = '';
    powerRow.style.top = '';
    powerRow.style.minWidth = '';
    powerRow.classList.toggle('toolbar-sub-open', open);
    if (open) positionSubmenu(powerRow, Tool.PowerLine);
  }
  if (waterRow) {
    const open = waterOptions.includes(active);
    waterRow.style.display = open ? 'flex' : 'none';
    waterRow.style.left = '';
    waterRow.style.top = '';
    waterRow.style.minWidth = '';
    waterRow.classList.toggle('toolbar-sub-open', open);
    if (open) positionSubmenu(waterRow, Tool.WaterPipe);
  }
  if (educationRow) {
    const open = educationOptions.includes(active);
    educationRow.style.display = open ? 'flex' : 'none';
    educationRow.style.left = '';
    educationRow.style.top = '';
    educationRow.style.minWidth = '';
    educationRow.classList.toggle('toolbar-sub-open', open);
    if (open) positionSubmenu(educationRow, Tool.ElementarySchool);
  }
}
