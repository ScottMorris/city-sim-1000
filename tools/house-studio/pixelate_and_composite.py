#!/usr/bin/env python3
"""Pixelate a Blender render and composite it onto the game's real grass
texture, reusing the same point-sample grass technique as the park/house-2D
pipeline (app/scripts/build-park-assets.mjs), so the 3D-rendered house slots
into the existing asset conventions instead of introducing a new look.
"""
from PIL import Image, ImageOps
import sys

SRC = sys.argv[1]
OUT = sys.argv[2]
PIXEL_GRID = int(sys.argv[3]) if len(sys.argv) > 3 else 60  # art-pixels across
FINAL_PX = 160  # matches the game's 1x1 building sprite convention

render = Image.open(SRC).convert('RGBA')

# Crop to the actual house content (plus a little padding) first, so the
# house fills the tile the way the reference sprites do -- the raw render
# canvas has a lot of empty transparent margin around it.
bbox = render.getbbox()
pad = int(max(bbox[2] - bbox[0], bbox[3] - bbox[1]) * 0.02)
crop_box = (
    max(0, bbox[0] - pad), max(0, bbox[1] - pad),
    min(render.width, bbox[2] + pad), min(render.height, bbox[3] + pad),
)
side = max(crop_box[2] - crop_box[0], crop_box[3] - crop_box[1])
cx = (crop_box[0] + crop_box[2]) // 2
cy = (crop_box[1] + crop_box[3]) // 2
square_box = (cx - side // 2, cy - side // 2, cx + side // 2, cy + side // 2)
render = render.crop(square_box)

# Point-sample (NEAREST) down to the pixel-art grid, not box-average: box
# filtering blends the black outline into its neighbours proportionally,
# which washes it down to grey instead of solid black once the grid is
# coarse enough to read as pixel art (measured directly -- BOX at 40 grid
# noticeably greys out the roofline vs. NEAREST at the same grid). NEAREST
# keeps outline pixels solid black; the tradeoff is texture noise if the
# grid is too fine relative to the render's own detail frequency. 60 is the
# sweet spot found by comparing 40/60/80 side by side: crisp solid linework
# without the higher grid's noisier micro-texture.
small = render.resize((PIXEL_GRID, PIXEL_GRID), Image.NEAREST)
r, g, b, a = small.split()
a = a.point(lambda v: 255 if v > 110 else 0)
rgb = Image.merge('RGB', (r, g, b))
rgb = ImageOps.posterize(rgb, 4)
small = Image.merge('RGBA', (*rgb.split(), a))
pixelated_full = small.resize((FINAL_PX, FINAL_PX), Image.NEAREST)

# No grass/oval/lawn compositing for now -- nixed per feedback to keep the
# pipeline focused on the house model itself while that's still in flux.
# Shrink slightly so the house doesn't fill the canvas edge-to-edge, and
# centre it, but otherwise just save the house alone on a transparent
# canvas (no ground plane, no oval).
HOUSE_SCALE = 0.9
scaled_side = int(FINAL_PX * HOUSE_SCALE)
house_scaled = pixelated_full.resize((scaled_side, scaled_side), Image.NEAREST)
pixelated = Image.new('RGBA', (FINAL_PX, FINAL_PX), (0, 0, 0, 0))
offset_x = (FINAL_PX - scaled_side) // 2
offset_y = (FINAL_PX - scaled_side) // 2
pixelated.alpha_composite(house_scaled, (offset_x, offset_y))

pixelated.save(OUT)
print(f"Wrote {OUT}")
