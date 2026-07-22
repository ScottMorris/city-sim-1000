// import.rs — one-time import of legacy JSON saves into an exact GameState.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

//! Legacy-save import: rebuild a full `GameState` from the SoA tile buffer +
//! scalar stats that the TS app extracts from a pre-CSAV JSON save.
//!
//! Old browser/file saves serialised the TS display `GameState` as JSON; they
//! contain the complete tile grid and headline stats but no engine snapshot.
//! Rather than replaying a command log from seed (lossy — the source of #109),
//! the TS side re-encodes the saved tiles into the existing wire SoA layout
//! (`city-sim-protocol::tile_buffer`) and this module decodes it into a real
//! `GameState`, transplanting the saved RNG stream so the imported city
//! continues on the exact deterministic path it was saved on.
//!
//! Known, deliberate fidelity limits (legacy saves only — CSAV saves carry the
//! engine snapshot and lose nothing):
//! - Zone density is not stored on TS tiles; grown zones import as Low.
//! - Building status/health import as fresh `Active`/100 and self-correct on
//!   the next `update_building_states` tick.
//! - Derived stats (education, budget breakdown, wilderness) start at their
//!   defaults and are recomputed within one tick / recompute interval.

use city_sim_protocol::commands::Policies;
use city_sim_protocol::tile_buffer::{decode_happiness, TileBufferOffsets, BYTES_PER_TILE};
use city_sim_protocol::tile_kind::TileKind;

use crate::buildings::{
    get_building_template, BuildingInstance, COAL_PLANT_MW, HYDRO_PLANT_MW, SOLAR_FARM_MW,
    WIND_TURBINE_MW,
};
use crate::rng::SeededRng;
use crate::state::GameState;

/// Headline scalars carried alongside the tile buffer.
#[derive(Debug, Clone, Copy)]
pub struct ImportStats {
    pub money: i64,
    pub day: u32,
    pub tick: u64,
    pub population: u32,
    pub jobs: u32,
    pub policies: Policies,
}

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("tile buffer is {actual} bytes; expected {expected} for a {width}×{height} map")]
    BadLength {
        actual: usize,
        expected: usize,
        width: u32,
        height: u32,
    },
    #[error("tile {index} has invalid kind byte {value}")]
    BadKind { index: usize, value: u8 },
}

/// Per-type generation and upkeep for power plants — mirrors the values
/// `apply_tool` passes to `place_footprint_building` on live placement.
fn plant_stats(kind: TileKind) -> Option<(u32, f32)> {
    match kind {
        TileKind::HydroPlant => Some((HYDRO_PLANT_MW, 150.0)),
        TileKind::CoalPlant => Some((COAL_PLANT_MW, 300.0)),
        TileKind::WindTurbine => Some((WIND_TURBINE_MW, 30.0)),
        TileKind::SolarFarm => Some((SOLAR_FARM_MW, 20.0)),
        _ => None,
    }
}

/// Rebuild a full `GameState` from a wire-layout SoA tile buffer + scalars.
pub fn from_tile_buffer(
    width: u32,
    height: u32,
    seed: u32,
    rng_state: [u32; 4],
    buffer: &[u8],
    stats: ImportStats,
) -> Result<GameState, ImportError> {
    let n = (width as usize) * (height as usize);
    let expected = n * BYTES_PER_TILE;
    if buffer.len() != expected {
        return Err(ImportError::BadLength {
            actual: buffer.len(),
            expected,
            width,
            height,
        });
    }
    let o = TileBufferOffsets::for_size(n);

    let mut state = GameState::new(width, height, seed);
    state.money = stats.money;
    state.day = stats.day;
    state.tick = stats.tick;
    state.population = stats.population;
    state.jobs = stats.jobs;
    state.policies = stats.policies.clamped();
    state.rng = SeededRng::from_state(rng_state);

    let mut max_building_id: u32 = 0;
    for i in 0..n {
        let kind_byte = buffer[o.kind + i];
        let kind = TileKind::from_u8(kind_byte).ok_or(ImportError::BadKind {
            index: i,
            value: kind_byte,
        })?;
        let underground_byte = buffer[o.underground_kind + i];
        let building_id = u16::from_le_bytes([
            buffer[o.building_id + i * 2],
            buffer[o.building_id + i * 2 + 1],
        ]);

        let tile = &mut state.tiles[i];
        tile.kind = kind;
        tile.flags = buffer[o.flags + i];
        tile.happiness = decode_happiness(buffer[o.happiness + i]);
        tile.elevation = buffer[o.elevation + i];
        tile.building_id = (building_id != 0).then_some(building_id);
        tile.underground = if underground_byte == 0xFF {
            None
        } else {
            TileKind::from_u8(underground_byte)
        };

        if building_id != 0 {
            max_building_id = max_building_id.max(building_id as u32);
            if let Some((mw, _)) = plant_stats(kind) {
                tile.power_plant_mw = mw as i32;
            }
            if let Some(tmpl) = get_building_template(kind) {
                if tmpl.water_output > 0 {
                    tile.water_output = tmpl.water_output;
                }
            }
        }
    }

    // Rebuild the building list from first-occurrence origins per id. Tiles
    // are scanned row-major, so the first tile seen for an id is its top-left
    // footprint corner — the same convention `place_footprint_building` stamps.
    for i in 0..n {
        let Some(id) = state.tiles[i].building_id else {
            continue;
        };
        let id = id as u32;
        if state.buildings.iter().any(|b| b.id == id) {
            continue;
        }
        let kind = state.tiles[i].kind;
        let x = (i as u32) % width;
        let y = (i as u32) / width;
        let mut instance = BuildingInstance::new(id, kind, (x, y));
        if let Some((_, maintenance)) = plant_stats(kind) {
            instance.maintenance_per_day = maintenance;
        }
        state.buildings.push(instance);
    }
    state.next_building_id = max_building_id + 1;
    state.tile_revision = 1;

    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::apply_tool;
    use crate::sim::Simulation;
    use city_sim_protocol::commands::Tool;
    use city_sim_protocol::tile_buffer::encode_happiness;

    /// Encode a state's tiles the way the TS legacy exporter does — the exact
    /// inverse of `from_tile_buffer` (wilderness byte left neutral).
    fn encode_tiles(state: &GameState) -> Vec<u8> {
        let n = state.tiles.len();
        let o = TileBufferOffsets::for_size(n);
        let mut buf = vec![0u8; n * BYTES_PER_TILE];
        for (i, tile) in state.tiles.iter().enumerate() {
            buf[o.kind + i] = tile.kind as u8;
            buf[o.flags + i] = tile.flags;
            buf[o.happiness + i] = encode_happiness(tile.happiness);
            buf[o.elevation + i] = tile.elevation;
            let bid = tile.building_id.unwrap_or(0);
            buf[o.building_id + i * 2] = (bid & 0xFF) as u8;
            buf[o.building_id + i * 2 + 1] = ((bid >> 8) & 0xFF) as u8;
            buf[o.underground_kind + i] = tile.underground.map_or(0xFF, |k| k as u8);
            buf[o.wilderness + i] = 128;
        }
        buf
    }

    fn import_stats(state: &GameState) -> ImportStats {
        ImportStats {
            money: state.money,
            day: state.day,
            tick: state.tick,
            population: state.population,
            jobs: state.jobs,
            policies: state.policies,
        }
    }

    fn build_city() -> Simulation {
        let mut sim = Simulation::new(8, 8, 7);
        apply_tool(&mut sim.state, Tool::Road, 3, 0);
        apply_tool(&mut sim.state, Tool::Road, 3, 1);
        apply_tool(&mut sim.state, Tool::Residential, 2, 0);
        apply_tool(&mut sim.state, Tool::HydroPlant, 5, 5);
        apply_tool(&mut sim.state, Tool::WaterPump, 0, 5);
        apply_tool(&mut sim.state, Tool::WaterPipe, 2, 5);
        for _ in 0..60 {
            sim.step(1.0 / 20.0);
        }
        sim
    }

    #[test]
    fn round_trips_kinds_flags_buildings_and_ids() {
        let sim = build_city();
        let buf = encode_tiles(&sim.state);
        let imported = from_tile_buffer(
            8,
            8,
            7,
            sim.state.rng.to_state(),
            &buf,
            import_stats(&sim.state),
        )
        .expect("import succeeds");

        for (i, (a, b)) in sim
            .state
            .tiles
            .iter()
            .zip(imported.tiles.iter())
            .enumerate()
        {
            assert_eq!(a.kind, b.kind, "tile {i} kind");
            assert_eq!(a.flags, b.flags, "tile {i} flags");
            assert_eq!(a.building_id, b.building_id, "tile {i} building id");
            assert_eq!(a.underground, b.underground, "tile {i} underground");
            assert_eq!(a.power_plant_mw, b.power_plant_mw, "tile {i} plant MW");
            assert_eq!(a.water_output, b.water_output, "tile {i} water output");
        }
        assert_eq!(imported.next_building_id, sim.state.next_building_id);
        assert_eq!(imported.buildings.len(), sim.state.buildings.len());
        for b in &sim.state.buildings {
            let ib = imported
                .buildings
                .iter()
                .find(|x| x.id == b.id)
                .expect("building imported");
            assert_eq!(ib.kind, b.kind);
            assert_eq!(ib.origin, b.origin);
            assert_eq!(ib.maintenance_per_day, b.maintenance_per_day);
        }
        assert_eq!(imported.money, sim.state.money);
        assert_eq!(imported.tick, sim.state.tick);
    }

    #[test]
    fn transplanted_rng_continues_the_exact_sequence() {
        let sim = build_city();
        let buf = encode_tiles(&sim.state);
        let imported = from_tile_buffer(
            8,
            8,
            7,
            sim.state.rng.to_state(),
            &buf,
            import_stats(&sim.state),
        )
        .unwrap();
        let mut live_rng = sim.state.rng.clone();
        let mut imported_rng = imported.rng.clone();
        for _ in 0..32 {
            assert_eq!(live_rng.next_u32(), imported_rng.next_u32());
        }
    }

    #[test]
    fn rejects_wrong_buffer_length() {
        let err = from_tile_buffer(
            8,
            8,
            7,
            [1, 2, 3, 4],
            &[0u8; 7],
            ImportStats {
                money: 0,
                day: 1,
                tick: 0,
                population: 0,
                jobs: 0,
                policies: Policies::default(),
            },
        )
        .unwrap_err();
        assert!(matches!(err, ImportError::BadLength { .. }));
    }

    #[test]
    fn rejects_invalid_kind_byte() {
        let n = 4 * 4;
        let mut buf = vec![0u8; n * BYTES_PER_TILE];
        buf[0] = 250; // not a TileKind
        let err = from_tile_buffer(
            4,
            4,
            0,
            [1, 2, 3, 4],
            &buf,
            ImportStats {
                money: 0,
                day: 1,
                tick: 0,
                population: 0,
                jobs: 0,
                policies: Policies::default(),
            },
        )
        .unwrap_err();
        assert!(matches!(
            err,
            ImportError::BadKind {
                index: 0,
                value: 250
            }
        ));
    }
}
