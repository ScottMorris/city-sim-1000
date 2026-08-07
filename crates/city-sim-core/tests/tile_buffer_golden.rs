// tile_buffer_golden.rs — cross-language golden fixture for the live SoA tile buffer.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

//! Builds a small deterministic 16×16 city with real `apply_tool` calls and a
//! few hundred ticks, encodes it with `wire::encode_tile_buffer` (the same
//! encoder both hosts call), and pins the resulting bytes — plus width and
//! height — against a committed fixture,
//! `tests/fixtures/tile_buffer_golden.json`. `tileBuffer.golden.test.ts` on
//! the TS side decodes the *same* fixture file and asserts against it too —
//! one golden shared across the language boundary. **The fixture is
//! regenerated from this side only** — the TS test only ever reads it.
//!
//! Two hand-copied offset tests (`tile_buffer.rs`'s `offsets_for_64x64`, and
//! its TS mirror in `protocol.test.ts`) already pin the byte layout in the
//! abstract; this pins one concrete encoding of it end to end, catching a
//! codec change on either side that happens to leave the abstract offsets
//! alone.
//!
//! ## Regenerating it
//!
//! ```text
//! GOLDEN=regen cargo test -p city-sim-core --test tile_buffer_golden
//! ```
//!
//! Regeneration is a deliberate act, same discipline as `golden_city.rs`: name
//! what moved and why in the commit message. After regenerating, re-check
//! `tileBuffer.golden.test.ts`'s assertions against the new fixture by hand —
//! nothing on the TS side regenerates itself.

use std::path::PathBuf;

use city_sim_core::commands::apply_tool;
use city_sim_core::sim::Simulation;
use city_sim_core::wire::encode_tile_buffer;
use city_sim_protocol::commands::{Tool, ViewStratum};

const WIDTH: u32 = 16;
const HEIGHT: u32 = 16;
const SEED: u32 = 4242;
/// One fixed tick, in real seconds — matches `golden_city.rs`'s `TICK_DT`.
const TICK_DT: f64 = 1.0 / 20.0;
const TICKS: u32 = 260;

const FIXTURE: &str = include_str!("fixtures/tile_buffer_golden.json");

#[derive(Debug, serde::Serialize, serde::Deserialize, PartialEq)]
struct Fixture {
    width: u32,
    height: u32,
    /// `wire::encode_tile_buffer`'s output — the exact SoA layout
    /// `city_sim_protocol::tile_buffer` describes.
    bytes: Vec<u8>,
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tile_buffer_golden.json")
}

/// Builds the golden city: a hydro plant, a water tower and an elementary
/// school in a touching row (so the tower and the school both sit on the
/// plant's power network without a relay line — any developed building
/// conducts, see `Tile::conducts`), two residential zone tiles against the
/// school's south edge (adjacent enough for `reachable_zone_candidates`'s
/// road/zone-only walk to actually reach them, not just near enough in a
/// straight line), road access, and a scattering of standalone features — a
/// level crossing, a bare hydro line, a buried pipe, a tree, open water, and
/// a park — purely for occupant-bit variety in the encoded buffer.
fn build_city() -> Simulation {
    let mut sim = Simulation::new(WIDTH, HEIGHT, SEED);

    // Utility row: plant | tower | school, each 2×2 and touching the next so
    // all three — and anything touching the row — share one conducting
    // component off the plant alone.
    apply_tool(&mut sim.state, Tool::HydroPlant, 2, 2, ViewStratum::Surface);
    apply_tool(&mut sim.state, Tool::WaterTower, 4, 2, ViewStratum::Surface);
    apply_tool(
        &mut sim.state,
        Tool::ElementarySchool,
        6,
        2,
        ViewStratum::Surface,
    );

    // Two residential zone tiles against the school's south edge.
    apply_tool(
        &mut sim.state,
        Tool::Residential,
        6,
        4,
        ViewStratum::Surface,
    );
    apply_tool(
        &mut sim.state,
        Tool::Residential,
        7,
        4,
        ViewStratum::Surface,
    );
    apply_tool(&mut sim.state, Tool::Road, 6, 5, ViewStratum::Surface);
    apply_tool(&mut sim.state, Tool::Road, 7, 5, ViewStratum::Surface);

    // A level crossing (road built first, rail second) well away from the
    // utility cluster.
    apply_tool(&mut sim.state, Tool::Road, 10, 10, ViewStratum::Surface);
    apply_tool(&mut sim.state, Tool::Rail, 10, 10, ViewStratum::Surface);

    // A bare hydro line on open ground.
    apply_tool(&mut sim.state, Tool::PowerLine, 1, 10, ViewStratum::Surface);

    // A buried pipe with nothing above it.
    apply_tool(
        &mut sim.state,
        Tool::WaterPipe,
        1,
        12,
        ViewStratum::Underground,
    );

    // A tree.
    apply_tool(&mut sim.state, Tool::Tree, 1, 14, ViewStratum::Surface);

    // Open water.
    apply_tool(&mut sim.state, Tool::Water, 14, 14, ViewStratum::Surface);

    // A park — a second, independent 1×1 footprint building.
    apply_tool(&mut sim.state, Tool::Park, 9, 9, ViewStratum::Surface);

    // Long enough past the 40-tick (~2 s) zone-growth delay for both
    // residential lots to develop and for education/utilities to settle.
    for _ in 0..TICKS {
        sim.step(TICK_DT);
    }

    sim
}

fn regen_message(got_json: &str) -> String {
    format!(
        "tests/fixtures/tile_buffer_golden.json is out of sync with what \
         build_city() now encodes.\n\
         Regenerate deliberately — name what moved and why in the commit message:\n\
           GOLDEN=regen cargo test -p city-sim-core --test tile_buffer_golden\n\n\
         Expected fixture content:\n{got_json}"
    )
}

#[test]
fn the_golden_tile_buffer_matches_the_committed_fixture() {
    let sim = build_city();
    let bytes = encode_tile_buffer(&sim.state);
    let got = Fixture {
        width: sim.state.width,
        height: sim.state.height,
        bytes,
    };
    let got_json = serde_json::to_string_pretty(&got).expect("serialise fixture");

    if std::env::var("GOLDEN").as_deref() == Ok("regen") {
        std::fs::write(fixture_path(), format!("{got_json}\n")).expect("write fixture");
        eprintln!(
            "\n*** tile_buffer_golden.json REGENERATED ***\n\
             This is a deliberate act. `git diff` it, name what moved and why the new\n\
             bytes are right, and justify it in the commit message.\n"
        );
        return;
    }

    let want: Fixture = serde_json::from_str(FIXTURE).unwrap_or_else(|e| {
        panic!(
            "tests/fixtures/tile_buffer_golden.json failed to parse: {e}\n\n{}",
            regen_message(&got_json)
        )
    });

    assert_eq!(got.width, want.width, "{}", regen_message(&got_json));
    assert_eq!(got.height, want.height, "{}", regen_message(&got_json));
    assert_eq!(
        got.bytes.len(),
        want.bytes.len(),
        "{}",
        regen_message(&got_json)
    );
    assert_eq!(got.bytes, want.bytes, "{}", regen_message(&got_json));
}

/// Two replays of the same seeded script must encode identical bytes — a
/// prerequisite for the fixture meaning anything at all.
#[test]
fn the_golden_tile_buffer_is_deterministic() {
    let a = encode_tile_buffer(&build_city().state);
    let b = encode_tile_buffer(&build_city().state);
    assert_eq!(a, b, "two replays of build_city() encoded different bytes");
}
