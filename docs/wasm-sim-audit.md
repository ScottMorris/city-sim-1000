# WASM Simulation Audit — Gaps & Drift

**Date:** 2026-07-06 · **Reconciled:** 2026-08-05
**Scope:** The default browser runtime — `crates/city-sim-core` → `crates/city-sim-wasm` (`SimHost`) → `app/src/workers/wasmSim.worker.ts` → `app/src/game/wasmSimBridge.ts` — originally audited against the TS parity oracle (`app/src/game/simulation.ts`, `tools.ts`), the protocol crates, the Tauri path, and the migration plan (`docs/rust-migration-tasks.md`).

**Context:** The Rust sim was intended to fully replace the TS sim once it was in a good place — it now has: the TS parity oracle (`simulation.ts`), its dedicated tests, and the cross-engine parity harness (`app/src/game/parity/`) were all removed 2026-07-30 (last version preserved at commit `1f8140a`). The Rust engine is the sole production engine and the sole spec. Section **A**'s items were originally framed as Rust-vs-TS drift; they're kept here as open Rust-behaviour decisions where the underlying question (should Rust do X?) still stands on its own merits. Sections **B–D** are transport, bridge, and process gaps. Resolved items are struck through in each section's **Resolved** checklist rather than kept as prose — see git history/blame on this file for the narrative of *when* and *why* each one closed.

**Status:** 0 blockers (P0) open (all 5 resolved), 5 high (P1), 6 medium/low (P2) open. 13 items resolved since the original audit.

---

## A. Behavioural drift — Rust core vs TS oracle (historical framing; open items are now Rust-behaviour decisions)

**Resolved:**
- [x] ~~A1. Power lines destroy zones (P1)~~ — the stratum/occupant rework (`#177`) replaced the single `kind` field; `Tool::PowerLine` now sets an `Occupant::PowerLine` bit and explicitly leaves zone/road/rail occupants standing (`commands.rs`).
- [x] ~~A2. Bulldoze precedence differs (P1)~~ — `#221` made the bulldozer layer-scoped: `SimCommand::ApplyTool` carries `stratum: ViewStratum`, and `bulldoze()` branches on it (Surface → building/surface/overhead only, Underground → pipe only).
- [x] ~~A3. Water production is not gated on a source connection (P1)~~ — `#200`/`#246`: a pump's footprint must be orthogonally adjacent to `Terrain::Water` to seed the BFS or count toward `water_produced`. See `docs/features/water-source-gating.md`.
- [x] ~~A4. Money is truncated to whole dollars every tick (P0)~~ — `money_frac` accumulator added to `GameState`; `apply_money_tick` no longer discards the fraction (`economy.rs`).
- [x] ~~A7. No per-tick happiness dynamics (P2)~~ — `apply_happiness_drift` (`wilderness.rs`) now nudges zoned-tile happiness toward a wilderness-score-derived target every tick, not just at placement/abandonment.
- [x] ~~A9. Minor arithmetic/type divergences (P2)~~ — moot: there is no TS oracle left to diverge from (`stateHash.ts` was removed with it 2026-07-30).

### A5. Population/jobs snap to capacity instead of declining gradually (P1)
- Old TS oracle: `growth = clamp(desiredPop − pop, −2, 2)` — a capacity drop (abandonment, bulldoze) declines population at most 2/tick.
- Rust: growth is `clamp(demand × 0.05, −2, 2)` accumulated, then the result is clamped to capacity with `.min(pop_cap)` (`economy.rs:295–316`) — a capacity drop still snaps population down instantly, confirmed still true.

### A6. Bylaws / lighting policy entirely absent (P1)
- No `bylaws` field on `GameState`, no `SimCommand` to set them; the old TS oracle scaled civic/zone power use and maintenance by a lighting bylaw and nudged happiness toward a policy target. The bylaws modal still exists in the UI (`app/src/ui/bylawsModal.ts`) and mutates TS-side state with **zero simulation effect**.
- Related: `pendingPenaltyEnabled` is still hardcoded `true` in Rust (`demand.rs`).

### A8. Budget `*ByType` breakdowns missing (P1)
- Rust `BudgetStats` has only scalar buckets (`economy.rs`) — no `powerByType`/`civicByType`/`zonesByType` maps, so the budget modal's per-type rows show stale TS-side mirror values in WASM mode. Confirmed still true (`grep ByType` — no hits in `economy.rs`).

---

## B. WASM transport surface gaps (vs `SimBridge` contract and Tauri path)

**Resolved:**
- [x] ~~B1. No snapshot save/load — the 120-tick replay cap (P0)~~ — `SimHost` gained `get_snapshot`/`load_snapshot`/`import_legacy`; `CommandLog` was deleted from the codebase entirely.
- [x] ~~B2. Sim events never emitted (P0)~~ — `#199`: `Simulation::handle_resource_alerts`/`take_alerts` port the deficit state machine into Rust, forwarded via both bridges. See `docs/features/sim-feedback-channel.md`.
- [x] ~~B3. Natural terrain not seeded into the Rust sim (P0)~~ — `#101`: `GameState::seed_natural_terrain` / `SimHost::set_natural_terrain`, wired end-to-end.
- [x] ~~B4. Command-log desync on rejected commands (P0)~~ — structurally gone with `CommandLog`; the TS `cmdLog` key survives only as a stripped legacy-save field (`persistence.ts`), not a live mirror.
- [x] ~~B5. Rejected placements give no user feedback (P2)~~ — `#199`, alongside B2: `CommandResult` now reaches `main.ts` on both bridges.
- [x] ~~B7. Undo rewinds simulation time (P2)~~ — ratified as intentional full-rewind semantics (snapshot-stack `History`); documented in `manual.html`.

### B6. `getMetadata()` returns null (P2)
- The "Option B" Rust `building_metadata()` export was never implemented (`wasmSimBridge.ts`: *"Returns null until Option B ... is implemented"*); UI callers fall back to TS `templates.ts` — a second source of truth for costs/footprints/capacities that can drift silently from `buildings.rs`'s `building_template!` macro table.

---

## C. Bridge/mirror integrity

### C1. Building mirror loses runtime state (P2)
- `applyTileBuffer` rebuilds `state.buildings` every frame via `createBuildingState()` defaults (`wasmSimBridge.ts`): `troubleTicks`, `health`, and real statuses are invisible to the UI, re-derived from `powered`/`watered` flags only. Confirmed still true. The tile buffer's current layout (`underground|surface|overhead|status|happiness|elevation|building_id|wilderness`, `tile_buffer.rs`) still carries no per-tile service coverage.

### C2. Education recomputed twice, in two languages (P2)
- Rust computes education for demand/decay (`education.rs`, wired in `sim.rs`); the bridge *also* runs TS `recomputeEducation` against the mirror every buffer apply (`wasmSimBridge.ts:673`) to feed the HUD/overlay. Confirmed still called. Two implementations of the same coverage algorithm will drift.

---

## D. Verification & documentation gaps

**Resolved:**
- [x] ~~D4 (part). `LocalSimBridge` contradicts "removed" docs~~ — `localSimBridge.ts` and `simulation.ts` are both deleted; `CLAUDE.md`'s claim is accurate now.
- [x] ~~D4 (part). Embedded golden hash goes stale~~ — `rust-migration-tasks.md` now points at `sim.rs`'s `GOLDEN_HASH_SEED42_8X8_100TICKS` by name instead of a literal value.

### D1. No automated Rust-vs-TS parity harness (P1)
- Moot as originally framed (no TS left to compare against), but the underlying need stands: a native fixture runner that replays seeds/command sequences through `city-sim-core` and asserts tolerance bands would still be the highest-leverage test for catching regressions in the A-section behaviour decisions (A5, A6, A8).

### D2. P4-3 cross-platform determinism unchecked (P1)
- `rust-migration-tasks.md` still has P4-3 open (unchecked box): no CI matrix proving identical golden hashes on x64/ARM, web/native. The sim uses `f32`/`f64` arithmetic throughout, so this is not a formality.

### D3. CI never tests the WASM crate (P2)
- `ci.yml` runs `cargo clippy`/`nextest` with `--exclude city-sim-wasm`; the wasm crate is only ever *built* (`wasm-pack build`). Nothing executes the compiled WASM (e.g. `wasm-bindgen-test` or a Playwright smoke test asserting `tick_count` advances and a tool round-trips).

### D4. Documentation contradicts the code (P2)
- `demand.rs` says "Education is stubbed to 0 until P3-8 (score=0, high_coverage=0)" but the code reads real `state.education.score`/`high_coverage` (P3-8 shipped) — stale comment, still present.

---

## Priority rollup (open items only)

| Pri | Item | Section |
|-----|------|---------|
| P1 | Population snaps to capacity on loss | A5 |
| P1 | Bylaws/settings have no effect in WASM mode | A6 |
| P1 | Budget by-type breakdowns missing from wire | A8 |
| P1 | No Rust-vs-TS parity harness — repurpose as a native regression harness | D1 |
| P1 | P4-3 cross-platform determinism unproven | D2 |
| P2 | `getMetadata()` null | B6 |
| P2 | Mirror loses building state | C1 |
| P2 | Duplicate education calc | C2 |
| P2 | WASM crate untested in CI | D3 |
| P2 | Stale "education stubbed" comment | D4 |

## Suggested order of attack

1. **D1** — stand up a native `city-sim-core` fixture/regression harness (no WASM needed); use it as the referee for A5/A6/A8 instead of a TS oracle that no longer exists.
2. **A5, A6, A8** — decide and implement each Rust-behaviour question with the harness catching regressions: gradual population decline on capacity loss, bylaws as a real `GameState` field + `SimCommand`, and by-type budget breakdowns on the wire.
3. **C1, C2** — fold real building runtime state and a single education-coverage implementation into the tile buffer/stats so the bridge stops re-deriving/duplicating them TS-side.
4. **D2, D3** — CI hardening: a cross-platform determinism matrix, and an actual executed-WASM smoke test.
