import { getCalendarPosition } from '../time';
import { BuildingStatus } from '../buildings/state';
import { BuildingCategory, getBuildingTemplate } from '../buildings/templates';
import type { GameState } from '../gameState';
import { computeLabourStats } from '../computeLabourStats';
import type { CitySnapshot } from './types';

const RUNWAY_CAP_MONTHS = 99;

function computeCapacities(state: GameState) {
  let populationCapacity = 0;
  let jobCapacity = 0;

  for (const building of state.buildings) {
    const template = getBuildingTemplate(building.templateId);
    if (!template) continue;
    const isActive = building.state.status === BuildingStatus.Active;
    const contributesCapacity =
      isActive ||
      (template.category === BuildingCategory.Zone &&
        (building.state.status === BuildingStatus.InactiveNoPower ||
          building.state.status === BuildingStatus.InactiveNoWater));
    if (!contributesCapacity) continue;
    if (template.populationCapacity) populationCapacity += template.populationCapacity;
    if (template.jobsCapacity) jobCapacity += template.jobsCapacity;
  }

  return { populationCapacity, jobCapacity };
}

function computeRunwayMonths(money: number, netPerMonth: number) {
  if (netPerMonth >= 0) return RUNWAY_CAP_MONTHS;
  if (money <= 0) return 0;
  return Math.min(RUNWAY_CAP_MONTHS, money / Math.abs(netPerMonth));
}

export function buildCitySnapshot(state: GameState): CitySnapshot {
  const calendar = getCalendarPosition(state.day);
  const year = Math.floor((calendar.month - 1) / 12) + 1;
  const { populationCapacity, jobCapacity } = computeCapacities(state);
  const labourStats = computeLabourStats(state.population, populationCapacity, jobCapacity);
  const tiles = state.tiles;
  let abandonedCount = 0;
  let happinessTotal = 0;

  for (const tile of tiles) {
    if (tile.abandoned) abandonedCount += 1;
    happinessTotal += tile.happiness ?? 0;
  }

  return {
    time: {
      day: calendar.dayOfMonth,
      month: calendar.month,
      year
    },
    economy: {
      cash: state.money,
      netPerMonth: state.budget?.netPerMonth ?? 0,
      runwayMonths: computeRunwayMonths(state.money, state.budget?.netPerMonth ?? 0)
    },
    population: {
      pop: state.population,
      jobs: state.jobs,
      unemploymentRate: labourStats.unemploymentRate,
      vacancyRate: labourStats.vacancyRate
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
      abandonedCount,
      avgHappiness: tiles.length > 0 ? happinessTotal / tiles.length : 0
    }
  };
}
