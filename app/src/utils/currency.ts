/** Formats a dollar amount: whole dollars with thousands separators at $100+, 2 decimals below that. */
export function formatCurrency(value: number, opts: { signed?: boolean } = {}): string {
  const { signed = false } = opts;
  const abs = Math.abs(value);
  const formatted = abs >= 100 ? Math.round(abs).toLocaleString() : abs.toFixed(2);
  const sign = signed ? (value > 0 ? '+' : value < 0 ? '-' : '') : '';
  return `${sign}$${formatted}`;
}
