# Desktop Per-Tile Building Identity

**Status:** fixed (`9da342c`) via client-side derivation — `onTick` repaints `tile.buildingId` from `event.buildings` and the TS template footprints each tick. One named residual risk (Rust/TS footprint drift) remains until #204 unifies the wire.

## Purpose

Every client, browser and desktop alike, can answer "which building is on this tile?" The HUD inspector, minimap water/education modes, and renderer building-kind branches all key off `buildingLookup.get(tile.buildingId)`.

## Current behaviour

The Tauri `TickEvent` wire still carries no per-tile `building_id`. Instead, `onTick` in `app/src/game/tauriSimBridge.ts` derives it: every tick it clears `tile.buildingId` on every tile (so a razed building's id cannot linger on its old footprint), then repaints from `event.buildings` — for each entry it stamps `b.id` across the tiles covered by the TS-side template footprint (`getBuildingTemplate(kind).footprint`, from `originX`/`originY`, clipped at the map edge). This is the second recovery option the original version of this doc proposed — ship the buildings table and derive the per-tile id client-side — chosen over adding `building_id` to the wire. The inspector, `isDevelopedZone`, minimap water/education overlays, and building-kind rendering now see the same facts on desktop as on the WASM path.

The residual risk, named plainly in the bridge's own doc comment (`tauriSimBridge.ts:26-31`): the derivation trusts that the Rust-side building footprint and the TS-side template footprint agree. A drift between them would silently mis-paint coverage — tiles claimed by the engine but not the TS template (or vice versa) would carry the wrong `buildingId`.

## Recovery

What remains open, now that the behavioural gap itself is closed:

* Retire the derivation structurally: #204 (unstarted) unifies the Tauri tick on the shared SoA tile buffer, which puts `building_id` on the wire directly and removes both the client-side repaint and the footprint-drift risk with it.
* Codifying: `app/src/game/tauriSimBridge.test.ts` now covers the derivation at unit level, including multi-tile footprint painting and clearing on a razed building. That partially satisfies the original recommendation — it pins the TS-side repaint logic, but it exercises the TS templates against themselves, so it would not catch a Rust/TS footprint drift. The cross-engine assertion (inspector-visible facts for a pump tile match between WASM and Tauri bridges, via a Tauri-side integration test or the parity harness's transport coverage) remains open, though #204 would largely subsume it.

## Non-goals

* Wire-format unification beyond this field — that is #204's scope, tracked there, not here; until it lands the transports stay structurally different.
