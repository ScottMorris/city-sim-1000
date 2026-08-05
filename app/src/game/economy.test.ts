import { describe, expect, it } from 'vitest';
import { createInitialState } from './gameState';
import { computeRunwayDays, getQuarterSummary, getRecentMonths, type BudgetHistoryEntry } from './economy';

// `#229`: the daily-recording/200-day-cap logic this file used to test
// (`recordDailyBudget`/`ensureBudgetHistory`) moved to Rust
// (`economy::record_daily_budget` in `city-sim-core`, covered there) — the
// client now just reads whatever `state.budgetHistory` array the wire
// supplies. These tests build that array by hand instead of driving it
// through a day-by-day client-side recompute.

function entry(day: number, revenue: number, expenses: number): BudgetHistoryEntry {
  return { day, revenue, expenses, net: revenue - expenses };
}

describe('budget helpers', () => {
  it('summarises last quarter and recent months from a wire-sourced budgetHistory array', () => {
    const state = createInitialState();
    state.budgetHistory = [];
    for (let d = 1; d <= 120; d++) {
      state.budgetHistory.push(entry(d, 100 + d, 50));
    }
    state.day = 120;
    const quarter = getQuarterSummary(state);
    expect(quarter.net).toBeGreaterThan(0);
    const months = getRecentMonths(state);
    expect(months.length).toBeGreaterThan(0);
    expect(months[0].label.startsWith('Month')).toBe(true);
  });

  it('treats a missing budgetHistory as empty rather than throwing', () => {
    const state = createInitialState();
    // @ts-expect-error — exercising the `?? []` guard against an absent field
    delete state.budgetHistory;
    state.day = 10;
    expect(getQuarterSummary(state).net).toBe(0);
    expect(getRecentMonths(state).every((m) => m.net === 0 && m.revenue === 0)).toBe(true);
  });

  it('computes runway only when burn is negative', () => {
    expect(computeRunwayDays(1000, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(computeRunwayDays(1000, 10)).toBe(Number.POSITIVE_INFINITY);
    expect(computeRunwayDays(0, -10)).toBe(0);
    expect(computeRunwayDays(100, -20)).toBeCloseTo(5);
  });
});
