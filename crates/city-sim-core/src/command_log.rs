// command_log.rs — record and deterministic replay of player tool commands.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use city_sim_protocol::commands::Tool;

use crate::commands::apply_tool;
use crate::sim::Simulation;

const MAGIC: &[u8; 4] = b"CLOG";
/// v2: added the optional `terrain` natural-terrain baseline. v1 logs are
/// still readable — they decode with no terrain layer.
const VERSION: u32 = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// One recorded player action: the sim tick at which it was applied, the tool
/// used, and the tile coordinates.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CommandLogEntry {
    pub tick: u64,
    pub tool: u8,
    pub x: u32,
    pub y: u32,
}

/// A complete record of every player tool action issued during a session,
/// plus the city dimensions and RNG seed needed to recreate the starting map.
///
/// Serialised with a `CLOG` magic header (same pattern as `snapshot.rs`),
/// followed by a postcard-encoded payload. The format is compact: each entry
/// is ~10 bytes, so even a long session produces a small file.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CommandLog {
    pub width: u32,
    pub height: u32,
    pub seed: u32,
    pub entries: Vec<CommandLogEntry>,
    /// Natural terrain baseline: one `TileKind` u8 per tile, row-major.
    /// Applied via `GameState::seed_natural_terrain` before replaying
    /// commands, so replays (including undo) start from the generated
    /// water/tree map rather than all-Land.
    pub terrain: Option<Vec<u8>>,
}

/// v1 wire layout — no terrain field. Kept so old logs stay readable.
#[derive(serde::Deserialize)]
struct CommandLogV1 {
    width: u32,
    height: u32,
    seed: u32,
    entries: Vec<CommandLogEntry>,
}

impl CommandLog {
    /// Create an empty log for a new city.
    pub fn new(width: u32, height: u32, seed: u32) -> Self {
        Self {
            width,
            height,
            seed,
            entries: Vec::new(),
            terrain: None,
        }
    }

    /// Set the natural terrain baseline applied at the start of every replay.
    pub fn set_terrain(&mut self, kinds: Vec<u8>) {
        self.terrain = Some(kinds);
    }

    /// Append a tool action at the current sim tick.
    pub fn record(&mut self, tick: u64, tool: Tool, x: u32, y: u32) {
        self.entries.push(CommandLogEntry {
            tick,
            tool: tool as u8,
            x,
            y,
        });
    }

    /// Serialise to bytes: `CLOG` magic (4 B) + version u32 LE (4 B) + postcard payload.
    pub fn to_bytes(&self) -> Result<Vec<u8>, postcard::Error> {
        let payload = postcard::to_allocvec(self)?;
        let mut out = Vec::with_capacity(8 + payload.len());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&VERSION.to_le_bytes());
        out.extend_from_slice(&payload);
        Ok(out)
    }

    /// Deserialise a command log produced by [`to_bytes`].
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, CommandLogError> {
        if bytes.len() < 8 {
            return Err(CommandLogError::TooShort);
        }
        if &bytes[..4] != MAGIC {
            return Err(CommandLogError::BadMagic);
        }
        let version = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        match version {
            1 => {
                let v1: CommandLogV1 =
                    postcard::from_bytes(&bytes[8..]).map_err(CommandLogError::Postcard)?;
                Ok(Self {
                    width: v1.width,
                    height: v1.height,
                    seed: v1.seed,
                    entries: v1.entries,
                    terrain: None,
                })
            }
            VERSION => postcard::from_bytes(&bytes[8..]).map_err(CommandLogError::Postcard),
            other => Err(CommandLogError::UnsupportedVersion(other)),
        }
    }

    /// Remove the most-recently recorded entry and return `true`, or return
    /// `false` if the log is empty.
    ///
    /// Used by the undo system: after `pop()`, call [`replay()`] to rewind
    /// the simulation to just before the popped command was applied.
    pub fn pop(&mut self) -> bool {
        if self.entries.is_empty() {
            false
        } else {
            self.entries.pop();
            true
        }
    }

    /// Replay the log from scratch and return the resulting [`Simulation`].
    ///
    /// Creates a fresh `Simulation::new(width, height, seed)` and applies
    /// each recorded command at its original tick by advancing the sim at
    /// `dt = 1/20 s` until the tick count matches. The returned `Simulation`
    /// is in the same state as at the end of the original session.
    ///
    /// Note: replay runs at full CPU speed with no frame limiter. A very long
    /// session may take several seconds on a slow machine.
    pub fn replay(&self) -> Simulation {
        let mut sim = Simulation::new(self.width, self.height, self.seed);
        if let Some(terrain) = &self.terrain {
            sim.state.seed_natural_terrain(terrain);
        }
        for entry in &self.entries {
            while sim.state.tick < entry.tick {
                sim.step(1.0 / 20.0);
            }
            if let Ok(tool) = Tool::try_from(entry.tool) {
                apply_tool(&mut sim.state, tool, entry.x, entry.y);
            }
        }
        sim
    }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum CommandLogError {
    #[error("command log too short to contain header")]
    TooShort,
    #[error("bad magic — not a CLOG file")]
    BadMagic,
    #[error("unsupported command log version {0}")]
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
    use city_sim_protocol::commands::Tool;

    fn make_log() -> CommandLog {
        let mut log = CommandLog::new(8, 8, 42);
        log.record(0, Tool::Road, 3, 0);
        log.record(0, Tool::Road, 3, 1);
        log.record(0, Tool::Residential, 0, 0);
        log.record(5, Tool::Commercial, 0, 2);
        log
    }

    #[test]
    fn round_trip_preserves_entries() {
        let original = make_log();
        let bytes = original.to_bytes().expect("serialise");
        let restored = CommandLog::from_bytes(&bytes).expect("deserialise");
        assert_eq!(restored.width, original.width);
        assert_eq!(restored.height, original.height);
        assert_eq!(restored.seed, original.seed);
        assert_eq!(restored.entries.len(), original.entries.len());
        for (a, b) in original.entries.iter().zip(restored.entries.iter()) {
            assert_eq!(a, b);
        }
    }

    #[test]
    fn header_magic_and_version() {
        let bytes = CommandLog::new(4, 4, 0).to_bytes().unwrap();
        assert_eq!(&bytes[..4], b"CLOG");
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 2);
    }

    #[test]
    fn v1_log_decodes_with_no_terrain() {
        // Hand-build a v1 payload: same fields minus `terrain`.
        #[derive(serde::Serialize)]
        struct V1 {
            width: u32,
            height: u32,
            seed: u32,
            entries: Vec<CommandLogEntry>,
        }
        let payload = postcard::to_allocvec(&V1 {
            width: 8,
            height: 8,
            seed: 42,
            entries: vec![CommandLogEntry {
                tick: 0,
                tool: Tool::Road as u8,
                x: 3,
                y: 0,
            }],
        })
        .unwrap();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"CLOG");
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&payload);

        let log = CommandLog::from_bytes(&bytes).expect("v1 log must decode");
        assert_eq!(log.seed, 42);
        assert_eq!(log.entries.len(), 1);
        assert!(log.terrain.is_none());
    }

    #[test]
    fn replay_applies_terrain_baseline() {
        use city_sim_protocol::tile_kind::TileKind;

        let mut log = CommandLog::new(4, 4, 7);
        // Tile 0 water, tile 1 tree, rest land.
        let mut terrain = vec![TileKind::Land as u8; 16];
        terrain[0] = TileKind::Water as u8;
        terrain[1] = TileKind::Tree as u8;
        log.set_terrain(terrain);

        let sim = log.replay();
        assert_eq!(sim.state.tiles[0].kind, TileKind::Water);
        assert_eq!(sim.state.tiles[1].kind, TileKind::Tree);
        assert_eq!(sim.state.tiles[2].kind, TileKind::Land);
    }

    #[test]
    fn terrain_round_trips_through_bytes() {
        let mut log = CommandLog::new(2, 2, 0);
        log.set_terrain(vec![1, 2, 0, 0]);
        let restored = CommandLog::from_bytes(&log.to_bytes().unwrap()).unwrap();
        assert_eq!(restored.terrain.as_deref(), Some(&[1u8, 2, 0, 0][..]));
    }

    #[test]
    fn bad_magic_returns_error() {
        let mut bytes = CommandLog::new(4, 4, 0).to_bytes().unwrap();
        bytes[0] = 0x00;
        assert!(matches!(
            CommandLog::from_bytes(&bytes),
            Err(CommandLogError::BadMagic)
        ));
    }

    #[test]
    fn wrong_version_returns_error() {
        let mut bytes = CommandLog::new(4, 4, 0).to_bytes().unwrap();
        bytes[4..8].copy_from_slice(&99u32.to_le_bytes());
        assert!(matches!(
            CommandLog::from_bytes(&bytes),
            Err(CommandLogError::UnsupportedVersion(99))
        ));
    }

    #[test]
    fn too_short_returns_error() {
        assert!(matches!(
            CommandLog::from_bytes(&[0u8; 4]),
            Err(CommandLogError::TooShort)
        ));
    }

    #[test]
    fn replay_produces_same_state_as_live_run() {
        use crate::sim::state_hash;

        // Run a live session, recording manually.
        let mut log = CommandLog::new(8, 8, 42);
        let mut sim = Simulation::new(8, 8, 42);

        // Record before apply — mirrors production order in commands.rs.
        log.record(sim.state.tick, Tool::Road, 3, 0);
        apply_tool(&mut sim.state, Tool::Road, 3, 0);

        log.record(sim.state.tick, Tool::Road, 3, 1);
        apply_tool(&mut sim.state, Tool::Road, 3, 1);

        log.record(sim.state.tick, Tool::Residential, 0, 0);
        apply_tool(&mut sim.state, Tool::Residential, 0, 0);

        // Advance a few ticks.
        for _ in 0..10 {
            sim.step(1.0 / 20.0);
        }

        log.record(sim.state.tick, Tool::Commercial, 0, 2);
        apply_tool(&mut sim.state, Tool::Commercial, 0, 2);

        // Run to tick 50.
        while sim.state.tick < 50 {
            sim.step(1.0 / 20.0);
        }

        let live_hash = state_hash(&sim.state);

        // Replay and advance to the same tick.
        let mut replayed = log.replay();
        while replayed.state.tick < 50 {
            replayed.step(1.0 / 20.0);
        }

        assert_eq!(
            live_hash,
            state_hash(&replayed.state),
            "replay must produce identical state to live run"
        );
    }

    #[test]
    fn empty_log_replay_matches_fresh_sim() {
        use crate::sim::state_hash;

        let log = CommandLog::new(4, 4, 7);
        let mut replayed = log.replay();
        let mut fresh = Simulation::new(4, 4, 7);

        for _ in 0..20 {
            replayed.step(1.0 / 20.0);
            fresh.step(1.0 / 20.0);
        }

        assert_eq!(state_hash(&replayed.state), state_hash(&fresh.state));
    }
}
