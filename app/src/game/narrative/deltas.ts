import type { CityDeltas, CitySnapshot } from './types';

const sign = (value: number) => (value > 0 ? 1 : value < 0 ? -1 : 0);

export function computeDeltas(
  prev: CitySnapshot | undefined,
  next: CitySnapshot
): CityDeltas {
  if (!prev) {
    return {
      cash: 0,
      netPerMonth: 0,
      runwayMonths: 0,
      pop: 0,
      jobs: 0,
      abandonedCount: 0,
      powerBalance: 0
    };
  }

  const prevSign = sign(prev.economy.netPerMonth);
  const nextSign = sign(next.economy.netPerMonth);
  const netPerMonthFlip =
    prevSign !== 0 && nextSign !== 0 && prevSign !== nextSign
      ? nextSign > 0
        ? 'negative_to_positive'
        : 'positive_to_negative'
      : undefined;

  return {
    cash: next.economy.cash - prev.economy.cash,
    netPerMonth: next.economy.netPerMonth - prev.economy.netPerMonth,
    runwayMonths: next.economy.runwayMonths - prev.economy.runwayMonths,
    pop: next.population.pop - prev.population.pop,
    jobs: next.population.jobs - prev.population.jobs,
    abandonedCount: next.map.abandonedCount - prev.map.abandonedCount,
    powerBalance: next.utilities.powerBalance - prev.utilities.powerBalance,
    netPerMonthFlip
  };
}
