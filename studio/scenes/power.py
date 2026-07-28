# Scene: hydro line ground tiles (wires only), all 15 connectivity variants.
# The pole is a separate scene (pole.py) rendered through the DIMETRIC camera
# and composited onto these tiles by the stylizer.
#
# FIRST PRINCIPLE: every wire hangs from the crossarm.
#
# The crossarm sits at screen height CROSSARM_Y with its tips at ±GAUGE (this
# is measured from pole.py, not invented here). Every leg therefore starts at
# the arm and runs out to a tile edge, which is what makes corners and
# junctions read as a line *turning at the pole* rather than two unrelated
# runs crossing.
#
# SAG IS DIRECTIONAL, and that is not a cheat — it is what the eye sees. A
# wire running away from the viewer (N-S) is foreshortened and its droop
# collapses to nothing, so it reads straight. A wire running across the view
# (E-W) shows its full catenary. So N-S legs are straight lines from the arm
# tips, and E-W legs are parabolas anchored at the arm and sagging to the
# edge — deliberately exaggerated, in keeping with the rest of the art.
# Sag is zero at the pole and maximal at the tile edge, which is correct
# (the low point of a span is midway between poles) and also makes the
# tiles join seamlessly.
#
# This is the reconciliation the original two hand-made sprites were reaching
# for: they had exactly these two behaviours but no shared anchor, so there
# was nothing to build a corner out of.
#
# GUYS: a pole is guyed when its wire tension is unbalanced, against the
# resultant pull. Summing the unit vectors of the connected edges gives that
# resultant for free — it cancels to zero on straights and the 4-way (no guy,
# correctly), and points along the imbalance for dead ends, corners and tees.
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
WIRE_W = 0.09        # 1 art cell; anything thinner shreds when downsampled
WIRE_Z = 0.06

# Measured off the composited sprite, not estimated: the crossarm bar occupies
# rows 43-49 of the 160 px tile, i.e. centred at 0.85 world with its underside
# at 0.775, and its tips are at ±0.53. (An earlier estimate of 0.78 was the
# bar's *underside* mistaken for its centre, which dragged every wire anchor
# ~3 px low and left a visible gap between the wires and the arm.)
CROSSARM_Y = 0.85
GAUGE = 0.53

# (anchor height at the arm, drop at the tile edge) for the two E-W wires.
# They hang from slightly different points and sag by different amounts, so
# the pair stays tight at the pole and fans apart toward the edge — attached
# AND legibly two wires.
#
# BOTH ANCHORS MUST SIT AT OR BELOW CROSSARM_Y. A wire cannot be higher than
# the thing it hangs from: anchoring the upper wire above the arm makes the
# span bulge over the pole, so its apex reads as a local maximum and the
# whole run looks like a series of arches rather than a hanging line. The
# hand-made sprites got away with an anchor slightly above the arm only
# because their sag was shallow enough to hide it; at the exaggerated sag
# this art wants, it is glaring. Peak at the tie, sag to the span's midpoint
# — which is the tile edge, since poles stand at tile centres.
EW_WIRES = ((0.84, 0.34), (0.70, 0.50))
EW_SEGMENTS = 18

# Guys are drawn in SCREEN space, not plan space, and this is the one place
# the scene deliberately abandons the plan-view rule.
#
# A guy always descends from the arm to the ground. Its compass bearing only
# decides which side of the pole it lands on — it can never send the guy *up*
# the image. Placing the anchor at its plan position does exactly that (a
# south-braced pole guys northward, which in plan is up-screen), producing a
# stub pointing at the sky. So: the guy runs from the arm down to GUY_BASE_Y,
# level with the pole's foot, offset left or right by the horizontal part of
# the brace direction. Poles braced due north or south have no horizontal
# component, so they default to the left rather than collapsing onto the
# trunk and vanishing.
GUY_REACH = 1.05
GUY_BASE_Y = -0.95     # the pole's foot on screen, from pole.py's framing
GUY_ANCHOR = 0.14      # stub at the ground end, so the guy reads as tied down

EDGE_DIR = {'n': (0.0, 1.0), 'e': (1.0, 0.0), 's': (0.0, -1.0), 'w': (-1.0, 0.0)}


def _ns_leg(mats, sign_y):
    """Straight wires from the arm tips out to the north or south edge."""
    far = sign_y * HALF
    length = abs(far - CROSSARM_Y)
    mid = (far + CROSSARM_Y) / 2
    for side in (1, -1):
        box(mats, 'wire', (side * GAUGE, mid, WIRE_Z), (WIRE_W, length, 0.04))


def _sag_y(anchor, sag, x):
    """Height of a hanging span at horizontal distance x from the pole.

    THE VERTEX BELONGS AT THE TILE EDGE, NOT AT THE POLE. A cable is steepest
    where it is tied — tension hauls it up to the crossarm — and flattest at
    its lowest point, which is midspan, which is the tile edge because poles
    stand at tile centres.

    Getting this backwards (vertex at the pole) still descends, so it reads as
    "sagging" at a glance, but it puts the flat part at the arm and the steep
    part at the seam: a smooth hump over every pole and a sharp V-kink at
    every tile boundary. Because the correct curve has zero slope at the edge,
    two neighbouring tiles meet tangentially and a run reads as one continuous
    wave — peak at each pole, trough at each seam — instead of scalloped arcs.
    """
    t = min(1.0, abs(x) / HALF)
    return anchor - sag * (1.0 - (1.0 - t) ** 2)


def _ew_leg(mats, sign_x):
    """Sagging wires from the arm out to the east or west edge."""
    for anchor, sag in EW_WIRES:
        for i in range(EW_SEGMENTS):
            x0 = sign_x * HALF * i / EW_SEGMENTS
            x1 = sign_x * HALF * (i + 1) / EW_SEGMENTS
            y0 = _sag_y(anchor, sag, x0)
            y1 = _sag_y(anchor, sag, x1)
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            span = math.hypot(x1 - x0, y1 - y0)
            box(mats, 'wire', (cx, cy, WIRE_Z), (span + 0.02, WIRE_W, 0.04),
                (0, 0, math.atan2(y1 - y0, x1 - x0)))


def _guy(mats, lateral):
    """A single guy: one straight run from the crossarm down to the ground."""
    ax, ay = lateral * GUY_REACH, GUY_BASE_Y
    cx, cy = ax / 2, (ay + CROSSARM_Y) / 2
    span = math.hypot(ax, ay - CROSSARM_Y)
    box(mats, 'wire', (cx, cy, WIRE_Z * 0.8), (span, WIRE_W * 0.75, 0.035),
        (0, 0, math.atan2(ay - CROSSARM_Y, ax)))
    # Ground anchor stub, so the guy terminates instead of stopping in mid-air.
    box(mats, 'wire', (ax, ay, WIRE_Z * 0.8), (GUY_ANCHOR, GUY_ANCHOR * 0.7, 0.035))


def build(mats):
    edges = VARIANTS[VARIANT]

    for edge in edges:
        if edge == 'n':
            _ns_leg(mats, 1)
        elif edge == 's':
            _ns_leg(mats, -1)
        elif edge == 'e':
            _ew_leg(mats, 1)
        else:
            _ew_leg(mats, -1)

    # Resultant pull; guy the pole against it when the legs don't balance.
    # Straights and the 4-way cancel to zero and correctly get no guy.
    pull_x = sum(EDGE_DIR[e][0] for e in edges)
    pull_y = sum(EDGE_DIR[e][1] for e in edges)
    if math.hypot(pull_x, pull_y) > 1e-6:
        # Brace away from the pull; ties land on a side carrying no wire.
        _guy(mats, -1.0 if pull_x > 1e-6 else 1.0 if pull_x < -1e-6 else -1.0)
