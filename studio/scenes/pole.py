# Scene: utility pole billboard prop — rendered through the standard DIMETRIC
# camera (so it stands up, like the pole in the existing hand-made powerline
# sprites) and composited onto the top-down power wire tiles by the stylizer.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

import math

from studiolib import box

ROTATION_DEG = 0
FOCUS_Z = 0.7


def build(mats):
    # The pole itself — taller than real-world proportion, matching the
    # exaggerated elevation-view pole of the existing sprites. The overlay is
    # composited at 1:1 world scale with the wire tile, so the crossarm tips
    # (±0.30 along the screen-horizontal) land exactly on the wire lines.
    box(mats, 'tie', (0, 0, 1.1), (0.12, 0.12, 2.2))
    # Crossarms, oriented perpendicular to the camera azimuth (45°) so they
    # read as horizontal bars on screen.
    for z in (2.0, 1.78):
        box(mats, 'tie', (0, 0, z), (0.68, 0.09, 0.07), (0, 0, math.radians(135)))
