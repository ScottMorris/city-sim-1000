# Scene: rail-road level crossings. Variant names give the RAIL direction:
# 'ns' = rail runs north-south across an east-west road, 'ew' = the reverse.
# Full-tile asphalt (road convention) with a wooden plank strip carrying the
# rails across it; road dashes skip the plank zone.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

from studiolib import box

TOP_DOWN = True
ROTATION_DEG = 0

VARIANTS = {'ns': None, 'ew': None}
VARIANT = 'ns'

GAUGE = 0.28
DASH_LEN = 0.4


def build(mats):
    rail_ns = VARIANT == 'ns'

    # Full-tile asphalt slab (road convention — this tile joins road tiles).
    box(mats, 'asphalt', (0, 0, 0.02), (4.1, 4.1, 0.04))

    # Road centre-line dashes, skipping the plank zone at the crossing.
    for centre in (-1.6, -0.8, 0.8, 1.6):
        loc = (centre, 0, 0.06) if rail_ns else (0, centre, 0.06)
        scale = (DASH_LEN + 0.02, 0.09, 0.04) if rail_ns else (0.09, DASH_LEN + 0.02, 0.04)
        box(mats, 'marking', loc, scale)

    # Wooden planking strip carrying the rails across the road.
    plank_scale = (1.0, 4.1, 0.05) if rail_ns else (4.1, 1.0, 0.05)
    box(mats, 'tie', (0, 0, 0.055), plank_scale)

    # The rails themselves, embedded in the planking.
    for side in (1, -1):
        loc = (GAUGE * side, 0, 0.095) if rail_ns else (0, GAUGE * side, 0.095)
        scale = (0.10, 4.1, 0.06) if rail_ns else (4.1, 0.10, 0.06)
        box(mats, 'rail', loc, scale)
