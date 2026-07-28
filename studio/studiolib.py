# Studio scaffolding — the INVARIANT layer of the render pipeline.
#
# Owns everything that must be identical for every asset so the whole set
# reads as one game: the camera, the sun, the render/pass settings, and the
# role/material system. Building scenes (scenes/*.py) only supply geometry.
#
# Scenes must NOT touch: camera, lights, world, render settings, view
# transform, or pass logic. See AUTHORING.md for the full contract.
#
# (c) Copyright 2026 Liminal HQ, Scott Morris
# SPDX-License-Identifier: MIT

import math
import os

import bpy
import mathutils

OUT_ROOT = '/studio/out/passes'
RES = 640
Z_MAX = 2.6                 # world-height normalization range for the height pass
DEFAULT_ROTATION_DEG = 75   # building yaw; camera/sun never move instead

# --- Roles ------------------------------------------------------------------
# Every material is a ROLE: a semantic part of a building. The albedo colour
# is a working colour (the stylizer's per-scene palette owns the final look);
# the ID colour must be unique — the stylizer matches nearest-in-linear.
ROLES = {
    'wall':    {'albedo': (0.659, 0.722, 0.753), 'id': (255, 0, 0)},
    'roof':    {'albedo': (0.361, 0.102, 0.102), 'id': (0, 255, 0)},
    'chimney': {'albedo': (0.550, 0.280, 0.220), 'id': (0, 0, 255)},
    'window':  {'albedo': (0.090, 0.330, 0.420), 'id': (255, 255, 0)},
    'door':    {'albedo': (0.420, 0.290, 0.140), 'id': (0, 255, 255)},
    'knob':    {'albedo': (0.950, 0.820, 0.150), 'id': (255, 0, 255)},
    'bush':    {'albedo': (0.160, 0.320, 0.130), 'id': (255, 128, 0)},
    'walkway': {'albedo': (0.620, 0.550, 0.420), 'id': (128, 0, 255)},
    'trim':    {'albedo': (0.780, 0.740, 0.640), 'id': (255, 255, 255)},
    'mullion': {'albedo': (0.780, 0.740, 0.640), 'id': (64, 64, 64)},
    'step':    {'albedo': (0.620, 0.600, 0.550), 'id': (128, 128, 128)},
    'awning':  {'albedo': (0.600, 0.180, 0.140), 'id': (128, 255, 0)},
    'sign':    {'albedo': (0.800, 0.730, 0.500), 'id': (0, 128, 128)},
    'rail':    {'albedo': (0.540, 0.560, 0.600), 'id': (0, 128, 0)},
    'tie':     {'albedo': (0.420, 0.290, 0.160), 'id': (128, 64, 0)},
    'ballast': {'albedo': (0.550, 0.520, 0.480), 'id': (64, 0, 128)},
    'asphalt': {'albedo': (0.055, 0.060, 0.050), 'id': (0, 0, 64)},
    'kerb':    {'albedo': (0.016, 0.018, 0.014), 'id': (64, 0, 0)},
    'shoulder': {'albedo': (0.290, 0.320, 0.270), 'id': (192, 0, 192)},
    'marking': {'albedo': (0.680, 0.660, 0.550), 'id': (192, 192, 192)},
    'wire':    {'albedo': (0.014, 0.016, 0.014), 'id': (0, 192, 192)},
}

registry = []  # (material, role)


def role_material(role):
    mat = bpy.data.materials.new(role)
    mat.use_nodes = True
    registry.append((mat, role))
    return mat


def _clear_nodes(mat):
    mat.node_tree.nodes.clear()
    return mat.node_tree.nodes, mat.node_tree.links


def set_diffuse(mat, rgb):
    nodes, links = _clear_nodes(mat)
    bsdf = nodes.new('ShaderNodeBsdfDiffuse')
    bsdf.inputs['Color'].default_value = (*rgb, 1)
    bsdf.inputs['Roughness'].default_value = 1.0
    out = nodes.new('ShaderNodeOutputMaterial')
    links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])


def set_emission(mat, rgb):
    nodes, links = _clear_nodes(mat)
    emit = nodes.new('ShaderNodeEmission')
    emit.inputs['Color'].default_value = (*rgb, 1)
    out = nodes.new('ShaderNodeOutputMaterial')
    links.new(emit.outputs['Emission'], out.inputs['Surface'])


def set_height_emission(mat):
    """Emission = world Z mapped to 0..1 greyscale — the height-contour pass.
    World-horizontal surface patterns (siding, shingle courses, brick rows)
    are contour lines of this pass, so the stylizer can draw them respecting
    the camera angle without any 3D texturing."""
    nodes, links = _clear_nodes(mat)
    geo = nodes.new('ShaderNodeNewGeometry')
    sep = nodes.new('ShaderNodeSeparateXYZ')
    map_range = nodes.new('ShaderNodeMapRange')
    map_range.inputs['From Min'].default_value = 0.0
    map_range.inputs['From Max'].default_value = Z_MAX
    emit = nodes.new('ShaderNodeEmission')
    out = nodes.new('ShaderNodeOutputMaterial')
    links.new(geo.outputs['Position'], sep.inputs['Vector'])
    links.new(sep.outputs['Z'], map_range.inputs['Value'])
    links.new(map_range.outputs['Result'], emit.inputs['Color'])
    links.new(emit.outputs['Emission'], out.inputs['Surface'])


# --- Geometry helpers for scenes -------------------------------------------
def box(mats, role, location, scale, rotation=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.scale = scale
    if rotation is not None:
        obj.rotation_euler = rotation
    obj.data.materials.append(mats[role])
    return obj


def face_box(mats, role, face_x, y, z, sy, sz, proud, thick=0.01):
    """Thin box mounted on a +X-facing wall plane at face_x, `proud` units out."""
    return box(mats, role, (face_x + proud, y, z), (thick, sy, sz))


def look_at(obj, target):
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()


# --- Driver -----------------------------------------------------------------
def run(scene_name, scene_module):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()
    registry.clear()

    mats = {role: role_material(role) for role in ROLES}
    scene_module.build(mats)

    # Rotate the building; camera and sun stay fixed (studio invariants).
    rotation = getattr(scene_module, 'ROTATION_DEG', DEFAULT_ROTATION_DEG)
    bpy.ops.object.empty_add(type='PLAIN_AXES', location=(0, 0, 0))
    pivot = bpy.context.object
    for obj in [o for o in bpy.data.objects if o.type == 'MESH']:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = pivot
    pivot.select_set(True)
    bpy.ops.object.parent_set(type='OBJECT', keep_transform=True)
    pivot.rotation_euler[2] = math.radians(rotation)

    # Camera: fixed 2:1 dimetric for buildings, straight-down orthographic for
    # ground tiles (TOP_DOWN scenes — roads/rails/terrain must tile
    # edge-to-edge with the existing top-down road textures). Both share
    # ortho_scale 4.0, so 1 art cell ≈ 0.08 world units in either mode.
    if getattr(scene_module, 'TOP_DOWN', False):
        # Explicit identity rotation: a camera at rest looks straight down -Z
        # with +Y at the image top (north-up). look_at is degenerate here (the
        # view direction is parallel to world Z, so the up hint collapses and
        # the yaw comes out arbitrary — this flipped the first corner tiles).
        bpy.ops.object.camera_add(location=(0, 0, 9), rotation=(0, 0, 0))
        cam = bpy.context.object
        cam.data.type = 'ORTHO'
        cam.data.ortho_scale = 4.0
    else:
        dist = 9
        elevation = math.atan(0.5)
        azimuth = math.radians(45)
        cam_pos = mathutils.Vector((
            dist * math.cos(elevation) * math.cos(azimuth),
            dist * math.cos(elevation) * math.sin(azimuth),
            dist * math.sin(elevation),
        ))
        bpy.ops.object.camera_add(location=cam_pos)
        cam = bpy.context.object
        cam.data.type = 'ORTHO'
        cam.data.ortho_scale = 4.0
        look_at(cam, mathutils.Vector((0, 0, getattr(scene_module, 'FOCUS_Z', 0.9))))
    bpy.context.scene.camera = cam

    # Sun: fixed world direction, plus a modest ambient floor so shadow faces
    # keep recoverable (non-zero) lighting for the stylizer to quantize.
    # Azimuth ~110° / elevation ~60° — from the screen's upper-left, so with
    # the standard 75° building yaw the front (gable/storefront) face is lit,
    # the long side wall falls into true shadow, and camera-facing roof
    # slopes catch partial light: three distinct bands on every building.
    # (The old position at azimuth ~214° lit only faces pointing AWAY from
    # the camera — every visible face sat in ambient, hence flat walls.)
    bpy.ops.object.light_add(type='SUN', location=(-1.9, 5.3, 10))
    sun = bpy.context.object
    sun.data.energy = 3.2
    sun.data.angle = math.radians(4)
    look_at(sun, mathutils.Vector((0, 0, 0)))

    world = bpy.context.scene.world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    bg.inputs[0].default_value = (1.0, 1.0, 1.0, 1)
    bg.inputs[1].default_value = 0.14

    # Render setup: raw colours, no tone-mapping — the stylizer owns the look.
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.render.resolution_x = RES
    scene.render.resolution_y = RES
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.view_settings.view_transform = 'Standard'

    out_dir = f'{OUT_ROOT}/{scene_name}'
    os.makedirs(out_dir, exist_ok=True)

    def render(path):
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)

    # Pass 1 — shaded (real light, denoised).
    for mat, role in registry:
        set_diffuse(mat, ROLES[role]['albedo'])
    scene.cycles.samples = 96
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = 'OPENIMAGEDENOISE'
    bpy.context.view_layer.cycles.use_denoising = True
    render(f'{out_dir}/shaded.png')

    # Passes 2-4 — flat data passes (1 sample, near-box filter).
    scene.cycles.samples = 1
    scene.cycles.use_denoising = False
    bpy.context.view_layer.cycles.use_denoising = False
    scene.render.filter_size = 0.01

    for mat, role in registry:
        set_emission(mat, ROLES[role]['albedo'])
    render(f'{out_dir}/albedo.png')

    # ID colours are defined as sRGB bytes; emission values are linear and the
    # PNG encoder applies the sRGB transfer curve on save. Emitting the
    # linear-decoded value makes the saved byte exactly equal the defined ID
    # byte, so the stylizer's nearest-match is exact. (Emitting byte/255
    # directly shifted mid-range channels — 64, 128 — enough to misclassify
    # roles: asphalt matched ballast, kerb matched tie.)
    def srgb_to_linear(b):
        c = b / 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    for mat, role in registry:
        r, g, b = ROLES[role]['id']
        set_emission(mat, (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b)))
    render(f'{out_dir}/id.png')

    for mat, role in registry:
        set_height_emission(mat)
    render(f'{out_dir}/height.png')

    print('PASSES_OK')
