# Scene: concrete tilt-up factory — fourth industrial variant. Wider and
# lower than factory.py, twin short stacks instead of one tall smokestack,
# a roller door beside a small office window (mixed industrial/office
# frontage) rather than a single loading dock.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

from studiolib import box, face_box

WALL_W, WALL_D, WALL_H = 2.5, 1.9, 1.1
ROOF_INSET = 0.10
ROOF_DROP = 0.07
DOOR_W, DOOR_H = 0.85, 0.8
WIN_W, WIN_H = 0.4, 0.36
STACK_SIZE, STACK_H = 0.24, 0.55

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

    # Twin short stacks toward the back.
    for sx in (-0.25, 0.25):
        box(mats, 'chimney', (sx - 0.5, -WALL_D / 2 + 0.22, roof_z + STACK_H / 2 - 0.04),
            (STACK_SIZE, STACK_SIZE, STACK_H))

    # Office window, left of the door.
    win_z = 0.55
    win_y = -0.55
    face_box(mats, 'trim', fx, win_y, win_z, WIN_W + 0.1, WIN_H + 0.1, 0.02, 0.03)
    face_box(mats, 'window', fx, win_y, win_z, WIN_W, WIN_H, 0.045)
    face_box(mats, 'mullion', fx, win_y, win_z, WIN_W, 0.04, 0.06)
    face_box(mats, 'mullion', fx, win_y, win_z, 0.04, WIN_H, 0.06)

    # Roller door, right of centre.
    door_y = 0.35
    face_box(mats, 'trim', fx, door_y, DOOR_H / 2 + 0.02, DOOR_W + 0.12, DOOR_H + 0.06, 0.02, 0.03)
    face_box(mats, 'door', fx, door_y, DOOR_H / 2, DOOR_W, DOOR_H, 0.045)

    # Loading apron.
    box(mats, 'step', (fx + 0.1, door_y, 0.025), (0.16, DOOR_W + 0.1, 0.05))
    box(mats, 'walkway', (fx + 0.45, door_y, 0.008), (0.75, DOOR_W * 0.7, 0.016))
