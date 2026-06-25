function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

const PENDING_PENALTY_MAX = 35;
const PENDING_PENALTY_BASE_FRACTION = 0.6;
const DEMAND_FLOOR = 8;
const FLOOR_FILL_THRESHOLD = 0.92;
const PRESSURE_THRESHOLD = 60;
const PRESSURE_RELIEF_FACTOR = 0.5;

export interface DemandInput {
  base: number;
  fillFraction: number;
  workforceTerm: number;
  labourTerm?: number;
  pendingZones: number;
  pendingSlope: number;
  utilityPenalty: number;
  seeded: boolean;
  seededValue: number;
  pendingPenaltyEnabled: boolean;
  floorOverride?: number;
}

export interface DemandComputation extends DemandInput {
  fillTerm: number;
  pendingPenaltyRaw: number;
  pendingPenaltyCapped: number;
  pendingPenaltyApplied: number;
  pressureRelief: number;
  demandBeforeUtilities: number;
  floorApplied: boolean;
  value: number;
}

export function computeDemand(input: DemandInput): DemandComputation {
  const labourTerm = input.labourTerm ?? 0;
  const fillTerm = input.base * (1 - input.fillFraction);

  if (input.seeded) {
    return {
      ...input,
      fillTerm,
      pendingPenaltyRaw: 0,
      pendingPenaltyCapped: 0,
      pendingPenaltyApplied: 0,
      pressureRelief: 0,
      demandBeforeUtilities: input.seededValue,
      floorApplied: false,
      value: input.seededValue
    };
  }

  const baseDemand = fillTerm + input.workforceTerm + labourTerm;
  const pendingPenaltyRaw = input.pendingPenaltyEnabled ? input.pendingZones * input.pendingSlope : 0;
  const pendingPenaltyCapped = input.pendingPenaltyEnabled
    ? Math.min(pendingPenaltyRaw, baseDemand * PENDING_PENALTY_BASE_FRACTION, PENDING_PENALTY_MAX)
    : 0;
  const pressureRelief = Math.max(0, baseDemand - PRESSURE_THRESHOLD) * PRESSURE_RELIEF_FACTOR;
  const pendingPenaltyApplied = Math.max(0, pendingPenaltyCapped - pressureRelief);
  const demandAfterPenalty = baseDemand - pendingPenaltyApplied;
  const demandBeforeUtilities =
    input.floorOverride !== undefined
      ? Math.max(demandAfterPenalty, input.floorOverride)
      : input.fillFraction < FLOOR_FILL_THRESHOLD
        ? Math.max(demandAfterPenalty, DEMAND_FLOOR)
        : demandAfterPenalty;
  const value = clamp(demandBeforeUtilities - input.utilityPenalty, 0, 100);

  return {
    ...input,
    fillTerm,
    pendingPenaltyRaw,
    pendingPenaltyCapped,
    pendingPenaltyApplied,
    pressureRelief,
    demandBeforeUtilities,
    floorApplied: demandBeforeUtilities > demandAfterPenalty,
    value
  };
}
