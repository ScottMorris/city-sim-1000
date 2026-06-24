export type LightingBylaw = 'mixed' | 'efficient' | 'carbonArc';

export interface BylawState {
  lighting: LightingBylaw;
}

export const DEFAULT_BYLAWS: BylawState = {
  lighting: 'mixed'
};

export interface LightingPolicyDefinition {
  id: LightingBylaw;
  label: string;
  lede: string;
  powerUseMultiplier: number;
  maintenanceMultiplier: number;
  happinessTarget: number;
}

export const LIGHTING_POLICIES: Record<LightingBylaw, LightingPolicyDefinition> = {
  mixed: {
    id: 'mixed',
    label: 'Mixed corridors',
    lede: 'Blend LED retrofits with heritage lamps to preview demand before carving districts.',
    powerUseMultiplier: 1,
    maintenanceMultiplier: 1,
    happinessTarget: 1.02
  },
  efficient: {
    id: 'efficient',
    label: 'Energy-efficient lighting',
    lede: 'LED-first rollout trims upkeep and power draw for civic and zoned lots.',
    powerUseMultiplier: 0.82,
    maintenanceMultiplier: 0.9,
    happinessTarget: 0.96
  },
  carbonArc: {
    id: 'carbonArc',
    label: 'Carbon-arc lamps',
    lede: 'Nostalgic lamps pull more power but add ambience in busy corridors.',
    powerUseMultiplier: 1.18,
    maintenanceMultiplier: 1.05,
    happinessTarget: 1.12
  }
};

export interface LightingBaseStats {
  powerUseCivic: number;
  powerUseZones: number;
  maintenanceCivic: number;
  maintenanceZones: number;
}

export interface LightingPolicyApplication {
  powerUse: number;
  powerUseDelta: number;
  maintenance: number;
  maintenanceDelta: number;
  maintenanceCivic: number;
  maintenanceZones: number;
  multipliers: {
    powerUse: number;
    maintenance: number;
  };
}

export function getLightingPolicy(id: LightingBylaw): LightingPolicyDefinition {
  return LIGHTING_POLICIES[id];
}

export function applyLightingPolicy(base: LightingBaseStats, bylaw: LightingBylaw): LightingPolicyApplication {
  const policy = getLightingPolicy(bylaw);
  const basePowerUse = base.powerUseCivic + base.powerUseZones;
  const baseMaintenance = base.maintenanceCivic + base.maintenanceZones;

  const adjustedPowerUse =
    base.powerUseCivic * policy.powerUseMultiplier + base.powerUseZones * policy.powerUseMultiplier;
  const adjustedMaintenanceCivic = base.maintenanceCivic * policy.maintenanceMultiplier;
  const adjustedMaintenanceZones = base.maintenanceZones * policy.maintenanceMultiplier;
  const adjustedMaintenance = adjustedMaintenanceCivic + adjustedMaintenanceZones;

  return {
    powerUse: adjustedPowerUse,
    powerUseDelta: adjustedPowerUse - basePowerUse,
    maintenance: adjustedMaintenance,
    maintenanceDelta: adjustedMaintenance - baseMaintenance,
    maintenanceCivic: adjustedMaintenanceCivic,
    maintenanceZones: adjustedMaintenanceZones,
    multipliers: {
      powerUse: policy.powerUseMultiplier,
      maintenance: policy.maintenanceMultiplier
    }
  };
}
