// soak.rs — drive a large city for a long time and assert it stays sane.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

//! **The soak.**
//!
//! Every other test in this workspace runs a handful of ticks. Nothing runs a
//! city for a simulated year, and a whole class of defect only shows up when
//! something is allowed to run: a counter that never resets, a vector sized by
//! a monotonic id, a float that drifts to `NaN` on the ten-thousandth
//! division. This file is that missing altitude.
//!
//! Four properties, checked over one long run:
//!
//! 1. **It does not panic.** Just running is the assertion.
//! 2. **No float goes non-finite and no count goes negative.** Every `f32` the
//!    game shows a player — the whole of [`BudgetStats`], [`DemandStats`],
//!    [`EducationStats`], the wilderness score and its full breakdown, and
//!    per-tile happiness — is checked at every checkpoint. The stats structs
//!    are checked by *exhaustive destructuring*, so adding a field to one of
//!    them fails to compile here until someone says what "sane" means for it.
//! 3. **`state_hash` is reproducible.** Two independently built, independently
//!    stepped simulations are compared at every checkpoint, not just at the
//!    end, so a divergence names the checkpoint it started at.
//! 4. **Allocation stays bounded.** Three checks at different resolutions. Two
//!    are plain assertions that fail the run like any other complaint: bytes
//!    per tick, early window against late; and the heap still held between
//!    ticks, which is the only one that sees a leak whose *rate* is flat. The
//!    third, the fine-grained `StructureLookup::new` probe, is the *one* known
//!    exception (#180): it is reported rather than enforced, it is excused by
//!    signature rather than by category, and the excusal is itself pinned so it
//!    cannot outlive the defect. See below.
//!
//! ## Running it
//!
//! ```text
//! bun run test:soak        # the CI-sized run, with the tables
//! bun run test:soak:long   # the opt-in long run
//! ```
//!
//! Both are thin wrappers over cargo, if you would rather say it directly:
//!
//! ```text
//! cargo test -p city-sim-core --test soak -- --nocapture
//! SOAK=long  cargo test -p city-sim-core --test soak -- --nocapture   # 3 000 days
//! SOAK=20000 cargo test -p city-sim-core --test soak -- --nocapture   # 20 000 days
//! ```
//!
//! `SOAK` takes `ci` (the default), `long`, or a plain number of days.
//!
//! The default is a 24×16 city for 160 simulated days (4 800 fixed ticks) —
//! about 7.5 seconds in the unoptimised build CI uses, and it needs no separate
//! CI job: `cargo nextest run --workspace` already picks it up, and the two
//! tests in this file run in parallel with each other and with everything else.
//!
//! `--nocapture` is worth having. The soak prints a checkpoint table —
//! population, money, live buildings, `next_building_id`, `state_hash` — and
//! an allocation summary, and those tables are how you read a failure.
//!
//! The map is small on purpose. Every system in `tick_fixed` is a full-map
//! pass, so cost is linear in tiles, and what surfaces a leak is *elapsed
//! ticks*, not area. Spending the budget on days rather than on tiles is what
//! makes a CI-sized run long enough to be worth running.
//!
//! ## Why allocation, and how it is measured
//!
//! The engine's per-tick work is bounded by the map, which does not grow. So
//! once a city reaches steady state, *bytes allocated per tick must stop
//! growing too*, and *the heap the city holds between ticks must stop growing*.
//! Anything that keeps climbing is either a leak or an index sized by something
//! monotonic, and both are bugs that only a long run finds.
//!
//! Those two are not the same measurement, and one of them is not optional:
//! a rate and a level fail differently. An index sized by a counter grows the
//! *rate*; a `Vec` that is pushed to once per tile per tick and never drained
//! grows only the *level*, at a perfectly flat rate. Measured, that second
//! mutation takes the peak heap from 0.05 MiB to 100 MiB while leaving bytes per
//! tick where they were, so a harness that watched only the rate would pass it.
//!
//! Measurement is a counting [`GlobalAlloc`] wrapping [`System`]. Its counters
//! are **thread-local**, so a soak measured on the test thread is not polluted
//! by whatever else `cargo test` is running in parallel, and `realloc` /
//! `alloc_zeroed` are deliberately left to their default trait implementations
//! so that every allocation funnels through the one counted `alloc`. Nothing
//! here is timing-dependent: allocation is a deterministic function of the
//! state, so the numbers are the same on every machine and there is no flake
//! budget to spend.
//!
//! There are three allocation checks, at different resolutions, and it is worth
//! being clear about which catches what and which of them can fail a build.
//! **Two of the three are enforced; only the third is excused:**
//!
//! - **The rate aggregate — enforced.** Bytes per tick over two equal windows —
//!   an early one taken after the city stops growing, a late one at the end of
//!   the run — must not grow. It is a plain assertion: it fails
//!   [`soak_long_run_stays_sane`] exactly like a `NaN` would. This is the
//!   general net, and it catches anything large, including leaks nobody has
//!   thought of. It is also *coarse*, because a tick allocates ~20 KB and a
//!   small index growing by a few hundred bytes disappears into that. On the
//!   default run it reads 1.01× against a 1.25× tolerance.
//!
//! - **The retained level — enforced.** The worst heap still outstanding
//!   *between* ticks, sampled once the tick's transients have been dropped,
//!   compared the same way across the same two windows. This is the ordinary
//!   meaning of "leak", and it is the one the rate aggregate is blind to by
//!   construction. It reads 1.15× on the default run against a 1.25× tolerance
//!   plus 8 KiB of slack, and — the reason the tolerance is trustworthy — the
//!   late figure is *the same 52 432 B* at 160 days and at 3 000 days, so the
//!   1.15× is one `Vec` capacity step and not a trend. #180 cannot register
//!   here at all: a `StructureLookup` is a transient, dropped before the
//!   sample, so it can never be offered as an excuse for a retained finding.
//!
//! - **The probe — reported, and the one known exception.** The worst
//!   `StructureLookup::new` call in each window, normalised by the change in
//!   peak live building count. An index of the live buildings must cost what the
//!   live buildings cost; if it grows while they do not, it is sized by the
//!   clock. This is the fine-toothed one, and it is what reports #180 — see
//!   below.
//!
//! ## Exactly one finding is excused, and it is excused by signature
//!
//! Every allocation finding carries an [`AllocationFinding::known`] tag, and
//! only the probe sets it. Everything else — the retained-heap finding, and an
//! aggregate finding raised in the same run the probe fires in — lands in the
//! enforced list and fails the soak. That distinction is the whole point: a
//! brand-new, unrelated leak must not be reported to whoever is reading the
//! output as "known defect #180" and then fail nothing, which is precisely what
//! an earlier draft of this file did by excusing the *category* rather than the
//! signature — and, worse, by leaving the only asserting test `#[ignore]`d, so
//! that the enforced list had nothing reading it at all.
//!
//! The excusal is pinned in both directions, so it cannot outlive the defect:
//!
//! - [`soak_long_run_stays_sane`] asserts that on a run of the default length or
//!   longer the probe *does* fire. Fix #180 and the soak goes red telling you to
//!   delete the exception — the same discipline the parity harness uses for its
//!   known drifts.
//! - [`allocation_per_call_tracks_live_buildings_not_the_id_space`] is the
//!   `#[ignore]`d acceptance test for the fix. Un-`ignore` it when the fix lands.
//!
//! ## Every part of that was checked by mutation, not by reading
//!
//! A gate nobody has watched fail is a gate nobody has tested — and this file
//! has already been wrong about that once, having claimed assertions it did not
//! make. So each of the three claims below was run. None of the mutations is
//! committed; re-run them if this file changes shape.
//!
//! - **The enforced rate aggregate has teeth.** Adding
//!   `let junk = vec![0u8; a.state.tick as usize * 4];` to the measured tick path
//!   — a leak sized by the clock and nothing to do with `StructureLookup` — takes
//!   the ratio to 1.45× and fails the soak, reporting 12 335 B/tick of growth
//!   against the probe's 126 B per call, so the message says plainly that the two
//!   are not the same order of magnitude.
//! - **The enforced retained level has teeth, and this one is why it exists.**
//!   Pushing one `String` per tile per tick into a `Vec` that is never drained
//!   fails the soak at 2.32× retained growth (44.0 MB → 102.0 MB), and the
//!   finding states that #180 cannot be the cause. The same mutation moves the
//!   rate aggregate not at all — it stays at 1.01× — so before this check
//!   existed, that leak passed the soak while taking the peak heap to 100 MiB.
//! - **The exception cannot outlive the defect.** Widening
//!   [`LOOKUP_GROWTH_TOLERANCE`] to 99.0 stands in for #180 being fixed: the
//!   probe stops firing and the soak fails with the message asking for the
//!   exception to be deleted.
//!
//! ## What this currently reports
//!
//! **`StructureLookup::new` is sized by the building-id space rather than by
//! the buildings in it, and that id space only ever grows.** On the default run
//! the worst call in a window goes 78 B → 204 B (2.62×) while the live count it
//! indexes stays at 28 (1.00×). `occupants.rs` allocates
//! `vec![None; max(max live id, next_building_id) + 1]`, and develop/abandon
//! churn drives `next_building_id` up for ever — about 1.2 ids per simulated
//! day in this city, and it is never reused or compacted.
//!
//! The allocation used to sit on the 20 Hz host emit path and on `state_hash`
//! too — both built a lookup to derive the wire `kind` byte every tick. Since
//! #177's TS/wire follow-up deleted that derivation (the wire now carries
//! occupant bits directly, no lookup needed to write them), those two are
//! fixed as a side effect. `compute_wilderness` is the call site that remains:
//! it still resolves a structure's kind, per tick, to score it.
//!
//! Two things were checked by experiment rather than assumed, because they
//! decide what a fix has to be:
//!
//! - **Removing `.max(state.next_building_id)` is not a fix.** With it removed,
//!   the probe still reports 77 B → 203 B: the highest *live* id climbs with
//!   the counter, because a freshly developed lot holds a freshly minted id and
//!   under churn there is nearly always one alive.
//! - **Sizing the index by the live building count is a fix, and a
//!   behaviour-preserving one.** Swapping the `Vec` for a map keyed by id holds
//!   the allocation flat across the whole run — a
//!   `HashMap::with_capacity(state.buildings.len())` measures a constant 176 B
//!   per call at both ends, against the `Vec`'s 78 B → 204 B; the exact constant
//!   is whatever map is chosen — and leaves every `state_hash` in the checkpoint
//!   table byte-for-byte identical. Per-tick allocation stays flat too (1.00×),
//!   so paying a little more per call early costs nothing overall: the tick path
//!   builds only a couple of these.
//!
//! `SOAK=long` (3 000 days, 90 000 ticks, ~2½ minutes) shows the same thing
//! with the scale it deserves: 78 B → 4 389 B, a 56× growth against a live
//! count that never moves off 28. Nothing else misbehaves over that run — no
//! panic, no non-finite float, no `state_hash` divergence between the two
//! cities, peak live heap flat at 0.06 MiB — and the coarse aggregate reaches
//! 1.23× against its 1.25× tolerance, so a few hundred more days and the
//! *enforced* net catches this one too. That is not a trap, and it is not an
//! excuse either: the aggregate's message carries both figures — its own growth
//! in B/tick and the probe's growth in B per call — and asks the reader to check
//! that they are the same order of magnitude before filing one as the other.
//! Being #180 is something the numbers have to show, not something a fired probe
//! confers.
//!
//! The probe's report is the correct outcome, not a broken test. **Do not
//! silence it by widening [`LOOKUP_GROWTH_TOLERANCE`], shortening the run, or
//! reducing the churn.** The fix belongs in `occupants.rs`.
//!
//! ## Modelling the 20 Hz host loop
//!
//! `Simulation::step` is not the whole per-tick cost. Both hosts —
//! `city_sim_wasm::SimHost::tile_buffer` and `tauri_plugin_city_sim::commands`
//! — write the tile wire buffer for every tile on *every* tick, and that is
//! real allocation work even though #177's TS/wire follow-up deleted the
//! [`StructureLookup`]-driven derivation this used to need: writing
//! `n * BYTES_PER_TILE` bytes and reading every tile's occupant bits still
//! allocates and iterates the whole map, once per tick. A soak that only
//! called `step` would miss that path. [`emit_wire_frame`] mirrors what those
//! hosts do, and the soak calls it once per tick. If either host's emit loop
//! changes shape, this should follow it.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use city_sim_core::commands::apply_tool;
use city_sim_core::occupants::StructureLookup;
use city_sim_core::sim::{state_hash, Simulation};
use city_sim_core::state::{BudgetStats, DemandStats, EducationStats, GameState};
use city_sim_core::wilderness::{WildernessBreakdown, WildernessStats};
use city_sim_core::wire::{
    wire_overhead_byte, wire_status_byte, wire_surface_byte, wire_underground_byte,
};
use city_sim_protocol::commands::Tool;
use city_sim_protocol::tile_buffer::{encode_happiness, TileBufferOffsets, BYTES_PER_TILE};

// ---------------------------------------------------------------------------
// The counting allocator
// ---------------------------------------------------------------------------

/// [`System`], plus a thread-local tally of bytes handed out and bytes live.
///
/// Thread-local rather than global on purpose: `cargo test` runs integration
/// tests in parallel threads within one binary, and a global counter would
/// measure the other tests as well. Under `cargo nextest`, which gives each
/// test its own process, the two are equivalent — but the file must be
/// correct under both.
struct Counting;

thread_local! {
    /// Monotonic total of every byte this thread has been handed.
    static ALLOCATED: Cell<u64> = const { Cell::new(0) };
    /// Bytes currently outstanding on this thread. Signed because a buffer
    /// allocated on one thread and freed on another would otherwise underflow;
    /// the soak does not do that, but the allocator must not be the thing that
    /// panics if something ever does.
    static LIVE: Cell<i64> = const { Cell::new(0) };
    /// High-water mark of `LIVE`.
    static PEAK: Cell<i64> = const { Cell::new(0) };
}

// SAFETY: every method forwards to `System`, which is a valid allocator, and
// the bookkeeping either side of the forward touches only thread-local `Cell`s
// of `Copy` types. Those neither allocate nor register a destructor, so there
// is no re-entrancy into the allocator and no TLS-teardown hazard; `try_with`
// covers the teardown window regardless.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: `layout` is forwarded unchanged to the system allocator.
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            let size = layout.size();
            let _ = ALLOCATED.try_with(|c| c.set(c.get().wrapping_add(size as u64)));
            let _ = LIVE.try_with(|live| {
                let now = live.get() + size as i64;
                live.set(now);
                let _ = PEAK.try_with(|peak| {
                    if now > peak.get() {
                        peak.set(now);
                    }
                });
            });
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        let _ = LIVE.try_with(|c| c.set(c.get() - layout.size() as i64));
        // SAFETY: `ptr` and `layout` come straight from the caller's contract
        // and are forwarded unchanged to the allocator that produced them.
        unsafe { System.dealloc(ptr, layout) }
    }

    // `realloc` and `alloc_zeroed` are deliberately NOT overridden. The default
    // trait implementations route through `self.alloc` / `self.dealloc`, which
    // is what keeps the tally complete.
}

#[global_allocator]
static GLOBAL: Counting = Counting;

/// Bytes handed to this thread since it started.
fn allocated_total() -> u64 {
    ALLOCATED.with(Cell::get)
}

/// High-water mark of live bytes on this thread.
fn peak_live() -> i64 {
    PEAK.with(Cell::get)
}

/// Bytes outstanding on this thread *right now* — allocated and not yet freed.
///
/// Sampled between ticks, when the transient per-tick buffers have all been
/// dropped, this is the heap the city is actually holding on to. It is the only
/// figure that sees a leak whose *rate* is constant.
fn live_bytes() -> i64 {
    LIVE.with(Cell::get)
}

/// Reset the high-water mark to whatever is live right now, so a later
/// [`peak_live`] describes only the window that follows.
fn rebase_peak() {
    let now = LIVE.with(Cell::get);
    PEAK.with(|p| p.set(now));
}

/// Run `f`, and report how many bytes it allocated.
fn measure_bytes<T>(f: impl FnOnce() -> T) -> (T, u64) {
    let before = allocated_total();
    let out = f();
    (out, allocated_total() - before)
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// One fixed tick, in real seconds — `Simulation::step` fires exactly one tick
/// per call at this `dt` and leaves the accumulator at zero, so a tick count is
/// exact rather than approximate. Matches `golden_city.rs`.
const TICK_DT: f64 = 1.0 / 20.0;

/// Sim ticks per simulated day: `day_frac` advances by `TICK_DT / 1.5`.
const TICKS_PER_DAY: u32 = 30;

/// Map size. Rectangular on purpose — a transposed x/y cannot pass unnoticed.
///
/// Deliberately modest. Every system in `tick_fixed` is a full-map pass, so
/// per-tick cost is linear in tiles and a big map buys nothing a soak needs:
/// what surfaces a leak is *elapsed ticks*, not area. The map is sized so the
/// default run is a few hundred simulated days in a few seconds of an
/// unoptimised build, which is what CI builds.
const WIDTH: u32 = 24;
const HEIGHT: u32 = 16;

const SEED: u32 = 20_260_729;

/// Days simulated when `SOAK` is unset.
const DEFAULT_DAYS: u32 = 160;

/// Days simulated for `SOAK=long`.
const LONG_DAYS: u32 = 3_000;

/// Ticks in each of the two allocation-measurement windows.
const WINDOW_TICKS: u32 = 250;

/// Ticks of settling between the city being finished and the early window
/// opening. Long enough for the town to fill and the outpost's churn cycle to
/// reach its steady rate — see the run table, where the live building count
/// goes flat around tick 1500 — so the early window measures a running city
/// and not a construction site.
const WARMUP_TICKS: u32 = 1_500;

/// How much more the late window may allocate per tick than the early one.
///
/// Not 1.0: the two windows sit at different points in the wilderness
/// recompute cadence and the live building count wobbles with the churn, so
/// some honest variation is expected. 1.25 is far below what an index sized by
/// a monotonic counter produces over a soak.
const ALLOC_GROWTH_TOLERANCE: f64 = 1.25;

/// How much more of the heap the city may still be holding in the late window
/// than it held in the early one.
///
/// Retained heap is what a leak in the ordinary sense grows: a `Vec` that is
/// pushed to and never drained, a cache with no eviction. Such a leak allocates
/// at a *constant* rate, so [`ALLOC_GROWTH_TOLERANCE`] — which compares rates —
/// never moves for it, and only this check sees it.
const RETAINED_GROWTH_TOLERANCE: f64 = 1.25;

/// Bytes of slack under [`RETAINED_GROWTH_TOLERANCE`]. The steady-state heap
/// here is tens of kilobytes and the live building list breathes with the churn,
/// so a fixed floor keeps the ratio from being decided by a few `Vec` growth
/// steps. Small next to any real leak, which climbs without bound.
const RETAINED_SLACK_BYTES: f64 = 8.0 * 1024.0;

/// How much more the *same* `StructureLookup::new` call may allocate at the end
/// of the run than at the start, after normalising for the change in live
/// building count.
const LOOKUP_GROWTH_TOLERANCE: f64 = 1.25;

/// Bytes of slack under [`LOOKUP_GROWTH_TOLERANCE`], to keep the comparison
/// meaningful for a city small enough that one allocation is a handful of
/// bytes. Deliberately tiny: the measurement is `Layout::size()`, which is
/// exact rather than rounded up to an allocator bucket, so there is no
/// granularity to absorb.
const LOOKUP_SLACK_BYTES: f64 = 32.0;

fn soak_days() -> u32 {
    match std::env::var("SOAK") {
        Err(_) => DEFAULT_DAYS,
        Ok(v) => {
            let v = v.trim().to_ascii_lowercase();
            match v.as_str() {
                "" | "ci" | "default" | "short" => DEFAULT_DAYS,
                "long" => LONG_DAYS,
                other => other.parse().unwrap_or_else(|_| {
                    panic!("SOAK must be `ci`, `long` or a number of days, not `{other}`")
                }),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The city
// ---------------------------------------------------------------------------

/// East edge of the serviced town. West of this line everything works.
const TOWN_END: u32 = 5;
/// The firebreak, `TOWN_END..OUTPOST_START`. Bare ground: no road, no zone, no
/// line. See [`build_soak_city`] for why it has to be bare.
const OUTPOST_START: u32 = 7;
/// East edge of the unpowered outpost. Beyond it, hinterland.
const OUTPOST_END: u32 = 21;

/// Build the city the soak runs.
///
/// It is laid out to keep *churning* rather than to be well run, because churn
/// is what a soak is for. Three districts, west to east:
///
/// - **The town** (`x < TOWN_END`). Roads, a coal plant, a water pump, an
///   elementary and a high school, a park. Its zones develop and stay
///   developed, so they carry the population, the tax base and the demand
///   curve.
///
/// - **The firebreak** (`TOWN_END..OUTPOST_START`). Two columns of bare
///   ground. This is load-bearing, and it is the thing the first draft of this
///   file got wrong: **roads conduct power.** `Occupant::Road` declares
///   `NET_POWER | NET_WATER | NET_TRAFFIC`, and so do all three zone tags and
///   any developed lot (`Tile::conducts` returns true for
///   `building_id.is_some()`). A single continuous street grid is therefore a
///   single power network no matter how far the plant is, and the first draft
///   of this city — one grid, plant at one end — had *nothing* unpowered and
///   *nothing* ever abandoned. Only physically separate networks can differ.
///
/// - **The outpost** (`OUTPOST_START..OUTPOST_END`). Its own road grid, its
///   own zones, and no hydro of any kind. Lots develop, come up
///   `InactiveNoPower`, take `trouble_power_penalty` (3.0) per tick against
///   `trouble_abandon_thresh` (12.0), and are abandoned four ticks later. The
///   vacant lot then waits out the 40-tick growth delay and develops again,
///   with a fresh id. That cycle is the churn engine: `next_building_id`
///   climbs for ever while the live building count sits flat. A player who
///   zones ahead of the grid gets exactly this.
///
/// - **The hinterland** (`x >= OUTPOST_END`). A lake and a forest, so the
///   wilderness score, the patch bonus, the fragmentation penalty and the
///   tourism revenue line all have something to say.
///
/// Two things about the zoning are deliberate and were arrived at by measuring,
/// not by taste. Both are about keeping demand — and therefore regrowth —
/// alive, because a stalled outpost measures nothing:
///
/// - **Not every free tile is zoned.** Demand carries a pending-zone penalty
///   (`pending_slope` 0.45 for residential), so blanket-zoning a map drives all
///   three tracks toward zero and growth stops.
///
/// - **The town is mostly commercial and industrial; the outpost is entirely
///   residential.** Residential demand is `base × (1 − population/capacity)`
///   plus a labour term worth up to `vacancy_rate × 60`. A town that houses its
///   own workers fills its own capacity, and residential demand collapses to
///   near zero within a hundred days — which is what the second draft of this
///   file did. Putting the jobs in the town and the housing in the outpost
///   keeps the vacancy rate high and residential demand around 19, which is
///   what keeps the outpost cycling. It is also a perfectly ordinary shape for
///   a city: a job centre with a dormitory suburb that the grid has not reached.
fn build_soak_city() -> Simulation {
    let mut sim = Simulation::new(WIDTH, HEIGHT, SEED);
    let s = &mut sim.state;

    // The treasury has to fund the build-out and then survive a long run
    // without the soak turning into a test of bankruptcy. The subject here is
    // stability, not solvency.
    s.money = 50_000_000;

    // --- The hinterland ---------------------------------------------------
    for y in 1..5 {
        for x in (OUTPOST_END + 1)..(WIDTH - 1) {
            apply_tool(s, Tool::Water, x, y);
        }
    }
    for y in 7..(HEIGHT - 1) {
        for x in (OUTPOST_END + 1)..(WIDTH - 1) {
            // Not a solid block — the holes give the fragmentation penalty and
            // the patch bonus something to disagree about.
            if (x + y) % 7 != 0 {
                apply_tool(s, Tool::Tree, x, y);
            }
        }
    }

    // --- Street grids, one per district, never joined ---------------------
    // Pitch 4, so blocks are 3×3 and the centre lot has no road of its own: it
    // grows through `zone_has_road_path`, the chain rule a pitch-2 grid would
    // never exercise.
    let grid = |s: &mut GameState, x0: u32, x1: u32| {
        for y in (0..HEIGHT).step_by(4) {
            for x in x0..x1 {
                apply_tool(s, Tool::Road, x, y);
            }
        }
        for x in (x0..x1).step_by(4) {
            for y in 0..HEIGHT {
                apply_tool(s, Tool::Road, x, y);
            }
        }
    };
    grid(s, 0, TOWN_END);
    grid(s, OUTPOST_START, OUTPOST_END);

    // --- Services, town only ----------------------------------------------
    // The plant sits on the town grid, so the whole town grid is live; the
    // outpost grid is unreachable across the firebreak.
    apply_tool(s, Tool::CoalPlant, 1, 1);
    apply_tool(s, Tool::WaterPump, 2, 2);
    apply_tool(s, Tool::ElementarySchool, 1, 5);
    apply_tool(s, Tool::HighSchool, 1, 9);
    apply_tool(s, Tool::Park, 3, 13);

    // --- Zoning -----------------------------------------------------------
    // The town cycles six parts jobs to one part housing; the outpost is all
    // housing. All three demand tracks and all three `maint_zones_*` ledger
    // lines stay live either way — see the doc comment for why the split is
    // this lopsided.
    const TOWN_ZONES: [Tool; 7] = [
        Tool::Commercial,
        Tool::Industrial,
        Tool::Commercial,
        Tool::Industrial,
        Tool::Commercial,
        Tool::Industrial,
        Tool::Residential,
    ];
    const OUTPOST_ZONES: [Tool; 1] = [Tool::Residential];

    let mut n = 0usize;
    let zone_block = |s: &mut GameState, x0: u32, x1: u32, zones: &[Tool], n: &mut usize| {
        for y in 0..HEIGHT {
            for x in x0..x1 {
                let idx = s.tile_index(x, y).expect("in bounds");
                // Bare, undeveloped land only — never over a road, a line or a
                // civic building.
                if s.tiles[idx].occupants() != 0 || s.tiles[idx].building_id.is_some() {
                    continue;
                }
                apply_tool(s, zones[*n % zones.len()], x, y);
                *n += 1;
            }
        }
    };
    zone_block(s, 0, TOWN_END, &TOWN_ZONES, &mut n);
    zone_block(s, OUTPOST_START, OUTPOST_END, &OUTPOST_ZONES, &mut n);

    // Prime demand so growth starts on tick 1 rather than after the economy
    // has warmed up — the soak's subject is the steady state, not the ramp.
    s.demand.residential = 90.0;
    s.demand.commercial = 70.0;
    s.demand.industrial = 70.0;

    sim
}

// ---------------------------------------------------------------------------
// The 20 Hz host emit
// ---------------------------------------------------------------------------

/// One frame of the wire tile buffer, exactly as the hosts build it.
///
/// Mirrors `city_sim_wasm::SimHost::tile_buffer` and the `tauri-plugin-city-sim`
/// tick event: each stratum's occupant bits, rebased to a dense byte, plus
/// status/happiness/elevation/building_id/wilderness — no `StructureLookup`,
/// no per-tile derivation, since #177's TS/wire follow-up deleted the
/// precedence ladder that used to need one here. Returns a checksum so
/// nothing here can be optimised away.
fn emit_wire_frame(state: &GameState) -> u64 {
    let tiles = &state.tiles;
    let n = tiles.len();
    let o = TileBufferOffsets::for_size(n);
    let mut buf = vec![0u8; n * BYTES_PER_TILE];
    for (i, tile) in tiles.iter().enumerate() {
        buf[o.underground + i] = wire_underground_byte(tile);
        buf[o.surface + i] = wire_surface_byte(tile);
        buf[o.overhead + i] = wire_overhead_byte(tile);
        buf[o.status + i] = wire_status_byte(tile);
        buf[o.happiness + i] = encode_happiness(tile.happiness);
        buf[o.elevation + i] = tile.elevation;
        let bid = tile.building_id.unwrap_or(0);
        buf[o.building_id + i * 2] = (bid & 0xFF) as u8;
        buf[o.building_id + i * 2 + 1] = (bid >> 8) as u8;
        buf[o.wilderness + i] = state.wilderness.local_field.get(i).copied().unwrap_or(128);
    }
    buf.iter().map(|&b| b as u64).sum()
}

// ---------------------------------------------------------------------------
// Sanity checks
// ---------------------------------------------------------------------------

/// One complaint. Collected rather than asserted, so a failing soak reports
/// every way in which the city went wrong instead of only the first.
type Complaints = Vec<String>;

/// The issue a known allocation exception is filed under.
const KNOWN_DEFECT: &str = "#180";

/// One allocation finding, plus whether this branch knowingly leaves it open.
///
/// The tag is set **per finding**, at the site that raises it, and only the
/// `StructureLookup::new` probe sets it. Tagging by signature rather than by
/// category is what keeps the exception from turning into a blindfold: an
/// aggregate finding raised in the same run the probe fires in still carries
/// `known: None`, so it still fails the soak.
struct AllocationFinding {
    /// `Some(issue)` for a finding whose *specific* signature is a recorded
    /// known defect. `None` — the default for anything new — is enforced.
    known: Option<&'static str>,
    message: String,
}

impl AllocationFinding {
    fn enforced(message: String) -> Self {
        Self {
            known: None,
            message,
        }
    }

    fn known_defect(issue: &'static str, message: String) -> Self {
        Self {
            known: Some(issue),
            message,
        }
    }
}

fn finite(name: &str, v: f32, at: &str, out: &mut Complaints) {
    if !v.is_finite() {
        out.push(format!("{at}: {name} is {v}"));
    }
}

fn finite64(name: &str, v: f64, at: &str, out: &mut Complaints) {
    if !v.is_finite() {
        out.push(format!("{at}: {name} is {v}"));
    }
}

/// Every `f32` in [`BudgetStats`], by exhaustive destructuring.
///
/// The pattern has no `..`: adding a field to `BudgetStats` breaks this file
/// until someone adds it here too. That is the point — a soak that silently
/// stops covering a new revenue line is worse than no soak.
fn check_budget(b: &BudgetStats, at: &str, out: &mut Complaints) {
    let BudgetStats {
        revenue,
        expenses,
        net,
        net_per_day,
        net_per_month,
        revenue_base,
        revenue_pop,
        revenue_commercial,
        revenue_industrial,
        revenue_tourism,
        expenses_transport,
        expenses_buildings,
        expenses_policies,
        maint_power,
        maint_civic,
        maint_zones,
        maint_roads,
        maint_rail,
        maint_power_lines,
        maint_pipes,
        maint_power_hydro,
        maint_power_coal,
        maint_power_wind,
        maint_power_solar,
        maint_civic_park,
        maint_civic_pump,
        maint_civic_tower,
        maint_civic_school,
        maint_zones_res,
        maint_zones_com,
        maint_zones_ind,
    } = b;
    for (name, v) in [
        ("budget.revenue", revenue),
        ("budget.expenses", expenses),
        ("budget.net", net),
        ("budget.net_per_day", net_per_day),
        ("budget.net_per_month", net_per_month),
        ("budget.revenue_base", revenue_base),
        ("budget.revenue_pop", revenue_pop),
        ("budget.revenue_commercial", revenue_commercial),
        ("budget.revenue_industrial", revenue_industrial),
        ("budget.revenue_tourism", revenue_tourism),
        ("budget.expenses_transport", expenses_transport),
        ("budget.expenses_buildings", expenses_buildings),
        ("budget.expenses_policies", expenses_policies),
        ("budget.maint_power", maint_power),
        ("budget.maint_civic", maint_civic),
        ("budget.maint_zones", maint_zones),
        ("budget.maint_roads", maint_roads),
        ("budget.maint_rail", maint_rail),
        ("budget.maint_power_lines", maint_power_lines),
        ("budget.maint_pipes", maint_pipes),
        ("budget.maint_power_hydro", maint_power_hydro),
        ("budget.maint_power_coal", maint_power_coal),
        ("budget.maint_power_wind", maint_power_wind),
        ("budget.maint_power_solar", maint_power_solar),
        ("budget.maint_civic_park", maint_civic_park),
        ("budget.maint_civic_pump", maint_civic_pump),
        ("budget.maint_civic_tower", maint_civic_tower),
        ("budget.maint_civic_school", maint_civic_school),
        ("budget.maint_zones_res", maint_zones_res),
        ("budget.maint_zones_com", maint_zones_com),
        ("budget.maint_zones_ind", maint_zones_ind),
    ] {
        finite(name, *v, at, out);
    }
    // Expense lines are costs, never credits. A negative one is a sign error
    // somewhere upstream, and it would quietly *pay* the city.
    for (name, v) in [
        ("budget.expenses", expenses),
        ("budget.expenses_transport", expenses_transport),
        ("budget.expenses_buildings", expenses_buildings),
        ("budget.expenses_policies", expenses_policies),
    ] {
        if *v < 0.0 {
            out.push(format!("{at}: {name} is negative ({v})"));
        }
    }
}

/// Same exhaustive treatment for the other stats blocks.
fn check_stats(state: &GameState, at: &str, out: &mut Complaints) {
    let DemandStats {
        residential,
        commercial,
        industrial,
    } = &state.demand;
    finite("demand.residential", *residential, at, out);
    finite("demand.commercial", *commercial, at, out);
    finite("demand.industrial", *industrial, at, out);

    let EducationStats {
        elementary_served,
        elementary_capacity,
        elementary_load,
        high_served,
        high_capacity,
        high_load,
        score,
        elementary_coverage,
        high_coverage,
    } = &state.education;
    for (name, v) in [
        ("education.elementary_served", elementary_served),
        ("education.elementary_capacity", elementary_capacity),
        ("education.elementary_load", elementary_load),
        ("education.high_served", high_served),
        ("education.high_capacity", high_capacity),
        ("education.high_load", high_load),
        ("education.score", score),
        ("education.elementary_coverage", elementary_coverage),
        ("education.high_coverage", high_coverage),
    ] {
        finite(name, *v, at, out);
        if *v < 0.0 {
            out.push(format!("{at}: {name} is negative ({v})"));
        }
    }

    let WildernessStats {
        score,
        trend,
        fast_ema,
        slow_ema,
        seeded: _,
        breakdown,
        local_field,
    } = &state.wilderness;
    finite("wilderness.score", *score, at, out);
    finite("wilderness.trend", *trend, at, out);
    finite("wilderness.fast_ema", *fast_ema, at, out);
    finite("wilderness.slow_ema", *slow_ema, at, out);
    if !(0.0..=100.0).contains(score) {
        out.push(format!("{at}: wilderness.score out of 0..=100 ({score})"));
    }
    if !local_field.is_empty() && local_field.len() != state.tiles.len() {
        out.push(format!(
            "{at}: wilderness.local_field is {} entries for {} tiles",
            local_field.len(),
            state.tiles.len()
        ));
    }

    let WildernessBreakdown {
        forests,
        parks,
        open_land,
        water_edge,
        patch,
        fragmentation,
        zones,
        industry,
        transport,
        power,
        civic,
    } = breakdown;
    for (name, v) in [
        ("wilderness.forests", forests),
        ("wilderness.parks", parks),
        ("wilderness.open_land", open_land),
        ("wilderness.water_edge", water_edge),
        ("wilderness.patch", patch),
        ("wilderness.fragmentation", fragmentation),
        ("wilderness.zones", zones),
        ("wilderness.industry", industry),
        ("wilderness.transport", transport),
        ("wilderness.power", power),
        ("wilderness.civic", civic),
    ] {
        finite(name, *v, at, out);
    }

    // Sub-integer accumulators. These are the floats most likely to drift:
    // they are added to every single tick for the whole run.
    finite64("pop_frac", state.pop_frac, at, out);
    finite64("jobs_frac", state.jobs_frac, at, out);
    finite64("money_frac", state.money_frac, at, out);
    finite64("day_frac", state.day_frac, at, out);
    // `day_frac` carries strictly less than one day; anything else means the
    // day counter has stopped tracking the clock.
    if !(0.0..1.0).contains(&state.day_frac) {
        out.push(format!("{at}: day_frac out of 0..1 ({})", state.day_frac));
    }

    // Population and jobs are `u32`, so "negative" is unrepresentable — but
    // an underflowing subtraction would wrap them to something enormous, and
    // that is the same bug wearing a different type. The map cannot house
    // more than a few hundred per tile.
    let ceiling = (state.tiles.len() as u32).saturating_mul(1_000);
    if state.population > ceiling {
        out.push(format!(
            "{at}: population {} exceeds {ceiling} — likely a `u32` underflow",
            state.population
        ));
    }
    if state.jobs > ceiling {
        out.push(format!(
            "{at}: jobs {} exceeds {ceiling} — likely a `u32` underflow",
            state.jobs
        ));
    }

    // The building-id ceiling.
    //
    // `next_building_id` is a `u32`, but `Tile::building_id` is an
    // `Option<u16>`, and both mint sites — `zones::place_zone_building` and
    // `commands::place_footprint_building` — write `Some(bid as u16)`. Past
    // 65 535 that truncates silently: the `BuildingInstance` keeps its `u32`
    // id, the tile records a wrapped one, and the two stop referring to the
    // same building. `check_tiles` would then report dangling ids, which is a
    // true but very indirect way to say "the counter overflowed", so name it
    // here instead.
    //
    // The counter never resets and is never compacted, so this is a hard
    // lifetime ceiling on a city rather than a transient. The default soak
    // does not come close — at the churn this city sustains it is tens of
    // thousands of simulated days away — but a very long `SOAK` or a much
    // busier city would reach it, and a silent wrap is not a thing to find out
    // about from a corrupted save.
    if state.next_building_id > u16::MAX as u32 {
        out.push(format!(
            "{at}: next_building_id is {}, past the {} that `Tile::building_id`'s `u16` can \
             hold — `Some(bid as u16)` at the mint sites has begun truncating silently",
            state.next_building_id,
            u16::MAX
        ));
    }
}

/// Per-tile floats, and the tile/building bookkeeping that has to stay
/// consistent for the derived wire bytes to mean anything.
fn check_tiles(state: &GameState, at: &str, out: &mut Complaints) {
    let mut bad_happiness = 0usize;
    let mut out_of_range = 0usize;
    let mut bad_scores = 0usize;
    for tile in &state.tiles {
        if !tile.happiness.is_finite() {
            bad_happiness += 1;
        } else if !(0.0..=1.5).contains(&tile.happiness) {
            out_of_range += 1;
        }
        if !tile.elementary_score.is_finite() || !tile.high_score.is_finite() {
            bad_scores += 1;
        }
    }
    if bad_happiness > 0 {
        out.push(format!(
            "{at}: {bad_happiness} tiles have non-finite happiness"
        ));
    }
    if out_of_range > 0 {
        out.push(format!(
            "{at}: {out_of_range} tiles have happiness outside 0.0..=1.5"
        ));
    }
    if bad_scores > 0 {
        out.push(format!(
            "{at}: {bad_scores} tiles have a non-finite education score"
        ));
    }

    for b in &state.buildings {
        if !b.trouble_ticks.is_finite() {
            out.push(format!(
                "{at}: building {} has non-finite trouble_ticks",
                b.id
            ));
            break;
        }
    }

    // Every `building_id` on a tile must resolve to a live building. An
    // abandonment that cleared the list but not the tile would leave a
    // dangling id, and `StructureLookup` would derive the wrong wire kind for
    // it — silently, because `kind_of` returns `None` rather than complaining.
    let live: std::collections::BTreeSet<u32> = state.buildings.iter().map(|b| b.id).collect();
    let mut dangling = 0usize;
    for tile in &state.tiles {
        if let Some(id) = tile.building_id {
            if !live.contains(&(id as u32)) {
                dangling += 1;
            }
        }
    }
    if dangling > 0 {
        out.push(format!(
            "{at}: {dangling} tiles carry a building_id with no live building behind it"
        ));
    }
}

// ---------------------------------------------------------------------------
// The soak
// ---------------------------------------------------------------------------

/// One end of the run: what the worst tick in a window looked like.
///
/// **Worst, not first.** A single-instant sample is the wrong instrument here,
/// and measuring proved it. A churning lot is only alive for the four ticks
/// between developing and being abandoned, so at any one instant the newest
/// live building is usually an old, low-numbered one — which makes a
/// once-per-window probe read low most of the time and spike occasionally.
/// Taking the maximum over every tick in the window catches the spike, so the
/// soak is honest about a *recurring* allocation and not just a permanent one.
/// The live count is maxed over the same window, so worst is compared against
/// worst and the normalisation stays fair.
#[derive(Default)]
struct Window {
    /// Total bytes allocated by the measured ticks (step + host emit).
    bytes: u64,
    /// Peak live building count — the data the index has to cover.
    max_live: usize,
    /// Ids ever minted, at the end of the window: the counter the index must
    /// *not* be sized by.
    next_id: u32,
    /// Peak id among the live buildings.
    ///
    /// Carried because it separates two candidate repairs. `StructureLookup`
    /// sizes its vector by `max(max live id, next_building_id)`; if the first
    /// of those stayed near the live count, dropping the second would be the
    /// whole fix. It does not stay near it — the id space is sparse, and a
    /// freshly developed lot holds an id as high as the counter — so this
    /// column is what shows whether a proposed fix actually bounds anything.
    max_live_id: u32,
    /// Peak bytes one `StructureLookup::new(&state)` allocated during the
    /// window.
    max_lookup_bytes: u64,
    /// Worst retained heap seen between ticks in the window — bytes allocated
    /// and not freed, sampled after the tick's transients have been dropped.
    max_retained_bytes: i64,
}

impl Window {
    /// Fold one tick's state into the window. Call once per tick, *outside*
    /// the per-tick allocation measurement, so the probe does not inflate the
    /// aggregate figure it is compared against.
    fn observe(&mut self, state: &GameState) {
        // Sampled before the probe below allocates anything, so this is the
        // heap the simulation is holding between ticks and nothing else.
        self.max_retained_bytes = self.max_retained_bytes.max(live_bytes());
        let (_, lookup_bytes) = measure_bytes(|| StructureLookup::new(state));
        self.max_lookup_bytes = self.max_lookup_bytes.max(lookup_bytes);
        self.max_live = self.max_live.max(state.buildings.len());
        self.next_id = state.next_building_id;
        self.max_live_id = self
            .max_live_id
            .max(state.buildings.iter().map(|b| b.id).max().unwrap_or(0));
    }

    fn per_tick(&self) -> f64 {
        self.bytes as f64 / WINDOW_TICKS as f64
    }
}

/// One line of the run table.
struct Checkpoint {
    day: u32,
    tick: u64,
    population: u32,
    money: i64,
    live_buildings: usize,
    next_building_id: u32,
    hash: u64,
}

/// Drive the soak once and return `(invariant complaints, allocation findings,
/// simulated days)`. Shared so the enforced invariants and the known-defect
/// acceptance test below measure the *same* run rather than two hand-kept
/// copies of one.
fn run_soak() -> (Complaints, Vec<AllocationFinding>, u32) {
    let days = soak_days();
    let total_ticks = days * TICKS_PER_DAY;
    assert!(
        total_ticks > WARMUP_TICKS + 2 * WINDOW_TICKS,
        "SOAK={days} days is too short to measure — needs at least {} ticks",
        WARMUP_TICKS + 2 * WINDOW_TICKS
    );

    let mut complaints: Complaints = Vec::new();
    // Allocation findings are collected here, each one tagged at the site that
    // raises it with whether it is a recorded known defect. The caller enforces
    // every untagged one; see [`AllocationFinding`].
    let mut allocation: Vec<AllocationFinding> = Vec::new();

    // Two independent cities, built and stepped in lockstep. Identical inputs
    // must give identical `state_hash` at every checkpoint; comparing as we go
    // means a divergence names the checkpoint it began at rather than only
    // being visible at the end.
    let mut a = build_soak_city();
    let mut b = build_soak_city();

    check_budget(&a.state.budget, "build", &mut complaints);
    check_stats(&a.state, "build", &mut complaints);
    check_tiles(&a.state, "build", &mut complaints);

    let checkpoint_every = (total_ticks / 10).max(1);
    let mut log: Vec<Checkpoint> = Vec::new();

    // Windows, in ticks from the start of the run.
    let early_window = WARMUP_TICKS..(WARMUP_TICKS + WINDOW_TICKS);
    let late_window = (total_ticks - WINDOW_TICKS)..total_ticks;

    let mut early = Window::default();
    let mut late = Window::default();

    // Peak is rebased once the cities are built, so it describes the run
    // rather than the build-out.
    rebase_peak();
    let mut checksum = 0u64;

    for t in 0..total_ticks {
        // Only city A is measured: B exists to answer the reproducibility
        // question and its allocations are not part of the budget.
        let window = if early_window.contains(&t) {
            Some(&mut early)
        } else if late_window.contains(&t) {
            Some(&mut late)
        } else {
            None
        };
        if let Some(w) = window {
            let ((), bytes) = measure_bytes(|| {
                a.step(TICK_DT);
                checksum = checksum.wrapping_add(emit_wire_frame(&a.state));
            });
            w.bytes += bytes;
            w.observe(&a.state);
        } else {
            a.step(TICK_DT);
            checksum = checksum.wrapping_add(emit_wire_frame(&a.state));
        }

        b.step(TICK_DT);

        let last = t + 1 == total_ticks;
        if (t + 1) % checkpoint_every == 0 || last {
            let at = format!("day {}", a.state.day);
            check_budget(&a.state.budget, &at, &mut complaints);
            check_stats(&a.state, &at, &mut complaints);
            check_tiles(&a.state, &at, &mut complaints);

            let ha = state_hash(&a.state);
            let hb = state_hash(&b.state);
            if ha != hb {
                complaints.push(format!(
                    "{at}: two identical runs disagree — state_hash {ha:#018x} vs {hb:#018x}"
                ));
            }
            log.push(Checkpoint {
                day: a.state.day,
                tick: a.state.tick,
                population: a.state.population,
                money: a.state.money,
                live_buildings: a.state.buildings.len(),
                next_building_id: a.state.next_building_id,
                hash: ha,
            });
        }
    }

    let peak = peak_live();

    // -- The run table ----------------------------------------------------
    println!(
        "\nsoak: {WIDTH}×{HEIGHT}, seed {SEED}, {days} days ({total_ticks} ticks), \
         SOAK={}, wire checksum {checksum:#018x}\n",
        std::env::var("SOAK").unwrap_or_else(|_| "unset (default)".into())
    );
    println!(
        "{:>7}  {:>8}  {:>7}  {:>12}  {:>6}  {:>9}  {:>18}",
        "day", "tick", "pop", "money", "live", "next_id", "state_hash"
    );
    for c in &log {
        println!(
            "{:>7}  {:>8}  {:>7}  {:>12}  {:>6}  {:>9}  {:#018x}",
            c.day, c.tick, c.population, c.money, c.live_buildings, c.next_building_id, c.hash
        );
    }

    let ratio = late.per_tick() / early.per_tick().max(1.0);
    let span_days = (late_window.start - early_window.start) as f64 / TICKS_PER_DAY as f64;
    let churn_per_day = (late.next_id - early.next_id) as f64 / span_days;

    let retained_ratio =
        late.max_retained_bytes as f64 / (early.max_retained_bytes as f64).max(1.0);

    println!(
        "\nallocation, city A, including the 20 Hz host emit. Each window is {WINDOW_TICKS} ticks;\n\
         the live, id, retained and lookup columns are the worst tick in the window, not the first.\n\
         \x20 early  ticks {:>6}..{:<6}  {:>9.0} B/tick   live {:>5}  max live id {:>8}  next_building_id {:>8}  retained {:>10} B  StructureLookup::new {:>8} B\n\
         \x20 late   ticks {:>6}..{:<6}  {:>9.0} B/tick   live {:>5}  max live id {:>8}  next_building_id {:>8}  retained {:>10} B  StructureLookup::new {:>8} B\n\
         \x20 per-tick growth {ratio:.2}× (tolerance {ALLOC_GROWTH_TOLERANCE:.2}×)\n\
         \x20 retained growth {retained_ratio:.2}× (tolerance {RETAINED_GROWTH_TOLERANCE:.2}× + {RETAINED_SLACK_BYTES:.0} B)\n\
         \x20 zone churn {churn_per_day:.1} new building ids per simulated day over {span_days:.0} days\n\
         \x20 peak live heap during the run {:.2} MiB\n",
        early_window.start,
        early_window.end,
        early.per_tick(),
        early.max_live,
        early.max_live_id,
        early.next_id,
        early.max_retained_bytes,
        early.max_lookup_bytes,
        late_window.start,
        late_window.end,
        late.per_tick(),
        late.max_live,
        late.max_live_id,
        late.next_id,
        late.max_retained_bytes,
        late.max_lookup_bytes,
        peak as f64 / (1024.0 * 1024.0),
    );

    // -- The isolated probe, measured first -------------------------------
    //
    // The aggregate below says *something* grew. This says what. It is measured
    // first only so the aggregate's message can name whether the two fired
    // together, which is the difference between "#180 has finally reached the
    // coarse net" and "something new is leaking".
    //
    // A `StructureLookup` is an index of the live buildings, so the memory it
    // needs is a function of how many buildings are live — not of how many have
    // ever existed. Comparing the worst call in each window, and normalising by
    // the change in peak live count, makes the check scale-free: it does not
    // care what the index costs per building, only that the cost tracks the
    // buildings rather than the clock.
    let live_ratio = late.max_live as f64 / (early.max_live as f64).max(1.0);
    let allowed =
        early.max_lookup_bytes as f64 * live_ratio * LOOKUP_GROWTH_TOLERANCE + LOOKUP_SLACK_BYTES;
    let probe_fired = late.max_lookup_bytes as f64 > allowed;

    // -- The aggregate assertion ------------------------------------------
    //
    // Steady state means steady work. The map does not grow, the live building
    // count does not trend, and the player does nothing after the build-out —
    // so the late window must not allocate materially more per tick than the
    // early one. Anything that does is sized by something monotonic.
    //
    // This one is **enforced**: it carries no known-defect tag, so it fails the
    // soak. It is the general net, and it has to stay able to see a leak that
    // has nothing to do with #180.
    if ratio > ALLOC_GROWTH_TOLERANCE {
        // Whether this is #180 arriving in the coarse net or a second defect is
        // decided by arithmetic, not by whether the probe happens to have fired
        // — it fires on every run of the default length or longer, so treating
        // that as an excuse would put every future aggregate finding under
        // someone else's issue number. Both figures go in the message and the
        // reader is asked to compare them.
        let agg_excess = late.per_tick() - early.per_tick();
        let lookup_excess = late.max_lookup_bytes as i64 - early.max_lookup_bytes as i64;
        let attribution = if probe_fired {
            format!(
                "\n    Known defect {KNOWN_DEFECT} is also present on this run: \
                 `StructureLookup::new` grew {lookup_excess} B per call over the same interval. \
                 The tick path builds only a handful of lookups per tick (the host emit, \
                 `state_hash`, and `compute_wilderness` on its cadence), so {KNOWN_DEFECT} can \
                 account for a few times {lookup_excess} B/tick at most — against the \
                 {agg_excess:.0} B/tick this finding reports. Compare those two before filing \
                 this under {KNOWN_DEFECT}: if they are not the same order of magnitude, this \
                 is a second, unrelated leak."
            )
        } else {
            format!(
                "\n    The `StructureLookup::new` probe did NOT fire on this run, so this is \
                 not known defect {KNOWN_DEFECT}. Something else on the tick or wire-emit path \
                 is sized by a counter. It grew {agg_excess:.0} B/tick."
            )
        };
        allocation.push(AllocationFinding::enforced(format!(
            "steady-state allocation per tick grew {ratio:.2}× between tick {} and tick {} \
             ({:.0} → {:.0} B/tick) while the live building count went {} → {}. Per-tick work \
             is bounded by the map, which did not change, so something on the tick path is \
             sized by a counter rather than by the live data. `next_building_id` went {} → {} \
             over the same interval ({churn_per_day:.1}/day){attribution}",
            early_window.start,
            late_window.start,
            early.per_tick(),
            late.per_tick(),
            early.max_live,
            late.max_live,
            early.next_id,
            late.next_id
        )));
    }

    // -- The retained-heap assertion --------------------------------------
    //
    // The aggregate above compares *rates*, and that is blind to a whole class
    // of leak by construction: pushing one `String` per tile into a `Vec` that
    // is never drained allocates the same number of bytes on every tick for
    // ever, so the rate never grows even as the heap does. Measured, that
    // mutation takes the peak heap from 0.05 MiB to 100 MiB and moves the
    // per-tick ratio not at all. So the heap itself is asserted, not just
    // printed.
    //
    // Enforced, and untaggable as #180: `StructureLookup` is a transient that
    // is dropped before this is sampled, so #180 cannot register here at all
    // and cannot be offered as an explanation for anything that does.
    if late.max_retained_bytes as f64
        > early.max_retained_bytes as f64 * RETAINED_GROWTH_TOLERANCE + RETAINED_SLACK_BYTES
    {
        let grew = late.max_retained_bytes - early.max_retained_bytes;
        allocation.push(AllocationFinding::enforced(format!(
            "retained heap between ticks grew {retained_ratio:.2}× between tick {} and tick {} \
             ({} → {} B, +{grew} B) while the live building count went {} → {}. This is memory \
             allocated and never freed, not per-tick churn: something is accumulating across \
             ticks — a `Vec` pushed to and never drained, a cache with no eviction, a history \
             that keeps every entry. Known defect {KNOWN_DEFECT} cannot be the cause and does \
             not excuse this: a `StructureLookup` is a transient, dropped before this figure is \
             sampled, so it contributes nothing to it. Peak heap over the whole run was {:.2} \
             MiB, against {:.2} MiB retained in the early window",
            early_window.start,
            late_window.start,
            early.max_retained_bytes,
            late.max_retained_bytes,
            early.max_live,
            late.max_live,
            peak as f64 / (1024.0 * 1024.0),
            early.max_retained_bytes as f64 / (1024.0 * 1024.0),
        )));
    }

    if probe_fired {
        allocation.push(AllocationFinding::known_defect(
            KNOWN_DEFECT,
            format!(
                "the worst `StructureLookup::new` in a window went {} B → {} B over the run while \
             the live building count it indexes went {} → {} ({live_ratio:.2}×). Sized by the \
             live data it would have grown {live_ratio:.2}×; it grew {:.2}×.\n    \
             It allocates `vec![None; max(max live id, next_building_id) + 1]` — sized by the \
             id space, not by the buildings in it. The id space only ever grows under zone \
             churn ({churn_per_day:.1} new ids per simulated day here) while the live count \
             does not: next_building_id {} → {}, max live id {} → {}.\n    \
             Both halves of that `max` are unbounded, so removing either one alone is not a \
             fix: `next_building_id` climbs monotonically, and the max *live* id climbs with \
             it whenever a freshly developed lot is alive — which is every few ticks under \
             churn. The repair is to stop indexing a dense `Vec` by a sparse building id.\n    \
             The 20 Hz host emit path and `state_hash` no longer allocate one of these — #177's \
             TS/wire follow-up deleted the derivation that needed a lookup there. \
             `compute_wilderness` is the call site this run's probe measures.",
                early.max_lookup_bytes,
                late.max_lookup_bytes,
                early.max_live,
                late.max_live,
                late.max_lookup_bytes as f64 / (early.max_lookup_bytes as f64).max(1.0),
                early.next_id,
                late.next_id,
                early.max_live_id,
                late.max_live_id,
            ),
        ));
    }

    (complaints, allocation, days)
}

/// The invariants: no panic, no NaN or infinity, no impossible stat,
/// reproducible `state_hash`, bounded bytes per tick and bounded retained heap
/// — **and** every allocation finding except the one whose signature is the
/// recorded known defect #180.
///
/// Three things happen here, in this order:
///
/// 1. Findings tagged with a known defect are printed under a banner that names
///    the issue, and do not fail. Exactly one signature is tagged, and only the
///    `StructureLookup::new` probe tags it.
/// 2. Every other finding — the rate aggregate, the retained heap, anything
///    added later — is folded into the complaints and fails the test. That is
///    what stops a new leak being filed under someone else's issue number, and
///    it is what makes this test, which *runs*, the thing enforcing the
///    allocation gate rather than the `#[ignore]`d one below.
/// 3. On a run of the default length or longer, the absence of the known finding
///    is itself a failure. A known exception nobody has re-checked is how a
///    harness quietly stops asserting anything, so the exception is pinned the
///    same way the parity harness pins its known drifts: fix #180 and this goes
///    red asking for the exception to be deleted.
#[test]
fn soak_long_run_stays_sane() {
    let (mut complaints, allocation, days) = run_soak();

    let (known, unexpected): (Vec<&AllocationFinding>, Vec<&AllocationFinding>) =
        allocation.iter().partition(|f| f.known.is_some());

    for f in &known {
        println!(
            "\nKNOWN DEFECT {} — reported, not failing this test:\n  - {}\n",
            f.known.unwrap_or("?"),
            f.message
        );
    }

    complaints.extend(unexpected.iter().map(|f| f.message.clone()));

    if days >= DEFAULT_DAYS && known.is_empty() {
        complaints.push(format!(
            "the `StructureLookup::new` probe did not fire over {days} simulated days, but \
             known defect {KNOWN_DEFECT} says it must. Either the defect is FIXED — in which \
             case delete the `AllocationFinding::known_defect` arm, un-`ignore` \
             `allocation_per_call_tracks_live_buildings_not_the_id_space`, and update the module \
             note — or the soak has stopped measuring the thing it excuses, which would let \
             {KNOWN_DEFECT} hide any amount of new growth behind it"
        ));
    }

    if !complaints.is_empty() {
        panic!(
            "the soak found {} problem(s) over {days} simulated days:\n  - {}\n",
            complaints.len(),
            complaints.join("\n  - ")
        );
    }
}

/// The acceptance test for #180. **Un-`ignore` this when the fix lands** —
/// that is the whole point of it existing.
///
/// `StructureLookup::new` allocates `vec![None; max(max live id, next_building_id) + 1]`,
/// a dense `Vec` indexed by a sparse building id, so it is sized by the id
/// space rather than by the buildings in it. Zone churn grows the id space for
/// ever while the live count holds steady, and the allocation is on the 20 Hz
/// host emit path (`SimHost::tile_buffer`, the Tauri tick event) as well as on
/// `state_hash` and `compute_wilderness`.
///
/// Measured over 160 simulated days: 78 B → 204 B per call while the live
/// building count it indexes went 28 → 28.
///
/// Kept `#[ignore]` rather than deleted or weakened so the harness records the
/// defect instead of being tuned around it. Note that it is *not* the only thing
/// standing between #180 and a green tree: [`soak_long_run_stays_sane`] runs, it
/// enforces every allocation finding this one does bar the single excused
/// signature, and it fails if that signature stops appearing.
#[test]
#[ignore = "known defect #180 — StructureLookup is sized by the id space, not the live count"]
fn allocation_per_call_tracks_live_buildings_not_the_id_space() {
    let (_, allocation, _) = run_soak();
    let messages: Vec<&str> = allocation.iter().map(|f| f.message.as_str()).collect();
    assert!(
        messages.is_empty(),
        "#180 is still open:\n  - {}\n",
        messages.join("\n  - ")
    );
}

/// The precondition the soak's allocation assertions rest on, asserted on its
/// own so a failure says *which* thing broke.
///
/// [`soak_long_run_stays_sane`] can only tell an index sized by
/// `next_building_id` apart from one sized by the live building count if those
/// two numbers actually diverge. Two things would silently stop that: zones
/// could stop being abandoned (no churn), or the city could still be under
/// construction at the end of the run (live count climbing as fast as the
/// counter). Either would leave the soak green while measuring nothing at all
/// — the worst possible failure mode for a regression test.
///
/// So this asserts both directly. If it fails, fix `build_soak_city`; do not
/// relax the numbers here, and do not relax the soak.
#[test]
fn the_outpost_churns_building_ids_while_the_city_holds_steady() {
    let window_days = 60;
    let mut sim = build_soak_city();
    for _ in 0..WARMUP_TICKS {
        sim.step(TICK_DT);
    }
    let day0 = sim.state.day;
    let id0 = sim.state.next_building_id;
    let live0 = sim.state.buildings.len();

    for _ in 0..(window_days * TICKS_PER_DAY) {
        sim.step(TICK_DT);
    }
    let elapsed_days = (sim.state.day - day0) as f64;
    let minted = sim.state.next_building_id - id0;
    let live1 = sim.state.buildings.len();
    let per_day = minted as f64 / elapsed_days;
    let live_growth = live1 as f64 / (live0 as f64).max(1.0);

    println!(
        "churn over {elapsed_days} days: {minted} ids minted ({per_day:.1}/day); \
         live buildings {live0} → {live1} ({live_growth:.2}×); \
         next_building_id {id0} → {}",
        sim.state.next_building_id
    );

    // The counter must lap the live count: at least one whole city's worth of
    // fresh ids minted per window, while the city itself stays the same size.
    // Below that, an index sized by the counter and one sized by the live data
    // are not far enough apart for the soak to tell them apart.
    let needed = live1 as u32;
    assert!(
        minted >= needed,
        "the outpost has stopped churning: only {minted} building ids minted over \
         {elapsed_days} days against {live1} live buildings (wanted at least {needed}, \
         and the layout as committed mints about {:.0}). The soak's allocation \
         assertions measure nothing without churn. Most likely causes: the firebreak in \
         `build_soak_city` no longer isolates the outpost's road network — roads conduct \
         power — or the zoned footprint has grown enough that the pending-zone demand \
         penalty has stalled regrowth",
        2.7 * live1 as f64
    );

    // And the live count — which is what legitimately bounds per-tick work —
    // must be flat, or the soak's early and late windows are not comparable.
    assert!(
        live_growth < 1.25,
        "the live building count grew {live_growth:.2}× over the measurement window \
         ({live0} → {live1}): the city has not reached steady state by tick \
         {WARMUP_TICKS}, so the soak's early and late allocation windows are measuring \
         construction rather than a leak. Raise `WARMUP_TICKS` or shrink the zoned \
         footprint in `build_soak_city`"
    );
}
