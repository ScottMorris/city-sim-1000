# Water Source Gating

**Status:** fixed (`#200`). A pump only produces water when its footprint is orthogonally adjacent to `Terrain::Water`; a dry pump reads `BuildingStatus::InactiveNoSource` and contributes nothing to the network or the HUD total. Was tracked as audit item A3 in `docs/wasm-sim-audit.md`.

## Purpose

A water pump only produces water when it is actually connected to a water source. Pumps are the tool that turns geography into infrastructure; without the gate, terrain stops mattering to the water network and the pump is just a cheaper water tower.

## Old behaviour (pre-migration; last captured in the removed TS oracle)

The TS sim gated pump output on `hasWaterSourceConnection()` (`app/src/game/simulation.ts:266-268` at `1f8140a`; oracle removed 2026-07-30, view with `git show 1f8140a:app/src/game/simulation.ts`; `app/src/game/utilities/water.ts`). Read closely, that check didn't actually consult terrain at all — `terrain` wasn't a field yet at that point in the codebase's history, and the check really asked whether a neighbour was a water-pipe occupant or itself had a `buildingId`. There was no clean historical behaviour to port faithfully; the fix below picks new semantics from scratch.

## The regression (fixed)

`crates/city-sim-core/src/utilities.rs` used to seed the water BFS from **any** `Active` building with water output — no adjacency or source check at all. A standalone pump in the middle of a desert supplied the whole city. The original excuse was audit item B3 (the engine had no natural terrain to check against), but B3 was fixed before this — `terrain` is a first-class tile field — so the gate was implementable and simply missing.

### Related accounting defect: production ignored building status (also fixed)

`SPEC.md` (§Water): *"Production: `waterProduced` sums powered pump/tower outputs, and for pumps, source-connected ones only."* `sum_output_water` used to sum every tile with `water_output > 0` regardless of `BuildingStatus`, so an unpowered (or unconnected) pump still padded the HUD's `waterProduced` while the BFS correctly refused to seed from it. Both now share one predicate, `is_effective_source` (`utilities.rs`), so seeding and the HUD total can't drift apart again.

## What shipped

* `BuildingTemplate::requires_water_source` (`buildings.rs`) — `true` only for `WaterPump`; `WaterTower` and everything else stay `false`.
* `footprint_touches_water` (`adjacency.rs`, mirrored in `app/src/game/adjacency.ts` for the two bridges' client-side status reconstruction) — **strict footprint adjacency**, not pipe-reachability. Chosen deliberately over the more flexible "plumbed in via pipes to a distant water tile" alternative: simpler (one O(1) check, no second flood-fill pass), and matches player intuition — build the pump on the shore. Pipe-reachability remains a legitimate future enhancement, not a fix.
* `BuildingStatus::InactiveNoSource`, set by `update_building_states`, distinct from `InactiveNoWater` (a *consumer* failing to reach the network — a pump doesn't consume water, so it never takes that branch). Surfaced in the HUD inspector ("No Water Source — build next to water") and reuses the existing `noWater` map/minimap indicator icon rather than adding new art.
* Golden-city fixture (`tests/fixtures/golden_city.script`) updated: the pump at (22,9) now has a one-tile lake at (23,9) so the reference city keeps a working water supply.

## Non-goals

* Groundwater, aquifers, or water quality — the gate is binary source-connection, as before.
* Changing water tower behaviour (towers are the terrain-independent option by design).
* Refusing *placement* of a pump that doesn't border water — SPEC.md's "Pump: must border ≥1 water tile" describes a build-time rule that's still unenforced (a pump can be placed anywhere, it just won't produce); that gap is tracked separately as `#206`, alongside the same gap for Hydro plants.
