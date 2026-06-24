// sim_wasm — WASM cdylib wrapper.
// Filled in during Phase 2 (stub sim) and Phase 3 (real sim).
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}
