// tile_kind.rs — canonical TileKind ↔ u8 mapping, single source of truth for the wire protocol.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

/// Canonical TileKind ↔ u8 mapping — single source of truth for the wire protocol.
///
/// The TS side (`src/game/protocol/tileKind.ts`) mirrors this table. If you add a
/// variant here you MUST update the TS mirror and bump the parity test fixture.
///
/// Values are intentionally explicit and must never be reordered — old saves
/// contain u8s and old replays contain these values in command logs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[repr(u8)]
pub enum TileKind {
    Land = 0,
    Water = 1,
    Tree = 2,
    Road = 3,
    Rail = 4,
    Residential = 5,
    Commercial = 6,
    Industrial = 7,
    PowerLine = 8,
    HydroPlant = 9,
    WaterPump = 10,
    WaterTower = 11,
    WaterPipe = 12,
    ElementarySchool = 13,
    HighSchool = 14,
    Park = 15,
    CoalPlant = 16,
    WindTurbine = 17,
    SolarFarm = 18,
    ParkLarge = 19,
}

impl TileKind {
    /// Convert a u8 byte (from the wire or a save) to a TileKind.
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Land),
            1 => Some(Self::Water),
            2 => Some(Self::Tree),
            3 => Some(Self::Road),
            4 => Some(Self::Rail),
            5 => Some(Self::Residential),
            6 => Some(Self::Commercial),
            7 => Some(Self::Industrial),
            8 => Some(Self::PowerLine),
            9 => Some(Self::HydroPlant),
            10 => Some(Self::WaterPump),
            11 => Some(Self::WaterTower),
            12 => Some(Self::WaterPipe),
            13 => Some(Self::ElementarySchool),
            14 => Some(Self::HighSchool),
            15 => Some(Self::Park),
            16 => Some(Self::CoalPlant),
            17 => Some(Self::WindTurbine),
            18 => Some(Self::SolarFarm),
            19 => Some(Self::ParkLarge),
            _ => None,
        }
    }

    pub fn to_u8(self) -> u8 {
        self as u8
    }

    /// All variants in u8 order — used by the exhaustive round-trip test and
    /// to generate the TS parity fixture.
    pub const ALL: &'static [TileKind] = &[
        Self::Land,
        Self::Water,
        Self::Tree,
        Self::Road,
        Self::Rail,
        Self::Residential,
        Self::Commercial,
        Self::Industrial,
        Self::PowerLine,
        Self::HydroPlant,
        Self::WaterPump,
        Self::WaterTower,
        Self::WaterPipe,
        Self::ElementarySchool,
        Self::HighSchool,
        Self::Park,
        Self::CoalPlant,
        Self::WindTurbine,
        Self::SolarFarm,
        Self::ParkLarge,
    ];

    /// Canonical string name — matches the TS `TileKind` string-enum value.
    pub fn ts_string(self) -> &'static str {
        match self {
            Self::Land => "land",
            Self::Water => "water",
            Self::Tree => "tree",
            Self::Road => "road",
            Self::Rail => "rail",
            Self::Residential => "residential",
            Self::Commercial => "commercial",
            Self::Industrial => "industrial",
            Self::PowerLine => "powerline",
            Self::HydroPlant => "hydro",
            Self::CoalPlant => "coal",
            Self::WindTurbine => "wind",
            Self::SolarFarm => "solar",
            Self::WaterPump => "pump",
            Self::WaterTower => "water_tower",
            Self::WaterPipe => "water_pipe",
            Self::ElementarySchool => "elementary_school",
            Self::HighSchool => "high_school",
            Self::Park => "park",
            Self::ParkLarge => "park_large",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_all_variants() {
        for &kind in TileKind::ALL {
            let byte = kind.to_u8();
            let back = TileKind::from_u8(byte).expect("from_u8 should succeed for every variant");
            assert_eq!(kind, back, "round-trip failed for {kind:?} (byte {byte})");
        }
    }

    #[test]
    fn no_duplicate_u8_values() {
        let mut seen = std::collections::HashSet::new();
        for &kind in TileKind::ALL {
            let byte = kind.to_u8();
            assert!(seen.insert(byte), "duplicate u8 value {byte} for {kind:?}");
        }
    }

    #[test]
    fn count_matches_ts_mirror() {
        // Keep in sync with src/game/protocol/tileKind.ts TILE_KIND_COUNT.
        assert_eq!(TileKind::ALL.len(), 20);
    }

    /// Emit the parity JSON so CI can diff it against the committed fixture.
    /// Run with: cargo test -p sim_protocol dump_parity_json -- --nocapture
    #[test]
    fn dump_parity_json() {
        let entries: Vec<_> = TileKind::ALL
            .iter()
            .map(|&k| serde_json::json!({ "u8": k.to_u8(), "ts": k.ts_string() }))
            .collect();
        let json = serde_json::to_string_pretty(&entries).unwrap();
        println!("{json}");
    }
}
