// error.rs — plugin-level error type exposed to Tauri and JS callers.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("simulation is not running — call start first")]
    NotStarted,
    #[error("simulation thread has exited")]
    ChannelClosed,
    #[error("command queue is full — slow down input")]
    ChannelFull,
    #[error("unknown tool id: {0}")]
    InvalidTool(u8),
    #[error("snapshot error: {0}")]
    Snapshot(String),
    #[error("timed out waiting for snapshot from sim thread")]
    SnapshotTimeout,
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
