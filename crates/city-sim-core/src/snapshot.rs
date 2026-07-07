// snapshot.rs — postcard serialisation for GameState.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use crate::state::GameState;

/// Four-byte magic number that identifies a city-sim snapshot.
const MAGIC: &[u8; 4] = b"CSIM";
/// Snapshot format version — bump when the binary layout changes incompatibly.
/// v2: `GameState` gained `policy: BudgetPolicy` and `BudgetStats` gained the
/// per-type maintenance breakdown fields.
const VERSION: u32 = 2;

/// Serialise `state` to a compact postcard byte vector prefixed by a 8-byte
/// header: magic `CSIM` (4 bytes) + version u32 (4 bytes, little-endian).
pub fn to_bytes(state: &GameState) -> Result<Vec<u8>, postcard::Error> {
    let payload = postcard::to_allocvec(state)?;
    let mut out = Vec::with_capacity(8 + payload.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&payload);
    Ok(out)
}

/// Deserialise a snapshot produced by [`to_bytes`].
///
/// Returns an error if the magic header is missing, the version is
/// unsupported, or the postcard payload is malformed.
pub fn from_bytes(bytes: &[u8]) -> Result<GameState, SnapshotError> {
    if bytes.len() < 8 {
        return Err(SnapshotError::TooShort);
    }
    if &bytes[..4] != MAGIC {
        return Err(SnapshotError::BadMagic);
    }
    let version = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
    if version != VERSION {
        return Err(SnapshotError::UnsupportedVersion(version));
    }
    postcard::from_bytes(&bytes[8..]).map_err(SnapshotError::Postcard)
}

#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    #[error("snapshot too short to contain header")]
    TooShort,
    #[error("bad magic — not a CSIM snapshot")]
    BadMagic,
    #[error("unsupported snapshot version {0}")]
    UnsupportedVersion(u32),
    #[error("postcard decode error: {0}")]
    Postcard(#[from] postcard::Error),
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::GameState;

    #[test]
    fn round_trip_empty_city() {
        let original = GameState::new(8, 8, 42);
        let bytes = to_bytes(&original).expect("serialise");
        let restored = from_bytes(&bytes).expect("deserialise");
        assert_eq!(original.width, restored.width);
        assert_eq!(original.height, restored.height);
        assert_eq!(original.seed, restored.seed);
        assert_eq!(original.money, restored.money);
        assert_eq!(original.tiles.len(), restored.tiles.len());
    }

    #[test]
    fn header_magic_present() {
        let bytes = to_bytes(&GameState::new(4, 4, 0)).unwrap();
        assert_eq!(&bytes[..4], b"CSIM");
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), VERSION);
    }

    #[test]
    fn bad_magic_returns_error() {
        let mut bytes = to_bytes(&GameState::new(4, 4, 0)).unwrap();
        bytes[0] = 0x00;
        assert!(matches!(from_bytes(&bytes), Err(SnapshotError::BadMagic)));
    }

    #[test]
    fn wrong_version_returns_error() {
        let mut bytes = to_bytes(&GameState::new(4, 4, 0)).unwrap();
        bytes[4..8].copy_from_slice(&99u32.to_le_bytes());
        assert!(matches!(
            from_bytes(&bytes),
            Err(SnapshotError::UnsupportedVersion(99))
        ));
    }

    #[test]
    fn too_short_returns_error() {
        assert!(matches!(
            from_bytes(&[0u8; 4]),
            Err(SnapshotError::TooShort)
        ));
    }

    #[test]
    fn round_trip_preserves_rng_state() {
        let mut original = GameState::new(8, 8, 99);
        // Advance RNG so its internal state is non-trivial.
        for _ in 0..50 {
            original.rng.next_u32();
        }
        let bytes = to_bytes(&original).expect("serialise");
        let mut restored = from_bytes(&bytes).expect("deserialise");
        // Both RNG instances must produce the same sequence post-restore.
        for _ in 0..20 {
            assert_eq!(
                original.rng.next_u32(),
                restored.rng.next_u32(),
                "RNG state diverged after round-trip"
            );
        }
    }

    #[test]
    fn round_trip_city_with_buildings_and_history() {
        use crate::buildings::{BuildingInstance, BuildingStatus};
        use crate::state::BudgetHistoryEntry;
        use city_sim_protocol::tile_kind::TileKind;

        let mut state = GameState::new(4, 4, 7);
        state.buildings.push(BuildingInstance {
            id: 1,
            kind: TileKind::Residential,
            origin: (0, 0),
            status: BuildingStatus::Active,
            health: 80,
            trouble_ticks: 2.5,
            maintenance_per_day: 0.0,
        });
        state.budget_history.push_back(BudgetHistoryEntry {
            day: 1,
            revenue: 100.0,
            expenses: 60.0,
            net: 40.0,
        });
        state.budget_history.push_back(BudgetHistoryEntry {
            day: 2,
            revenue: 110.0,
            expenses: 65.0,
            net: 45.0,
        });

        let bytes = to_bytes(&state).expect("serialise");
        let restored = from_bytes(&bytes).expect("deserialise");

        assert_eq!(restored.buildings.len(), 1);
        assert_eq!(restored.buildings[0].id, 1);
        assert_eq!(restored.buildings[0].health, 80);
        assert_eq!(restored.buildings[0].trouble_ticks, 2.5);
        assert_eq!(restored.buildings[0].status, BuildingStatus::Active);
        assert_eq!(restored.budget_history.len(), 2);
        assert_eq!(restored.budget_history[1].net, 45.0);
    }
}
