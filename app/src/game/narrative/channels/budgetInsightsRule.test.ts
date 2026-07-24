import { describe, expect, it } from 'vitest';
import { formatCurrency } from './budgetInsightsRule';

describe('formatCurrency', () => {
  it('shows 2 decimals under $10', () => {
    expect(formatCurrency(0.52)).toBe('$0.52');
  });

  it('shows 2 decimals for $10-$99.99 (regression for #146)', () => {
    expect(formatCurrency(12.4)).toBe('$12.40');
    expect(formatCurrency(48)).toBe('$48.00');
  });

  it('rounds to whole dollars with thousands separators at $100+', () => {
    expect(formatCurrency(3407, { signed: true })).toBe('+$3,407');
  });

  it('applies a +/- sign only when signed is requested', () => {
    expect(formatCurrency(12.4, { signed: true })).toBe('+$12.40');
    expect(formatCurrency(-12.4, { signed: true })).toBe('-$12.40');
    expect(formatCurrency(-12.4)).toBe('$12.40');
  });
});
