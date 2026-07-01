// sim_bench.rs — criterion benchmarks for city-sim-core simulation systems.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use city_sim_core::{
    command_log::CommandLog,
    commands::apply_tool,
    sim::Simulation,
    snapshot::{from_bytes, to_bytes},
    state::GameState,
};
use city_sim_protocol::commands::Tool;
use criterion::{black_box, criterion_group, criterion_main, Criterion};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Build a small but non-trivial 8×8 city: roads + zones + demand primed.
/// Mirrors the `make_city_sim` helper in sim.rs tests.
fn make_populated_8x8(seed: u32) -> Simulation {
    let mut sim = Simulation::new(8, 8, seed);
    // Roads
    apply_tool(&mut sim.state, Tool::Road, 3, 0);
    apply_tool(&mut sim.state, Tool::Road, 3, 1);
    apply_tool(&mut sim.state, Tool::Road, 3, 2);
    apply_tool(&mut sim.state, Tool::Road, 3, 3);
    // Zones
    apply_tool(&mut sim.state, Tool::Residential, 0, 0);
    apply_tool(&mut sim.state, Tool::Residential, 1, 0);
    apply_tool(&mut sim.state, Tool::Residential, 0, 1);
    apply_tool(&mut sim.state, Tool::Residential, 1, 1);
    apply_tool(&mut sim.state, Tool::Commercial, 0, 2);
    apply_tool(&mut sim.state, Tool::Industrial, 0, 3);
    // Prime demand so zone growth fires from tick 1
    sim.state.demand.residential = 80.0;
    sim.state.demand.commercial = 60.0;
    sim.state.demand.industrial = 60.0;
    sim
}

/// Build a command log with ~50 entries spread across tick 0..10.
fn make_command_log_50() -> CommandLog {
    let mut log = CommandLog::new(8, 8, 42);
    // Lay roads along column 3 (ticks 0..5)
    for row in 0..5u32 {
        log.record(row as u64, Tool::Road, 3, row);
    }
    // Place zones adjacent to roads (ticks 5..10)
    for row in 0..5u32 {
        log.record((5 + row) as u64, Tool::Residential, 2, row);
    }
    // Additional commercial / industrial (tick 10)
    log.record(10, Tool::Commercial, 4, 0);
    log.record(10, Tool::Commercial, 4, 1);
    log.record(10, Tool::Industrial, 4, 2);
    log.record(10, Tool::Industrial, 4, 3);
    // Water infrastructure (tick 12)
    log.record(12, Tool::WaterPump, 6, 0);
    log.record(12, Tool::WaterPipe, 5, 0);
    log.record(12, Tool::WaterPipe, 4, 0);
    // More roads to reach 50 entries
    for i in 0..35u32 {
        let x = (i % 7) + 1;
        let y = (i / 7) % 8;
        let tick = 15 + i as u64;
        log.record(tick, Tool::Road, x, y);
    }
    log
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

/// Single `apply_tool(Road)` call on a fresh 8×8 state.
///
/// Measures the cost of the hottest player-action path: bounds check, fund
/// deduction, tile mutation, and tile_revision bump.
fn apply_tool_road(c: &mut Criterion) {
    c.bench_function("apply_tool_road", |b| {
        b.iter_batched(
            || GameState::new(8, 8, 0),
            |mut state| {
                let result = apply_tool(&mut state, black_box(Tool::Road), 3, 3);
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

/// `CommandLog::replay()` on a log with ~50 entries.
///
/// Replay must advance the sim tick-by-tick between commands, so this
/// measures both the replay dispatcher overhead and the underlying tick cost.
fn command_log_replay(c: &mut Criterion) {
    let log = make_command_log_50();

    c.bench_function("command_log_replay", |b| {
        b.iter(|| {
            let sim = black_box(&log).replay();
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
    command_log_replay,
);
criterion_main!(benches);
