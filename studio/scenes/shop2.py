# Scene: wide general store — second commercial variant, alongside shop.py.
# Two storefront windows flanking a centred door (vs shop.py's single wide
# window beside an offset door), cream stucco wall, green awning.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

import math

import bpy

from studiolib import box, face_box

WALL_W, WALL_D, WALL_H = 2.3, 1.8, 1.6
ROOF_INSET = 0.10
ROOF_DROP = 0.10
WIN_W, WIN_H = 0.5, 0.46
DOOR_W, DOOR_H = 0.42, 0.72

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

    # Rooftop vent.
    box(mats, 'chimney', (0.5, 0.4, WALL_H - ROOF_DROP + 0.13), (0.24, 0.24, 0.30))

    # Sign band, full storefront width.
    face_box(mats, 'sign', fx, 0, 1.28, 1.7, 0.24, 0.03, 0.05)

    # Awning: one continuous sloped slab over the whole storefront.
    awning = box(mats, 'awning', (fx + 0.16, 0, 1.04), (0.40, 1.55, 0.045))
    awning.rotation_euler = (0, math.radians(18), 0)

    # Two storefront windows flanking a centred door.
    win_z = 0.62
    for win_y in (-0.62, 0.62):
        face_box(mats, 'trim', fx, win_y, win_z, WIN_W + 0.14, WIN_H + 0.14, 0.02, 0.04)
        face_box(mats, 'window', fx, win_y, win_z, WIN_W, WIN_H, 0.05)
        face_box(mats, 'mullion', fx, win_y, win_z, WIN_W, 0.05, 0.065)
        face_box(mats, 'mullion', fx, win_y, win_z, 0.05, WIN_H, 0.065)

    face_box(mats, 'trim', fx, 0, DOOR_H / 2 + 0.04, DOOR_W + 0.16, DOOR_H + 0.08, 0.02, 0.04)
    face_box(mats, 'door', fx, 0, DOOR_H / 2, DOOR_W, DOOR_H, 0.05)
    face_box(mats, 'knob', fx, DOOR_W / 2 - 0.06, DOOR_H * 0.45, 0.06, 0.06, 0.065)

    # Step + walkway at the door.
    box(mats, 'step', (fx + 0.14, 0, 0.035), (0.22, DOOR_W + 0.14, 0.07))
    box(mats, 'walkway', (fx + 0.45, 0, 0.008), (0.8, DOOR_W, 0.016))

    # Planter boxes under each window.
    for win_y in (-0.62, 0.62):
        box(mats, 'bush', (fx + 0.14, win_y, 0.11), (0.22, WIN_W * 0.8, 0.22))
