import { describe, it, expect } from 'vitest';
import { computeLabourStats } from './computeLabourStats';

describe('computeLabourStats', () => {
  it('computes balanced labour when jobs exceed workers', () => {
    const stats = computeLabourStats(100, 120, 80);
    expect(stats.workers).toBeCloseTo(55);
    expect(stats.employed).toBeCloseTo(55);
    expect(stats.unemployed).toBeCloseTo(0);
    expect(stats.unemploymentRate).toBeCloseTo(0);
    expect(stats.vacancyRate).toBeCloseTo((80 - 55) / 80);
  });

  it('computes unemployment when workers exceed jobs', () => {
    const stats = computeLabourStats(100, 120, 20);
    expect(stats.employed).toBeCloseTo(20);
    expect(stats.unemployed).toBeCloseTo(35);
    expect(stats.unemploymentRate).toBeCloseTo(35 / 55);
    expect(stats.vacancyRate).toBeCloseTo(0);
  });

  it('handles zero jobs or workers safely', () => {
    const noJobs = computeLabourStats(100, 120, 0);
    expect(noJobs.employed).toBe(0);
    expect(noJobs.unemploymentRate).toBeCloseTo(1);
    expect(noJobs.vacancyRate).toBeCloseTo(1);

    const noWorkers = computeLabourStats(0, 50, 20);
    expect(noWorkers.workers).toBe(0);
    expect(noWorkers.unemploymentRate).toBe(0);
    expect(noWorkers.vacancyRate).toBeCloseTo(1);
  });
});
