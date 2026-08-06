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
/// v3: `GameState` gained `wilderness: WildernessStats` and `BudgetStats`
/// gained `revenue_tourism`.
/// v5: #177 step 3 — `Tile` was stratified. `kind: TileKind` + `underground:
/// Option<TileKind>` + three structural bits inside `flags` became `terrain:
/// Terrain` + `underground: StratumSet<Underground>` + `surface:
/// StratumSet<Surface>` + `overhead: StratumSet<Overhead>` + `density:
/// ZoneDensity`.
/// v6: `BuildingInstance::kind` moved from the frozen `TileKind` alphabet to
/// the new `BuildingKind` (`crates/city-sim-protocol/src/building_kind.rs`)
/// — a building is an entity occupying a tile, not a kind of tile.
/// v7: `Policies` gained `lighting: LightingPolicy` — the lighting bylaw
/// moved from the TS-only `ClientState.bylaws` into engine-owned, simulated
/// state (see `city_sim_protocol::commands::LightingPolicy`).
///
/// **v4 and v5 are both refused outright now — a deliberate pre-release
/// compatibility break, not an oversight.** A real `.citysim` download or
/// IndexedDB engine snapshot saved against an older released build genuinely
/// was v4 bytes, and v5 never left this branch (see the superseded doc this
/// replaces, in git history, for how that one stayed live). Both are dropped
/// in the same change: `docs/tile-model.md` states the project's pre-release stance
/// plainly — the CSIM snapshot format, wire bytes, and u8 alphabets may
/// change freely before 1.0; only the legacy JSON save vocabulary and the
/// frozen `legacy_tile_buffer` layout are fixed. A pre-1.0 CSAV file
/// containing an old CSIM engine snapshot fails to load after this change,
/// loudly (`SnapshotError::UnsupportedVersion`) rather than silently
/// decoding a `BuildingInstance::kind` byte against the wrong alphabet. The
/// legacy JSON save path (`import.rs`'s `from_tile_buffer`, driven by
/// `persistence.ts`'s `transcodeLegacySave`) is untouched — it was never a
/// *snapshot* — so an old save is still recoverable through that door.
const VERSION: u32 = 7;

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
    let payload = &bytes[8..];
    match version {
        VERSION => postcard::from_bytes(payload).map_err(SnapshotError::Postcard),
        v => Err(SnapshotError::UnsupportedVersion(v)),
    }
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

    /// The deliberate pre-release compatibility break this `VERSION` bump
    /// makes: a real `origin/main`-shipped v4 CSIM snapshot, and the v5 shape
    /// that only ever lived on the stratification branch, are both refused
    /// outright now — no silent decode against the wrong `BuildingInstance::kind`
    /// alphabet, and no dead conversion arm kept alive for either.
    #[test]
    fn old_snapshot_versions_are_refused_not_silently_migrated() {
        for old_version in [4u32, 5u32] {
            let mut bytes = to_bytes(&GameState::new(4, 4, 0)).unwrap();
            bytes[4..8].copy_from_slice(&old_version.to_le_bytes());
            assert!(
                matches!(
                    from_bytes(&bytes),
                    Err(SnapshotError::UnsupportedVersion(v)) if v == old_version
                ),
                "v{old_version} should be refused, not migrated"
            );
        }
    }

    /// A snapshot whose `surface` field carries an overhead bit is **refused**,
    /// end to end, by [`from_bytes`] — not masked, not logged, not loaded.
    ///
    /// The reasoning is in the one `Deserialize` impl every stratum set shares:
    /// the invariant is unrepresentable in the running program, so no build of
    /// this engine can have written such a tile, and postcard is positional
    /// with nothing to resynchronise against — a stratum holding a foreign bit
    /// says the reader and the writer disagree about where the fields are, and
    /// every byte after it is suspect. Loading it anyway would produce a city
    /// that is quietly wrong, which is the failure mode the whole model exists
    /// to end.
    ///
    /// The forgery is done in bytes because there is no other way to do it:
    /// `StratumSet::<Surface>(1 << 9, PhantomData)` does not compile outside
    /// `occupants::strata`.
    #[test]
    fn a_snapshot_with_a_cross_stratum_bit_is_refused() {
        use crate::occupants::{occupant_bit, Occupant, OccupantSet};

        let mut bytes = to_bytes(&GameState::new(1, 1, 0)).unwrap();
        // Header, then `width`, `height`, the tile-vector length — all 1 — and
        // then the tile, whose first four fields are `terrain` and the three
        // strata. Asserted rather than assumed, so a reordering of `Tile` fails
        // here instead of silently testing nothing.
        let tile = 8 + 3;
        assert_eq!(
            &bytes[tile..tile + 4],
            &[0, 0, 0, 0],
            "expected Land + three empty strata at the head of the tile"
        );

        // Splice a hydro line — an *overhead* occupant — into `surface`.
        let line: OccupantSet = occupant_bit(Occupant::PowerLine);
        let forged = postcard::to_allocvec(&line).unwrap();
        bytes.splice(tile + 2..tile + 3, forged);

        let err = from_bytes(&bytes).expect_err("a forged stratum must not load");
        assert!(
            matches!(err, SnapshotError::Postcard(_)),
            "expected a decode error, got {err:?}"
        );
    }

    /// The same splice into `overhead`, where the bit does belong, loads
    /// cleanly — so the test above is failing on the *stratum*, not on the
    /// splice itself.
    #[test]
    fn the_same_bit_in_its_own_stratum_loads() {
        use crate::occupants::{occupant_bit, Occupant, OccupantSet};

        let mut bytes = to_bytes(&GameState::new(1, 1, 0)).unwrap();
        let tile = 8 + 3;
        let line: OccupantSet = occupant_bit(Occupant::PowerLine);
        let forged = postcard::to_allocvec(&line).unwrap();
        bytes.splice(tile + 3..tile + 4, forged);

        let state = from_bytes(&bytes).expect("a line overhead is a legal tile");
        assert!(state.tiles[0].has_occupant(Occupant::PowerLine));
        assert_eq!(
            state.tiles[0].occupants_in(crate::occupants::Stratum::Surface),
            0
        );
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
        use city_sim_protocol::building_kind::BuildingKind;

        let mut state = GameState::new(4, 4, 7);
        state.buildings.push(BuildingInstance {
            id: 1,
            kind: BuildingKind::Residential,
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
