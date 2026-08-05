# Education Stats and Service Load Over the Wire

**Status:** engine wiring landed (`#228`). `city_sim_core::education::recompute_education` already computed the right numbers every tick; they simply never reached the client. Both bindings now carry `EducationStats` and per-building seats-used, and the TS client reads them instead of independently re-deriving the whole subsystem.

## Purpose

`recompute_education` runs every tick and produces two things: a city-wide `EducationStats` snapshot, and — per active school — how many seats it filled. Neither crossed the wire. `app/src/game/education.ts`'s `recomputeEducation` re-ran the same BFS/greedy-fill algorithm client-side, in both bridges, to populate `state.education`, each building's `serviceLoad.slotsUsed`, and each tile's `services.served`/`scores`. Two implementations of the same algorithm can (and did) disagree — `#226` was a tie-break mismatch between the TS and Rust BFS when a school at capacity had several zone tiles tied at the same distance. Fixing the tie-break alone would have been a stopgap; the next algorithmic drift would reopen the same class of bug. The real fix is for Rust to send its own answer and for TS to stop computing one.

## What shipped

* `GameState::education_seats_used: HashMap<u32, f32>` (`crates/city-sim-core/src/state.rs`) — building id → seats consumed, populated inside `recompute_education`'s existing per-building loop (`crates/city-sim-core/src/education.rs`) instead of discarding `used` after folding it into the city-wide total. `#[serde(skip)]`, same lifecycle as `utility_networks` (`#230`): fully re-derived every tick, no snapshot `VERSION` bump.
* Per-tile `elementary_served`/`high_served`/`elementary_score`/`high_score` — already computed by `recompute_education`, now carried on the live SoA tile buffer (`crates/city-sim-protocol/src/tile_buffer.rs`): the two previously-spare `status` bits (6–7) for the served flags, plus two new quantised `elementary_score`/`high_score` u8 arrays. `BYTES_PER_TILE` grows 9 → 11 — additive only; the frozen 8-byte `legacy_tile_buffer` used by old `.citysim` imports is untouched, and every reader keys off `TileBufferOffsets` rather than a hardcoded stride.
* Wire exposure, mirroring `#230`'s `power_components_json`/`water_components_json` pattern: `SimHost::education_json`/`education_seats_used_json` (WASM, `crates/city-sim-wasm/src/lib.rs`) and `TickEvent::education`/`education_seats_used` (Tauri, `crates/tauri-plugin-city-sim/src/commands.rs`), each a local `WireEducationStats`/`WireEducationSeatsUsed` — no shared `city_sim_protocol` type, matching the existing `WireBuilding`/`WireUtilityComponent` duplication.
* `app/src/game/wasmSimBridge.ts`/`tauriSimBridge.ts` read `state.education` and each school's `serviceLoad.slotsUsed` straight from the wire; `app/src/game/protocol/tileBuffer.ts`'s `decodeTileBuffer` writes `tile.services.served`/`scores` from the new status bits and score bytes. The Education map overlay, the minimap overlay, and the tile inspector's coverage percentage are unchanged in behaviour — they read the same `tile.services` shape, now populated from Rust instead of a client recompute.
* `app/src/game/education.ts`'s `recomputeEducation` is deleted. `getEducationScore` and `computeEducationReach` (the school-placement preview helper — no engine equivalent, since it previews a building that hasn't been placed yet) stay. `createEmptyEducationStats`'s and `createInitialState`'s defaults now match `EducationStats::default()` (`score`/coverages = `1.0`, not `0`) — a city with no schools has no load anywhere, which is full coverage, not zero.

## Non-goals (this issue)

* Police/fire/health service-load wiring — Rust's `ServiceKind` only has `EducationElementary`/`EducationHigh` today; those services aren't ported to the engine yet.
* New UI surfacing per-school seats-used beyond what the inspector already showed (`#233`/`#234` track dedicated panels).
* `#226`'s narrow tie-break fix — superseded: once TS stops computing its own served set, there is no second implementation left to disagree with Rust's.

## See also

`docs/features/utility-network-components.md` — the `#230` precedent this wiring follows (per-tick wire exposure of an already-computed engine value, local per-binding wire structs, `#[serde(skip)]` for fully-derived `GameState` fields).
