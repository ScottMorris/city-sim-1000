# Scene: hydro pole billboard prop — rendered through the standard DIMETRIC
# camera (so it stands up, like the pole in the existing hand-made hydro
# sprites) and composited onto the top-down wire tiles by the stylizer.
#
# Measured against both reference sprites: pole spans ~22-78% of the tile
# height with a single long crossarm whose bar sits ~31 px above tile centre
# once the billboard is composited 12 art cells (40 px) low — the same
# alignment puts the crossarm tips exactly on the vertical tile's wires
# (±0.53 world) and at the horizontal tile's upper wire height.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

import math

from studiolib import box

ROTATION_DEG = 0
FOCUS_Z = 0.7


def build(mats):
    # The pole: tall (2.7 world -> ~58% of tile height on screen), wide
    # enough (0.17 ~ 2 art cells) that the wood material shows between its
    # ink outlines. Wood role — shaded two-tone by the studio sun.
    box(mats, 'tie', (0, 0, 1.35), (0.17, 0.17, 2.7))
    # Double crossarms (classic hydro), oriented perpendicular to the camera
    # azimuth so they read horizontal. Their heights project to the two EW
    # wire anchor lines (0.894*z - overlay offset): z 2.0 -> +0.79, z 1.67 ->
    # +0.49 — so BOTH sagging wires hang from an arm, and the NS wires meet
    # the upper arm's tips. Porcelain insulators (trim) mark the attachments.
    for z, length in ((2.0, 1.15), (1.67, 0.95)):
        box(mats, 'tie', (0, 0, z), (length, 0.09, 0.08), (0, 0, math.radians(135)))
        for side in (1, -1):
            tip = (length / 2) * side
            box(mats, 'trim', (tip * -0.707, tip * 0.707, z + 0.11), (0.12, 0.12, 0.13))
    # Transformer can hanging right of the pole below the arm (grey).
    stub = 0.20
    box(mats, 'step', (stub * 0.707, -stub * 0.707, 1.62), (0.14, 0.14, 0.32))
