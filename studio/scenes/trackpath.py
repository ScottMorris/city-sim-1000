# Shared path sampling for ground-tile scenes (rail, road, crossings).
# Paths run from tile centre to edge midpoints (straights) or as quarter arcs
# joining adjacent edges; all geometry that follows a path is laid along
# dense samples of these polylines.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

import math

HALF = 2.05   # overshoot the ±2.0 frame edge so neighbouring tiles meet cleanly

EDGE_POINTS = {
    'n': (0, 1), 'e': (1, 0), 's': (0, -1), 'w': (-1, 0),
}

CONNECTIVITY_VARIANTS = {
    'ns': {'n', 's'}, 'ew': {'e', 'w'},
    'corner-ne': {'n', 'e'}, 'corner-nw': {'n', 'w'},
    'corner-se': {'s', 'e'}, 'corner-sw': {'s', 'w'},
    't-nes': {'n', 'e', 's'}, 't-esw': {'e', 's', 'w'},
    't-nsw': {'n', 's', 'w'}, 't-new': {'n', 'e', 'w'},
    'cross': {'n', 'e', 's', 'w'},
    'end-n': {'n'}, 'end-e': {'e'}, 'end-s': {'s'}, 'end-w': {'w'},
}


def sample_straight(edge, start=-0.1):
    """Centre (slight overshoot) to edge midpoint, sampled every ~0.05."""
    dx, dy = EDGE_POINTS[edge]
    points = []
    steps = int(HALF / 0.05)
    for i in range(steps + 1):
        t = start + (HALF - start) * i / steps
        points.append((dx * t, dy * t))
    return points


def sample_full_straight(edge_a, edge_b):
    """Edge-to-edge straight through the centre (for ns/ew variants)."""
    ax, ay = EDGE_POINTS[edge_a]
    points = []
    steps = int(2 * HALF / 0.05)
    for i in range(steps + 1):
        t = -HALF + 2 * HALF * i / steps
        points.append((-ax * t, -ay * t))
    return points


def sample_arc(edge_a, edge_b):
    """Quarter arc of radius 2 joining two adjacent edge midpoints, centred
    on the tile corner both edges share."""
    ax, ay = EDGE_POINTS[edge_a]
    bx, by = EDGE_POINTS[edge_b]
    cx, cy = (ax + bx) * 2, (ay + by) * 2
    start = math.atan2(ay * 2 - cy, ax * 2 - cx)
    end = math.atan2(by * 2 - cy, bx * 2 - cx)
    while end - start > math.pi:
        end -= 2 * math.pi
    while end - start < -math.pi:
        end += 2 * math.pi
    points = []
    steps = 40
    for i in range(steps + 1):
        a = start + (end - start) * i / steps
        points.append((cx + 2 * math.cos(a), cy + 2 * math.sin(a)))
    return points


def adjacent_pair(edges):
    """The (edge, edge) tuple if `edges` is exactly one adjacent pair, else None."""
    for pair in (('n', 'e'), ('n', 'w'), ('s', 'e'), ('s', 'w')):
        if set(pair) == edges:
            return pair
    return None


def tangent_at(points, i):
    j = min(i + 1, len(points) - 1)
    k = max(i - 1, 0)
    return math.atan2(points[j][1] - points[k][1], points[j][0] - points[k][0])


def arc_length_to(points, i):
    total = 0.0
    for k in range(1, i + 1):
        total += math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1])
    return total


def index_at_length(points, s):
    return min(range(len(points)), key=lambda i: abs(arc_length_to(points, i) - s))
