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
///
/// **The three stratum fields landed inside v5, not in a v6.** v5 has never
/// been released — `origin/main` and `main` both read `VERSION = 4` — so it was
/// introduced and reshaped on the same unpushed branch, and a v6 would exist
/// solely to describe a shape that was never published. What a version number
/// buys is a migration path for bytes that exist; there are none to speak of,
/// so it would buy nothing and cost a permanent dead arm in [`from_bytes`].
/// The moment this branch is pushed that reasoning expires — the next change to
/// the tile's shape is a v6.
///
/// Be precise about what that costs, because it is not nothing. The restructure
/// changed no *simulated* behaviour, but it did move the persisted bytes:
/// `Tile` went from one varint `occupants` field to three, so a snapshot
/// written by an earlier commit *on this branch* no longer loads. The exposure
/// is a `.citysim` download or an IndexedDB save made while dev-running the
/// branch between the first stratum commit and this one, and nothing else. The
/// failure is loud rather than silent — the hand-written `Deserialize` on
/// `StratumSet` rejects a foreign bit pattern outright, which is what
/// `tests::a_snapshot_with_a_cross_stratum_bit_is_refused` covers — so such a
/// save errors instead of decoding into a wrong city.
///
/// v4 is still **readable**: [`from_bytes`] dispatches it through
/// [`crate::migrate::v4_to_v5`], which describes the old `GameState` field for
/// field and converts each tile with [`crate::migrate::tile_from_v4`] — the
/// same function `import.rs` uses for the legacy buffer path. Loading a v4 save
/// and saving it again upgrades it in place; there is no downgrade path and
/// none is wanted.
const VERSION: u32 = 5;

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
        // The pre-strata tile shape — decoded against a shim that spells the
        // old `GameState` out positionally, then converted.
        4 => postcard::from_bytes::<crate::migrate::v4::GameState>(payload)
            .map(crate::migrate::v4_to_v5)
            .map_err(SnapshotError::Postcard),
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
