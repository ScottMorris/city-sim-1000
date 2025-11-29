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
  [Tool.HydroPlant]: 'Hydro',
  [Tool.CoalPlant]: 'Coal',
  [Tool.WindTurbine]: 'Wind',
  [Tool.SolarFarm]: 'Solar',
  [Tool.WaterPump]: 'Pump',
  [Tool.Residential]: 'Res',
  [Tool.Commercial]: 'Com',
  [Tool.Industrial]: 'Ind',
  [Tool.Bulldoze]: 'Bulldoze',
  [Tool.Park]: 'Park'
};

export function initToolbar(toolbar: HTMLElement, onSelect: (tool: Tool) => void, initial: Tool) {
  toolbar.innerHTML = '';
  let powerMenu: HTMLDivElement | null = null;
  let powerHoldTimer: number | null = null;

  const closePowerMenu = () => {
    powerMenu?.remove();
    powerMenu = null;
  };

  const powerOptions: Tool[] = [
    Tool.PowerLine,
    Tool.HydroPlant,
    Tool.CoalPlant,
    Tool.WindTurbine,
    Tool.SolarFarm
  ];

  const createPowerMenu = (anchor: HTMLElement) => {
    closePowerMenu();
    const menu = document.createElement('div');
    menu.className = 'power-menu';
    powerOptions.forEach((tool) => {
      const item = document.createElement('button');
      item.textContent = toolLabels[tool];
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        onSelect(tool);
        closePowerMenu();
        updateToolbar(toolbar, tool);
      });
      menu.appendChild(item);
    });
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    document.body.appendChild(menu);
    powerMenu = menu;
  };

  document.addEventListener('click', () => closePowerMenu());

  (Object.values(Tool) as Tool[]).forEach((key) => {
    const button = document.createElement('button');
    button.className = 'tool-button';
    button.textContent = toolLabels[key];
    button.dataset.tool = key;
    if (key === Tool.PowerLine) {
      button.addEventListener('pointerdown', () => {
        powerHoldTimer = window.setTimeout(() => {
          createPowerMenu(button);
        }, 350);
      });
      button.addEventListener('pointerup', () => {
        if (powerHoldTimer) {
          clearTimeout(powerHoldTimer);
          powerHoldTimer = null;
          if (!powerMenu) {
            onSelect(Tool.PowerLine);
            updateToolbar(toolbar, Tool.PowerLine);
          }
        }
      });
      button.addEventListener('pointerleave', () => {
        if (powerHoldTimer) {
          clearTimeout(powerHoldTimer);
          powerHoldTimer = null;
        }
      });
    } else {
      button.addEventListener('click', () => {
        onSelect(key);
        updateToolbar(toolbar, key);
        closePowerMenu();
      });
    }
    toolbar.appendChild(button);
  });
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
}
