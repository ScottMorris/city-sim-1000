// constants.ts — build costs, maintenance, and power plant configs.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { Occupant } from './protocol/occupants';
import { Tool } from './toolTypes';

export enum PowerPlantType {
  Hydro = 'hydro',
  Coal = 'coal',
  Wind = 'wind',
  Solar = 'solar'
}

export interface PowerPlantConfig {
  id: PowerPlantType;
  name: string;
  outputMw: number;
  buildCost: number;
  maintenancePerDay: number;
  footprint: { width: number; height: number };
  requiresWaterEdge?: boolean;
}

export const POWER_PLANT_CONFIGS: Record<PowerPlantType, PowerPlantConfig> = {
  [PowerPlantType.Hydro]: {
    id: PowerPlantType.Hydro,
    name: 'Hydro Plant',
    outputMw: 60,
    buildCost: 20000,
    maintenancePerDay: 150,
    footprint: { width: 2, height: 2 },
    requiresWaterEdge: true
  },
  [PowerPlantType.Coal]: {
    id: PowerPlantType.Coal,
    name: 'Coal Plant',
    outputMw: 80,
    buildCost: 25000,
    maintenancePerDay: 300,
    footprint: { width: 2, height: 2 }
  },
  [PowerPlantType.Wind]: {
    id: PowerPlantType.Wind,
    name: 'Wind Turbine',
    outputMw: 8,
    buildCost: 5000,
    maintenancePerDay: 30,
    footprint: { width: 2, height: 2 }
  },
  [PowerPlantType.Solar]: {
    id: PowerPlantType.Solar,
    name: 'Solar Farm',
    outputMw: 5,
    buildCost: 4000,
    maintenancePerDay: 20,
    footprint: { width: 2, height: 2 }
  }
};

export const BUILD_COST: Record<Tool, number> = {
  [Tool.Inspect]: 0,
  [Tool.TerraformRaise]: 10,
  [Tool.TerraformLower]: 10,
  [Tool.Water]: 12,
  [Tool.Tree]: 8,
  [Tool.Road]: 5,
  [Tool.Rail]: 15,
  [Tool.PowerLine]: 6,
  [Tool.HydroPlant]: POWER_PLANT_CONFIGS[PowerPlantType.Hydro].buildCost,
  [Tool.CoalPlant]: POWER_PLANT_CONFIGS[PowerPlantType.Coal].buildCost,
  [Tool.WindTurbine]: POWER_PLANT_CONFIGS[PowerPlantType.Wind].buildCost,
  [Tool.SolarFarm]: POWER_PLANT_CONFIGS[PowerPlantType.Solar].buildCost,
  [Tool.WaterPump]: 400,
  [Tool.WaterTower]: 1200,
  [Tool.WaterPipe]: 4,
  [Tool.ElementarySchool]: 4500,
  [Tool.HighSchool]: 7000,
  [Tool.Residential]: 40,
  [Tool.Commercial]: 60,
  [Tool.Industrial]: 80,
  [Tool.Bulldoze]: 1,
  [Tool.Park]: 10,
  [Tool.ParkLarge]: 32
};

/** Per-day upkeep for linear infrastructure, keyed by the occupant it is —
 *  these were never kinds of tile, they're things a tile carries. Display
 *  only (`toolInfo.ts`); the engine's own ledger lives in `economy.rs`. */
export const MAINTENANCE: Partial<Record<Occupant, number>> = {
  [Occupant.Road]: 0.1,
  [Occupant.Rail]: 0.2,
  [Occupant.PowerLine]: 0.08,
  [Occupant.Pipe]: 0.04
};

export const LOCAL_STORAGE_KEY = 'city-sim-1000-save';
