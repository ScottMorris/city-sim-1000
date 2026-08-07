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

import { getCalendarPosition, DAYS_PER_MONTH } from '../time';
import { computeRunwayDays } from '../economy';
import type { GameState } from '../gameState';
import type { CitySnapshot } from './types';

/** Display cap for the narrative layer's runway figure — `computeRunwayDays` itself is uncapped (an idle city with a tiny deficit can run for years), but nobody needs to read "1,400 months" on a budget card. */
const RUNWAY_CAP_MONTHS = 99;

/** One formula, `computeRunwayDays` (`economy.ts`) — converted to months and capped for display, not a second derivation. */
function computeRunwayMonths(money: number, netPerDay: number): number {
  const days = computeRunwayDays(money, netPerDay);
  if (!Number.isFinite(days)) return RUNWAY_CAP_MONTHS;
  return Math.min(RUNWAY_CAP_MONTHS, days / DAYS_PER_MONTH);
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
      runwayMonths: computeRunwayMonths(state.money, state.budget?.netPerDay ?? 0),
      revenue: state.budget?.revenue ?? 0,
      expenses: state.budget?.expenses ?? 0,
      breakdown: {
        revenue: {
          base: state.budget?.revenueBase ?? 0,
          residents: state.budget?.revenuePop ?? 0,
          commercial: state.budget?.revenueCommercial ?? 0,
          industrial: state.budget?.revenueIndustrial ?? 0
        },
        expenses: {
          transport: state.budget?.expensesTransport ?? 0,
          buildings: state.budget?.expensesBuildings ?? 0
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
