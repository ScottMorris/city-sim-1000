import { Tool } from '../game/toolTypes';
import { getToolHotkey, primaryLabelOverrides, toolLabels } from './toolInfo';
import { initRadioWidget } from './radio';

const powerOptions: Tool[] = [
  Tool.PowerLine,
  Tool.HydroPlant,
  Tool.CoalPlant,
  Tool.WindTurbine,
  Tool.SolarFarm
];

const waterOptions: Tool[] = [Tool.WaterPump, Tool.WaterTower, Tool.WaterPipe];

export function initToolbar(
  toolbar: HTMLElement,
  onSelect: (tool: Tool) => void,
  initial: Tool,
  options: { onOpenBudget?: () => void } = {}
) {
  toolbar.innerHTML = '';
  const { onOpenBudget } = options;

  const primaryRow = document.createElement('div');
  primaryRow.className = 'toolbar-row';
  const powerRow = document.createElement('div');
  powerRow.className = 'toolbar-sub';
  powerRow.dataset.submenu = 'power';
  const waterRow = document.createElement('div');
  waterRow.className = 'toolbar-sub';
  waterRow.dataset.submenu = 'water';
  toolbar.appendChild(primaryRow);
  toolbar.appendChild(powerRow);
  toolbar.appendChild(waterRow);

  const groupedTools: Tool[][] = [
    [Tool.Inspect, Tool.TerraformRaise, Tool.TerraformLower, Tool.Water, Tool.Tree],
    [Tool.Road, Tool.Rail],
    [Tool.PowerLine, Tool.WaterPump],
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
    if (key === Tool.WaterPipe) {
      button.disabled = true;
      button.title = 'Underground water pipes view coming soon';
    }
    button.addEventListener('click', () => {
      if (button.disabled) return;
      onSelect(key);
      updateToolbar(toolbar, key);
    });
    row.appendChild(button);
  };

  powerOptions.forEach((key) => createSubButton(powerRow, key, key === Tool.PowerLine ? '⚡ Lines' : undefined));
  waterOptions.forEach((key) => createSubButton(waterRow, key, key === Tool.WaterPump ? '🚰 Pump' : undefined));

  initRadioWidget(radioHost);
  updateToolbar(toolbar, initial);
}

export function updateToolbar(toolbar: HTMLElement, active: Tool) {
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
    const isActive =
      key === active ||
      (activePower && key === Tool.PowerLine) ||
      (activeWater && key === Tool.WaterPump);
    btn.classList.toggle('active', isActive);
  });
  toolbar.querySelectorAll('.tool-sub-button').forEach((btn) => {
    const key = btn.getAttribute('data-tool');
    btn.classList.toggle('active', key === active);
  });
  const powerRow = toolbar.querySelector<HTMLDivElement>('.toolbar-sub[data-submenu="power"]');
  const waterRow = toolbar.querySelector<HTMLDivElement>('.toolbar-sub[data-submenu="water"]');
  if (powerRow) {
    powerRow.style.display = powerOptions.includes(active) ? 'flex' : 'none';
  }
  if (waterRow) {
    waterRow.style.display = waterOptions.includes(active) ? 'flex' : 'none';
  }
}
