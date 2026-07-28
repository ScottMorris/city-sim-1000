# Scene: glass office tower — first office/high-tech building variant.
# Taller and narrower than the industrial hightech.py plant, with two full-
# width glass bands reading as stacked floors instead of one big curtain
# wall, and a canopy over the entrance.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

import math

import bpy

from studiolib import box, face_box

WALL_W, WALL_D, WALL_H = 1.9, 1.7, 1.9
ROOF_INSET = 0.10
ROOF_DROP = 0.06
WIN_W, WIN_H = 1.3, 0.34
DOOR_W, DOOR_H = 0.4, 0.66
UNIT_SIZE, UNIT_H = 0.26, 0.2

ROTATION_DEG = 75
FOCUS_Z = WALL_H * 0.46


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

    # Two rooftop units.
    for ux in (-0.5, 0.4):
        box(mats, 'chimney', (ux, -0.35, roof_z + UNIT_H / 2 - 0.03), (UNIT_SIZE, UNIT_SIZE, UNIT_H))

    # Two full-width glass bands, reading as stacked floors. The uncovered
    # wall strip between them is the spandrel — no separate role needed.
    for win_z in (0.95, 1.55):
        face_box(mats, 'trim', fx, 0, win_z, WIN_W + 0.08, WIN_H + 0.08, 0.02, 0.03)
        face_box(mats, 'window', fx, 0, win_z, WIN_W, WIN_H, 0.045)
        face_box(mats, 'mullion', fx, 0, win_z, 0.04, WIN_H, 0.06)

    # Entrance door with a canopy, centred beneath the glass bands.
    face_box(mats, 'trim', fx, 0, DOOR_H / 2 + 0.02, DOOR_W + 0.14, DOOR_H + 0.06, 0.02, 0.03)
    face_box(mats, 'door', fx, 0, DOOR_H / 2, DOOR_W, DOOR_H, 0.045)
    face_box(mats, 'knob', fx, DOOR_W / 2 - 0.06, DOOR_H * 0.5, 0.06, 0.06, 0.06)

    canopy = box(mats, 'awning', (fx + 0.16, 0, 0.72), (0.3, 0.9, 0.035))
    canopy.rotation_euler = (0, math.radians(10), 0)

    box(mats, 'step', (fx + 0.1, 0, 0.025), (0.16, DOOR_W + 0.12, 0.05))
    box(mats, 'walkway', (fx + 0.42, 0, 0.008), (0.7, DOOR_W * 0.8, 0.016))
