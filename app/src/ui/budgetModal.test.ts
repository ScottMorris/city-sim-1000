// budgetModal.test.ts — deriveBudgetBreakdown groups WireBudgetStats' flat fields correctly.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { createDefaultBudgetStats } from '../game/gameState';
import { PowerPlantType } from '../game/constants';
import { BuildingKind } from '../game/buildings/templates';
import { deriveBudgetBreakdown } from './budgetModal';

describe('deriveBudgetBreakdown', () => {
  it('groups the flat wire fields into the nested revenue/expenses/details shape', () => {
    const budget = {
      ...createDefaultBudgetStats(),
      revenueBase: 100,
      revenuePop: 200,
      revenueCommercial: 300,
      revenueIndustrial: 400,
      revenueTourism: 50,
      expensesTransport: 10,
      expensesBuildings: 20,
      expensesPolicies: 5,
      maintRoads: 1,
      maintRail: 2,
      maintPowerLines: 3,
      maintPipes: 4,
      maintPower: 30,
      maintCivic: 40,
      maintZones: 50
    };

    const breakdown = deriveBudgetBreakdown(budget);

    expect(breakdown.revenue).toEqual({
      base: 100,
      residents: 200,
      commercial: 300,
      industrial: 400,
      tourism: 50
    });
    expect(breakdown.expenses).toEqual({ transport: 10, buildings: 20, policies: 5 });
    expect(breakdown.details.transport).toEqual({ roads: 1, rail: 2, powerLines: 3, waterPipes: 4 });
    expect(breakdown.details.buildings.power).toBe(30);
    expect(breakdown.details.buildings.civic).toBe(40);
    expect(breakdown.details.buildings.zones).toBe(50);
  });

  it('groups per-type maintenance into the powerByType/civicByType/zonesByType maps — the display grouping the mirror no longer carries', () => {
    const budget = {
      ...createDefaultBudgetStats(),
      maintPowerHydro: 11,
      maintPowerCoal: 22,
      maintPowerWind: 33,
      maintPowerSolar: 44,
      maintCivicPark: 5,
      maintCivicPump: 6,
      maintCivicTower: 7,
      maintCivicSchool: 8,
      maintZonesRes: 9,
      maintZonesCom: 10,
      maintZonesInd: 12
    };

    const breakdown = deriveBudgetBreakdown(budget);

    expect(breakdown.details.buildings.powerByType).toEqual({
      [PowerPlantType.Hydro]: 11,
      [PowerPlantType.Coal]: 22,
      [PowerPlantType.Wind]: 33,
      [PowerPlantType.Solar]: 44
    });
    expect(breakdown.details.buildings.civicByType).toEqual({
      [BuildingKind.Park]: 5,
      [BuildingKind.WaterPump]: 6,
      [BuildingKind.WaterTower]: 7,
      school: 8
    });
    expect(breakdown.details.buildings.zonesByType).toEqual({
      [BuildingKind.Residential]: 9,
      [BuildingKind.Commercial]: 10,
      [BuildingKind.Industrial]: 12
    });
  });
});
