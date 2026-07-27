#!/usr/bin/env python3
"""Pixelate a Blender render and composite it onto the game's real grass
texture, reusing the same point-sample grass technique as the park/house-2D
pipeline (app/scripts/build-park-assets.mjs), so the 3D-rendered house slots
into the existing asset conventions instead of introducing a new look.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps
import random
import sys

SRC = sys.argv[1]
OUT = sys.argv[2]
PIXEL_GRID = int(sys.argv[3]) if len(sys.argv) > 3 else 60  # art-pixels across
FINAL_PX = 160  # matches the game's 1x1 building sprite convention
GRASS_PATH = Path(__file__).resolve().parents[2] / "app/public/assets/tiles/terrain/grass.png"
random.seed(1)  # deterministic lawn jitter across re-runs

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

# Oval proportions, matching the existing building sprite convention
# (res-house-*, school-*, park-*) -- measured off res-house-2.png (oval
# spans ~x10-149, centred y~130, ry~20 of a 160 canvas).
oval_cx, oval_cy, oval_rx, oval_ry = FINAL_PX * 0.5, FINAL_PX * 0.865, FINAL_PX * 0.4, FINAL_PX * 0.09

# Shrink so the house's own width stays inside the oval's width (measured
# off res-house-2.png: house ~125px vs oval ~128px of a 160px canvas) --
# a higher scale has the house overshooting past the oval on both sides.
HOUSE_SCALE = 0.93
scaled_side = int(FINAL_PX * HOUSE_SCALE)
house_scaled = pixelated_full.resize((scaled_side, scaled_side), Image.NEAREST)
pixelated = Image.new('RGBA', (FINAL_PX, FINAL_PX), (0, 0, 0, 0))
offset_x = (FINAL_PX - scaled_side) // 2
# Plant the house's own bottom edge into the oval instead of a fixed offset
# -- a fixed offset leaves a gap of bare grass between the house and the
# oval once HOUSE_SCALE shrinks the house (it no longer reaches down far
# enough to actually sit on the lawn it's supposed to be standing on).
offset_y = int(oval_cy + oval_ry * 0.4 - scaled_side)
pixelated.alpha_composite(house_scaled, (offset_x, offset_y))

grass = Image.open(GRASS_PATH).convert('RGB')
gw, gh = grass.size
bg = Image.new('RGB', (FINAL_PX, FINAL_PX))
for y in range(FINAL_PX):
    for x in range(FINAL_PX):
        bg.putpixel((x, y), grass.getpixel((x * gw // FINAL_PX, y * gh // FINAL_PX)))

# Mowed-lawn fill: in the reference the oval isn't just a ring around plain
# ambient grass -- the interior is a distinct tended lawn with faint mower
# stripes, separating the kept yard from the wild dithered grass outside.
# The reference's own banding is subtle and slightly irregular (it reads as
# a lawn, not a barcode) -- low contrast between the two tones, jittered
# per-pixel, rather than flat hard-edged bands.
LAWN_LIGHT = (46, 89, 22)
LAWN_DARK = (34, 73, 17)
STRIPE_H = 6
for y in range(max(0, int(oval_cy - oval_ry - 2)), min(FINAL_PX, int(oval_cy + oval_ry + 3))):
    stripe_colour = LAWN_LIGHT if (y // STRIPE_H) % 2 == 0 else LAWN_DARK
    for x in range(max(0, int(oval_cx - oval_rx - 2)), min(FINAL_PX, int(oval_cx + oval_rx + 3))):
        if ((x - oval_cx) / oval_rx) ** 2 + ((y - oval_cy) / oval_ry) ** 2 <= 1:
            jitter = random.randint(-3, 3)
            bg.putpixel((x, y), tuple(max(0, min(255, c + jitter)) for c in stripe_colour))

# Black-outlined oval border on top of the lawn fill.
draw = ImageDraw.Draw(bg)
draw.ellipse(
    [oval_cx - oval_rx - 2, oval_cy - oval_ry - 2, oval_cx + oval_rx + 2, oval_cy + oval_ry + 2],
    outline=(10, 20, 20), width=3,
)

bg = bg.convert('RGBA')
bg.alpha_composite(pixelated)
bg.convert('RGB').save(OUT)
print(f"Wrote {OUT}")
