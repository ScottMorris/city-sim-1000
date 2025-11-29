import { Tool } from '../game/toolTypes';

const toolLabels: Record<Tool, string> = {
  [Tool.Inspect]: 'Inspect',
  [Tool.TerraformRaise]: 'Raise',
  [Tool.TerraformLower]: 'Lower',
  [Tool.Water]: 'Water',
  [Tool.Tree]: 'Trees',
  [Tool.Road]: 'Road',
  [Tool.Rail]: 'Rail',
  [Tool.PowerLine]: 'Power',
  [Tool.WaterPump]: 'Pump',
  [Tool.Residential]: 'Res',
  [Tool.Commercial]: 'Com',
  [Tool.Industrial]: 'Ind',
  [Tool.Bulldoze]: 'Bulldoze',
  [Tool.Park]: 'Park'
};

export function initToolbar(toolbar: HTMLElement, onSelect: (tool: Tool) => void, initial: Tool) {
  toolbar.innerHTML = '';
  const powerOptions: Tool[] = [
    Tool.PowerLine,
    Tool.HydroPlant,
    Tool.CoalPlant,
    Tool.WindTurbine,
    Tool.SolarFarm
  ];

  const primaryRow = document.createElement('div');
  primaryRow.className = 'toolbar-row';
  const powerRow = document.createElement('div');
  powerRow.className = 'toolbar-sub';
  toolbar.appendChild(primaryRow);
  toolbar.appendChild(powerRow);

  const primaryTools = (Object.values(Tool) as Tool[]).filter(
    (t) =>
      ![Tool.HydroPlant, Tool.CoalPlant, Tool.WindTurbine, Tool.SolarFarm].includes(t)
  );

  primaryTools.forEach((key) => {
    const button = document.createElement('button');
    button.className = 'tool-button';
    button.textContent = toolLabels[key];
    button.dataset.tool = key;
    button.addEventListener('click', () => {
      onSelect(key);
      updateToolbar(toolbar, key);
      powerRow.style.display = key === Tool.PowerLine ? 'flex' : 'none';
    });
    primaryRow.appendChild(button);
  });

  powerOptions.forEach((key) => {
    const button = document.createElement('button');
    button.className = 'tool-sub-button';
    button.textContent = key === Tool.PowerLine ? 'Lines' : toolLabels[key];
    button.dataset.tool = key;
    button.addEventListener('click', () => {
      onSelect(key);
      updateToolbar(toolbar, key);
      powerRow.style.display = 'flex';
    });
    powerRow.appendChild(button);
  });

  powerRow.style.display =
    initial === Tool.PowerLine ||
    initial === Tool.HydroPlant ||
    initial === Tool.CoalPlant ||
    initial === Tool.WindTurbine ||
    initial === Tool.SolarFarm
      ? 'flex'
      : 'none';

  updateToolbar(toolbar, initial);
}

export function updateToolbar(toolbar: HTMLElement, active: Tool) {
  toolbar.querySelectorAll('.tool-button').forEach((btn) => {
    const key = btn.getAttribute('data-tool');
    const activePower =
      active === Tool.PowerLine ||
      active === Tool.HydroPlant ||
      active === Tool.CoalPlant ||
      active === Tool.WindTurbine ||
      active === Tool.SolarFarm;
    const isActive = key === active || (activePower && key === Tool.PowerLine);
    btn.classList.toggle('active', isActive);
  });
  toolbar.querySelectorAll('.tool-sub-button').forEach((btn) => {
    const key = btn.getAttribute('data-tool');
    btn.classList.toggle('active', key === active);
  });
}
