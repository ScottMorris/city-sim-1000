# WASM Simulation Audit — Gaps & Drift

**Date:** 2026-07-06
**Scope:** The default browser runtime — `crates/city-sim-core` → `crates/city-sim-wasm` (`SimHost`) → `app/src/workers/wasmSim.worker.ts` → `app/src/game/wasmSimBridge.ts` — audited against the TS parity oracle (`app/src/game/simulation.ts`, `tools.ts`), the protocol crates, the Tauri path, and the migration plan (`docs/rust-migration-tasks.md`).

**Context:** The Rust sim is intended to fully replace the TS sim once it is in a good place. This audit therefore separates (A) **behavioural drift** between the Rust core and the TS oracle, (B) **feature gaps in the WASM transport surface** relative to what the Tauri path and the `SimBridge` contract already promise, (C) **bridge/mirror integrity issues**, and (D) **verification and documentation gaps**.

**Update (2026-07-21):** B3 (no natural terrain in the Rust sim) has been resolved by the Wilderness Score work (#101) — `GameState::seed_natural_terrain` / `SimHost::set_natural_terrain`, wired end-to-end via `wasmSim.worker.ts`. Left the rest of this audit as originally written; the other four P0s (A4, B1, B2, B4) were spot-checked against current `main` and remain accurate.

**Update (2026-07-22):** the undo/save rework (#109) resolved four more items. **A4** — `money_frac` accumulator added to `GameState` (golden hash regenerated). **B1** — `SimHost` gained `get_snapshot`/`load_snapshot`/`import_legacy`; saves are CSAV containers carrying the engine snapshot, and the 120-tick replay cap is gone along with the whole command-log replay path (`CommandLog` deleted). **B4** — resolved structurally: there is no TS-side command-log mirror any more. **B7** — ratified as intentional full-rewind semantics (snapshot-stack `History`; documented in the manual). Also fixed while there: `day_frac` moved into `GameState` so restores keep sub-day progress, and D4's `LocalSimBridge` contradiction is gone (the file is actually deleted now).

**Update (2026-07-30):** the TS parity oracle (`app/src/game/simulation.ts`), its dedicated tests (`stateHash.test.ts`, `regression.test.ts`, `budgetPolicy.test.ts`), and the cross-engine parity harness (`app/src/game/parity/`) have all been removed — the oracle's last version is preserved at commit `1f8140a`. The Rust engine is now the sole production engine and the sole spec; every behavioural-drift finding below is historical.

---

## Executive summary

The Rust core covers the full tick loop (utilities, zone growth, building states, education/services, demand, economy, decay) and is deterministic with a committed golden hash. However:

1. **Save/load fidelity is fundamentally weaker on WASM than on Tauri.** Tauri exposes postcard snapshots; the WASM `SimHost` exposes nothing, so loads are reconstructed by command-log replay **capped at 120 ticks** — a mature city's tick/day/population/jobs are silently reset on reload.
2. **The event channel is dead.** `FromSim::Alert` / `Narrative` / `CommandResult` are defined in the protocol but never emitted by any Rust code; power/water deficit alerts and sim-driven narrative items simply do not exist in WASM mode.
3. **The Rust world has no natural terrain.** `GameState::new` is all-Land; the bridge repaints natural water/trees for display only, so the sim and the screen disagree about the map.
4. **Several placement/economy rules have drifted** from the TS oracle (power lines destroy zones, bulldoze precedence, water-source gating, integer money truncation, bylaws absent).
5. **No automated Rust-vs-TS parity run exists.** The tolerance-banded regression fixtures still drive only the TS sim.

Item counts: 5 blockers (P0), 8 high (P1), 8 medium/low (P2).

---

## A. Behavioural drift — Rust core vs TS oracle

### A1. Power lines destroy zones (P1)
- TS: a power line over a Residential/Commercial/Industrial tile keeps the zone kind and sets `powerOverlay` (`tools.ts:110–127`).
- Rust: `Tool::PowerLine` unconditionally rewrites `tile.kind = TileKind::PowerLine` (`crates/city-sim-core/src/commands.rs:131–149`). The zone is lost, which also changes demand/revenue counters (zone counts are per-kind).

### A2. Bulldoze precedence differs (P1)
- TS: underground pipes are only bulldozed when the minimap is in `underground` mode; in surface mode the surface is cleared and the pipe survives (`tools.ts:190–210`).
- Rust: `bulldoze()` removes the building if any, **else removes the underground pipe if any**, else reverts to Land (`commands.rs:339–351`). Bulldozing a road with a pipe beneath removes the pipe and keeps the road — inverted vs TS.
- Root cause: the protocol has no way to express the underground-view context; `SimCommand::ApplyTool` carries only tool + coordinates (`crates/city-sim-protocol/src/commands.rs:42–49`).

### A3. Water production is not gated on a source connection (P1) — ✅ resolved (#200)
- TS: a pump/tower only contributes `waterOutput` when `hasWaterSourceConnection()` finds an adjacent water carrier outside its own footprint (`app/src/game/utilities/water.ts:41–64`, also `simulation.ts:226–235`).
- Rust (fixed): a pump's footprint must be orthogonally adjacent to `Terrain::Water` to seed the BFS or count toward `water_produced` — strict footprint adjacency, a deliberately new rule rather than a port of the TS check above (which, read closely, never actually consulted terrain). See `docs/features/water-source-gating.md`.

### A4. Money is truncated to whole dollars every tick (P0)
- TS: `money` is a float; per-tick accrual `netPerDay * dt/1.5` accumulates fractionally (`simulation.ts:501`).
- Rust: `money: i64`; `apply_money_tick` computes the new balance in f64 and casts back with `as i64`, discarding the fraction **every tick** (`crates/city-sim-core/src/economy.rs:207–211`). Consequences: systematic under-accrual (≈28% at a new-city income level), and any city with `net_per_day < 30` (delta < 1/tick) has frozen income — including frozen losses. `pop_frac`/`jobs_frac` accumulators exist for exactly this problem; there is no `money_frac`.

### A5. Population/jobs snap to capacity instead of declining gradually (P1)
- TS: `growth = clamp(desiredPop − pop, −2, 2)` — when capacity drops (abandonment, bulldoze), population declines at most 2/tick (`simulation.ts:361–372`).
- Rust: growth is `clamp(demand × 0.05, −2, 2)` accumulated, then the result is clamped to capacity with `.min(pop_cap)` — a capacity drop snaps population down instantly (`economy.rs:176–197`).

### A6. Bylaws / lighting policy entirely absent (P1)
- TS oracle scales civic/zone power use and maintenance by the lighting bylaw and nudges tile happiness toward the policy target each tick (`simulation.ts:149–151, 291–300, 332–359`; default target 1.02, `bylaws.ts`).
- Rust: no `bylaws` field on `GameState`, no `SimCommand` to set them, and the scaling is explicitly stubbed to 1.0 (`economy.rs:24–25`). The bylaws modal still exists in the UI (`app/src/ui/bylawsModal.ts`) and mutates TS-side state — **it has zero simulation effect in WASM mode**.
- Related: `pendingPenaltyEnabled` is hardcoded `true` in Rust (`demand.rs:283–285`); TS reads `state.settings`.

### A7. No per-tick happiness dynamics (P2)
Rust only touches happiness at placement (+0.05, `commands.rs:321`) and abandonment (−0.1, `buildings.rs:398`). The TS per-tick nudge toward the lighting target never happens, so tiles sit at 1.0 forever and the decay system's `unhappy` branch (`happiness < 0.4`) is nearly unreachable in Rust.

### A8. Budget `*ByType` breakdowns missing (P1)
TS `BudgetStats.breakdown.details.buildings` includes `powerByType`, `civicByType`, `zonesByType` maps (`simulation.ts:489–496`). Rust `BudgetStats` has only the scalar buckets (`economy.rs:119–139`), and `SimStats` (worker) carries no by-type fields — so the budget modal's per-type rows show stale TS-side values (whatever was in the mirror at swap time) in WASM mode. Task P3-7 called for a fixed enum table; it was not carried through to the wire.

### A9. Minor arithmetic/type divergences (P2)
- `power_used`/`water_used` rounded to i32 in Rust (`sim.rs:196–199`); TS keeps floats.
- `day` is u32 with a fractional accumulator in Rust; TS `day` is a float. HUD month boundaries survive, but sub-day values differ.
- Rust `state_hash` and TS `stateHash.ts` are engine-local tools; their values are not comparable across engines (fine, but do not mistake them for cross-engine parity checks).

---

## B. WASM transport surface gaps (vs `SimBridge` contract and Tauri path)

### B1. No snapshot save/load — the 120-tick replay cap (P0)
- Tauri exposes `get_snapshot`/`load_snapshot`/`get_map_seed`/`get_command_log`/`load_command_log` (`crates/tauri-plugin-city-sim/src/commands.rs:263–346`), backed by `snapshot.rs` (postcard, versioned header).
- WASM `SimHost` exposes **none of these** (`crates/city-sim-wasm/src/lib.rs`). `WasmSimBridge.loadState` replays the JSON-save's command log into a fresh `SimHost`, then fast-forwards — capped at `Math.min(targetTick, 120)` in both `init` and `load` (`app/src/workers/wasmSim.worker.ts`). Only money is re-synced via `set_money`.
- Effect: loading any save older than 6 seconds of sim time (120 ticks) silently rewinds tick/day/population/jobs/budget history to ≈tick 120. The display shows the saved values until the first `step_result` overwrites them. Task **P5-1 is marked done but is Tauri-only**.
- Also: saves without a `cmdLog` (older saves; `persistence.ts:246–250`) fall back to a seed-only `reset` — the sim becomes a blank map while the display still shows the loaded city until the next buffer apply erases it.

### B2. Sim events never emitted (P0) — ✅ resolved 2026-07-30 (#199)
`FromSim` (`crates/city-sim-protocol/src/events.rs`) defines `Alert`, `Narrative`, `CommandResult`, `TickStats`, but no Rust code constructs `Alert`/`Narrative`/`CommandResult` anywhere (wasm crate, core, or Tauri plugin). The TS oracle emits power/water deficit alerts and narrative events (`simulation.ts:715–787`); `main.ts` has handlers wired for them (`main.ts:199–209`) that can never fire in WASM mode. The narrative layer in WASM mode is reduced to player-action events and month-end snapshots generated TS-side.

Fixed by porting the deficit state machine into `Simulation::handle_resource_alerts` (`sim.rs`), drained per host step via `Simulation::take_alerts` and forwarded over both the WASM worker's `step_result` and the Tauri `TickEvent.alerts`. See `docs/features/sim-feedback-channel.md` for the full recovery.

### B3. Natural terrain not seeded into the Rust sim (P0) — ✅ resolved 2026-07-21 (#101)
- TS `createInitialState` generates a water border and centre speckle (`gameState.ts:241–257`); Rust `GameState::new` is all-Land (`state.rs:336–341`).
- `WasmSimBridge` compensates with a display-only mask (`naturalTileKinds` + `modifiedTiles`, `wasmSimBridge.ts:80–104, 326–347`), so the *renderer* shows water the *sim* doesn't know about. Consequences:
  - Players can build roads/zones "on water" (sim sees Land) — placement cost and rules ignore the water entirely.
  - Any future water-adjacency rule (hydro plants are specifically water-powered; pump source gating per A3) has no terrain to check.
  - Undo bookkeeping can desync the mask: `undo_result` deletes the tile from `modifiedTiles` even when an earlier command also touched the same tile (`wasmSimBridge.ts:262–268`), so a natural water/tree tile can wrongly resurface over a player-built tile.
- The right fix direction is to generate terrain inside `city-sim-core` from the seed (deterministic), drop the TS mask, and let the tile buffer be the single source of truth.

### B4. Command-log desync on rejected commands (P0)
`WasmSimBridge.send` pushes to its TS-side `cmdLog` **before** the async result arrives (`wasmSimBridge.ts:143–150`); Rust pops its own `CommandLog` when `apply_tool` fails (`crates/city-sim-wasm/src/lib.rs:153–164`), but the bridge's `apply_result` handler only `console.warn`s and never removes the rejected entry (`wasmSimBridge.ts:252–255`). The two logs then disagree. Since the TS `cmdLog` is what gets saved (`persistence.ts`) and replayed on load/engine-swap, a command rejected live (e.g. insufficient funds) can *succeed* during replay when money differs at that tick — replayed state diverges from the session the player actually had.

### B5. Rejected placements give no user feedback (P2) — ✅ resolved 2026-07-30 (#199)
`send()` returns an optimistic `{ success: true }` and `FromSim::CommandResult` is never emitted (B2), so a failed placement is invisible except for the money display correcting on the next stats tick. The TS path returned the real result synchronously.

Fixed alongside B2: the async result (success and message) now reaches `main.ts` as a `CommandResult` message on both bridges — WASM via `SimHost::last_apply_message`, Tauri via a new reply channel on `SimCmd::ApplyTool`. See `docs/features/sim-feedback-channel.md`.

### B6. `getMetadata()` returns null (P2)
The "Option B" Rust `building_metadata()` export was never implemented (`wasmSimBridge.ts:228–229`, `simBridge.ts:70–76`); UI callers fall back to TS `templates.ts`. Acceptable while templates are hand-mirrored, but it is a second source of truth for costs/footprints/capacities that can drift silently from `buildings.rs` (`building_template!` macro table).

### B7. Undo rewinds simulation time (P2)
`CommandLog::replay()` steps only until each entry's recorded tick; after the pop, the returned sim ends at the tick of the **last remaining command** (`command_log.rs:102–123`). Undoing a tool also rewinds all sim progress (money, population, growth) that happened after that command. Whether that is intended "rewind" semantics or a bug should be decided and documented; the HUD gives no hint that time moved backwards.

---

## C. Bridge/mirror integrity

### C1. Building mirror loses runtime state (P2)
`applyTileBuffer` rebuilds `state.buildings` every frame from the tile buffer with `createBuildingState()` defaults (`wasmSimBridge.ts:364–393`): `troubleTicks`, `health`, and real statuses are invisible to the UI. Status is re-derived from `powered`/`watered` flags only. The tile buffer also carries no per-tile service coverage (layout: underground|surface|overhead|status|happiness|elevation|building_id|wilderness — `tile_buffer.rs`; the pre-#177 `kind`/`flags`/`underground_kind` spelling this line originally named no longer exists), so:

### C2. Education recomputed twice, in two languages (P2)
Rust computes education for demand/decay (`education.rs`, wired in `sim.rs:133`); the bridge *also* runs the TS `recomputeEducation` against the mirror every buffer apply (`wasmSimBridge.ts:396`) to feed the HUD/overlay. Two implementations of the same coverage algorithm will drift; the HUD could show "served" while the Rust decay logic disagrees. Fix direction: put service coverage (or at least the two served bits + scores) into the tile buffer / stats.

---

## D. Verification & documentation gaps

### D1. No automated Rust-vs-TS parity harness (P1)
`regression.test.ts` states its purpose is to "later, confirm that the Rust sim_core produces values within the same bands" — that later never came; it still drives only the TS `Simulation`. The Rust golden hash (`sim.rs`) is Rust-vs-Rust determinism only. Given the drift items in section A, a fixture runner that replays the same seeds/command logs through `city-sim-core` (native, no WASM needed) and asserts the same tolerance bands is the single highest-leverage test to add before the TS oracle is retired.

### D2. P4-3 cross-platform determinism unchecked (P1)
`rust-migration-tasks.md` still has P4-3 open: no CI matrix proving identical golden hashes on x64/ARM, web/native. The sim uses `f32`/`f64` arithmetic throughout, so this is not a formality.

### D3. CI never tests the WASM crate (P2)
`ci.yml` runs `cargo clippy`/`nextest` with `--exclude city-sim-wasm`; the wasm crate is only ever *built* (`wasm-pack build`, ci.yml:283). Nothing executes the compiled WASM (e.g. a `wasm-bindgen-test` or a Playwright smoke test asserting `tick_count` advances and a tool round-trips).

### D4. Documentation contradicts the code (P2)
- `CLAUDE.md` and task P5-4 say "`LocalSimBridge` has been removed" — it exists (`app/src/game/localSimBridge.ts`), is imported by `main.ts:22`, and is reachable via `?bridge=ts` and the engine-swap toggle (`main.ts:188–194, 223–229`). It also imports `simulation.ts`, contradicting "do not import this file from production code".
- `demand.rs:222` says "Education is stubbed to 0 until P3-8" but the code reads real `state.education` values (P3-8 shipped) — stale comment.
- The golden hash in `rust-migration-tasks.md` (P3-10, `0x3d128c538d40e908`) no longer matches `sim.rs` (`0xb234ed590e7135fb`) — expected after tuning, but the doc should say "see `sim.rs`" instead of embedding the value.

---

## Priority rollup

| Pri | Item | Section |
|-----|------|---------|
| P0 | Money truncated every tick (frozen income below 30/day) | A4 |
| P0 | No WASM snapshot API; loads capped at 120-tick replay | B1 |
| ~~P0~~ | ~~`FromSim` alerts/narrative never emitted~~ — resolved (#199) | B2 |
| ~~P0~~ | ~~Natural terrain absent from Rust sim; display-only mask~~ — resolved (#101) | B3 |
| P0 | TS/Rust command-log desync on rejected commands | B4 |
| P1 | Power line destroys zones | A1 |
| P1 | Bulldoze precedence + missing underground-mode context | A2 |
| P1 | ~~Water production not gated on source connection~~ (resolved, #200) | A3 |
| P1 | Population snaps to capacity on loss | A5 |
| P1 | Bylaws/settings have no effect in WASM mode | A6 |
| P1 | Budget by-type breakdowns missing from wire | A8 |
| P1 | No Rust-vs-TS parity harness for the golden fixtures | D1 |
| P1 | P4-3 cross-platform determinism unproven | D2 |
| P2 | Happiness dynamics absent; rounding/type divergences | A7, A9 |
| P2 | ~~No placement-failure feedback~~ (resolved, #199); `getMetadata()` null | B5, B6 |
| P2 | Undo rewinds sim time | B7 |
| P2 | Mirror loses building state; duplicate education calc | C1, C2 |
| P2 | WASM crate untested in CI; docs drift | D3, D4 |

## Suggested order of attack

1. **A4** (`money_frac` accumulator) — one-file fix, immediately closes the biggest silent economy drift.
2. **B4** (pop TS `cmdLog` on `apply_result: false`) — small bridge fix protecting every save made from now on.
3. **B1** (expose `snapshot_bytes()`/`load_snapshot_bytes()` on `SimHost`, store snapshot in the save alongside the cmdLog) — removes the 120-tick cap and the money/set_money workaround.
4. **B3** (seed terrain in `city-sim-core` from the seed; delete the display mask) — unblocks A3-style water rules and makes the tile buffer authoritative.
5. ~~**B2** (emit `FromSim` events from the tick loop; forward via worker/Channel) — restores alerts + narrative on the production path.~~ — done (#199).
6. **D1** (native fixture parity harness) — then burn down the A-section drift items with the harness as the referee, and decide each one: match the TS behaviour, or ratify the Rust behaviour and update the oracle/fixtures + `docs/game-parameters.md`/manual.
