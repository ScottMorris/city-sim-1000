// sim_bench.rs — criterion benchmarks for city-sim-core simulation systems.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use city_sim_core::{
    commands::apply_tool,
    history::{History, HistoryConfig},
    sim::Simulation,
    snapshot::{from_bytes, to_bytes},
    state::GameState,
};
use city_sim_protocol::commands::{Tool, ViewStratum};
use criterion::{black_box, criterion_group, criterion_main, Criterion};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Build a small but non-trivial 8×8 city: roads + zones + demand primed.
/// Mirrors the `make_city_sim` helper in sim.rs tests.
fn make_populated_8x8(seed: u32) -> Simulation {
    let mut sim = Simulation::new(8, 8, seed);
    // Roads
    apply_tool(&mut sim.state, Tool::Road, 3, 0, ViewStratum::Surface);
    apply_tool(&mut sim.state, Tool::Road, 3, 1, ViewStratum::Surface);
    apply_tool(&mut sim.state, Tool::Road, 3, 2, ViewStratum::Surface);
    apply_tool(&mut sim.state, Tool::Road, 3, 3, ViewStratum::Surface);
    // Zones
    apply_tool(
        &mut sim.state,
        Tool::Residential,
        0,
        0,
        ViewStratum::Surface,
    );
    apply_tool(
        &mut sim.state,
        Tool::Residential,
        1,
        0,
        ViewStratum::Surface,
    );
    apply_tool(
        &mut sim.state,
        Tool::Residential,
        0,
        1,
        ViewStratum::Surface,
    );
    apply_tool(
        &mut sim.state,
        Tool::Residential,
        1,
        1,
        ViewStratum::Surface,
    );
    apply_tool(&mut sim.state, Tool::Commercial, 0, 2, ViewStratum::Surface);
    apply_tool(&mut sim.state, Tool::Industrial, 0, 3, ViewStratum::Surface);
    // Prime demand so zone growth fires from tick 1
    sim.state.demand.residential = 80.0;
    sim.state.demand.commercial = 60.0;
    sim.state.demand.industrial = 60.0;
    sim
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

/// 100 ticks of a populated 8×8 city at dt = 1/20 s.
///
/// Exercises the full tick loop: utility BFS, zone growth, building states,
/// demand, economy, and decay. A good overall regression benchmark.
fn tick_100(c: &mut Criterion) {
    c.bench_function("tick_100", |b| {
        b.iter_batched(
            || make_populated_8x8(42),
            |mut sim| {
                for _ in 0..100 {
                    sim.step(black_box(1.0 / 20.0));
                }
                black_box(sim)
            },
            criterion::BatchSize::SmallInput,
        )
    });
}

/// 1000 ticks of a blank 64×64 city.
///
/// Stresses the O(n) per-tile operations (BFS seeds, tile iteration) on a
/// larger grid. Blank city means zone growth never fires, isolating the
/// utility/budget subsystems.
fn tick_1000_64x64(c: &mut Criterion) {
    c.bench_function("tick_1000_64x64", |b| {
        b.iter_batched(
            || Simulation::new(64, 64, 0),
            |mut sim| {
                for _ in 0..1000 {
                    sim.step(black_box(1.0 / 20.0));
                }
                black_box(sim)
            },
            criterion::BatchSize::SmallInput,
        )
    });
}

/// Single `apply_tool(Road, ViewStratum::Surface)` call on a fresh 8×8 state.
///
/// Measures the cost of the hottest player-action path: bounds check, fund
/// deduction, tile mutation, and tile_revision bump.
fn apply_tool_road(c: &mut Criterion) {
    c.bench_function("apply_tool_road", |b| {
        b.iter_batched(
            || GameState::new(8, 8, 0),
            |mut state| {
                let result = apply_tool(
                    &mut state,
                    black_box(Tool::Road),
                    3,
                    3,
                    ViewStratum::Surface,
                );
                black_box(result)
            },
            criterion::BatchSize::SmallInput,
        )
    });
}

/// `to_bytes` + `from_bytes` round-trip of a populated 8×8 city.
///
/// Measures snapshot serialisation performance, which determines save/load
/// and send-over-channel latency.
fn snapshot_roundtrip(c: &mut Criterion) {
    let sim = make_populated_8x8(42);
    let state = &sim.state;

    c.bench_function("snapshot_roundtrip", |b| {
        b.iter(|| {
            let bytes = to_bytes(black_box(state)).expect("serialise");
            let restored = from_bytes(black_box(&bytes)).expect("deserialise");
            black_box(restored)
        })
    });
}

/// One full undo step through the snapshot-stack `History`: capture the
/// pre-stroke snapshot, then restore it via `Simulation::load_state`.
///
/// This is the whole cost of the O(1) undo model — replacing the old
/// replay-from-seed bench, which scaled with session length.
fn history_undo_restore(c: &mut Criterion) {
    c.bench_function("history_undo_restore", |b| {
        b.iter(|| {
            let mut sim = make_populated_8x8(42);
            let mut history = History::new(HistoryConfig::default());
            let bytes = history.prepare(&sim.state, 1).expect("snapshot encodes");
            history.commit(bytes, 1);
            let restored = history.undo(&sim.state).expect("one entry");
            sim.load_state(restored);
            black_box(sim)
        })
    });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

criterion_group!(
    benches,
    tick_100,
    tick_1000_64x64,
    apply_tool_road,
    snapshot_roundtrip,
    history_undo_restore,
);
criterion_main!(benches);
