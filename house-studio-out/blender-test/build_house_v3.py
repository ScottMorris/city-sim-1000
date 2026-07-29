import bpy
import math
import mathutils

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()


def look_at(obj, target):
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()


def flat_material(name, rgb, roughness=0.85):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Specular"].default_value = 0.15
    return mat


def siding_material(name, base_rgb, band_scale=16, band_contrast=0.12, bump=0.06):
    """Horizontal plank-siding look: a banded wave texture drives both a
    subtle colour alternation and a bump/normal offset, so the siding reads
    as physical relief under the sun lamp, not just a flat colour."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    output = nodes.new('ShaderNodeOutputMaterial')
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    tex_coord = nodes.new('ShaderNodeTexCoord')
    wave = nodes.new('ShaderNodeTexWave')
    wave.wave_type = 'BANDS'
    wave.bands_direction = 'Z'
    wave.inputs['Scale'].default_value = band_scale
    wave.inputs['Distortion'].default_value = 0.0
    ramp = nodes.new('ShaderNodeValToRGB')
    lo, hi = ramp.color_ramp.elements
    lo.position = 0.4
    hi.position = 0.6
    lo.color = (*[max(0, c - band_contrast) for c in base_rgb], 1)
    hi.color = (*[min(1, c + band_contrast * 0.4) for c in base_rgb], 1)
    bump_node = nodes.new('ShaderNodeBump')
    bump_node.inputs['Strength'].default_value = bump
    links.new(tex_coord.outputs['Object'], wave.inputs['Vector'])
    links.new(wave.outputs['Color'], ramp.inputs['Fac'])
    links.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])
    links.new(wave.outputs['Fac'], bump_node.inputs['Height'])
    links.new(bump_node.outputs['Normal'], bsdf.inputs['Normal'])
    bsdf.inputs['Roughness'].default_value = 0.8
    bsdf.inputs['Specular'].default_value = 0.2
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
    return mat


# --- Wall box -------------------------------------------------------------
WALL_W, WALL_D, WALL_H = 2.0, 1.6, 1.6
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, WALL_H / 2))
wall = bpy.context.object
wall.scale = (WALL_W, WALL_D, WALL_H)
wall.data.materials.append(siding_material("wall_siding", (0.92, 0.93, 0.94)))

# --- Gable roof -------------------------------------------------------------
ROOF_OVERHANG = 0.18
ROOF_H = 1.0
rx = WALL_W / 2 + ROOF_OVERHANG
ry = WALL_D / 2 + ROOF_OVERHANG
base_z = WALL_H

verts = [
    (-rx, -ry, base_z), (rx, -ry, base_z),
    (rx, ry, base_z), (-rx, ry, base_z),
    (-rx, 0, base_z + ROOF_H),
    (rx, 0, base_z + ROOF_H),
]
faces = [(0, 1, 5, 4), (2, 3, 4, 5), (1, 2, 5), (3, 0, 4)]
roof_mesh = bpy.data.meshes.new("roof_mesh")
roof_mesh.from_pydata(verts, [], faces)
roof_mesh.update()
roof_obj = bpy.data.objects.new("roof", roof_mesh)
bpy.context.collection.objects.link(roof_obj)
roof_obj.data.materials.append(flat_material("roof", (0.55, 0.13, 0.13), roughness=0.6))

# --- Chimney, seated on the front slope ------------------------------------
chim_x, chim_y = -rx * 0.45, -ry * 0.55
slope_t = (chim_y - (-ry)) / (0 - (-ry))
chim_base_z = base_z + slope_t * ROOF_H
CHIM_SIZE, CHIM_H = 0.22, 0.55
bpy.ops.mesh.primitive_cube_add(size=1, location=(chim_x, chim_y, chim_base_z + CHIM_H / 2 - 0.05))
chimney = bpy.context.object
chimney.scale = (CHIM_SIZE, CHIM_SIZE, CHIM_H)
chimney.data.materials.append(flat_material("chimney", (0.55, 0.28, 0.22)))

# --- Window + door on the +Y front wall face -------------------------------
WIN_W, WIN_H = 0.4, 0.4
bpy.ops.mesh.primitive_cube_add(size=1, location=(-0.35, WALL_D / 2 + 0.02, 1.05))
window = bpy.context.object
window.scale = (WIN_W, 0.03, WIN_H)
window.data.materials.append(flat_material("window", (0.09, 0.33, 0.42), roughness=0.15))
win_frame = bpy.data.materials.new("window_frame_dummy")  # kept simple: frame via a slightly larger dark box behind
bpy.ops.mesh.primitive_cube_add(size=1, location=(-0.35, WALL_D / 2 + 0.015, 1.05))
window_frame = bpy.context.object
window_frame.scale = (WIN_W + 0.05, 0.02, WIN_H + 0.05)
window_frame.data.materials.append(flat_material("window_frame", (0.05, 0.05, 0.05)))

DOOR_W, DOOR_H = 0.34, 0.75
bpy.ops.mesh.primitive_cube_add(size=1, location=(0.45, WALL_D / 2 + 0.02, DOOR_H / 2))
door = bpy.context.object
door.scale = (DOOR_W, 0.03, DOOR_H)
door.data.materials.append(flat_material("door", (0.42, 0.29, 0.14)))
bpy.ops.mesh.primitive_cube_add(size=1, location=(0.45 + DOOR_W / 2 - 0.04, WALL_D / 2 + 0.03, DOOR_H * 0.5))
knob = bpy.context.object
knob.scale = (0.03, 0.02, 0.03)
knob.data.materials.append(flat_material("knob", (0.85, 0.68, 0.25), roughness=0.2))

# --- Camera: classic 2:1 dimetric angle ------------------------------------
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

# --- Lighting: key sun + a soft fill so shadow faces aren't pure black -----
bpy.ops.object.light_add(type='SUN', location=(-6, -4, 8))
sun = bpy.context.object
sun.data.energy = 2.6
sun.data.angle = math.radians(4)
look_at(sun, mathutils.Vector((0, 0, 0)))

bpy.ops.object.light_add(type='SUN', location=(6, 6, 4))
fill = bpy.context.object
fill.data.energy = 0.6
fill.data.angle = math.radians(20)
look_at(fill, mathutils.Vector((0, 0, 0)))

world = bpy.context.scene.world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
bg.inputs[0].default_value = (0.35, 0.38, 0.42, 1)
bg.inputs[1].default_value = 0.5

# --- Render -----------------------------------------------------------------
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 96
scene.render.resolution_x = 640
scene.render.resolution_y = 640
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = '/out/house_v3.png'

bpy.ops.render.render(write_still=True)
print("RENDER_OK")
