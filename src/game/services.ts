export enum ServiceId {
  Police = 'police',
  Fire = 'fire',
  Health = 'health'
}

export interface ServiceDefinition {
  id: ServiceId;
  name: string;
  coverageRadius: number; // tiles, flood-filled along roads
  capacity: number; // max tiles/people served before quality drops
  buildCost: number;
  upkeep: number;
  servedHappinessDelta: number;
  unservedHappinessDelta: number;
}

export interface ServiceSystemState {
  definitions: Record<ServiceId, ServiceDefinition>;
}

export interface ServiceLoad {
  slotsUsed: Partial<Record<ServiceId, number>>;
}

export interface TileServiceState {
  scores: Partial<Record<ServiceId, number>>;
  served: Partial<Record<ServiceId, boolean>>;
}

export const DEFAULT_SERVICE_DEFINITIONS: Record<ServiceId, ServiceDefinition> = {
  [ServiceId.Police]: {
    id: ServiceId.Police,
    name: 'Police Station',
    coverageRadius: 8,
    capacity: 140,
    buildCost: 6000,
    upkeep: 45,
    servedHappinessDelta: 0.05,
    unservedHappinessDelta: -0.05
  },
  [ServiceId.Fire]: {
    id: ServiceId.Fire,
    name: 'Fire Station',
    coverageRadius: 8,
    capacity: 140,
    buildCost: 5500,
    upkeep: 40,
    servedHappinessDelta: 0.06,
    unservedHappinessDelta: -0.08
  },
  [ServiceId.Health]: {
    id: ServiceId.Health,
    name: 'Clinic',
    coverageRadius: 10,
    capacity: 180,
    buildCost: 7000,
    upkeep: 55,
    servedHappinessDelta: 0.07,
    unservedHappinessDelta: -0.06
  }
};

export function createServiceSystemState(): ServiceSystemState {
  return {
    definitions: { ...DEFAULT_SERVICE_DEFINITIONS }
  };
}

export function createEmptyServiceLoad(): ServiceLoad {
  return { slotsUsed: {} };
}

export function createTileServiceState(): TileServiceState {
  return { scores: {}, served: {} };
}
