# Rust Migration — Execution Map (Task Breakdown)

**Companion to** [`rust-migration-plan.md`](./rust-migration-plan.md) (the strategy / north star).
This doc is the **steady map you follow**: granular tasks, ordered, with acceptance
criteria and dependencies. Update the checkboxes as you go.

> **How to use this:** Work top-to-bottom within a phase; respect `deps`. Each task has a
> **DoD** (definition of done) that must be green before checking it. Task IDs (`P0-1`…)
> are stable so this doc can be mechanically promoted to a GitHub epic + sub-issues later
> — each issue links back to its task here; rationale stays in the plan doc, not the issue.

**Legend:** `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked
**Global gate:** every task ends green on `bun run test` and (once Rust exists) `cargo test`.

---

## Phase 0 — Make the TS sim deterministic + build the oracle
*Goal: a run-to-run deterministic TS sim and a regression harness, entirely in the
current codebase. No Rust yet. This is the safety net the whole migration leans on.*

- [x] **P0-1 · Seeded PRNG in TS.** Add a small SplitMix64+xoshiro128** PRNG module
  (mirror of the planned Rust one). `deps:` none.
  **DoD:** unit test proves same seed → same sequence; matches the Rust algorithm's
  reference vectors (record them now so Rust can assert against the same vectors).
- [x] **P0-2 · Thread `seed` into `GameState`.** Add `seed:number` + a live RNG instance;
  default-seed factory; back-fill in `persistence.deserialize`. `deps:` P0-1.
  **DoD:** new field defaulted for old saves; `npm run lint` clean.
- [x] **P0-3 · Replace the 2 `Math.random()` calls** in `spawnZoneBuildings`
  (`simulation.ts:596` shuffle, `:609` growth roll) with the seeded RNG. `deps:` P0-2.
  **DoD:** existing `tools.test.ts` random-stubbing tests updated to drive the seeded RNG;
  sim is run-to-run identical for a fixed seed + command list.
- [x] **P0-4 · State-hash util (TS).** Stable hash over gameplay-affecting state (sorted,
  integer-quantised floats). `deps:` P0-3. **DoD:** running a fixture twice → identical
  hash, 10/10 runs.
- [x] **P0-5 · Golden scenarios + tolerance-banded fixtures.** Pick 3–4 seeds + command
  logs (small/medium maps; cover power, water-stub, zones, abandonment). Record
  population, money trajectory, tile-kind counts, abandonment as JSON fixtures with
  tolerance bands. `deps:` P0-4.
  **DoD:** a `regression.test.ts` replays each scenario and asserts within bands; committed.

## Phase 1 — Monorepo + protocol + bridge seam (no real Rust sim)
*Goal: app runs exactly as today, but the UI talks to the sim through `SimBridge`, and
the Rust workspace exists and compiles.*

- [x] **P1-1 · Scaffold Cargo workspace** (`sim_core`, `sim_protocol`, `sim_wasm`,
  `sim_tauri`). Benches live inside `sim_core`, not a 5th crate. `deps:` none.
  **DoD:** `cargo check --workspace` green; `.gitignore` covers `/target`, wasm output.
- [x] **P1-2 · `sim_protocol` types.** `SimCommand`, `FromSim`, `SystemStats`,
  `SimEvent`, **`TileKind` ↔ u8 mapping (single source of truth)**, and the **tile buffer
  layout** (SoA field offsets). serde + postcard. `deps:` P1-1.
  **DoD:** round-trip serialize test; the u8↔TileKind table has an exhaustive test.
- [x] **P1-3 · TS protocol mirror** `src/game/protocol/*.ts` (commands, diffs, tile-buffer
  offsets) kept in sync with P1-2 (codegen or hand-mirrored + a parity test). `deps:` P1-2.
  **DoD:** a test asserts the TS `TileKind`→u8 map equals the Rust one (via a committed
  JSON dump from Rust).
- [x] **P1-4 · `SimBridge` interface** in TS (`init/send/onMessage/dispose`). `deps:` P1-3.
- [x] **P1-5 · `LocalSimBridge`** wrapping the *existing* TS `Simulation` behind the
  interface; `main.ts` stops touching `Simulation` directly and goes through the bridge.
  `tools.ts` becomes a command *encoder* (Tool+coords → `SimCommand`). `deps:` P1-4.
  **DoD:** game plays identically to today; Phase-0 regression fixtures still pass.

## Phase 2 — End-to-end pipe with a STUB Rust sim
*Goal: de-risk the hardest integration — Worker + shared memory + tile mirror — before
porting any real logic. The Rust `step()` here is trivial (flip a few tiles).*

- [x] **P2-1 · `sim_wasm` cdylib + `SimHost`** with a stub `step()` and a tile buffer it
  writes into. `deps:` P1-2. **DoD:** `wasm-pack build` produces a loadable module. ✓
- [x] **P2-2 · Worker host + tile mirror.** Worker owns the WASM sim; tile buffer sent to
  main thread via transferable `ArrayBuffer`. `deps:` P2-1.
  **DoD:** renderer draws tiles read *only* from the mirror; stub tile (1,1) flips
  Land↔Road each tick when `?bridge=wasm` is set. ✓
- [x] **P2-3 · `WasmSimBridge`** (Worker `postMessage` for structured msgs; transferable
  `ArrayBuffer` for tiles). Swap it in behind `SimBridge` via `?bridge=wasm`. `deps:` P2-2.
  **DoD:** Init → tick → one command round-trips → TickStats arrives in the UI. ✓
- [x] **P2-4 · COOP/COEP headers set** in Vite dev server and `vite preview`; transferable-
  `ArrayBuffer` fallback is the current implementation (no SAB yet). `deps:` P2-2.
  **DoD:** `crossOriginIsolated` is true on dev server; upgrade to SAB is a Phase 3 task. ✓

## Phase 3 — Port systems into `step()` (oracle-checked after each)
*Goal: fill the real simulation into `sim_core`. After EACH task, run the Phase-0
regression fixtures (now driving the Rust sim via the bridge) — they must stay in band.
Add a Rust-to-Rust golden hash + tick-by-tick hash log to binary-search divergence.*

- [x] **P3-1 · `sim_core` state + accessors + RNG** (`GameState`, `Tile` SoA, tile(x,y),
  index↔coords, derived per-system RNG). `deps:` P2-3. **DoD:** Rust RNG matches the
  P0-1 reference vectors; state unit tests pass.
- [x] **P3-2 · Power network (BFS).** `deps:` P3-1.
- [x] **P3-3 · Water network (real model, not the stub).** Decide the actual pipe/source
  model here. `deps:` P3-2.
- [x] **P3-4 · Zone growth (uses derived RNG).** `deps:` P3-3.
- [x] **P3-5 · Building state machine** (`updateBuildingStates`, statuses, trouble ticks,
  abandonment). `deps:` P3-4.
- [x] **P3-6 · Demand.** `deps:` P3-5.
- [x] **P3-7 · Economy / budget** incl. the `*ByType` breakdown maps (intern to a fixed
  enum table rather than `HashMap` — see plan §3). `deps:` P3-6.
- [x] **P3-8 · Education + services + serviceDistribution.** `deps:` P3-7.
- [x] **P3-9 · Command validation = port `applyTool` rules** (cost, road access,
  overwrite/clear, transport-vs-zone semantics) into `sim_core`; commands return
  success/error per protocol. `deps:` P3-5 (needs building placement).
  **DoD for P3-x (each):** the system's own unit tests pass **and** all Phase-0
  regression fixtures stay in band **and** the Rust golden hash is stable run-to-run.
- [x] **P3-10 · Parity milestone.** Full sim ported; all regression fixtures in band;
  golden hash committed (`0x3d128c538d40e908`, seed=42, 8×8 city, 100 ticks). `deps:` P3-1..P3-9.

## Phase 4 — Tauri v2 transport
- [ ] **P4-1 · `sim_tauri` backend** runs `sim_core` natively; commands + Channel events;
  tile buffer over a Channel. `deps:` P3-10.
- [ ] **P4-2 · `TauriSimBridge`** + runtime detection (web→WASM, desktop→Tauri). `deps:`
  P4-1. **DoD:** desktop build plays identically; same renderer, same fixtures pass.
- [ ] **P4-3 · Cross-platform determinism check** — golden hash identical on x64 + ARM,
  web + native. `deps:` P4-2. **DoD:** CI matrix proves it (validates the fixed-point
  decision).

## Phase 5 — Artifacts, cutover, polish
- [ ] **P5-1 · Snapshot save/load** (postcard) + one-time JSON→new import shim. `deps:`
  P3-10.
- [ ] **P5-2 · Command-log replays** (record + play back; the real shareable artifact).
  `deps:` P5-1.
- [ ] **P5-3 · Map/seed export.** `deps:` P5-1.
- [ ] **P5-4 · Delete the TS sim** (`simulation.ts` + sim-only helpers); UI keeps tile
  mirror + protocol + narrative/services UI only. `deps:` P3-10, P5-1.
  **DoD:** `LocalSimBridge` removed or demoted to a test-only oracle; app ships on
  Rust core; docs/manual/SPEC updated.
- [ ] **P5-5 · (Optional) Undo via delta ring buffer** (~50 s / ~6 MB). Only if an undo
  feature is wanted. `deps:` P3-10.
- [ ] **P5-6 · Benchmarks + CI for both targets** (criterion in `sim_core`; wasm + tauri
  build workflows). `deps:` P4-2.

---

## Decisions still open (resolve before the phase that needs them)
- **Map-size ceiling** we're designing for (drives whether SAB/SoA is mandatory). *Needed
  by P2-2.*
- **Real water model** (pipes/sources/pressure?) replacing the stub. *Needed by P3-3.*
- **`*ByType` breakdown representation** — fixed enum table (preferred) vs `HashMap`.
  *Needed by P3-7.*
- **Save break vs. import shim** scope. *Needed by P5-1.*

## If/when we promote to a GitHub epic
- One **epic issue** = link to `rust-migration-plan.md`; checklist of the 6 phases.
- One **sub-issue per task** (`P0-1`…), title = task line, body = DoD + deps + a link to
  this doc's anchor. Generate with `gh issue create` from this file; **do not** copy
  rationale into issues — keep a single source of truth.
- Use a `rust-migration` label + a milestone per phase for burndown.
