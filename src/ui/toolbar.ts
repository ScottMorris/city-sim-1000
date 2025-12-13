import { Tool } from '../game/toolTypes';
import { getToolHotkey, primaryLabelOverrides, toolLabels } from './toolInfo';
import { initRadioWidget, type RadioWidget } from './radio';
import { fetchRadioStations, type RadioStation } from './radioStations';

const powerOptions: Tool[] = [
  Tool.PowerLine,
  Tool.HydroPlant,
  Tool.CoalPlant,
  Tool.WindTurbine,
  Tool.SolarFarm
];

const waterOptions: Tool[] = [Tool.WaterPump, Tool.WaterTower, Tool.WaterPipe];
const educationOptions: Tool[] = [Tool.ElementarySchool, Tool.HighSchool];

interface ToolbarOptions {
  onOpenBudget?: () => void;
  onOpenBylaws?: () => void;
  onOpenSettings?: () => void;
  radioVolume?: number;
  radioStationId?: string;
  onRadioStationChange?: (stationId: string) => void;
}

export interface ToolbarControllers {
  radio: RadioWidget;
  setRadioStation: (stationId?: string, opts?: { triggerChange?: boolean }) => void;
}

export function initToolbar(
  toolbar: HTMLElement,
  onSelect: (tool: Tool) => void,
  initial: Tool,
  options: ToolbarOptions = {}
): ToolbarControllers {
  toolbar.innerHTML = '';
  const { onOpenBudget, onOpenBylaws, onOpenSettings, radioVolume, radioStationId, onRadioStationChange } = options;

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

  const groupedTools: Tool[][] = [
    [Tool.Inspect, Tool.TerraformRaise, Tool.TerraformLower, Tool.Water, Tool.Tree],
    [Tool.Road, Tool.Rail],
    [Tool.PowerLine, Tool.WaterPump],
    [Tool.ElementarySchool],
    [Tool.Residential, Tool.Commercial, Tool.Industrial],
    [Tool.Park],
    [Tool.Bulldoze]
  ];

  const createPrimaryButton = (key: Tool) => {
    const button = document.createElement('button');
    button.className = 'tool-button';
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

  groupedTools.forEach((group) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'toolbar-group';
    group.forEach((key) => {
      const button = createPrimaryButton(key);
      groupEl.appendChild(button);
    });
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
  const radioHost = document.createElement('div');
  radioHost.className = 'toolbar-radio-slot';
  const radioStationHost = document.createElement('div');
  radioStationHost.className = 'toolbar-radio-station';
  radioGroup.appendChild(radioHost);
  radioGroup.appendChild(radioStationHost);
  trailingCluster.appendChild(radioGroup);

  const adminGroup = document.createElement('div');
  adminGroup.className = 'toolbar-group toolbar-group-admin';
  let hasAdminButtons = false;

  if (onOpenSettings) {
    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = 'tool-button';
    settingsBtn.textContent = '⚙️ Settings';
    settingsBtn.title = 'Open settings';
    settingsBtn.addEventListener('click', () => onOpenSettings());
    adminGroup.appendChild(settingsBtn);
    hasAdminButtons = true;
  }

  if (onOpenBylaws) {
    const bylawsBtn = document.createElement('button');
    bylawsBtn.type = 'button';
    bylawsBtn.id = 'bylaws-modal-btn';
    bylawsBtn.className = 'tool-button';
    bylawsBtn.textContent = '📜 Bylaws';
    bylawsBtn.title = 'Open bylaws screen';
    bylawsBtn.addEventListener('click', () => onOpenBylaws());
    adminGroup.appendChild(bylawsBtn);
    hasAdminButtons = true;
  }

  if (onOpenBudget) {
    const budgetBtn = document.createElement('button');
    budgetBtn.type = 'button';
    budgetBtn.id = 'budget-modal-btn';
    budgetBtn.className = 'tool-button budget-button';
    budgetBtn.textContent = '📊 Budget';
    budgetBtn.title = 'Open budget screen';
    budgetBtn.addEventListener('click', () => onOpenBudget());
    adminGroup.appendChild(budgetBtn);
    hasAdminButtons = true;
  }

  if (hasAdminButtons) {
    adminGroup.setAttribute('role', 'group');
    adminGroup.setAttribute('aria-label', 'City admin tools');
    trailingCluster.appendChild(adminGroup);
  }

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
    radioGroup.classList.remove('toolbar-group-radio-open');
  };

  const positionStationMenu = () => {
    const rect = stationButton.getBoundingClientRect();
    const margin = 8;
    stationMenu.style.left = `${Math.round(rect.left + window.scrollX)}px`;
    stationMenu.style.top = `${Math.round(rect.bottom + margin + window.scrollY)}px`;
    stationMenu.style.minWidth = `${Math.max(rect.width, 220)}px`;
  };

  const openStationMenu = () => {
    if (stationButton.disabled || !stations.length) return;
    positionStationMenu();
    stationMenu.classList.add('open');
    stationButton.setAttribute('aria-expanded', 'true');
    radioGroup.classList.add('toolbar-group-radio-open');
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

  return { radio, setRadioStation };
}

export function updateToolbar(toolbar: HTMLElement, active: Tool) {
  toolbar.dataset.activeTool = active;
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
      (activeWater && key === Tool.WaterPump) ||
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
    if (open) positionSubmenu(waterRow, Tool.WaterPump);
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
