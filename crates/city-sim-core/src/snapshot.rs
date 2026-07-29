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
// The v4 fixture — a genuine pre-strata save, loaded and checked byte for byte
// ---------------------------------------------------------------------------

/// Loading a real v4 file and proving the city that comes out is the city that
/// went in.
///
/// The fixture is not synthesised by this module: `city_v4.csim` was written by
/// `snapshot::to_bytes` on the commit
/// `fix(sim): read every stratum, so no feature goes uncounted` — step 2 of
/// #177, the last commit before the tile was stratified — by a throwaway
/// `dump_v4_fixture` generator that has since been deleted. (Named by subject,
/// not by hash: rebasing this branch changes the hash and leaves the citation
/// pointing at nothing.) `city_v4.expected` is what that same tree put on the wire for
/// every tile. Neither file can be regenerated from this tree, which is the
/// point: a migration you can only demonstrate against your own output is not a
/// migration.
///
/// **The comparison is on the derived wire bytes, not on the new struct's
/// fields.** The wire is the one vocabulary that exists on both sides of the
/// change, so "the loaded city is identical to what v4 produced" is a claim a
/// reviewer can check — and it is simultaneously the proof that `app/src/`
/// needs no changes.
#[cfg(test)]
mod v4_fixture {
    use super::*;
    use crate::display;
    use crate::occupants::StructureLookup;
    use city_sim_protocol::tile_buffer::flags;
    use city_sim_protocol::tile_kind::TileKind;

    const CSIM: &[u8] = include_bytes!("../tests/fixtures/city_v4.csim");
    const EXPECTED: &str = include_str!("../tests/fixtures/city_v4.expected");

    /// What v4 recorded for one tile: the four values it put on the wire.
    struct V4Tile {
        kind: String,
        flags: u8,
        underground: u8,
        building_id: u32,
    }

    /// The three ways a v4 tile is *allowed* to come back spelled differently.
    ///
    /// The first two are cases where v4 had **two** spellings for one physical
    /// tile and the strata have one, so the difference being erased is the
    /// whole point of the occupant model rather than a defect in it. The third
    /// is not a spelling collapse at all: it deletes an occupant, and so it
    /// moves the loaded city's wilderness score and every trajectory downstream
    /// of it. That is deliberate — it is delta 3 of `display.rs`'s module note,
    /// the one change in step 3 that is a gameplay fix rather than a
    /// representation change. Every other tile must match exactly.
    #[derive(Debug, PartialEq, Eq, Hash, Clone, Copy, PartialOrd, Ord)]
    enum Normalisation {
        /// `Road` + `RAIL_UNDERLAY` → `Rail` + `ROAD_UNDERLAY`. A level
        /// crossing built road-last. Build order is not a property of the tile
        /// and is not stored, so the two orders collapse; rail wins because a
        /// railway dragged across an existing road is the commoner history.
        CrossingBuiltRoadLast,
        /// `Land` + `POWER_OVERLAY` → `PowerLine` + `POWER_OVERLAY`. A hydro
        /// line demoted to the flag by a later regrade. The tile still carries
        /// a line; v4 just forgot to say so in the kind byte.
        LineDemotedByARegrade,
        /// A structure kind with no development behind it → `Land`. A park
        /// `remove_building` bulldozed and left the `kind` of. It scored and
        /// billed as a park with nothing there. **Not a spelling collapse** —
        /// dropping it changes the loaded city's wilderness score, which is
        /// the intended fix, not a side effect.
        GhostStructure,
    }

    /// `TileKind` has no `from_str`, and the fixture records kinds by name so a
    /// reviewer can read it. Twenty discriminants, matched on their `Debug`
    /// spelling — the same spelling the generator wrote.
    fn kind_by_name(name: &str) -> Option<TileKind> {
        (0u8..=u8::MAX)
            .filter_map(TileKind::from_u8)
            .find(|k| format!("{k:?}") == name)
    }

    fn classify(want: &V4Tile, got_kind: &str, got_flags: u8) -> Option<Normalisation> {
        let road_last = want.kind == "Road"
            && want.flags & flags::RAIL_UNDERLAY != 0
            && got_kind == "Rail"
            && got_flags == (want.flags & !flags::RAIL_UNDERLAY) | flags::ROAD_UNDERLAY;
        if road_last {
            return Some(Normalisation::CrossingBuiltRoadLast);
        }
        let demoted = want.kind == "Land"
            && want.flags & flags::POWER_OVERLAY != 0
            && got_kind == "PowerLine"
            && got_flags == want.flags;
        if demoted {
            return Some(Normalisation::LineDemotedByARegrade);
        }
        let ghost = want.building_id == 65535
            && kind_by_name(&want.kind).is_some_and(crate::occupants::is_structure_kind)
            && got_kind == "Land"
            && got_flags == want.flags;
        if ghost {
            return Some(Normalisation::GhostStructure);
        }
        None
    }

    #[test]
    fn v4_snapshot_loads_the_same_city() {
        assert_eq!(
            u32::from_le_bytes(CSIM[4..8].try_into().unwrap()),
            4,
            "the fixture must still be a v4 file"
        );

        let state = from_bytes(CSIM).expect("a genuine v4 save must still load");

        // --- parse the expectations --------------------------------------
        let mut want_tiles: Vec<Option<V4Tile>> = Vec::new();
        let mut want_buildings: Vec<String> = Vec::new();
        let mut scalars: Vec<(String, String)> = Vec::new();
        for line in EXPECTED.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let f: Vec<&str> = line.split_whitespace().collect();
            match f[0] {
                "tile" => {
                    let idx: usize = f[1].parse().unwrap();
                    if want_tiles.len() <= idx {
                        want_tiles.resize_with(idx + 1, || None);
                    }
                    want_tiles[idx] = Some(V4Tile {
                        kind: f[2].to_string(),
                        flags: f[3].parse().unwrap(),
                        underground: f[4].parse().unwrap(),
                        building_id: f[5].parse().unwrap(),
                    });
                }
                "building" => want_buildings.push(f[1..].join(" ")),
                "grid" => {}
                key => scalars.push((key.to_string(), f[1].to_string())),
            }
        }
        assert_eq!(want_tiles.len(), state.tiles.len(), "tile count");
        assert!(!want_buildings.is_empty(), "fixture has buildings");

        // --- scalars ------------------------------------------------------
        for (key, want) in &scalars {
            let got = match key.as_str() {
                "money" => state.money.to_string(),
                "day" => state.day.to_string(),
                "tick" => state.tick.to_string(),
                "population" => state.population.to_string(),
                "jobs" => state.jobs.to_string(),
                // The v4 hash is deliberately not compared: `state_hash` mixes
                // in the wire kind byte, so the normalised tiles below move it
                // by construction. `v5_hash_of_the_migrated_fixture_is_stable`
                // pins the value that actually comes out.
                "state_hash" => continue,
                other => panic!("unknown scalar {other} in fixture"),
            };
            assert_eq!(&got, want, "scalar `{key}` changed across the migration");
        }

        // --- the grid, tile by tile --------------------------------------
        let lookup = StructureLookup::new(&state);
        let mut normalised: Vec<(usize, Normalisation)> = Vec::new();
        for (i, tile) in state.tiles.iter().enumerate() {
            let want = want_tiles[i].as_ref().expect("every tile is recorded");
            let (kind, got_flags) = display::wire_kind_and_flags(tile, &lookup);
            let got_kind = format!("{kind:?}");
            let got_underground = display::wire_underground(tile);
            let got_bid = tile.building_id.map_or(65535u32, u32::from);

            // The underground stratum and the development never normalise.
            assert_eq!(
                got_underground, want.underground,
                "tile {i}: underground byte moved"
            );
            assert_eq!(got_bid, want.building_id, "tile {i}: building_id moved");

            if got_kind == want.kind && got_flags == want.flags {
                continue;
            }
            match classify(want, &got_kind, got_flags) {
                Some(n) => normalised.push((i, n)),
                None => panic!(
                    "tile {i}: v4 wrote {}/{} and v5 derives {got_kind}/{got_flags} — \
                     that is not one of the three documented normalisations",
                    want.kind, want.flags
                ),
            }
        }

        // --- the buildings ------------------------------------------------
        let got_buildings: Vec<String> = state
            .buildings
            .iter()
            .map(|b| {
                format!(
                    "{} {:?} {} {} {:?}",
                    b.id, b.kind, b.origin.0, b.origin.1, b.status
                )
            })
            .collect();
        assert_eq!(got_buildings, want_buildings, "the building list changed");

        // --- and the normalisations really are exercised ------------------
        // Without this the test would still pass on a fixture that happened to
        // contain none of the interesting tiles.
        let mut kinds: Vec<Normalisation> = normalised.iter().map(|(_, n)| *n).collect();
        kinds.sort();
        kinds.dedup();
        assert_eq!(
            kinds,
            vec![
                Normalisation::CrossingBuiltRoadLast,
                Normalisation::LineDemotedByARegrade,
                Normalisation::GhostStructure,
            ],
            "the fixture must exercise all three normalisations, and only those \
             — got {normalised:?}"
        );
    }

    /// The migrated fixture's hash, pinned.
    ///
    /// This is *not* the hash `city_v4.expected` records. `state_hash` feeds the
    /// wire kind byte in, and the tiles listed by `v4_snapshot_loads_the_same_city`
    /// as normalised change that byte by design — a road-last level crossing now
    /// hashes as `Rail`, a regraded line as `PowerLine`, a ghost park as `Land`.
    /// The per-tile assertions in that test are what prove the city survived;
    /// this one only stops the migrated result drifting silently later.
    #[test]
    fn v5_hash_of_the_migrated_fixture_is_stable() {
        let state = from_bytes(CSIM).expect("load v4");
        assert_eq!(
            crate::sim::state_hash(&state),
            V5_HASH_OF_V4_FIXTURE,
            "the migrated v4 fixture hashes differently than when it was committed"
        );
    }

    const V5_HASH_OF_V4_FIXTURE: u64 = 0xe569aac15ab7c67c;

    /// A v4 file re-saved comes back out as v5, and reloads unchanged.
    #[test]
    fn resaving_a_v4_file_upgrades_it_in_place() {
        let migrated = from_bytes(CSIM).expect("load v4");
        let bytes = to_bytes(&migrated).expect("save");
        assert_eq!(
            u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            5,
            "re-saving must write the current version"
        );
        let reloaded = from_bytes(&bytes).expect("reload v5");
        assert_eq!(
            crate::sim::state_hash(&reloaded),
            crate::sim::state_hash(&migrated),
            "the v5 round trip is lossless"
        );
    }
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
