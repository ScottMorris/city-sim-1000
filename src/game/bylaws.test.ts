import { describe, expect, it } from 'vitest';
import { projectLightingPolicy } from './bylawAnalytics';
import { DEFAULT_BYLAWS, applyLightingPolicy } from './bylaws';
import { createInitialState } from './gameState';
import { BuildingStatus, createBuildingState, getBuildingTemplate } from './buildings';
import { TileKind } from './gameState';

describe('bylaws', () => {
  it('scales base stats with lighting multipliers', () => {
    const result = applyLightingPolicy(
      {
        powerUseCivic: 8,
        powerUseZones: 4,
        maintenanceCivic: 50,
        maintenanceZones: 10
      },
      'efficient'
    );

    expect(result.powerUse).toBeCloseTo((8 + 4) * 0.82, 5);
    expect(result.maintenance).toBeCloseTo((50 + 10) * 0.9, 5);
    expect(result.powerUseDelta).toBeCloseTo(result.powerUse - 12, 5);
    expect(result.maintenanceDelta).toBeCloseTo(result.maintenance - 60, 5);
  });

  it('projects lighting policy deltas against the active bylaw', () => {
    const state = createInitialState(8, 8);
    state.bylaws = { ...DEFAULT_BYLAWS };
    const residentialTemplate = getBuildingTemplate(TileKind.Residential);
    const highSchoolTemplate = getBuildingTemplate(TileKind.HighSchool);
    if (!residentialTemplate || !highSchoolTemplate) {
      throw new Error('Missing templates for lighting projection test');
    }

    state.buildings.push(
      {
        id: 1,
        templateId: residentialTemplate.id,
        origin: { x: 1, y: 1 },
        state: { ...createBuildingState(), status: BuildingStatus.Active }
      },
      {
        id: 2,
        templateId: highSchoolTemplate.id,
        origin: { x: 3, y: 3 },
        state: { ...createBuildingState(), status: BuildingStatus.Active }
      }
    );

    const projection = projectLightingPolicy(state, 'efficient');
    expect(projection.deltaPowerUse).toBeLessThan(0);
    expect(projection.deltaMaintenance).toBeLessThan(0);

    const heritageProjection = projectLightingPolicy(state, 'carbonArc');
    expect(heritageProjection.deltaPowerUse).toBeGreaterThan(0);
    expect(heritageProjection.deltaMaintenance).toBeGreaterThan(0);
  });
});
