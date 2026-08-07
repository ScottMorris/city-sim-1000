// building_kind.rs — canonical BuildingKind ↔ u8 mapping, the building-template key.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use ts_rs::TS;

/// Which category a [`BuildingKind`] belongs to — the high nibble of its
/// discriminant. `Safety` and `Health` are reserved: declared here so the
/// alphabet has room for them, but no [`BuildingKind`] carries either yet.
///
/// Rust-internal only — not `#[derive(TS)]`'d. No wire struct carries a
/// `BuildingCategory` field (`WireBuilding.kind` is a raw `u8`, decoded on
/// the TS side by `BUILDING_KIND_BY_U8`, not by category), and TS has its
/// own, deliberately coarser three-way grouping for display
/// (`buildings/templates.ts`'s `LedgerGroup`, which lumps `Water`/
/// `Education`/`Recreation` into one `Civic` bucket) — mirroring this
/// seven-way taxonomy into TS as well would just be a second grouping
/// nothing reads. `category()` below exists to keep `BuildingKind`'s high
/// nibble assignment self-checking (see this module's tests), not for any
/// TS consumer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[repr(u8)]
pub enum BuildingCategory {
    Zone = 1,
    Power = 2,
    Water = 3,
    Education = 4,
    Recreation = 5,
    Safety = 6,
    Health = 7,
}

/// Canonical BuildingKind ↔ u8 mapping — the stable identity of a building
/// template, on the wire and in a `BuildingInstance`.
///
/// A building is an entity that occupies a tile, not a kind of tile — see
/// `docs/tile-model.md` and `app/src/game/buildings/templates.ts`'s
/// `BuildingKind`, whose string values this mirrors one-for-one via
/// [`BuildingKind::ts_string`]. Unlike [`crate::tile_kind::TileKind`], this
/// enum is **not** frozen legacy-save vocabulary — the discriminants below are
/// free to be renumbered or extended pre-release, per the maintainer-approved
/// design. `0x00` is reserved and never valid: every real member's high
/// nibble is its [`BuildingCategory`] (1–7) and the low nibble distinguishes
/// members within that category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize, TS)]
#[serde(into = "u8", try_from = "u8")]
// ts-rs's serde-compat does not understand `into`/`try_from` (unlike `rename`,
// `rename_all`, `tag`, ...  — see the crate's supported-attribute list), so
// without this override it would derive the TS shape from the enum's own
// variants (a string-literal union) and silently lie about the wire, which is
// a plain `u8` routed through `Into<u8>`/`TryFrom<u8>`. `#[ts(type = "number")]`
// pins the generated type to what is actually serialised. Do not remove this
// without also removing the `serde(into/try_from)` pair above.
#[ts(type = "number", export_to = "BuildingKind.ts")]
#[repr(u8)]
pub enum BuildingKind {
    // Zone
    Residential = 0x10,
    Commercial = 0x11,
    Industrial = 0x12,
    // Power
    HydroPlant = 0x20,
    CoalPlant = 0x21,
    WindTurbine = 0x22,
    SolarFarm = 0x23,
    // Water
    WaterPump = 0x30,
    WaterTower = 0x31,
    // Education
    ElementarySchool = 0x40,
    HighSchool = 0x41,
    // Recreation
    Park = 0x50,
    ParkLarge = 0x51,
}

impl BuildingKind {
    /// All variants, grouped by category and in ascending discriminant order.
    pub const ALL: &'static [BuildingKind] = &[
        Self::Residential,
        Self::Commercial,
        Self::Industrial,
        Self::HydroPlant,
        Self::CoalPlant,
        Self::WindTurbine,
        Self::SolarFarm,
        Self::WaterPump,
        Self::WaterTower,
        Self::ElementarySchool,
        Self::HighSchool,
        Self::Park,
        Self::ParkLarge,
    ];

    /// Number of variants — the length of a table indexed by
    /// [`BuildingKind::dense_index`] rather than by the raw (sparse)
    /// discriminant.
    pub const COUNT: usize = Self::ALL.len();

    /// The category this kind belongs to — the high nibble of its
    /// discriminant.
    pub fn category(self) -> BuildingCategory {
        match (self as u8) >> 4 {
            1 => BuildingCategory::Zone,
            2 => BuildingCategory::Power,
            3 => BuildingCategory::Water,
            4 => BuildingCategory::Education,
            5 => BuildingCategory::Recreation,
            6 => BuildingCategory::Safety,
            7 => BuildingCategory::Health,
            _ => unreachable!("every BuildingKind's high nibble is a declared category"),
        }
    }

    /// A dense, gapless index (`0..COUNT`) for tables keyed by building kind —
    /// e.g. `WildernessTunables::structure_eco` — so a 13-member alphabet
    /// spread across `0x10..=0x51` doesn't force a ~90-entry array of mostly
    /// holes. Order matches [`BuildingKind::ALL`].
    pub const fn dense_index(self) -> usize {
        match self {
            Self::Residential => 0,
            Self::Commercial => 1,
            Self::Industrial => 2,
            Self::HydroPlant => 3,
            Self::CoalPlant => 4,
            Self::WindTurbine => 5,
            Self::SolarFarm => 6,
            Self::WaterPump => 7,
            Self::WaterTower => 8,
            Self::ElementarySchool => 9,
            Self::HighSchool => 10,
            Self::Park => 11,
            Self::ParkLarge => 12,
        }
    }

    /// Convert a u8 byte (from the wire or a `BuildingInstance`) to a
    /// `BuildingKind`. `0x00` and any byte not naming a declared member
    /// return `None`.
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0x10 => Some(Self::Residential),
            0x11 => Some(Self::Commercial),
            0x12 => Some(Self::Industrial),
            0x20 => Some(Self::HydroPlant),
            0x21 => Some(Self::CoalPlant),
            0x22 => Some(Self::WindTurbine),
            0x23 => Some(Self::SolarFarm),
            0x30 => Some(Self::WaterPump),
            0x31 => Some(Self::WaterTower),
            0x40 => Some(Self::ElementarySchool),
            0x41 => Some(Self::HighSchool),
            0x50 => Some(Self::Park),
            0x51 => Some(Self::ParkLarge),
            _ => None,
        }
    }

    pub fn to_u8(self) -> u8 {
        self as u8
    }

    /// Canonical string name — matches the TS `BuildingKind` string-enum
    /// value in `app/src/game/buildings/templates.ts`, and the legacy
    /// `TileKind::ts_string` spelling those 13 members were copied from once,
    /// on purpose, so save/MCP vocabulary doesn't move.
    pub fn ts_string(self) -> &'static str {
        match self {
            Self::HydroPlant => "hydro",
            Self::CoalPlant => "coal",
            Self::WindTurbine => "wind",
            Self::SolarFarm => "solar",
            Self::WaterPump => "pump",
            Self::WaterTower => "water_tower",
            Self::Park => "park",
            Self::ParkLarge => "park_large",
            Self::ElementarySchool => "elementary_school",
            Self::HighSchool => "high_school",
            Self::Residential => "residential",
            Self::Commercial => "commercial",
            Self::Industrial => "industrial",
        }
    }
}

// Stable-discriminant-byte serde: postcard and JSON both carry a plain u8,
// same shape as `TileKind`'s custom (de)serialisation but expressed through
// `into`/`try_from` since `to_u8`/`from_u8` already exist and this repo has
// no reason to hand-roll a `Visitor` twice.
impl From<BuildingKind> for u8 {
    fn from(k: BuildingKind) -> u8 {
        k.to_u8()
    }
}

impl TryFrom<u8> for BuildingKind {
    type Error = InvalidBuildingKindByte;

    fn try_from(v: u8) -> Result<Self, Self::Error> {
        Self::from_u8(v).ok_or(InvalidBuildingKindByte(v))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("{0:#04x} is not a valid BuildingKind byte")]
pub struct InvalidBuildingKindByte(pub u8);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_all_variants() {
        for &kind in BuildingKind::ALL {
            let byte = kind.to_u8();
            let back =
                BuildingKind::from_u8(byte).expect("from_u8 should succeed for every variant");
            assert_eq!(
                kind, back,
                "round-trip failed for {kind:?} (byte {byte:#04x})"
            );
        }
    }

    #[test]
    fn no_duplicate_u8_values() {
        let mut seen = std::collections::HashSet::new();
        for &kind in BuildingKind::ALL {
            let byte = kind.to_u8();
            assert!(
                seen.insert(byte),
                "duplicate u8 value {byte:#04x} for {kind:?}"
            );
        }
    }

    #[test]
    fn count_matches_all_len() {
        assert_eq!(BuildingKind::ALL.len(), 13);
        assert_eq!(BuildingKind::COUNT, BuildingKind::ALL.len());
    }

    #[test]
    fn dense_index_is_a_gapless_permutation_of_0_to_count() {
        let mut seen = [false; BuildingKind::COUNT];
        for &kind in BuildingKind::ALL {
            let idx = kind.dense_index();
            assert!(
                idx < BuildingKind::COUNT,
                "{kind:?} index {idx} out of range"
            );
            assert!(
                !seen[idx],
                "{kind:?} shares dense_index {idx} with another kind"
            );
            seen[idx] = true;
        }
        assert!(seen.iter().all(|&s| s), "dense_index leaves a gap");
    }

    #[test]
    fn category_matches_the_high_nibble_for_every_member() {
        for &kind in BuildingKind::ALL {
            let expected = match kind.to_u8() >> 4 {
                1 => BuildingCategory::Zone,
                2 => BuildingCategory::Power,
                3 => BuildingCategory::Water,
                4 => BuildingCategory::Education,
                5 => BuildingCategory::Recreation,
                n => panic!("unexpected high nibble {n} for {kind:?}"),
            };
            assert_eq!(kind.category(), expected, "{kind:?}");
        }
    }

    #[test]
    fn zero_byte_is_never_valid() {
        assert_eq!(BuildingKind::from_u8(0x00), None);
        assert!(BuildingKind::try_from(0x00u8).is_err());
    }

    #[test]
    fn unassigned_bytes_are_rejected() {
        for v in [
            0x00, 0x01, 0x0F, 0x13, 0x24, 0x32, 0x42, 0x52, 0x60, 0x70, 0xFF,
        ] {
            assert_eq!(
                BuildingKind::from_u8(v),
                None,
                "byte {v:#04x} should be invalid"
            );
            assert!(
                BuildingKind::try_from(v).is_err(),
                "byte {v:#04x} should be invalid"
            );
        }
    }

    #[test]
    fn ts_string_is_unique_per_member() {
        let mut seen = std::collections::HashSet::new();
        for &kind in BuildingKind::ALL {
            assert!(
                seen.insert(kind.ts_string()),
                "duplicate ts_string for {kind:?}"
            );
        }
    }
}
