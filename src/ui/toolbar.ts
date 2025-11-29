import { Tool } from '../game/tools';

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
  [Tool.WaterPump]: 'Pump',
  [Tool.Residential]: 'Res',
  [Tool.Commercial]: 'Com',
  [Tool.Industrial]: 'Ind',
  [Tool.Bulldoze]: 'Bulldoze',
  [Tool.Park]: 'Park'
};

export function initToolbar(toolbar: HTMLElement, onSelect: (tool: Tool) => void, initial: Tool) {
  toolbar.innerHTML = '';
  (Object.values(Tool) as Tool[]).forEach((key) => {
    const button = document.createElement('button');
    button.className = 'tool-button';
    button.textContent = toolLabels[key];
    button.dataset.tool = key;
    button.addEventListener('click', () => {
      onSelect(key);
      updateToolbar(toolbar, key);
    });
    toolbar.appendChild(button);
  });
  updateToolbar(toolbar, initial);
}

export function updateToolbar(toolbar: HTMLElement, active: Tool) {
  toolbar.querySelectorAll('.tool-button').forEach((btn) => {
    const isActive = btn.getAttribute('data-tool') === active;
    btn.classList.toggle('active', isActive);
  });
}
