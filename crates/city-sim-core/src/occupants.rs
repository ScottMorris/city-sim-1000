// occupants.rs — stratum/occupant model: the derived view of what stands on a tile.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

//! The occupant model, step 1 of the strangler migration tracked in #177.
//!
//! Today a tile records its infrastructure in two places — the single-valued
//! `Tile::kind` and the structural flags `FLAG_ROAD_UNDERLAY`,
//! `FLAG_RAIL_UNDERLAY`, `FLAG_POWER_OVERLAY` — so a road carrying a hydro
//! line has *two* legal spellings depending on build order. Every consumer
//! that reads `kind` and forgets the flags silently under-counts; that same
//! bug has now been found in `economy.rs`, `wilderness.rs`,
//! `tileRenderUtils.ts` and `commands.rs`.
//!
//! This module does not change how a tile is stored. `kind` and the flags stay
//! authoritative. What it adds is a *derived* view — an `OccupantSet` bitset
//! answering "what is physically here?" — so that consumers can be converted
//! one at a time (step 2) before storage is flipped (step 3).
//!
//! Three strata, stacked the way the world is:
//!
//! | stratum     | occupants                                  | default |
//! | ----------- | ------------------------------------------ | ------- |
//! | underground | Pipe, Subway*, Fibre*                      | coexist |
//! | surface     | Road, Rail, Zone{R,C,I}, Structure         | conflict |
//! | overhead    | PowerLine, Trees                           | conflict |
//!
//! (* reserved — no tool, no `TileKind`, no flag exists for them yet. The bits
//! are claimed now so the underground mask stays stable when step 3 persists
//! the set.)
//!
//! Terrain (`Land` | `Water`) is a separate concept from occupants: it
//! contributes no occupant bit, so a bare land tile and a water tile both have
//! an empty set.
//!
//! Note that terrain is *not* yet what the design note describes. `docs/tile-model.md`
//! wants terrain to be the thing the bulldozer restores a tile to and the thing
//! that survives terraforming; today neither holds. `Tool::TerraformRaise` /
//! `TerraformLower` overwrite `kind` with `Land` / `Water` — terraforming is
//! precisely the operation that *changes* terrain — and `bulldoze` always
//! writes `Land`, never `Water`. `Tile::terrain()` reads today's storage
//! faithfully; making it durable is step 3's job.
//!
//! **Precedence disappears.** `commands.rs` runs a zone > hydro > road/rail
//! precedence purely to decide who owns the contested `kind` slot. The
//! occupant set is a union, so it never asks who won.
//!
//! Only the three occupants that *have* a fallback flag — Road, Rail,
//! PowerLine — have two spellings to reconcile, and for those the predicate is
//! `kind == X || flag`. The other five (`Pipe`, the three zones, `Structure`,
//! `Trees`) have exactly one spelling each and read `kind`/`underground`
//! directly, because no flag was ever minted for them. What matters is that
//! wherever two spellings exist they collapse to the same set — that property
//! is the whole foundation of the migration, and `both_recordings_agree` below
//! proves it by exhaustive enumeration (not fuzzing: a fixed 32-combination
//! space with pinned counts, over road/rail/line/zone only).

use crate::economy::{MAINT_POWER_LINE, MAINT_RAIL, MAINT_ROAD, MAINT_WATER_PIPE};
use crate::state::{Tile, FLAG_POWER_OVERLAY, FLAG_RAIL_UNDERLAY, FLAG_ROAD_UNDERLAY};
use crate::wilderness::WildernessTunables;
use city_sim_protocol::commands::BudgetPolicy;
use city_sim_protocol::tile_kind::TileKind;

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/// A physical layer of the map. Depth/height ordering is the discriminant
/// order, which is also the draw order: underground → surface → overhead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Stratum {
    Underground = 0,
    Surface = 1,
    Overhead = 2,
}

impl Stratum {
    /// Every stratum, in depth order. Exists so an exhaustive walk over the
    /// strata is a loop rather than three hand-written lines that a fourth
    /// stratum would silently leave behind.
    pub const ALL: [Stratum; 3] = [Stratum::Underground, Stratum::Surface, Stratum::Overhead];
}

/// One thing that can occupy a tile. A flat tag — anything with per-instance
/// data (which structure, which building) lives on the `BuildingInstance` that
/// `Tile::building_id` points at.
///
/// Discriminants are the bit positions in an [`OccupantSet`] and are grouped by
/// stratum so [`stratum_mask`] is a compile-time constant and a per-stratum
/// query is a single AND. **Never reorder them** — step 3 persists this set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Occupant {
    // --- Underground: bits 0–2 ---
    Pipe = 0,
    /// Reserved. Derives to `false`; no tool or `TileKind` exists.
    Subway = 1,
    /// Reserved. Derives to `false`; no tool or `TileKind` exists.
    Fibre = 2,
    // --- Surface: bits 3–8 ---
    Road = 3,
    Rail = 4,
    ZoneResidential = 5,
    ZoneCommercial = 6,
    ZoneIndustrial = 7,
    Structure = 8,
    // --- Overhead: bits 9–10 ---
    PowerLine = 9,
    Trees = 10,
}

/// Number of occupants defined. Bits 11–15 of an [`OccupantSet`] are spare.
pub const OCCUPANT_COUNT: usize = 11;

/// Every occupant in bit order — the iteration order of [`iter_set`].
pub const ALL_OCCUPANTS: [Occupant; OCCUPANT_COUNT] = [
    Occupant::Pipe,
    Occupant::Subway,
    Occupant::Fibre,
    Occupant::Road,
    Occupant::Rail,
    Occupant::ZoneResidential,
    Occupant::ZoneCommercial,
    Occupant::ZoneIndustrial,
    Occupant::Structure,
    Occupant::PowerLine,
    Occupant::Trees,
];

/// Bitset of [`Occupant`]s, one bit per occupant.
pub type OccupantSet = u16;

/// What the ground itself is — `Land` or `Water` — as distinct from anything
/// occupying it.
///
/// In the target model of `docs/tile-model.md` terrain is durable: it is what
/// bulldoze restores a tile to and it survives terraforming. Today it is
/// neither, because it shares the `kind` slot with everything else —
/// `TerraformRaise`/`TerraformLower` overwrite it and `bulldoze` always writes
/// `Land`. This accessor reports today's storage; step 3 is what makes it durable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Terrain {
    Land = 0,
    Water = 1,
}

/// A network an occupant may conduct.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Network {
    Power = 0,
    Water = 1,
    Traffic = 2,
}

impl Network {
    /// Every network. Same purpose as [`Stratum::ALL`]: a fifth network is a
    /// table row plus a loop iteration, never a forgotten branch.
    pub const ALL: [Network; 3] = [Network::Power, Network::Water, Network::Traffic];
}

/// Bitset of [`Network`]s.
pub type NetworkSet = u8;

pub const NET_NONE: NetworkSet = 0;
pub const NET_POWER: NetworkSet = 1 << (Network::Power as u8);
pub const NET_WATER: NetworkSet = 1 << (Network::Water as u8);
pub const NET_TRAFFIC: NetworkSet = 1 << (Network::Traffic as u8);

/// Which line of the wilderness HUD breakdown an eco contribution lands on.
/// Mirrors the `match kind` in `wilderness.rs` — one variant per field of
/// `WildernessBreakdown` that the per-tile base value can reach.
///
/// Three different things produce a category, because in `wilderness.rs` three
/// different things produce eco: the terrain ([`Tile::terrain_category`], the
/// only source of [`EcoCategory::OpenLand`]), an occupant tag
/// ([`occupant_category`]) and a structure's kind ([`structure_category`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EcoCategory {
    Forests,
    Parks,
    /// Bare, unbuilt land. Produced by [`Tile::terrain_category`] only — no
    /// *occupant* is open land, since the credit is exactly what having an
    /// occupant costs you.
    OpenLand,
    Zones,
    Industry,
    Transport,
    Power,
    Civic,
    /// Contributes to no breakdown line: the reserved occupants and buried
    /// pipes. **Not** `Structure` — a structure has no category of its own,
    /// see [`occupant_category`].
    Neutral,
}

impl EcoCategory {
    /// Every breakdown line. Used by `every_eco_category_is_produced` to prove
    /// no variant is decorative — `OpenLand` was, until `terrain_category`
    /// existed to produce it.
    pub const ALL: [EcoCategory; 9] = [
        EcoCategory::Forests,
        EcoCategory::Parks,
        EcoCategory::OpenLand,
        EcoCategory::Zones,
        EcoCategory::Industry,
        EcoCategory::Transport,
        EcoCategory::Power,
        EcoCategory::Civic,
        EcoCategory::Neutral,
    ];
}

/// The budget department whose funding level scales an occupant's upkeep.
///
/// `compute_daily_budget` scales road and rail by `fund_transport`, hydro lines
/// by `fund_power` and water pipes by `fund_civic`. Upkeep is therefore not a
/// number, it is a number *and* a department: at 50% transport funding a road
/// costs 0.05, and any accessor that returns 0.10 regardless is wrong for every
/// funding level but the default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum FundingDept {
    Transport = 0,
    Power = 1,
    Civic = 2,
    /// Never scaled by any funding slider. Carried by occupants whose tile
    /// upkeep is `0.0` — their real bill arrives through a `BuildingInstance`
    /// (zone maintenance is private-sector and unfunded by design).
    Unfunded = 3,
}

impl FundingDept {
    /// The multiplier this department applies under `policy`. Identical to the
    /// three `BudgetPolicy::funding_multiplier` calls in `compute_daily_budget`.
    #[inline]
    pub fn multiplier(self, policy: &BudgetPolicy) -> f32 {
        match self {
            FundingDept::Transport => BudgetPolicy::funding_multiplier(policy.fund_transport),
            FundingDept::Power => BudgetPolicy::funding_multiplier(policy.fund_power),
            FundingDept::Civic => BudgetPolicy::funding_multiplier(policy.fund_civic),
            FundingDept::Unfunded => 1.0,
        }
    }
}

/// Which `BudgetStats` field an occupant's upkeep is reported on.
///
/// The budget screen shows roads, rail, hydro lines and pipes as four separate
/// lines, so a step-2 conversion has to rebuild the breakdown, not just the
/// total. Discriminants are indices into the array returned by
/// [`set_upkeep_by_line`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum LedgerLine {
    /// `BudgetStats::maint_roads`.
    Roads = 0,
    /// `BudgetStats::maint_rail`.
    Rail = 1,
    /// `BudgetStats::maint_power_lines`.
    PowerLines = 2,
    /// `BudgetStats::maint_pipes`.
    Pipes = 3,
    /// Reported on no per-tile line — see [`FundingDept::Unfunded`].
    Untracked = 4,
}

/// Number of ledger lines, including `Untracked`.
pub const LEDGER_LINE_COUNT: usize = 5;

/// Every ledger line, in discriminant order — the index order of
/// [`set_upkeep_by_line`].
pub const ALL_LEDGER_LINES: [LedgerLine; LEDGER_LINE_COUNT] = [
    LedgerLine::Roads,
    LedgerLine::Rail,
    LedgerLine::PowerLines,
    LedgerLine::Pipes,
    LedgerLine::Untracked,
];

/// Where an occupant's eco value comes from.
///
/// A plain `Option<TileKind>` was not enough: it collapsed "scores nothing"
/// and "cannot be answered from the tag alone" into one `None`, and the
/// accessor turned both into `0.0`. That silently flattened the ten structure
/// kinds — a coal plant (−8.0) and a large park (+4.0) scoring the same.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EcoSource {
    /// Scores `WildernessTunables::base_eco[kind]`.
    ///
    /// The indirection through a `TileKind` rather than a literal is
    /// load-bearing: the Green Industry programme rewrites
    /// `base_eco[Industrial]` at runtime, and a static number here would
    /// disable the policy with no test noticing.
    Kind(TileKind),
    /// Scores nothing, under any tunables — the reserved occupants, which have
    /// no `TileKind` at all.
    Zero,
    /// Not answerable from the occupant tag: resolve with [`structure_eco`]
    /// against the tile's `structure_kind()`.
    PerStructureKind,
}

// ---------------------------------------------------------------------------
// Bit helpers
// ---------------------------------------------------------------------------

/// The single-bit mask for one occupant.
#[inline]
pub const fn occupant_bit(o: Occupant) -> OccupantSet {
    1 << (o as u8)
}

const B_PIPE: OccupantSet = occupant_bit(Occupant::Pipe);
const B_SUBWAY: OccupantSet = occupant_bit(Occupant::Subway);
const B_FIBRE: OccupantSet = occupant_bit(Occupant::Fibre);
const B_ROAD: OccupantSet = occupant_bit(Occupant::Road);
const B_RAIL: OccupantSet = occupant_bit(Occupant::Rail);
const B_ZONE_R: OccupantSet = occupant_bit(Occupant::ZoneResidential);
const B_ZONE_C: OccupantSet = occupant_bit(Occupant::ZoneCommercial);
const B_ZONE_I: OccupantSet = occupant_bit(Occupant::ZoneIndustrial);
const B_STRUCTURE: OccupantSet = occupant_bit(Occupant::Structure);
const B_POWER_LINE: OccupantSet = occupant_bit(Occupant::PowerLine);
const B_TREES: OccupantSet = occupant_bit(Occupant::Trees);

/// Bits 0–2. Reserved headroom: none — Subway and Fibre already claim the
/// spare slots.
pub const UNDERGROUND_MASK: OccupantSet = B_PIPE | B_SUBWAY | B_FIBRE;
/// Bits 3–8.
pub const SURFACE_MASK: OccupantSet =
    B_ROAD | B_RAIL | B_ZONE_R | B_ZONE_C | B_ZONE_I | B_STRUCTURE;
/// Bits 9–10.
pub const OVERHEAD_MASK: OccupantSet = B_POWER_LINE | B_TREES;
/// Everything the player can see on the map.
///
/// Not the same as "what the bulldozer clears": `bulldoze` also clears
/// `underground`, and clears it *first*, so on a road carrying a pipe the first
/// click removes nothing visible. Use this mask for what is drawn, not for what
/// a tool reaches.
pub const VISIBLE_MASK: OccupantSet = SURFACE_MASK | OVERHEAD_MASK;
/// The three zone tags. Reserved for step 2 — [`Tile::zone_occupant`] is the
/// accessor to reach for today, and it is what the tests pin.
pub const ZONE_MASK: OccupantSet = B_ZONE_R | B_ZONE_C | B_ZONE_I;

/// All occupant bits currently in use. Bits 11–15 are spare — **note** that
/// inserting a new occupant into a full stratum shifts every bit above it, and
/// those bits become persisted data in step 3. Widen a stratum's range before
/// it is persisted, not after.
pub const ALL_MASK: OccupantSet = UNDERGROUND_MASK | SURFACE_MASK | OVERHEAD_MASK;

/// Branch-free "set this bit when the predicate holds".
#[inline]
const fn bit_when(present: bool, o: Occupant) -> OccupantSet {
    (present as OccupantSet) << (o as u8)
}

// ---------------------------------------------------------------------------
// The occupant table
// ---------------------------------------------------------------------------

/// Static properties of one occupant. This is the table that was previously
/// smeared across hand-written guards in each tool handler.
#[derive(Debug, Clone, Copy)]
pub struct OccupantDef {
    pub occupant: Occupant,
    pub stratum: Stratum,
    /// Where this occupant's wilderness eco value comes from. See [`EcoSource`]
    /// — in particular why `Structure` is `PerStructureKind` and not a number.
    pub eco: EcoSource,
    /// Per-day upkeep charged for the occupant's presence on the tile, **before
    /// the funding multiplier of [`Self::funding`] is applied**. `0.0` for
    /// anything billed off a `BuildingInstance` instead.
    ///
    /// Never sum this field across departments and call the result a bill:
    /// `compute_daily_budget` scales each line separately, so a bare sum is the
    /// true expense only at 100% funding everywhere. Use [`set_upkeep_funded`].
    pub upkeep_unfunded: f32,
    /// Budget department whose funding slider scales [`Self::upkeep_unfunded`].
    pub funding: FundingDept,
    /// `BudgetStats` field this occupant's upkeep is reported on, so a step-2
    /// conversion can rebuild the four-line breakdown and not just the total.
    pub ledger: LedgerLine,
    /// Networks this occupant conducts by its own nature. `Structure` is
    /// `NET_NONE` because a structure conducts through its *development*
    /// (`building_id` / `power_plant_mw`), not through the tag — a ghost
    /// structure left behind by `remove_building` conducts nothing.
    pub conducts: NetworkSet,
    /// The materialised, symmetric set of occupants this one cannot share a
    /// tile with. Derived from the stratum default plus [`COMPAT_EXCEPTIONS`]
    /// and pinned against that derivation by
    /// `compatibility_table_is_derived_from_defaults_plus_exceptions`.
    pub conflicts: OccupantSet,
    /// Wilderness breakdown line for this occupant's eco contribution, or
    /// `None` when the tag cannot answer — `Structure` again, whose category
    /// is per kind ([`structure_category`]: a coal plant is `Power`, a park is
    /// `Parks`). A flat `Neutral` here would route every structure's eco to no
    /// line at all.
    pub category: Option<EcoCategory>,
    /// Participates in the wilderness patch bonus, water-edge bonus and
    /// fragmentation penalty (`is_strong_nature` in `wilderness.rs`), or `None`
    /// when the tag cannot answer. `Structure` is `None` because parks *are*
    /// strong nature and arrive as `Structure`; that half is resolved per
    /// structure kind by [`structure_is_strong_nature`].
    pub strong_nature: Option<bool>,
}

/// Indexed by `Occupant as usize`.
pub static OCCUPANT_DEFS: [OccupantDef; OCCUPANT_COUNT] = [
    // --- Underground ---
    OccupantDef {
        occupant: Occupant::Pipe,
        stratum: Stratum::Underground,
        // Nature above a buried pipe is still nature: base_eco[WaterPipe] = 0.0.
        eco: EcoSource::Kind(TileKind::WaterPipe),
        upkeep_unfunded: MAINT_WATER_PIPE,
        funding: FundingDept::Civic, // economy.rs: `maint_pipes *= fund_civic`
        ledger: LedgerLine::Pipes,
        conducts: NET_WATER,
        conflicts: 0,
        category: Some(EcoCategory::Neutral),
        strong_nature: Some(false),
    },
    OccupantDef {
        occupant: Occupant::Subway,
        stratum: Stratum::Underground,
        eco: EcoSource::Zero,
        upkeep_unfunded: 0.0,
        funding: FundingDept::Unfunded,
        ledger: LedgerLine::Untracked,
        conducts: NET_NONE,
        conflicts: 0,
        category: Some(EcoCategory::Neutral),
        strong_nature: Some(false),
    },
    OccupantDef {
        occupant: Occupant::Fibre,
        stratum: Stratum::Underground,
        eco: EcoSource::Zero,
        upkeep_unfunded: 0.0,
        funding: FundingDept::Unfunded,
        ledger: LedgerLine::Untracked,
        conducts: NET_NONE,
        conflicts: 0,
        category: Some(EcoCategory::Neutral),
        strong_nature: Some(false),
    },
    // --- Surface ---
    OccupantDef {
        occupant: Occupant::Road,
        stratum: Stratum::Surface,
        eco: EcoSource::Kind(TileKind::Road),
        upkeep_unfunded: MAINT_ROAD,
        funding: FundingDept::Transport, // `maint_roads *= fund_transport`
        ledger: LedgerLine::Roads,
        conducts: NET_POWER | NET_WATER | NET_TRAFFIC,
        conflicts: SURFACE_MASK & !(B_ROAD | B_RAIL),
        category: Some(EcoCategory::Transport),
        strong_nature: Some(false),
    },
    OccupantDef {
        occupant: Occupant::Rail,
        stratum: Stratum::Surface,
        eco: EcoSource::Kind(TileKind::Rail),
        upkeep_unfunded: MAINT_RAIL,
        funding: FundingDept::Transport, // `maint_rail *= fund_transport`
        ledger: LedgerLine::Rail,
        // Not traffic: `has_road_access` and the education service BFS both
        // ignore rail, and no transit network exists in the engine yet.
        conducts: NET_POWER | NET_WATER,
        conflicts: SURFACE_MASK & !(B_ROAD | B_RAIL),
        category: Some(EcoCategory::Transport),
        strong_nature: Some(false),
    },
    OccupantDef {
        occupant: Occupant::ZoneResidential,
        stratum: Stratum::Surface,
        eco: EcoSource::Kind(TileKind::Residential),
        // An undeveloped zone tile costs nothing; a developed lot is billed
        // through its BuildingInstance (economy.rs) on the `maint_zones` line,
        // which no funding slider touches — zone upkeep is private-sector.
        upkeep_unfunded: 0.0,
        funding: FundingDept::Unfunded,
        ledger: LedgerLine::Untracked,
        conducts: NET_POWER | NET_WATER,
        conflicts: SURFACE_MASK & !B_ZONE_R,
        category: Some(EcoCategory::Zones),
        strong_nature: Some(false),
    },
    OccupantDef {
        occupant: Occupant::ZoneCommercial,
        stratum: Stratum::Surface,
        eco: EcoSource::Kind(TileKind::Commercial),
        upkeep_unfunded: 0.0,
        funding: FundingDept::Unfunded,
        ledger: LedgerLine::Untracked,
        conducts: NET_POWER | NET_WATER,
        conflicts: SURFACE_MASK & !B_ZONE_C,
        category: Some(EcoCategory::Zones),
        strong_nature: Some(false),
    },
    OccupantDef {
        occupant: Occupant::ZoneIndustrial,
        stratum: Stratum::Surface,
        // Runtime-tunable: Green Industry rewrites base_eco[Industrial].
        eco: EcoSource::Kind(TileKind::Industrial),
        upkeep_unfunded: 0.0,
        funding: FundingDept::Unfunded,
        ledger: LedgerLine::Untracked,
        conducts: NET_POWER | NET_WATER,
        conflicts: SURFACE_MASK & !B_ZONE_I,
        category: Some(EcoCategory::Industry),
        strong_nature: Some(false),
    },
    OccupantDef {
        occupant: Occupant::Structure,
        stratum: Stratum::Surface,
        eco: EcoSource::PerStructureKind,
        // Billed off BuildingInstance::maintenance_per_day, on the power or
        // civic line depending on the template — not on any per-tile line.
        upkeep_unfunded: 0.0,
        funding: FundingDept::Unfunded,
        ledger: LedgerLine::Untracked,
        conducts: NET_NONE, // conducts through `development`, not the tag
        // Cross-stratum exception: a line through a power plant or a school.
        // Only ONE of the two guards enforces it today — `Tool::PowerLine`
        // refuses a tile with a `building_id`, but the converse guard in
        // `place_footprint_building` never asks `has_power_overlay()`, so a
        // structure CAN still be stamped over a live line. See
        // `known_defect_a_structure_is_stamped_over_a_live_hydro_line`.
        conflicts: (SURFACE_MASK & !B_STRUCTURE) | B_POWER_LINE,
        category: None,      // see `structure_category`
        strong_nature: None, // see `structure_is_strong_nature`
    },
    // --- Overhead ---
    OccupantDef {
        occupant: Occupant::PowerLine,
        stratum: Stratum::Overhead,
        eco: EcoSource::Kind(TileKind::PowerLine),
        upkeep_unfunded: MAINT_POWER_LINE,
        funding: FundingDept::Power, // `maint_power_lines *= fund_power`
        ledger: LedgerLine::PowerLines,
        // Power only. A road carrying a line still carries water, but that is
        // the road's doing, not the line's.
        conducts: NET_POWER,
        conflicts: B_TREES | B_STRUCTURE,
        category: Some(EcoCategory::Power),
        strong_nature: Some(false),
    },
    OccupantDef {
        occupant: Occupant::Trees,
        stratum: Stratum::Overhead,
        eco: EcoSource::Kind(TileKind::Tree),
        upkeep_unfunded: 0.0,
        funding: FundingDept::Unfunded,
        ledger: LedgerLine::Untracked,
        conducts: NET_NONE,
        conflicts: B_POWER_LINE,
        category: Some(EcoCategory::Forests),
        strong_nature: Some(true),
    },
];

/// A pair whose compatibility differs from its stratum default.
#[derive(Debug, Clone, Copy)]
pub struct CompatException {
    pub a: Occupant,
    pub b: Occupant,
    /// `true` = coexists despite a conflicting default;
    /// `false` = conflicts despite a coexisting default.
    pub coexist: bool,
    pub why: &'static str,
}

/// The complete exception list. Two entries, one in each direction — the
/// design note's "exactly one exception" counted same-stratum pairs only and
/// missed Structure + PowerLine.
pub static COMPAT_EXCEPTIONS: [CompatException; 2] = [
    CompatException {
        a: Occupant::Road,
        b: Occupant::Rail,
        coexist: true,
        why: "the level crossing — Tool::Road preserves a rail underlay and Tool::Rail preserves a road underlay",
    },
    CompatException {
        a: Occupant::Structure,
        b: Occupant::PowerLine,
        coexist: false,
        why: "cross-stratum, but a line strung through a school or a power plant is not a tile the model admits: Tool::PowerLine refuses a tile that already carries a building. The converse guard is INCOMPLETE today — place_footprint_building rejects kind Road/Rail/PowerLine and both underlays but never asks has_power_overlay(), so any tile whose line lives in that flag rather than in kind takes a structure on top of a live, still-billed line (zone, then string a line; or string a line, then TerraformRaise). This exception therefore states the target rule, not today's reachable set; see known_defect_a_structure_is_stamped_over_a_live_hydro_line, closed by step 2 of #177",
    },
];

// ---------------------------------------------------------------------------
// Free functions over the table
// ---------------------------------------------------------------------------

/// The static definition of one occupant.
#[inline]
pub fn occupant_def(o: Occupant) -> &'static OccupantDef {
    &OCCUPANT_DEFS[o as usize]
}

/// Every bit belonging to one stratum. Compile-time constant, so a
/// per-stratum query is one AND.
#[inline]
pub const fn stratum_mask(s: Stratum) -> OccupantSet {
    match s {
        Stratum::Underground => UNDERGROUND_MASK,
        Stratum::Surface => SURFACE_MASK,
        Stratum::Overhead => OVERHEAD_MASK,
    }
}

/// Whether two occupants of this stratum conflict *by default*.
///
/// The default is per stratum, not global, because the strata differ in
/// whether space is scarce: the ground is contested, depth is free, and canopy
/// versus conductors genuinely fight.
#[inline]
pub const fn stratum_default_is_conflict(s: Stratum) -> bool {
    match s {
        Stratum::Underground => false,
        Stratum::Surface => true,
        Stratum::Overhead => true,
    }
}

/// Iterate the occupants present in a set, in bit order.
pub fn iter_set(set: OccupantSet) -> impl Iterator<Item = Occupant> {
    ALL_OCCUPANTS
        .into_iter()
        .filter(move |&o| set & occupant_bit(o) != 0)
}

/// Whether two occupants may share a tile. Symmetric; an occupant never
/// conflicts with itself (a set holds at most one of each).
#[inline]
pub fn pair_conflicts(a: Occupant, b: Occupant) -> bool {
    a != b && occupant_def(a).conflicts & occupant_bit(b) != 0
}

/// Check a set against the compatibility table.
///
/// **This describes the TARGET model, not the set of tiles today's game can
/// build.** The table says what an occupant set *ought* to be allowed to look
/// like once step 2 has tightened the tool guards; `commands.rs` does not yet
/// enforce it, so an ordinary sequence of clicks can produce a set this
/// function rejects. Two such sequences exist today, both inventoried as
/// known defects and both fixed in step 2 of #177:
///
/// - `Residential` → `PowerLine` → `Park` stamps a structure over a live
///   hydro line, because `place_footprint_building` never asks
///   `has_power_overlay()` — `known_defect_a_structure_is_stamped_over_a_live_hydro_line`.
/// - `PowerLine` → `Tree` plants a canopy through the conductors, because
///   `set_kind` rewrites `kind` and leaves `FLAG_POWER_OVERLAY` set —
///   `known_defect_trees_are_planted_through_a_live_hydro_line`.
///
/// `producible_conflicts_are_inventoried` closes the single-tile state space
/// under `apply_tool` and pins that list at exactly those two, so a third one
/// cannot appear unnoticed.
///
/// **Advisory only.** Never panic on this result — log it, count it, or
/// `debug_assert` it, but let the save load. Saves in the wild already contain
/// violating tiles, and `Tool::TerraformLower` can leave `building_id` set on
/// a tile that has become water besides.
pub fn validate_set(set: OccupantSet) -> Result<(), (Occupant, Occupant)> {
    let present: Vec<Occupant> = iter_set(set).collect();
    for (i, &a) in present.iter().enumerate() {
        for &b in &present[i + 1..] {
            if pair_conflicts(a, b) {
                return Err((a, b));
            }
        }
    }
    Ok(())
}

/// Per-day upkeep for a set, split across the `BudgetStats` lines and **before
/// funding**. Indexed by `LedgerLine as usize`.
///
/// This is the primitive the other two upkeep functions are built from, and
/// the one a step-2 conversion of `compute_daily_budget` wants: that function
/// keeps `maint_roads`, `maint_rail`, `maint_power_lines` and `maint_pipes`
/// apart all the way to the budget screen, and each is scaled by a different
/// slider, so a single total can rebuild neither the breakdown nor the bill.
pub fn set_upkeep_by_line(set: OccupantSet) -> [f32; LEDGER_LINE_COUNT] {
    let mut lines = [0.0_f32; LEDGER_LINE_COUNT];
    for o in iter_set(set) {
        let def = occupant_def(o);
        lines[def.ledger as usize] += def.upkeep_unfunded;
    }
    lines
}

/// Total per-day upkeep for a set at 100% funding in every department — a
/// plain sum of the four independent `if`s in `compute_daily_budget`.
///
/// Equal to the real bill **only** while all three funding sliders sit at
/// `MAX_FUNDING`, which is where `BudgetPolicy::default()` puts them. Under any
/// other policy use [`set_upkeep_funded`].
pub fn set_upkeep_unfunded(set: OccupantSet) -> f32 {
    iter_set(set).map(|o| occupant_def(o).upkeep_unfunded).sum()
}

/// Total per-day upkeep for a set under `policy`, each occupant scaled by its
/// own department's funding multiplier.
///
/// Reproduces the sum of the four per-tile maintenance lines of
/// `compute_daily_budget` after funding is applied. It does **not** include
/// building maintenance (`maint_power` / `maint_civic` / `maint_zones`, billed
/// off `state.buildings`) or wilderness programme costs.
pub fn set_upkeep_funded(set: OccupantSet, policy: &BudgetPolicy) -> f32 {
    iter_set(set)
        .map(|o| {
            let def = occupant_def(o);
            def.upkeep_unfunded * def.funding.multiplier(policy)
        })
        .sum()
}

/// Whether any occupant in the set conducts a network by its own nature.
/// Does **not** account for development — use [`Tile::conducts`] for that.
pub fn set_conducts(set: OccupantSet, network: Network) -> bool {
    let bit = 1 << (network as u8);
    iter_set(set).any(|o| occupant_def(o).conducts & bit != 0)
}

/// Eco value of one occupant, read through the tunables so runtime policy
/// patches (Green Industry) keep working.
///
/// `None` for `Structure` — and only for `Structure` — because the ten
/// structure kinds span +4.0 for a park down to −8.0 for a coal plant. (Four
/// distinct values across ten kinds: −1.0 covers six of them and +4.0 two.)
/// There is no honest number to return, so the caller is made to ask
/// [`structure_eco`] instead of being handed a `0.0` that looks like an answer.
/// The reserved occupants return `Some(0.0)`: they really do score nothing.
pub fn occupant_eco(o: Occupant, t: &WildernessTunables) -> Option<f32> {
    match occupant_def(o).eco {
        EcoSource::Kind(kind) => Some(t.base_eco[kind as usize]),
        EcoSource::Zero => Some(0.0),
        EcoSource::PerStructureKind => None,
    }
}

/// Wilderness breakdown line for one occupant. `None` for `Structure` only —
/// resolve it with [`structure_category`]. Same hole as [`occupant_eco`]:
/// answering `Neutral` would route a coal plant's −8.0 to no line at all.
#[inline]
pub fn occupant_category(o: Occupant) -> Option<EcoCategory> {
    occupant_def(o).category
}

/// Whether one occupant is strong nature. `None` for `Structure` only —
/// resolve it with [`structure_is_strong_nature`], because parks *are* strong
/// nature and they arrive as `Structure`.
#[inline]
pub fn occupant_is_strong_nature(o: Occupant) -> Option<bool> {
    occupant_def(o).strong_nature
}

/// Eco value of a specific structure kind — a 12.0 spread from +4.0 (park) to
/// −8.0 (coal plant). It is the *spread* that matters, not the count: only four
/// distinct values exist across the ten kinds, but collapsing them into one
/// `Structure` constant would flatten a park and a coal plant into each other.
pub fn structure_eco(kind: TileKind, t: &WildernessTunables) -> f32 {
    debug_assert!(
        is_structure_kind(kind),
        "structure_eco called with a non-structure kind"
    );
    t.base_eco[kind as usize]
}

/// Wilderness breakdown line for a specific structure kind.
pub fn structure_category(kind: TileKind) -> EcoCategory {
    match kind {
        TileKind::HydroPlant
        | TileKind::CoalPlant
        | TileKind::WindTurbine
        | TileKind::SolarFarm => EcoCategory::Power,
        TileKind::WaterPump
        | TileKind::WaterTower
        | TileKind::ElementarySchool
        | TileKind::HighSchool => EcoCategory::Civic,
        TileKind::Park | TileKind::ParkLarge => EcoCategory::Parks,
        _ => EcoCategory::Neutral,
    }
}

/// Parks are strong nature; every other structure is not.
pub fn structure_is_strong_nature(kind: TileKind) -> bool {
    matches!(kind, TileKind::Park | TileKind::ParkLarge)
}

/// The ten `TileKind`s that derive to the single `Structure` occupant. They
/// behave identically under every compatibility rule — `place_footprint_building`
/// applies one guard to all of them — so one tag suffices, and the per-kind
/// data (eco, upkeep, category) is looked up rather than duplicated.
pub const fn is_structure_kind(kind: TileKind) -> bool {
    matches!(
        kind,
        TileKind::HydroPlant
            | TileKind::CoalPlant
            | TileKind::WindTurbine
            | TileKind::SolarFarm
            | TileKind::WaterPump
            | TileKind::WaterTower
            | TileKind::ElementarySchool
            | TileKind::HighSchool
            | TileKind::Park
            | TileKind::ParkLarge
    )
}

// ---------------------------------------------------------------------------
// Derived tile accessors — NO storage change
// ---------------------------------------------------------------------------

impl Tile {
    /// What the ground is. `Terrain::Land` is exactly `wilderness::is_buildable`
    /// (which is `kind != Water`); `Terrain::Water` is its complement.
    ///
    /// Reads today's `kind` slot, so it is not yet durable — see [`Terrain`].
    #[inline]
    pub fn terrain(&self) -> Terrain {
        if self.kind == TileKind::Water {
            Terrain::Water
        } else {
            Terrain::Land
        }
    }

    /// Everything physically present on the tile, across all three strata.
    ///
    /// An OR of masked comparisons with no branches, because the utility BFS
    /// calls into this per visited tile and wilderness makes two O(N) passes.
    ///
    /// Every predicate is `kind == X || flag`, which is what makes the two
    /// spellings of one physical tile collapse: `(kind = Road, POWER_OVERLAY)`
    /// and `(kind = PowerLine, ROAD_UNDERLAY | POWER_OVERLAY)` both yield
    /// `{Road, PowerLine}`.
    #[inline]
    pub fn occupants(&self) -> OccupantSet {
        let k = self.kind;
        let f = self.flags;
        // Underground
        bit_when(
            matches!(self.underground, Some(TileKind::WaterPipe)),
            Occupant::Pipe,
        )
        // Surface
        | bit_when(
            k == TileKind::Road || f & FLAG_ROAD_UNDERLAY != 0,
            Occupant::Road,
        )
        | bit_when(
            k == TileKind::Rail || f & FLAG_RAIL_UNDERLAY != 0,
            Occupant::Rail,
        )
        | bit_when(k == TileKind::Residential, Occupant::ZoneResidential)
        | bit_when(k == TileKind::Commercial, Occupant::ZoneCommercial)
        | bit_when(k == TileKind::Industrial, Occupant::ZoneIndustrial)
        // `kind` only, deliberately not gated on `building_id`:
        // `remove_building` keeps the kind so a zone lot can regrow, which
        // leaves a bulldozed park scoring +4.0 forever. That bug is
        // preserved exactly here — see `has_ghost_structure`.
        | bit_when(is_structure_kind(k), Occupant::Structure)
        // Overhead
        | bit_when(
            k == TileKind::PowerLine || f & FLAG_POWER_OVERLAY != 0,
            Occupant::PowerLine,
        )
        | bit_when(k == TileKind::Tree, Occupant::Trees)
    }

    /// The occupants of one stratum.
    #[inline]
    pub fn occupants_in(&self, stratum: Stratum) -> OccupantSet {
        self.occupants() & stratum_mask(stratum)
    }

    /// Whether one specific occupant is present.
    #[inline]
    pub fn has_occupant(&self, occupant: Occupant) -> bool {
        self.occupants() & occupant_bit(occupant) != 0
    }

    /// Surface + overhead: what the player sees and what the bulldozer clears.
    /// Underground occupants are excluded — they are only reachable from the
    /// underground view.
    #[inline]
    pub fn visible_occupants(&self) -> OccupantSet {
        self.occupants() & VISIBLE_MASK
    }

    /// The tile's land use, if it is zoned. Zones are mutually exclusive.
    #[inline]
    pub fn zone_occupant(&self) -> Option<Occupant> {
        match self.kind {
            TileKind::Residential => Some(Occupant::ZoneResidential),
            TileKind::Commercial => Some(Occupant::ZoneCommercial),
            TileKind::Industrial => Some(Occupant::ZoneIndustrial),
            _ => None,
        }
    }

    /// Which structure occupies the tile, if any. `Structure` is one tag, but
    /// eco, upkeep and breakdown category are all per kind.
    #[inline]
    pub fn structure_kind(&self) -> Option<TileKind> {
        if is_structure_kind(self.kind) {
            Some(self.kind)
        } else {
            None
        }
    }

    /// A structure tag with nothing behind it — `remove_building` cleared the
    /// `building_id` but deliberately kept the `kind` so zone lots can regrow.
    /// Exposed so the ghost is nameable; fixing it is a separate change.
    #[inline]
    pub fn has_ghost_structure(&self) -> bool {
        self.has_occupant(Occupant::Structure) && self.building_id.is_none()
    }

    /// Whether the tile carries a network.
    ///
    /// Reads `building_id` / `power_plant_mw` directly on top of the occupant
    /// set, because a developed lot conducts by virtue of being developed —
    /// that is a property of the development, not of any occupant.
    #[inline]
    pub fn conducts(&self, network: Network) -> bool {
        let set = self.occupants();
        match network {
            Network::Power => {
                self.power_plant_mw > 0
                    || self.building_id.is_some()
                    || set_conducts(set, Network::Power)
            }
            Network::Water => self.building_id.is_some() || set_conducts(set, Network::Water),
            Network::Traffic => set_conducts(set, Network::Traffic),
        }
    }

    /// Per-day upkeep for the tile's own infrastructure, split across the four
    /// `BudgetStats` maintenance lines and before funding.
    #[inline]
    pub fn tile_upkeep_by_line(&self) -> [f32; LEDGER_LINE_COUNT] {
        set_upkeep_by_line(self.occupants())
    }

    /// Per-day upkeep for the tile's own infrastructure at 100% funding.
    ///
    /// **Does** include: road, rail, hydro-line and buried-pipe upkeep, one
    /// charge per feature the tile carries.
    ///
    /// **Does not** include: the funding multipliers. Each feature is scaled by
    /// a different slider — road and rail by `fund_transport`, hydro lines by
    /// `fund_power`, pipes by `fund_civic` — so this equals what
    /// `compute_daily_budget` bills for the tile only while all three sliders
    /// sit at `MAX_FUNDING`, which is where `BudgetPolicy::default()` puts
    /// them. Use [`Tile::tile_upkeep_funded`] under any other policy. It also
    /// excludes building maintenance, billed off `state.buildings`, and
    /// wilderness programme costs.
    #[inline]
    pub fn tile_upkeep_unfunded(&self) -> f32 {
        set_upkeep_unfunded(self.occupants())
    }

    /// Per-day upkeep for the tile's own infrastructure under `policy`, each
    /// feature scaled by its own department's funding level. Building
    /// maintenance is still billed separately off `state.buildings`.
    #[inline]
    pub fn tile_upkeep_funded(&self, policy: &BudgetPolicy) -> f32 {
        set_upkeep_funded(self.occupants(), policy)
    }

    /// Eco contribution of the terrain alone.
    ///
    /// `base_eco[Land] = 1.0` is the open-land credit, which a built tile
    /// loses entirely — so it is gated on the *visible* set. A buried pipe
    /// under open land keeps the credit, which is what today's `kind`-based
    /// scoring does too.
    #[inline]
    pub fn terrain_eco(&self, t: &WildernessTunables) -> f32 {
        match self.terrain() {
            Terrain::Water => t.base_eco[TileKind::Water as usize],
            Terrain::Land => {
                if self.visible_occupants() == 0 {
                    t.base_eco[TileKind::Land as usize]
                } else {
                    0.0
                }
            }
        }
    }

    /// Which breakdown line [`Tile::terrain_eco`] belongs on, or `None` when
    /// the terrain contributes to no line.
    ///
    /// The only producer of [`EcoCategory::OpenLand`], and the reason that
    /// variant exists: the `TileKind::Land` arm of the breakdown `match` in
    /// `wilderness::compute_wilderness` credits a bare `Land` tile +1.0 to
    /// `breakdown.open_land`, and nothing an *occupant* can do earns that line.
    /// Water is `None` — `wilderness.rs` matches `Water | WaterPipe => {}` and
    /// files their (zero) value nowhere.
    ///
    /// Gated on the visible set exactly as `terrain_eco` is, so the pair stay
    /// consistent: a `Some` category always accompanies the open-land credit
    /// and a `None` always accompanies a zero.
    #[inline]
    pub fn terrain_category(&self) -> Option<EcoCategory> {
        match self.terrain() {
            Terrain::Water => None,
            Terrain::Land => {
                if self.visible_occupants() == 0 {
                    Some(EcoCategory::OpenLand)
                } else {
                    None
                }
            }
        }
    }

    /// Base eco value of the tile: terrain plus the sum over its occupants.
    ///
    /// The `Σ` is the point — a fifth network is one table row and every
    /// consumer that sums picks it up for free. Note this intentionally
    /// differs from today's `base_eco[kind]` on multi-occupant tiles: a road
    /// carrying a line scores −3.0 here against −1.0 or −2.0 today depending
    /// on which spelling it happens to have. That is the open `wilderness.rs`
    /// bug, and converting that module is deliberately the last step.
    pub fn tile_eco(&self, t: &WildernessTunables) -> f32 {
        let mut eco = self.terrain_eco(t);
        for o in iter_set(self.occupants()) {
            // `None` means "the tag cannot answer" — today only `Structure`,
            // whose value comes from its kind.
            eco += match occupant_eco(o, t) {
                Some(v) => v,
                None => self.structure_kind().map_or(0.0, |k| structure_eco(k, t)),
            };
        }
        eco
    }

    /// Strong nature: earns the patch and water-edge bonuses and risks the
    /// fragmentation penalty. Trees plus parks, matching
    /// `wilderness::is_strong_nature`.
    #[inline]
    pub fn is_strong_nature(&self) -> bool {
        iter_set(self.occupants()).any(|o| match occupant_is_strong_nature(o) {
            Some(strong) => strong,
            // `None` means "the tag cannot answer": a park is strong nature and
            // a coal plant is not, and both are `Structure`.
            None => self
                .structure_kind()
                .is_some_and(structure_is_strong_nature),
        })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adjacency::has_road_access;
    use crate::commands::apply_tool;
    use crate::state::{GameState, FLAG_ABANDONED, FLAG_POWERED, FLAG_WATERED};
    use crate::utilities::{is_power_carrier_pub, is_water_carrier_pub};
    use city_sim_protocol::commands::Tool;

    // --- helpers ---------------------------------------------------------

    /// A tile spelled out by hand: kind + structural flags + underground.
    fn tile(kind: TileKind, flags: u8, underground: Option<TileKind>) -> Tile {
        Tile {
            kind,
            flags,
            underground,
            ..Tile::land()
        }
    }

    const STRUCTURAL_FLAGS: u8 = FLAG_ROAD_UNDERLAY | FLAG_RAIL_UNDERLAY | FLAG_POWER_OVERLAY;

    /// Every combination of the three structural flags.
    fn structural_flag_combos() -> Vec<u8> {
        (0u8..8)
            .map(|i| {
                (if i & 1 != 0 { FLAG_ROAD_UNDERLAY } else { 0 })
                    | (if i & 2 != 0 { FLAG_RAIL_UNDERLAY } else { 0 })
                    | (if i & 4 != 0 { FLAG_POWER_OVERLAY } else { 0 })
            })
            .collect()
    }

    /// Four-character column label for the printed compatibility table — the
    /// three zone tags share a prefix, so `{:?}` truncated is ambiguous.
    fn short_name(o: Occupant) -> &'static str {
        match o {
            Occupant::Pipe => "Pipe",
            Occupant::Subway => "Sbwy",
            Occupant::Fibre => "Fibr",
            Occupant::Road => "Road",
            Occupant::Rail => "Rail",
            Occupant::ZoneResidential => "ZonR",
            Occupant::ZoneCommercial => "ZonC",
            Occupant::ZoneIndustrial => "ZonI",
            Occupant::Structure => "Strc",
            Occupant::PowerLine => "Powr",
            Occupant::Trees => "Tree",
        }
    }

    /// Which `WildernessBreakdown` line the real `compute_wilderness` files a
    /// tile of `kind` on — *measured* out of the function rather than
    /// transcribed from its `match`, so the pins below track `wilderness.rs`
    /// instead of quietly agreeing with a stale copy of it.
    ///
    /// The probe tunables score `kind` at exactly 1.0 and every other kind at
    /// 0.0, on a grid of one `kind` tile surrounded by water — a filler that
    /// files its value on no line at all (`Water | WaterPipe => {}`, so a
    /// surface pipe would serve equally well). The three
    /// neighbourhood adjustments are zeroed because they have breakdown lines
    /// of their own, so the sole thing that can move a category line is the
    /// base value of the probe tile. Whichever line comes back holding 1.0 is
    /// the arm `match kind` took; no line moving is [`EcoCategory::Neutral`].
    fn breakdown_line_for(kind: TileKind) -> EcoCategory {
        let mut base_eco = [0.0_f32; 20];
        base_eco[kind as usize] = 1.0;
        let t = WildernessTunables {
            base_eco,
            patch_bonus_cap: 0.0,
            edge_bonus: 0.0,
            fragmentation_penalty: 0.0,
            ..WildernessTunables::default()
        };

        let mut s = GameState::new(3, 3, 0);
        for tl in &mut s.tiles {
            tl.kind = TileKind::Water;
        }
        s.tiles[4].kind = kind;

        let b = crate::wilderness::compute_wilderness(&s, &t).breakdown;
        let lines = [
            (EcoCategory::Forests, b.forests),
            (EcoCategory::Parks, b.parks),
            (EcoCategory::OpenLand, b.open_land),
            (EcoCategory::Zones, b.zones),
            (EcoCategory::Industry, b.industry),
            (EcoCategory::Transport, b.transport),
            (EcoCategory::Power, b.power),
            (EcoCategory::Civic, b.civic),
        ];
        assert_eq!(
            lines.len() + 1,
            EcoCategory::ALL.len(),
            "an EcoCategory was added — give it a WildernessBreakdown field here \
             (the +1 is Neutral, which has no field by definition)"
        );
        let hit: Vec<EcoCategory> = lines
            .iter()
            .filter(|(_, v)| *v != 0.0)
            .map(|(c, _)| *c)
            .collect();
        assert!(
            hit.len() <= 1,
            "{kind:?} moved more than one breakdown line: {hit:?}"
        );
        hit.first().copied().unwrap_or(EcoCategory::Neutral)
    }

    fn set_string(set: OccupantSet) -> String {
        let names: Vec<String> = iter_set(set).map(|o| format!("{o:?}")).collect();
        if names.is_empty() {
            "{}".to_string()
        } else {
            format!("{{{}}}", names.join(", "))
        }
    }

    // --- table integrity -------------------------------------------------

    #[test]
    fn defs_are_indexed_by_discriminant() {
        for (i, o) in ALL_OCCUPANTS.into_iter().enumerate() {
            assert_eq!(o as usize, i, "ALL_OCCUPANTS must be in bit order");
            assert_eq!(
                OCCUPANT_DEFS[i].occupant, o,
                "OCCUPANT_DEFS must be indexed by `Occupant as usize`"
            );
        }
        assert_eq!(OCCUPANT_DEFS.len(), OCCUPANT_COUNT);
    }

    #[test]
    fn stratum_masks_partition_the_word() {
        // Driven off `Stratum::ALL` so a fourth stratum joins the partition
        // check by existing, rather than by someone remembering to add a line.
        let mut union: OccupantSet = 0;
        for (i, a) in Stratum::ALL.into_iter().enumerate() {
            assert_eq!(a as usize, i, "Stratum::ALL must be in discriminant order");
            assert_ne!(stratum_mask(a), 0, "{a:?} has no occupants");
            for b in Stratum::ALL {
                if a != b {
                    assert_eq!(
                        stratum_mask(a) & stratum_mask(b),
                        0,
                        "{a:?} and {b:?} share a bit"
                    );
                }
            }
            union |= stratum_mask(a);
        }
        assert_eq!(
            union, ALL_MASK,
            "every occupant must belong to exactly one stratum"
        );
        // Contiguous, stratum-grouped bit ranges keep `stratum_mask` a constant.
        assert_eq!(UNDERGROUND_MASK, 0b0000_0000_0000_0111);
        assert_eq!(SURFACE_MASK, 0b0000_0001_1111_1000);
        assert_eq!(OVERHEAD_MASK, 0b0000_0110_0000_0000);
        // Bits 11–15 are spare headroom.
        assert_eq!(ALL_MASK, 0b0000_0111_1111_1111);

        for o in ALL_OCCUPANTS {
            let def = occupant_def(o);
            assert_eq!(
                stratum_mask(def.stratum) & occupant_bit(o),
                occupant_bit(o),
                "{o:?} is not inside its own stratum mask"
            );
        }
    }

    /// Every `conducts` mask is made of known networks, and `set_conducts`
    /// answers for each of them. Driven off `Network::ALL` so a fourth network
    /// is covered the moment it is declared.
    #[test]
    fn conducts_masks_only_use_declared_networks() {
        let known: NetworkSet = Network::ALL
            .into_iter()
            .fold(0, |acc, n| acc | (1 << (n as u8)));
        assert_eq!(known, NET_POWER | NET_WATER | NET_TRAFFIC);
        for (i, n) in Network::ALL.into_iter().enumerate() {
            assert_eq!(n as usize, i, "Network::ALL must be in discriminant order");
        }

        for o in ALL_OCCUPANTS {
            let def = occupant_def(o);
            assert_eq!(
                def.conducts & !known,
                0,
                "{o:?} conducts an undeclared network"
            );
            for n in Network::ALL {
                assert_eq!(
                    set_conducts(occupant_bit(o), n),
                    def.conducts & (1 << (n as u8)) != 0,
                    "{o:?} / {n:?}"
                );
            }
        }
        assert!(
            !set_conducts(0, Network::Power),
            "the empty set conducts nothing"
        );
    }

    #[test]
    fn conflicts_are_symmetric_and_never_reflexive() {
        for a in ALL_OCCUPANTS {
            assert_eq!(
                occupant_def(a).conflicts & occupant_bit(a),
                0,
                "{a:?} must not conflict with itself"
            );
            for b in ALL_OCCUPANTS {
                assert_eq!(
                    pair_conflicts(a, b),
                    pair_conflicts(b, a),
                    "compatibility must be symmetric: {a:?} / {b:?}"
                );
            }
        }
    }

    // --- the exhaustive compatibility table ------------------------------

    /// Enumerates every ordered pair of occupants, prints the whole table, and
    /// pins the counts. The design note asserted "19 pairs, exactly one
    /// exception"; that counted same-stratum pairs only and missed the
    /// cross-stratum Structure + PowerLine conflict. Both numbers are pinned
    /// here so nobody has to trust the prose.
    #[test]
    fn compatibility_table_is_exhaustive_and_pinned() {
        let mut ordered_total = 0usize;
        let mut ordered_distinct = 0usize;
        let mut unordered_distinct = 0usize;
        let mut same_stratum = 0usize;
        let mut cross_stratum = 0usize;
        let mut conflicting = 0usize;
        let mut coexisting = 0usize;
        let mut per_stratum = [0usize; 3];

        // Header: one column per occupant.
        let mut header = format!("{:<18}", "");
        for b in ALL_OCCUPANTS {
            header.push_str(&format!("{:>6}", short_name(b)));
        }
        println!("\ncompatibility table — `.` coexist, `X` conflict, `-` self\n{header}");

        for a in ALL_OCCUPANTS {
            let mut row = format!("{:<18}", format!("{a:?}"));
            for b in ALL_OCCUPANTS {
                ordered_total += 1;
                if a == b {
                    assert!(!pair_conflicts(a, b));
                    row.push_str(&format!("{:>6}", "-"));
                    continue;
                }
                ordered_distinct += 1;
                let conflict = pair_conflicts(a, b);
                row.push_str(&format!("{:>6}", if conflict { "X" } else { "." }));

                // Count each unordered pair once.
                if (a as u8) < (b as u8) {
                    unordered_distinct += 1;
                    let sa = occupant_def(a).stratum;
                    let sb = occupant_def(b).stratum;
                    if sa == sb {
                        same_stratum += 1;
                        per_stratum[sa as usize] += 1;
                    } else {
                        cross_stratum += 1;
                    }
                    if conflict {
                        conflicting += 1;
                    } else {
                        coexisting += 1;
                    }
                }
            }
            println!("{row}");
        }

        println!(
            "\n{OCCUPANT_COUNT} occupants → {ordered_total} ordered pairs ({ordered_distinct} distinct), \
             {unordered_distinct} unordered"
        );
        println!(
            "  same-stratum {same_stratum} (underground {}, surface {}, overhead {}), cross-stratum {cross_stratum}",
            per_stratum[Stratum::Underground as usize],
            per_stratum[Stratum::Surface as usize],
            per_stratum[Stratum::Overhead as usize],
        );
        println!(
            "  conflicting {conflicting}, coexisting {coexisting}, exceptions {}",
            COMPAT_EXCEPTIONS.len()
        );
        for e in &COMPAT_EXCEPTIONS {
            println!(
                "  exception: {:?} + {:?} → {} — {}",
                e.a,
                e.b,
                if e.coexist { "coexist" } else { "conflict" },
                e.why
            );
        }

        // Pinned counts.
        assert_eq!(OCCUPANT_COUNT, 11);
        assert_eq!(ordered_total, 121, "11 × 11 ordered pairs including self");
        assert_eq!(ordered_distinct, 110);
        assert_eq!(unordered_distinct, 55);
        assert_eq!(same_stratum, 19, "the design note's 19 same-stratum pairs");
        assert_eq!(per_stratum[Stratum::Underground as usize], 3);
        assert_eq!(per_stratum[Stratum::Surface as usize], 15);
        assert_eq!(per_stratum[Stratum::Overhead as usize], 1);
        assert_eq!(cross_stratum, 36);
        assert_eq!(conflicting, 16);
        assert_eq!(coexisting, 39);
        assert_eq!(conflicting + coexisting, unordered_distinct);
        assert_eq!(
            COMPAT_EXCEPTIONS.len(),
            2,
            "Road+Rail and Structure+PowerLine"
        );
    }

    /// The materialised `conflicts` masks must equal "stratum default, then
    /// apply the exception list" — so the table cannot drift from the rule it
    /// claims to encode.
    #[test]
    fn compatibility_table_is_derived_from_defaults_plus_exceptions() {
        let mut exceptions_used = 0usize;
        for a in ALL_OCCUPANTS {
            for b in ALL_OCCUPANTS {
                if a == b {
                    continue;
                }
                let da = occupant_def(a);
                let db = occupant_def(b);
                let mut expected =
                    da.stratum == db.stratum && stratum_default_is_conflict(da.stratum);
                let exception = COMPAT_EXCEPTIONS
                    .iter()
                    .find(|e| (e.a == a && e.b == b) || (e.a == b && e.b == a));
                if let Some(e) = exception {
                    assert_ne!(
                        expected, !e.coexist,
                        "{a:?} + {b:?} is listed as an exception but matches the stratum default"
                    );
                    expected = !e.coexist;
                    if (a as u8) < (b as u8) {
                        exceptions_used += 1;
                    }
                }
                assert_eq!(
                    pair_conflicts(a, b),
                    expected,
                    "{a:?} + {b:?}: table says {}, default+exceptions say {}",
                    pair_conflicts(a, b),
                    expected
                );
            }
        }
        assert_eq!(
            exceptions_used,
            COMPAT_EXCEPTIONS.len(),
            "every exception must be reachable"
        );
    }

    #[test]
    fn validate_set_is_advisory_and_finds_the_right_pair() {
        assert_eq!(validate_set(0), Ok(()));
        assert_eq!(validate_set(B_ROAD | B_RAIL), Ok(()), "level crossing");
        assert_eq!(
            validate_set(B_ROAD | B_POWER_LINE),
            Ok(()),
            "road with a line"
        );
        assert_eq!(
            validate_set(B_PIPE | B_SUBWAY | B_FIBRE),
            Ok(()),
            "depth is free"
        );
        assert_eq!(
            validate_set(B_ROAD | B_TREES),
            Ok(()),
            "street trees, cross-stratum"
        );
        assert_eq!(
            validate_set(B_ROAD | B_ZONE_R),
            Err((Occupant::Road, Occupant::ZoneResidential))
        );
        assert_eq!(
            validate_set(B_STRUCTURE | B_POWER_LINE),
            Err((Occupant::Structure, Occupant::PowerLine))
        );
        assert_eq!(
            validate_set(B_POWER_LINE | B_TREES),
            Err((Occupant::PowerLine, Occupant::Trees))
        );

        // Producible today: Tool::Tree over a hydro line leaves the overlay
        // flag set. Validation must report it, not panic on it. Built through
        // the real tools in `known_defect_trees_are_planted_through_a_live_hydro_line`.
        let t = tile(TileKind::Tree, FLAG_POWER_OVERLAY, None);
        assert_eq!(t.occupants(), B_TREES | B_POWER_LINE);
        assert!(validate_set(t.occupants()).is_err());
    }

    // --- known defects: tiles the game builds and the table forbids ---------
    //
    // Everything in this section asserts what the game does **today**, not
    // what it should do. Each one is a real bug of exactly the class this
    // module exists to close, and each is fixed in step 2 of #177 by
    // tightening `commands.rs`. That makes these tests deliberately upside
    // down: they are written to go RED the moment the fix lands, which is the
    // point — the fix must not be able to slip in without someone coming back
    // here, deleting the defect and moving the assertion to the correct side.
    // Step 1 changes no behaviour, so none of it can be fixed here.

    /// **Known defect.** Three ordinary tool clicks stamp a structure over a
    /// live hydro line, producing `{Structure, PowerLine}` — a pair
    /// [`COMPAT_EXCEPTIONS`] declares impossible.
    ///
    /// `place_footprint_building` (`commands.rs` ~336–346) rejects a tile whose
    /// `kind` is `Road`, `Rail` or `PowerLine`, and rejects `has_road_underlay()`
    /// and `has_rail_underlay()` — but it never asks `has_power_overlay()`. A
    /// line strung across a *zoned* tile records itself in that flag and leaves
    /// `kind` on the zone, so the guard looks at `Residential`, sees nothing it
    /// objects to, and lets a park land on top of the conductors.
    ///
    /// The line survives as a flag: still drawn, still conducting power, still
    /// billed `MAINT_POWER_LINE` every day, and now unreachable by the
    /// bulldozer except through the building. Step 2 adds the missing
    /// `has_power_overlay()` clause, at which point the third click fails and
    /// this test goes red — rewrite it then, do not weaken it.
    #[test]
    fn known_defect_a_structure_is_stamped_over_a_live_hydro_line() {
        let mut s = GameState::new(4, 4, 0);
        assert!(apply_tool(&mut s, Tool::Residential, 2, 2).success);
        assert!(apply_tool(&mut s, Tool::PowerLine, 2, 2).success);

        // After two clicks the tile is a zone carrying a line, recorded the one
        // canonical way: the zone keeps `kind`, the line takes the flag.
        let t = s.tiles[s.tile_index(2, 2).unwrap()].clone();
        assert_eq!(t.kind, TileKind::Residential);
        assert!(t.has_power_overlay());
        assert_eq!(t.occupants(), B_ZONE_R | B_POWER_LINE);
        assert_eq!(validate_set(t.occupants()), Ok(()));

        // The third click is the defect. It succeeds — and it should not.
        let r = apply_tool(&mut s, Tool::Park, 2, 2);
        assert!(
            r.success,
            "step 2 has tightened place_footprint_building — good. Delete this \
             known defect and assert the rejection instead."
        );

        let t = s.tiles[s.tile_index(2, 2).unwrap()].clone();
        assert_eq!(t.kind, TileKind::Park);
        assert!(t.building_id.is_some(), "a real park, not a ghost");
        assert!(
            t.has_power_overlay(),
            "the line is still there — it was never cleared, only built over"
        );
        assert_eq!(t.occupants(), B_STRUCTURE | B_POWER_LINE);
        assert_eq!(
            validate_set(t.occupants()),
            Err((Occupant::Structure, Occupant::PowerLine)),
            "the table calls this pair impossible and the game just built it"
        );

        // Not a cosmetic leftover: the buried line still conducts and is still
        // billed, which is what makes this a defect rather than a stale bit.
        assert!(t.conducts(Network::Power));
        assert!(
            (t.tile_upkeep_unfunded() - MAINT_POWER_LINE).abs() < 1e-6,
            "the city keeps paying for a line it can no longer see or remove"
        );

        // Zoning is not the only way in. Anything that moves the line out of
        // `kind` and into the flag opens the same hole: `Tool::TerraformRaise`
        // writes `kind = Land` and leaves the overlay standing, after which the
        // guard sees a bare land tile. `producible_conflicts_are_inventoried`
        // finds this route on its own; it is spelled out here so the fix is
        // understood as "the guard is missing a clause", not "zoning is odd".
        let mut s = GameState::new(4, 4, 0);
        assert!(apply_tool(&mut s, Tool::PowerLine, 1, 1).success);
        assert!(apply_tool(&mut s, Tool::TerraformRaise, 1, 1).success);
        let t = s.tiles[s.tile_index(1, 1).unwrap()].clone();
        assert_eq!(t.kind, TileKind::Land);
        assert!(t.has_power_overlay());
        assert!(apply_tool(&mut s, Tool::HydroPlant, 1, 1).success);
        assert_eq!(
            s.tiles[s.tile_index(1, 1).unwrap()].occupants(),
            B_STRUCTURE | B_POWER_LINE
        );
    }

    /// **Known defect.** Two tool clicks plant a canopy through live
    /// conductors, producing `{Trees, PowerLine}` — a straight overhead-stratum
    /// conflict, no exception needed.
    ///
    /// `Tool::Tree` goes through `set_kind`, which rewrites `kind` and leaves
    /// every structural flag alone, so `FLAG_POWER_OVERLAY` outlives the line
    /// that set it. Same shape as the structure defect above: the line is
    /// invisible to `kind`, still conducting and still billed. Step 2 makes
    /// `Tool::Tree` clear the overlay (or refuse the tile); this test goes red
    /// then, by design.
    #[test]
    fn known_defect_trees_are_planted_through_a_live_hydro_line() {
        let mut s = GameState::new(4, 4, 0);
        assert!(apply_tool(&mut s, Tool::PowerLine, 1, 1).success);
        let r = apply_tool(&mut s, Tool::Tree, 1, 1);
        assert!(
            r.success,
            "step 2 has tightened Tool::Tree — good. Delete this known defect \
             and assert the rejection instead."
        );

        let t = s.tiles[s.tile_index(1, 1).unwrap()].clone();
        assert_eq!(t.kind, TileKind::Tree);
        assert!(t.has_power_overlay(), "set_kind never touches the flags");
        assert_eq!(t.occupants(), B_TREES | B_POWER_LINE);
        assert_eq!(
            validate_set(t.occupants()),
            Err((Occupant::PowerLine, Occupant::Trees))
        );
        assert!(t.conducts(Network::Power));
        assert!((t.tile_upkeep_unfunded() - MAINT_POWER_LINE).abs() < 1e-6);
    }

    /// Exhaustive search for tiles the game can build that the compatibility
    /// table calls impossible — so the two known defects above are a complete
    /// inventory rather than the two somebody happened to notice.
    ///
    /// Closes the single-tile state space under `apply_tool`: every tool,
    /// applied at one spot, from every distinct grid state reached so far, to a
    /// fixed point. Breadth-first and with the treasury topped up after each
    /// click, so neither path length nor funds can hide a reachable state.
    ///
    /// Any pair found here is producible by clicking, which means either the
    /// table is wrong about it or the game is. The answer is pinned, so a third
    /// defect appearing — or one of these two being fixed — lands as a failing
    /// test rather than as silence.
    #[test]
    fn producible_conflicts_are_inventoried() {
        use std::collections::{HashSet, VecDeque};

        // Driven off `Tool::try_from`, which rejects the first invalid
        // discriminant, so a newly added tool joins the sweep by existing.
        let tools: Vec<Tool> = (0u8..=u8::MAX)
            .map_while(|v| Tool::try_from(v).ok())
            .collect();
        assert_eq!(tools.len(), 23, "a Tool was added — re-run the sweep");

        /// Grid identity: everything a tool guard or `occupants()` can read.
        /// Money is deliberately excluded, and reset below, so that two states
        /// with the same tiles are the same node however dearly they were
        /// reached.
        fn signature(s: &GameState) -> Vec<(u8, u8, u8, bool)> {
            s.tiles
                .iter()
                .map(|t| {
                    (
                        t.kind as u8,
                        t.flags,
                        t.underground.map_or(0xFF, |k| k as u8),
                        t.building_id.is_some(),
                    )
                })
                .collect()
        }

        // 4×4 so a 2×2 footprint placed at (1, 1) fits; every click lands at
        // (1, 1), and the surrounding tiles move only as footprint spill.
        let start = GameState::new(4, 4, 0);
        let mut seen: HashSet<Vec<(u8, u8, u8, bool)>> = HashSet::new();
        seen.insert(signature(&start));
        let mut frontier: VecDeque<(GameState, Vec<Tool>)> = VecDeque::new();
        frontier.push_back((start, Vec::new()));

        let mut found: Vec<((Occupant, Occupant), Vec<Tool>)> = Vec::new();
        let mut states = 1usize;

        while let Some((s, path)) = frontier.pop_front() {
            for &tool in &tools {
                let mut next = s.clone();
                apply_tool(&mut next, tool, 1, 1);
                // Funds must never be what makes a state unreachable.
                next.money = 100_000;
                if !seen.insert(signature(&next)) {
                    continue;
                }
                states += 1;
                assert!(states < 100_000, "state space blew up — bound the sweep");
                let mut next_path = path.clone();
                next_path.push(tool);

                for t in &next.tiles {
                    let set = t.occupants();
                    for a in iter_set(set) {
                        for b in iter_set(set) {
                            if (a as u8) < (b as u8)
                                && pair_conflicts(a, b)
                                && !found.iter().any(|(p, _)| *p == (a, b))
                            {
                                found.push(((a, b), next_path.clone()));
                            }
                        }
                    }
                }
                frontier.push_back((next, next_path));
            }
        }

        println!("\n{states} reachable grid states under apply_tool at one tile");
        for ((a, b), path) in &found {
            println!("  producible conflict {a:?} + {b:?} via {path:?}");
        }

        // Sorted, so the pin is about which pairs are reachable and not about
        // the order the search happened to reach them in.
        let mut pairs: Vec<(Occupant, Occupant)> = found.iter().map(|(p, _)| *p).collect();
        pairs.sort_by_key(|(a, b)| (*a as u8, *b as u8));
        assert_eq!(
            pairs,
            vec![
                (Occupant::Structure, Occupant::PowerLine),
                (Occupant::PowerLine, Occupant::Trees),
            ],
            "the producible-conflict inventory changed. A new pair means a new \
             defect of the same class; a missing pair means step 2 fixed one, in \
             which case delete its known-defect test above and this entry."
        );
    }

    // --- per-kind round trip ---------------------------------------------

    /// Every `TileKind` maps to a sensible (terrain, occupants) pair. Bare
    /// tile: no flags, nothing underground.
    #[test]
    fn every_tile_kind_maps_to_a_sensible_terrain_and_set() {
        let expected: &[(TileKind, Terrain, OccupantSet)] = &[
            (TileKind::Land, Terrain::Land, 0),
            (TileKind::Water, Terrain::Water, 0),
            (TileKind::Tree, Terrain::Land, B_TREES),
            (TileKind::Road, Terrain::Land, B_ROAD),
            (TileKind::Rail, Terrain::Land, B_RAIL),
            (TileKind::Residential, Terrain::Land, B_ZONE_R),
            (TileKind::Commercial, Terrain::Land, B_ZONE_C),
            (TileKind::Industrial, Terrain::Land, B_ZONE_I),
            (TileKind::PowerLine, Terrain::Land, B_POWER_LINE),
            (TileKind::HydroPlant, Terrain::Land, B_STRUCTURE),
            (TileKind::WaterPump, Terrain::Land, B_STRUCTURE),
            (TileKind::WaterTower, Terrain::Land, B_STRUCTURE),
            // A surface WaterPipe derives to nothing, deliberately: no tool has
            // ever written it, base_eco is 0.0 and it has no breakdown
            // category, but `import.rs` accepts the byte — so the empty answer
            // must be on purpose rather than by accident.
            (TileKind::WaterPipe, Terrain::Land, 0),
            (TileKind::ElementarySchool, Terrain::Land, B_STRUCTURE),
            (TileKind::HighSchool, Terrain::Land, B_STRUCTURE),
            (TileKind::Park, Terrain::Land, B_STRUCTURE),
            (TileKind::CoalPlant, Terrain::Land, B_STRUCTURE),
            (TileKind::WindTurbine, Terrain::Land, B_STRUCTURE),
            (TileKind::SolarFarm, Terrain::Land, B_STRUCTURE),
            (TileKind::ParkLarge, Terrain::Land, B_STRUCTURE),
        ];
        assert_eq!(
            expected.len(),
            TileKind::ALL.len(),
            "a TileKind was added without an occupant mapping"
        );

        println!("\nTileKind → (terrain, occupants)");
        for (kind, terrain, set) in expected {
            let t = tile(*kind, 0, None);
            println!(
                "  {:<16} {:?}  {}",
                kind.ts_string(),
                terrain,
                set_string(*set)
            );
            assert_eq!(t.terrain(), *terrain, "{kind:?} terrain");
            assert_eq!(t.occupants(), *set, "{kind:?} occupants");
            // A bare tile occupies at most one stratum's worth of surface.
            assert!(
                validate_set(t.occupants()).is_ok(),
                "{kind:?} is self-inconsistent"
            );
        }

        // The two spellings of a pipe: underground (real) and surface (import only).
        assert_eq!(
            tile(TileKind::Land, 0, Some(TileKind::WaterPipe)).occupants(),
            B_PIPE
        );
        assert_eq!(
            tile(TileKind::Land, 0, Some(TileKind::WaterPipe)).occupants_in(Stratum::Underground),
            B_PIPE
        );
    }

    #[test]
    fn every_occupant_except_the_reserved_ones_is_producible() {
        let mut produced: OccupantSet = 0;
        for &kind in TileKind::ALL {
            for flags in structural_flag_combos() {
                for underground in [None, Some(TileKind::WaterPipe)] {
                    produced |= tile(kind, flags, underground).occupants();
                }
            }
        }
        assert_eq!(
            produced,
            ALL_MASK & !(B_SUBWAY | B_FIBRE),
            "producible set: {} (reserved: Subway, Fibre)",
            set_string(produced)
        );
        // Reserved bits derive to false, always.
        assert_eq!(produced & (B_SUBWAY | B_FIBRE), 0);
    }

    #[test]
    fn non_structural_flags_do_not_affect_the_set() {
        for &kind in TileKind::ALL {
            let bare = tile(kind, 0, None);
            let noisy = tile(
                kind,
                FLAG_POWERED | FLAG_WATERED | FLAG_ABANDONED | 0b1100_0000,
                None,
            );
            assert_eq!(
                bare.occupants(),
                noisy.occupants(),
                "{kind:?}: derived state, density and abandonment must not change occupants"
            );
        }
    }

    // --- THE property: both recordings agree ------------------------------

    /// The migration rests entirely on this: one physical tile, however it
    /// happens to be spelled, derives to one occupant set.
    ///
    /// For every combination of road / rail / hydro line / zone, enumerate
    /// every legal recording — each present feature takes a turn owning
    /// `kind`, the rest fall back to their flags, plus the redundant variant
    /// where the owner *also* sets its own flag (unreachable from
    /// `commands.rs`, but `import.rs` copies `kind` and `flags` verbatim out
    /// of a save buffer, so it is reachable) — and assert every spelling
    /// yields the identical set.
    ///
    /// A zone has no fallback flag, so when a zone is present only the zone
    /// can own `kind`; that is a fact about today's storage, and it is exactly
    /// the asymmetry the occupant set erases.
    #[test]
    fn both_recordings_agree() {
        let zones = [
            None,
            Some((TileKind::Residential, B_ZONE_R)),
            Some((TileKind::Commercial, B_ZONE_C)),
            Some((TileKind::Industrial, B_ZONE_I)),
        ];
        let mut checked = 0usize;
        let mut multi_spelling = 0usize;
        let mut total_spellings = 0usize;

        println!("\nphysical tile → recordings → derived set");
        for road in [false, true] {
            for rail in [false, true] {
                for line in [false, true] {
                    for zone in zones {
                        let expected = bit_when(road, Occupant::Road)
                            | bit_when(rail, Occupant::Rail)
                            | bit_when(line, Occupant::PowerLine)
                            | zone.map_or(0, |(_, bit)| bit);

                        // Flags for every present feature.
                        let all_flags = (if road { FLAG_ROAD_UNDERLAY } else { 0 })
                            | (if rail { FLAG_RAIL_UNDERLAY } else { 0 })
                            | (if line { FLAG_POWER_OVERLAY } else { 0 });

                        // Candidate owners of `kind`. A zone must own it when
                        // present, because it has no flag to fall back on.
                        let mut owners: Vec<(TileKind, u8)> = Vec::new();
                        if let Some((zk, _)) = zone {
                            // A zone owns `kind` and has no flag of its own, so
                            // every other present feature must keep its flag.
                            owners.push((zk, 0));
                        } else {
                            if road {
                                owners.push((TileKind::Road, FLAG_ROAD_UNDERLAY));
                            }
                            if rail {
                                owners.push((TileKind::Rail, FLAG_RAIL_UNDERLAY));
                            }
                            if line {
                                owners.push((TileKind::PowerLine, FLAG_POWER_OVERLAY));
                            }
                            if owners.is_empty() {
                                owners.push((TileKind::Land, 0));
                            }
                        }

                        let mut spellings: Vec<(TileKind, u8)> = Vec::new();
                        for (kind, own_flag) in owners {
                            // Canonical: the owner drops its own flag.
                            spellings.push((kind, all_flags & !own_flag));
                            // Redundant: the owner also sets its own flag.
                            spellings.push((kind, all_flags));
                        }
                        spellings.dedup();

                        let sets: Vec<OccupantSet> = spellings
                            .iter()
                            .map(|&(k, f)| tile(k, f, None).occupants())
                            .collect();

                        let distinct_spellings = spellings.len();
                        total_spellings += distinct_spellings;
                        if distinct_spellings > 1 {
                            multi_spelling += 1;
                        }
                        println!(
                            "  road={road:<5} rail={rail:<5} line={line:<5} zone={:<12} × {distinct_spellings} recording(s) → {}",
                            zone.map_or("none".to_string(), |(k, _)| k.ts_string().to_string()),
                            set_string(expected)
                        );

                        for (&(k, f), &got) in spellings.iter().zip(sets.iter()) {
                            assert_eq!(
                                got,
                                expected,
                                "spelling (kind={k:?}, flags={f:#010b}) derived {} but the physical tile is {}",
                                set_string(got),
                                set_string(expected)
                            );
                        }
                        // And every spelling agrees with every other.
                        assert!(sets.windows(2).all(|w| w[0] == w[1]));
                        checked += 1;

                        // Underground is orthogonal: adding a pipe adds
                        // exactly one bit to every spelling.
                        for &(k, f) in &spellings {
                            assert_eq!(
                                tile(k, f, Some(TileKind::WaterPipe)).occupants(),
                                expected | B_PIPE
                            );
                        }
                    }
                }
            }
        }

        assert_eq!(checked, 32, "2 road × 2 rail × 2 line × 4 zone states");
        assert_eq!(
            total_spellings, 49,
            "distinct (kind, flags) recordings enumerated"
        );
        assert_eq!(
            multi_spelling, 7,
            "combinations with more than one legal recording — every unzoned tile \
             carrying at least one of road/rail/line. A zoned tile has exactly one \
             recording because a zone has no fallback flag, which is precisely the \
             storage asymmetry the occupant set erases."
        );
    }

    /// The same property driven through the real tools rather than hand-built
    /// tiles: build order must not change the derived set.
    #[test]
    fn tool_orderings_agree() {
        fn build(order: &[Tool]) -> OccupantSet {
            let mut s = GameState::new(4, 4, 0);
            for &t in order {
                apply_tool(&mut s, t, 1, 1);
            }
            s.tiles[s.tile_index(1, 1).unwrap()].occupants()
        }

        // Road, rail and line — all six orderings give the level crossing
        // under a hydro line.
        let expected = B_ROAD | B_RAIL | B_POWER_LINE;
        let perms: [[Tool; 3]; 6] = [
            [Tool::Road, Tool::Rail, Tool::PowerLine],
            [Tool::Road, Tool::PowerLine, Tool::Rail],
            [Tool::Rail, Tool::Road, Tool::PowerLine],
            [Tool::Rail, Tool::PowerLine, Tool::Road],
            [Tool::PowerLine, Tool::Road, Tool::Rail],
            [Tool::PowerLine, Tool::Rail, Tool::Road],
        ];
        for p in perms {
            assert_eq!(build(&p), expected, "ordering {p:?} disagreed");
        }

        // Zone + line, both ways round — the zone survives the line and the
        // line survives the zone.
        for pair in [
            [Tool::Residential, Tool::PowerLine],
            [Tool::PowerLine, Tool::Residential],
        ] {
            assert_eq!(build(&pair), B_ZONE_R | B_POWER_LINE, "ordering {pair:?}");
        }

        // Zone + road: the zone tool refuses a road tile and the road tool
        // paves over a zone, so both orders end at a bare road. Pinning
        // today's behaviour, not endorsing it.
        for pair in [
            [Tool::Residential, Tool::Road],
            [Tool::Road, Tool::Residential],
        ] {
            assert_eq!(build(&pair), B_ROAD, "ordering {pair:?}");
        }

        // A pipe is orthogonal to everything above it.
        assert_eq!(
            build(&[Tool::WaterPipe, Tool::Road, Tool::PowerLine]),
            B_PIPE | B_ROAD | B_POWER_LINE
        );
    }

    // --- upkeep -----------------------------------------------------------

    /// `tile_upkeep_unfunded` must reproduce the four independent `if`s in
    /// `compute_daily_budget` exactly, over the whole (kind, flags,
    /// underground) space — at 100% funding, where the multipliers are all 1.0.
    /// Non-default funding is `tile_upkeep_is_funded_per_department` below.
    #[test]
    fn tile_upkeep_matches_the_economy_ledger() {
        let mut cases = 0usize;
        for &kind in TileKind::ALL {
            for flags in structural_flag_combos() {
                for underground in [None, Some(TileKind::WaterPipe)] {
                    let t = tile(kind, flags, underground);
                    // Verbatim copy of the economy.rs loop body.
                    let mut expected = 0.0_f32;
                    if t.kind == TileKind::Road || t.has_road_underlay() {
                        expected += MAINT_ROAD;
                    }
                    if t.kind == TileKind::Rail || t.has_rail_underlay() {
                        expected += MAINT_RAIL;
                    }
                    if t.kind == TileKind::PowerLine || t.has_power_overlay() {
                        expected += MAINT_POWER_LINE;
                    }
                    if t.underground == Some(TileKind::WaterPipe) {
                        expected += MAINT_WATER_PIPE;
                    }
                    assert!(
                        (t.tile_upkeep_unfunded() - expected).abs() < 1e-6,
                        "{kind:?} flags={flags:#010b} underground={underground:?}: \
                         tile_upkeep_unfunded {} vs ledger {expected}",
                        t.tile_upkeep_unfunded()
                    );
                    // The default policy funds everything at 100%, which is the
                    // only policy under which the two agree.
                    assert!(
                        (t.tile_upkeep_funded(&BudgetPolicy::default()) - expected).abs() < 1e-6,
                        "{kind:?}: default funding must be neutral"
                    );
                    // The by-line split must add up to the same total.
                    let lines = t.tile_upkeep_by_line();
                    assert!((lines.iter().sum::<f32>() - expected).abs() < 1e-6);
                    assert_eq!(
                        lines[LedgerLine::Untracked as usize],
                        0.0,
                        "no per-tile occupant may bill to an untracked line"
                    );
                    cases += 1;
                }
            }
        }
        assert_eq!(cases, TileKind::ALL.len() * 8 * 2);

        // The worst case a tile can carry.
        let everything = tile(
            TileKind::PowerLine,
            STRUCTURAL_FLAGS,
            Some(TileKind::WaterPipe),
        );
        assert!((everything.tile_upkeep_unfunded() - 0.42).abs() < 1e-6);
    }

    /// The point of the department tag: at **non-default** funding a bare sum
    /// of `upkeep_unfunded` is not the bill, and the four ledger lines are
    /// scaled by three different sliders. Both the per-line breakdown and the
    /// funded total are checked against the real `compute_daily_budget` over a
    /// city containing every (kind, flags, underground) combination.
    #[test]
    fn tile_upkeep_is_funded_per_department() {
        use crate::economy::compute_daily_budget;

        // 20 kinds × 8 flag combos × 2 underground states = 320 tiles.
        let combos: Vec<(TileKind, u8, Option<TileKind>)> = TileKind::ALL
            .iter()
            .flat_map(|&kind| {
                structural_flag_combos().into_iter().flat_map(move |flags| {
                    [None, Some(TileKind::WaterPipe)]
                        .into_iter()
                        .map(move |ug| (kind, flags, ug))
                })
            })
            .collect();
        assert_eq!(combos.len(), 320);

        let mut s = GameState::new(20, 16, 0);
        assert_eq!(s.tiles.len(), combos.len());
        for (t, &(kind, flags, ug)) in s.tiles.iter_mut().zip(combos.iter()) {
            *t = tile(kind, flags, ug);
        }

        // Deliberately lopsided, and none of them the default 100%: transport
        // at a quarter, power at four fifths, civic switched off entirely. A
        // scalar upkeep cannot reconstruct any of the four lines from these.
        s.policies.budget = BudgetPolicy {
            fund_transport: 25,
            fund_power: 80,
            fund_civic: 0,
            ..BudgetPolicy::default()
        };
        let policy = s.policies.budget;
        let b = compute_daily_budget(&s);

        // Per-line: rebuild each BudgetStats maintenance field from the table.
        let mut lines = [0.0_f32; LEDGER_LINE_COUNT];
        for t in &s.tiles {
            for (acc, add) in lines.iter_mut().zip(t.tile_upkeep_by_line()) {
                *acc += add;
            }
        }
        let funded =
            |line: LedgerLine, dept: FundingDept| lines[line as usize] * dept.multiplier(&policy);
        let expect = [
            (
                "maint_roads",
                b.maint_roads,
                funded(LedgerLine::Roads, FundingDept::Transport),
            ),
            (
                "maint_rail",
                b.maint_rail,
                funded(LedgerLine::Rail, FundingDept::Transport),
            ),
            (
                "maint_power_lines",
                b.maint_power_lines,
                funded(LedgerLine::PowerLines, FundingDept::Power),
            ),
            (
                "maint_pipes",
                b.maint_pipes,
                funded(LedgerLine::Pipes, FundingDept::Civic),
            ),
        ];
        println!("\nledger line → economy.rs vs occupant table (25/80/0 funding)");
        for (name, ledger, rebuilt) in expect {
            println!("  {name:<18} {ledger:>8.3} {rebuilt:>8.3}");
            assert!(
                (ledger - rebuilt).abs() < 1e-3,
                "{name}: economy.rs says {ledger}, the occupant table rebuilt {rebuilt}"
            );
        }

        // Total: the sum of the funded per-tile upkeeps is the sum of the four
        // lines, and — the actual defect — it is *not* the unfunded sum.
        let ledger_total = b.maint_roads + b.maint_rail + b.maint_power_lines + b.maint_pipes;
        let funded_total: f32 = s.tiles.iter().map(|t| t.tile_upkeep_funded(&policy)).sum();
        let unfunded_total: f32 = s.tiles.iter().map(|t| t.tile_upkeep_unfunded()).sum();
        println!(
            "  {:<18} {ledger_total:>8.3} {funded_total:>8.3}  (unfunded {unfunded_total:.3})",
            "total"
        );
        assert!((funded_total - ledger_total).abs() < 1e-2);
        assert!(
            (unfunded_total - ledger_total).abs() > 1.0,
            "the test would be worthless if the unfunded sum also matched"
        );

        // Civic funding is off, so every pipe is free and nothing else changes.
        assert_eq!(b.maint_pipes, 0.0);
        assert!(lines[LedgerLine::Pipes as usize] > 0.0);
    }

    /// Every department tag matches what `economy.rs` actually does to that
    /// line, checked one slider at a time on a single-feature city.
    #[test]
    fn every_funding_department_scales_its_own_line() {
        use crate::economy::compute_daily_budget;

        // One tile carrying a road, a rail, a hydro line and a buried pipe.
        let mut s = GameState::new(1, 1, 0);
        s.tiles[0] = tile(
            TileKind::Road,
            FLAG_RAIL_UNDERLAY | FLAG_POWER_OVERLAY,
            Some(TileKind::WaterPipe),
        );
        assert_eq!(
            s.tiles[0].occupants(),
            B_ROAD | B_RAIL | B_POWER_LINE | B_PIPE
        );

        // Halve one department at a time; only its own lines may move.
        for (dept, set_level) in [
            (
                FundingDept::Transport,
                (|p: &mut BudgetPolicy| p.fund_transport = 50) as fn(&mut BudgetPolicy),
            ),
            (FundingDept::Power, |p: &mut BudgetPolicy| p.fund_power = 50),
            (FundingDept::Civic, |p: &mut BudgetPolicy| p.fund_civic = 50),
        ] {
            let mut policy = BudgetPolicy::default();
            set_level(&mut policy);
            s.policies.budget = policy;
            let b = compute_daily_budget(&s);
            let got = [
                b.maint_roads,
                b.maint_rail,
                b.maint_power_lines,
                b.maint_pipes,
            ];
            for (line, ledger) in [
                LedgerLine::Roads,
                LedgerLine::Rail,
                LedgerLine::PowerLines,
                LedgerLine::Pipes,
            ]
            .into_iter()
            .zip(got)
            {
                // Find the occupant that owns this line and check its tag
                // predicted the halving.
                let owner = ALL_OCCUPANTS
                    .into_iter()
                    .find(|&o| occupant_def(o).ledger == line)
                    .expect("every tracked line has exactly one occupant");
                let def = occupant_def(owner);
                let expected = def.upkeep_unfunded * def.funding.multiplier(&policy);
                assert!(
                    (ledger - expected).abs() < 1e-6,
                    "{line:?} under halved {dept:?}: economy.rs {ledger}, table {expected}"
                );
                assert_eq!(
                    def.funding == dept,
                    (ledger - def.upkeep_unfunded).abs() > 1e-6,
                    "{line:?} must move if and only if it belongs to {dept:?}"
                );
            }
        }
    }

    /// No two tracked ledger lines share an occupant, and no occupant charges
    /// upkeep without saying which department pays and which line reports it.
    #[test]
    fn upkeep_always_carries_a_department_and_a_line() {
        let mut seen: Vec<LedgerLine> = Vec::new();
        for o in ALL_OCCUPANTS {
            let def = occupant_def(o);
            if def.upkeep_unfunded == 0.0 {
                assert_eq!(
                    def.ledger,
                    LedgerLine::Untracked,
                    "{o:?} bills nothing, so it must not claim a ledger line"
                );
                assert_eq!(def.funding, FundingDept::Unfunded, "{o:?}");
                continue;
            }
            assert_ne!(
                def.ledger,
                LedgerLine::Untracked,
                "{o:?} charges {} a day with no ledger line",
                def.upkeep_unfunded
            );
            assert_ne!(
                def.funding,
                FundingDept::Unfunded,
                "{o:?} charges {} a day with no funding department",
                def.upkeep_unfunded
            );
            assert!(
                !seen.contains(&def.ledger),
                "{:?} claimed twice",
                def.ledger
            );
            seen.push(def.ledger);
        }
        assert_eq!(seen.len(), LEDGER_LINE_COUNT - 1, "one per tracked line");
        assert_eq!(ALL_LEDGER_LINES.len(), LEDGER_LINE_COUNT);
        for (i, line) in ALL_LEDGER_LINES.into_iter().enumerate() {
            assert_eq!(line as usize, i, "ALL_LEDGER_LINES must be in index order");
        }
    }

    // --- conducts ---------------------------------------------------------

    /// `conducts(Water)` must be byte-identical to `is_water_carrier`, and
    /// `conducts(Power)` must be identical to `is_power_carrier` *except* on
    /// tiles that carry a hydro line only through `FLAG_POWER_OVERLAY` while
    /// nothing else conducts — the same "checked `kind`, forgot the flag" bug
    /// this module exists to close. That divergence set is pinned here so
    /// step 2 signs up for it knowingly.
    #[test]
    fn conducts_versus_todays_carrier_predicates() {
        let mut power_divergences = 0usize;
        // Recorded rather than asserted case by case: an `assert_eq!` inside
        // the loop would panic before the count below could ever be read, so
        // `water_divergences == 0` would be asserting a constant against
        // itself. Collecting first makes that assertion the real check, and
        // the failure message still names every offending tile.
        let mut water_divergences: Vec<String> = Vec::new();
        let mut traffic_divergences = 0usize;
        let mut cases = 0usize;

        // A two-tile probe city for `adjacency::has_road_access`, which is a
        // query about a tile's *neighbours*: the tile under test sits at (0, 0)
        // and the question is asked at (1, 0), whose only neighbour it is. The
        // tile at (1, 0) is never read by the query, so it can stay bare land.
        let mut probe = GameState::new(2, 1, 0);

        for &kind in TileKind::ALL {
            for flags in structural_flag_combos() {
                for underground in [None, Some(TileKind::WaterPipe)] {
                    for building_id in [None, Some(1u16)] {
                        for mw in [0i32, 100] {
                            let t = Tile {
                                kind,
                                flags,
                                underground,
                                building_id,
                                power_plant_mw: mw,
                                ..Tile::land()
                            };
                            cases += 1;

                            // --- water: no divergence permitted ---
                            if t.conducts(Network::Water) != is_water_carrier_pub(&t) {
                                water_divergences.push(format!(
                                    "{kind:?} flags={flags:#010b} ug={underground:?} \
                                     bid={building_id:?} mw={mw}"
                                ));
                            }

                            // --- power: exactly one documented divergence ---
                            let ghost_line = t.has_power_overlay()
                                && kind != TileKind::PowerLine
                                && !t.has_occupant(Occupant::Road)
                                && !t.has_occupant(Occupant::Rail)
                                && t.zone_occupant().is_none()
                                && building_id.is_none()
                                && mw == 0;
                            let diverged = t.conducts(Network::Power) != is_power_carrier_pub(&t);
                            assert_eq!(
                                diverged, ghost_line,
                                "power: {kind:?} flags={flags:#010b} ug={underground:?} \
                                 bid={building_id:?} mw={mw} — divergence must occur exactly \
                                 when a line is recorded only in FLAG_POWER_OVERLAY"
                            );
                            if diverged {
                                assert!(t.conducts(Network::Power) && !is_power_carrier_pub(&t));
                                power_divergences += 1;
                            }

                            // --- traffic: Road only ---
                            assert_eq!(
                                t.conducts(Network::Traffic),
                                kind == TileKind::Road || t.has_road_underlay()
                            );
                            // `adjacency::has_road_access` also accepts a bare
                            // PowerLine tile — compensation for hydro owning
                            // `kind` on a road tile, not a claim that lines
                            // carry traffic. Rewriting it is a behaviour change.
                            // The real function is called, not a copy of its
                            // condition, so that widening or narrowing it shows
                            // up here as a changed divergence count.
                            probe.tiles[0] = t.clone();
                            let adjacency_says = has_road_access(&probe, 1, 0);
                            if t.conducts(Network::Traffic) != adjacency_says {
                                traffic_divergences += 1;
                                assert_eq!(kind, TileKind::PowerLine);
                                assert!(!t.has_road_underlay());
                            }
                        }
                    }
                }
            }
        }

        assert_eq!(cases, TileKind::ALL.len() * 8 * 2 * 2 * 2);
        assert!(
            water_divergences.is_empty(),
            "water must convert with an empty diff — {} tiles disagreed: {:?}",
            water_divergences.len(),
            water_divergences
        );
        assert_eq!(
            power_divergences, 28,
            "tiles whose only conductor is a FLAG_POWER_OVERLAY line: 14 kinds \
             (all but Road, Rail, the three zones and PowerLine itself) × 2 \
             underground states, with the overlay as the only structural flag"
        );
        assert_eq!(
            traffic_divergences, 32,
            "bare PowerLine tiles that adjacency.rs treats as road access"
        );
    }

    #[test]
    fn structures_conduct_through_development_not_the_tag() {
        // A live park: building_id set.
        let live = Tile {
            kind: TileKind::Park,
            building_id: Some(7),
            ..Tile::land()
        };
        assert!(live.has_occupant(Occupant::Structure));
        assert!(live.conducts(Network::Power));
        assert!(live.conducts(Network::Water));
        assert!(!live.has_ghost_structure());

        // The ghost `remove_building` leaves behind: kind kept, id cleared.
        let ghost = tile(TileKind::Park, 0, None);
        assert!(ghost.has_occupant(Occupant::Structure));
        assert!(!ghost.conducts(Network::Power));
        assert!(!ghost.conducts(Network::Water));
        assert!(ghost.has_ghost_structure());

        // A power plant conducts from its output even before roll-up.
        let plant = Tile {
            kind: TileKind::CoalPlant,
            power_plant_mw: 500,
            ..Tile::land()
        };
        assert!(plant.conducts(Network::Power));
    }

    #[test]
    fn a_developed_zone_lot_is_not_a_structure() {
        // `zones.rs` grows a lot in place: kind stays Residential, building_id
        // is set. If that derived `Structure` as well, the
        // Zone-conflicts-Structure rule would fire on every grown lot.
        let lot = Tile {
            kind: TileKind::Residential,
            building_id: Some(3),
            ..Tile::land()
        };
        assert_eq!(lot.occupants(), B_ZONE_R);
        assert!(!lot.has_occupant(Occupant::Structure));
        assert_eq!(validate_set(lot.occupants()), Ok(()));
        assert_eq!(lot.zone_occupant(), Some(Occupant::ZoneResidential));
        assert_eq!(lot.structure_kind(), None);
    }

    // --- eco --------------------------------------------------------------

    /// The eco sum reproduces `base_eco[kind]` on every single-occupant tile.
    /// Exactly one kind diverges, deliberately, and it is named in the loop:
    /// a surface `WaterPipe` keeps the bare-land credit because its occupant
    /// set is empty.
    #[test]
    fn tile_eco_matches_base_eco_on_single_occupant_tiles() {
        let t = WildernessTunables::default();
        println!("\nTileKind → tile_eco vs base_eco[kind]");
        for &kind in TileKind::ALL {
            let tl = tile(kind, 0, None);
            let got = tl.tile_eco(&t);
            let today = t.base_eco[kind as usize];
            println!(
                "  {:<16} {got:>6.1}   (today {today:>6.1})",
                kind.ts_string()
            );
            if kind == TileKind::WaterPipe {
                // A *surface* WaterPipe derives to the empty set, so it keeps
                // the open-land credit rather than scoring 0.0. Unreachable
                // from any tool; only `import.rs` can produce it.
                assert_eq!(got, 1.0);
                assert_eq!(today, 0.0);
                continue;
            }
            assert_eq!(got, today, "{kind:?}");
        }

        // The buried pipe keeps the open-land credit — the visible-set gate is
        // what makes that exact.
        assert_eq!(
            tile(TileKind::Land, 0, Some(TileKind::WaterPipe)).tile_eco(&t),
            1.0
        );
        assert_eq!(
            tile(TileKind::Tree, 0, Some(TileKind::WaterPipe)).tile_eco(&t),
            6.0
        );

        // The multi-occupant tile is where the model intentionally changes the
        // number: this is the open wilderness.rs bug the exercise exists to fix.
        let road_with_line = tile(TileKind::Road, FLAG_POWER_OVERLAY, None);
        let line_over_road = tile(
            TileKind::PowerLine,
            FLAG_ROAD_UNDERLAY | FLAG_POWER_OVERLAY,
            None,
        );
        assert_eq!(road_with_line.occupants(), line_over_road.occupants());
        assert_eq!(road_with_line.tile_eco(&t), -3.0);
        assert_eq!(line_over_road.tile_eco(&t), -3.0);
        // Today the two spellings score differently — that is the bug.
        assert_eq!(t.base_eco[TileKind::Road as usize], -2.0);
        assert_eq!(t.base_eco[TileKind::PowerLine as usize], -1.0);

        // Level crossing: -4.0 against today's -2.0.
        assert_eq!(
            tile(TileKind::Rail, FLAG_ROAD_UNDERLAY, None).tile_eco(&t),
            -4.0
        );
    }

    #[test]
    fn zone_industrial_eco_follows_the_green_industry_policy() {
        use city_sim_protocol::commands::WildernessPolicy;
        let base = WildernessTunables::default();
        let ind = tile(TileKind::Industrial, 0, None);
        assert_eq!(occupant_eco(Occupant::ZoneIndustrial, &base), Some(-5.0));
        assert_eq!(ind.tile_eco(&base), -5.0);

        let green = base.effective(&WildernessPolicy {
            green_industry: true,
            ..Default::default()
        });
        assert_eq!(
            occupant_eco(Occupant::ZoneIndustrial, &green),
            Some(-2.0),
            "a static eco in OccupantDef would silently disable Green Industry"
        );
        assert_eq!(ind.tile_eco(&green), -2.0);
    }

    /// Pins the eco value and breakdown line of all ten structure kinds, and
    /// pins `Structure` as the one tag that refuses to answer for itself. The
    /// ten values are *not* distinct — −1.0 appears six times and +4.0 twice —
    /// so distinctness is not what is checked here; what matters is that the
    /// spread survives, which the park-versus-coal gap at the end pins.
    #[test]
    fn structure_eco_and_category_come_from_the_kind_not_the_tag() {
        let t = WildernessTunables::default();
        let table = [
            (TileKind::Park, 4.0, EcoCategory::Parks),
            (TileKind::ParkLarge, 4.0, EcoCategory::Parks),
            (TileKind::HydroPlant, -2.0, EcoCategory::Power),
            (TileKind::CoalPlant, -8.0, EcoCategory::Power),
            (TileKind::WindTurbine, -1.0, EcoCategory::Power),
            (TileKind::SolarFarm, -1.0, EcoCategory::Power),
            (TileKind::WaterPump, -1.0, EcoCategory::Civic),
            (TileKind::WaterTower, -1.0, EcoCategory::Civic),
            (TileKind::ElementarySchool, -1.0, EcoCategory::Civic),
            (TileKind::HighSchool, -1.0, EcoCategory::Civic),
        ];
        assert_eq!(
            table.len(),
            TileKind::ALL
                .iter()
                .filter(|k| is_structure_kind(**k))
                .count(),
            "a structure kind was added without an eco entry"
        );
        for (kind, eco, category) in table {
            assert_eq!(structure_eco(kind, &t), eco, "{kind:?}");
            assert_eq!(structure_category(kind), category, "{kind:?}");
            assert_eq!(tile(kind, 0, None).tile_eco(&t), eco, "{kind:?}");
        }
        // The `Structure` tag cannot answer, and says so rather than handing
        // back a `0.0` that looks like an answer. The compiler forces the
        // caller to unwrap, and the only correct unwrap is `structure_eco`.
        assert_eq!(
            occupant_def(Occupant::Structure).eco,
            EcoSource::PerStructureKind
        );
        assert_eq!(occupant_eco(Occupant::Structure, &t), None);
        assert_eq!(occupant_category(Occupant::Structure), None);
        assert_eq!(occupant_is_strong_nature(Occupant::Structure), None);
        // Every other occupant *can* answer, so `Structure` is the only hole.
        for o in ALL_OCCUPANTS {
            let answerable = o != Occupant::Structure;
            assert_eq!(occupant_eco(o, &t).is_some(), answerable, "{o:?} eco");
            assert_eq!(occupant_category(o).is_some(), answerable, "{o:?} category");
            assert_eq!(
                occupant_is_strong_nature(o).is_some(),
                answerable,
                "{o:?} strong_nature"
            );
        }
        // The reserved occupants really do score nothing — that is a different
        // answer from "cannot be answered", and the type keeps them apart.
        assert_eq!(occupant_eco(Occupant::Subway, &t), Some(0.0));
        assert_eq!(occupant_eco(Occupant::Fibre, &t), Some(0.0));

        // The park/coal spread is the thing a flattened constant would destroy.
        let spread = structure_eco(TileKind::Park, &t) - structure_eco(TileKind::CoalPlant, &t);
        assert_eq!(spread, 12.0);
        // …and it survives every route into the score, not just `structure_eco`.
        let park = tile(TileKind::Park, 0, None);
        let coal = tile(TileKind::CoalPlant, 0, None);
        assert_eq!(park.tile_eco(&t) - coal.tile_eco(&t), 12.0);
        assert_eq!(park.occupants(), coal.occupants(), "same tag, same bit");
    }

    #[test]
    fn strong_nature_matches_the_wilderness_rule() {
        for &kind in TileKind::ALL {
            // The rule itself, not a copy of it: a local `matches!` would go on
            // agreeing with itself after `wilderness.rs` changed.
            let expected = crate::wilderness::is_strong_nature(kind);
            assert_eq!(
                tile(kind, 0, None).is_strong_nature(),
                expected,
                "{kind:?}: must match wilderness::is_strong_nature"
            );
        }
        assert_eq!(occupant_is_strong_nature(Occupant::Trees), Some(true));
        assert_eq!(occupant_is_strong_nature(Occupant::Road), Some(false));
        // Not `Some(false)`: a park is strong nature and a park is a
        // `Structure`, so the tag alone must refuse to answer.
        assert_eq!(occupant_is_strong_nature(Occupant::Structure), None);
        assert!(tile(TileKind::Park, 0, None).is_strong_nature());
        assert!(!tile(TileKind::CoalPlant, 0, None).is_strong_nature());
    }

    /// Every [`EcoCategory`] must be produced by something. `OpenLand` was
    /// declared and unreachable: `wilderness.rs` credits a bare `Land` tile
    /// +1.0 to `breakdown.open_land`, but no *occupant* is open land, so only
    /// `terrain_category` can produce it.
    #[test]
    fn every_eco_category_is_produced() {
        let mut produced: Vec<EcoCategory> = Vec::new();
        let note = |c: EcoCategory, produced: &mut Vec<EcoCategory>| {
            if !produced.contains(&c) {
                produced.push(c);
            }
        };

        for o in ALL_OCCUPANTS {
            if let Some(c) = occupant_category(o) {
                note(c, &mut produced);
            }
        }
        for &kind in TileKind::ALL {
            if is_structure_kind(kind) {
                note(structure_category(kind), &mut produced);
            }
            if let Some(c) = tile(kind, 0, None).terrain_category() {
                note(c, &mut produced);
            }
        }

        println!("\nproduced eco categories: {produced:?}");
        for c in EcoCategory::ALL {
            assert!(produced.contains(&c), "{c:?} is declared but unreachable");
        }
        assert_eq!(produced.len(), EcoCategory::ALL.len());
    }

    /// Pins the breakdown category of **every** occupant and **every**
    /// structure kind, twice over: against a literal expectation, and against
    /// the line `wilderness.rs` actually files that tile on.
    ///
    /// `OccupantDef::category` is the field step 2's wilderness conversion
    /// reads, and until this test existed all eleven of its values were
    /// unverified claims — four of them could be corrupted at once (Road
    /// Transport→Power, PowerLine Power→Civic, Trees Forests→Neutral,
    /// ZoneIndustrial Industry→Zones) with the whole workspace staying green.
    ///
    /// Both halves are load-bearing. The literal table catches a change to
    /// `wilderness.rs` and a matching change to `OCCUPANT_DEFS` that cancel
    /// out; the measured half catches the table drifting away from the game.
    /// The expectations are arrays of length [`OCCUPANT_COUNT`] and of the
    /// structure-kind count, so a newly added occupant or structure fails to
    /// **compile** until it has been classified.
    #[test]
    fn every_occupant_and_structure_kind_has_a_pinned_breakdown_category() {
        let expected: [(Occupant, Option<EcoCategory>); OCCUPANT_COUNT] = [
            // A buried pipe files nowhere: `wilderness.rs` matches
            // `Water | WaterPipe => {}`.
            (Occupant::Pipe, Some(EcoCategory::Neutral)),
            // Reserved: no tool, no TileKind, so nothing can file them at all.
            (Occupant::Subway, Some(EcoCategory::Neutral)),
            (Occupant::Fibre, Some(EcoCategory::Neutral)),
            (Occupant::Road, Some(EcoCategory::Transport)),
            (Occupant::Rail, Some(EcoCategory::Transport)),
            (Occupant::ZoneResidential, Some(EcoCategory::Zones)),
            (Occupant::ZoneCommercial, Some(EcoCategory::Zones)),
            // Industry is its own line — not `Zones`, which is R and C only.
            (Occupant::ZoneIndustrial, Some(EcoCategory::Industry)),
            // The one tag that cannot answer: a park is `Parks` and a coal
            // plant is `Power`, and both arrive as `Structure`.
            (Occupant::Structure, None),
            (Occupant::PowerLine, Some(EcoCategory::Power)),
            (Occupant::Trees, Some(EcoCategory::Forests)),
        ];

        println!("\noccupant → category (OCCUPANT_DEFS vs wilderness.rs)");
        for o in ALL_OCCUPANTS {
            let want = expected
                .iter()
                .find(|(k, _)| *k == o)
                .unwrap_or_else(|| {
                    panic!("{o:?} has no pinned breakdown category — classify it here")
                })
                .1;
            assert_eq!(
                occupant_category(o),
                want,
                "{o:?}: OCCUPANT_DEFS disagrees with the pinned category"
            );

            // The pin itself, checked against the game: whichever `TileKind`
            // the occupant derives its eco from is the kind `wilderness.rs`
            // would be looking at.
            let measured = match occupant_def(o).eco {
                EcoSource::Kind(kind) => Some(breakdown_line_for(kind)),
                EcoSource::Zero => Some(EcoCategory::Neutral),
                EcoSource::PerStructureKind => None,
            };
            println!(
                "  {:<18} {:?}",
                format!("{o:?}"),
                want.map_or("per structure kind".to_string(), |c| format!("{c:?}"))
            );
            assert_eq!(
                want, measured,
                "{o:?}: the pinned category is not the line wilderness.rs uses"
            );
        }

        let structures: [(TileKind, EcoCategory); 10] = [
            (TileKind::HydroPlant, EcoCategory::Power),
            (TileKind::CoalPlant, EcoCategory::Power),
            (TileKind::WindTurbine, EcoCategory::Power),
            (TileKind::SolarFarm, EcoCategory::Power),
            (TileKind::WaterPump, EcoCategory::Civic),
            (TileKind::WaterTower, EcoCategory::Civic),
            (TileKind::ElementarySchool, EcoCategory::Civic),
            (TileKind::HighSchool, EcoCategory::Civic),
            (TileKind::Park, EcoCategory::Parks),
            (TileKind::ParkLarge, EcoCategory::Parks),
        ];
        assert_eq!(
            structures.len(),
            TileKind::ALL
                .iter()
                .filter(|k| is_structure_kind(**k))
                .count(),
            "a structure kind was added without a breakdown category"
        );

        println!("structure kind → category (structure_category vs wilderness.rs)");
        for &kind in TileKind::ALL {
            if !is_structure_kind(kind) {
                continue;
            }
            let want = structures
                .iter()
                .find(|(k, _)| *k == kind)
                .unwrap_or_else(|| panic!("{kind:?} has no pinned breakdown category"))
                .1;
            println!("  {:<18} {want:?}", kind.ts_string());
            assert_eq!(structure_category(kind), want, "{kind:?}");
            assert_eq!(
                want,
                breakdown_line_for(kind),
                "{kind:?}: the pinned category is not the line wilderness.rs uses"
            );
        }

        // Exhaustive over `TileKind`: whichever route a bare tile's eco takes
        // — occupant tag, structure kind, or terrain — must land on the line
        // `wilderness.rs` files that tile on.
        println!("TileKind → derived category vs wilderness.rs");
        for &kind in TileKind::ALL {
            let tl = tile(kind, 0, None);
            let derived = if is_structure_kind(kind) {
                structure_category(kind)
            } else {
                let mut present = iter_set(tl.occupants());
                let first = present.next();
                assert_eq!(
                    present.count(),
                    0,
                    "{kind:?}: a bare non-structure tile must derive at most one occupant"
                );
                match first {
                    Some(o) => occupant_category(o)
                        .expect("only Structure refuses to answer, and it is handled above"),
                    // Nothing on the surface: the terrain answers, and `None`
                    // there means "files on no line", i.e. Neutral.
                    None => tl.terrain_category().unwrap_or(EcoCategory::Neutral),
                }
            };
            let measured = breakdown_line_for(kind);
            println!("  {:<18} {derived:?}", kind.ts_string());
            if kind == TileKind::WaterPipe {
                // The one divergence, and it is deliberate. A *surface*
                // WaterPipe derives to the empty occupant set (no tool has
                // ever written one; only `import.rs` can produce it), so the
                // occupant model hands it the open-land credit while
                // `wilderness.rs` files its 0.0 nowhere. Same divergence
                // `tile_eco_matches_base_eco_on_single_occupant_tiles` pins.
                assert_eq!(derived, EcoCategory::OpenLand);
                assert_eq!(measured, EcoCategory::Neutral);
                continue;
            }
            assert_eq!(
                derived, measured,
                "{kind:?}: derived category is not the line wilderness.rs uses"
            );
        }
    }

    /// `terrain_category` is the routing half of `terrain_eco`: the two must
    /// agree about when the open-land credit applies, over the whole (kind,
    /// flags, underground) space.
    #[test]
    fn terrain_category_tracks_the_open_land_credit() {
        let t = WildernessTunables::default();
        let bare = tile(TileKind::Land, 0, None);
        assert_eq!(bare.terrain_category(), Some(EcoCategory::OpenLand));
        assert_eq!(bare.terrain_eco(&t), 1.0);

        // Water files its (zero) value on no line, exactly as `wilderness.rs`
        // does with its `Water | WaterPipe => {}` arm. The sweep below reads
        // "no credit" off a zero eco, which is only sound while water scores
        // zero — so pin that.
        assert_eq!(t.base_eco[TileKind::Water as usize], 0.0);
        assert_eq!(Tile::water().terrain_category(), None);
        assert_eq!(Tile::water().terrain_eco(&t), 0.0);

        // A buried pipe leaves the surface open, so the credit stands.
        let piped = tile(TileKind::Land, 0, Some(TileKind::WaterPipe));
        assert_eq!(piped.terrain_category(), Some(EcoCategory::OpenLand));
        assert_eq!(piped.terrain_eco(&t), 1.0);

        // Anything visible takes the credit away — including a hydro line that
        // only exists as a flag, which is the spelling `wilderness.rs` misses.
        let flagged = tile(TileKind::Land, FLAG_POWER_OVERLAY, None);
        assert_eq!(flagged.terrain_category(), None);
        assert_eq!(flagged.terrain_eco(&t), 0.0);

        let mut open = 0usize;
        for &kind in TileKind::ALL {
            for flags in structural_flag_combos() {
                for underground in [None, Some(TileKind::WaterPipe)] {
                    let tl = tile(kind, flags, underground);
                    let credited = tl.terrain_eco(&t) != 0.0;
                    assert_eq!(
                        tl.terrain_category() == Some(EcoCategory::OpenLand),
                        credited,
                        "{kind:?} flags={flags:#010b}: category and credit disagree"
                    );
                    if credited {
                        open += 1;
                    }
                }
            }
        }
        // Land and a surface WaterPipe are the only kinds with no visible
        // occupant, and only with no structural flags set; the underground
        // state is orthogonal.
        assert_eq!(open, 2 * 2, "Land and WaterPipe, flags=0, ×2 underground");
    }

    // --- misc accessors ---------------------------------------------------

    #[test]
    fn visible_occupants_excludes_the_underground() {
        let t = tile(
            TileKind::Road,
            FLAG_POWER_OVERLAY,
            Some(TileKind::WaterPipe),
        );
        assert_eq!(t.occupants(), B_PIPE | B_ROAD | B_POWER_LINE);
        assert_eq!(t.visible_occupants(), B_ROAD | B_POWER_LINE);
        assert_eq!(t.occupants_in(Stratum::Underground), B_PIPE);
        assert_eq!(t.occupants_in(Stratum::Surface), B_ROAD);
        assert_eq!(t.occupants_in(Stratum::Overhead), B_POWER_LINE);
        assert_eq!(
            t.occupants_in(Stratum::Underground)
                | t.occupants_in(Stratum::Surface)
                | t.occupants_in(Stratum::Overhead),
            t.occupants()
        );
    }

    #[test]
    fn iter_set_is_in_bit_order_and_round_trips() {
        let set = B_TREES | B_ROAD | B_PIPE | B_POWER_LINE;
        let got: Vec<Occupant> = iter_set(set).collect();
        assert_eq!(
            got,
            vec![
                Occupant::Pipe,
                Occupant::Road,
                Occupant::PowerLine,
                Occupant::Trees
            ]
        );
        let rebuilt = got.iter().fold(0, |acc, &o| acc | occupant_bit(o));
        assert_eq!(rebuilt, set);
        assert_eq!(iter_set(0).count(), 0);
        assert_eq!(iter_set(ALL_MASK).count(), OCCUPANT_COUNT);
    }

    #[test]
    fn terrain_survives_its_occupants() {
        // `Tool::TerraformLower` leaves `building_id` set on a tile that has
        // become water, so a Water tile can carry occupants today. Terrain is
        // still Water, and it contributes no bit.
        let drowned = Tile {
            kind: TileKind::Water,
            flags: FLAG_ROAD_UNDERLAY,
            building_id: Some(2),
            ..Tile::land()
        };
        assert_eq!(drowned.terrain(), Terrain::Water);
        assert_eq!(drowned.occupants(), B_ROAD);
        assert_eq!(Tile::land().terrain(), Terrain::Land);
        assert_eq!(Tile::water().terrain(), Terrain::Water);
        assert_eq!(Tile::land().occupants(), 0);
        assert_eq!(Tile::water().occupants(), 0, "terrain is not an occupant");
    }
}
