# Scene: narrow café — third commercial variant. Taller, narrower footprint
# than shop.py/shop2.py, with one tall portrait-proportioned window instead
# of a wide storefront pane.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

import math

from studiolib import box, face_box

WALL_W, WALL_D, WALL_H = 1.7, 1.5, 1.7
ROOF_INSET = 0.10
ROOF_DROP = 0.10
WIN_W, WIN_H = 0.5, 0.78
DOOR_W, DOOR_H = 0.4, 0.7

ROTATION_DEG = 75
FOCUS_Z = WALL_H * 0.55


def build(mats):
    fx = WALL_W / 2

    # Wall box up to roof level only.
    roof_z = WALL_H - ROOF_DROP
    box(mats, 'wall', (0, 0, roof_z / 2), (WALL_W, WALL_D, roof_z))

    # Flat roof slab.
    box(mats, 'roof', (0, 0, roof_z + 0.02), (WALL_W - ROOF_INSET, WALL_D - ROOF_INSET, 0.06))

    # Parapet ring.
    lip = 0.10
    for sign_x in (1, -1):
        box(mats, 'wall', (sign_x * (WALL_W / 2 - lip / 2), 0, WALL_H - ROOF_DROP / 2),
            (lip, WALL_D, ROOF_DROP))
    for sign_y in (1, -1):
        box(mats, 'wall', (0, sign_y * (WALL_D / 2 - lip / 2), WALL_H - ROOF_DROP / 2),
            (WALL_W, lip, ROOF_DROP))

    # Rooftop vent, offset toward the back corner.
    box(mats, 'chimney', (-0.35, -0.3, WALL_H - ROOF_DROP + 0.13), (0.2, 0.2, 0.26))

    # Sign band, narrower than the storefront variants.
    face_box(mats, 'sign', fx, -0.15, 1.36, 1.05, 0.22, 0.03, 0.05)

    # Awning over the window only, dropping toward the street.
    win_y = -0.32
    awning = box(mats, 'awning', (fx + 0.15, win_y, 1.14), (0.34, 0.62, 0.04))
    awning.rotation_euler = (0, math.radians(18), 0)

    # Tall portrait window.
    win_z = WALL_H * 0.44
    face_box(mats, 'trim', fx, win_y, win_z, WIN_W + 0.14, WIN_H + 0.14, 0.02, 0.04)
    face_box(mats, 'window', fx, win_y, win_z, WIN_W, WIN_H, 0.05)
    face_box(mats, 'mullion', fx, win_y, win_z, WIN_W, 0.05, 0.065)
    face_box(mats, 'mullion', fx, win_y, win_z, 0.05, WIN_H, 0.065)

    door_y = 0.45
    face_box(mats, 'trim', fx, door_y, DOOR_H / 2 + 0.04, DOOR_W + 0.16, DOOR_H + 0.08, 0.02, 0.04)
    face_box(mats, 'door', fx, door_y, DOOR_H / 2, DOOR_W, DOOR_H, 0.05)
    face_box(mats, 'knob', fx, door_y - DOOR_W / 2 + 0.06, DOOR_H * 0.45, 0.06, 0.06, 0.065)

    # Step + walkway at the door.
    box(mats, 'step', (fx + 0.14, door_y, 0.035), (0.22, DOOR_W + 0.14, 0.07))
    box(mats, 'walkway', (fx + 0.45, door_y, 0.008), (0.8, DOOR_W, 0.016))

    # Planter under the window.
    box(mats, 'bush', (fx + 0.14, win_y, 0.11), (0.22, WIN_W * 0.75, 0.22))
