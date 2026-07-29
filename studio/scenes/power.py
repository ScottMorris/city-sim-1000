# Scene: hydro line ground tiles (wires only), every connectivity variant in
# every carriageway situation. The pole is a separate scene (pole.py) rendered
# through the DIMETRIC camera and composited onto these tiles by the stylizer.
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
# SECOND PRINCIPLE: A POLE NEVER STANDS IN THE CARRIAGEWAY. The tile art is
# full-width asphalt, so a line laid over a road or rail has to get its
# support out of the traffic lane. There are exactly three ways to do that,
# and which applies depends on how the line meets what is beneath it:
#
#   * it crosses square      -> two poles, one either side (the `crossing-*`
#                               variants; the wires span the gap)
#   * anything else          -> one pole moved out to the kerb line, with the
#                               legs rebuilt to reach it (the `along-ns-*`,
#                               `along-ew-*` and `junction-*` families)
#
# The kerbside families are named for the CARRIAGEWAY's axis, not the line's:
# `along-ns-corner-ne` is a line turning north-to-east on top of a road
# running north-south. Which kerb the pole lands on is decided here, from the
# same resultant-pull sum that decides the guy, so the pole tucks toward the
# side the wires already lean — and the game never has to know, because it
# addresses sprites by (variant, carriageway axis) alone.
#
# LEG CONTINUITY. A leg running ALONG the carriageway meets a neighbour that
# is displaced the same way, so it terminates at the displaced edge point and
# the corridor reads straight. A leg running off the carriageway meets an
# undisplaced neighbour, so it terminates at the edge midpoint. That keeps
# every seam joined; a line entering or leaving a corridor jogs sideways once,
# which is what real distribution does anyway.
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

# A crossing tile is carried by two poles standing clear of the carriageway
# rather than one planted in it, so its span structure differs from every
# other tile: peak at EACH pole, a shallow trough over the road between them,
# and the usual trough at the tile edges so neighbours still meet.
POLE_OFF = 1.30
# Sag scales with span squared. The span between the two poles is 2*POLE_OFF
# against a normal 4.0 between tile centres, so it sags (2.6/4)^2 as much.
MID_SAG_RATIO = 0.42

# How far a single kerbside pole moves off centre. Both numbers are measured,
# not chosen: the road sprites put their verge band at |1.75|-|2.0| world, and
# the composited pole billboard occupies y -1.07 (foot) to +1.60 (cap) by
# x -0.60 to +0.58.
#
# SIDEWAYS the pole moves freely — 1.30 lands its far edge at 1.88, hard against
# the kerb with the whole billboard still inside the tile.
SHOULDER_X = 1.30
# VERTICALLY IT CAN ONLY EVER GO SOUTH, and not far. The pole is 2.67 tall in a
# 4.0 tile, so there is no offset that puts the foot on the north verge without
# throwing the cap clean off the tile; -0.80 is simply "foot on the south verge"
# (-1.87), which is as far as it goes. The arm then sits near the road's centre
# line, and that is correct rather than a compromise — a real pole stands at the
# kerb and cantilevers its crossarm out over the carriageway. What the eye reads
# as "in the road" is the FOOT, and the foot is now on the verge.
#
# The consequence is that an east-west carriageway always carries its line down
# the south side, whichever way the wires lean. Streets do pick a side.
SHOULDER_Y = -0.80
# On a tile with carriageway both ways there is no verge to stand on, only the
# corner between the two. Pull in slightly on x so the pole tucks into the
# quadrant instead of straddling the cross road.
SHOULDER_DIAG_X = 1.15

# The composited sprite is 160 px across an ortho_scale of 4.0 world units.
PX_PER_UNIT = 40.0

GUY_REACH = 1.05
GUY_BASE_Y = -0.95     # the pole's foot on screen, from pole.py's framing
GUY_ANCHOR = 0.14      # stub at the ground end, so the guy reads as tied down

EDGE_DIR = {'n': (0.0, 1.0), 'e': (1.0, 0.0), 's': (0.0, -1.0), 'w': (-1.0, 0.0)}

# A pole with nothing attached yet. Without this, a lone tile fell back to the
# 4-way cross and sprouted wires in every direction reaching to nothing.
BASE_VARIANTS = {**CONNECTIVITY_VARIANTS, 'isolated': set()}

# Carriageway situations needing a kerbside pole, named for the carriageway's
# own axis: a road/rail running north-south, one running east-west, and a tile
# carrying both (a 4-way junction, or a level crossing).
CLASSES = ('along-ns', 'along-ew', 'junction')


def _crosses_square(cls, base):
    """Is this a straight line square across the carriageway? Those are the
    two-pole cases, already covered by `crossing-ns`/`crossing-ew`."""
    if base not in ('ns', 'ew'):
        return False
    return cls == 'junction' or (cls == 'along-ns') == (base == 'ew')


VARIANTS = {
    **BASE_VARIANTS,
    # Crossing tiles: same connectivity as the straights, different span
    # structure and pole placement (see POLE_OFF).
    'crossing-ns': {'n', 's'},
    'crossing-ew': {'e', 'w'},
}
for _cls in CLASSES:
    for _base, _edges in BASE_VARIANTS.items():
        if not _crosses_square(_cls, _base):
            VARIANTS[f'{_cls}-{_base}'] = _edges

VARIANT = 'ns'  # overridden by the render driver


def _parse(variant):
    """(carriageway class, base connectivity) — class is None on open ground."""
    for cls in CLASSES:
        if variant.startswith(f'{cls}-'):
            return cls, variant[len(cls) + 1:]
    return None, variant


def _pull(edges):
    """Resultant of the connected legs' unit vectors."""
    return (sum(EDGE_DIR[e][0] for e in edges), sum(EDGE_DIR[e][1] for e in edges))


def _shoulder(cls, edges):
    """Where the single pole stands, in world units from the tile centre.

    The east/west choice follows the wires — the pole tucks toward the side
    they already lean, which is also the side the guy is braced away from. A
    tie goes west, so a straight run down a corridor picks one side and every
    tile in it agrees. There is no north/south choice to make (see SHOULDER_Y).
    """
    px, _ = _pull(edges)
    if cls == 'along-ns':      # carriageway vertical -> kerb east or west
        return (SHOULDER_X if px > 1e-6 else -SHOULDER_X, 0.0)
    if cls == 'along-ew':      # carriageway horizontal -> the south verge
        return (0.0, SHOULDER_Y)
    return (SHOULDER_DIAG_X if px > 1e-6 else -SHOULDER_DIAG_X, SHOULDER_Y)


def _px(wx, wy):
    """World offset -> stylizer pixel offset. Image y grows downward."""
    return {'dx': round(wx * PX_PER_UNIT), 'dy': round(-wy * PX_PER_UNIT)}


def prop_offsets():
    """Where the stylizer must composite the pole billboard(s).

    Derived here rather than restated in `stylize.mjs`: the offsets and the
    wire geometry have to agree exactly, and they only do if one place decides.
    """
    if VARIANT == 'crossing-ns':
        return [_px(0, POLE_OFF), _px(0, -POLE_OFF)]
    if VARIANT == 'crossing-ew':
        return [_px(-POLE_OFF, 0), _px(POLE_OFF, 0)]
    cls, _ = _parse(VARIANT)
    if cls is None:
        return [_px(0, 0)]
    return [_px(*_shoulder(cls, VARIANTS[VARIANT]))]


def _straight(mats, x0, y0, x1, y1, width=WIRE_W, overlap=0.02):
    """One wire segment between two points, at whatever angle.

    `overlap` lengthens each segment slightly so a sampled curve reads as one
    wire instead of a dotted line of hairline gaps.
    """
    span = math.hypot(x1 - x0, y1 - y0)
    if span < 1e-6:
        return
    box(mats, 'wire', ((x0 + x1) / 2, (y0 + y1) / 2, WIRE_Z), (span + overlap, width, 0.04),
        (0, 0, math.atan2(y1 - y0, x1 - x0)))


def _hanging(mats, x0, y0, x1, y1, segments=EW_SEGMENTS):
    """A span tied at (x0, y0) and hanging to its low point at (x1, y1).

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
    def at(t):
        return x0 + (x1 - x0) * t, y0 - (y0 - y1) * (1.0 - (1.0 - t) ** 2)

    for i in range(segments):
        ax, ay = at(i / segments)
        bx, by = at((i + 1) / segments)
        _straight(mats, ax, ay, bx, by)


def _ns_leg(mats, sign_y, pole, parallel):
    """Wires from the arm tips to the north or south edge.

    Foreshortened, so no sag — but they do lean when the pole is off centre
    and the neighbour is not.
    """
    sx, sy = pole
    end_x = sx if parallel else 0.0
    for side in (1, -1):
        _straight(mats, sx + side * GAUGE, sy + CROSSARM_Y,
                  end_x + side * GAUGE, sign_y * HALF)


def _ew_leg(mats, sign_x, pole, parallel):
    """Sagging wires from the arm out to the east or west edge."""
    sx, sy = pole
    end_y = sy if parallel else 0.0
    for anchor, sag in EW_WIRES:
        _hanging(mats, sx, sy + anchor, sign_x * HALF, end_y + anchor - sag)


def _span_y(peak_y, drop, x, x_peak, x_trough):
    """Height within one span: steepest at the tie, flat at the low point."""
    denom = abs(x_trough - x_peak)
    t = min(1.0, abs(x - x_peak) / denom) if denom else 1.0
    return peak_y - drop * (1.0 - (1.0 - t) ** 2)


def _crossing_y(anchor, sag, x):
    """Height of an E-W wire on a crossing tile, across the whole width."""
    ax = abs(x)
    if ax >= POLE_OFF:
        return _span_y(anchor, sag, ax, POLE_OFF, HALF)          # pole -> tile edge
    return _span_y(anchor, sag * MID_SAG_RATIO, ax, POLE_OFF, 0.0)  # pole -> over the road


def _ew_crossing(mats):
    """E-W wires carried by two poles either side of the carriageway."""
    segments = EW_SEGMENTS * 2
    for anchor, sag in EW_WIRES:
        for i in range(segments):
            x0 = -HALF + 2 * HALF * i / segments
            x1 = -HALF + 2 * HALF * (i + 1) / segments
            _straight(mats, x0, _crossing_y(anchor, sag, x0), x1, _crossing_y(anchor, sag, x1))


def _guy(mats, pole, lateral):
    """A single guy: one straight run from the crossarm down to the ground.

    Drawn in SCREEN space, not plan space, and this is the one place the scene
    deliberately abandons the plan-view rule.

    A guy always descends from the arm to the ground. Its compass bearing only
    decides which side of the pole it lands on — it can never send the guy *up*
    the image. Placing the anchor at its plan position does exactly that (a
    south-braced pole guys northward, which in plan is up-screen), producing a
    stub pointing at the sky. So: the guy runs from the arm down to
    GUY_BASE_Y, level with the pole's foot, offset left or right by the
    horizontal part of the brace direction. Poles braced due north or south
    have no horizontal component, so they default to the left rather than
    collapsing onto the trunk and vanishing.
    """
    sx, sy = pole
    ax, ay = sx + lateral * GUY_REACH, sy + GUY_BASE_Y
    # Thinner than a conductor, and a touch lower, so it reads as a stay.
    span = math.hypot(ax - sx, ay - (sy + CROSSARM_Y))
    box(mats, 'wire', ((sx + ax) / 2, (sy + CROSSARM_Y + ay) / 2, WIRE_Z * 0.8),
        (span, WIRE_W * 0.75, 0.035),
        (0, 0, math.atan2(ay - (sy + CROSSARM_Y), ax - sx)))
    # Ground anchor stub, so the guy terminates instead of stopping in mid-air.
    box(mats, 'wire', (ax, ay, WIRE_Z * 0.8), (GUY_ANCHOR, GUY_ANCHOR * 0.7, 0.035))


def build(mats):
    cls, _ = _parse(VARIANT)
    edges = VARIANTS[VARIANT]

    if VARIANT == 'crossing-ew':
        _ew_crossing(mats)
        return

    pole = (0.0, 0.0) if cls is None else _shoulder(cls, edges)

    # 'isolated' has no edges: no wires, and no guy either — nothing is
    # pulling on the pole. The tile is just the composited billboard.
    for edge in edges:
        if edge in ('n', 's'):
            _ns_leg(mats, 1 if edge == 'n' else -1, pole, cls == 'along-ns')
        else:
            _ew_leg(mats, 1 if edge == 'e' else -1, pole, cls == 'along-ew')

    # Resultant pull; guy the pole against it when the legs don't balance.
    # Straights and the 4-way cancel to zero and correctly get no guy.
    pull_x, pull_y = _pull(edges)
    if math.hypot(pull_x, pull_y) > 1e-6:
        # Brace away from the pull; ties land on a side carrying no wire.
        _guy(mats, pole, -1.0 if pull_x > 1e-6 else 1.0 if pull_x < -1e-6 else -1.0)
