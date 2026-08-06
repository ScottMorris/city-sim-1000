// CommandResult, Tool enum, and player-adjustable policy types for the sim protocol.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use ts_rs::TS;

/// All tools the player can apply to the map.
///
/// Mirrors `Tool` in `src/game/toolTypes.ts`. Keep in sync — values are
/// serialised in command logs and must remain stable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[repr(u8)]
pub enum Tool {
    Inspect = 0,
    TerraformRaise = 1,
    TerraformLower = 2,
    Water = 3,
    Tree = 4,
    Road = 5,
    Rail = 6,
    PowerLine = 7,
    HydroPlant = 8,
    CoalPlant = 9,
    WindTurbine = 10,
    SolarFarm = 11,
    WaterPump = 12,
    WaterTower = 13,
    WaterPipe = 14,
    ElementarySchool = 15,
    HighSchool = 16,
    Residential = 17,
    Commercial = 18,
    Industrial = 19,
    Park = 20,
    Bulldoze = 21,
    ParkLarge = 22,
}

/// SimCity-style fiscal policy: per-class tax rates and per-department
/// funding levels, adjustable from the budget screen.
///
/// Tax rates are whole percentages (0–20). 9% is the neutral default — the
/// revenue formulas scale by `rate / 9`, so the default reproduces the
/// pre-policy economy exactly. Funding levels are whole percentages (0–100)
/// with 100 as the fully-funded default; underfunding trims upkeep but has
/// consequences (brownouts, crowded schools, commuter frustration).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "BudgetPolicy.ts")]
pub struct BudgetPolicy {
    pub tax_residential: u8,
    pub tax_commercial: u8,
    pub tax_industrial: u8,
    pub fund_transport: u8,
    pub fund_power: u8,
    pub fund_civic: u8,
}

pub const NEUTRAL_TAX_RATE: u8 = 9;
pub const MAX_TAX_RATE: u8 = 20;
pub const MAX_FUNDING: u8 = 100;

impl Default for BudgetPolicy {
    fn default() -> Self {
        Self {
            tax_residential: NEUTRAL_TAX_RATE,
            tax_commercial: NEUTRAL_TAX_RATE,
            tax_industrial: NEUTRAL_TAX_RATE,
            fund_transport: MAX_FUNDING,
            fund_power: MAX_FUNDING,
            fund_civic: MAX_FUNDING,
        }
    }
}

impl BudgetPolicy {
    /// Clamp all fields into their legal ranges.
    pub fn clamped(self) -> Self {
        Self {
            tax_residential: self.tax_residential.min(MAX_TAX_RATE),
            tax_commercial: self.tax_commercial.min(MAX_TAX_RATE),
            tax_industrial: self.tax_industrial.min(MAX_TAX_RATE),
            fund_transport: self.fund_transport.min(MAX_FUNDING),
            fund_power: self.fund_power.min(MAX_FUNDING),
            fund_civic: self.fund_civic.min(MAX_FUNDING),
        }
    }

    /// Revenue multiplier for a tax rate (`rate / 9`, so 9% → 1.0).
    pub fn tax_multiplier(rate: u8) -> f32 {
        rate as f32 / NEUTRAL_TAX_RATE as f32
    }

    /// Cost/effect multiplier for a funding level (`level / 100`).
    pub fn funding_multiplier(level: u8) -> f32 {
        level as f32 / MAX_FUNDING as f32
    }
}

/// Wilderness programmes toggled from the Bylaws screen (#9).
///
/// `nature_reserve` (unlocks at wilderness ≥ 60): boosts the patch bonus and
/// softens the fragmentation penalty for a flat daily cost.
/// `green_industry`: industrial tiles do reduced wilderness damage in return
/// for a per-zone daily subsidy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "WildernessPolicy.ts")]
pub struct WildernessPolicy {
    pub nature_reserve: bool,
    pub green_industry: bool,
}

/// City-wide lighting standard (Bylaws screen). A named enum rather than a
/// bare string so an invalid id can never decode — mirrors the `LightingPolicy`
/// re-export in `app/src/game/bylaws.ts` one-for-one via the `ts-rs` export.
///
/// `Mixed` is the neutral default: both multipliers below are exactly `1.0`,
/// so an unset bylaw reproduces the pre-bylaw numbers bit-for-bit — the same
/// contract `BudgetPolicy::default()`/`WildernessPolicy::default()` keep.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "LightingPolicy.ts")]
pub enum LightingPolicy {
    /// Blend of LED retrofits and heritage lamps — the neutral baseline.
    #[default]
    Mixed,
    /// LED-first rollout: trims civic/zone power draw and upkeep.
    Efficient,
    /// Nostalgic lamps: more power and upkeep, more ambience.
    CarbonArc,
}

impl LightingPolicy {
    /// City-wide multiplier on civic + zone building power draw (MW).
    ///
    /// Applied in `city_sim_core::sim::Sim::compute_utility_use`, and only to
    /// civic/zone buildings' consumption — never to power *production*
    /// (`utilities::recompute_utility_network`'s funding-scaled supply side)
    /// and never to a power plant's own draw (power plants don't have any).
    pub fn power_use_multiplier(self) -> f32 {
        match self {
            LightingPolicy::Mixed => 1.0,
            LightingPolicy::Efficient => 0.82,
            LightingPolicy::CarbonArc => 1.18,
        }
    }

    /// City-wide multiplier on civic + zone building maintenance ($/day).
    ///
    /// Applied in `city_sim_core::economy::compute_daily_budget`, alongside
    /// — not instead of — the department funding multiplier.
    pub fn maintenance_multiplier(self) -> f32 {
        match self {
            LightingPolicy::Mixed => 1.0,
            LightingPolicy::Efficient => 0.9,
            LightingPolicy::CarbonArc => 1.05,
        }
    }
}

/// Every player-adjustable policy, grouped under one roof.
///
/// New policy families nest here as additional fields rather than as new
/// top-level state or new wire commands. Every field carries
/// `#[serde(default)]` so older payloads decode cleanly after a policy is
/// added. Policies are deliberately *not* undoable — undo applies to tools;
/// the live `Policies` value is carried across every history restore.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "Policies.ts")]
pub struct Policies {
    /// Tax rates and department funding levels (budget screen).
    #[serde(default)]
    pub budget: BudgetPolicy,
    /// Wilderness programmes (Bylaws screen).
    #[serde(default)]
    pub wilderness: WildernessPolicy,
    /// City-wide lighting standard (Bylaws screen).
    #[serde(default)]
    pub lighting: LightingPolicy,
}

impl Policies {
    /// Clamp every family into its legal ranges.
    pub fn clamped(self) -> Self {
        Self {
            budget: self.budget.clamped(),
            wilderness: self.wilderness,
            lighting: self.lighting,
        }
    }
}

/// Which layer of the tile a layer-scoped tool (currently just
/// `Tool::Bulldoze`) acts on — filled from the player's active view.
///
/// Deliberately distinct from `Stratum` in `city-sim-core`'s `occupants.rs`
/// (`Underground | Surface | Overhead`, tile-internal): the surface *view*
/// maps to two tile strata — `Surface` and `Overhead` — at once. `Surface` is
/// the default so command logs recorded before this field existed, and any
/// command that doesn't care about layers, decode unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[repr(u8)]
pub enum ViewStratum {
    #[default]
    Surface = 0,
    Underground = 1,
}

impl From<u8> for ViewStratum {
    /// Decodes the `stratum_idx` byte the WASM and Tauri bridges pass across
    /// their FFI/IPC boundary (mirroring `Tool`'s discriminant convention).
    /// Infallible rather than `TryFrom` — any value but `1` is `Surface`,
    /// so an absent or unrecognised stratum always acts on the surface.
    fn from(v: u8) -> Self {
        if v == ViewStratum::Underground as u8 {
            ViewStratum::Underground
        } else {
            ViewStratum::Surface
        }
    }
}

/// Result returned synchronously for `ApplyTool` commands.
///
/// `stroke_id` correlates this result back to the `ApplyTool` send that
/// produced it — the drag-paint stroke id the caller already supplied. Both
/// transports stamp it on at their command boundary (`SimHost::apply_tool`'s
/// caller in the WASM worker; the Tauri `apply_tool` command) rather than
/// inside `city_sim_core::commands::apply_tool` itself, which has no
/// `stroke_id` parameter — every internal `CommandResult::ok()`/`fail()`
/// call site is unaffected. Replaces `mcpBridge.ts`'s blind FIFO result
/// queue, which mismatched results under Tauri's unordered IPC arrival and
/// any interleaving with a human player's own `ApplyTool` sends.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "CommandResult.ts")]
pub struct CommandResult {
    pub success: bool,
    pub message: Option<String>,
    #[serde(default)]
    pub stroke_id: u32,
}

impl CommandResult {
    pub fn ok() -> Self {
        Self {
            success: true,
            message: None,
            stroke_id: 0,
        }
    }
    pub fn fail(msg: impl Into<String>) -> Self {
        Self {
            success: false,
            message: Some(msg.into()),
            stroke_id: 0,
        }
    }
    /// Stamp the correlation id on at the transport boundary — see the
    /// struct doc comment.
    pub fn with_stroke_id(mut self, stroke_id: u32) -> Self {
        self.stroke_id = stroke_id;
        self
    }
}

impl TryFrom<u8> for Tool {
    type Error = ();
    fn try_from(v: u8) -> Result<Self, ()> {
        if v <= Tool::ParkLarge as u8 {
            // SAFETY: Tool is #[repr(u8)] with contiguous discriminants 0..=22.
            Ok(unsafe { std::mem::transmute::<u8, Tool>(v) })
        } else {
            Err(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use postcard::{from_bytes, to_allocvec};

    #[test]
    fn tool_try_from_u8_roundtrips() {
        for v in 0u8..=22 {
            let tool = Tool::try_from(v).expect("valid discriminant");
            assert_eq!(tool as u8, v);
        }
        assert!(Tool::try_from(23).is_err());
        assert!(Tool::try_from(255).is_err());
    }

    #[test]
    fn view_stratum_defaults_to_surface() {
        // `From<u8>` treats every byte but `1` as `Surface`, and
        // `ViewStratum::default()` must agree — a tool applied without an
        // explicit stratum acts on the surface, never underground.
        assert_eq!(ViewStratum::default(), ViewStratum::Surface);
    }

    #[test]
    fn view_stratum_from_u8() {
        // Only `wasm/src/lib.rs` calls this decoder (the FFI boundary for
        // `stratum_idx`), so it needs its own direct test to be covered by
        // `cargo test --workspace`.
        assert_eq!(ViewStratum::from(0u8), ViewStratum::Surface);
        assert_eq!(ViewStratum::from(1u8), ViewStratum::Underground);
        assert_eq!(ViewStratum::from(2u8), ViewStratum::Surface);
        assert_eq!(ViewStratum::from(255u8), ViewStratum::Surface);
    }

    #[test]
    fn policies_round_trip_postcard() {
        let policies = Policies {
            budget: BudgetPolicy {
                tax_residential: 12,
                tax_commercial: 7,
                tax_industrial: 20,
                fund_transport: 80,
                fund_power: 50,
                fund_civic: 100,
            },
            wilderness: WildernessPolicy {
                nature_reserve: true,
                green_industry: false,
            },
            lighting: LightingPolicy::CarbonArc,
        };
        let bytes = to_allocvec(&policies).unwrap();
        let back: Policies = from_bytes(&bytes).unwrap();
        assert_eq!(back, policies);
    }

    #[test]
    fn default_policies_are_neutral() {
        let p = Policies::default();
        assert_eq!(p.budget, BudgetPolicy::default());
        assert_eq!(p.wilderness, WildernessPolicy::default());
        assert_eq!(p.lighting, LightingPolicy::Mixed);
    }

    #[test]
    fn policies_clamp_delegates_to_families() {
        let p = Policies {
            budget: BudgetPolicy {
                tax_residential: 99,
                ..BudgetPolicy::default()
            },
            wilderness: WildernessPolicy::default(),
            lighting: LightingPolicy::Efficient,
        }
        .clamped();
        assert_eq!(p.budget.tax_residential, MAX_TAX_RATE);
        // `lighting` has no illegal range to clamp — `clamped()` must still
        // carry it through untouched rather than silently resetting it.
        assert_eq!(p.lighting, LightingPolicy::Efficient);
    }

    #[test]
    fn default_lighting_policy_is_mixed_and_neutral() {
        let p = LightingPolicy::default();
        assert_eq!(p, LightingPolicy::Mixed);
        assert_eq!(p.power_use_multiplier(), 1.0);
        assert_eq!(p.maintenance_multiplier(), 1.0);
    }

    #[test]
    fn non_default_lighting_policies_are_not_neutral() {
        // Pins the exact multipliers against `app/src/game/bylaws.ts`'s
        // `LIGHTING_POLICIES` display table — the two must agree, since the
        // TS table exists only to preview what these values will do.
        assert_eq!(LightingPolicy::Efficient.power_use_multiplier(), 0.82);
        assert_eq!(LightingPolicy::Efficient.maintenance_multiplier(), 0.9);
        assert_eq!(LightingPolicy::CarbonArc.power_use_multiplier(), 1.18);
        assert_eq!(LightingPolicy::CarbonArc.maintenance_multiplier(), 1.05);
    }

    #[test]
    fn lighting_policy_round_trips_postcard() {
        for policy in [
            LightingPolicy::Mixed,
            LightingPolicy::Efficient,
            LightingPolicy::CarbonArc,
        ] {
            let bytes = to_allocvec(&policy).unwrap();
            let back: LightingPolicy = from_bytes(&bytes).unwrap();
            assert_eq!(back, policy);
        }
    }

    #[test]
    fn budget_policy_clamps_out_of_range() {
        let policy = BudgetPolicy {
            tax_residential: 99,
            tax_commercial: 0,
            tax_industrial: 21,
            fund_transport: 255,
            fund_power: 101,
            fund_civic: 0,
        }
        .clamped();
        assert_eq!(policy.tax_residential, MAX_TAX_RATE);
        assert_eq!(policy.tax_commercial, 0);
        assert_eq!(policy.tax_industrial, MAX_TAX_RATE);
        assert_eq!(policy.fund_transport, MAX_FUNDING);
        assert_eq!(policy.fund_power, MAX_FUNDING);
        assert_eq!(policy.fund_civic, 0);
    }

    #[test]
    fn default_wilderness_policy_is_all_off() {
        let p = WildernessPolicy::default();
        assert!(!p.nature_reserve);
        assert!(!p.green_industry);
    }

    #[test]
    fn default_policy_is_neutral() {
        let p = BudgetPolicy::default();
        assert_eq!(BudgetPolicy::tax_multiplier(p.tax_residential), 1.0);
        assert_eq!(BudgetPolicy::funding_multiplier(p.fund_power), 1.0);
    }

    #[test]
    fn command_result_round_trips() {
        let r = CommandResult::fail("Not enough funds");
        let bytes = to_allocvec(&r).unwrap();
        let back: CommandResult = from_bytes(&bytes).unwrap();
        assert!(!back.success);
        assert_eq!(back.message.as_deref(), Some("Not enough funds"));
    }
}
