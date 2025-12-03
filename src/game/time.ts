export const DAYS_PER_MONTH = 30;

export function getCalendarPosition(dayCount: number) {
  const zeroBasedDay = Math.max(0, dayCount - 1);
  const month = Math.floor(zeroBasedDay / DAYS_PER_MONTH) + 1;
  const dayOfMonth = (Math.floor(zeroBasedDay) % DAYS_PER_MONTH) + 1;
  return { month, dayOfMonth };
}
