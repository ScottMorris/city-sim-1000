# Scene: wide single-storey bungalow — second residential variant, alongside
# house.py. Lower, wider massing with a shallower roof pitch and a single
# large picture window (contrast against house.py's steep gable + small
# upper window).
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

import bpy

from studiolib import box, face_box

WALL_W, WALL_D, WALL_H = 2.2, 1.7, 0.85
ROOF_H = 0.85
ROOF_OVERHANG_EAVE = 0.075
ROOF_OVERHANG_RAKE = 0.15
WIN_W, WIN_H = 0.56, 0.38
DOOR_W, DOOR_H = 0.4, 0.62
CHIM_SIZE, CHIM_H = 0.22, 0.62

ROTATION_DEG = 75
FOCUS_Z = (WALL_H + ROOF_H) * 0.42


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

    # Chimney on the +Y slope (mirrored from house.py's -Y placement so the
    # silhouette reads differently from the far side too).
    chim_x, chim_y = -rx * 0.4, ry * 0.5
    slope_t = (chim_y - ry) / (0 - ry)
    chim_base_z = eave_z + slope_t * (ridge_z - eave_z)
    box(mats, 'chimney', (chim_x, chim_y, chim_base_z + CHIM_H / 2 - 0.05),
        (CHIM_SIZE, CHIM_SIZE, CHIM_H))

    # Single large picture window on the gable end, low and wide (bungalow
    # massing reads through a squat window rather than a tall one).
    fx = WALL_W / 2
    win_z = WALL_H * 0.55
    win_y = -0.32
    face_box(mats, 'trim', fx, win_y, win_z, WIN_W + 0.16, WIN_H + 0.16, 0.02, 0.04)
    face_box(mats, 'window', fx, win_y, win_z, WIN_W, WIN_H, 0.05)
    face_box(mats, 'mullion', fx, win_y, win_z, WIN_W, 0.05, 0.065)

    door_y = 0.5
    face_box(mats, 'trim', fx, door_y, DOOR_H / 2 + 0.04, DOOR_W + 0.16, DOOR_H + 0.08, 0.02, 0.04)
    face_box(mats, 'door', fx, door_y, DOOR_H / 2, DOOR_W, DOOR_H, 0.05)
    face_box(mats, 'knob', fx, door_y - DOOR_W / 2 + 0.06, DOOR_H * 0.45, 0.06, 0.06, 0.065)

    # Stone step under the door.
    box(mats, 'step', (fx + 0.14, door_y, 0.035), (0.22, DOOR_W + 0.14, 0.07))

    # Bush at the wall junction corner, opposite the window.
    bpy.ops.mesh.primitive_ico_sphere_add(
        subdivisions=2, radius=0.34, location=(fx + 0.16, WALL_D / 2 + 0.05, 0.2))
    bush = bpy.context.object
    bush.scale = (1.0, 1.0, 0.8)
    bush.data.materials.append(mats['bush'])

    # Walkway from the door.
    walkway_len = 0.75
    box(mats, 'walkway', (fx + walkway_len / 2, door_y, 0.008), (walkway_len, DOOR_W, 0.016))
