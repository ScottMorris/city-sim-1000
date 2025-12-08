import { createEmptyServiceLoad, ServiceLoad } from '../services';

export enum BuildingStatus {
  Active = 'active',
  InactiveNoPower = 'inactive_no_power',
  InactiveDamaged = 'inactive_damaged'
}

export interface BuildingState {
  status: BuildingStatus;
  health: number; // 0-100, v1 stub
  serviceLoad: ServiceLoad;
  troubleTicks: number;
  abandoned: boolean;
}

export interface BuildingInstance {
  id: number;
  templateId: string;
  origin: { x: number; y: number };
  state: BuildingState;
}

export function createBuildingState(): BuildingState {
  return {
    status: BuildingStatus.Active,
    health: 100,
    serviceLoad: createEmptyServiceLoad(),
    troubleTicks: 0,
    abandoned: false
  };
}
