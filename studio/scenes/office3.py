# Scene: boutique tech startup — third office variant. Smaller and lower
# than office1.py/office2.py, one big storefront-style glass frontage (like
# the industrial hightech.py plant) plus a bright accent sign band instead
# of a second floor of windows.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

from studiolib import box, face_box

WALL_W, WALL_D, WALL_H = 1.8, 1.6, 1.3
ROOF_INSET = 0.10
ROOF_DROP = 0.06
WIN_W, WIN_H = 0.8, 0.62
DOOR_W, DOOR_H = 0.4, 0.66

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

    # Small rooftop unit.
    box(mats, 'chimney', (-0.35, -0.3, roof_z + 0.1), (0.24, 0.24, 0.18))

    # Bright accent sign band above the glass.
    face_box(mats, 'sign', fx, -0.3, roof_z - 0.14, 0.78, 0.18, 0.03, 0.05)

    # Large glass frontage, left of the door.
    win_y = -0.3
    win_z = 0.62
    face_box(mats, 'trim', fx, win_y, win_z, WIN_W + 0.1, WIN_H + 0.1, 0.02, 0.03)
    face_box(mats, 'window', fx, win_y, win_z, WIN_W, WIN_H, 0.045)
    face_box(mats, 'mullion', fx, win_y, win_z, WIN_W, 0.04, 0.06)
    face_box(mats, 'mullion', fx, win_y, win_z, 0.04, WIN_H, 0.06)

    # Entrance door, right of the glass.
    door_y = 0.55
    face_box(mats, 'trim', fx, door_y, DOOR_H / 2 + 0.02, DOOR_W + 0.14, DOOR_H + 0.06, 0.02, 0.03)
    face_box(mats, 'door', fx, door_y, DOOR_H / 2, DOOR_W, DOOR_H, 0.045)
    face_box(mats, 'knob', fx, door_y - DOOR_W / 2 + 0.06, DOOR_H * 0.5, 0.06, 0.06, 0.06)

    box(mats, 'step', (fx + 0.1, door_y, 0.025), (0.16, DOOR_W + 0.12, 0.05))
    box(mats, 'walkway', (fx + 0.4, door_y, 0.008), (0.65, DOOR_W * 0.8, 0.016))
