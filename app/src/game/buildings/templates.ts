// templates.ts — static BuildingTemplate data for zones, civic buildings, and power plants.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { BUILD_COST, POWER_PLANT_CONFIGS, PowerPlantType } from '../constants';
import { Tool } from '../toolTypes';
import { ServiceId } from '../services';

/**
 * The coarse power/civic/zone bucket a template's upkeep lands in — the same
 * trio the engine's budget ledger reports (`economy.rs`'s maintenance
 * breakdown) and the debug/bylaw UI groups by. Distinct from Rust's
 * `BuildingCategory` (`city-sim-protocol`'s `building_kind.rs`), the precise
 * seven-member domain taxonomy carried in a `BuildingKind`'s high nibble —
 * `Water`/`Education`/`Recreation` all land in `Civic` here.
 */
export enum LedgerGroup {
  Power = 'power',
  Civic = 'civic',
  Zone = 'zone'
}

/**
 * Which static building this template is — the live, renderer/gameplay-facing
 * identity a `BuildingTemplate` carries, as opposed to `id` (the save/MCP/
 * `Tool`-compatible lookup key; identical in value to the corresponding
 * member here for every template except the three zone lots, whose `id`
 * carries a `zone-` prefix `BuildingKind` never did). Deliberately its own
 * enum rather than a reuse of `TileKind`: `TileKind` is frozen legacy-save
 * vocabulary now (`docs/tile-model.md`), and every member's string value is
 * copied from it once, on purpose, so today's save/MCP spelling doesn't move.
 */
export enum BuildingKind {
  HydroPlant = 'hydro',
  CoalPlant = 'coal',
  WindTurbine = 'wind',
  SolarFarm = 'solar',
  WaterPump = 'pump',
  WaterTower = 'water_tower',
  Park = 'park',
  ParkLarge = 'park_large',
  ElementarySchool = 'elementary_school',
  HighSchool = 'high_school',
  Residential = 'residential',
  Commercial = 'commercial',
  Industrial = 'industrial'
}

export interface BuildingTemplate {
  id: string;
  name: string;
  category: LedgerGroup;
  footprint: { width: number; height: number };
  cost: number;
  maintenance: number;
  kind: BuildingKind;
  spriteKey?: string;
  requiresPower?: boolean;
  requiresWater?: boolean;
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
  /** Flat-colour fallback for the renderer's structure ladder rung
   *  (`dominantColour`/`minimapBaseColour` in `rendering/tileRenderUtils.ts`/
   *  `ui/minimap.ts`) — the display colour a live instance of this template
   *  paints when no sprite has resolved for its tile. Zone templates leave
   *  this unset: a developed lot's occupant is a zone tag, not `Structure`
   *  (see `isDevelopedZone`), so the structure rung never looks at their
   *  colour — the zone rung reads `OCCUPANT_COLOURS` instead. */
  colour?: number;
}

export const POWER_PLANT_TEMPLATES: Record<PowerPlantType, BuildingTemplate> = {
  [PowerPlantType.Hydro]: {
    id: PowerPlantType.Hydro,
    name: POWER_PLANT_CONFIGS[PowerPlantType.Hydro].name,
    category: LedgerGroup.Power,
    footprint: POWER_PLANT_CONFIGS[PowerPlantType.Hydro].footprint,
    cost: POWER_PLANT_CONFIGS[PowerPlantType.Hydro].buildCost,
    maintenance: POWER_PLANT_CONFIGS[PowerPlantType.Hydro].maintenancePerDay,
    kind: BuildingKind.HydroPlant,
    colour: 0x50d1ff,
    requiresPower: false,
    power: { type: PowerPlantType.Hydro, outputMw: POWER_PLANT_CONFIGS[PowerPlantType.Hydro].outputMw }
  },
  [PowerPlantType.Coal]: {
    id: PowerPlantType.Coal,
    name: POWER_PLANT_CONFIGS[PowerPlantType.Coal].name,
    category: LedgerGroup.Power,
    footprint: POWER_PLANT_CONFIGS[PowerPlantType.Coal].footprint,
    cost: POWER_PLANT_CONFIGS[PowerPlantType.Coal].buildCost,
    maintenance: POWER_PLANT_CONFIGS[PowerPlantType.Coal].maintenancePerDay,
    kind: BuildingKind.CoalPlant,
    colour: 0x888888,
    requiresPower: false,
    power: { type: PowerPlantType.Coal, outputMw: POWER_PLANT_CONFIGS[PowerPlantType.Coal].outputMw }
  },
  [PowerPlantType.Wind]: {
    id: PowerPlantType.Wind,
    name: POWER_PLANT_CONFIGS[PowerPlantType.Wind].name,
    category: LedgerGroup.Power,
    footprint: POWER_PLANT_CONFIGS[PowerPlantType.Wind].footprint,
    cost: POWER_PLANT_CONFIGS[PowerPlantType.Wind].buildCost,
    maintenance: POWER_PLANT_CONFIGS[PowerPlantType.Wind].maintenancePerDay,
    kind: BuildingKind.WindTurbine,
    colour: 0xddeeff,
    requiresPower: false,
    power: { type: PowerPlantType.Wind, outputMw: POWER_PLANT_CONFIGS[PowerPlantType.Wind].outputMw }
  },
  [PowerPlantType.Solar]: {
    id: PowerPlantType.Solar,
    name: POWER_PLANT_CONFIGS[PowerPlantType.Solar].name,
    category: LedgerGroup.Power,
    footprint: POWER_PLANT_CONFIGS[PowerPlantType.Solar].footprint,
    cost: POWER_PLANT_CONFIGS[PowerPlantType.Solar].buildCost,
    maintenance: POWER_PLANT_CONFIGS[PowerPlantType.Solar].maintenancePerDay,
    kind: BuildingKind.SolarFarm,
    colour: 0xffdd44,
    requiresPower: false,
    power: { type: PowerPlantType.Solar, outputMw: POWER_PLANT_CONFIGS[PowerPlantType.Solar].outputMw }
  }
};

export const CIVIC_BUILDING_TEMPLATES: Record<string, BuildingTemplate> = {
  [BuildingKind.WaterPump]: {
    id: BuildingKind.WaterPump,
    name: 'Water Pump',
    category: LedgerGroup.Civic,
    footprint: { width: 1, height: 1 },
    cost: BUILD_COST[Tool.WaterPump],
    maintenance: 5,
    kind: BuildingKind.WaterPump,
    colour: 0x4ac6b7,
    requiresPower: true,
    waterOutput: 50
  },
  [BuildingKind.WaterTower]: {
    id: BuildingKind.WaterTower,
    name: 'Water Tower',
    category: LedgerGroup.Civic,
    footprint: { width: 2, height: 2 },
    cost: BUILD_COST[Tool.WaterTower],
    maintenance: 12,
    kind: BuildingKind.WaterTower,
    colour: 0x94d1ff,
    requiresPower: true,
    waterOutput: 120
  },
  [BuildingKind.Park]: {
    id: BuildingKind.Park,
    name: 'Small Park',
    category: LedgerGroup.Civic,
    footprint: { width: 1, height: 1 },
    cost: 10,
    maintenance: 0.05,
    kind: BuildingKind.Park,
    colour: 0x2fa05a,
    requiresPower: false
  },
  [BuildingKind.ParkLarge]: {
    id: BuildingKind.ParkLarge,
    name: 'Large Park',
    category: LedgerGroup.Civic,
    footprint: { width: 2, height: 2 },
    cost: 32,
    maintenance: 0.16,
    kind: BuildingKind.ParkLarge,
    colour: 0x2fa05a,
    requiresPower: false
  },
  [BuildingKind.ElementarySchool]: {
    id: BuildingKind.ElementarySchool,
    name: 'Elementary School',
    category: LedgerGroup.Civic,
    footprint: { width: 2, height: 2 },
    cost: BUILD_COST[Tool.ElementarySchool],
    maintenance: 40,
    kind: BuildingKind.ElementarySchool,
    colour: 0x6aa7ff,
    requiresPower: true,
    powerUse: 4,
    service: { id: ServiceId.EducationElementary, coverageRadius: 8, capacity: 180 }
  },
  [BuildingKind.HighSchool]: {
    id: BuildingKind.HighSchool,
    name: 'High School',
    category: LedgerGroup.Civic,
    footprint: { width: 2, height: 2 },
    cost: BUILD_COST[Tool.HighSchool],
    maintenance: 55,
    kind: BuildingKind.HighSchool,
    colour: 0x8f7bff,
    requiresPower: true,
    powerUse: 5,
    service: { id: ServiceId.EducationHigh, coverageRadius: 9, capacity: 160 }
  }
};

export const ZONE_BUILDING_TEMPLATES: Record<string, BuildingTemplate> = {
  [BuildingKind.Residential]: {
    id: 'zone-residential',
    name: 'Residential Lot',
    category: LedgerGroup.Zone,
    footprint: { width: 1, height: 1 },
    cost: BUILD_COST[Tool.Residential],
    maintenance: 1,
    kind: BuildingKind.Residential,
    requiresPower: true,
    powerUse: 1.5,
    waterUse: 1,
    populationCapacity: 14
  },
  [BuildingKind.Commercial]: {
    id: 'zone-commercial',
    name: 'Commercial Lot',
    category: LedgerGroup.Zone,
    footprint: { width: 1, height: 1 },
    cost: BUILD_COST[Tool.Commercial],
    maintenance: 1.2,
    kind: BuildingKind.Commercial,
    requiresPower: true,
    powerUse: 2.5,
    waterUse: 1.5,
    jobsCapacity: 8
  },
  [BuildingKind.Industrial]: {
    id: 'zone-industrial',
    name: 'Industrial Lot',
    category: LedgerGroup.Zone,
    footprint: { width: 1, height: 1 },
    cost: BUILD_COST[Tool.Industrial],
    maintenance: 1.4,
    kind: BuildingKind.Industrial,
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

export function getBuildingTemplate(templateId: string): BuildingTemplate | undefined {
  return STATIC_BUILDING_TEMPLATES[templateId];
}

/**
 * The HUD/toolbar display cost for `tool` — a building's template cost where
 * one exists (power plants, civic buildings, zones), else the flat
 * `BUILD_COST` entry for terrain/transport/utility tools. Placement itself
 * (and the real cost charged) happens in the Rust engine
 * (`crates/city-sim-core/src/commands.rs`); this is display-only.
 */
export function getToolCost(tool: Tool): number {
  const templateCost = getBuildingTemplate(tool)?.cost;
  if (templateCost !== undefined) return templateCost;
  return BUILD_COST[tool] ?? 0;
}
