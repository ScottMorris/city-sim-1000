# Desktop Per-Tile Building Identity

**Status:** fixed — the Tauri wire now carries `building_id` (and happiness/elevation/wilderness) directly, sharing `city_sim_protocol::tile_buffer`'s exact SoA layout and decode helpers with the WASM path. No residual risk: there is no client-side derivation left to drift.

## Purpose

Every client, browser and desktop alike, can answer "which building is on this tile?" The HUD inspector, minimap water/education modes, and renderer building-kind branches all key off `buildingLookup.get(tile.buildingId)`.

## Current behaviour

`TickEvent.tiles` (`crates/tauri-plugin-city-sim/src/commands.rs`) is produced by `city_sim_core::wire::encode_tile_buffer` — the same function `city-sim-wasm`'s `tile_buffer()` calls. It is the exact SoA buffer `city_sim_protocol::tile_buffer` describes: `underground[N] | surface[N] | overhead[N] | status[N] | happiness[N] | elevation[N] | building_id[N×2] | wilderness[N]`. `app/src/game/tauriSimBridge.ts`'s `onTick` decodes it via `protocol/tileBuffer.ts`'s `decodeTileBuffer` — the same function `wasmSimBridge.ts` uses for the WASM wire. `tile.buildingId` is read straight off the wire; `event.buildings` is consulted only to resolve a `building_id` to its template kind (power/water status gating, the HUD inspector's building name), never to derive tile coverage.

This closes the gap this doc originally tracked (`9da342c`'s client-side, footprint-derived stopgap is deleted) and the residual risk that stopgap carried: there is no second, independently-maintained footprint table for the engine's own building placement to disagree with, because there is no derivation left — `building_id` is sourced from the same wire buffer as everything else, on both transports.

As a side effect, the Tauri path also gains real per-tile `happiness`, `elevation` and `wilderness` (previously placeholder values that were never overwritten, since nothing on the wire carried them) — the same underlying gap, closed by the same change.

## Recovery

Done. `city_sim_core::wire::encode_tile_buffer` is the one encoder both `city-sim-wasm/src/lib.rs`'s `tile_buffer()` and `tauri-plugin-city-sim/src/commands.rs`'s `build_tick_event` call; `protocol/tileBuffer.ts`'s `decodeTileBuffer` is the one decoder both `wasmSimBridge.ts` and `tauriSimBridge.ts` call. A wire-layout bug fixed in either function is fixed on both transports at once — the two encoders (and decoders) cannot silently drift apart the way two hand-written, independently-maintained implementations could.

## Codifying

* `crates/city-sim-core/src/wire.rs`: `encode_tile_buffer_places_every_field_at_its_soa_offset` pins every field's byte offset for a multi-tile grid.
* `app/src/game/tauriSimBridge.test.ts`: direct wire-decode assertions (every field, at its documented offset) replace the old footprint-derivation tests; a dedicated case confirms `buildingId` decodes independent of `event.buildings`' contents.
* Still open, tracked in #213: a real cross-engine parity assertion (inspector-visible facts for a pump tile match between the WASM and Tauri bridges) — the parity harness (`app/src/game/parity/`) has no Tauri-transport coverage at all today. Not required to close this gap, since both transports now provably share one encoder and one decoder rather than being asserted to agree by convention.

## Non-goals

* Building Tauri-transport coverage into the cross-engine parity harness — tracked in #213, not part of this fix.
