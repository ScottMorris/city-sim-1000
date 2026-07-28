# Scene: high-tech plant — third industrial variant. Taller and slimmer
# than factory.py/warehouse.py, with one large glass curtain-wall window
# instead of a loading dock, and a small rooftop condenser unit.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

import bpy

from studiolib import box, face_box

WALL_W, WALL_D, WALL_H = 2.2, 1.9, 1.45
ROOF_INSET = 0.10
ROOF_DROP = 0.08
WIN_W, WIN_H = 1.0, 0.85
UNIT_SIZE, UNIT_H = 0.34, 0.24

ROTATION_DEG = 75
FOCUS_Z = WALL_H * 0.5


def build(mats):
    fx = WALL_W / 2

    # Wall box up to roof level only.
    roof_z = WALL_H - ROOF_DROP
    box(mats, 'wall', (0, 0, roof_z / 2), (WALL_W, WALL_D, roof_z))

    # Flat roof slab.
    box(mats, 'roof', (0, 0, roof_z + 0.02), (WALL_W - ROOF_INSET, WALL_D - ROOF_INSET, 0.06))

    # Low parapet ring.
    lip = 0.08
    for sign_x in (1, -1):
        box(mats, 'wall', (sign_x * (WALL_W / 2 - lip / 2), 0, WALL_H - ROOF_DROP / 2),
            (lip, WALL_D, ROOF_DROP))
    for sign_y in (1, -1):
        box(mats, 'wall', (0, sign_y * (WALL_D / 2 - lip / 2), WALL_H - ROOF_DROP / 2),
            (WALL_W, lip, ROOF_DROP))

    # Rooftop condenser unit, set back from the front edge.
    box(mats, 'chimney', (-0.4, -0.3, roof_z + UNIT_H / 2 - 0.03), (UNIT_SIZE, UNIT_SIZE, UNIT_H))

    # Large glass curtain wall, most of the left half of the front face.
    win_z = roof_z * 0.56
    win_y = -0.3
    face_box(mats, 'trim', fx, win_y, win_z, WIN_W + 0.1, WIN_H + 0.1, 0.02, 0.03)
    face_box(mats, 'window', fx, win_y, win_z, WIN_W, WIN_H, 0.045)
    face_box(mats, 'mullion', fx, win_y, win_z, WIN_W, 0.04, 0.06)
    face_box(mats, 'mullion', fx, win_y, win_z, 0.04, WIN_H, 0.06)

    # Recessed entry door, right of the curtain wall.
    door_y = 0.65
    door_w, door_h = 0.4, 0.66
    face_box(mats, 'trim', fx, door_y, door_h / 2 + 0.02, door_w + 0.12, door_h + 0.06, 0.02, 0.03)
    face_box(mats, 'door', fx, door_y, door_h / 2, door_w, door_h, 0.045)
    face_box(mats, 'knob', fx, door_y - door_w / 2 + 0.06, door_h * 0.5, 0.06, 0.06, 0.06)

    box(mats, 'step', (fx + 0.1, door_y, 0.025), (0.16, door_w + 0.1, 0.05))
    box(mats, 'walkway', (fx + 0.4, door_y, 0.008), (0.7, door_w * 0.7, 0.016))
