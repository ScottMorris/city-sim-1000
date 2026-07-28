# Scene: corrugated-metal heavy factory — fifth industrial variant. Squat
# and wide like factory2.py but with a single offset chimney (shorter than
# factory.py's) and a band of two square windows beside a wide door,
# reading as an older heavy-industry shed.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

import bpy

from studiolib import box, face_box

WALL_W, WALL_D, WALL_H = 2.5, 1.9, 1.2
ROOF_INSET = 0.10
ROOF_DROP = 0.07
DOOR_W, DOOR_H = 0.9, 0.85
WIN_W, WIN_H = 0.3, 0.3
CHIM_SIZE, CHIM_H = 0.3, 0.7

ROTATION_DEG = 75
FOCUS_Z = WALL_H * 0.52


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

    # Single offset chimney, shorter than factory.py's.
    box(mats, 'chimney', (-0.7, -WALL_D / 2 + 0.22, roof_z + CHIM_H / 2 - 0.04),
        (CHIM_SIZE, CHIM_SIZE, CHIM_H))

    # Two square windows in a row.
    win_z = roof_z - 0.24
    for win_y in (-0.75, -0.4):
        face_box(mats, 'trim', fx, win_y, win_z, WIN_W + 0.08, WIN_H + 0.08, 0.02, 0.03)
        face_box(mats, 'window', fx, win_y, win_z, WIN_W, WIN_H, 0.04)

    # Wide door, right of the windows.
    door_y = 0.3
    face_box(mats, 'trim', fx, door_y, DOOR_H / 2 + 0.02, DOOR_W + 0.12, DOOR_H + 0.06, 0.02, 0.03)
    face_box(mats, 'door', fx, door_y, DOOR_H / 2, DOOR_W, DOOR_H, 0.045)

    # Loading apron.
    box(mats, 'step', (fx + 0.1, door_y, 0.025), (0.16, DOOR_W + 0.1, 0.05))
    box(mats, 'walkway', (fx + 0.5, door_y, 0.008), (0.9, DOOR_W * 0.6, 0.016))
