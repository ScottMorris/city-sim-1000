// economy.ts — budget-history bucketing (recent months, quarter summary) and runway estimation.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { GameState } from './gameState';
import { getCalendarPosition, DAYS_PER_MONTH } from './time';

export const MONTHS_PER_QUARTER = 3;

/**
 * `#229`: mirrors `city_sim_core::state::BudgetHistoryEntry` exactly. Rust
 * is the sole source now — the ring buffer, its 200-day cap, and the
 * day-boundary dedup this used to need client-side all live in
 * `economy::record_daily_budget`; the wire's `budgetHistory` array is
 * adopted verbatim by both bridges, see `wasmSimBridge.ts`/`tauriSimBridge.ts`.
 */
export interface BudgetHistoryEntry {
  day: number;
  revenue: number;
  expenses: number;
  net: number;
}

export interface BudgetBucket {
  label: string;
  revenue: number;
  expenses: number;
  net: number;
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
  const daily = state.budgetHistory ?? [];
  const currentMonth = getCalendarPosition(state.day).month;
  const months: BudgetBucket[] = [];
  for (let i = 0; i < MONTHS_PER_QUARTER; i++) {
    const monthNumber = currentMonth - i;
    if (monthNumber < 1) break;
    const startDay = (monthNumber - 1) * DAYS_PER_MONTH + 1;
    const endDay = monthNumber * DAYS_PER_MONTH;
    const bucket = sumBucket(daily, startDay, endDay);
    const label = `Month ${monthNumber}`;
    months.push({ ...bucket, label });
  }
  return months;
}

export function getQuarterSummary(state: GameState): BudgetBucket {
  const daily = state.budgetHistory ?? [];
  const endDay = Math.floor(state.day);
  const startDay = Math.max(1, endDay - DAYS_PER_MONTH * MONTHS_PER_QUARTER + 1);
  const bucket = sumBucket(daily, startDay, endDay);
  return { ...bucket, label: `Last ${MONTHS_PER_QUARTER} months` };
}

export function computeRunwayDays(money: number, netPerDay: number): number {
  if (netPerDay >= 0) return Number.POSITIVE_INFINITY;
  if (money <= 0) return 0;
  return money / Math.abs(netPerDay);
}
