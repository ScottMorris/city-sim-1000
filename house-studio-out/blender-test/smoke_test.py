import bpy
import math

# Clear default scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# A simple box + "roof" (a scaled cube on top) to sanity-check a fixed
# orthographic isometric camera and a sun lamp render correctly headless.
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 1))
wall = bpy.context.object
wall.scale = (1, 1, 1)

bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=1.6, depth=1.2, location=(0, 0, 2.6))
roof = bpy.context.object
roof.rotation_euler[2] = math.radians(45)

bpy.ops.mesh.primitive_cube_add(size=0.3, location=(0.6, -0.6, 3.2))
chimney = bpy.context.object

# Materials so we can see the two faces are actually distinct surfaces.
mat_wall = bpy.data.materials.new("wall")
mat_wall.diffuse_color = (0.9, 0.9, 0.85, 1)
wall.data.materials.append(mat_wall)

mat_roof = bpy.data.materials.new("roof")
mat_roof.diffuse_color = (0.55, 0.15, 0.15, 1)
roof.data.materials.append(mat_roof)

# Orthographic camera at a classic dimetric-ish angle.
bpy.ops.object.camera_add(location=(8, -8, 6))
cam = bpy.context.object
cam.data.type = 'ORTHO'
cam.data.ortho_scale = 6
direction = (0, 0, 1)
cam.rotation_euler = (math.radians(60), 0, math.radians(45))
bpy.context.scene.camera = cam

# Sun lamp for real shadows.
bpy.ops.object.light_add(type='SUN', location=(5, -5, 10))
sun = bpy.context.object
sun.data.energy = 3
sun.rotation_euler = (math.radians(50), 0, math.radians(30))

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.render.resolution_x = 320
scene.render.resolution_y = 320
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = '/out/smoke_test.png'

bpy.ops.render.render(write_still=True)
print("RENDER_OK")
