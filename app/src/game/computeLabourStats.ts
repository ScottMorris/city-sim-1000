export interface LabourStats {
  resCapacity: number;
  population: number;
  jobCapacity: number;
  workers: number;
  employed: number;
  unemployed: number;
  unemploymentRate: number;
  vacancyRate: number;
}

const DEFAULT_WORKER_SHARE = 0.55;

/**
 * Computes aggregate labour stats for the city. These rates are aggregate,
 * not per-citizen agents.
 */
export function computeLabourStats(
  population: number,
  resCapacity: number,
  jobCapacity: number,
  workerShare = DEFAULT_WORKER_SHARE
): LabourStats {
  const workers = Math.max(0, population * workerShare);
  const employed = Math.min(workers, jobCapacity);
  const unemployed = Math.max(0, workers - jobCapacity);
  const unemploymentRate = workers === 0 ? 0 : unemployed / workers;
  const vacancyRate = jobCapacity === 0 ? 1 : Math.max(0, jobCapacity - employed) / jobCapacity;

  return {
    resCapacity,
    population,
    jobCapacity,
    workers,
    employed,
    unemployed,
    unemploymentRate,
    vacancyRate
  };
}
