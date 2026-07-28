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
    # The pole itself.
    box(mats, 'tie', (0, 0, 0.7), (0.12, 0.12, 1.4))
    # Crossarms, oriented perpendicular to the camera azimuth (45°) so they
    # read as horizontal bars on screen.
    for z in (1.28, 1.08):
        box(mats, 'tie', (0, 0, z), (0.60, 0.09, 0.07), (0, 0, math.radians(135)))
