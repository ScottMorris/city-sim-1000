use std::collections::{HashSet, VecDeque};
use sim_protocol::tile_kind::TileKind;
use crate::state::{GameState, Tile, FLAG_POWERED, FLAG_WATERED};

/// Four orthogonal directions as (dx, dy) pairs.
const DIRS: [(i32, i32); 4] = [(0, -1), (1, 0), (0, 1), (-1, 0)];

/// Iterator over in-bounds orthogonal neighbours of (x, y).
pub fn orthogonal_neighbours(
    width: u32,
    height: u32,
    x: u32,
    y: u32,
) -> impl Iterator<Item = (u32, u32)> {
    DIRS.into_iter().filter_map(move |(dx, dy)| {
        let nx = x as i32 + dx;
        let ny = y as i32 + dy;
        if nx >= 0 && ny >= 0 && (nx as u32) < width && (ny as u32) < height {
            Some((nx as u32, ny as u32))
        } else {
            None
        }
    })
}

/// Returns true if the tile is a zone (residential / commercial / industrial).
/// Mirrors `isZone()` in `app/src/game/adjacency.ts`.
pub fn is_zone(tile: &Tile) -> bool {
    matches!(tile.kind, TileKind::Residential | TileKind::Commercial | TileKind::Industrial)
}

/// Returns true if any orthogonal neighbour of (x, y) is a road, road-underlay,
/// or power line.  Mirrors `hasRoadAccess()` in `adjacency.ts`.
pub fn has_road_access(state: &GameState, x: u32, y: u32) -> bool {
    for (nx, ny) in orthogonal_neighbours(state.width, state.height, x, y) {
        let Some(t) = state.tile_at(nx, ny) else { continue };
        if t.kind == TileKind::Road || t.has_road_underlay() || t.kind == TileKind::PowerLine {
            return true;
        }
    }
    false
}

/// Returns true if (x, y) is a zone tile that has at least one non-zone
/// orthogonal neighbour.  Mirrors `isFrontierZone()` in `adjacency.ts`.
pub fn is_frontier_zone(state: &GameState, x: u32, y: u32) -> bool {
    let Some(tile) = state.tile_at(x, y) else { return false };
    if !is_zone(tile) { return false; }
    for (nx, ny) in orthogonal_neighbours(state.width, state.height, x, y) {
        let Some(n) = state.tile_at(nx, ny) else { continue };
        if !is_zone(n) { return true; }
    }
    false
}

/// BFS through zone tiles from (start_x, start_y): returns true if a road
/// tile can be reached.  Mirrors `zoneHasRoadPath()` in `adjacency.ts`.
pub fn zone_has_road_path(state: &GameState, start_x: u32, start_y: u32) -> bool {
    let Some(start) = state.tile_at(start_x, start_y) else { return false };
    if !is_zone(start) { return false; }
    if has_road_access(state, start_x, start_y) { return true; }

    let mut visited: HashSet<usize> = HashSet::new();
    let mut queue: VecDeque<(u32, u32)> = VecDeque::new();
    queue.push_back((start_x, start_y));

    while let Some((x, y)) = queue.pop_front() {
        for (nx, ny) in orthogonal_neighbours(state.width, state.height, x, y) {
            let idx = (ny * state.width + nx) as usize;
            if visited.contains(&idx) { continue; }
            visited.insert(idx);
            let Some(n) = state.tile_at(nx, ny) else { continue };
            if !is_zone(n) { continue; }
            if has_road_access(state, nx, ny) { return true; }
            queue.push_back((nx, ny));
        }
    }
    false
}

/// Returns true if (x, y) is powered directly or via an adjacent powered carrier.
/// Mirrors `tileHasPower()` in `adjacency.ts`.
pub fn tile_has_power(state: &GameState, x: u32, y: u32) -> bool {
    if state.tile_at(x, y).map_or(false, |t| t.flags & FLAG_POWERED != 0) {
        return true;
    }
    use crate::utilities::is_power_carrier_pub;
    for (nx, ny) in orthogonal_neighbours(state.width, state.height, x, y) {
        if let Some(n) = state.tile_at(nx, ny) {
            if n.flags & FLAG_POWERED != 0 && is_power_carrier_pub(n) {
                return true;
            }
        }
    }
    false
}

/// Returns true if (x, y) is watered directly or via an adjacent watered carrier.
/// Mirrors `tileHasWater()` in `adjacency.ts`.
pub fn tile_has_water(state: &GameState, x: u32, y: u32) -> bool {
    if state.tile_at(x, y).map_or(false, |t| t.flags & FLAG_WATERED != 0) {
        return true;
    }
    use crate::utilities::is_water_carrier_pub;
    for (nx, ny) in orthogonal_neighbours(state.width, state.height, x, y) {
        if let Some(n) = state.tile_at(nx, ny) {
            if n.flags & FLAG_WATERED != 0 && is_water_carrier_pub(n) {
                return true;
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::FLAG_ROAD_UNDERLAY;

    fn g(w: u32, h: u32) -> GameState { GameState::new(w, h, 0) }
    fn kind(state: &mut GameState, x: u32, y: u32, k: TileKind) {
        state.tile_at_mut(x, y).unwrap().kind = k;
    }

    #[test]
    fn road_gives_road_access() {
        let mut s = g(3, 1);
        kind(&mut s, 0, 0, TileKind::Residential);
        kind(&mut s, 1, 0, TileKind::Road);
        assert!(has_road_access(&s, 0, 0));
    }

    #[test]
    fn no_adjacent_road_returns_false() {
        let mut s = g(3, 1);
        kind(&mut s, 0, 0, TileKind::Residential);
        assert!(!has_road_access(&s, 0, 0));
    }

    #[test]
    fn road_underlay_gives_access() {
        let mut s = g(2, 1);
        kind(&mut s, 0, 0, TileKind::Residential);
        s.tile_at_mut(1, 0).unwrap().set_flag(FLAG_ROAD_UNDERLAY, true);
        assert!(has_road_access(&s, 0, 0));
    }

    #[test]
    fn is_zone_true_for_zone_kinds() {
        for k in [TileKind::Residential, TileKind::Commercial, TileKind::Industrial] {
            assert!(is_zone(&Tile { kind: k, ..Tile::land() }));
        }
    }

    #[test]
    fn is_zone_false_for_non_zone() {
        assert!(!is_zone(&Tile::land()));
        assert!(!is_zone(&Tile { kind: TileKind::Road, ..Tile::land() }));
    }

    #[test]
    fn frontier_zone_adjacent_to_non_zone() {
        // 3×2 grid: top row all Residential; (0,1) is Land — it is a non-zone
        // in-bounds neighbour of (0,0), making (0,0) a frontier zone.
        let mut s = g(3, 2);
        kind(&mut s, 0, 0, TileKind::Residential);
        kind(&mut s, 1, 0, TileKind::Residential);
        kind(&mut s, 2, 0, TileKind::Residential);
        // Row 1 stays as Land (default)
        assert!(is_frontier_zone(&s, 0, 0), "(0,0) has non-zone neighbour (0,1)");
    }

    #[test]
    fn non_frontier_zone_all_zone_neighbours() {
        let mut s = g(3, 3);
        for y in 0..3 {
            for x in 0..3 {
                kind(&mut s, x, y, TileKind::Residential);
            }
        }
        // Interior tile (1,1) has only in-bounds zone neighbours — not frontier
        assert!(!is_frontier_zone(&s, 1, 1));
    }

    #[test]
    fn zone_has_road_path_via_adjacent_zone() {
        let mut s = g(4, 1);
        kind(&mut s, 0, 0, TileKind::Residential);
        kind(&mut s, 1, 0, TileKind::Residential);
        kind(&mut s, 2, 0, TileKind::Road);
        // Start at (0,0) — no direct road access, but (1,0) has road access
        assert!(zone_has_road_path(&s, 0, 0));
    }

    #[test]
    fn zone_has_road_path_false_when_isolated() {
        let mut s = g(3, 1);
        kind(&mut s, 0, 0, TileKind::Residential);
        kind(&mut s, 1, 0, TileKind::Residential);
        assert!(!zone_has_road_path(&s, 0, 0));
    }

    #[test]
    fn tile_has_power_direct() {
        let mut s = g(1, 1);
        s.tile_at_mut(0, 0).unwrap().set_flag(FLAG_POWERED, true);
        assert!(tile_has_power(&s, 0, 0));
    }

    #[test]
    fn tile_has_power_via_adjacent() {
        let mut s = g(2, 1);
        // (0,0) is an unpowered zone; (1,0) is a powered road
        kind(&mut s, 0, 0, TileKind::Residential);
        kind(&mut s, 1, 0, TileKind::Road);
        s.tile_at_mut(1, 0).unwrap().set_flag(FLAG_POWERED, true);
        assert!(tile_has_power(&s, 0, 0));
    }

    #[test]
    fn tile_has_power_false_when_not_powered() {
        let s = g(2, 1);
        assert!(!tile_has_power(&s, 0, 0));
    }
}
