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

use ts_rs::TS;

/// One row of the building list sent by both hosts (`SimHost::buildings_json`
/// on the WASM path, `TickEvent::buildings` on the Tauri path).
#[derive(Debug, Clone, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "WireBuilding.ts")]
pub struct WireBuilding {
    pub id: u32,
    /// `BuildingKind as u8` — decode with `BUILDING_KIND_BY_U8` in TS.
    pub kind: u8,
    pub origin_x: u32,
    pub origin_y: u32,
    /// `BuildingStatus as u8` (`#200`) — decode with `BUILDING_STATUS_BY_U8`
    /// in TS. Replaces the client-side power/water-flag reconstruction both
    /// bridges used to run per building.
    pub status: u8,
    /// 0–100; see `city_sim_core::buildings::BuildingInstance::health`.
    pub health: u8,
}

/// One row of the power/water network component list sent by both hosts
/// (`SimHost::power_components_json`/`water_components_json` on the WASM
/// path, `TickEvent::power_components`/`water_components` on the Tauri path).
#[derive(Debug, Clone, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "WireUtilityComponent.ts")]
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
#[derive(Debug, Clone, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "WireEducationStats.ts")]
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
#[derive(Debug, Clone, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "WireEducationSeatsUsed.ts")]
pub struct WireEducationSeatsUsed {
    pub building_id: u32,
    pub used: f32,
}

/// One row of the rolling 200-day budget history sent by both hosts
/// (`SimHost::budget_history_json` on the WASM path, `TickEvent::budget_history`
/// on the Tauri path) — see `city_sim_core::state::BudgetHistoryEntry` (`#229`).
#[derive(Debug, Clone, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "WireBudgetHistoryEntry.ts")]
pub struct WireBudgetHistoryEntry {
    pub day: u32,
    pub revenue: f32,
    pub expenses: f32,
    pub net: f32,
}

/// Full headline + breakdown budget snapshot sent by both hosts
/// (`SimHost`'s individual `budget_*` getters on the WASM path, assembled
/// into `SimStats` by `wasmSim.worker.ts`; `TickEvent::budget` on the Tauri
/// path, which had none of this before — see `#252`'s follow-up). Mirrors
/// `city_sim_core::state::BudgetStats` field-for-field.
#[derive(Debug, Clone, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "WireBudgetStats.ts")]
pub struct WireBudgetStats {
    pub revenue: f32,
    pub expenses: f32,
    pub net: f32,
    pub net_per_day: f32,
    pub net_per_month: f32,
    pub revenue_base: f32,
    pub revenue_pop: f32,
    pub revenue_commercial: f32,
    pub revenue_industrial: f32,
    pub revenue_tourism: f32,
    pub expenses_transport: f32,
    pub expenses_buildings: f32,
    pub expenses_policies: f32,
    pub maint_power: f32,
    pub maint_civic: f32,
    pub maint_zones: f32,
    pub maint_roads: f32,
    pub maint_rail: f32,
    pub maint_power_lines: f32,
    pub maint_pipes: f32,
    pub maint_power_hydro: f32,
    pub maint_power_coal: f32,
    pub maint_power_wind: f32,
    pub maint_power_solar: f32,
    pub maint_civic_park: f32,
    pub maint_civic_pump: f32,
    pub maint_civic_tower: f32,
    pub maint_civic_school: f32,
    pub maint_zones_res: f32,
    pub maint_zones_com: f32,
    pub maint_zones_ind: f32,
}

/// Per-category wilderness eco totals sent by both hosts — see
/// `city_sim_core::wilderness::WildernessBreakdown`, which this mirrors
/// field-for-field. The WASM path already exposed these via individual
/// `wilderness_*` getters; `TickEvent` did not (`#252`'s follow-up) — the
/// desktop wilderness tooltip stayed zeroed forever without it.
#[derive(Debug, Clone, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "WireWildernessBreakdown.ts")]
pub struct WireWildernessBreakdown {
    pub forests: f32,
    pub parks: f32,
    pub open_land: f32,
    pub water_edge: f32,
    pub patch: f32,
    pub fragmentation: f32,
    pub zones: f32,
    pub industry: f32,
    pub transport: f32,
    pub power: f32,
    pub civic: f32,
}

/// City-wide labour aggregates sent by both hosts — see
/// `city_sim_core::demand::LabourStats`, which this mirrors field-for-field.
/// Replaces the TS-side `computeLabourStats.ts` recompute (including its
/// hard-coded 0.55 worker-share constant) — see `#200`'s wire-adoption
/// follow-up.
#[derive(Debug, Clone, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "WireLabourStats.ts")]
pub struct WireLabourStats {
    pub population: f32,
    pub res_capacity: f32,
    pub job_capacity: f32,
    pub workers: f32,
    pub employed: f32,
    pub unemployed: f32,
    pub unemployment_rate: f32,
    pub vacancy_rate: f32,
}

/// One zone class's full demand derivation — every intermediate value
/// `city_sim_core::demand::compute_demand` already computes, not just the
/// final clamped percentage. Mirrors `DemandComputation` in
/// `city_sim_core::demand`, which itself mirrors the shape the TS shadow
/// model (`app/src/game/demand.ts`, deleted) used to return locally.
#[derive(Debug, Clone, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "WireDemandClassBreakdown.ts")]
pub struct WireDemandClassBreakdown {
    pub base: f32,
    pub fill_fraction: f32,
    pub fill_term: f32,
    pub workforce_term: f32,
    pub labour_term: f32,
    pub pending_zones: f32,
    pub pending_penalty_raw: f32,
    pub pending_penalty_capped: f32,
    pub pending_penalty_applied: f32,
    pub pressure_relief: f32,
    pub utility_penalty: f32,
    pub demand_before_utilities: f32,
    pub floor_applied: bool,
    pub seeded: bool,
    pub value: f32,
}

/// Per-class demand breakdown for all three zone classes — see
/// `WireDemandClassBreakdown`.
#[derive(Debug, Clone, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "WireDemandBreakdown.ts")]
pub struct WireDemandBreakdown {
    pub residential: WireDemandClassBreakdown,
    pub commercial: WireDemandClassBreakdown,
    pub industrial: WireDemandClassBreakdown,
}
