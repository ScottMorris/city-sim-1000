// wireMirror.ts — shared building-mirror decode: turns one tick's wire building list into display `BuildingInstance[]`.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
//
// `wasmSimBridge.ts` and `tauriSimBridge.ts` each rebuild `state.buildings`
// from their own wire `WireBuilding[]` list every tick — two separately
// `ts-rs`-generated types (`app/src/game/protocol/generated/WireBuilding.ts`
// and `crates/tauri-plugin-city-sim/guest-js/generated/WireBuilding.ts`) that
// are structurally identical but live in different packages, so this helper
// is typed against that shared shape rather than importing either generated
// file — a cross-package import isn't clean here, so this stays a structural
// duplicate of both, the same way `alertSeverity.ts` centralised the
// severity ladder `renderer.ts`/`minimap.ts` used to each carry a copy of.

import { BuildingInstance, BuildingState, BuildingStatus, createBuildingState } from './state';
import { getBuildingTemplate } from './templates';
import { buildingKindFromU8 } from '../protocol/buildingKind';
import { buildingStatusFromU8 } from '../protocol/buildingStatus';

/** Structural subset of the generated `WireBuilding` shared by both bridges' wire types. */
export interface WireBuildingLike {
  id: number;
  kind: number;
  originX: number;
  originY: number;
  status: number;
  health: number;
}

/** Structural subset of the generated `WireEducationSeatsUsed` shared by both bridges' wire types. */
export interface WireEducationSeatsUsedLike {
  buildingId: number;
  used: number;
}

/**
 * Rebuilds the display `state.buildings` mirror from one tick's wire
 * building list. Rust is authoritative; this is a display mirror only.
 *
 * An unrecognised `kind` byte (should never happen against a matching engine
 * build) is warned and that building is skipped, rather than fabricated with
 * an empty-string `templateId`. An unrecognised `status` byte is warned and
 * falls back to `BuildingStatus.Active`.
 */
export function buildBuildingMirror(
  wireBuildings: readonly WireBuildingLike[],
  seatsUsed: readonly WireEducationSeatsUsedLike[]
): BuildingInstance[] {
  const seatsUsedByBuildingId = new Map(seatsUsed.map((e) => [e.buildingId, e.used]));
  const buildings: BuildingInstance[] = [];

  for (const b of wireBuildings) {
    const kind = buildingKindFromU8(b.kind);
    if (kind === undefined) {
      console.warn(`wireMirror: unrecognised BuildingKind byte 0x${b.kind.toString(16)} for building #${b.id} — skipping`);
      continue;
    }

    let status = buildingStatusFromU8(b.status);
    if (status === undefined) {
      console.warn(`wireMirror: unrecognised BuildingStatus byte ${b.status} for building #${b.id} — falling back to Active`);
      status = BuildingStatus.Active;
    }

    const template = getBuildingTemplate(kind);
    const bstate: BuildingState = createBuildingState();
    bstate.status = status;
    bstate.health = b.health;

    // `#228` — seats consumed, from the wire; only schools currently have an
    // entry (Rust's `ServiceKind` has no other service ported yet).
    const used = template?.service ? seatsUsedByBuildingId.get(b.id) : undefined;
    if (template?.service && used !== undefined) {
      bstate.serviceLoad.slotsUsed[template.service.id] = used;
    }

    buildings.push({
      id: b.id,
      templateId: kind,
      origin: { x: b.originX, y: b.originY },
      state: bstate
    });
  }

  return buildings;
}
