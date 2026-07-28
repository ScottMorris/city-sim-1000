# Scene: hydro line ground tiles (wires only). The pole is a separate scene
# (pole.py) rendered through the DIMETRIC camera and composited onto these
# tiles by the stylizer — the same top-down-ground / elevation-pole cheat the
# existing (liked) hand-made hydro sprites use.
#
# Measured from those sprites, the two orientations use different cheats:
# - vertical (ns): plan view — two dead-straight wires at ±0.53 world.
# - horizontal (ew): elevation view — wires hang above centre (anchored at
#   the pole's crossarm height) and sag toward the tile edges, kinking at
#   each pole exactly like the reference.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

import math

from studiolib import box

TOP_DOWN = True
ROTATION_DEG = 0

VARIANTS = {'ns': None, 'ew': None}
VARIANT = 'ns'

WIRE_OFFSET = 0.56   # the pole's crossarm-tip gauge — wires attach there
WIRE_W = 0.09
SAG = 0.22           # catenary dip at the tile edge (elevation-view wires)
EW_ANCHORS = (0.79, 0.50)  # wire heights at the pole: crossarm height, with
                           # the near-side wire drawn slightly lower for depth


def build(mats):
    if VARIANT == 'ns':
        for side in (1, -1):
            box(mats, 'wire', (WIRE_OFFSET * side, 0, 0.06), (WIRE_W, 4.1, 0.04))
    else:
        # Sagging elevation-view wires: segmented along x, dipping toward the
        # edges; adjacent tiles continue the curve, kinking at each pole.
        segments = 16
        for anchor in EW_ANCHORS:
            for i in range(segments):
                x0 = -2.05 + 4.1 * i / segments
                x1 = -2.05 + 4.1 * (i + 1) / segments
                y0 = anchor - SAG * (x0 / 2) ** 2
                y1 = anchor - SAG * (x1 / 2) ** 2
                cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
                length = math.hypot(x1 - x0, y1 - y0)
                box(mats, 'wire', (cx, cy, 0.06), (length + 0.02, WIRE_W, 0.04),
                    (0, 0, math.atan2(y1 - y0, x1 - x0)))
