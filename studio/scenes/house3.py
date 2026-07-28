# Scene: narrow two-storey colonial — third residential variant. Taller and
# narrower than house.py/house2.py, with a stacked window-over-window front
# (reads as two storeys) instead of a single gable window.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

import bpy

from studiolib import box, face_box

WALL_W, WALL_D, WALL_H = 1.7, 1.5, 1.35
ROOF_H = 0.95
ROOF_OVERHANG_EAVE = 0.075
ROOF_OVERHANG_RAKE = 0.14
WIN_W, WIN_H = 0.36, 0.38
DOOR_W, DOOR_H = 0.38, 0.6
CHIM_SIZE, CHIM_H = 0.24, 0.85

ROTATION_DEG = 75
FOCUS_Z = (WALL_H + ROOF_H) * 0.46


def build(mats):
    # Wall box.
    box(mats, 'wall', (0, 0, WALL_H / 2), (WALL_W, WALL_D, WALL_H))

    # Gable roof volume: two slope quads (roof) + two gable-end triangles
    # (wall), one mesh, two material slots.
    rx = WALL_W / 2 + ROOF_OVERHANG_RAKE
    half_depth = WALL_D / 2
    pitch = ROOF_H / half_depth
    ry = half_depth + ROOF_OVERHANG_EAVE
    eave_z = WALL_H - pitch * ROOF_OVERHANG_EAVE
    ridge_z = WALL_H + ROOF_H

    verts = [
        (-rx, -ry, eave_z), (rx, -ry, eave_z),
        (rx, ry, eave_z), (-rx, ry, eave_z),
        (-rx, 0, ridge_z), (rx, 0, ridge_z),
        (-WALL_W / 2, -WALL_D / 2, WALL_H), (-WALL_W / 2, WALL_D / 2, WALL_H),
        (WALL_W / 2, -WALL_D / 2, WALL_H), (WALL_W / 2, WALL_D / 2, WALL_H),
        (-WALL_W / 2, 0, ridge_z), (WALL_W / 2, 0, ridge_z),
    ]
    faces = [
        (0, 1, 5, 4),    # -Y slope
        (2, 3, 4, 5),    # +Y slope
        (6, 7, 10),      # -X gable cap
        (9, 8, 11),      # +X gable cap
    ]
    roof_mesh = bpy.data.meshes.new('roof_mesh')
    roof_mesh.from_pydata(verts, [], faces)
    roof_mesh.update()
    roof_obj = bpy.data.objects.new('roof', roof_mesh)
    bpy.context.collection.objects.link(roof_obj)
    roof_obj.data.materials.append(mats['roof'])
    roof_obj.data.materials.append(mats['wall'])
    for poly in roof_obj.data.polygons:
        poly.material_index = 0 if len(poly.vertices) == 4 else 1

    # Chimney centred on the ridge, tall — narrow massing reads better with a
    # centred stack than an offset one.
    chim_x, chim_y = 0.0, 0.0
    box(mats, 'chimney', (chim_x, chim_y, ridge_z + CHIM_H / 2 - 0.08),
        (CHIM_SIZE, CHIM_SIZE, CHIM_H))

    fx = WALL_W / 2

    # Upper-storey window in the gable end.
    win_z_hi = WALL_H + 0.14
    face_box(mats, 'trim', fx, 0, win_z_hi, WIN_W + 0.14, WIN_H + 0.14, 0.02, 0.04)
    face_box(mats, 'window', fx, 0, win_z_hi, WIN_W, WIN_H, 0.05)
    face_box(mats, 'mullion', fx, 0, win_z_hi, WIN_W, 0.05, 0.065)
    face_box(mats, 'mullion', fx, 0, win_z_hi, 0.05, WIN_H, 0.065)

    # Ground-storey window beside the door.
    win_z_lo = WALL_H * 0.42
    win_y_lo = -0.42
    face_box(mats, 'trim', fx, win_y_lo, win_z_lo, WIN_W + 0.14, WIN_H + 0.14, 0.02, 0.04)
    face_box(mats, 'window', fx, win_y_lo, win_z_lo, WIN_W, WIN_H, 0.05)
    face_box(mats, 'mullion', fx, win_y_lo, win_z_lo, WIN_W, 0.05, 0.065)
    face_box(mats, 'mullion', fx, win_y_lo, win_z_lo, 0.05, WIN_H, 0.065)

    door_y = 0.35
    face_box(mats, 'trim', fx, door_y, DOOR_H / 2 + 0.04, DOOR_W + 0.16, DOOR_H + 0.08, 0.02, 0.04)
    face_box(mats, 'door', fx, door_y, DOOR_H / 2, DOOR_W, DOOR_H, 0.05)
    face_box(mats, 'knob', fx, door_y - DOOR_W / 2 + 0.06, DOOR_H * 0.5, 0.06, 0.06, 0.065)

    # Stone step under the door.
    box(mats, 'step', (fx + 0.14, door_y, 0.035), (0.22, DOOR_W + 0.14, 0.07))

    # Bush at the wall junction corner.
    bpy.ops.mesh.primitive_ico_sphere_add(
        subdivisions=2, radius=0.3, location=(fx + 0.16, -WALL_D / 2 - 0.05, 0.19))
    bush = bpy.context.object
    bush.scale = (1.0, 1.0, 0.8)
    bush.data.materials.append(mats['bush'])

    # Walkway from the door.
    walkway_len = 0.7
    box(mats, 'walkway', (fx + walkway_len / 2, door_y, 0.008), (walkway_len, DOOR_W, 0.016))
