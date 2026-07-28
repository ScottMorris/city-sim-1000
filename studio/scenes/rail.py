# Scene: railway ground tiles — all 15 connectivity variants from one
# parametric builder (mirrors the road tileset's 4-bit N/E/S/W naming).
#
# Top-down ground tile: geometry spans the full 4×4-unit frame so edges meet
# neighbouring tiles exactly. Track = raised ballast bed + ties + two rails,
# built as chunky overlapping boxes laid along a sampled path (straight
# half-lines to edge midpoints; quarter arcs for corners; buffer stop for
# dead ends). Each variant is real rotated geometry — never a rotated sprite
# — so the fixed studio sun shades every variant consistently.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

import math

from studiolib import box
from scenes.trackpath import (
    CONNECTIVITY_VARIANTS, EDGE_POINTS, adjacent_pair,
    sample_straight, sample_arc, tangent_at, arc_length_to, index_at_length,
)

TOP_DOWN = True
ROTATION_DEG = 0

GAUGE = 0.28         # rail offset from the path centreline
TIE_SPACING = 0.4    # divides the 2.0-unit half-tile evenly -> seamless joins
BALLAST_W = 1.1

VARIANTS = CONNECTIVITY_VARIANTS
VARIANT = 'ns'  # overridden by the render driver


def _lay_track(mats, points):
    # Ballast bed: overlapping cross-slabs along the path.
    for i in range(0, len(points), 2):
        x, y = points[i]
        box(mats, 'ballast', (x, y, 0.035), (0.16, BALLAST_W, 0.07), (0, 0, tangent_at(points, i)))

    # Ties: perpendicular sleepers at fixed world spacing (phase 0.2 so the
    # gap across a tile edge equals the in-tile spacing -> seamless).
    total = arc_length_to(points, len(points) - 1)
    s = 0.2
    while s < total:
        idx = index_at_length(points, s)
        x, y = points[idx]
        box(mats, 'tie', (x, y, 0.10), (0.16, 0.95, 0.05), (0, 0, tangent_at(points, idx)))
        s += TIE_SPACING

    # Rails: short segments at ±GAUGE, following the path tangent.
    for i in range(0, len(points) - 2, 2):
        x, y = points[i]
        ang = tangent_at(points, i)
        nx, ny = -math.sin(ang), math.cos(ang)
        for side in (1, -1):
            box(mats, 'rail',
                (x + nx * GAUGE * side, y + ny * GAUGE * side, 0.165),
                (0.20, 0.10, 0.08), (0, 0, ang))


def build(mats):
    edges = VARIANTS[VARIANT]
    pair = adjacent_pair(edges)

    if pair:
        # Pure corner: one smooth quarter arc.
        _lay_track(mats, sample_arc(*pair))
    else:
        for edge in sorted(edges):
            _lay_track(mats, sample_straight(edge))

    if len(edges) == 1:
        # Dead end: buffer stop across the track just past the tile centre.
        edge = next(iter(edges))
        dx, dy = EDGE_POINTS[edge]
        ang = math.atan2(dy, dx)
        box(mats, 'tie', (dx * 0.15, dy * 0.15, 0.12), (0.14, 0.75, 0.24), (0, 0, ang))
