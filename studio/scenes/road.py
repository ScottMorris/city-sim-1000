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

# Matched against the existing road sprites: long dashes, short gaps, and a
# fat line (~6px at their 128px scale). Period divides the 4.0-unit tile
# evenly so dashes join across tile boundaries.
DASH_PERIOD = 0.8
DASH_LEN = 0.55
DASH_W = 0.16


def _dashes(mats, points, phase=0.125):
    total = arc_length_to(points, len(points) - 1)
    s = phase
    while s + DASH_LEN <= total + 0.01:
        centre = s + DASH_LEN / 2
        idx = index_at_length(points, centre)
        x, y = points[idx]
        box(mats, 'marking', (x, y, 0.06), (DASH_LEN, DASH_W, 0.04),
            (0, 0, tangent_at(points, idx)))
        s += DASH_PERIOD


def build(mats):
    edges = VARIANTS[VARIANT]

    # Full-tile asphalt slab (matches the existing road sprites, which are
    # asphalt edge-to-edge regardless of variant).
    box(mats, 'asphalt', (0, 0, 0.02), (4.1, 4.1, 0.04))

    # Kerb lines along unconnected edges.
    for edge, (dx, dy) in EDGE_POINTS.items():
        if edge in edges:
            continue
        box(mats, 'kerb', (dx * 1.96, dy * 1.96, 0.05),
            (0.09 if dx else 4.1, 0.09 if dy else 4.1, 0.05))

    # Dashed centre-line markings.
    pair = adjacent_pair(edges)
    if edges in ({'n', 's'}, {'e', 'w'}):
        a, b = sorted(edges)
        _dashes(mats, sample_full_straight(a, b))
    elif pair:
        _dashes(mats, sample_arc(*pair))
    else:
        # Ends, tees, crossings: dash each connected half toward the centre;
        # the half-length (2.0) cuts the third dash so junction cores stay
        # clean automatically.
        for edge in sorted(edges):
            _dashes(mats, list(reversed(sample_straight(edge, start=0.0))))
