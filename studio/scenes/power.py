# Scene: hydro line ground tiles (wires only), all 15 connectivity variants.
# The pole is a separate scene (pole.py) rendered through the DIMETRIC camera
# and composited onto these tiles by the stylizer — the same top-down-ground /
# elevation-pole cheat the hand-made hydro sprites use.
#
# PLAN VIEW THROUGHOUT. The first version of this scene drew `ns` in plan view
# (straight parallel wires) but `ew` in elevation (a catenary sagging toward
# the tile edges). Those two cheats cannot meet at a corner — a wire arriving
# from the north as two parallel lines has nowhere to join a curve hanging in
# elevation — which is why only the two straights and the four dead ends ever
# had sprites, and every corner/T/cross fell through to a flat colour rect.
# Unifying on plan view makes all 15 variants fall out of one parametric
# scene, exactly like road.py and rail.py.
#
# Each variant is real rotated geometry — never a rotated sprite, which would
# rotate the studio sun with it and break lighting consistency.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

import math

from studiolib import box
from scenes.trackpath import CONNECTIVITY_VARIANTS

TOP_DOWN = True
ROTATION_DEG = 0

VARIANTS = CONNECTIVITY_VARIANTS
VARIANT = 'ns'  # overridden by the render driver

HALF = 2.05          # overshoot the ±2.0 frame edge so neighbours meet cleanly
OVERLAP = 0.08       # legs run just past centre so opposite legs join seamlessly
WIRE_OFFSET = 0.56   # the pole's crossarm-tip gauge — wires attach there
WIRE_W = 0.09        # 1 art cell; anything thinner shreds when downsampled
WIRE_Z = 0.06

# Dead-end poles carry the whole pull of the line, so they're braced by guy
# wires anchored on the far side. Two, splayed off the axis, the way real
# terminal poles are guyed.
GUY_LEN = 0.95
GUY_TOP = 1.30       # attach height; only affects relief (wires are flat-shaded)
GUY_SPLAY_DEG = 26

# Unit vectors, in the top-down camera's north-up frame (+Y north, +X east).
EDGE_DIR = {'n': (0.0, 1.0), 'e': (1.0, 0.0), 's': (0.0, -1.0), 'w': (-1.0, 0.0)}


def _leg(mats, edge):
    """A wire pair running from one tile edge in to just past the centre."""
    ux, uy = EDGE_DIR[edge]
    length = HALF + OVERLAP
    mid = (HALF - OVERLAP) / 2
    for side in (1, -1):
        if ux == 0:                      # north/south leg — wires offset in X
            loc = (WIRE_OFFSET * side, uy * mid, WIRE_Z)
            scale = (WIRE_W, length, 0.04)
        else:                            # east/west leg — wires offset in Y
            loc = (ux * mid, WIRE_OFFSET * side, WIRE_Z)
            scale = (length, WIRE_W, 0.04)
        box(mats, 'wire', loc, scale)


def _guy(mats, ux, uy):
    """One guy wire: from the pole's upper trunk down to a ground anchor.

    Modelled as a box elongated along +X, tilted about Y so it descends, then
    spun about Z onto the compass bearing. Seen from the straight-down camera
    it reads as a line radiating from the pole to its anchor.
    """
    span = math.hypot(GUY_LEN, GUY_TOP)
    box(mats, 'wire',
        (ux * GUY_LEN / 2, uy * GUY_LEN / 2, GUY_TOP / 2),
        (span, WIRE_W * 0.8, 0.035),
        (0, math.atan2(GUY_TOP, GUY_LEN), math.atan2(uy, ux)))


def build(mats):
    edges = VARIANTS[VARIANT]
    for edge in edges:
        _leg(mats, edge)

    # Dead end: brace the terminal pole against the single direction of pull.
    if len(edges) == 1:
        pull_x, pull_y = EDGE_DIR[next(iter(edges))]
        base = math.atan2(-pull_y, -pull_x)          # anchor opposite the pull
        for sign in (1, -1):
            theta = base + sign * math.radians(GUY_SPLAY_DEG)
            _guy(mats, math.cos(theta), math.sin(theta))
