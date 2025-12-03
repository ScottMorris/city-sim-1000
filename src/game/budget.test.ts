import { describe, expect, it } from 'vitest';
import { createInitialState } from './gameState';
import {
  computeRunwayDays,
  ensureBudgetHistory,
  getQuarterSummary,
  getRecentMonths,
  recordDailyBudget
} from './budget';

describe('budget helpers', () => {
  it('records one entry per day and trims history', () => {
    const state = createInitialState();
    ensureBudgetHistory(state);
    state.budget.revenue = 100;
    state.budget.expenses = 50;
    state.budget.net = 50;
    for (let d = 1; d <= 5; d++) {
      state.day = d;
      recordDailyBudget(state);
    }
    expect(state.budgetHistory.daily.length).toBe(5);
    expect(state.budgetHistory.lastRecordedDay).toBe(5);
    const last = state.budgetHistory.daily[state.budgetHistory.daily.length - 1];
    expect(last.day).toBe(5);
    expect(last.net).toBe(50);
  });

  it('summarises last quarter and recent months', () => {
    const state = createInitialState();
    ensureBudgetHistory(state);
    for (let d = 1; d <= 120; d++) {
      state.day = d;
      state.budget.revenue = 100 + d;
      state.budget.expenses = 50;
      state.budget.net = state.budget.revenue - state.budget.expenses;
      recordDailyBudget(state);
    }
    state.day = 120;
    const quarter = getQuarterSummary(state);
    expect(quarter.net).toBeGreaterThan(0);
    const months = getRecentMonths(state);
    expect(months.length).toBeGreaterThan(0);
    expect(months[0].label.startsWith('Month')).toBe(true);
  });

  it('computes runway only when burn is negative', () => {
    expect(computeRunwayDays(1000, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(computeRunwayDays(1000, 10)).toBe(Number.POSITIVE_INFINITY);
    expect(computeRunwayDays(0, -10)).toBe(0);
    expect(computeRunwayDays(100, -20)).toBeCloseTo(5);
  });
});
