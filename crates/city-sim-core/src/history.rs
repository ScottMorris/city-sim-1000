// history.rs — bounded undo/redo stack of full GameState snapshots.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

//! Snapshot-stack undo/redo shared by the WASM host and the Tauri plugin.
//!
//! One snapshot is captured per player *stroke* (a drag paints many tiles but
//! forms a single undo step), taken immediately **before** the stroke's first
//! successful command. Undo restores the full pre-stroke state — tiles, money,
//! population, RNG stream, and the clock — via `Simulation::load_state`; redo
//! returns to the exact moment undo was pressed. Policies are deliberately
//! outside the stack: hosts re-apply the live `Policies` value after every
//! restore, because undo applies to tools, not to policy changes.
//!
//! Entries hold postcard `snapshot::to_bytes` blobs rather than `GameState`
//! clones — ~35 % smaller, and every push exercises the serde path that saves
//! depend on. The stack is session-only: it is never serialised, and hosts
//! clear it on load/new-game so a loaded save is the undo floor.

use std::collections::VecDeque;

use crate::snapshot;
use crate::state::GameState;

/// Bounds for the in-memory history. Both caps apply; the oldest undo entries
/// are evicted first when either is exceeded.
#[derive(Debug, Clone, Copy)]
pub struct HistoryConfig {
    /// Maximum number of undo entries (strokes) retained.
    pub max_entries: usize,
    /// Maximum total bytes across the undo and redo stacks.
    pub max_bytes: usize,
}

impl Default for HistoryConfig {
    fn default() -> Self {
        Self {
            max_entries: 64,
            max_bytes: 32 * 1024 * 1024,
        }
    }
}

struct Entry {
    /// `snapshot::to_bytes` blob of the state this entry restores.
    bytes: Vec<u8>,
    /// Stroke id the entry was captured for — used to coalesce the many
    /// `apply_tool` calls of one drag into a single undo step.
    stroke: u64,
}

/// Bounded undo/redo history of engine snapshots.
#[derive(Default)]
pub struct History {
    undo: VecDeque<Entry>,
    redo: Vec<Entry>,
    total_bytes: usize,
    config: HistoryConfig,
}

impl History {
    pub fn new(config: HistoryConfig) -> Self {
        Self {
            undo: VecDeque::new(),
            redo: Vec::new(),
            total_bytes: 0,
            config,
        }
    }

    /// Serialise `state` as a prospective undo point for `stroke`.
    ///
    /// Returns `None` when the top undo entry already belongs to this stroke
    /// (later commands of the same drag share its snapshot) or when
    /// serialisation fails (no undo point, never a crash). The caller applies
    /// the command and passes the bytes to [`History::commit`] only on
    /// success, so a stroke whose first commands all fail anchors its snapshot
    /// to the first command that actually lands.
    pub fn prepare(&self, state: &GameState, stroke: u64) -> Option<Vec<u8>> {
        if self.undo.back().is_some_and(|e| e.stroke == stroke) {
            return None;
        }
        snapshot::to_bytes(state).ok()
    }

    /// Push a prepared snapshot as the newest undo entry.
    ///
    /// Clears the redo stack (a fresh action forks the timeline) and evicts
    /// the oldest undo entries beyond the configured caps.
    pub fn commit(&mut self, bytes: Vec<u8>, stroke: u64) {
        self.clear_redo();
        self.total_bytes += bytes.len();
        self.undo.push_back(Entry { bytes, stroke });
        while self.undo.len() > 1
            && (self.undo.len() > self.config.max_entries
                || self.total_bytes > self.config.max_bytes)
        {
            if let Some(evicted) = self.undo.pop_front() {
                self.total_bytes -= evicted.bytes.len();
            }
        }
    }

    /// Pop the newest undo entry and decode it. `current` (the live state at
    /// the moment undo is pressed) is pushed onto the redo stack so redo
    /// returns exactly here. Returns `None` when there is nothing to undo.
    pub fn undo(&mut self, current: &GameState) -> Option<GameState> {
        let entry = self.undo.pop_back()?;
        self.total_bytes -= entry.bytes.len();
        let restored = snapshot::from_bytes(&entry.bytes).ok()?;
        if let Ok(bytes) = snapshot::to_bytes(current) {
            self.total_bytes += bytes.len();
            self.redo.push(Entry {
                bytes,
                stroke: entry.stroke,
            });
        }
        Some(restored)
    }

    /// Pop the newest redo entry and decode it. `current` is pushed back onto
    /// the undo stack so undo returns exactly here. Returns `None` when there
    /// is nothing to redo.
    pub fn redo(&mut self, current: &GameState) -> Option<GameState> {
        let entry = self.redo.pop()?;
        self.total_bytes -= entry.bytes.len();
        let restored = snapshot::from_bytes(&entry.bytes).ok()?;
        if let Ok(bytes) = snapshot::to_bytes(current) {
            self.total_bytes += bytes.len();
            self.undo.push_back(Entry {
                bytes,
                stroke: entry.stroke,
            });
        }
        Some(restored)
    }

    /// Drop all history. Called on load/new-game — the freshly loaded state
    /// becomes the undo floor.
    pub fn clear(&mut self) {
        self.undo.clear();
        self.clear_redo();
        self.total_bytes = 0;
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    fn clear_redo(&mut self) {
        for entry in self.redo.drain(..) {
            self.total_bytes -= entry.bytes.len();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::{state_hash, Simulation};
    use city_sim_protocol::commands::Tool;

    fn make_sim() -> Simulation {
        let mut sim = Simulation::new(8, 8, 42);
        sim.state.demand.residential = 80.0;
        sim
    }

    /// Mirror of the host apply pattern: prepare → apply → commit on success.
    fn host_apply(
        sim: &mut Simulation,
        history: &mut History,
        stroke: u64,
        tool: Tool,
        x: u32,
        y: u32,
    ) -> bool {
        let pending = history.prepare(&sim.state, stroke);
        let result = crate::commands::apply_tool(&mut sim.state, tool, x, y);
        if result.success {
            if let Some(bytes) = pending {
                history.commit(bytes, stroke);
            }
        }
        result.success
    }

    #[test]
    fn undo_restores_the_exact_pre_stroke_state() {
        let mut sim = make_sim();
        let mut history = History::new(HistoryConfig::default());
        for _ in 0..10 {
            sim.step(1.0 / 20.0);
        }
        let before = state_hash(&sim.state);
        assert!(host_apply(&mut sim, &mut history, 1, Tool::Road, 3, 3));
        for _ in 0..10 {
            sim.step(1.0 / 20.0);
        }
        let restored = history.undo(&sim.state).expect("one entry to undo");
        assert_eq!(
            state_hash(&restored),
            before,
            "undo must restore the pre-stroke state exactly"
        );
    }

    #[test]
    fn redo_returns_to_the_moment_undo_was_pressed() {
        let mut sim = make_sim();
        let mut history = History::new(HistoryConfig::default());
        assert!(host_apply(&mut sim, &mut history, 1, Tool::Road, 3, 3));
        for _ in 0..7 {
            sim.step(1.0 / 20.0);
        }
        let at_undo_press = state_hash(&sim.state);
        let restored = history.undo(&sim.state).unwrap();
        sim.load_state(restored);
        let redone = history.redo(&sim.state).expect("one entry to redo");
        assert_eq!(
            state_hash(&redone),
            at_undo_press,
            "redo must return to the pre-undo moment"
        );
        assert!(
            history.can_undo(),
            "the undone stroke is undoable again after redo"
        );
    }

    #[test]
    fn same_stroke_commands_share_one_undo_entry() {
        let mut sim = make_sim();
        let mut history = History::new(HistoryConfig::default());
        assert!(host_apply(&mut sim, &mut history, 7, Tool::Road, 1, 1));
        assert!(host_apply(&mut sim, &mut history, 7, Tool::Road, 2, 1));
        assert!(host_apply(&mut sim, &mut history, 7, Tool::Road, 3, 1));
        assert_eq!(history.undo.len(), 1, "a drag is one undo step");
        let restored = history.undo(&sim.state).unwrap();
        assert!(
            restored
                .tiles
                .iter()
                .all(|t| !t.has_occupant(crate::occupants::Occupant::Road)),
            "undoing the stroke removes every tile it painted"
        );
    }

    #[test]
    fn failed_first_command_does_not_create_an_entry() {
        let mut sim = make_sim();
        let mut history = History::new(HistoryConfig::default());
        // Out of bounds — rejected.
        assert!(!host_apply(&mut sim, &mut history, 1, Tool::Road, 99, 99));
        assert!(!history.can_undo());
        // Later success in the same stroke anchors the snapshot there.
        assert!(host_apply(&mut sim, &mut history, 1, Tool::Road, 3, 3));
        assert!(history.can_undo());
    }

    #[test]
    fn new_commit_clears_the_redo_stack() {
        let mut sim = make_sim();
        let mut history = History::new(HistoryConfig::default());
        assert!(host_apply(&mut sim, &mut history, 1, Tool::Road, 3, 3));
        let restored = history.undo(&sim.state).unwrap();
        sim.load_state(restored);
        assert!(history.can_redo());
        assert!(host_apply(&mut sim, &mut history, 2, Tool::Tree, 4, 4));
        assert!(!history.can_redo(), "a fresh action forks the timeline");
    }

    #[test]
    fn max_entries_evicts_oldest_first() {
        let mut sim = make_sim();
        let mut history = History::new(HistoryConfig {
            max_entries: 3,
            max_bytes: usize::MAX,
        });
        for (i, x) in (0..5).enumerate() {
            assert!(host_apply(
                &mut sim,
                &mut history,
                i as u64,
                Tool::Road,
                x,
                0
            ));
        }
        assert_eq!(history.undo.len(), 3);
        // Entries for strokes 2, 3, 4 survive; the oldest two were evicted.
        assert_eq!(history.undo.front().unwrap().stroke, 2);
    }

    #[test]
    fn byte_cap_evicts_but_always_keeps_one_entry() {
        let mut sim = make_sim();
        // Absurdly small cap: every snapshot exceeds it on its own.
        let mut history = History::new(HistoryConfig {
            max_entries: 64,
            max_bytes: 1,
        });
        assert!(host_apply(&mut sim, &mut history, 1, Tool::Road, 1, 0));
        assert!(host_apply(&mut sim, &mut history, 2, Tool::Road, 2, 0));
        assert_eq!(
            history.undo.len(),
            1,
            "the newest entry survives the byte cap"
        );
        assert_eq!(history.undo.front().unwrap().stroke, 2);
    }

    #[test]
    fn empty_stacks_return_none() {
        let mut history = History::new(HistoryConfig::default());
        let sim = make_sim();
        assert!(history.undo(&sim.state).is_none());
        assert!(history.redo(&sim.state).is_none());
        assert!(!history.can_undo());
        assert!(!history.can_redo());
    }

    #[test]
    fn clear_empties_everything() {
        let mut sim = make_sim();
        let mut history = History::new(HistoryConfig::default());
        assert!(host_apply(&mut sim, &mut history, 1, Tool::Road, 3, 3));
        let restored = history.undo(&sim.state).unwrap();
        sim.load_state(restored);
        history.clear();
        assert!(!history.can_undo());
        assert!(!history.can_redo());
        assert_eq!(history.total_bytes, 0);
    }

    #[test]
    fn byte_accounting_balances_across_operations() {
        let mut sim = make_sim();
        let mut history = History::new(HistoryConfig::default());
        for i in 0..3 {
            assert!(host_apply(
                &mut sim,
                &mut history,
                i,
                Tool::Road,
                i as u32,
                0
            ));
        }
        while let Some(restored) = history.undo(&sim.state) {
            sim.load_state(restored);
        }
        while let Some(restored) = history.redo(&sim.state) {
            sim.load_state(restored);
        }
        let expected: usize = history.undo.iter().map(|e| e.bytes.len()).sum::<usize>()
            + history.redo.iter().map(|e| e.bytes.len()).sum::<usize>();
        assert_eq!(history.total_bytes, expected);
        history.clear();
        assert_eq!(history.total_bytes, 0);
    }
}
