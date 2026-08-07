// export_bindings.rs — generates the checked-in TS mirror of this crate's wire types.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

//! Regenerates `app/src/game/protocol/generated/` from the `#[derive(TS)]` types in
//! this crate — the canonical TS mirror of every protocol type that actually crosses
//! a JSON boundary. Hand-editing anything under `generated/` is pointless: this test
//! overwrites it deterministically on every `cargo test -p city-sim-protocol` run.
//!
//! `crates/tauri-plugin-city-sim/tests/export_bindings.rs` re-exports the subset
//! `guest-js/` needs (`Policies`, `CommandResult`, plus everything `TickEvent`
//! depends on) into its own `guest-js/generated/` — see that file for why it is a
//! second copy rather than an import reaching into `app/`.
//!
//! CI enforces freshness with `git diff --exit-code -- app/src/game/protocol/generated/`
//! after `cargo test --workspace` — see `.github/workflows/ci.yml`.

use std::path::PathBuf;

use city_sim_protocol::building_kind::{BuildingCategory, BuildingKind};
use city_sim_protocol::commands::{CommandResult, Policies};
use city_sim_protocol::events::SimAlert;
use city_sim_protocol::wire_types::{
    WireBudgetHistoryEntry, WireBudgetStats, WireBuilding, WireDemandBreakdown,
    WireEducationSeatsUsed, WireEducationStats, WireLabourStats, WireUtilityComponent,
    WireWildernessBreakdown,
};
use ts_rs::{Config, TS};

fn export_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR rather than a relative path: deterministic regardless of
    // whether the test binary is invoked from the workspace root
    // (`cargo test --workspace`) or from this crate's own directory
    // (`cargo test -p city-sim-protocol`).
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../app/src/game/protocol/generated")
}

#[test]
fn export_bindings() {
    // None of this crate's exported types carry a 64-bit integer today, but pin
    // the same "number", not ts-rs's default "bigint", that
    // `tauri-plugin-city-sim`'s export uses — see that crate's
    // `tests/export_bindings.rs` for why: every 64-bit field on the wire here
    // round-trips through JSON, which has no `bigint`, so `number` (with its
    // documented ±2^53 precision caveat) is what actually arrives in TS, not a
    // native `bigint`.
    let cfg = Config::new()
        .with_out_dir(export_dir())
        .with_large_int("number");

    // `export_all` also writes each type's structural dependencies (e.g. `Policies`
    // pulls in `BudgetPolicy`/`WildernessPolicy`, `SimAlert` pulls in `AlertKind`) —
    // see each type's `#[ts(export_to = "...")]` for its filename.
    Policies::export_all(&cfg).expect("export Policies");
    CommandResult::export_all(&cfg).expect("export CommandResult");
    SimAlert::export_all(&cfg).expect("export SimAlert");
    WireBuilding::export_all(&cfg).expect("export WireBuilding");
    WireUtilityComponent::export_all(&cfg).expect("export WireUtilityComponent");
    WireEducationStats::export_all(&cfg).expect("export WireEducationStats");
    WireEducationSeatsUsed::export_all(&cfg).expect("export WireEducationSeatsUsed");
    WireBudgetHistoryEntry::export_all(&cfg).expect("export WireBudgetHistoryEntry");
    WireBudgetStats::export_all(&cfg).expect("export WireBudgetStats");
    WireWildernessBreakdown::export_all(&cfg).expect("export WireWildernessBreakdown");
    WireLabourStats::export_all(&cfg).expect("export WireLabourStats");
    // Pulls in `WireDemandClassBreakdown` as a structural dependency.
    WireDemandBreakdown::export_all(&cfg).expect("export WireDemandBreakdown");
    // Not a structural dependency of `BuildingKind` (`category()` is a method, not a
    // field), so it needs its own explicit call.
    BuildingKind::export_all(&cfg).expect("export BuildingKind");
    BuildingCategory::export_all(&cfg).expect("export BuildingCategory");
}
