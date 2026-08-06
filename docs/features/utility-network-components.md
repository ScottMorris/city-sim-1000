# Utility Network Connected Components

**Status:** engine model and wire exposure landed (`#230`). `recompute_utility_network` labels every reached tile with a connected-component id per pass and tracks per-component produced/consumed alongside the existing city-wide totals; both the WASM and Tauri bindings surface the breakdown, and `GameState.utilities` in TS carries it as `powerComponents`/`waterComponents`.

## Purpose

`state.utilities.power_produced`/`water_produced` are one pooled sum across the whole map — correct for the city-wide HUD, but blind to *which* physically-connected segment a plant, a pump, or a shortfall belongs to. Two disconnected grids (two separate towns, no shared wire) can have one segment in surplus and the other starved while the city-wide aggregate reads as a net surplus. A per-plant "how much of my output is in use" stat is only meaningful today if the plant is the sole source on its segment — with several plants sharing one network, production is pooled and fungible, so attribution needs to know which plants share a segment first.

## What shipped

* `UtilityComponent { id, produced, used, source_count }` and `UtilityNetworks { power_labels, water_labels, power_components, water_components }` (`crates/city-sim-core/src/utilities.rs`).
* `recompute_utility_network` restructured from one flat multi-source BFS into a per-source flood-fill: a source already labelled by an earlier source's flood shares that component instead of re-flooding, so every reachable tile is still visited once, not once per source.
* `produced`/`used` are left **unrounded** (`f32`) on each component. City-wide `power_produced`/`water_produced` is `(Σ components).round()` — mathematically the same single rounding step the old code applied to the grand total (`fund × Σ raw_i` = `Σ(raw_i × fund)`), so this is not a behaviour change: the golden-city fixture and every pre-existing test pass unmodified. Rounding per component, and any further display formatting, is left to the wire boundary or the UI — not baked into the simulation.
* `UtilityComponent::utilisation()` — `min(1.0, used / produced)`, the attribution convention for multiple sources sharing one segment: every source on a segment is assumed to run at the same utilisation fraction as the segment itself. Chosen over merit-order dispatch (no per-plant cost/priority model exists) and distance-weighted attribution (would need a second, more expensive pass).
* `state.utility_networks: UtilityNetworks` on `GameState`, `#[serde(skip)]` — fully derived from the grid every recompute, same lifecycle as the pre-existing `FLAG_POWERED`/`FLAG_WATERED` tile flags (excluded from `state_hash` for the same reason). No snapshot `VERSION` bump: nothing here is persisted.
* Component ids are stable only within one recompute; a grid edit (bridging or severing a segment) can renumber every component on the next tick. Nothing today needs cross-tick identity — a future narrative event ("this segment has been starved for 3 days") would snapshot a component's stats at emission time rather than hold an id across ticks.
* Wire exposure: `SimHost::power_components_json`/`water_components_json` (WASM, `city-sim-wasm/src/lib.rs`) and `TickEvent::power_components`/`water_components` (Tauri, `tauri-plugin-city-sim/src/commands.rs`), each a local `WireUtilityComponent` mapped from the engine's `UtilityComponent` — no shared `city_sim_protocol` type, since neither binding's existing per-tick wire shape (`WireBuilding`, `TickEvent`) goes through the protocol crate's `FromSim` today; both already duplicate their wire structs locally, and this follows the same pattern. `GameState.utilities.powerComponents`/`waterComponents` (`app/src/game/gameState.ts`) carry the same unrounded `produced`/`used` figures through to TS; nothing in the UI reads them yet.

## Non-goals (this issue)

* Per-plant utilisation surfaced in the building inspector UI, or any HUD/panel rendering of per-segment stats — the data reaches `GameState` but nothing displays it.
* Per-segment deficit alerts or narrative events keyed to a specific component.
* Stable cross-tick component identity.
* Snapshot format changes (none needed — see above).

These are exactly the follow-ups #230 was filed to unblock, not part of it.

## See also

`docs/features/education-over-the-wire.md` (`#228`) follows this same pattern — per-tick wire exposure of an already-computed engine value, local per-binding wire structs, `#[serde(skip)]` for the fully-derived `GameState` field.
