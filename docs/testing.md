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

That coverage test asks each case in whichever of four ways can see it — a run of tools on one tile, a shape in the replayed city, an in-order walk over footprint rects for the 2×2 raze (which spans two tiles and so fits neither of the first two), and a power-adjacency check for the isolated plant. The fixtures README sets out which case goes which way and why. Each was verified by deleting the case, regenerating the dump so the diff test stayed green, and watching the coverage test be the only thing that failed.

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
bun run test:parity    # 42 tests, ~0.6 s — needs `bun run build:wasm` first
```

One command script, two engines, one vocabulary of answers. The Rust side is the **real** `SimHost` cdylib out of `app/src/wasm/`, loaded in vitest's node environment by dynamic import; the TS side is `simulation.ts` / `applyTool`, the declared test-only oracle. Both start from an identical map — `createInitialState`'s terrain is pushed into Rust via `set_natural_terrain` — and both answer through the same `factsFromWire`, so the mapping itself cannot hide a disagreement.

`replay(script, opts)` returns a typed `Disagreement[]` over three observable classes: per-command `accepted`, per-tile facts, and headline scalars. The fact vocabulary is deliberately spelling-agnostic (`water`, `trees`, `road`, `rail`, `line`, `zone`, `structure`, `pipe`, `developed`, `powered`, `watered`, `abandoned`).

If `bun run build:wasm` has not been run, the harness **fails with an actionable sentence** rather than skipping. A parity harness that can quietly no-op is worse than no parity harness, which is why the CI job builds WASM rather than tolerating its absence.

### What it covers

9 named placement scenarios, 5 running-city scenarios, 26 fuzz scenarios (a cheap-tool palette ×12 at 300 commands, a footprint palette ×6 at 60 commands and 30 ticks, tick-and-settle ×4, serviced-city ×4 at 80 commands), and 2 pinned known drifts. The fuzz uses a seeded LCG, so a failure is reproducible from the seed printed in the test name.

The twelve-predicate fact vocabulary is covered as follows, and the split is deliberate rather than incidental:

- **The eight structural facts** — `water`, `trees`, `road`, `rail`, `line`, `zone`, `structure`, `pipe` — by every scenario, including all 26 fuzz ones.
- **`powered`** by the serviced-city family and by the footprint family. The footprint palette carries the carriageways, the line, the pipe and the three zones alongside the stamps, and the family ticks, because `buildings/manager.ts` owns both where a footprint may be stamped *and* what the tick loop then does to it — and a palette of nothing but stamps reaches only the first. Widening it moved the six seeds from 130 accepted commands, 200 structure tiles and 0 powered tiles to 202, 217 and 128.
- **`watered`** by the serviced-city fuzz family alone. It starts from a fixed nine-command prelude (coal plant, two crossing streets, a lake with a pump on its shore, nine zoned lots) and then lets 80 random commands loose on it, so the two engines' power and water propagation is compared over randomly mangled topologies. That is `adjacency.ts`'s ground, and `adjacency.ts` is the file that drifted twice during #177. The footprint family cannot reach `watered` and does not claim to: its palette has no `Tool.Water`, so nothing it stamps ever stands beside natural water.
- **`developed` and `abandoned`** by two *deterministic* named scenarios — the serviced city grown for 90 ticks, and the same city with its only plant razed and twelve more ticks run. Both assert the state was actually reached, not merely agreed on: two engines that grew nothing would agree perfectly.

Why those last two are not fuzzed is worth stating plainly, because the earlier version of this harness omitted them without saying so. Zone growth is a Fisher-Yates shuffle plus a per-candidate probability roll, drawn from `SeededRng` on one side and the deliberately matching `rng.rs` on the other. The two streams stay in step only while their *draw counts* do, and the draw count depends on the utility balances through `utilityFactor`. Measured: under a random script two of four seeds disagree on `developed`, every disagreement traceable to a click knocking out the pump and one of the two pinned drifts then moving that engine's water balance; and even undisturbed, the two engines pick different lots somewhere between 100 and 120 ticks. So the deterministic scenarios stop at 90 ticks, inside the reproducible window, and the fuzz families stop at 30, under the growth delay.

The two long deterministic scenarios compare tiles but not the headline scalars, for a third reason that is neither drift nor omission: Rust holds the ledgers as `i32` and `i64 + money_frac`, TypeScript holds them as floats, and over 90 ticks the residues accumulate past a whole credit. Every other scenario compares the headline exactly. All three exclusions are written out in the test file where they are declared.

### Two known drifts, pinned rather than papered over

Both are recorded as assertions that fail if the drift *changes*, so neither can widen unnoticed. Rust is canonical in both cases:

1. **The engine credits water production from a pump that is neither powered nor beside water.** The oracle credits nothing.
2. **The two engines disagree on whether a lot activates in a city with no water system.** `Simulation::tick_fixed` gates the water requirement on `state.has_water_system()`; `simulation.ts` passes `waterEnabled: true` unconditionally, so every lot in a city that has never seen a pipe sits at `InactiveNoWater`. Closing this means changing `simulation.ts`, which moves the committed goldens in `stateHash.test.ts` and the tolerance bands in `regression.test.ts` — an oracle-calibration decision, not a test one.

### What it does NOT cover

- **The raw `kind` byte.** Every predicate in the vocabulary is spelling-agnostic by construction (`app/src/game/parity/tileFacts.ts` reads occupant bits directly rather than a resolved kind) — the byte itself, where one is still derived for a legacy consumer (`app/src/game/protocol/legacyProjection.ts`'s `legacyKind`), is harness 1's and harness 3's ground instead.
- **Wilderness.** Excluded by decision 4 of `docs/features/wilderness-score.md`.
- **Education, the budget breakdown, per-tile happiness, narrative events, undo/redo.** The oracle is not compared on any of these.
- **Which lot zone growth picks, past ~110 ticks.** Two independent RNG streams, in step only while their draw counts are. See above; the ceiling is in the gap table at the end of this document.
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

One city, one page, one fixture build, four images compared with soft assertions so all four report together. Everything sits in rows 22–30, clear of the bottom-anchored HUD panels. The project pins a 1440×900 viewport at `deviceScaleFactor: 1`, forces the sRGB colour profile, disables LCD text, and pins the rasteriser to SwiftShader — a developer machine silently swapping in a real GPU would produce diffs that mean nothing.

**A note on the calibration methodology below.** The thresholds, clips and allowances this section justifies were measured by deliberately reverting `wire_kind`'s precedence in `crates/city-sim-core/src/display.rs` and rebuilding the WASM, back when that module was the live wire's derivation layer. `display.rs` and `wire_kind` no longer exist — the live wire buffer carries occupant bits directly now (`crates/city-sim-protocol/src/tile_buffer.rs`, `crates/city-sim-core/src/wire.rs`), so the specific "revert this function, rebuild, measure the pixel diff" steps described below are a historical record of how the numbers below were derived, not a command you can still run. The thresholds/clips themselves are still correct — nothing about *why* `b-hydro-lines.png` needs a `0.125` allowance or *why* the minimap is clipped to its fixture band changed when the derivation layer did. Re-validating that this harness hasn't gone blind today means reverting the equivalent precedence in `app/src/game/protocol/legacyProjection.ts`'s `legacyKind` (the TS-side port of the same ladder, since that is what the renderer and minimap read from now) rather than in the deleted Rust module.

An exact match takes **both** `maxDiffPixels: 0` and `threshold: 0`, and it is worth knowing why. `maxDiffPixels` bounds how many pixels may differ; `threshold` decides what "differ" *means*, per pixel, as a perceived YIQ distance — and Playwright defaults it to 0.2, so left alone a pixel has to move a fifth of the colour space before it counts at all. That is not academic here: delta 1 is one minimap pixel going rail-brown to road-grey, a smaller step than that. Measured by reverting `wire_kind`'s rail/road precedence in the engine and rebuilding the WASM: at `threshold: 0` `d-minimap.png` fails by 11 pixels and the other three baselines are untouched; at the default 0.2 every baseline passes and only the spec's numeric `kindAt` assertions notice. The tile art is flat dithered pixel art at a fixed camera with the rasteriser pinned, so 0 costs nothing in *timing* flakiness — there is no antialiasing jitter to absorb and no text in shot.

It does cost something across machines, and one image pays it. Pinning the rasteriser to SwiftShader makes a run reproducible on one machine; it does not make two Chromium builds agree bit-for-bit. GitHub Actions renders a 36-pixel cluster of `b-hydro-lines.png` differently from a developer machine — worst pair `(170,219,113)` → `(204,233,170)`, a visibly different green rather than a rounding step — so `threshold: 0` passed locally and failed CI. Measured from the failing run's own artefacts through pixelmatch's YIQ metric: the noise tops out at **0.1032** (median 0.0277) and delta 1 sits at **0.1549**. That image therefore carries a per-call `threshold: 0.125` of its own, documented at the assertion.

The exception is scoped to one image on purpose, and it does not blind the image it sits on: re-measured with the allowance in place, dropping `wire_kind`'s zone rung still moves `b-hydro-lines.png` by 3 919 pixels.

**`d-minimap.png` needed the opposite treatment, and it is the more instructive case.** Shot whole, that canvas differs on CI by 1 702 pixels spread over the entire image — and one of those transitions is a YIQ step of 0.1545 against delta 1's own 0.1549. Signal and noise are the same size, so no `threshold` can separate them and any value large enough to pass would blind the test completely. What fixed it was asking what the image is *for*. The fixture occupies tiles 12–29 across rows 22–30; the rest of the canvas is procedurally shaded wilderness that no assertion is about, and shooting all 44 100 pixels imported 42 000 of them as unexamined background. Measured inside the fixture band on the same failing artefact: **zero** differing pixels. So the minimap is now clipped to that band and keeps exact matching, with no per-image `threshold` at all — and reverting `wire_kind`'s rail/road precedence still fails it by exactly 11 pixels.

The general lesson for a new fixture that fails only on CI: first check whether the difference is even inside the region you meant to pin. Narrowing the clip beats loosening the comparison, because it keeps the check exact. Reach for a per-image `threshold`, sized from the failing run's artefacts, only when the noise is genuinely mixed in with the signal — which is the situation `b-hydro-lines.png` is in and `d-minimap.png` was not.

It is organised around `display.rs`'s **three deltas** — the three classes of tile that come off the wire differently than they did at `fix(sim): read every stratum, so no feature goes uncounted` — step 2 of #177, the last commit where `kind` was canonical:

1. **A bare level crossing.** Rail now wins the kind byte in both build orders, so a road-last crossing's flat colour moves. The sprite is unchanged; the minimap pixel is not.
2. **A bare hydro line.** `PowerLine` now wins over a regrade. Measured here to be a visual no-op.
3. **A bulldozed footprint building.** The razed tile now emits `Land` instead of keeping a ghost `Park`.

Each fixture names the delta it pins, or says explicitly that it is a control that must NOT have moved.

The images are known to be **sensitive**, not merely stable, and both mutations were re-run after the CI fixes above rather than inherited from before them. Reverting `wire_kind`'s rail/road precedence moves `d-minimap.png` by 11 pixels and nothing else, exactly as `display.rs` predicts; dropping its zone rung moves `b-hydro-lines.png` by 3 919 pixels. Neither mutation is committed — re-running them is how you check the harness has not gone blind, and the first of the two is also what proves the minimap clip still frames the tile it exists to watch.

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
- **Bounded allocation**, at three resolutions, two of them enforced and one signature excused. Allocation is measured by a thread-local counting `GlobalAlloc`; it is a deterministic function of state, so there is no flake budget — the numbers are the same on every machine.
  - **The coarse rate aggregate is enforced.** Bytes per tick over an early window and a late one, tolerance 1.25×, and it fails `soak_long_run_stays_sane` like a `NaN` would. On the default run it reads 1.01×. Proved to have teeth by adding a synthetic leak sized by the tick counter to the measured tick path: the soak goes red at 1.45× and names the figure.
  - **The retained heap is enforced.** The worst heap still outstanding *between* ticks, sampled once the tick's transients are dropped, compared across the same two windows at the same 1.25× plus 8 KiB of slack. It reads 1.15× on the default run, and the late figure is the same 52 432 B at 160 days and at 3 000 days, so that 1.15× is one `Vec` capacity step rather than a trend. This check exists because the rate aggregate is blind to a flat-rate leak by construction: pushing one `String` per tile per tick into a never-drained `Vec` takes the peak heap from 0.05 MiB to 100 MiB while leaving bytes per tick at 1.01×, and before this check that mutation passed the soak. It now fails at 2.32×, and the finding says #180 cannot be the cause — a `StructureLookup` is a transient, dropped before the sample, so it can never register here.
  - **The fine-grained `StructureLookup::new` probe is the one known exception** (#180), reported under a banner rather than enforced. It is excused *by signature*, at the site that raises it — so an aggregate finding raised in the same run still fails, and a new leak cannot be filed under someone else's issue number.
  - **The exception is pinned in both directions.** On a run of the default length or longer, the probe *not* firing is itself a failure, so fixing #180 turns the soak red asking for the exception to be deleted; and `allocation_per_call_tracks_live_buildings_not_the_id_space` is the `#[ignore]`d acceptance test to un-ignore when it lands. Verified by widening `LOOKUP_GROWTH_TOLERANCE` to simulate a fix — the soak goes red with the delete-the-exception message.

### What it does NOT cover

- **Performance.** Nothing fails when a tick gets ten times slower. Only allocation is gated.
- **Any city but one.** One shape, one seed, one command palette. A leak reachable only through repeated terraforming, repeated save/load, or undo/redo churn is not covered.
- **Peak memory as a budget.** Peak live heap is printed, not asserted against a ceiling.

### It reports a known defect without going red, and without going blind

A soak run prints the `StructureLookup::new` finding under a `KNOWN DEFECT #180` banner and passes. That is the intended arrangement, not a soft-pedal: #180 is a real engine defect this branch deliberately does not fix, and it is excused by its own signature only — every other allocation finding fails the run. See "Known defect #180" at the end of this document for what it is.

On `SOAK=long` the coarse aggregate reads 1.23× against its 1.25× tolerance. A few hundred more simulated days and #180 will trip the enforced aggregate too. That is correct behaviour and the message handles it: the aggregate reports its own growth in B/tick alongside the probe's growth in B per call and asks the reader to check the two are the same order of magnitude before filing one as the other.

**Do not silence the probe** by widening `LOOKUP_GROWTH_TOLERANCE`, shortening the run, or reducing the churn. The fix belongs in `occupants.rs`.

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

`crates/city-sim-core/tests/fixtures/city_v4.csim` is the exception that proves the point — it is a genuine pre-strata save, generated on the commit `fix(sim): read every stratum, so no feature goes uncounted` by a test that was deleted immediately afterwards, and it **cannot be regenerated at all**. A migration you can only demonstrate against your own output is not a migration.

---

## CI

`.github/workflows/ci.yml`. All jobs run in parallel; the critical path is `mobile-e2e`, so the harnesses add no wall-clock time to a CI run beyond what that job already spends.

| Job | Harness it carries | What it added |
| --- | --- | --- |
| `rust-test` | golden city, default soak | Nothing to wire — `cargo nextest run --workspace` picks both up. nextest gives each its own process, so the soak's ~8 s is what sets the job's test wall clock and every other test in the workspace is free. Known defect #180 does not fail this job: it is reported under a banner, while the soak's coarse allocation aggregate is enforced and every other allocation finding is a failure. |
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
| **Zone growth selection diverges past ~110 ticks** | The two engines draw from separate RNG streams that stay in step only while their draw counts do, so in an undisturbed, fully serviced city they pick the same lots at 100 ticks and different ones at 120. Everything longer than that is unpinned across the language boundary, and so is any growth after a random script has touched the utilities. Measured, not inferred; the numbers are in `crossEngineParity.test.ts` at `SERVICED_CITY`. | Medium, and it is the same calibration decision as the row above: it needs one engine's RNG consumption made to match the other's exactly, which moves committed goldens. |
| **No performance gate anywhere** | Allocation is bounded; time is not. A tick that gets ten times slower passes every test in this repo. | Medium — a timing gate needs a flake budget, which allocation did not. |
| **The soak is one city shape** | 24×16, one seed, one command palette, one map. Leaks reachable through terraforming churn, save/load churn or undo/redo churn are out of reach. | Low. `SOAK` already parameterises the length; the shape and palette would need the same treatment. |
| **Mutation coverage is checked by hand, once** | Every one of the four has now been shown to fail on a deliberate mutation, and each mutation is written down where it belongs: two in `visual.spec.ts` and `playwright.config.ts` (rail/road precedence, the zone rung), four in the fixtures README (deleting each awkward case and regenerating the dump first), three in `soak.rs` (a synthetic clock-sized leak; a never-drained `Vec` leaking at a flat rate; a widened lookup tolerance standing in for a fix), and one in `crossEngineParity.test.ts` (dropping the footprint family's ticks, which fails its `powered` floor on all six seeds). Parity's reach is not only stated as measured numbers — the serviced-city and footprint families assert the state they claim to reach, so a family that goes quiet fails rather than agreeing vacuously. What is still missing is anything that re-checks it — nothing runs these mutations on a schedule, so the record ages. | High to automate properly. In the meantime, re-run the mutation documented next to whichever harness a change touches, and treat a mutation that no longer goes red as a finding. |

---

## Known defect #180 — `StructureLookup::new` is sized by the id space, not by the buildings in it

The soak reports this one and stays green; every other allocation finding fails the run. What follows is what #180 *is*, so the banner in a soak run means something to whoever reads it.

`StructureLookup::new`, in `crates/city-sim-core/src/occupants.rs` (named rather than given a line number, which would go stale on the next edit above it) — it allocates `vec![None; max(max_live_id, next_building_id) + 1]`. It is sized by the **building-id space**, not by the buildings in it, and that id space only ever grows: develop/abandon churn mints about 1.2 new ids per simulated day and none are ever reused or compacted.

On the default run the worst call in a window goes 78 B → 204 B (2.62×) while the live count it indexes stays at 28 (1.00×). On `SOAK=long` it goes 78 B → 4 389 B (56×) against the same flat live count, and the coarse aggregate reaches 1.23× against its 1.25× tolerance — given a few hundred more days, even the general net would catch it.

Two things were checked by experiment rather than assumed, because they decide what a fix has to be:

- **Removing `.max(state.next_building_id)` is not a fix.** With it removed the probe still reports 77 B → 203 B: the highest *live* id climbs with the counter, because a freshly developed lot holds a freshly minted id and under churn there is nearly always one alive. Both halves of that `max` are unbounded.
- **Sizing the index by the live building count is a fix, and a behaviour-preserving one.** Swapping the `Vec` for a map keyed by id holds the allocation flat at 304 B across the whole run and leaves every `state_hash` in the checkpoint table byte-for-byte identical.

The allocation sits on the 20 Hz host emit path (`SimHost::tile_buffer` and the Tauri tick event) as well as on `state_hash` and `compute_wilderness`, so it is hot.

This is an engine change, and the harness branch deliberately does not make it. Until it lands, the soak prints the finding under a `KNOWN DEFECT #180` banner — excused by that one signature and nothing else, and with the *absence* of the finding treated as a failure so the exception cannot outlive the defect. The acceptance test is `allocation_per_call_tracks_live_buildings_not_the_id_space`, `#[ignore]`d until the fix lands.

So the soak passing is conditional on the probe still firing. If #180 is fixed and nobody removes the exception, the soak goes red on purpose and says so — see harness 4 above.

---

## There is no status section here, on purpose

Whether the tree is green today is not something a document can know. Every gate is listed in **Every command** at the top of this file; run them, and read the run rather than a paragraph describing a run somebody else did. A committed count is stale from the commit that follows it, and the failure mode is worse than the absence: a reader who trusts a green paragraph does not run the gate.

What this file states instead are the invariants — what each harness pins, what it deliberately does not, which exclusions are pinned so that *closing* them fails a build, and which mutation proves each harness can still see. Those survive a passing build and a failing one alike.
