# Scene: road ground tiles — all 15 connectivity variants, styled after the
# existing hand-made road set (which is the liked reference): full-tile
# asphalt, dark kerb lines along unconnected edges, dashed centre-line
# markings following the connection paths.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

import math

from studiolib import box
from scenes.trackpath import (
    CONNECTIVITY_VARIANTS, EDGE_POINTS, adjacent_pair,
    sample_straight, sample_full_straight, sample_arc,
    tangent_at, arc_length_to, index_at_length,
)

TOP_DOWN = True
ROTATION_DEG = 0

VARIANTS = CONNECTIVITY_VARIANTS
VARIANT = 'ns'  # overridden by the render driver

# Measured from the existing road sprites (the liked reference): dashes are
# 22x12 px at their 128 px scale -> 0.69 x 0.375 world, period 1.0 on
# straights (4 bold blocks per tile, phase centring the edge gaps), and a
# nearly-continuous fat line on corners (tiny ~0.1 notches, period pi/4 so
# the quarter arc holds exactly 4 dashes).
DASH_LEN = 0.69
DASH_W = 0.375
STRAIGHT_PERIOD = 1.0
ARC_PERIOD = 0.72   # gap ~0.03 -> the corner line reads nearly continuous,
                    # with flush partial dashes at both edges (matches the
                    # reference's bold curved line with small notches)


def _dashes(mats, points, period):
    total = arc_length_to(points, len(points) - 1)
    s = (period - DASH_LEN) / 2
    while s < total - 0.05:
        # Clip the final dash to the remaining path instead of dropping it —
        # otherwise the line stops short of the tile edge and fails to join
        # its neighbour (caught on the corner arcs, whose length is not a
        # multiple of the period).
        length = min(DASH_LEN, total - s)
        centre = s + length / 2
        idx = index_at_length(points, centre)
        x, y = points[idx]
        box(mats, 'marking', (x, y, 0.06), (length, DASH_W, 0.04),
            (0, 0, tangent_at(points, idx)))
        s += period


def _end_cap(mats, edge):
    """Dead-end paint (measured from road-end-n.png): a standard first dash,
    a second dash running long into a perpendicular crossbar just past the
    tile centre — the T-shaped terminus marking."""
    dx, dy = EDGE_POINTS[edge]
    ang = math.atan2(dy, dx)
    at = lambda s: (dx * (2 - s), dy * (2 - s), 0.06)
    box(mats, 'marking', at(0.5), (DASH_LEN, DASH_W, 0.04), (0, 0, ang))       # dash
    box(mats, 'marking', at(1.485), (0.66, DASH_W, 0.04), (0, 0, ang))         # stub
    box(mats, 'marking', at(1.985), (0.34, 1.125, 0.04), (0, 0, ang))          # crossbar


def build(mats):
    edges = VARIANTS[VARIANT]

    # Full-tile asphalt slab (matches the existing road sprites, which are
    # asphalt edge-to-edge regardless of variant).
    box(mats, 'asphalt', (0, 0, 0.02), (4.1, 4.1, 0.04))

    # Unconnected edges: a light grey shoulder strip with a dark hairline at
    # the very edge (measured from the reference: ~0.22-wide #575d54 strip,
    # 1 px near-black outer line).
    for edge, (dx, dy) in EDGE_POINTS.items():
        if edge in edges:
            continue
        box(mats, 'shoulder', (dx * 1.86, dy * 1.86, 0.05),
            (0.22 if dx else 4.1, 0.22 if dy else 4.1, 0.05))
        box(mats, 'kerb', (dx * 2.01, dy * 2.01, 0.055),
            (0.08 if dx else 4.1, 0.08 if dy else 4.1, 0.05))

    # Dashed centre-line markings.
    pair = adjacent_pair(edges)
    if edges in ({'n', 's'}, {'e', 'w'}):
        a, b = sorted(edges)
        _dashes(mats, sample_full_straight(a, b), STRAIGHT_PERIOD)
    elif pair:
        _dashes(mats, sample_arc(*pair), ARC_PERIOD)
    elif len(edges) == 1:
        # Dead end: dashes terminate in the T-shaped end cap.
        _end_cap(mats, next(iter(edges)))
    else:
        # Tees, crossings: dash each connected half toward the centre; the
        # half-length (2.0) cuts the second full dash so junction cores stay
        # clean automatically.
        for edge in sorted(edges):
            _dashes(mats, list(reversed(sample_straight(edge, start=0.0))), STRAIGHT_PERIOD)
