# Testing

This document covers the four **architecture harnesses** — the tests that check the simulation at a higher altitude than a unit test can reach — plus the ordinary gates around them, what they deliberately do not cover, and how to regenerate the committed baselines.

## Why these exist

The strata tile model (#177, `docs/tile-model.md`) was verified almost entirely by unit tests, and that turned out to be the wrong altitude. `Tile` went from a single-valued `kind` plus bolt-on flags to per-stratum occupant sets, with the wire `kind`/`flags` bytes now **derived** for the renderer (`crates/city-sim-core/src/display.rs`) and old saves migrated (`migrate.rs`). Four classes of defect were invisible to the tests that shipped with it:

- A **wrong sprite** with every assertion green — `display.rs` exists to emit bytes a renderer interprets, and a numeric assertion cannot see what those bytes draw. One real shift was measured by hand during the work: a level crossing's minimap pixel moved from rail-brown to road-grey, and nothing in CI would have caught it.
- A **drifting oracle** — `app/src/game/simulation.ts` and `adjacency.ts` mirror engine logic as a test-only parity oracle. They drifted from Rust three times during #177 and were repaired by hand-reading both files. No test failed when they disagreed.
- A **throwaway probe** — a "replay commands on two builds, diff the observables" tool was written, used and deleted three times over the same change.
- A **long-run defect** — nothing exercised more than a handful of ticks. `StructureLookup::new` allocates a vector sized by `next_building_id`, which climbs for ever under zone churn. Real, unfixed, and exactly what a soak surfaces.

Each harness closes one of those. They are meant to be **committed tools**, not scaffolding: each is runnable with one command, each is fast enough for CI, and each is wired into `.github/workflows/ci.yml`.

## Vocabulary

Used consistently across the harnesses and the code they test:

- **canonical** — the source of truth. The per-stratum occupant sets on `Tile`.
- **derived / view / projection** — computed from the canonical state. The wire `kind`, `flags` and `underground` bytes.
- **persisted / snapshot** — bytes only. What `snapshot.rs` writes and `migrate.rs` reads.

## Every command

All run from the repo root.

| Command | What it runs | Cost |
| --- | --- | --- |
| `cargo test --workspace` | all Rust, including the golden city and the default soak | ~8 s |
| `bun run test` | all TypeScript, including cross-engine parity | ~2 s |
| `bun run test:e2e` | all three Playwright projects, including visual regression | ~26 s |
| `cargo test -p city-sim-core --test golden_city` | harness 1 alone | 0.5 s |
| `bun run test:parity` | harness 2 alone | 0.6 s |
| `bun run test:visual` | harness 3 alone | ~13 s |
| `bun run test:soak` | harness 4 alone, default size | 7.5 s |
| `bun run test:soak:long` | harness 4, 3 000 simulated days | ~140 s |
| `bun run lint` | `tsc --noEmit` | ~5 s |
| `cargo clippy --workspace --exclude city-sim-wasm --all-targets -- -D warnings` | Rust lints | ~30 s cold |
| `cargo fmt --all -- --check` | Rust formatting | instant |

Two prerequisites after a fresh clone or worktree, both of which produce gitignored output:

```bash
bun run build:wasm        # app/src/wasm/ — needed by dev, by e2e, and by the parity harness
bun run build:plugin-js   # crates/tauri-plugin-city-sim/dist-js/ — needed by the Vite dev server and build
```

---

## Harness 1 — the golden city

**Files:** `crates/city-sim-core/tests/golden_city.rs`, `crates/city-sim-core/tests/fixtures/golden_city.script`, `crates/city-sim-core/tests/fixtures/golden_city.expected`. Documented in detail in `crates/city-sim-core/tests/fixtures/README.md`.

```bash
cargo test -p city-sim-core --test golden_city                 # run — 4 tests, 0.5 s
GOLDEN=regen cargo test -p city-sim-core --test golden_city    # regenerate the dump
```

A committed command script and a committed dump of everything observable after replaying it. The script is **data, not code** — `grid w h`, `seed n`, `tick n`, `<Tool> <x> <y>`, `refuse <Tool> <x> <y>` — so adding a case is a line in a text file. Tool names resolve from the `Tool` enum's own `Debug` spelling, so renaming a variant breaks the script loudly rather than silently.

A 24×16 city (deliberately non-square, so a transposed x/y cannot pass), seed `20260729`, 400 ticks in two stretches so the gallery of awkward states is built into a **live** city. It ends at population 141, jobs 117, 32 buildings, near-break-even budget, wilderness 44.49, education coverage 0.55 — every dumped block carries real numbers rather than zeroes.

### What it covers

Every tile line carries both halves at once — the **derived** wire bytes (`kind`, `flags`, `ug`) and the **canonical** tile (`terrain`, `occ`, `bid`). A derivation that drifts from the strata under it shows up as the two halves of one line disagreeing.

Level crossings in both build orders plus a third carrying a line; a hydro line over road, over rail, over a level crossing, over a vacant zone, and over a lot that then develops under it; a road laid under an existing line; a lone line; a line demoted to its flag by a later regrade, with a pipe under it; trees planted through a live line; water brushed over a live line; a pipe under a road, a lone pipe, a pipe under water; 1×1 and 2×2 footprints; a 1×1 structure razed where v4 left a scoring ghost; a 2×2 footprint cleared by one click anywhere inside it; a bulldozed lake that is still a lake; a lake paved and the pavement razed, which is not; an abandoned lot; and a power plant deliberately left off the network.

Three companion tests keep the fixture honest rather than merely stable: it replays twice and diffs (determinism); it asserts every awkward case above is *still* built, so a well-meaning script edit cannot quietly delete coverage while leaving the dump green; and it catches a silently truncated dump.

### What it does NOT cover

- **Anything above the wire bytes.** It pins the bytes, not the sprite. That is harness 3's job.
- **Other platforms.** The dump is only ever verified on x86-64 Linux. The wilderness patch bonus goes through `f32::exp`, a libm routine that may differ by an ulp across platforms; see the reproducibility caveat in the fixtures README.
- **Any map but this one.** One grid, one seed, one script.
- **Save/load.** The city is built by replaying commands, never by round-tripping a snapshot.

### Regenerating

`GOLDEN=regen` rewrites `golden_city.expected`. **See the warning below** — the dump is a derived artefact, so a wrong derivation and a stale expectation look identical from the outside.

---

## Harness 2 — cross-engine parity

**Files:** `app/src/game/parity/tileFacts.ts`, `engines.ts`, `replay.ts`, `crossEngineParity.test.ts`.

```bash
bun run test:parity    # 36 tests, ~0.6 s — needs `bun run build:wasm` first
```

One command script, two engines, one vocabulary of answers. The Rust side is the **real** `SimHost` cdylib out of `app/src/wasm/`, loaded in vitest's node environment by dynamic import; the TS side is `simulation.ts` / `applyTool`, the declared test-only oracle. Both start from an identical map — `createInitialState`'s terrain is pushed into Rust via `set_natural_terrain` — and both answer through the same `factsFromWire`, so the mapping itself cannot hide a disagreement.

`replay(script, opts)` returns a typed `Disagreement[]` over three observable classes: per-command `accepted`, per-tile facts, and headline scalars. The fact vocabulary is deliberately spelling-agnostic (`water`, `trees`, `road`, `rail`, `line`, `zone`, `structure`, `pipe`, `developed`, `powered`, `watered`, `abandoned`).

If `bun run build:wasm` has not been run, the harness **fails with an actionable sentence** rather than skipping. A parity harness that can quietly no-op is worse than no parity harness, which is why the CI job builds WASM rather than tolerating its absence.

### What it covers

9 named placement scenarios, 3 running-city scenarios, 22 fuzz scenarios (a cheap-tool palette ×12 at 300 commands, a footprint palette ×6 at 60 commands, tick-and-settle ×4), and 2 pinned known drifts. The fuzz uses a seeded LCG, so a failure is reproducible from the seed printed in the test name.

### Two known drifts, pinned rather than papered over

Both are recorded as assertions that fail if the drift *changes*, so neither can widen unnoticed. Rust is canonical in both cases:

1. **The engine credits water production from a pump that is neither powered nor beside water.** The oracle credits nothing.
2. **The two engines disagree on whether a lot activates in a city with no water system.** `Simulation::tick_fixed` gates the water requirement on `state.has_water_system()`; `simulation.ts` passes `waterEnabled: true` unconditionally, so every lot in a city that has never seen a pipe sits at `InactiveNoWater`. Closing this means changing `simulation.ts`, which moves the committed goldens in `stateHash.test.ts` and the tolerance bands in `regression.test.ts` — an oracle-calibration decision, not a test one.

### What it does NOT cover

- **The raw `kind` byte.** Every predicate in the vocabulary is invariant under `display.rs`'s three normalisations; the byte itself is harness 1's and harness 3's ground.
- **Wilderness.** Excluded by decision 4 of `docs/features/wilderness-score.md`.
- **Education, the budget breakdown, per-tile happiness, narrative events, undo/redo.** The oracle is not compared on any of these.
- **The Tauri bridge.** Only the WASM `SimHost` is driven.

### Regenerating

Nothing to regenerate — there is no baseline file. When it goes red, one of the two engines is wrong, and the fix is in an engine, not in the harness.

---

## Harness 3 — visual regression

**Files:** `app/e2e/visual.spec.ts`, `app/e2e/__screenshots__/linux/{a-level-crossings,b-hydro-lines,c-parks-and-water,d-minimap}.png`, and the `visual` project in `app/playwright.config.ts`.

```bash
bun run test:visual           # run — 1 test, 4 images, ~13 s including the Vite build
bun run test:visual:update    # regenerate the baselines (Linux only)
bun run test:e2e              # runs this project alongside the two mobile ones
```

One city, one page, one fixture build, four images compared with soft assertions so all four report together. Everything sits in rows 22–30, clear of the bottom-anchored HUD panels. The project pins a 1440×900 viewport at `deviceScaleFactor: 1`, forces the sRGB colour profile, disables LCD text, and pins the rasteriser to SwiftShader — a developer machine silently swapping in a real GPU would produce diffs that mean nothing. `maxDiffPixels: 0`: the tile art is flat dithered pixel art with a fixed camera, so any difference at all is a real one.

It is organised around `display.rs`'s **three deltas** — the three classes of tile that come off the wire differently than they did at `303897f`, the last commit where `kind` was canonical:

1. **A bare level crossing.** Rail now wins the kind byte in both build orders, so a road-last crossing's flat colour moves. The sprite is unchanged; the minimap pixel is not.
2. **A bare hydro line.** `PowerLine` now wins over a regrade. Measured here to be a visual no-op.
3. **A bulldozed footprint building.** The razed tile now emits `Land` instead of keeping a ghost `Park`.

Each fixture names the delta it pins, or says explicitly that it is a control that must NOT have moved.

The images are known to be **sensitive**, not merely stable. Reverting `wire_kind`'s road/rail precedence moves `d-minimap.png` and nothing else, exactly as `display.rs` predicts; dropping its zone rung moves `b-hydro-lines.png` by 3 899 pixels. Neither mutation is committed — re-running them is how you check the harness has not gone blind.

### What it does NOT cover

- **Sprite variant selection and autotiling.** One camera, one zoom, one set of clips. The 15-variant power-line tileset, road and rail autotiling across every junction, and every zoom level are unpinned.
- **The overlays and the HUD.** Power, water and wilderness overlays, the ribbon, modals and the news ticker are not screenshotted.
- **Non-Linux platforms.** Baselines are per-platform by design: Chromium rasterises WebGL differently across operating systems, so a macOS run reports "snapshot missing" — loud and obviously not a regression — rather than a false diff. The consequence is real: a macOS developer cannot iterate on these locally and has to read CI.
- **The Tauri bridge.** The page runs the WASM bridge.

### Regenerating

`bun run test:visual:update`, on Linux, with the same SwiftShader rasteriser the config pins. **See the warning below.**

---

## Harness 4 — the soak

**File:** `crates/city-sim-core/tests/soak.rs`. The module note at the top of that file is the long-form version of this section.

```bash
bun run test:soak         # default — 24×16, 160 simulated days (4 800 ticks), 7.5 s
bun run test:soak:long    # SOAK=long — 3 000 days (90 000 ticks), ~140 s
SOAK=20000 cargo test -p city-sim-core --test soak -- --nocapture
```

`SOAK` takes `ci` (the default), `long`, or a plain number of days. `--nocapture` is worth having: the soak prints a checkpoint table (population, money, live buildings, `next_building_id`, `state_hash`) and an allocation summary, and those tables are how you read a failure.

The map is small on purpose. Every system in `tick_fixed` is a full-map pass, so cost is linear in tiles, and what surfaces a leak is *elapsed ticks*, not area. Spending the budget on days rather than on area is what makes a CI-sized run long enough to be worth running.

The soak also models the **20 Hz host emit loop**. Both hosts — `city_sim_wasm::SimHost::tile_buffer` and the Tauri plugin's tick event — build a `StructureLookup` and derive the wire bytes for every tile on *every* tick, because since #177 those bytes are derived rather than persisted. A soak that only called `step` would miss the busiest allocation path in the product.

### What it asserts

- **No panic.** Just running is the assertion.
- **No non-finite float and no wrapped count.** Every `f32` a player sees — the whole of `BudgetStats`, `DemandStats`, `EducationStats`, the wilderness score and its full breakdown, and per-tile happiness — checked at every checkpoint. The stats structs are checked by **exhaustive destructuring**, so adding a field fails to compile here until someone says what "sane" means for it.
- **No dangling `building_id`.**
- **`state_hash` reproducibility.** Two independently built, independently stepped cities are compared at every checkpoint, not just at the end, so a divergence names the checkpoint it started at.
- **Bounded allocation**, at two resolutions: a coarse bytes-per-tick aggregate over an early and a late window, and a fine-grained probe on `StructureLookup::new` normalised by the live building count. Allocation is measured by a thread-local counting `GlobalAlloc`. It is a deterministic function of state, so there is no flake budget — the numbers are the same on every machine.

### What it does NOT cover

- **Performance.** Nothing fails when a tick gets ten times slower. Only allocation is gated.
- **Any city but one.** One shape, one seed, one command palette. A leak reachable only through repeated terraforming, repeated save/load, or undo/redo churn is not covered.
- **Peak memory as a budget.** Peak live heap is printed, not asserted against a ceiling.

### It is currently RED — and that is correct

The `StructureLookup::new` probe fails. See "Current status" at the end of this document. **Do not silence it** by widening `LOOKUP_GROWTH_TOLERANCE`, shortening the run, or reducing the churn. The fix belongs in `occupants.rs`.

---

## Regenerating a baseline is a deliberate act

Two of these harnesses carry committed baselines: `golden_city.expected` and the four PNGs under `app/e2e/__screenshots__/linux/`.

Both baselines are **derived artefacts**. That is precisely what makes them dangerous: a wrong derivation and a stale expectation look identical from the outside, and both are cured by pressing the regenerate button. "Regenerate until green" is the way this kind of harness dies — not with a decision, but with a habit.

So:

- **Never regenerate to make a build pass.** Regenerate only once you can say, in words, what moved and why it was supposed to move.
- **Justify it in the commit message.** Every line of the golden dump that moves, and every image that changes, must be named and explained. A diff nobody can explain is a bug report, not a merge.
- **Read the diff before you trust it.** The golden dump prints one thing per line so a diff points at the thing that moved. The Playwright HTML report shows expected/actual/diff for every changed image; the diff artefact is uploaded by CI.
- **A baseline change and a behaviour change belong in the same commit.** A regeneration committed on its own has no reviewable justification attached to it.
- **If you cannot explain it, it is a finding.** Report it. Do not adjust the expectation to fit the code.

The same rule holds for the pinned known drifts in harness 2 and the documented normalisations in the v4 migration fixture: they are pinned so a *change* to them fails. Widening a pin is the same act as regenerating a baseline, and needs the same justification.

`crates/city-sim-core/tests/fixtures/city_v4.csim` is the exception that proves the point — it is a genuine pre-strata save, generated at `303897f` by a test that was deleted immediately afterwards, and it **cannot be regenerated at all**. A migration you can only demonstrate against your own output is not a migration.

---

## CI

`.github/workflows/ci.yml`. All jobs run in parallel; the critical path is `mobile-e2e`, so the harnesses add no wall-clock time to a CI run beyond what that job already spends.

| Job | Harness it carries | What it added |
| --- | --- | --- |
| `rust-test` | golden city, default soak | Nothing to wire — `cargo nextest run --workspace` picks both up. nextest gives each its own process, so the soak's ~8 s is what sets the job's test wall clock and the other 322 tests are free. |
| `ts-test` | cross-engine parity | Needed the WASM build. This job now installs the Rust toolchain with the `wasm32-unknown-unknown` target, restores the Rust cache, installs `wasm-pack` and runs `bun run build:wasm` before `bun run test:ci` — the same shape `mobile-e2e` already used. Roughly +90 s cold, +20 s with a warm cache; still well under the critical path. |
| `mobile-e2e` | visual regression | Nothing to wire — the `visual` Playwright project is picked up by the existing `bun run test:e2e`. About +10 s. The job's `name:` was deliberately left alone so branch-protection check names do not move. |
| `rust-soak-long` | the long soak | New job, `workflow_dispatch` only, so it costs nothing on pull requests and pushes. Run it from the Actions tab before merging anything that touches allocation on the tick or wire-emit paths. |

The visual baselines are Linux-specific, which is why that project has to run on the Linux runner and cannot be validated from a developer's machine on another OS.

---

## The gaps that remain

Honest rather than reassuring. These four harnesses close four specific holes; they do not make the simulation well-tested.

| Gap | Detail | Cost of closing |
| --- | --- | --- |
| **The Tauri bridge is never executed** | `tauri-plugin-city-sim` only gets `cargo build`. Nothing drives `TauriSimBridge` end to end. The soak *models* the plugin's wire-emit loop in `emit_wire_frame` but does not run it, so the model can silently stop matching. | High — needs a headless Tauri harness or a WebDriver runner. |
| **Save/load is only pinned across the v4 migration** | Nothing writes a save on this tree, reloads it, and asserts the city is identical. `city_v4` proves v4 → v5. Round-tripping a v5 CSAV container — engine snapshot plus `ClientState`, settings, bylaws — is unproven. | Low. A golden-city variant that snapshots, reloads and re-dumps would be a day's work and would reuse the existing dump code. |
| **Cross-platform float determinism of the golden dump** | Only ever verified on x86-64 Linux. The `rust-determinism` matrix runs `golden_hash` on arm64, not the golden city. The `f32::exp` ulp caveat in the fixtures README is theoretical — never actually exercised. Deliberately left out of the blocking matrix rather than added untested. | Low, but it may go red on first contact. Check with `cargo nextest run -p city-sim-core -E 'binary(golden_city)'` on arm64 before wiring it in. |
| **Renderer above the wire bytes** | Harness 3 pins four clips of one city at one zoom. Sprite variant selection, road/rail/line autotiling across every junction, the 15-variant power-line tileset, every zoom level, and the power/water/wilderness overlays are all unpinned. | Medium. More fixtures in the same spec; the machinery exists. |
| **Undo/redo and command history** | `history.rs` is unit tested only. No harness replays an undo/redo sequence and compares the result to the state before it, and neither the golden city nor the parity script issues one. | Low. `refuse`/`undo` directives in the golden script, and an `undo` verb in the parity replay. |
| **Parity's observable set is a chosen subset** | Wilderness, education, budget breakdown, per-tile happiness and narrative events are not compared between engines. Two drifts are knowingly pinned open — the oracle is wrong about the water-system gate and about idle-pump production. | Medium, and it is a calibration decision: fixing the oracle moves committed goldens in `stateHash.test.ts` and the bands in `regression.test.ts`. |
| **No performance gate anywhere** | Allocation is bounded; time is not. A tick that gets ten times slower passes every test in this repo. | Medium — a timing gate needs a flake budget, which allocation did not. |
| **The soak is one city shape** | 24×16, one seed, one command palette, one map. Leaks reachable through terraforming churn, save/load churn or undo/redo churn are out of reach. | Low. `SOAK` already parameterises the length; the shape and palette would need the same treatment. |
| **Mutation coverage is checked by hand, once** | Harness 3's sensitivity was proved by two deliberate mutations that were run and then discarded. Harness 1's and 4's were not proved that way at all. Nothing re-checks that any of these harnesses can still fail. | High to automate properly. In the meantime, re-run the two documented mutations described in `visual.spec.ts` whenever `display.rs` changes shape. |

---

## Current status

**`cargo test --workspace` is RED, on purpose, because of a real engine defect the soak found.**

```
city-sim-core unit tests   299 passed
golden_city                  4 passed
soak                         1 passed, 1 FAILED
city-sim-protocol           19 passed
```

Everything else is green: `bun run test` 342 passed (35 files, including the 36 parity tests), `bun run lint` clean, `bun run test:e2e` 15 passed (including the visual project), `cargo clippy -p city-sim-core --all-targets -- -D warnings` clean, `cargo fmt --all -- --check` clean.

### The finding

`crates/city-sim-core/src/occupants.rs:1107` — `StructureLookup::new` allocates `vec![None; max(max_live_id, next_building_id) + 1]`. It is sized by the **building-id space**, not by the buildings in it, and that id space only ever grows: develop/abandon churn mints about 1.2 new ids per simulated day and none are ever reused or compacted.

On the default run the worst call in a window goes 78 B → 204 B (2.62×) while the live count it indexes stays at 28 (1.00×). On `SOAK=long` it goes 78 B → 4 389 B (56×) against the same flat live count, and the coarse aggregate reaches 1.23× against its 1.25× tolerance — given a few hundred more days, even the general net would catch it.

Two things were checked by experiment rather than assumed, because they decide what a fix has to be:

- **Removing `.max(state.next_building_id)` is not a fix.** With it removed the probe still reports 77 B → 203 B: the highest *live* id climbs with the counter, because a freshly developed lot holds a freshly minted id and under churn there is nearly always one alive. Both halves of that `max` are unbounded.
- **Sizing the index by the live building count is a fix, and a behaviour-preserving one.** Swapping the `Vec` for a map keyed by id holds the allocation flat at 304 B across the whole run and leaves every `state_hash` in the checkpoint table byte-for-byte identical.

The allocation sits on the 20 Hz host emit path (`SimHost::tile_buffer` and the Tauri tick event) as well as on `state_hash` and `compute_wilderness`, so it is hot.

This is an engine change, and the harness branch deliberately does not make it. Until it lands, the `rust-test` CI job fails.
