import { BuildingCategory, BuildingStatus, getBuildingTemplate } from './buildings';
import type { GameState } from './gameState';
import {
  applyLightingPolicy,
  DEFAULT_BYLAWS,
  type LightingBaseStats,
  type LightingBylaw
} from './bylaws';

export function computeLightingBaseStats(state: GameState): LightingBaseStats {
  const base: LightingBaseStats = {
    powerUseCivic: 0,
    powerUseZones: 0,
    maintenanceCivic: 0,
    maintenanceZones: 0
  };

  for (const building of state.buildings) {
    const template = getBuildingTemplate(building.templateId);
    if (!template) continue;
    if (template.category === BuildingCategory.Power) continue;

    if (template.maintenance) {
      if (template.category === BuildingCategory.Civic) base.maintenanceCivic += template.maintenance;
      if (template.category === BuildingCategory.Zone) base.maintenanceZones += template.maintenance;
    }

    const isActive = building.state.status === BuildingStatus.Active;
    if (!isActive) continue;

    if (template.powerUse) {
      if (template.category === BuildingCategory.Civic) base.powerUseCivic += template.powerUse;
      if (template.category === BuildingCategory.Zone) base.powerUseZones += template.powerUse;
    }
  }

  return base;
}

export function projectLightingPolicy(state: GameState, lighting: LightingBylaw) {
  const base = computeLightingBaseStats(state);
  const currentLighting = state.bylaws?.lighting ?? DEFAULT_BYLAWS.lighting;
  const current = applyLightingPolicy(base, currentLighting);
  const next = applyLightingPolicy(base, lighting);
  const basePowerUse = base.powerUseCivic + base.powerUseZones;
  const baseMaintenance = base.maintenanceCivic + base.maintenanceZones;

  return {
    basePowerUse,
    baseMaintenance,
    current,
    next,
    deltaPowerUse: next.powerUse - current.powerUse,
    deltaMaintenance: next.maintenance - current.maintenance
  };
}
