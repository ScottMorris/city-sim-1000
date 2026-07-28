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
    # Crossarms, thick enough (0.14 ~ 1.7 art cells) that the wood core shows
    # between the ink outlines like the pole's does. (Insulator nubs were
    # tried and cut: sub-cell at this grid, they just added ink and mushed
    # the junction.)
    #
    # One arm, along world (-1, 1) so the fixed 45° azimuth reads it
    # horizontal on screen, with its tips on the N-S wires.
    #
    # A second arm at right angles was tried, to give the E-W wires tips to
    # land on too — physically what a junction pole has. It does not survive
    # this projection: a bar along (1, 1) points away from the camera, so the
    # 2:1 dimetric foreshortens 1.15 world units into a stub that merely
    # thickens the first arm into a blob. E-W wires therefore pass the pole
    # rather than visibly hanging from it; accepted, and cheaper to revisit in
    # the stylizer than in geometry.
    box(mats, 'tie', (0, 0, 2.0), (1.15, 0.14, 0.11), (0, 0, math.radians(135)))
    # Transformer can on the pole, well below the arm so it stays clear of
    # the wire bundle (grey).
    #
    # Shortened rather than narrowed. It read as a lot of transformer for a
    # distribution pole, but the bulk was vertical: at 0.32 tall it ran nearly
    # a third of the visible trunk. Slimming it to 0.11 instead put it at ~1.3
    # art cells wide, under the 2-3 cells a part needs to hold its own colour,
    # so the majority vote swallowed the grey and left an anonymous dark blob.
    # Width carries legibility here; height carried the dominance.
    stub = 0.20
    box(mats, 'step', (stub * 0.707, -stub * 0.707, 1.30), (0.14, 0.14, 0.22))
