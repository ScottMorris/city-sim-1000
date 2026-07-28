# Scene: small commercial shop — flat parapet roof, storefront window with an
# awning, sign band, rooftop vent, hedge planter. First non-house asset: the
# variety test for the studio pipeline.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

import math

import bpy

from studiolib import box, face_box

WALL_W, WALL_D, WALL_H = 2.1, 1.7, 1.55   # taller box, no pitched roof
ROOF_INSET = 0.10                          # parapet lip width
ROOF_DROP = 0.10                           # roof surface sits below the parapet rim
WIN_W, WIN_H = 1.05, 0.50                  # wide storefront window
DOOR_W, DOOR_H = 0.42, 0.72

ROTATION_DEG = 75
FOCUS_Z = WALL_H * 0.55


def build(mats):
    fx = WALL_W / 2

    # Wall box up to roof level only — a solid box to the rim would cap the
    # building with a wall-coloured top face and hide the roof entirely.
    roof_z = WALL_H - ROOF_DROP
    box(mats, 'wall', (0, 0, roof_z / 2), (WALL_W, WALL_D, roof_z))

    # Flat roof slab on top of the wall box. Being flat (constant height), it
    # naturally gets no course lines from the height-contour stylizer.
    box(mats, 'roof', (0, 0, roof_z + 0.02), (WALL_W - ROOF_INSET, WALL_D - ROOF_INSET, 0.06))

    # Parapet: a ring of four thin wall-role boxes rising past the roof.
    lip = 0.10
    for sign_x in (1, -1):
        box(mats, 'wall', (sign_x * (WALL_W / 2 - lip / 2), 0, WALL_H - ROOF_DROP / 2),
            (lip, WALL_D, ROOF_DROP))
    for sign_y in (1, -1):
        box(mats, 'wall', (0, sign_y * (WALL_D / 2 - lip / 2), WALL_H - ROOF_DROP / 2),
            (WALL_W, lip, ROOF_DROP))

    # Rooftop vent (chimney role).
    box(mats, 'chimney', (-0.45, -0.35, WALL_H - ROOF_DROP + 0.13), (0.24, 0.24, 0.30))

    # Sign band above the awning, full storefront width.
    face_box(mats, 'sign', fx, 0, 1.24, 1.5, 0.26, 0.03, 0.05)

    # Awning: sloped slab over the storefront, dropping toward the street.
    awning = box(mats, 'awning', (fx + 0.16, -0.12, 1.02), (0.40, 1.30, 0.045))
    awning.rotation_euler = (0, math.radians(18), 0)

    # Storefront window (offset left) + door (offset right).
    win_y, win_z = -0.28, 0.62
    face_box(mats, 'trim', fx, win_y, win_z, WIN_W + 0.14, WIN_H + 0.14, 0.02, 0.04)
    face_box(mats, 'window', fx, win_y, win_z, WIN_W, WIN_H, 0.05)
    face_box(mats, 'mullion', fx, win_y, win_z, 0.05, WIN_H, 0.065)

    door_y = 0.62
    face_box(mats, 'trim', fx, door_y, DOOR_H / 2 + 0.04, DOOR_W + 0.16, DOOR_H + 0.08, 0.02, 0.04)
    face_box(mats, 'door', fx, door_y, DOOR_H / 2, DOOR_W, DOOR_H, 0.05)
    face_box(mats, 'knob', fx, door_y - DOOR_W / 2 + 0.06, DOOR_H * 0.45, 0.06, 0.06, 0.065)

    # Step + walkway at the door.
    box(mats, 'step', (fx + 0.14, door_y, 0.035), (0.22, DOOR_W + 0.14, 0.07))
    box(mats, 'walkway', (fx + 0.45, door_y, 0.008), (0.8, DOOR_W, 0.016))

    # Hedge planter under the storefront window.
    box(mats, 'bush', (fx + 0.14, win_y, 0.11), (0.22, WIN_W * 0.8, 0.22))
