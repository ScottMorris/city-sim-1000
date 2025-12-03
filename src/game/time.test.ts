import { describe, expect, it } from 'vitest';
import { DAYS_PER_MONTH, getCalendarPosition } from './time';

describe('getCalendarPosition', () => {
  it('maps the first day to month 1, day 1', () => {
    const calendar = getCalendarPosition(1);
    expect(calendar.month).toBe(1);
    expect(calendar.dayOfMonth).toBe(1);
  });

  it('rolls to the next month after 30 days', () => {
    const endOfFirst = getCalendarPosition(DAYS_PER_MONTH);
    expect(endOfFirst.month).toBe(1);
    expect(endOfFirst.dayOfMonth).toBe(DAYS_PER_MONTH);

    const startOfSecond = getCalendarPosition(DAYS_PER_MONTH + 1);
    expect(startOfSecond.month).toBe(2);
    expect(startOfSecond.dayOfMonth).toBe(1);
  });

  it('handles fractional days by flooring the day-of-month', () => {
    const midMonth = getCalendarPosition(45.2);
    expect(midMonth.month).toBe(2);
    expect(midMonth.dayOfMonth).toBe(15);
  });
});
