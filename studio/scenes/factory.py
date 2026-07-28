# Scene: brick factory with a smokestack — first industrial variant. Flat
# roof, a wide loading-dock door (reuses the 'door' role at industrial
# scale), a clerestory row of small windows, and a tall chimney stack.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

from studiolib import box, face_box

WALL_W, WALL_D, WALL_H = 2.4, 1.8, 1.3
ROOF_INSET = 0.10
ROOF_DROP = 0.08
# Door height is capped so its trim clears the clerestory row above it: the
# window trim starts at 0.83, and a 0.68 door tops out at 0.73, leaving a
# 1-cell wall band between them. A taller door merges the two outlines.
DOOR_W, DOOR_H = 0.9, 0.68
WIN_W, WIN_H = 0.26, 0.24
CHIM_SIZE, CHIM_H = 0.32, 1.0

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

    # Tall smokestack at the back corner.
    box(mats, 'chimney', (-fx * 0.55, -WALL_D / 2 + 0.2, roof_z + CHIM_H / 2 - 0.05),
        (CHIM_SIZE, CHIM_SIZE, CHIM_H))

    # Clerestory row of small windows above the loading dock.
    win_z = roof_z - 0.22
    for win_y in (-0.55, 0, 0.55):
        face_box(mats, 'trim', fx, win_y, win_z, WIN_W + 0.1, WIN_H + 0.1, 0.02, 0.03)
        face_box(mats, 'window', fx, win_y, win_z, WIN_W, WIN_H, 0.045)

    # Wide loading-dock door, off-centre.
    door_y = 0.15
    face_box(mats, 'trim', fx, door_y, DOOR_H / 2 + 0.02, DOOR_W + 0.12, DOOR_H + 0.06, 0.02, 0.03)
    face_box(mats, 'door', fx, door_y, DOOR_H / 2, DOOR_W, DOOR_H, 0.045)
    face_box(mats, 'knob', fx, door_y - DOOR_W / 2 + 0.08, DOOR_H * 0.5, 0.06, 0.06, 0.06)

    # Loading apron.
    box(mats, 'step', (fx + 0.12, door_y, 0.03), (0.2, DOOR_W + 0.1, 0.06))
    box(mats, 'walkway', (fx + 0.5, door_y, 0.008), (0.9, DOOR_W * 0.7, 0.016))
