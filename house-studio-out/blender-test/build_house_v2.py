import bpy
import bmesh
import math
import mathutils

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()


def make_material(name, rgb, roughness=0.9):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    return mat


def look_at(obj, target):
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()


# --- Wall box -----------------------------------------------------------
WALL_W, WALL_D, WALL_H = 2.0, 1.6, 1.6
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, WALL_H / 2))
wall = bpy.context.object
wall.scale = (WALL_W, WALL_D, WALL_H)
wall.data.materials.append(make_material("wall", (0.82, 0.82, 0.80)))

# --- Gable roof: 6 verts (4 base corners + 2 ridge points), ridge runs
# along X, peaking at y=0. Two rectangular slope faces + two triangular
# gable-end faces. This is a real 3D primitive, not a hand-faked silhouette.
ROOF_OVERHANG = 0.18
ROOF_H = 1.0
rx = WALL_W / 2 + ROOF_OVERHANG
ry = WALL_D / 2 + ROOF_OVERHANG
base_z = WALL_H

verts = [
    (-rx, -ry, base_z), (rx, -ry, base_z),  # front base corners
    (rx, ry, base_z), (-rx, ry, base_z),    # back base corners
    (-rx, 0, base_z + ROOF_H),              # ridge left
    (rx, 0, base_z + ROOF_H),               # ridge right
]
faces = [
    (0, 1, 5, 4),  # front slope
    (2, 3, 4, 5),  # back slope
    (1, 2, 5),     # right gable end (triangle)
    (3, 0, 4),     # left gable end (triangle)
]
roof_mesh = bpy.data.meshes.new("roof_mesh")
roof_mesh.from_pydata(verts, [], faces)
roof_mesh.update()
roof_obj = bpy.data.objects.new("roof", roof_mesh)
bpy.context.collection.objects.link(roof_obj)
roof_obj.data.materials.append(make_material("roof", (0.55, 0.13, 0.13)))

# --- Chimney: seated on the FRONT slope surface, not floating -----------
# Front slope goes from z=base_z at y=-ry to z=base_z+ROOF_H at y=0.
chim_x, chim_y = -rx * 0.45, -ry * 0.55
slope_t = (chim_y - (-ry)) / (0 - (-ry))  # 0 at eave, 1 at ridge
chim_base_z = base_z + slope_t * ROOF_H
CHIM_SIZE, CHIM_H = 0.22, 0.55
bpy.ops.mesh.primitive_cube_add(size=1, location=(chim_x, chim_y, chim_base_z + CHIM_H / 2 - 0.05))
chimney = bpy.context.object
chimney.scale = (CHIM_SIZE, CHIM_SIZE, CHIM_H)
chimney.data.materials.append(make_material("chimney", (0.55, 0.28, 0.22)))

# --- Camera: classic 2:1 dimetric angle (arctan(0.5) ≈ 26.565°), 45° azimuth.
DIST = 9
elevation = math.atan(0.5)
azimuth = math.radians(45)
cam_pos = mathutils.Vector((
    DIST * math.cos(elevation) * math.cos(azimuth),
    DIST * math.cos(elevation) * math.sin(azimuth),
    DIST * math.sin(elevation),
))
bpy.ops.object.camera_add(location=cam_pos)
cam = bpy.context.object
cam.data.type = 'ORTHO'
cam.data.ortho_scale = 4.2
look_at(cam, mathutils.Vector((0, 0, WALL_H * 0.6)))
bpy.context.scene.camera = cam

# --- Sun lamp: classic upper-left light for consistent isometric shading.
bpy.ops.object.light_add(type='SUN', location=(-6, -4, 8))
sun = bpy.context.object
sun.data.energy = 2.4
sun.data.angle = math.radians(3)
look_at(sun, mathutils.Vector((0, 0, 0)))

# --- Render ---------------------------------------------------------------
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 64
scene.render.resolution_x = 640
scene.render.resolution_y = 640
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = '/out/house_v2.png'

bpy.ops.render.render(write_still=True)
print("RENDER_OK")
