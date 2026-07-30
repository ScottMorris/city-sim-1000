# Desktop Per-Tile Building Identity

**Status:** regressed by the tile-model PR stack (#187/#189), documented as a known gap in `app/src/game/tauriSimBridge.ts:19-31` — this doc promotes it from code comment to tracked feature.

## Purpose

Every client, browser and desktop alike, can answer "which building is on this tile?" The HUD inspector, minimap water/education modes, and renderer building-kind branches all key off `buildingLookup.get(tile.buildingId)`.

## Current behaviour

Since the stack, `Occupant::Structure` is a flat tag and the specific kind lives on the `BuildingInstance`. The WASM wire carries per-tile `building_id`; the **Tauri `TickEvent` does not**. On desktop, `tile.buildingId` is never set, so the inspector, `isDevelopedZone`, minimap water/education overlays, and any building-kind rendering silently see an undeveloped tile. (Before the stack, the Tauri wire's per-tile `TileKind` byte answered the question directly, so this is a real regression relative to pre-stack desktop behaviour, not a pre-existing hole.)

## Recovery

* Add `building_id` to the Tauri tick payload (matching the WASM tile buffer's SoA layout so the decode path is shared), or ship the buildings table + footprints and derive the per-tile id client-side — pick whichever keeps the two transports decoding through one code path.
* Delete the apologia comment in `tauriSimBridge.ts` once true.
* Codify: a Tauri-side integration test (or extend the cross-engine parity harness's transport coverage) asserting the inspector-visible facts for a pump tile match between WASM and Tauri bridges.

## Non-goals

* Wire-format unification beyond this field; the transports may stay structurally different.
