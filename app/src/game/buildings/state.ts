// state.ts — runtime building mirror: status/health/service-load, wire-populated per building instance.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { createEmptyServiceLoad, ServiceLoad } from '../services';

export enum BuildingStatus {
  Active = 'active',
  InactiveNoPower = 'inactive_no_power',
  InactiveNoWater = 'inactive_no_water',
  /** A water source (pump) whose footprint doesn't touch water terrain (#200). */
  InactiveNoSource = 'inactive_no_source',
  InactiveDamaged = 'inactive_damaged'
}

export interface BuildingState {
  status: BuildingStatus;
  health: number; // 0-100, v1 stub
  serviceLoad: ServiceLoad;
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
    serviceLoad: createEmptyServiceLoad()
  };
}
