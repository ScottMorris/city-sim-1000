# Scene: powerline ground tiles (wires only). The pole is a separate scene
# (pole.py) rendered through the DIMETRIC camera and composited onto these
# tiles by the stylizer — the same top-down-ground / elevation-pole cheat the
# existing (liked) hand-made powerline sprites use.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

from studiolib import box

TOP_DOWN = True
ROTATION_DEG = 0

VARIANTS = {'ns': None, 'ew': None}
VARIANT = 'ns'

WIRE_OFFSET = 0.30


def build(mats):
    ns = VARIANT == 'ns'
    # Two parallel wires, low over the grass (kept near the ground so their
    # cast shadows stay tight instead of drawing a doubled line).
    for side in (1, -1):
        loc = (WIRE_OFFSET * side, 0, 0.06) if ns else (0, WIRE_OFFSET * side, 0.06)
        scale = (0.09, 4.1, 0.04) if ns else (4.1, 0.09, 0.04)
        box(mats, 'wire', loc, scale)
