# Water Source Gating

**Status:** regressed in the Rust migration — the TS-era rule still lives in the test oracle, the Rust engine dropped it. Tracked as audit item A3 in `docs/wasm-sim-audit.md`.

## Purpose

A water pump only produces water when it is actually connected to a water source. Pumps are the tool that turns geography into infrastructure; without the gate, terrain stops mattering to the water network and the pump is just a cheaper water tower.

## Old behaviour (pre-migration, still in the oracle)

The TS sim gated pump output on `hasWaterSourceConnection()` — a pump adjacent to (or plumbed to) water terrain produced; a pump on dry land did not (`app/src/game/simulation.ts:266-268`, `app/src/game/utilities/water.ts`).

## Current behaviour (the defect)

`crates/city-sim-core/src/utilities.rs:118-140` seeds the water BFS from **any** `Active` building with water output — no adjacency or source check at all. A standalone pump in the middle of a desert supplies the whole city. The original excuse was audit item B3 (the engine had no natural terrain to check against), but B3 is fixed — `terrain` is now a first-class tile field — so the gate is implementable and simply missing.

The oracle and the engine actively disagree here, which also means the cross-engine parity harness has no scenario covering it.

### Related accounting defect: production ignores building status

`SPEC.md` (§Water): *"Production: `waterProduced` sums powered, connected pump/tower outputs."* In practice `sum_output_water` (`crates/city-sim-core/src/utilities.rs:220-238`) sums every tile with `water_output > 0` regardless of `BuildingStatus` — `tile.water_output` is never zeroed when a pump goes `InactiveNoPower` (`buildings.rs:254-271` only flips status). The BFS *seeding* does check `Active`, so the displayed balance and the actual supply disagree: an unpowered pump adds +50 to the HUD water number while supplying nothing. Fix alongside the source gate so production, seeding, and the HUD all agree on one definition of "producing".

## Recovery

* Port the source-connection check into the Rust water pass: a pump contributes output only when its footprint touches (or is network-connected to, matching the old TS reachability definition) `Terrain::Water`.
* Decide and document what "connected" means now that terrain is durable: strict footprint adjacency (simplest, matches player intuition) vs pipe-reachable from a water tile. The old TS definition is the reference; pick deliberately rather than by port accident.
* Building status UI: a dry pump should read as inactive/starved in the HUD inspector, not silently zero.
* Add a parity scenario (pump on dry land vs pump beside a lake) and a golden-city case, so the rule is pinned in both harnesses.
* Update `docs/game-parameters.md` and `app/public/manual.html` if either describes pump behaviour.

## Non-goals

* Groundwater, aquifers, or water quality — the gate is binary source-connection, as before.
* Changing water tower behaviour (towers are the terrain-independent option by design).
