import { GameState } from './gameState';
import { getCalendarPosition, DAYS_PER_MONTH } from './time';

export const BUDGET_HISTORY_LENGTH = 200;
export const MONTHS_PER_QUARTER = 3;

export interface BudgetHistoryEntry {
  day: number;
  revenue: number;
  expenses: number;
  net: number;
}

export interface BudgetHistory {
  daily: BudgetHistoryEntry[];
  lastRecordedDay: number;
}

export interface BudgetBucket {
  label: string;
  revenue: number;
  expenses: number;
  net: number;
}

export function ensureBudgetHistory(state: GameState): BudgetHistory {
  if (!state.budgetHistory) {
    state.budgetHistory = { daily: [], lastRecordedDay: 0 };
  } else {
    state.budgetHistory.daily = state.budgetHistory.daily ?? [];
    state.budgetHistory.lastRecordedDay = state.budgetHistory.lastRecordedDay ?? 0;
  }
  return state.budgetHistory;
}

export function recordDailyBudget(state: GameState) {
  const history = ensureBudgetHistory(state);
  const currentDay = Math.floor(state.day);
  if (currentDay <= history.lastRecordedDay) return;
  const entry: BudgetHistoryEntry = {
    day: currentDay,
    revenue: state.budget.revenue,
    expenses: state.budget.expenses,
    net: state.budget.net
  };
  history.daily.push(entry);
  while (history.daily.length > BUDGET_HISTORY_LENGTH) {
    history.daily.shift();
  }
  history.lastRecordedDay = currentDay;
}

function sumBucket(entries: BudgetHistoryEntry[], startDay: number, endDay: number): BudgetBucket {
  const window = entries.filter((e) => e.day >= startDay && e.day <= endDay);
  const revenue = window.reduce((sum, e) => sum + e.revenue, 0);
  const expenses = window.reduce((sum, e) => sum + e.expenses, 0);
  const net = window.reduce((sum, e) => sum + e.net, 0);
  const label = `${startDay}-${endDay}`;
  return { label, revenue, expenses, net };
}

export function getRecentMonths(state: GameState): BudgetBucket[] {
  const history = ensureBudgetHistory(state);
  const currentMonth = getCalendarPosition(state.day).month;
  const months: BudgetBucket[] = [];
  for (let i = 0; i < MONTHS_PER_QUARTER; i++) {
    const monthNumber = currentMonth - i;
    if (monthNumber < 1) break;
    const startDay = (monthNumber - 1) * DAYS_PER_MONTH + 1;
    const endDay = monthNumber * DAYS_PER_MONTH;
    const bucket = sumBucket(history.daily, startDay, endDay);
    const label = `Month ${monthNumber}`;
    months.push({ ...bucket, label });
  }
  return months;
}

export function getQuarterSummary(state: GameState): BudgetBucket {
  const history = ensureBudgetHistory(state);
  const endDay = Math.floor(state.day);
  const startDay = Math.max(1, endDay - DAYS_PER_MONTH * MONTHS_PER_QUARTER + 1);
  const bucket = sumBucket(history.daily, startDay, endDay);
  return { ...bucket, label: `Last ${MONTHS_PER_QUARTER} months` };
}

export function computeRunwayDays(money: number, netPerDay: number): number {
  if (netPerDay >= 0) return Number.POSITIVE_INFINITY;
  if (money <= 0) return 0;
  return money / Math.abs(netPerDay);
}
