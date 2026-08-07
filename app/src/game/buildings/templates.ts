// templates.ts — static BuildingTemplate data for zones, civic buildings, and power plants.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { BUILD_COST, POWER_PLANT_CONFIGS, PowerPlantType } from '../constants';
import { Tool } from '../toolTypes';
import { ServiceId } from '../services';
import { engineBuildingData } from './templateData';

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

/**
 * A static building's display + numeric spec. `footprint`, `cost`,
 * `maintenance`, `powerUse`, `waterUse`, `waterOutput`,
 * `populationCapacity`, `jobsCapacity`, and `service.{coverageRadius,
 * capacity}` all come from `templateData.json` (`engineBuildingData`/
 * `BUILD_COST`) — Rust's own numbers, not a second hand-typed copy of them.
 * What's left hand-authored below is display-only: `name`, `colour`,
 * `spriteKey`, `category` (`LedgerGroup`), and the `requiresPower`/
 * `requiresWater` capability flags.
 */
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

const hydroData = engineBuildingData('HydroPlant');
const coalData = engineBuildingData('CoalPlant');
const windData = engineBuildingData('WindTurbine');
const solarData = engineBuildingData('SolarFarm');

export const POWER_PLANT_TEMPLATES: Record<PowerPlantType, BuildingTemplate> = {
  [PowerPlantType.Hydro]: {
    id: PowerPlantType.Hydro,
    name: POWER_PLANT_CONFIGS[PowerPlantType.Hydro].name,
    category: LedgerGroup.Power,
    footprint: hydroData.footprint,
    cost: BUILD_COST[Tool.HydroPlant],
    maintenance: hydroData.maintenance,
    kind: BuildingKind.HydroPlant,
    colour: 0x50d1ff,
    requiresPower: false,
    power: { type: PowerPlantType.Hydro, outputMw: POWER_PLANT_CONFIGS[PowerPlantType.Hydro].outputMw }
  },
  [PowerPlantType.Coal]: {
    id: PowerPlantType.Coal,
    name: POWER_PLANT_CONFIGS[PowerPlantType.Coal].name,
    category: LedgerGroup.Power,
    footprint: coalData.footprint,
    cost: BUILD_COST[Tool.CoalPlant],
    maintenance: coalData.maintenance,
    kind: BuildingKind.CoalPlant,
    colour: 0x888888,
    requiresPower: false,
    power: { type: PowerPlantType.Coal, outputMw: POWER_PLANT_CONFIGS[PowerPlantType.Coal].outputMw }
  },
  [PowerPlantType.Wind]: {
    id: PowerPlantType.Wind,
    name: POWER_PLANT_CONFIGS[PowerPlantType.Wind].name,
    category: LedgerGroup.Power,
    footprint: windData.footprint,
    cost: BUILD_COST[Tool.WindTurbine],
    maintenance: windData.maintenance,
    kind: BuildingKind.WindTurbine,
    colour: 0xddeeff,
    requiresPower: false,
    power: { type: PowerPlantType.Wind, outputMw: POWER_PLANT_CONFIGS[PowerPlantType.Wind].outputMw }
  },
  [PowerPlantType.Solar]: {
    id: PowerPlantType.Solar,
    name: POWER_PLANT_CONFIGS[PowerPlantType.Solar].name,
    category: LedgerGroup.Power,
    footprint: solarData.footprint,
    cost: BUILD_COST[Tool.SolarFarm],
    maintenance: solarData.maintenance,
    kind: BuildingKind.SolarFarm,
    colour: 0xffdd44,
    requiresPower: false,
    power: { type: PowerPlantType.Solar, outputMw: POWER_PLANT_CONFIGS[PowerPlantType.Solar].outputMw }
  }
};

const waterPumpData = engineBuildingData('WaterPump');
const waterTowerData = engineBuildingData('WaterTower');
const parkData = engineBuildingData('Park');
const parkLargeData = engineBuildingData('ParkLarge');
const elemSchoolData = engineBuildingData('ElementarySchool');
const highSchoolData = engineBuildingData('HighSchool');

export const CIVIC_BUILDING_TEMPLATES: Record<string, BuildingTemplate> = {
  [BuildingKind.WaterPump]: {
    id: BuildingKind.WaterPump,
    name: 'Water Pump',
    category: LedgerGroup.Civic,
    footprint: waterPumpData.footprint,
    cost: BUILD_COST[Tool.WaterPump],
    maintenance: waterPumpData.maintenance,
    kind: BuildingKind.WaterPump,
    colour: 0x4ac6b7,
    requiresPower: true,
    waterOutput: waterPumpData.waterOutput
  },
  [BuildingKind.WaterTower]: {
    id: BuildingKind.WaterTower,
    name: 'Water Tower',
    category: LedgerGroup.Civic,
    footprint: waterTowerData.footprint,
    cost: BUILD_COST[Tool.WaterTower],
    maintenance: waterTowerData.maintenance,
    kind: BuildingKind.WaterTower,
    colour: 0x94d1ff,
    requiresPower: true,
    waterOutput: waterTowerData.waterOutput
  },
  [BuildingKind.Park]: {
    id: BuildingKind.Park,
    name: 'Small Park',
    category: LedgerGroup.Civic,
    footprint: parkData.footprint,
    cost: BUILD_COST[Tool.Park],
    maintenance: parkData.maintenance,
    kind: BuildingKind.Park,
    colour: 0x2fa05a,
    requiresPower: false
  },
  [BuildingKind.ParkLarge]: {
    id: BuildingKind.ParkLarge,
    name: 'Large Park',
    category: LedgerGroup.Civic,
    footprint: parkLargeData.footprint,
    cost: BUILD_COST[Tool.ParkLarge],
    maintenance: parkLargeData.maintenance,
    kind: BuildingKind.ParkLarge,
    colour: 0x2fa05a,
    requiresPower: false
  },
  [BuildingKind.ElementarySchool]: {
    id: BuildingKind.ElementarySchool,
    name: 'Elementary School',
    category: LedgerGroup.Civic,
    footprint: elemSchoolData.footprint,
    cost: BUILD_COST[Tool.ElementarySchool],
    maintenance: elemSchoolData.maintenance,
    kind: BuildingKind.ElementarySchool,
    colour: 0x6aa7ff,
    requiresPower: true,
    powerUse: elemSchoolData.powerUse,
    service: {
      id: ServiceId.EducationElementary,
      coverageRadius: elemSchoolData.service!.radius,
      capacity: elemSchoolData.service!.capacity
    }
  },
  [BuildingKind.HighSchool]: {
    id: BuildingKind.HighSchool,
    name: 'High School',
    category: LedgerGroup.Civic,
    footprint: highSchoolData.footprint,
    cost: BUILD_COST[Tool.HighSchool],
    maintenance: highSchoolData.maintenance,
    kind: BuildingKind.HighSchool,
    colour: 0x8f7bff,
    requiresPower: true,
    powerUse: highSchoolData.powerUse,
    service: {
      id: ServiceId.EducationHigh,
      coverageRadius: highSchoolData.service!.radius,
      capacity: highSchoolData.service!.capacity
    }
  }
};

const residentialData = engineBuildingData('Residential');
const commercialData = engineBuildingData('Commercial');
const industrialData = engineBuildingData('Industrial');

export const ZONE_BUILDING_TEMPLATES: Record<string, BuildingTemplate> = {
  [BuildingKind.Residential]: {
    id: 'zone-residential',
    name: 'Residential Lot',
    category: LedgerGroup.Zone,
    footprint: residentialData.footprint,
    cost: BUILD_COST[Tool.Residential],
    maintenance: residentialData.maintenance,
    kind: BuildingKind.Residential,
    requiresPower: true,
    powerUse: residentialData.powerUse,
    waterUse: residentialData.waterUse,
    populationCapacity: residentialData.populationCapacity
  },
  [BuildingKind.Commercial]: {
    id: 'zone-commercial',
    name: 'Commercial Lot',
    category: LedgerGroup.Zone,
    footprint: commercialData.footprint,
    cost: BUILD_COST[Tool.Commercial],
    maintenance: commercialData.maintenance,
    kind: BuildingKind.Commercial,
    requiresPower: true,
    powerUse: commercialData.powerUse,
    waterUse: commercialData.waterUse,
    jobsCapacity: commercialData.jobsCapacity
  },
  [BuildingKind.Industrial]: {
    id: 'zone-industrial',
    name: 'Industrial Lot',
    category: LedgerGroup.Zone,
    footprint: industrialData.footprint,
    cost: BUILD_COST[Tool.Industrial],
    maintenance: industrialData.maintenance,
    kind: BuildingKind.Industrial,
    requiresPower: true,
    powerUse: industrialData.powerUse,
    waterUse: industrialData.waterUse,
    jobsCapacity: industrialData.jobsCapacity
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
