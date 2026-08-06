// wire_types.rs — wire-shape structs shared by the WASM and Tauri sim hosts.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

//! Serde structs both the WASM host (`city-sim-wasm`, serialised to a JSON
//! string) and the Tauri host (`tauri-plugin-city-sim`, serialised natively
//! over an IPC `Channel`) send to the TypeScript client. Hoisted here — out
//! of both host crates, which used to define byte-identical copies — so the
//! two transports cannot silently drift from each other.
//!
//! `#[serde(rename_all = "camelCase")]` throughout since both are consumed
//! directly by TypeScript. The `From` conversions from the engine's own
//! types (`UtilityComponent`, `EducationStats`, `BudgetHistoryEntry`) live in
//! `city-sim-core` (`wire.rs`), not here — `city-sim-protocol` does not
//! depend on `city-sim-core`, so this crate can only own the wire shapes
//! themselves.

/// One row of the building list sent by both hosts (`SimHost::buildings_json`
/// on the WASM path, `TickEvent::buildings` on the Tauri path).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireBuilding {
    pub id: u32,
    /// `TileKind as u8` — decode with `tileKindFromU8` in TS, matching every
    /// other wire use of `TileKind`.
    pub kind: u8,
    pub origin_x: u32,
    pub origin_y: u32,
}

/// One row of the power/water network component list sent by both hosts
/// (`SimHost::power_components_json`/`water_components_json` on the WASM
/// path, `TickEvent::power_components`/`water_components` on the Tauri path).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireUtilityComponent {
    pub id: u16,
    pub produced: f32,
    pub used: f32,
    pub source_count: u16,
    /// `used / produced`, clamped to `[0, 1]` — see `UtilityComponent::utilisation`.
    pub utilisation: f32,
}

/// Wire shape of the city-wide education coverage snapshot sent by both
/// hosts (`SimHost::education_json` on the WASM path, `TickEvent::education`
/// on the Tauri path). Mirrors `city_sim_core::state::EducationStats`
/// field-for-field; kept as a separate type rather than deriving `Serialize`
/// directly on the engine struct, so the engine's own types stay wire-agnostic.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireEducationStats {
    pub elementary_served: f32,
    pub elementary_capacity: f32,
    pub elementary_load: f32,
    pub high_served: f32,
    pub high_capacity: f32,
    pub high_load: f32,
    pub score: f32,
    pub elementary_coverage: f32,
    pub high_coverage: f32,
}

/// One row of the per-school seats-used list sent by both hosts
/// (`SimHost::education_seats_used_json` on the WASM path,
/// `TickEvent::education_seats_used` on the Tauri path).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireEducationSeatsUsed {
    pub building_id: u32,
    pub used: f32,
}

/// One row of the rolling 200-day budget history sent by both hosts
/// (`SimHost::budget_history_json` on the WASM path, `TickEvent::budget_history`
/// on the Tauri path) — see `city_sim_core::state::BudgetHistoryEntry` (`#229`).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireBudgetHistoryEntry {
    pub day: u32,
    pub revenue: f32,
    pub expenses: f32,
    pub net: f32,
}
