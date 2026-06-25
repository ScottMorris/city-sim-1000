// lib.rs — WASM cdylib wrapper bridging sim_core to the browser Worker.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT
use city_sim_protocol::{
    commands::{CommandResult, SimCommand},
    tile_buffer::{TileBufferOffsets, BYTES_PER_TILE},
    tile_kind::TileKind,
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// Stub simulation host. Flips tile (1,1) between Land and Road on every
/// `step()` call so that the renderer shows visible proof of WASM writes.
/// All other tiles remain Land. No real simulation logic is run here.
#[wasm_bindgen]
pub struct SimHost {
    width: u32,
    height: u32,
    tick: u64,
    tile_kinds: Vec<u8>,
}

#[wasm_bindgen]
impl SimHost {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32) -> SimHost {
        let n = (width * height) as usize;
        SimHost {
            width,
            height,
            tick: 0,
            tile_kinds: vec![TileKind::Land as u8; n],
        }
    }

    pub fn tick_count(&self) -> u32 {
        self.tick as u32
    }
    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Advance one step: increment tick, toggle demo tile at (1,1).
    pub fn step(&mut self, _dt: f64) {
        self.tick += 1;
        if self.width > 2 && self.height > 2 {
            let idx = (1 * self.width + 1) as usize;
            self.tile_kinds[idx] = if self.tile_kinds[idx] == TileKind::Land as u8 {
                TileKind::Road as u8
            } else {
                TileKind::Land as u8
            };
        }
    }

    /// Accept a postcard-encoded `SimCommand`; return a postcard-encoded `CommandResult`.
    pub fn send_command(&self, bytes: &[u8]) -> Vec<u8> {
        // Decode for future use; ignore the result in the stub.
        let _: Result<SimCommand, _> = postcard::from_bytes(bytes);
        postcard::to_allocvec(&CommandResult::ok()).unwrap_or_default()
    }

    /// Return the number of bytes in the SoA tile buffer (width × height × 6).
    pub fn tile_buffer_byte_len(&self) -> usize {
        (self.width * self.height) as usize * BYTES_PER_TILE
    }

    /// Return a fresh SoA tile buffer with the current tile state.
    ///
    /// Layout (see `city_sim_protocol::tile_buffer`):
    ///   `kind[N] | flags[N] | happiness[N] | elevation[N] | building_id[N*2]`
    pub fn tile_buffer(&self) -> Vec<u8> {
        let n = (self.width * self.height) as usize;
        let o = TileBufferOffsets::for_size(n);
        let mut buf = vec![0u8; TileBufferOffsets::total_bytes(n)];
        for i in 0..n {
            buf[o.kind + i] = self.tile_kinds[i];
            // flags, happiness, elevation, building_id all remain 0
        }
        buf
    }
}
