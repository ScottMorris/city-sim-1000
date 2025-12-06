import { BUILD_COST, MAINTENANCE, POWER_PLANT_CONFIGS, PowerPlantType } from '../game/constants';
import { getBuildingTemplate } from '../game/buildings';
import { TileKind } from '../game/gameState';
import { Tool } from '../game/toolTypes';
import { defaultHotkeys, HotkeyAction } from './hotkeys';

export interface ToolDetails {
  tool: Tool;
  name: string;
  hotkey?: string;
  rows: { label: string; value: string }[];
  hints: string[];
  unavailable?: boolean;
}

export const toolLabels: Record<Tool, string> = {
  [Tool.Inspect]: '🔍 Inspect',
  [Tool.TerraformRaise]: '⛰️ Raise',
  [Tool.TerraformLower]: '🕳️ Lower',
  [Tool.Water]: '🌊 Water',
  [Tool.Tree]: '🌲 Trees',
  [Tool.Road]: '🛣️ Road',
  [Tool.Rail]: '🚆 Rail',
  [Tool.PowerLine]: '⚡ Power',
  [Tool.HydroPlant]: '🌊 Hydro',
  [Tool.CoalPlant]: '🏭 Coal',
  [Tool.WindTurbine]: '🌬️ Wind',
  [Tool.SolarFarm]: '☀️ Solar',
  [Tool.WaterPump]: '🚰 Pump',
  [Tool.WaterTower]: '🗼 Tower',
  [Tool.WaterPipe]: '🔧 Pipes',
  [Tool.ElementarySchool]: '🏫 Elementary',
  [Tool.HighSchool]: '🏢 High School',
  [Tool.Residential]: '🏘️ Res',
  [Tool.Commercial]: '🏪 Com',
  [Tool.Industrial]: '🏭 Ind',
  [Tool.Bulldoze]: '🪓 Bulldoze',
  [Tool.Park]: '🌳 Park'
};

export const primaryLabelOverrides: Partial<Record<Tool, string>> = {
  [Tool.WaterPump]: '🚰 Water',
  [Tool.ElementarySchool]: '🎓 Schools'
};

const toolNames: Record<Tool, string> = {
  [Tool.Inspect]: 'Inspect',
  [Tool.TerraformRaise]: 'Raise Terrain',
  [Tool.TerraformLower]: 'Lower Terrain',
  [Tool.Water]: 'Water Paint',
  [Tool.Tree]: 'Trees',
  [Tool.Road]: 'Roads',
  [Tool.Rail]: 'Rail',
  [Tool.PowerLine]: 'Power Lines',
  [Tool.HydroPlant]: 'Hydro Plant',
  [Tool.CoalPlant]: 'Coal Plant',
  [Tool.WindTurbine]: 'Wind Turbine',
  [Tool.SolarFarm]: 'Solar Farm',
  [Tool.WaterPump]: 'Water Pump',
  [Tool.WaterTower]: 'Water Tower',
  [Tool.WaterPipe]: 'Water Pipes',
  [Tool.ElementarySchool]: 'Elementary School',
  [Tool.HighSchool]: 'High School',
  [Tool.Residential]: 'Residential Zone',
  [Tool.Commercial]: 'Commercial Zone',
  [Tool.Industrial]: 'Industrial Zone',
  [Tool.Bulldoze]: 'Bulldoze',
  [Tool.Park]: 'Park'
};

const toolHotkeyActions: Partial<Record<Tool, HotkeyAction>> = {
  [Tool.Inspect]: 'selectInspect',
  [Tool.TerraformRaise]: 'selectTerraformRaise',
  [Tool.TerraformLower]: 'selectTerraformLower',
  [Tool.Water]: 'selectWater',
  [Tool.Tree]: 'selectTrees',
  [Tool.Road]: 'selectRoad',
  [Tool.Rail]: 'selectRail',
  [Tool.PowerLine]: 'selectPower',
  [Tool.HydroPlant]: 'selectHydro',
  [Tool.WaterPump]: 'selectWaterPump',
  [Tool.WaterTower]: 'selectWaterTower',
  [Tool.ElementarySchool]: 'selectElementarySchool',
  [Tool.HighSchool]: 'selectHighSchool',
  [Tool.Residential]: 'selectResidential',
  [Tool.Commercial]: 'selectCommercial',
  [Tool.Industrial]: 'selectIndustrial',
  [Tool.Park]: 'selectPark',
  [Tool.Bulldoze]: 'selectBulldoze'
};

const powerPlantToolToType: Partial<Record<Tool, PowerPlantType>> = {
  [Tool.HydroPlant]: PowerPlantType.Hydro,
  [Tool.CoalPlant]: PowerPlantType.Coal,
  [Tool.WindTurbine]: PowerPlantType.Wind,
  [Tool.SolarFarm]: PowerPlantType.Solar
};

function formatHotkey(binding?: string): string | undefined {
  if (!binding) return undefined;
  if (binding.startsWith('Key')) return binding.slice(3);
  if (binding.startsWith('Digit')) return binding.slice(5);
  return binding;
}

export function getToolHotkey(tool: Tool): string | undefined {
  const action = toolHotkeyActions[tool];
  if (!action) return undefined;
  const binding = defaultHotkeys[action]?.[0];
  return formatHotkey(binding);
}

function formatCurrency(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const abs = Math.abs(value);
  const formatted =
    abs >= 100 ? Math.round(value).toLocaleString() : abs >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `$${formatted}`;
}

function formatFootprint(width: number, height: number): string {
  return `${width}x${height} tiles`;
}

function withMaintenanceRow(rows: { label: string; value: string }[], amount?: number) {
  if (amount === undefined) return;
  rows.push({ label: 'Upkeep', value: `${formatCurrency(amount)} / day` });
}

function addUtilityUse(
  rows: { label: string; value: string }[],
  powerUse?: number,
  waterUse?: number,
  waterOutput?: number
) {
  const parts: string[] = [];
  if (powerUse !== undefined) parts.push(`⚡ ${powerUse.toFixed(1)} MW`);
  if (waterUse !== undefined) parts.push(`💧 ${waterUse.toFixed(1)} m³`);
  if (waterOutput !== undefined) parts.push(`↥ ${waterOutput.toFixed(1)} m³`);
  if (parts.length) rows.push({ label: 'Utilities', value: parts.join(' • ') });
}

export function getToolDetails(tool: Tool): ToolDetails {
  const cost = BUILD_COST[tool];
  const rows: { label: string; value: string }[] = [];
  const hints: string[] = [];
  const name = toolNames[tool] ?? tool;
  const hotkey = getToolHotkey(tool);
  if (cost !== undefined && (tool !== Tool.Inspect || cost > 0)) {
    rows.push({ label: 'Cost', value: formatCurrency(cost) ?? '$0' });
  }

  switch (tool) {
    case Tool.Road:
      withMaintenanceRow(rows, MAINTENANCE[TileKind.Road]);
      rows.push({ label: 'Purpose', value: 'Access + conducts power' });
      hints.push('Bulldoze roads/rail first before zoning over them.');
      break;
    case Tool.Rail:
      withMaintenanceRow(rows, MAINTENANCE[TileKind.Rail]);
      rows.push({ label: 'Purpose', value: 'Freight/passenger routes' });
      hints.push('Rails conduct power and can cross roads.');
      break;
    case Tool.PowerLine: {
      withMaintenanceRow(rows, MAINTENANCE[TileKind.PowerLine]);
      rows.push({ label: 'Purpose', value: 'Carries power; can overlay roads/rail' });
      break;
    }
    case Tool.HydroPlant:
    case Tool.CoalPlant:
    case Tool.WindTurbine:
    case Tool.SolarFarm: {
      const plantType = powerPlantToolToType[tool];
      if (!plantType) break;
      const config = POWER_PLANT_CONFIGS[plantType];
      rows.push({ label: 'Output', value: `${config.outputMw} MW` });
      rows.push({ label: 'Footprint', value: formatFootprint(config.footprint.width, config.footprint.height) });
      withMaintenanceRow(rows, config.maintenancePerDay);
      if (tool === Tool.HydroPlant && config.requiresWaterEdge) {
        hints.push('Place along water edges for flavour; placement rules will tighten with pipes.');
      }
      break;
    }
    case Tool.WaterPump:
    case Tool.WaterTower: {
      const template = getBuildingTemplate(tool === Tool.WaterPump ? TileKind.WaterPump : TileKind.WaterTower);
      if (template) {
        rows.push({ label: 'Output', value: `${template.waterOutput?.toFixed(0) ?? 0} m³ / day` });
        rows.push({ label: 'Footprint', value: formatFootprint(template.footprint.width, template.footprint.height) });
        withMaintenanceRow(rows, template.maintenance);
        addUtilityUse(rows, template.powerUse, template.waterUse, template.waterOutput);
      }
      hints.push(template?.requiresPower ? 'Requires power to run.' : 'Keeps running without power.');
      break;
    }
    case Tool.ElementarySchool:
    case Tool.HighSchool: {
      const template = getBuildingTemplate(
        tool === Tool.ElementarySchool ? TileKind.ElementarySchool : TileKind.HighSchool
      );
      if (template) {
        rows.push({ label: 'Footprint', value: formatFootprint(template.footprint.width, template.footprint.height) });
        const service = template.service;
        if (service) {
          rows.push({ label: 'Coverage', value: `${service.coverageRadius} tiles (road reach)` });
          rows.push({ label: 'Capacity', value: `${service.capacity} seats` });
        }
        withMaintenanceRow(rows, template.maintenance);
        addUtilityUse(rows, template.powerUse, template.waterUse, template.waterOutput);
      }
      hints.push('Covers homes through the road network; requires power to stay open.');
      break;
    }
    case Tool.Residential:
    case Tool.Commercial:
    case Tool.Industrial: {
      const kind =
        tool === Tool.Residential ? TileKind.Residential : tool === Tool.Commercial ? TileKind.Commercial : TileKind.Industrial;
      const template = getBuildingTemplate(kind);
      if (template) {
        rows.push({ label: 'Maintenance', value: `${formatCurrency(template.maintenance) ?? '$0'} / day` });
        addUtilityUse(rows, template.powerUse, template.waterUse, template.waterOutput);
        if (template.populationCapacity !== undefined) {
          rows.push({ label: 'Capacity', value: `${template.populationCapacity} pop` });
        }
        if (template.jobsCapacity !== undefined) {
          rows.push({ label: 'Capacity', value: `${template.jobsCapacity} jobs` });
        }
      }
      hints.push('Needs road access and power; water is stubbed high until pipes land.');
      break;
    }
    case Tool.Park: {
      const template = getBuildingTemplate(TileKind.Park);
      if (template) {
        withMaintenanceRow(rows, template.maintenance);
        rows.push({ label: 'Footprint', value: formatFootprint(template.footprint.width, template.footprint.height) });
      }
      hints.push('Raises happiness around it.');
      break;
    }
    case Tool.Tree:
      hints.push('Adds small happiness to nearby tiles.');
      break;
    case Tool.Water:
      hints.push('Paints water; use raise/lower to carve edges cleanly.');
      break;
    case Tool.TerraformRaise:
    case Tool.TerraformLower:
      hints.push('Terrain costs apply per tile; use to open buildable land or carve rivers.');
      break;
    case Tool.Bulldoze:
      hints.push('Clears buildings or networks; terrain stays unchanged.');
      break;
    case Tool.WaterPipe:
      hints.push('Underground pipes coming soon.');
      return { tool, name, hotkey, rows, hints, unavailable: true };
    case Tool.Inspect:
    default:
      hints.push('Inspect a tile to see utilities, status, and capacity.');
      break;
  }

  return { tool, name, hotkey, rows, hints };
}
