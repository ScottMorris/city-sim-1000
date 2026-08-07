// snapshot.ts — assembles a periodic CitySnapshot for the narrative layer.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// Population capacity/labour rates, abandoned-tile count, and mean happiness
// used to be recomputed here from a TS shadow of the engine (a per-building
// capacity walk, `computeLabourStats.ts`, a per-tile loop) — all four now
// come straight off the wire (`state.labour`, `state.abandonedCount`,
// `state.avgHappiness`; `#200`'s wire-adoption follow-up).

import { getCalendarPosition } from '../time';
import type { GameState } from '../gameState';
import type { CitySnapshot } from './types';

const RUNWAY_CAP_MONTHS = 99;

function computeRunwayMonths(money: number, netPerMonth: number) {
  if (netPerMonth >= 0) return RUNWAY_CAP_MONTHS;
  if (money <= 0) return 0;
  return Math.min(RUNWAY_CAP_MONTHS, money / Math.abs(netPerMonth));
}

export function buildCitySnapshot(state: GameState): CitySnapshot {
  const calendar = getCalendarPosition(state.day);
  const year = Math.floor((calendar.month - 1) / 12) + 1;

  return {
    time: {
      day: calendar.dayOfMonth,
      month: calendar.month,
      year
    },
    economy: {
      cash: state.money,
      netPerMonth: state.budget?.netPerMonth ?? 0,
      runwayMonths: computeRunwayMonths(state.money, state.budget?.netPerMonth ?? 0),
      revenue: state.budget?.revenue ?? 0,
      expenses: state.budget?.expenses ?? 0,
      breakdown: {
        revenue: {
          base: state.budget?.breakdown.revenue.base ?? 0,
          residents: state.budget?.breakdown.revenue.residents ?? 0,
          commercial: state.budget?.breakdown.revenue.commercial ?? 0,
          industrial: state.budget?.breakdown.revenue.industrial ?? 0
        },
        expenses: {
          transport: state.budget?.breakdown.expenses.transport ?? 0,
          buildings: state.budget?.breakdown.expenses.buildings ?? 0
        }
      }
    },
    population: {
      pop: state.population,
      jobs: state.jobs,
      unemploymentRate: state.labour.unemploymentRate,
      vacancyRate: state.labour.vacancyRate
    },
    demand: {
      residential: state.demand.residential,
      commercial: state.demand.commercial,
      industrial: state.demand.industrial
    },
    utilities: {
      powerProduced: state.utilities.powerProduced,
      powerUsed: state.utilities.powerUsed,
      powerBalance: state.utilities.power
    },
    map: {
      abandonedCount: state.abandonedCount,
      avgHappiness: state.avgHappiness
    }
  };
}
