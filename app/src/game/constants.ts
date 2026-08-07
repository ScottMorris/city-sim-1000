// constants.ts — build costs, maintenance, and power plant configs.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { Occupant } from './protocol/occupants';
import { Tool } from './toolTypes';
import { engineBuildingData, engineToolCost } from './buildings/templateData';

export enum PowerPlantType {
  Hydro = 'hydro',
  Coal = 'coal',
  Wind = 'wind',
  Solar = 'solar'
}

/**
 * Display-only power plant config. `outputMw` reads `templateData.json`'s
 * `outputMw` — generated from Rust's own `HYDRO_PLANT_MW` &c. constants
 * (`crates/city-sim-core/src/buildings.rs`, `tests/template_data.rs`) — but
 * is display-only here (the toolbar tooltip in `ui/toolInfo.ts`) — nothing
 * client-side computes with it, unlike `footprint`/build cost/maintenance,
 * which used to live here too and now come from `templateData.json`
 * (`buildings/templates.ts`, `BUILD_COST` below) since the engine actually
 * charges/enforces them.
 */
export interface PowerPlantConfig {
  id: PowerPlantType;
  name: string;
  outputMw: number;
  requiresWaterEdge?: boolean;
}

export const POWER_PLANT_CONFIGS: Record<PowerPlantType, PowerPlantConfig> = {
  [PowerPlantType.Hydro]: {
    id: PowerPlantType.Hydro,
    name: 'Hydro Plant',
    outputMw: engineBuildingData('HydroPlant').outputMw!,
    requiresWaterEdge: true
  },
  [PowerPlantType.Coal]: {
    id: PowerPlantType.Coal,
    name: 'Coal Plant',
    outputMw: engineBuildingData('CoalPlant').outputMw!
  },
  [PowerPlantType.Wind]: {
    id: PowerPlantType.Wind,
    name: 'Wind Turbine',
    outputMw: engineBuildingData('WindTurbine').outputMw!
  },
  [PowerPlantType.Solar]: {
    id: PowerPlantType.Solar,
    name: 'Solar Farm',
    outputMw: engineBuildingData('SolarFarm').outputMw!
  }
};

/**
 * The HUD/toolbar display cost for every `Tool`, read from
 * `templateData.json`'s `toolCost` — generated from Rust's own `tool_cost`
 * (`crates/city-sim-core/src/commands.rs`), the function that actually
 * charges the player. `BUILD_COST` used to be a hand-typed literal table
 * `tool_cost` was copied from by hand; now there is exactly one number per
 * tool, and Rust owns it.
 */
export const BUILD_COST: Record<Tool, number> = Object.fromEntries(
  (Object.keys(Tool) as (keyof typeof Tool)[]).map((key) => [Tool[key], engineToolCost(key)])
) as Record<Tool, number>;

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
