// Road, rail, power, and water adjacency queries used throughout the simulation.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use crate::occupants::Network;
use crate::state::{GameState, Tile, FLAG_POWERED, FLAG_WATERED};
use std::collections::{HashSet, VecDeque};

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
    tile.zone_occupant().is_some()
}

/// Returns true if any orthogonal neighbour of (x, y) carries traffic — that
/// is, has a `Road` occupant, whether recorded as `kind` or as
/// `FLAG_ROAD_UNDERLAY`.
///
/// **Behaviour change, step 2 of #177.** This used to read
/// `kind == Road || has_road_underlay() || kind == PowerLine`. The third
/// clause was compensation, not a rule: when a hydro line is strung over a
/// road the tile is recorded `kind = PowerLine` + `FLAG_ROAD_UNDERLAY`, and
/// the author of that clause was reaching for the road hidden underneath.
/// It reached too far — a *bare* hydro line across open country granted road
/// access to every zone beside it, so lots grew, filled and paid tax with no
/// street. `Tile::conducts(Network::Traffic)` asks the honest question
/// instead, and the road-under-a-line case answers it through the underlay
/// with no special case at all.
///
/// The converse half of the old bug is gone too: a line strung over a zoned
/// or developed tile leaves `kind` alone, so the old `kind == PowerLine` test
/// could never see it. Nothing is lost by dropping it, because a line has
/// never been a road.
///
/// Still mirrors `hasRoadAccess()` in `app/src/game/adjacency.ts`: the TS
/// parity oracle dropped the same clause, pinned by
/// `does not grant road access from a bare hydro line` and
/// `does not treat a zone chain ending at a bare hydro line as a road path`
/// in `app/src/game/adjacency.test.ts`.
pub fn has_road_access(state: &GameState, x: u32, y: u32) -> bool {
    for (nx, ny) in orthogonal_neighbours(state.width, state.height, x, y) {
        let Some(t) = state.tile_at(nx, ny) else {
            continue;
        };
        if t.conducts(Network::Traffic) {
            return true;
        }
    }
    false
}

/// Returns true if (x, y) is a zone tile that has at least one non-zone
/// orthogonal neighbour.  Mirrors `isFrontierZone()` in `adjacency.ts`.
pub fn is_frontier_zone(state: &GameState, x: u32, y: u32) -> bool {
    let Some(tile) = state.tile_at(x, y) else {
        return false;
    };
    if !is_zone(tile) {
        return false;
    }
    for (nx, ny) in orthogonal_neighbours(state.width, state.height, x, y) {
        let Some(n) = state.tile_at(nx, ny) else {
            continue;
        };
        if !is_zone(n) {
            return true;
        }
    }
    false
}

/// BFS through zone tiles from (start_x, start_y): returns true if a road
/// tile can be reached.
///
/// Unchanged in itself, but it inherits the step-2 narrowing of
/// [`has_road_access`]: a chain of zones whose far end touched only a bare
/// hydro line is no longer a road path. That is the one place the narrowing
/// reaches zone growth, because a zone *directly* beside a line is a frontier
/// zone and grows on that ticket regardless — see
/// `a_zone_chain_ending_at_a_bare_line_is_not_a_road_path`.
pub fn zone_has_road_path(state: &GameState, start_x: u32, start_y: u32) -> bool {
    let Some(start) = state.tile_at(start_x, start_y) else {
        return false;
    };
    if !is_zone(start) {
        return false;
    }
    if has_road_access(state, start_x, start_y) {
        return true;
    }

    let mut visited: HashSet<usize> = HashSet::new();
    let mut queue: VecDeque<(u32, u32)> = VecDeque::new();
    queue.push_back((start_x, start_y));

    while let Some((x, y)) = queue.pop_front() {
        for (nx, ny) in orthogonal_neighbours(state.width, state.height, x, y) {
            let idx = (ny * state.width + nx) as usize;
            if visited.contains(&idx) {
                continue;
            }
            visited.insert(idx);
            let Some(n) = state.tile_at(nx, ny) else {
                continue;
            };
            if !is_zone(n) {
                continue;
            }
            if has_road_access(state, nx, ny) {
                return true;
            }
            queue.push_back((nx, ny));
        }
    }
    false
}

/// Returns true if (x, y) is powered directly or via an adjacent powered
/// carrier. Mirrors `tileHasPower()` in `app/src/game/adjacency.ts`, whose
/// `isPowerCarrier` gained the same `powerOverlay` clause — pinned by
/// `powers a tile from a powered neighbour whose line is only in the overlay`
/// in `app/src/game/adjacency.test.ts`.
///
/// The carrier test is [`Tile::conducts`], the same predicate the power BFS
/// uses, so "reached by the flood fill" and "counts as a supply next door"
/// cannot drift apart. It inherits the step-2 fix from `utilities.rs`: a
/// hydro line recorded only in `FLAG_POWER_OVERLAY` now supplies its
/// neighbours instead of being invisible.
pub fn tile_has_power(state: &GameState, x: u32, y: u32) -> bool {
    if state
        .tile_at(x, y)
        .is_some_and(|t| t.flags & FLAG_POWERED != 0)
    {
        return true;
    }
    for (nx, ny) in orthogonal_neighbours(state.width, state.height, x, y) {
        if let Some(n) = state.tile_at(nx, ny) {
            if n.flags & FLAG_POWERED != 0 && n.conducts(Network::Power) {
                return true;
            }
        }
    }
    false
}

/// Returns true if (x, y) is watered directly or via an adjacent watered carrier.
/// Mirrors `tileHasWater()` in `adjacency.ts`.
pub fn tile_has_water(state: &GameState, x: u32, y: u32) -> bool {
    if state
        .tile_at(x, y)
        .is_some_and(|t| t.flags & FLAG_WATERED != 0)
    {
        return true;
    }
    for (nx, ny) in orthogonal_neighbours(state.width, state.height, x, y) {
        if let Some(n) = state.tile_at(nx, ny) {
            if n.flags & FLAG_WATERED != 0 && n.conducts(Network::Water) {
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
    use crate::commands::apply_tool;
    use crate::state::{FLAG_POWER_OVERLAY, FLAG_ROAD_UNDERLAY};
    use city_sim_protocol::commands::Tool;
    use city_sim_protocol::tile_kind::TileKind;

    fn g(w: u32, h: u32) -> GameState {
        GameState::new(w, h, 0)
    }
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
        s.tile_at_mut(1, 0)
            .unwrap()
            .set_flag(FLAG_ROAD_UNDERLAY, true);
        assert!(has_road_access(&s, 0, 0));
    }

    /// **Behaviour change, step 2 of #177.** A bare hydro line is not a road.
    /// It used to grant road access outright — `has_road_access` accepted any
    /// neighbour whose `kind` was `PowerLine` — so a zone strung with a line
    /// and no street grew, filled and paid tax regardless.
    #[test]
    fn a_bare_hydro_line_does_not_give_road_access() {
        let mut s = g(3, 1);
        s.money = 10_000;
        kind(&mut s, 0, 0, TileKind::Residential);
        apply_tool(&mut s, Tool::PowerLine, 1, 0);
        let line = s.tile_at(1, 0).unwrap();
        assert_eq!(line.kind, TileKind::PowerLine);
        assert!(!line.has_road_underlay(), "no road under this line");
        assert!(!has_road_access(&s, 0, 0));
    }

    /// The road under a line still gives access, whichever order it was built
    /// in — that is what the old `kind == PowerLine` clause was really
    /// compensating for, and the underlay answers it without the special case.
    #[test]
    fn a_line_over_a_road_keeps_giving_road_access() {
        // Line first, then pave: `Tool::Road` keeps kind `PowerLine` and
        // records FLAG_ROAD_UNDERLAY.
        let mut s = g(3, 1);
        s.money = 10_000;
        kind(&mut s, 0, 0, TileKind::Residential);
        apply_tool(&mut s, Tool::PowerLine, 1, 0);
        apply_tool(&mut s, Tool::Road, 1, 0);
        let t = s.tile_at(1, 0).unwrap();
        assert_eq!(t.kind, TileKind::PowerLine);
        assert!(t.has_road_underlay());
        assert!(has_road_access(&s, 0, 0), "line-then-road");

        // Pave first, then string the line — same tile, same answer.
        let mut s = g(3, 1);
        s.money = 10_000;
        kind(&mut s, 0, 0, TileKind::Residential);
        apply_tool(&mut s, Tool::Road, 1, 0);
        apply_tool(&mut s, Tool::PowerLine, 1, 0);
        assert!(has_road_access(&s, 0, 0), "road-then-line");
    }

    /// A road hidden under a hydro *overlay* — the spelling `Tool::PowerLine`
    /// leaves on a zoned tile, and the one no `kind`-only test could see.
    #[test]
    fn road_underlay_beneath_a_power_overlay_gives_access() {
        let mut s = g(2, 1);
        kind(&mut s, 0, 0, TileKind::Residential);
        let n = s.tile_at_mut(1, 0).unwrap();
        n.kind = TileKind::Tree;
        n.set_flag(FLAG_ROAD_UNDERLAY, true);
        n.set_flag(FLAG_POWER_OVERLAY, true);
        assert!(has_road_access(&s, 0, 0));
    }

    #[test]
    fn is_zone_true_for_zone_kinds() {
        for k in [
            TileKind::Residential,
            TileKind::Commercial,
            TileKind::Industrial,
        ] {
            assert!(is_zone(&Tile {
                kind: k,
                ..Tile::land()
            }));
        }
    }

    #[test]
    fn is_zone_false_for_non_zone() {
        assert!(!is_zone(&Tile::land()));
        assert!(!is_zone(&Tile {
            kind: TileKind::Road,
            ..Tile::land()
        }));
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
        assert!(
            is_frontier_zone(&s, 0, 0),
            "(0,0) has non-zone neighbour (0,1)"
        );
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

    /// Where dropping the `PowerLine` clause actually reaches the sim.
    ///
    /// `zones.rs` grows a lot when *any* of road access, a zone chain to a
    /// road, or frontier status holds. A zone directly beside a bare line is a
    /// frontier zone by construction — the line is a non-zone neighbour — so
    /// it keeps growing either way. The tile that changes is the one deep
    /// inside a zone blob, which has neither road access nor frontier status
    /// and used to reach a "road" through the chain: the bare line at the far
    /// end of the blob.
    #[test]
    fn a_zone_chain_ending_at_a_bare_line_is_not_a_road_path() {
        let mut s = g(4, 3);
        s.money = 10_000;
        for y in 0..3 {
            for x in 0..3 {
                kind(&mut s, x, y, TileKind::Residential);
            }
        }
        apply_tool(&mut s, Tool::PowerLine, 3, 1);

        // (1,1) is the interior tile: every neighbour is a zone, so it is
        // neither a frontier zone nor road-adjacent.
        assert!(!is_frontier_zone(&s, 1, 1));
        assert!(!has_road_access(&s, 1, 1));
        assert!(
            !zone_has_road_path(&s, 1, 1),
            "a hydro line is not a road at the end of the chain"
        );

        // Pave the same tile and the chain is a road path again.
        apply_tool(&mut s, Tool::Road, 3, 1);
        assert!(zone_has_road_path(&s, 1, 1));
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

    /// **Behaviour change, step 2 of #177.** A powered neighbour whose line
    /// lives only in `FLAG_POWER_OVERLAY` now supplies the tile. The old
    /// `is_power_carrier` asked `kind == PowerLine`, so this neighbour could
    /// be flagged powered by the BFS and still refuse to hand the power on.
    #[test]
    fn tile_has_power_via_a_line_in_the_overlay_flag() {
        let mut s = g(2, 1);
        kind(&mut s, 0, 0, TileKind::Residential);
        let n = s.tile_at_mut(1, 0).unwrap();
        n.kind = TileKind::Tree; // Tool::Tree rewrote kind, the flag survived
        n.set_flag(FLAG_POWER_OVERLAY, true);
        n.set_flag(FLAG_POWERED, true);
        assert!(tile_has_power(&s, 0, 0));
    }

    #[test]
    fn tile_has_power_false_when_not_powered() {
        let s = g(2, 1);
        assert!(!tile_has_power(&s, 0, 0));
    }
}
