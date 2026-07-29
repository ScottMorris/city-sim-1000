// occupants.rs — stratum/occupant model: what stands on a tile, and its table.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

//! The occupant model, the canonical representation of a tile since step 3 of
//! the migration tracked in #177. The design note it implements is
//! `docs/tile-model.md`; "the design note" below always means that file.
//!
//! A tile used to record its infrastructure in two places — the single-valued
//! `Tile::kind` and the structural flags `FLAG_ROAD_UNDERLAY`,
//! `FLAG_RAIL_UNDERLAY`, `FLAG_POWER_OVERLAY` — so a road carrying a hydro
//! line had *two* legal spellings depending on build order. Every consumer
//! that read `kind` and forgot the flags silently under-counted; that same bug
//! was found in `economy.rs`, `wilderness.rs`, `tileRenderUtils.ts` and
//! `commands.rs` while `kind` was still canonical.
//!
//! Now `Tile::terrain` holds the ground and `Tile::occupants` holds everything
//! standing on, over or under it, one bit per [`Occupant`]. There is one
//! spelling, no precedence, and nothing to reconcile. `TileKind` no longer
//! describes a tile at all, but it survives as three other things — the last
//! of which is still canonical, for the structure rather than for the tile:
//! the *wire vocabulary* (the
//! `kind` byte of the SoA tile buffer — see `display.rs`), the *building
//! template key* (`BuildingInstance::kind`), and the *wilderness tunables key*
//! (`WildernessTunables::base_eco[kind]`, which [`EcoSource::Kind`] indirects
//! through so Green Industry keeps working).
//!
//! Three strata, stacked the way the world is:
//!
//! | stratum     | occupants                                  | default |
//! | ----------- | ------------------------------------------ | ------- |
//! | underground | Pipe, Subway*, Fibre*                      | coexist |
//! | surface     | Road, Rail, Zone{R,C,I}, Structure         | conflict |
//! | overhead    | PowerLine, Trees                           | conflict |
//!
//! (* reserved — no tool and no way to build them yet. The bits are claimed so
//! the underground mask stays stable now that the set is persisted.)
//!
//! Terrain (`Land` | `Water`) is a separate concept from occupants: it
//! contributes no occupant bit, so a bare land tile and a water tile both have
//! an empty set.
//!
//! Terrain is stored but not yet what the design note describes. It wants
//! terrain to be the thing the bulldozer restores a tile to and the thing that
//! survives terraforming; the second holds by construction now, the first does
//! not — `bulldoze` still writes `Land`, and every tool that used to overwrite
//! `kind` still forces `Terrain::Land`. Teaching those tools to leave terrain
//! alone moves the wilderness buildable count, so it is step 4.
//!
//! **Precedence disappears.** `commands.rs` used to run a zone > hydro >
//! road/rail precedence purely to decide who owned the contested `kind` slot.
//! The occupant set is a union, so it never asks who won. The one place an
//! ordering survives is `display.rs`, which has to pick a single `kind` byte
//! for the wire — and that ordering is a *projection* concern, not a fact
//! about the tile.

use crate::economy::{MAINT_POWER_LINE, MAINT_RAIL, MAINT_ROAD, MAINT_WATER_PIPE};
use crate::state::{GameState, Tile};
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
/// Its own stored field on [`Tile`] since step 3, so it is no longer destroyed
/// by whatever is built on top. Behaviour has not caught up to it: every
/// tool that used to overwrite `kind` still writes `Terrain::Land`, and
/// `bulldoze` still writes `Land` rather than restoring water. Making terrain
/// survive construction moves the wilderness `buildable` count, so it is a
/// gameplay change of its own (#177 step 4).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, Default, serde::Serialize, serde::Deserialize,
)]
#[repr(u8)]
pub enum Terrain {
    #[default]
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
/// The three zone tags. Used by `commands.rs` to refuse a zone or a structure
/// over land already zoned; [`Tile::zone_occupant`] is the accessor for asking
/// *which* zone, since a tile carries at most one.
pub const ZONE_MASK: OccupantSet = B_ZONE_R | B_ZONE_C | B_ZONE_I;

/// All occupant bits currently in use. Bits 11–15 are spare — **note** that
/// inserting a new occupant into a full stratum shifts every bit above it, and
/// those bits become persisted data in step 3. Widen a stratum's range before
/// it is persisted, not after.
pub const ALL_MASK: OccupantSet = UNDERGROUND_MASK | SURFACE_MASK | OVERHEAD_MASK;

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
        // Enforced from both sides since step 2 of #177 — `Tool::PowerLine`
        // refuses a tile with a `building_id`, and `place_footprint_building`
        // now asks the occupant set rather than `kind`, so it sees a line in
        // either of its two spellings. See
        // `a_structure_is_refused_over_a_live_hydro_line`.
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
        why: "cross-stratum, but a line strung through a school or a power plant is not a tile the model admits: Tool::PowerLine refuses a tile that already carries a building, and place_footprint_building refuses a tile that already carries a line. The second half of that was missing until step 2 of #177 — the guard enumerated kind Road/Rail/PowerLine and the two underlay flags but never asked has_power_overlay(), so any tile whose line lived in the flag rather than in kind (zone, then string a line; or string a line, then TerraformRaise) took a structure on top of live, still-billed conductors. It asks the occupant set now, which answers the same for both spellings; see a_structure_is_refused_over_a_live_hydro_line",
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
/// **This describes the TARGET model, and today's game can still build one
/// tile it rejects.** Step 2 of #177 converted the placement guards in
/// `commands.rs` to ask the occupant set, which closed the structure route —
/// `Residential` → `PowerLine` → `Park` is refused now, in either spelling.
/// One producible violation survives:
///
/// - `PowerLine` → `Tree` plants a canopy through the conductors, because
///   `Tool::Tree` rewrites `kind` and clears only the *surface*, leaving
///   `FLAG_POWER_OVERLAY` set —
///   `known_defect_trees_are_planted_through_a_live_hydro_line`. This one is
///   not a guard that reads the wrong field, so converting the guards did not
///   reach it. Nor is it the two-spellings asymmetry: a line always sets the
///   overlay flag, so both its recordings survive a canopy alike. Refusing it
///   would also have to answer for `Tool::Water`, which flows through the same
///   overlay flag on purpose — a line over water is a pylon span — so it stays
///   a gameplay decision of its own.
///
/// `producible_conflicts_are_inventoried` closes the single-tile state space
/// under `apply_tool` and pins that list at exactly that one, so neither a
/// regression of the structure route nor a third defect can appear unnoticed.
///
/// **Advisory only.** Never panic on this result — log it, count it, or
/// `debug_assert` it, but let the save load. Saves in the wild already contain
/// violating tiles, including ones written before `regrade_refusal` stopped
/// the terrain brushes from drowning a live building.
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
// Structure identity
// ---------------------------------------------------------------------------

/// The `TileKind` a zone occupant's `BuildingInstance` is templated from.
///
/// The inverse of the three `ZoneX => TileKind::X` arms that used to live in
/// `Tile::zone_occupant`. `get_building_template` is indexed by `TileKind`, so
/// growing a lot needs the tag turned back into a template key; the tag itself
/// is what the *land use* question is asked of.
#[inline]
pub fn zone_template_kind(o: Occupant) -> Option<TileKind> {
    match o {
        Occupant::ZoneResidential => Some(TileKind::Residential),
        Occupant::ZoneCommercial => Some(TileKind::Commercial),
        Occupant::ZoneIndustrial => Some(TileKind::Industrial),
        _ => None,
    }
}

/// Which structure stands on a tile, resolved through its `building_id`.
///
/// [`Occupant::Structure`] is one flat tag, so the tile no longer records
/// whether it holds a coal plant (−8.0 eco) or a large park (+4.0). The
/// `BuildingInstance` the tile's `development` points at does, and this is the
/// index that makes asking it cheap: built once per pass in O(buildings), it
/// keeps `compute_wilderness` at O(N) rather than the O(N × B) a per-tile
/// `state.buildings.iter().find(…)` would cost over the whole grid twice a
/// recompute.
pub struct StructureLookup {
    /// Indexed by building id; `None` for ids that are not live buildings.
    kinds: Vec<Option<TileKind>>,
}

impl StructureLookup {
    /// Index every live building in `state` by id.
    pub fn new(state: &GameState) -> Self {
        let max_id = state
            .buildings
            .iter()
            .map(|b| b.id)
            .max()
            .unwrap_or(0)
            .max(state.next_building_id);
        let mut kinds = vec![None; max_id as usize + 1];
        for b in &state.buildings {
            kinds[b.id as usize] = Some(b.kind);
        }
        Self { kinds }
    }

    /// The template kind of the building with this id, if it is live.
    #[inline]
    pub fn kind_of(&self, id: u16) -> Option<TileKind> {
        self.kinds.get(id as usize).copied().flatten()
    }

    /// Which structure occupies the tile, if any.
    ///
    /// `None` for a developed zone lot: the lot carries a `building_id` and a
    /// `BuildingInstance` whose kind is `Residential`, but its occupant is a
    /// zone tag, not [`Occupant::Structure`].
    #[inline]
    pub fn structure_kind(&self, tile: &Tile) -> Option<TileKind> {
        if !tile.has_occupant(Occupant::Structure) {
            return None;
        }
        debug_assert!(
            tile.building_id.is_some(),
            "a Structure occupant with no development behind it — `remove_building` \
             must clear the tag along with the id"
        );
        tile.building_id.and_then(|id| self.kind_of(id))
    }
}

// ---------------------------------------------------------------------------
// Tile accessors over the canonical strata
// ---------------------------------------------------------------------------

impl Tile {
    /// Whether the tile carries a network.
    ///
    /// Reads `building_id` / `power_plant_mw` directly on top of the occupant
    /// set, because a developed lot conducts by virtue of being developed —
    /// that is a property of the development, not of any occupant.
    #[inline]
    pub fn conducts(&self, network: Network) -> bool {
        let set = self.occupants;
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
        set_upkeep_by_line(self.occupants)
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
        set_upkeep_unfunded(self.occupants)
    }

    /// Per-day upkeep for the tile's own infrastructure under `policy`, each
    /// feature scaled by its own department's funding level. Building
    /// maintenance is still billed separately off `state.buildings`.
    #[inline]
    pub fn tile_upkeep_funded(&self, policy: &BudgetPolicy) -> f32 {
        set_upkeep_funded(self.occupants, policy)
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
    /// variant exists: `wilderness::compute_wilderness` credits a bare `Land`
    /// tile +1.0 to `breakdown.open_land`, and nothing an *occupant* can do
    /// earns that line. Water is `None` — its (zero) value is filed nowhere,
    /// which is what the old `Water | WaterPipe => {}` arm expressed.
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
}

/// Base eco value of a tile: terrain plus the sum over its occupants.
///
/// The `Σ` is the point — a fifth network is one table row and every consumer
/// that sums picks it up for free. This is what `wilderness::compute_wilderness`
/// scores (#173): a road carrying a line is −3.0, against the −1.0 or −2.0 the
/// old `base_eco[kind]` lookup gave depending on which spelling the tile
/// happened to have. That function unrolls the sum rather than calling this,
/// because it also has to file each term on its own breakdown line; the two are
/// pinned equal by a `debug_assert` in its scoring loop.
///
/// A free function rather than a `Tile` method since step 3: a tile no longer
/// knows *which* structure stands on it, so the answer needs the
/// [`StructureLookup`] as well.
pub fn tile_eco(tile: &Tile, lookup: &StructureLookup, t: &WildernessTunables) -> f32 {
    let mut eco = tile.terrain_eco(t);
    for o in iter_set(tile.occupants) {
        // `None` means "the tag cannot answer" — today only `Structure`,
        // whose value comes from its kind.
        eco += match occupant_eco(o, t) {
            Some(v) => v,
            None => lookup
                .structure_kind(tile)
                .map_or(0.0, |k| structure_eco(k, t)),
        };
    }
    eco
}

/// Strong nature: earns the patch and water-edge bonuses and risks the
/// fragmentation penalty. Trees plus parks.
///
/// Takes the lookup for the same reason [`tile_eco`] does — a park is strong
/// nature and a coal plant is not, and both are [`Occupant::Structure`].
#[inline]
pub fn is_strong_nature(tile: &Tile, lookup: &StructureLookup) -> bool {
    iter_set(tile.occupants).any(|o| match occupant_is_strong_nature(o) {
        Some(strong) => strong,
        None => lookup
            .structure_kind(tile)
            .is_some_and(structure_is_strong_nature),
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adjacency::has_road_access;
    use crate::commands::apply_tool;
    use crate::migrate::{set_v4_kind, tile_from_v4};
    use crate::state::{FLAG_ABANDONED, FLAG_POWERED, FLAG_WATERED};
    use city_sim_protocol::commands::Tool;
    use city_sim_protocol::tile_buffer::flags::{
        POWER_OVERLAY as FLAG_POWER_OVERLAY, RAIL_UNDERLAY as FLAG_RAIL_UNDERLAY,
        ROAD_UNDERLAY as FLAG_ROAD_UNDERLAY,
    };

    // --- helpers ---------------------------------------------------------

    /// A tile spelled out by hand the way v4 spelled it: kind + structural
    /// flags + underground, decoded into the strata.
    ///
    /// Every occupant-model assertion below still poses its question in the
    /// old `kind`-and-flags vocabulary, which is the point — the answers must
    /// not have moved. A structure kind is given a development so it is not
    /// read as the ghost `tile_from_v4` drops.
    fn tile(kind: TileKind, flags: u8, underground: Option<TileKind>) -> Tile {
        let building_id = is_structure_kind(kind).then_some(1);
        tile_from_v4(kind, flags, underground, building_id)
    }

    /// The [`StructureLookup`] that goes with [`tile`]: building id 1 is a
    /// `kind`, which is the development `tile` hands every structure kind.
    fn lookup(kind: TileKind) -> StructureLookup {
        let mut s = GameState::new(1, 1, 0);
        s.buildings
            .push(crate::buildings::BuildingInstance::new(1, kind, (0, 0)));
        s.next_building_id = 2;
        StructureLookup::new(&s)
    }

    /// Eco of a hand-spelled v4 tile, with the matching lookup.
    fn eco_of(
        kind: TileKind,
        flags: u8,
        underground: Option<TileKind>,
        t: &WildernessTunables,
    ) -> f32 {
        tile_eco(&tile(kind, flags, underground), &lookup(kind), t)
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
    /// 0.0, on a grid of one `kind` tile surrounded by water — a filler whose
    /// terrain has no [`EcoCategory`] at all, so it files its value on no
    /// line. The three
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
            *tl = crate::state::Tile::water();
        }
        // A structure's eco comes from its development, so the probe needs a
        // `BuildingInstance` behind it or it is scored as bare ground.
        if is_structure_kind(kind) {
            s.tiles[4] = crate::state::Tile::land();
            s.tiles[4].set_occupant(Occupant::Structure, true);
            s.tiles[4].building_id = Some(1);
            s.buildings
                .push(crate::buildings::BuildingInstance::new(1, kind, (1, 1)));
            s.next_building_id = 2;
        } else {
            set_v4_kind(&mut s.tiles[4], kind);
        }

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

    /// Branch-free "set this bit when the predicate holds".
    fn bit_when(present: bool, o: Occupant) -> OccupantSet {
        if present {
            occupant_bit(o)
        } else {
            0
        }
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
        assert_eq!(t.occupants, B_TREES | B_POWER_LINE);
        assert!(validate_set(t.occupants).is_err());
    }

    // --- placement: the table enforced, and what still escapes it -----------
    //
    // The first test here was a known defect until step 2 of #177 and is now a
    // regression test; the second is still a known defect and asserts what the
    // game does **today**, not what it should do. A known-defect test is
    // written to go RED the moment its fix lands, which is the point — the fix
    // must not be able to slip in without someone coming back here and moving
    // the assertion to the correct side.

    /// **Regression, step 2 of #177.** Three ordinary tool clicks used to stamp
    /// a structure over a live hydro line, producing `{Structure, PowerLine}` —
    /// a pair [`COMPAT_EXCEPTIONS`] declares impossible. The third click is
    /// refused now.
    ///
    /// `place_footprint_building` used to reject a tile whose `kind` was
    /// `Road`, `Rail` or `PowerLine` plus `has_road_underlay()` and
    /// `has_rail_underlay()` — but it never asked `has_power_overlay()`. A line
    /// strung across a *zoned* tile records itself in that flag and leaves
    /// `kind` on the zone, so the guard looked at `Residential`, saw nothing it
    /// objected to, and let a park land on top of the conductors. The line then
    /// survived as a flag: still drawn, still conducting power, still billed
    /// `MAINT_POWER_LINE` every day, and unreachable by the bulldozer except
    /// through the building on top of it.
    ///
    /// The guard asks `occupants()` now, so both spellings of a line answer the
    /// same. Two routes are checked, because the flag-only spelling is reached
    /// two ways and only the occupant set covers both.
    #[test]
    fn a_structure_is_refused_over_a_live_hydro_line() {
        let mut s = GameState::new(4, 4, 0);
        assert!(apply_tool(&mut s, Tool::Residential, 2, 2).success);
        assert!(apply_tool(&mut s, Tool::PowerLine, 2, 2).success);

        // After two clicks the tile is a zone carrying a line, recorded the one
        // canonical way: the zone keeps `kind`, the line takes the flag.
        let t = s.tiles[s.tile_index(2, 2).unwrap()].clone();
        assert_eq!(t.zone_occupant(), Some(Occupant::ZoneResidential));
        assert!(t.has_occupant(Occupant::PowerLine));
        assert_eq!(t.occupants, B_ZONE_R | B_POWER_LINE);
        assert_eq!(validate_set(t.occupants), Ok(()));

        // The third click is refused — the line is in the flag, not in `kind`,
        // and the guard reads the occupant set.
        let money = s.money;
        let r = apply_tool(&mut s, Tool::Park, 2, 2);
        assert!(!r.success, "a park landed on top of live conductors");
        assert_eq!(s.money, money, "a refused placement must not charge");
        assert!(s.buildings.is_empty(), "a refused placement built nothing");

        // The tile is untouched: still a zone, still carrying its line.
        let t = s.tiles[s.tile_index(2, 2).unwrap()].clone();
        assert_eq!(t.zone_occupant(), Some(Occupant::ZoneResidential));
        assert_eq!(t.occupants, B_ZONE_R | B_POWER_LINE);
        assert!(t.building_id.is_none());

        // Bulldozing the line clears the way, so the refusal is a "clear it
        // first", not a tile the player can never build on.
        assert!(apply_tool(&mut s, Tool::Bulldoze, 2, 2).success);
        assert!(apply_tool(&mut s, Tool::Park, 2, 2).success);
        assert_eq!(s.tiles[s.tile_index(2, 2).unwrap()].occupants, B_STRUCTURE);

        // Zoning is not the only way in. Anything that moves the line out of
        // `kind` and into the flag used to open the same hole:
        // `Tool::TerraformRaise` writes `kind = Land` and leaves the overlay
        // standing — correctly, a regrade does not take down a span — after
        // which the old guard saw a bare land tile.
        let mut s = GameState::new(4, 4, 0);
        assert!(apply_tool(&mut s, Tool::PowerLine, 1, 1).success);
        assert!(apply_tool(&mut s, Tool::TerraformRaise, 1, 1).success);
        let t = s.tiles[s.tile_index(1, 1).unwrap()].clone();
        assert_eq!(t.terrain(), Terrain::Land);
        assert!(t.has_occupant(Occupant::PowerLine));
        assert_eq!(
            t.occupants, B_POWER_LINE,
            "the regrade must preserve the overhead stratum"
        );
        assert!(t.conducts(Network::Power));
        assert!((t.tile_upkeep_unfunded() - MAINT_POWER_LINE).abs() < 1e-6);
        assert!(
            !apply_tool(&mut s, Tool::HydroPlant, 1, 1).success,
            "a terraformed line is still a line"
        );

        // A footprint larger than one tile is guarded on every tile it covers,
        // not just its origin: the line here is at (2, 2), the 2×2 plant at
        // (1, 1).
        let mut s = GameState::new(4, 4, 0);
        assert!(apply_tool(&mut s, Tool::Residential, 2, 2).success);
        assert!(apply_tool(&mut s, Tool::PowerLine, 2, 2).success);
        assert!(
            !apply_tool(&mut s, Tool::HydroPlant, 1, 1).success,
            "the footprint's far corner sits on a line"
        );
    }

    /// **Behaviour change, step 3 of #177.** A *ghost* structure no longer
    /// exists.
    ///
    /// `remove_building` used to clear the `building_id` and keep the `kind`,
    /// with the comment "keep the tile kind so the zone lot can regrow". For a
    /// zone lot that is right and still happens — a lot's occupant is its zone
    /// tag, which `remove_building` never touches. For a *structure* it left a
    /// `TileKind::Park` with nothing behind it: still +4.0 of wilderness for
    /// ever, and a second bulldoze click to clear.
    ///
    /// Making the strata canonical forces the question, because
    /// `Occupant::Structure` is one flat tag and the `BuildingInstance` is the
    /// only thing that knows which structure it is. A tag with no development
    /// has no identity to score, so keeping it would have *silently* changed a
    /// bulldozed park from +4.0 to 0.0 — the same fix, smuggled inside a
    /// representation change. It is made in the open here instead: the tag goes
    /// with the id.
    #[test]
    fn removing_a_building_takes_its_structure_tag_with_it() {
        for tool in [Tool::Residential, Tool::Road, Tool::Rail, Tool::PowerLine] {
            let mut s = GameState::new(4, 4, 0);
            assert!(apply_tool(&mut s, Tool::Park, 1, 1).success);
            let bid = s.tiles[s.tile_index(1, 1).unwrap()].building_id.unwrap();
            crate::commands::remove_building(&mut s, bid as u32);
            let t = s.tiles[s.tile_index(1, 1).unwrap()].clone();
            assert!(
                !t.has_occupant(Occupant::Structure),
                "{tool:?}: a ghost structure survived"
            );
            assert_eq!(t.occupants, 0, "{tool:?}: bare ground is what is left");
            assert!(
                apply_tool(&mut s, tool, 1, 1).success,
                "{tool:?} was refused by a demolished park"
            );
        }
    }

    /// The other half of the same change: a bulldozed *zone lot* still regrows,
    /// because its occupant was never `Structure`.
    #[test]
    fn removing_a_zone_lot_leaves_the_zone_standing() {
        let mut s = GameState::new(4, 4, 0);
        assert!(apply_tool(&mut s, Tool::Residential, 1, 1).success);
        let idx = s.tile_index(1, 1).unwrap();
        s.tiles[idx].building_id = Some(9);
        s.buildings.push(crate::buildings::BuildingInstance::new(
            9,
            TileKind::Residential,
            (1, 1),
        ));
        crate::commands::remove_building(&mut s, 9);
        assert_eq!(
            s.tiles[idx].zone_occupant(),
            Some(Occupant::ZoneResidential),
            "the lot must still be zoned so it can regrow"
        );
    }

    /// **Known defect.** Two tool clicks plant a canopy through live
    /// conductors, producing `{Trees, PowerLine}` — a straight overhead-stratum
    /// conflict, no exception needed.
    ///
    /// `Tool::Tree` regrades the ground and plants on it, which clears the
    /// surface stratum but leaves the span overhead — so the line outlives the
    /// canopy that grew through it, still conducting and still billed.
    ///
    /// **Step 2 of #177 did not reach this one, deliberately.** It looks like
    /// the structure defect above and is not: that one was a *guard* reading
    /// one of a line's two spellings, so converting the guard to the occupant
    /// set closed it. Nor is it the build-order asymmetry that
    /// the regrade closes, because a line is overhead in either build order —
    /// it survives a canopy whichever way you clicked.
    ///
    /// What is left is a straight gameplay decision, and `Tool::Water` is the
    /// same code path producing a tile the model *wants* (a line over water is
    /// the pylon span `docs/tile-model.md` names as a variant), so "clear the
    /// overlay too" would be wrong. Plant refused under a line, versus canopy
    /// silently destroying a span the player paid for, belongs with its own
    /// message and a manual update rather than inside a guard conversion.
    /// Whoever takes it: this test goes red then, by design.
    ///
    /// Note what step 2 *did* reach: `Tool::Tree` now refuses a tile carrying a
    /// live `building_id`, because a canopy planted over a coal plant erased
    /// the `Structure` occupant while the plant kept producing and billing —
    /// state corruption rather than a gameplay call. See
    /// `planting_refuses_a_tile_carrying_a_live_building`. A hydro line has no
    /// `building_id`, so this route is untouched.
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
        assert!(t.has_occupant(Occupant::Trees));
        assert!(
            t.has_occupant(Occupant::PowerLine),
            "planting regrades the ground, never the span above it"
        );
        assert_eq!(t.occupants, B_TREES | B_POWER_LINE);
        assert_eq!(
            validate_set(t.occupants),
            Err((Occupant::PowerLine, Occupant::Trees))
        );
        assert!(t.conducts(Network::Power));
        assert!((t.tile_upkeep_unfunded() - MAINT_POWER_LINE).abs() < 1e-6);
    }

    /// Exhaustive search for tiles the game can build that the compatibility
    /// table calls impossible — so the known defect above is a complete
    /// inventory rather than the one somebody happened to notice.
    ///
    /// Closes the single-tile state space under `apply_tool`: every tool,
    /// applied at one spot, from every distinct grid state reached so far, to a
    /// fixed point. Breadth-first and with the treasury topped up after each
    /// click, so neither path length nor funds can hide a reachable state.
    ///
    /// Any pair found here is producible by clicking, which means either the
    /// table is wrong about it or the game is. The answer is pinned, so a
    /// second defect appearing — or the last one being fixed — lands as a
    /// failing test rather than as silence.
    ///
    /// It is also the regression test for the structure route that step 2 of
    /// #177 closed, and a stronger one than
    /// `a_structure_is_refused_over_a_live_hydro_line`: that test names the two
    /// click sequences we know about, this one proves there is no third.
    #[test]
    fn producible_conflicts_are_inventoried() {
        use std::collections::{HashSet, VecDeque};

        // Driven off `Tool::try_from`, which rejects the first invalid
        // discriminant, so a newly added tool joins the sweep by existing.
        let tools: Vec<Tool> = (0u8..=u8::MAX)
            .map_while(|v| Tool::try_from(v).ok())
            .collect();
        assert_eq!(tools.len(), 23, "a Tool was added — re-run the sweep");

        /// Grid identity: everything a tool guard can read. Money is
        /// deliberately excluded, and reset below, so that two states with the
        /// same tiles are the same node however dearly they were reached.
        fn signature(s: &GameState) -> Vec<(u8, u16, u8, bool)> {
            s.tiles
                .iter()
                .map(|t| {
                    (
                        t.terrain() as u8,
                        t.occupants,
                        t.flags,
                        t.building_id.is_some(),
                    )
                })
                .collect()
        }

        // 4×4 so a 2×2 footprint placed at (1, 1) fits; every click lands at
        // (1, 1), and the surrounding tiles move only as footprint spill.
        let start = GameState::new(4, 4, 0);
        let mut seen: HashSet<Vec<(u8, u16, u8, bool)>> = HashSet::new();
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
                    let set = t.occupants;
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
            vec![(Occupant::PowerLine, Occupant::Trees)],
            "the producible-conflict inventory changed. A new pair means a new \
             defect of the same class — in particular (Structure, PowerLine) \
             coming back means a placement guard has gone back to reading \
             `kind`. A missing pair means a defect was fixed, in which case \
             rewrite its known-defect test above as a regression test and drop \
             this entry."
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
            assert_eq!(t.occupants, *set, "{kind:?} occupants");
            // A bare tile occupies at most one stratum's worth of surface.
            assert!(
                validate_set(t.occupants).is_ok(),
                "{kind:?} is self-inconsistent"
            );
        }

        // The two spellings of a pipe: underground (real) and surface (import only).
        assert_eq!(
            tile(TileKind::Land, 0, Some(TileKind::WaterPipe)).occupants,
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
                    produced |= tile(kind, flags, underground).occupants;
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
                bare.occupants, noisy.occupants,
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
    /// can own `kind`; that is a fact about the `kind`-and-flags encoding, and
    /// it is exactly the asymmetry the occupant set erases.
    #[test]
    fn every_v4_recording_decodes_to_the_same_set() {
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
                            .map(|&(k, f)| tile(k, f, None).occupants)
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
                                tile(k, f, Some(TileKind::WaterPipe)).occupants,
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
    /// tiles: build order must not change the stored set.
    #[test]
    fn tool_orderings_agree() {
        fn build(order: &[Tool]) -> OccupantSet {
            let mut s = GameState::new(4, 4, 0);
            for &t in order {
                apply_tool(&mut s, t, 1, 1);
            }
            s.tiles[s.tile_index(1, 1).unwrap()].occupants
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

    /// `tile_upkeep_unfunded` must reproduce the four independent `if`s that
    /// `compute_daily_budget` used to hand-write, over the whole (kind, flags,
    /// underground) space — at 100% funding, where the multipliers are all 1.0.
    /// Non-default funding is `tile_upkeep_is_funded_per_department` below.
    ///
    /// Step 2 of #177 deleted those `if`s from `economy.rs`, which is exactly
    /// why the copy below stays: it is now the *independent* oracle, deriving
    /// the bill straight from `kind`, the flags and `underground` with no help
    /// from the table the accessor is built on. Delete it and the two sides of
    /// the comparison become the same code.
    #[test]
    fn tile_upkeep_matches_the_economy_ledger() {
        let mut cases = 0usize;
        for &kind in TileKind::ALL {
            for flags in structural_flag_combos() {
                for underground in [None, Some(TileKind::WaterPipe)] {
                    let t = tile(kind, flags, underground);
                    // The pre-conversion economy.rs loop body, verbatim — its
                    // `kind` clauses read the v4 spelling this tile was built
                    // from, not the tile.
                    let mut expected = 0.0_f32;
                    if kind == TileKind::Road || flags & FLAG_ROAD_UNDERLAY != 0 {
                        expected += MAINT_ROAD;
                    }
                    if kind == TileKind::Rail || flags & FLAG_RAIL_UNDERLAY != 0 {
                        expected += MAINT_RAIL;
                    }
                    if kind == TileKind::PowerLine || flags & FLAG_POWER_OVERLAY != 0 {
                        expected += MAINT_POWER_LINE;
                    }
                    if t.has_occupant(Occupant::Pipe) {
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
            s.tiles[0].occupants,
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

    /// The pre-migration `is_power_carrier` from `utilities.rs`, kept longhand
    /// as an independent oracle now that the real one is gone. It is the
    /// *before* side of the step-2 conversion: transcribing it here rather
    /// than deriving it from `OCCUPANT_DEFS` is the point, because a copy that
    /// tracked the table could no longer show the diff.
    ///
    /// Note the missing `has_power_overlay()` — that omission is the bug.
    ///
    /// It is spelled in the *pre-migration vocabulary* — the v4 `(kind, flags)`
    /// pair the probe tile was decoded from — rather than in occupants, because
    /// an oracle written in the new vocabulary is a copy of the thing it is
    /// meant to check.
    fn pre_migration_is_power_carrier(
        kind: TileKind,
        flags: u8,
        building_id: Option<u16>,
        mw: i32,
    ) -> bool {
        use TileKind::*;
        mw > 0
            || building_id.is_some()
            || kind == PowerLine
            || kind == Road
            || flags & FLAG_ROAD_UNDERLAY != 0
            || kind == Rail
            || flags & FLAG_RAIL_UNDERLAY != 0
            || matches!(kind, Residential | Commercial | Industrial)
    }

    /// The pre-migration `is_water_carrier`. Unlike its power counterpart it
    /// already read every fallback, which is why water converts with an empty
    /// diff.
    fn pre_migration_is_water_carrier(
        kind: TileKind,
        flags: u8,
        underground: Option<TileKind>,
        building_id: Option<u16>,
    ) -> bool {
        use TileKind::*;
        underground == Some(WaterPipe)
            || building_id.is_some()
            || kind == Road
            || flags & FLAG_ROAD_UNDERLAY != 0
            || kind == Rail
            || flags & FLAG_RAIL_UNDERLAY != 0
            || matches!(kind, Residential | Commercial | Industrial)
    }

    /// What step 2 actually moved, measured against the predicates it
    /// replaced.
    ///
    /// - **Water**: empty diff, as promised in step 1.
    /// - **Power**: `conducts(Power)` is a strict superset — 28 tiles whose
    ///   only conductor is a hydro line recorded in `FLAG_POWER_OVERLAY`.
    ///   Those tiles used to sever the grid while still being billed
    ///   `MAINT_POWER_LINE`; they now conduct. The count is unchanged from
    ///   step 1, which pinned it as *pending*; what changed is that
    ///   `utilities.rs` now sits on the fixed side of it, which
    ///   `the_live_carrier_predicate_is_conducts` below is what proves.
    /// - **Traffic**: converged. Step 1 pinned 32 divergent tiles, every one a
    ///   bare hydro line that `adjacency::has_road_access` counted as a road.
    ///   Step 2 deleted that clause, so the count is now zero.
    #[test]
    fn conducts_versus_the_predicates_it_replaced() {
        let mut power_divergences = 0usize;
        // Recorded rather than asserted case by case: an `assert_eq!` inside
        // the loop would panic before the count below could ever be read, so
        // `water_divergences == 0` would be asserting a constant against
        // itself. Collecting first makes that assertion the real check, and
        // the failure message still names every offending tile.
        let mut water_divergences: Vec<String> = Vec::new();
        let mut traffic_divergences: Vec<String> = Vec::new();
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
                            let mut t = tile_from_v4(kind, flags, underground, building_id);
                            t.power_plant_mw = mw;
                            cases += 1;

                            // --- water: no divergence permitted ---
                            if t.conducts(Network::Water)
                                != pre_migration_is_water_carrier(
                                    kind,
                                    flags,
                                    underground,
                                    building_id,
                                )
                            {
                                water_divergences.push(format!(
                                    "{kind:?} flags={flags:#010b} ug={underground:?} \
                                     bid={building_id:?} mw={mw}"
                                ));
                            }

                            // --- power: exactly one documented divergence ---
                            let ghost_line = t.has_occupant(Occupant::PowerLine)
                                && kind != TileKind::PowerLine
                                && !t.has_occupant(Occupant::Road)
                                && !t.has_occupant(Occupant::Rail)
                                && t.zone_occupant().is_none()
                                && building_id.is_none()
                                && mw == 0;
                            let diverged = t.conducts(Network::Power)
                                != pre_migration_is_power_carrier(kind, flags, building_id, mw);
                            assert_eq!(
                                diverged, ghost_line,
                                "power: {kind:?} flags={flags:#010b} ug={underground:?} \
                                 bid={building_id:?} mw={mw} — divergence must occur exactly \
                                 when a line is recorded only in FLAG_POWER_OVERLAY"
                            );
                            if diverged {
                                assert!(
                                    t.conducts(Network::Power)
                                        && !pre_migration_is_power_carrier(
                                            kind,
                                            flags,
                                            building_id,
                                            mw
                                        )
                                );
                                power_divergences += 1;
                            }

                            // --- traffic: Road only ---
                            assert_eq!(
                                t.conducts(Network::Traffic),
                                kind == TileKind::Road || flags & FLAG_ROAD_UNDERLAY != 0
                            );
                            // The real `adjacency::has_road_access` is called,
                            // not a copy of its condition, so that widening or
                            // narrowing it shows up here as a changed
                            // divergence count. Step 1 measured 32 — bare
                            // hydro lines it counted as roads. Step 2 removed
                            // that clause; the count below is now zero.
                            probe.tiles[0] = t.clone();
                            let adjacency_says = has_road_access(&probe, 1, 0);
                            if t.conducts(Network::Traffic) != adjacency_says {
                                traffic_divergences.push(format!(
                                    "{kind:?} flags={flags:#010b} ug={underground:?} \
                                     bid={building_id:?} mw={mw}"
                                ));
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
            "tiles the old BFS severed and the new one carries: 14 kinds (all \
             but Road, Rail, the three zones and PowerLine itself) × 2 \
             underground states, with the overlay as the only structural flag"
        );
        assert!(
            traffic_divergences.is_empty(),
            "has_road_access has converged on conducts(Traffic) — {} tiles \
             disagreed: {:?}",
            traffic_divergences.len(),
            traffic_divergences
        );
    }

    /// The utility BFS asks [`Tile::conducts`] and nothing else.
    ///
    /// `conducts_versus_the_predicates_it_replaced` measures the diff against
    /// a transcribed *copy* of the old rule, which by itself would keep
    /// passing if `utilities.rs` quietly grew a third predicate. This calls
    /// the live `is_carrier` — the exact function the flood fill runs — over
    /// the same tile space, so the conversion cannot be undone without a
    /// failure here.
    #[test]
    fn the_live_carrier_predicate_is_conducts() {
        use crate::utilities::{is_carrier, UtilityKind};
        let mut cases = 0usize;
        for &kind in TileKind::ALL {
            for flags in structural_flag_combos() {
                for underground in [None, Some(TileKind::WaterPipe)] {
                    for building_id in [None, Some(1u16)] {
                        for mw in [0i32, 100] {
                            let mut t = tile_from_v4(kind, flags, underground, building_id);
                            t.power_plant_mw = mw;
                            cases += 1;
                            for (utility, network) in [
                                (UtilityKind::Power, Network::Power),
                                (UtilityKind::Water, Network::Water),
                            ] {
                                assert_eq!(
                                    is_carrier(&t, utility),
                                    t.conducts(network),
                                    "{utility:?}: {kind:?} flags={flags:#010b} \
                                     ug={underground:?} bid={building_id:?} mw={mw}"
                                );
                            }
                        }
                    }
                }
            }
        }
        assert_eq!(cases, TileKind::ALL.len() * 8 * 2 * 2 * 2);
    }

    #[test]
    fn structures_conduct_through_development_not_the_tag() {
        // A live park: `Structure` plus the development behind it.
        let live = tile_from_v4(TileKind::Park, 0, None, Some(7));
        assert!(live.has_occupant(Occupant::Structure));
        assert!(live.conducts(Network::Power));
        assert!(live.conducts(Network::Water));

        // The v4 ghost `remove_building` used to leave behind — a structure
        // kind with no development. It decodes to bare ground, because a flat
        // `Structure` tag with nothing behind it has no identity at all.
        let ghost = tile_from_v4(TileKind::Park, 0, None, None);
        assert!(!ghost.has_occupant(Occupant::Structure));
        assert!(!ghost.conducts(Network::Power));
        assert!(!ghost.conducts(Network::Water));

        // A power plant conducts from its output even before roll-up.
        let mut plant = tile_from_v4(TileKind::CoalPlant, 0, None, None);
        plant.power_plant_mw = 500;
        assert!(plant.conducts(Network::Power));
    }

    #[test]
    fn a_developed_zone_lot_is_not_a_structure() {
        // `zones.rs` grows a lot in place: kind stays Residential, building_id
        // is set. If that derived `Structure` as well, the
        // Zone-conflicts-Structure rule would fire on every grown lot.
        let lot = tile_from_v4(TileKind::Residential, 0, None, Some(3));
        assert_eq!(lot.occupants, B_ZONE_R);
        assert!(!lot.has_occupant(Occupant::Structure));
        assert_eq!(validate_set(lot.occupants), Ok(()));
        assert_eq!(lot.zone_occupant(), Some(Occupant::ZoneResidential));

        // …and the lookup agrees: the lot's `BuildingInstance` is a
        // `Residential` template, but the tile carries no structure.
        let mut s = GameState::new(1, 1, 0);
        s.tiles[0] = lot;
        s.buildings.push(crate::buildings::BuildingInstance::new(
            3,
            TileKind::Residential,
            (0, 0),
        ));
        s.next_building_id = 4;
        assert_eq!(
            StructureLookup::new(&s).structure_kind(&s.tiles[0]),
            None,
            "a developed lot is not a structure"
        );
    }

    /// Step 2 of #177 rewrote the same three-armed `matches!(tile.kind,
    /// Residential | Commercial | Industrial)` in `demand.rs`, `zones.rs`,
    /// `education.rs`, `economy.rs` and `wilderness.rs` as `zone_occupant()`.
    /// Six consumers now rest on that being the *same question*, so it is
    /// pinned here over the whole (kind, flags, underground) space rather than
    /// left to five separate readings of the diff.
    ///
    /// The flags matter: a zone carrying a hydro line spells the line into
    /// `FLAG_POWER_OVERLAY` and keeps `kind = Commercial`, so the tile must
    /// still count as commercial for revenue, demand and school catchment
    /// while also being billed for the line.
    #[test]
    fn zone_occupant_is_the_old_three_armed_kind_match() {
        let mut zoned = 0usize;
        for &kind in TileKind::ALL {
            for flags in structural_flag_combos() {
                for underground in [None, Some(TileKind::WaterPipe)] {
                    let t = tile(kind, flags, underground);
                    let old = matches!(
                        kind,
                        TileKind::Residential | TileKind::Commercial | TileKind::Industrial
                    );
                    assert_eq!(
                        t.zone_occupant().is_some(),
                        old,
                        "{kind:?} flags={flags:#010b} underground={underground:?}"
                    );
                    // And the tag names the right zone.
                    assert_eq!(
                        t.zone_occupant(),
                        match kind {
                            TileKind::Residential => Some(Occupant::ZoneResidential),
                            TileKind::Commercial => Some(Occupant::ZoneCommercial),
                            TileKind::Industrial => Some(Occupant::ZoneIndustrial),
                            _ => None,
                        }
                    );
                    // A zone is exactly one bit of ZONE_MASK, never two.
                    assert_eq!(
                        (t.occupants & ZONE_MASK).count_ones(),
                        old as u32,
                        "{kind:?} must carry exactly {} zone bit(s)",
                        old as u32
                    );
                    zoned += old as usize;
                }
            }
        }
        assert_eq!(
            zoned,
            3 * 8 * 2,
            "three zone kinds over 16 flag/pipe states"
        );
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
            let got = eco_of(kind, 0, None, &t);
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
            eco_of(TileKind::Land, 0, Some(TileKind::WaterPipe), &t),
            1.0
        );
        assert_eq!(
            eco_of(TileKind::Tree, 0, Some(TileKind::WaterPipe), &t),
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
        assert_eq!(road_with_line.occupants, line_over_road.occupants);
        assert_eq!(eco_of(TileKind::Road, FLAG_POWER_OVERLAY, None, &t), -3.0);
        assert_eq!(
            eco_of(
                TileKind::PowerLine,
                FLAG_ROAD_UNDERLAY | FLAG_POWER_OVERLAY,
                None,
                &t
            ),
            -3.0
        );
        // Today the two spellings score differently — that is the bug.
        assert_eq!(t.base_eco[TileKind::Road as usize], -2.0);
        assert_eq!(t.base_eco[TileKind::PowerLine as usize], -1.0);

        // Level crossing: -4.0 against today's -2.0.
        assert_eq!(eco_of(TileKind::Rail, FLAG_ROAD_UNDERLAY, None, &t), -4.0);
    }

    #[test]
    fn zone_industrial_eco_follows_the_green_industry_policy() {
        use city_sim_protocol::commands::WildernessPolicy;
        let base = WildernessTunables::default();
        assert_eq!(occupant_eco(Occupant::ZoneIndustrial, &base), Some(-5.0));
        assert_eq!(eco_of(TileKind::Industrial, 0, None, &base), -5.0);

        let green = base.effective(&WildernessPolicy {
            green_industry: true,
            ..Default::default()
        });
        assert_eq!(
            occupant_eco(Occupant::ZoneIndustrial, &green),
            Some(-2.0),
            "a static eco in OccupantDef would silently disable Green Industry"
        );
        assert_eq!(eco_of(TileKind::Industrial, 0, None, &green), -2.0);
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
            assert_eq!(eco_of(kind, 0, None, &t), eco, "{kind:?}");
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
        assert_eq!(
            eco_of(TileKind::Park, 0, None, &t) - eco_of(TileKind::CoalPlant, 0, None, &t),
            12.0
        );
        assert_eq!(park.occupants, coal.occupants, "same tag, same bit");
    }

    #[test]
    fn strong_nature_matches_the_wilderness_rule() {
        for &kind in TileKind::ALL {
            // `wilderness::compute_wilderness` asks
            // `occupants::is_strong_nature` now, so this is the *pre-migration*
            // kind-level rule, kept longhand as an independent oracle: it
            // cannot drift with `OCCUPANT_DEFS` the way a local `matches!`
            // copied from the table would.
            let expected = crate::wilderness::strong_nature_kind(kind);
            assert_eq!(
                is_strong_nature(&tile(kind, 0, None), &lookup(kind)),
                expected,
                "{kind:?}: must match the pre-migration kind rule"
            );
        }
        assert_eq!(occupant_is_strong_nature(Occupant::Trees), Some(true));
        assert_eq!(occupant_is_strong_nature(Occupant::Road), Some(false));
        // Not `Some(false)`: a park is strong nature and a park is a
        // `Structure`, so the tag alone must refuse to answer.
        assert_eq!(occupant_is_strong_nature(Occupant::Structure), None);
        assert!(is_strong_nature(
            &tile(TileKind::Park, 0, None),
            &lookup(TileKind::Park)
        ));
        assert!(!is_strong_nature(
            &tile(TileKind::CoalPlant, 0, None),
            &lookup(TileKind::CoalPlant)
        ));
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
            // A buried pipe scores 0.0 and files nowhere — `Neutral` is the
            // line the old `Water | WaterPipe => {}` arm sent it to.
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
                let mut present = iter_set(tl.occupants);
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
                // ever written one; only `import.rs` can produce it), so it is
                // scored as open land. `breakdown_line_for` still measures
                // `Neutral`, because the probe tunables put 1.0 on `WaterPipe`
                // and 0.0 on `Land`, so the credit it earns is 0.0 and no line
                // visibly moves. Same divergence
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
        // only exists as a flag, the spelling `wilderness.rs` used to miss
        // entirely, handing a tile with live conductors on it the full +1.0
        // open-land credit.
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
        assert_eq!(t.occupants, B_PIPE | B_ROAD | B_POWER_LINE);
        assert_eq!(t.visible_occupants(), B_ROAD | B_POWER_LINE);
        assert_eq!(t.occupants_in(Stratum::Underground), B_PIPE);
        assert_eq!(t.occupants_in(Stratum::Surface), B_ROAD);
        assert_eq!(t.occupants_in(Stratum::Overhead), B_POWER_LINE);
        assert_eq!(
            t.occupants_in(Stratum::Underground)
                | t.occupants_in(Stratum::Surface)
                | t.occupants_in(Stratum::Overhead),
            t.occupants
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
        // A Water tile can carry occupants. No tool builds this exact one any
        // more — a regrade takes the whole surface stratum with it — but saves
        // written before that landed carry both it and a `building_id` on
        // drowned ground. Terrain is still Water, and it contributes no bit.
        let drowned = tile_from_v4(TileKind::Water, FLAG_ROAD_UNDERLAY, None, Some(2));
        assert_eq!(drowned.terrain(), Terrain::Water);
        assert_eq!(drowned.occupants, B_ROAD);
        assert_eq!(Tile::land().terrain(), Terrain::Land);
        assert_eq!(Tile::water().terrain(), Terrain::Water);
        assert_eq!(Tile::land().occupants, 0);
        assert_eq!(Tile::water().occupants, 0, "terrain is not an occupant");
    }
}
