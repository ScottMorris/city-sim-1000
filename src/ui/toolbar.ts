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

  const primaryTools = (Object.values(Tool) as Tool[]).filter(
    (t) =>
      ![
        Tool.HydroPlant,
        Tool.CoalPlant,
        Tool.WindTurbine,
        Tool.SolarFarm,
        Tool.WaterTower,
        Tool.WaterPipe
      ].includes(t)
  );

  primaryTools.forEach((key) => {
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
    primaryRow.appendChild(button);
  });

  const radioHost = document.createElement('div');
  radioHost.className = 'toolbar-radio-slot';
  primaryRow.appendChild(radioHost);

  const spacer = document.createElement('div');
  spacer.className = 'toolbar-spacer';
  primaryRow.appendChild(spacer);

  if (onOpenBudget) {
    const budgetBtn = document.createElement('button');
    budgetBtn.id = 'budget-modal-btn';
    budgetBtn.className = 'tool-button budget-button';
    budgetBtn.textContent = '📊 Budget';
    budgetBtn.title = 'Open budget screen';
    budgetBtn.addEventListener('click', () => onOpenBudget());
    primaryRow.appendChild(budgetBtn);
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
