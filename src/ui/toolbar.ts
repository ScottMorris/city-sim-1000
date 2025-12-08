import { Tool } from '../game/toolTypes';
import { getToolHotkey, primaryLabelOverrides, toolLabels } from './toolInfo';
import { initRadioWidget, type RadioWidget } from './radio';

const powerOptions: Tool[] = [
  Tool.PowerLine,
  Tool.HydroPlant,
  Tool.CoalPlant,
  Tool.WindTurbine,
  Tool.SolarFarm
];

const waterOptions: Tool[] = [Tool.WaterPump, Tool.WaterTower, Tool.WaterPipe];
const educationOptions: Tool[] = [Tool.ElementarySchool, Tool.HighSchool];

export function initToolbar(
  toolbar: HTMLElement,
  onSelect: (tool: Tool) => void,
  initial: Tool,
  options: { onOpenBudget?: () => void; onOpenSettings?: () => void; radioVolume?: number } = {}
): { radio: RadioWidget } {
  toolbar.innerHTML = '';
  const { onOpenBudget, onOpenSettings, radioVolume } = options;

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
  radioGroup.appendChild(radioHost);
  trailingCluster.appendChild(radioGroup);

  if (onOpenSettings) {
    const settingsGroup = document.createElement('div');
    settingsGroup.className = 'toolbar-group';
    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'tool-button';
    settingsBtn.textContent = '⚙️ Settings';
    settingsBtn.title = 'Open settings';
    settingsBtn.addEventListener('click', () => onOpenSettings());
    settingsGroup.appendChild(settingsBtn);
    trailingCluster.appendChild(settingsGroup);
  }

  if (onOpenBudget) {
    const budgetGroup = document.createElement('div');
    budgetGroup.className = 'toolbar-group';
    const budgetBtn = document.createElement('button');
    budgetBtn.id = 'budget-modal-btn';
    budgetBtn.className = 'tool-button budget-button';
    budgetBtn.textContent = '📊 Budget';
    budgetBtn.title = 'Open budget screen';
    budgetBtn.addEventListener('click', () => onOpenBudget());
    budgetGroup.appendChild(budgetBtn);
    trailingCluster.appendChild(budgetGroup);
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
  updateToolbar(toolbar, initial);

  const restyleSubmenus = () => {
    const activeTool = toolbar.dataset.activeTool as Tool | undefined;
    if (activeTool) {
      updateToolbar(toolbar, activeTool);
    }
  };
  toolbar.addEventListener('scroll', restyleSubmenus);
  window.addEventListener('resize', restyleSubmenus);

  return { radio };
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
