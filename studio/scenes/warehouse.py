# Scene: low steel warehouse — second industrial variant. Wider and lower
# than factory.py, no smokestack; a very wide roller door and two roof
# vents instead.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

from studiolib import box, face_box

WALL_W, WALL_D, WALL_H = 2.6, 1.9, 1.0
ROOF_INSET = 0.10
ROOF_DROP = 0.07
DOOR_W, DOOR_H = 1.3, 0.6
WIN_W, WIN_H = 0.24, 0.16
VENT_SIZE, VENT_H = 0.24, 0.22

ROTATION_DEG = 75
FOCUS_Z = WALL_H * 0.55


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

    # Two roof vents.
    for vx in (-0.5, 0.5):
        box(mats, 'chimney', (vx, 0.25, roof_z + VENT_H / 2 - 0.03), (VENT_SIZE, VENT_SIZE, VENT_H))

    # Thin clerestory windows above the roller door.
    win_z = DOOR_H + 0.13
    for win_y in (-0.75, -0.4, 0.4, 0.75):
        face_box(mats, 'trim', fx, win_y, win_z, WIN_W + 0.08, WIN_H + 0.08, 0.02, 0.03)
        face_box(mats, 'window', fx, win_y, win_z, WIN_W, WIN_H, 0.04)

    # Very wide roller door, centred.
    face_box(mats, 'trim', fx, 0, DOOR_H / 2 + 0.02, DOOR_W + 0.12, DOOR_H + 0.06, 0.02, 0.03)
    face_box(mats, 'door', fx, 0, DOOR_H / 2, DOOR_W, DOOR_H, 0.045)

    # Loading apron running the width of the door.
    box(mats, 'step', (fx + 0.1, 0, 0.025), (0.16, DOOR_W + 0.1, 0.05))
    box(mats, 'walkway', (fx + 0.45, 0, 0.008), (0.8, DOOR_W * 0.6, 0.016))
