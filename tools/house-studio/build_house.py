import bmesh
import bpy
import math
import mathutils

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# --- Tunable proportions (iterating against res-house-2.png measurements) --
WALL_W, WALL_D, WALL_H = 2.0, 1.6, 1.05   # was 1.6 -- reference reads roof-dominant, squat
ROOF_H = 1.15                              # was 1.0; 1.35 read roof-heavy vs reference
# Object-visibility sweep of the reference (classifying every art-pixel cell)
# revealed this is a GABLE-END composition, not two slope faces: the ridge
# runs along X, so the camera sees one roof SLOPE (the +Y face) and one
# GABLE END (the +X face -- a small roof triangle over a plain full-height
# wall). Window+door belong on the gable end, which structurally has almost
# no roof over it -- that's the "front of the house doesn't have a roof"
# observation. Eaves (slope side) overhang more; gable rake (door side)
# overhangs only a little.
ROOF_OVERHANG_EAVE = 0.075   # Y -- the roof-slope face's eave (was 0.15,
# halved per feedback). Extended back out now that the rake overhang
# (below) exists -- testing whether the earlier gable-corner notch is still
# a problem now that there's open air
# past the gable end instead of a flush wall corner right at the roof edge.
ROOF_OVERHANG_RAKE = 0.15    # X -- overhang along the ridge direction, past
# the gable ends. Since the slope's pitch only depends on Y (not X), this
# extends the roof plane without touching its angle at all, and since
# nothing needs to meet it out there (open air past the wall corner, not
# visible from this camera's elevation), it doesn't reintroduce the
# notch/seam problems the Y-direction eave overhang caused.
WIN_W, WIN_H = 0.42, 0.42                  # smaller per feedback -- was 0.55/0.55
DOOR_W, DOOR_H = 0.4, 0.62
CHIM_SIZE, CHIM_H = 0.24, 0.75             # taller -- reference chimney clears the ridge noticeably
# Reference has window+door CLUSTERED and VERTICALLY STACKED (window
# directly above the door) on the gable-end wall.
FEATURE_Y = 0.0  # centred on the gable-end (X) face's depth axis


def look_at(obj, target):
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()


# --- Toon/cel shading -------------------------------------------------------
# The thing separating our output from genuine hand-drawn pixel art isn't
# grid size or line weight -- it's that Principled BSDF gives every face a
# smooth, continuous, physically-lit gradient, and posterizing that after
# the fact just puts visible *bands* into a gradient that's still shaped
# like a gradient. A pixel artist doesn't do that: they pick 2 (sometimes 3)
# flat tones per face directly -- "this face is lit, this face is in
# shadow" -- with a hard edge between them, no falloff.
#
# The first version of this used Diffuse BSDF -> ShaderNodeShaderToRGB to
# get that lighting response and quantize it. That turned out to be
# unreliable: sampling the raw ShaderToRGB output directly showed an EXACT
# constant (206, 206, 206) on the wall, roof, chimney, AND the bush all at
# once -- not a real per-surface lighting evaluation, a fallback value.
# It's a known Cycles reliability gap (see e.g. the Blender manual's own
# notes on ShaderToRGB's limited support across render paths), and it only
# went unnoticed because the wall-to-wall "contrast" everyone was reading as
# toon shading was actually just each face's own siding/shingle band colour
# -- there was never any real light/shadow split happening.
#
# The robust alternative (what most Cycles NPR/toon setups actually use):
# skip ShaderToRGB and compute N.L directly with plain vector math against a
# fixed light-direction constant (matching the key sun below). Deterministic,
# no path-tracing-dependent node involved.
_KEY_LIGHT_DIR = (-0.557, -0.371, 0.743)  # normalized, points FROM origin
# TOWARD the key sun at (-6,-4,8) -- keep in sync if that light ever moves.


def _toon_lighting(nodes, links):
    geometry = nodes.new('ShaderNodeNewGeometry')
    light_vec = nodes.new('ShaderNodeCombineXYZ')
    light_vec.inputs['X'].default_value = _KEY_LIGHT_DIR[0]
    light_vec.inputs['Y'].default_value = _KEY_LIGHT_DIR[1]
    light_vec.inputs['Z'].default_value = _KEY_LIGHT_DIR[2]
    dot = nodes.new('ShaderNodeVectorMath')
    dot.operation = 'DOT_PRODUCT'
    links.new(geometry.outputs['Normal'], dot.inputs[0])
    links.new(light_vec.outputs['Vector'], dot.inputs[1])
    # Dot product is -1..1 (facing away..facing toward the light); remap to
    # 0..1 so the ramp's 0..1 position convention lines up with it, with the
    # shadow/lit split landing exactly at "perpendicular to the light".
    remap = nodes.new('ShaderNodeMath')
    remap.operation = 'MULTIPLY_ADD'
    remap.inputs[1].default_value = 0.5
    remap.inputs[2].default_value = 0.5
    links.new(dot.outputs['Value'], remap.inputs[0])
    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'CONSTANT'
    shadow, lit = ramp.color_ramp.elements
    shadow.position = 0.5
    shadow.color = (0.6, 0.6, 0.6, 1)
    lit.position = 0.501
    lit.color = (1.0, 1.0, 1.0, 1)
    links.new(remap.outputs['Value'], ramp.inputs['Fac'])
    return ramp.outputs['Color']


def _finish_toon(mat, nodes, links, color_socket):
    lighting = _toon_lighting(nodes, links)
    mix = nodes.new('ShaderNodeMixRGB')
    mix.blend_type = 'MULTIPLY'
    mix.inputs['Fac'].default_value = 1.0
    links.new(color_socket, mix.inputs['Color1'])
    links.new(lighting, mix.inputs['Color2'])
    emission = nodes.new('ShaderNodeEmission')
    links.new(mix.outputs['Color'], emission.inputs['Color'])
    output = nodes.new('ShaderNodeOutputMaterial')
    links.new(emission.outputs['Emission'], output.inputs['Surface'])


def flat_material(name, rgb, roughness=0.85, specular=0.15):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    color = nodes.new('ShaderNodeRGB')
    color.outputs[0].default_value = (*rgb, 1)
    _finish_toon(mat, nodes, links, color.outputs[0])
    return mat


def siding_material(name, base_rgb, band_scale=1.3, band_contrast=0.17):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    tex_coord = nodes.new('ShaderNodeTexCoord')
    wave = nodes.new('ShaderNodeTexWave')
    wave.wave_type = 'BANDS'
    wave.bands_direction = 'Z'
    wave.inputs['Scale'].default_value = band_scale
    ramp = nodes.new('ShaderNodeValToRGB')
    # LINEAR (soft) transition, not CONSTANT -- at this low a band_scale (wide
    # slats), a hard step reads as one bold black seam line rather than a
    # plank groove. A wider, softer transition avoids that crease look while
    # keeping the bands clearly visible.
    ramp.color_ramp.interpolation = 'LINEAR'
    lo, hi = ramp.color_ramp.elements
    lo.position = 0.35
    hi.position = 0.65
    lo.color = (*[max(0, c - band_contrast) for c in base_rgb], 1)
    hi.color = (*[min(1, c + band_contrast * 0.4) for c in base_rgb], 1)
    links.new(tex_coord.outputs['Object'], wave.inputs['Vector'])
    links.new(wave.outputs['Color'], ramp.inputs['Fac'])
    _finish_toon(mat, nodes, links, ramp.outputs['Color'])
    return mat


def shingle_material(name, base_rgb, row_scale=3.2, contrast=0.08):
    """Roof shingle rows: a low-frequency band texture along the slope (UV V),
    matching the siding technique's approach. A brick/checker pattern here
    aliased into pure static once point-sampled down to the sprite grid --
    shingle rows at a wave period wide enough to survive downsampling read as
    deliberate coursing instead of noise."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    tex_coord = nodes.new('ShaderNodeTexCoord')
    wave = nodes.new('ShaderNodeTexWave')
    wave.wave_type = 'BANDS'
    wave.bands_direction = 'Y'
    wave.inputs['Scale'].default_value = row_scale
    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'CONSTANT'
    lo, hi = ramp.color_ramp.elements
    lo.position = 0.46
    hi.position = 0.54
    lo.color = (*[max(0, c - contrast) for c in base_rgb], 1)
    hi.color = (*[min(1, c + contrast * 0.4) for c in base_rgb], 1)
    links.new(tex_coord.outputs['UV'], wave.inputs['Vector'])
    links.new(wave.outputs['Color'], ramp.inputs['Fac'])
    _finish_toon(mat, nodes, links, ramp.outputs['Color'])
    return mat


# --- Wall box -------------------------------------------------------------
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, WALL_H / 2))
wall = bpy.context.object
wall.scale = (WALL_W, WALL_D, WALL_H)
wall.data.materials.append(siding_material("wall_siding", (0.659, 0.722, 0.753)))

# The box's own top face is never seen (it's capped by the roof/gable-cap
# geometry above) but it still shares its boundary edge with the gable
# cap's base edge once everything is welded together below -- that makes a
# 3-face non-manifold junction there (box END face + box TOP face + gable
# cap), and Freestyle flags that as a crease regardless of the dihedral
# angle being flat. Deleting the redundant top face leaves a clean 2-face
# edge (END face + gable cap) with no seam.
bm = bmesh.new()
bm.from_mesh(wall.data)
bm.faces.ensure_lookup_table()
top_faces = [f for f in bm.faces if f.normal.z > 0.9]
bmesh.ops.delete(bm, geom=top_faces, context='FACES')
bm.to_mesh(wall.data)
bm.free()

# --- Gable roof -------------------------------------------------------------
# Gable ends (X faces) get NO roof overhang and NO roof surface at all -- per
# the reference, those two walls are flat siding all the way to the ridge,
# with the roof only pitched on the Y (eave) sides. The roof mesh only
# contains the two slope quads (no triangular end-caps) with a separate
# wall-material triangle (below) filling the gable peak instead. rx is flush
# with the wall/gable-cap plane -- the two slope quads' open side edges are
# welded directly onto the gable caps below, instead of the earlier approach
# of recessing the roof to hide the gap, which left its far edge visibly
# poking out past the wall silhouette from this camera angle.
rx = WALL_W / 2 + ROOF_OVERHANG_RAKE
base_z = WALL_H

# Eave overhang extends the rafter length along the SAME slope line, not
# sideways at a constant height -- a real rafter tail drops lower as it
# extends past the wall, it doesn't flatten the pitch. Using the wall's own
# half-depth/ROOF_H as the pitch reference means the extended edge stays on
# the exact same line the gable cap's rake edge already follows, which also
# means the roof surface and the gable cap meet with no gap.
half_depth = WALL_D / 2
pitch = ROOF_H / half_depth
ry = half_depth + ROOF_OVERHANG_EAVE
eave_z = base_z - pitch * ROOF_OVERHANG_EAVE

# Nudged fractionally above its true slope-plane position (thickness added
# only at the ridge, tapering to zero at the eave edge) so it sits proud of
# the gable cap instead of exactly coincident with it -- coincident coplanar
# surfaces z-fight, which was letting the wall's black outline flicker
# through the roof texture.
ROOF_PROUD = 0.015
verts = [
    (-rx, -ry, eave_z), (rx, -ry, eave_z),
    (rx, ry, eave_z), (-rx, ry, eave_z),
    (-rx, 0, base_z + ROOF_H + ROOF_PROUD),
    (rx, 0, base_z + ROOF_H + ROOF_PROUD),
]
faces = [(0, 1, 5, 4), (2, 3, 4, 5)]
roof_mesh = bpy.data.meshes.new("roof_mesh")
roof_mesh.from_pydata(verts, [], faces)
roof_mesh.update()
roof_obj = bpy.data.objects.new("roof", roof_mesh)
bpy.context.collection.objects.link(roof_obj)
roof_obj.data.materials.append(shingle_material("roof_shingles", (0.361, 0.102, 0.102)))

# Smart-UV-unwrap so each roof slope face gets its own well-behaved planar UV
# space instead of sharing one raw object-space coordinate, which streaked
# badly across the two differently-angled faces. Done before the join below
# so it only touches the roof's own faces, not the wall/gable-cap ones.
bpy.context.view_layer.objects.active = roof_obj
roof_obj.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(66))
bpy.ops.object.mode_set(mode='OBJECT')
roof_obj.select_set(False)

# --- Gable-end wall caps: flat siding triangles filling the peak on both X
# ends, flush with the wall's own end face (not proud) so this is what makes
# the door/window face (and its opposite) "flat surfaces all the way to the
# top" instead of showing a roof-coloured triangle. Flush placement means
# the cap's base edge is exactly coincident with the wall box's top-end
# edge; joining + welding them below turns that into a real shared edge
# instead of two separate open mesh boundaries, which is what was causing
# Freestyle to outline a stray seam line across the gable wall.
gable_caps = []
for sign in (1, -1):
    gx = sign * (WALL_W / 2)
    gverts = [
        (gx, -WALL_D / 2, base_z), (gx, WALL_D / 2, base_z), (gx, 0, base_z + ROOF_H),
    ]
    gfaces = [(0, 1, 2)]
    gmesh = bpy.data.meshes.new(f"gable_cap_mesh_{sign}")
    gmesh.from_pydata(gverts, [], gfaces)
    gmesh.update()
    gcap = bpy.data.objects.new(f"gable_cap_{sign}", gmesh)
    bpy.context.collection.objects.link(gcap)
    gcap.data.materials.append(wall.data.materials[0])
    gable_caps.append(gcap)

# NOTE: earlier there was a "soffit return" patch here (a flat wall-material
# triangle bridging the roof's overhung base corner back to the wall
# corner) meant to close the small notch left by the eave overhang sticking
# out past the flush gable end. Real houses with this combination (overhung
# eave, flush gable) do have a small triangular return there -- but it's
# framed as part of the ROOF/fascia, thin, following the roof's own plane.
# A flat vertical panel in the WALL's plane is architecturally the wrong
# shape: after the building rotation it extends in the direction that reads
# as extra width in almost every camera angle (confirmed via a straight
# front-elevation render -- the wall silhouette was visibly wider than the
# actual box). Removed. Instead ROOF_OVERHANG_EAVE below is kept small
# enough that the leftover notch is a minor, unfilled detail rather than
# something that needs bridging geometry at all.

# Weld the wall box, both gable caps, AND the roof into one seamless mesh --
# separate objects with touching-but-disconnected edges each count as an
# open boundary, which Freestyle's border-line detection outlines
# individually (this is what made the roof look detached/"flying" off the
# gable end -- its open side edge had nothing welded to it).
bpy.ops.object.select_all(action='DESELECT')
for obj in (*gable_caps, roof_obj, wall):
    obj.select_set(True)
bpy.context.view_layer.objects.active = wall
bpy.ops.object.join()
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.remove_doubles(threshold=0.001)
bpy.ops.object.mode_set(mode='OBJECT')

# --- Chimney, seated on the front slope ------------------------------------
chim_x, chim_y = -rx * 0.42, -ry * 0.5
slope_t = (chim_y - (-ry)) / (0 - (-ry))
chim_base_z = base_z + slope_t * ROOF_H
bpy.ops.mesh.primitive_cube_add(size=1, location=(chim_x, chim_y, chim_base_z + CHIM_H / 2 - 0.06))
chimney = bpy.context.object
chimney.scale = (CHIM_SIZE, CHIM_SIZE, CHIM_H)
chimney.data.materials.append(flat_material("chimney", (0.55, 0.28, 0.22)))

# --- Window + door on the +X GABLE-END wall face, vertically stacked -------
# (window directly above the door, per the object-visibility sweep) --------
win_z = WALL_H + 0.15  # moved up into the gable peak now that the roof-edge artifact above it is gone
bpy.ops.mesh.primitive_cube_add(size=1, location=(WALL_W / 2 + 0.02, FEATURE_Y, win_z))
window = bpy.context.object
window.scale = (0.03, WIN_W, WIN_H)
window.data.materials.append(flat_material("window", (0.09, 0.33, 0.42), roughness=0.15))
bpy.ops.mesh.primitive_cube_add(size=1, location=(WALL_W / 2 + 0.015, FEATURE_Y, win_z))
window_frame = bpy.context.object
window_frame.scale = (0.02, WIN_W + 0.06, WIN_H + 0.06)
window_frame.data.materials.append(flat_material("window_frame", (0.05, 0.05, 0.05)))

door_z = DOOR_H / 2
bpy.ops.mesh.primitive_cube_add(size=1, location=(WALL_W / 2 + 0.02, FEATURE_Y, door_z))
door = bpy.context.object
door.scale = (0.03, DOOR_W, DOOR_H)
door.data.materials.append(flat_material("door", (0.42, 0.29, 0.14)))
bpy.ops.mesh.primitive_cube_add(size=1, location=(WALL_W / 2 + 0.03, FEATURE_Y + DOOR_W / 2 - 0.05, DOOR_H * 0.5))
knob = bpy.context.object
knob.scale = (0.03, 0.05, 0.05)  # was 0.02/0.03/0.03 -- too small to show its
# own fill colour, the black outline swallowed the whole thing
knob.data.materials.append(flat_material("knob", (0.95, 0.82, 0.15), roughness=0.2))

# --- Bush: a small rounded shrub at the corner where the two walls meet,
# not in front of the door (reference has it at the wall junction). Centring
# the door/window freed up room to make this wider than before.
bush_x, bush_y = WALL_W / 2 + 0.18, -WALL_D / 2 - 0.06
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.36, location=(bush_x, bush_y, 0.22))
bush = bpy.context.object
bush.scale = (1.0, 1.0, 0.8)
bush.data.materials.append(flat_material("bush", (0.16, 0.32, 0.13), roughness=0.95, specular=0.05))

# --- Walkway: a flat ground-texture patch leading away from the door, not
# stacked-stone geometry -- reads as a distinct dirt/path colour on the
# ground plane, matching the reference's solid tan patch at the threshold.
# Narrowed to the door's own width and lengthened a bit so it reads as a
# straight sidewalk instead of a wide patio patch.
WALKWAY_LEN, WALKWAY_W = 0.8, DOOR_W
bpy.ops.mesh.primitive_cube_add(size=1, location=(WALL_W / 2 + WALKWAY_LEN / 2, FEATURE_Y, 0.008))
walkway = bpy.context.object
walkway.scale = (WALKWAY_LEN, WALKWAY_W, 0.016)
walkway.data.materials.append(flat_material("walkway", (0.62, 0.55, 0.42), roughness=0.95, specular=0.05))

# --- Rotate the whole building around Z (camera/lights stay fixed) --------
# Orientation was off by 90deg vs the reference -- parent everything built so
# far to an empty and turn the empty, rather than re-deriving every object's
# X/Y coordinates by hand.
BUILDING_ROTATION_DEG = 75  # 90 (the corner view showing the door/window
# gable) - a 15deg nudge the other way this time.
bpy.ops.object.empty_add(type='PLAIN_AXES', location=(0, 0, 0))
pivot = bpy.context.object
pivot.name = "building_pivot"
built_so_far = [o for o in bpy.data.objects if o.type == 'MESH']
for obj in built_so_far:
    obj.select_set(True)
bpy.context.view_layer.objects.active = pivot
pivot.select_set(True)
bpy.ops.object.parent_set(type='OBJECT', keep_transform=True)
pivot.rotation_euler[2] = math.radians(BUILDING_ROTATION_DEG)

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
cam.data.ortho_scale = 4.0
look_at(cam, mathutils.Vector((0, 0, (WALL_H + ROOF_H) * 0.42)))
bpy.context.scene.camera = cam

# --- Lighting ---------------------------------------------------------------
# The toon materials quantize a Diffuse BSDF's lighting response into a hard
# 2-band light/shadow step -- that only reads as deliberate cel-shading if
# there's real directional contrast to quantize. A strong fill light and
# bright ambient (useful before, to avoid pure-black shadows in a PBR
# render) would just push every face's diffuse value above the threshold
# uniformly, killing the light/shadow split entirely. Key light stays
# strong and directional; fill and ambient are cut way down -- just enough
# that shadow-side faces aren't going through pure-black territory before
# the ramp quantizes them, not enough to erase the split.
bpy.ops.object.light_add(type='SUN', location=(-6, -4, 8))
sun = bpy.context.object
sun.data.energy = 3.4
sun.data.angle = math.radians(4)
look_at(sun, mathutils.Vector((0, 0, 0)))

bpy.ops.object.light_add(type='SUN', location=(6, 6, 4))
fill = bpy.context.object
fill.data.energy = 0.25
fill.data.angle = math.radians(20)
look_at(fill, mathutils.Vector((0, 0, 0)))

world = bpy.context.scene.world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
bg.inputs[0].default_value = (0.4, 0.43, 0.47, 1)
bg.inputs[1].default_value = 0.15

# --- Render -----------------------------------------------------------------
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 128
scene.cycles.use_denoising = True
scene.cycles.denoiser = 'OPENIMAGEDENOISE'
view_layer_denoise = bpy.context.view_layer
view_layer_denoise.cycles.use_denoising = True
scene.render.resolution_x = 640
scene.render.resolution_y = 640
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = '/out/house.png'

# Freestyle: real silhouette + crease-line edges, matching the reference's
# crisp black cel-shaded outlines instead of pure photographic shading.
scene.render.use_freestyle = True
view_layer = bpy.context.view_layer
view_layer.use_freestyle = True
lineset = view_layer.freestyle_settings.linesets[0]
lineset.linestyle.color = (0.0, 0.0, 0.0)
lineset.linestyle.thickness = 9.0
lineset.select_silhouette = True
lineset.select_crease = True
lineset.select_border = True
lineset.select_edge_mark = False

bpy.ops.render.render(write_still=True)
print("RENDER_OK")
