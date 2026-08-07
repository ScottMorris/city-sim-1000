// services.ts — service vocabulary (ServiceId) and the per-tile/per-building service mirrors the wire populates.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// Service coverage/capacity/upkeep definitions used to live here too
// (`DEFAULT_SERVICE_DEFINITIONS`, `ServiceSystemState`) as input to a TS
// shadow of the engine's service system — deleted as dead once nothing
// called them; service placement/coverage math runs in Rust
// (`crates/city-sim-core/src/buildings.rs`), and only the display mirrors
// below (`TileServiceState`, `ServiceLoad`) survive.

export enum ServiceId {
  Police = 'police',
  Fire = 'fire',
  Health = 'health',
  EducationElementary = 'education_elementary',
  EducationHigh = 'education_high'
}

export interface ServiceLoad {
  slotsUsed: Partial<Record<ServiceId, number>>;
}

export interface TileServiceState {
  scores: Partial<Record<ServiceId, number>>;
  served: Partial<Record<ServiceId, boolean>>;
}

export function createEmptyServiceLoad(): ServiceLoad {
  return { slotsUsed: {} };
}

export function createTileServiceState(): TileServiceState {
  return { scores: {}, served: {} };
}
