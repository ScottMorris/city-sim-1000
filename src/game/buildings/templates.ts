import { BUILD_COST, POWER_PLANT_CONFIGS, PowerPlantType } from '../configs';
import { TileKind } from '../gameState';
import { Tool } from '../toolTypes';
import { ServiceId } from '../services';

export enum BuildingCategory {
  Power = 'power',
  Civic = 'civic',
  Zone = 'zone'
}

export interface BuildingTemplate {
  id: string;
  name: string;
  category: BuildingCategory;
  footprint: { width: number; height: number };
  cost: number;
  maintenance: number;
  tileKind: TileKind;
  spriteKey?: string;
  requiresPower?: boolean;
  power?: { type: PowerPlantType; outputMw: number };
  powerUse?: number;
  waterUse?: number;
  waterOutput?: number;
  populationCapacity?: number;
  jobsCapacity?: number;
  service?: {
    id: ServiceId;
    coverageRadius: number;
    capacity: number;
  };
}

export const POWER_PLANT_TEMPLATES: Record<PowerPlantType, BuildingTemplate> = {
  [PowerPlantType.Hydro]: {
    id: PowerPlantType.Hydro,
    name: POWER_PLANT_CONFIGS[PowerPlantType.Hydro].name,
    category: BuildingCategory.Power,
    footprint: POWER_PLANT_CONFIGS[PowerPlantType.Hydro].footprint,
    cost: POWER_PLANT_CONFIGS[PowerPlantType.Hydro].buildCost,
    maintenance: POWER_PLANT_CONFIGS[PowerPlantType.Hydro].maintenancePerDay,
    tileKind: TileKind.HydroPlant,
    requiresPower: false,
    power: { type: PowerPlantType.Hydro, outputMw: POWER_PLANT_CONFIGS[PowerPlantType.Hydro].outputMw }
  },
  [PowerPlantType.Coal]: {
    id: PowerPlantType.Coal,
    name: POWER_PLANT_CONFIGS[PowerPlantType.Coal].name,
    category: BuildingCategory.Power,
    footprint: POWER_PLANT_CONFIGS[PowerPlantType.Coal].footprint,
    cost: POWER_PLANT_CONFIGS[PowerPlantType.Coal].buildCost,
    maintenance: POWER_PLANT_CONFIGS[PowerPlantType.Coal].maintenancePerDay,
    tileKind: TileKind.HydroPlant,
    requiresPower: false,
    power: { type: PowerPlantType.Coal, outputMw: POWER_PLANT_CONFIGS[PowerPlantType.Coal].outputMw }
  },
  [PowerPlantType.Wind]: {
    id: PowerPlantType.Wind,
    name: POWER_PLANT_CONFIGS[PowerPlantType.Wind].name,
    category: BuildingCategory.Power,
    footprint: POWER_PLANT_CONFIGS[PowerPlantType.Wind].footprint,
    cost: POWER_PLANT_CONFIGS[PowerPlantType.Wind].buildCost,
    maintenance: POWER_PLANT_CONFIGS[PowerPlantType.Wind].maintenancePerDay,
    tileKind: TileKind.HydroPlant,
    requiresPower: false,
    power: { type: PowerPlantType.Wind, outputMw: POWER_PLANT_CONFIGS[PowerPlantType.Wind].outputMw }
  },
  [PowerPlantType.Solar]: {
    id: PowerPlantType.Solar,
    name: POWER_PLANT_CONFIGS[PowerPlantType.Solar].name,
    category: BuildingCategory.Power,
    footprint: POWER_PLANT_CONFIGS[PowerPlantType.Solar].footprint,
    cost: POWER_PLANT_CONFIGS[PowerPlantType.Solar].buildCost,
    maintenance: POWER_PLANT_CONFIGS[PowerPlantType.Solar].maintenancePerDay,
    tileKind: TileKind.HydroPlant,
    requiresPower: false,
    power: { type: PowerPlantType.Solar, outputMw: POWER_PLANT_CONFIGS[PowerPlantType.Solar].outputMw }
  }
};

export const CIVIC_BUILDING_TEMPLATES: Record<string, BuildingTemplate> = {
  [TileKind.WaterPump]: {
    id: TileKind.WaterPump,
    name: 'Water Pump',
    category: BuildingCategory.Civic,
    footprint: { width: 1, height: 1 },
    cost: BUILD_COST[Tool.WaterPump],
    maintenance: 5,
    tileKind: TileKind.WaterPump,
    requiresPower: true,
    waterOutput: 50
  },
  [TileKind.WaterTower]: {
    id: TileKind.WaterTower,
    name: 'Water Tower',
    category: BuildingCategory.Civic,
    footprint: { width: 2, height: 2 },
    cost: BUILD_COST[Tool.WaterTower],
    maintenance: 12,
    tileKind: TileKind.WaterTower,
    requiresPower: false,
    waterOutput: 120
  },
  [TileKind.Park]: {
    id: TileKind.Park,
    name: 'Park',
    category: BuildingCategory.Civic,
    footprint: { width: 1, height: 1 },
    cost: 10,
    maintenance: 0.05,
    tileKind: TileKind.Park,
    requiresPower: false
  },
  [TileKind.ElementarySchool]: {
    id: TileKind.ElementarySchool,
    name: 'Elementary School',
    category: BuildingCategory.Civic,
    footprint: { width: 2, height: 2 },
    cost: BUILD_COST[Tool.ElementarySchool],
    maintenance: 40,
    tileKind: TileKind.ElementarySchool,
    requiresPower: true,
    powerUse: 4,
    service: { id: ServiceId.EducationElementary, coverageRadius: 8, capacity: 180 }
  },
  [TileKind.HighSchool]: {
    id: TileKind.HighSchool,
    name: 'High School',
    category: BuildingCategory.Civic,
    footprint: { width: 2, height: 2 },
    cost: BUILD_COST[Tool.HighSchool],
    maintenance: 55,
    tileKind: TileKind.HighSchool,
    requiresPower: true,
    powerUse: 5,
    service: { id: ServiceId.EducationHigh, coverageRadius: 9, capacity: 160 }
  }
};

export const ZONE_BUILDING_TEMPLATES: Record<string, BuildingTemplate> = {
  [TileKind.Residential]: {
    id: 'zone-residential',
    name: 'Residential Lot',
    category: BuildingCategory.Zone,
    footprint: { width: 1, height: 1 },
    cost: BUILD_COST[Tool.Residential],
    maintenance: 1,
    tileKind: TileKind.Residential,
    requiresPower: true,
    powerUse: 1.5,
    waterUse: 1,
    populationCapacity: 14
  },
  [TileKind.Commercial]: {
    id: 'zone-commercial',
    name: 'Commercial Lot',
    category: BuildingCategory.Zone,
    footprint: { width: 1, height: 1 },
    cost: BUILD_COST[Tool.Commercial],
    maintenance: 1.2,
    tileKind: TileKind.Commercial,
    requiresPower: true,
    powerUse: 2.5,
    waterUse: 1.5,
    jobsCapacity: 8
  },
  [TileKind.Industrial]: {
    id: 'zone-industrial',
    name: 'Industrial Lot',
    category: BuildingCategory.Zone,
    footprint: { width: 1, height: 1 },
    cost: BUILD_COST[Tool.Industrial],
    maintenance: 1.4,
    tileKind: TileKind.Industrial,
    requiresPower: true,
    powerUse: 3,
    waterUse: 2,
    jobsCapacity: 12
  }
};

const ZONE_TEMPLATES_BY_ID = Object.values(ZONE_BUILDING_TEMPLATES).reduce(
  (acc, template) => {
    acc[template.id] = template;
    return acc;
  },
  {} as Record<string, BuildingTemplate>
);

const STATIC_BUILDING_TEMPLATES: Record<string, BuildingTemplate> = {
  ...POWER_PLANT_TEMPLATES,
  ...CIVIC_BUILDING_TEMPLATES,
  ...ZONE_BUILDING_TEMPLATES,
  ...ZONE_TEMPLATES_BY_ID
};

const CUSTOM_BUILDING_TEMPLATES: Record<string, BuildingTemplate> = {};

export function getBuildingTemplate(templateId: string): BuildingTemplate | undefined {
  if (CUSTOM_BUILDING_TEMPLATES[templateId]) return CUSTOM_BUILDING_TEMPLATES[templateId];
  const staticTemplate = STATIC_BUILDING_TEMPLATES[templateId];
  if (staticTemplate) return staticTemplate;
  return undefined;
}

export function registerBuildingTemplate(template: BuildingTemplate) {
  CUSTOM_BUILDING_TEMPLATES[template.id] = template;
}

export function getPowerPlantTemplate(type: PowerPlantType): BuildingTemplate {
  return POWER_PLANT_TEMPLATES[type];
}
