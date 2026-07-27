#!/usr/bin/env python3
"""Pixelate a Blender render and composite it onto a manicured lawn base."""
from PIL import Image, ImageOps
import random
import sys

SRC = sys.argv[1]
OUT = sys.argv[2]
PIXEL_GRID = int(sys.argv[3]) if len(sys.argv) > 3 else 60  # art-pixels across
FINAL_PX = 160  # matches the game's 1x1 building sprite convention
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

GROUND_Y = FINAL_PX * 0.93  # where the house's own base should sit

# Shrink so the house doesn't fill the canvas edge-to-edge.
HOUSE_SCALE = 0.93
scaled_side = int(FINAL_PX * HOUSE_SCALE)
house_scaled = pixelated_full.resize((scaled_side, scaled_side), Image.NEAREST)
pixelated = Image.new('RGBA', (FINAL_PX, FINAL_PX), (0, 0, 0, 0))
offset_x = (FINAL_PX - scaled_side) // 2
offset_y = int(GROUND_Y - scaled_side)
pixelated.alpha_composite(house_scaled, (offset_x, offset_y))

# Manicured-lawn background, no oval ring: the earlier version tiled the
# game's rough dithered grass.png and only smoothed a lawn oval on top of
# it, which read as a weird patch rather than a coherent "this is a tended
# yard" ground. Simpler and closer to what was asked for: the WHOLE canvas
# is the same low-contrast mowed-stripe fill, no ring, no separate "wild
# grass" texture to clash with it.
LAWN_LIGHT = (46, 89, 22)
LAWN_DARK = (34, 73, 17)
STRIPE_H = 6
bg = Image.new('RGB', (FINAL_PX, FINAL_PX))
for y in range(FINAL_PX):
    stripe_colour = LAWN_LIGHT if (y // STRIPE_H) % 2 == 0 else LAWN_DARK
    for x in range(FINAL_PX):
        jitter = random.randint(-3, 3)
        bg.putpixel((x, y), tuple(max(0, min(255, c + jitter)) for c in stripe_colour))

bg = bg.convert('RGBA')
bg.alpha_composite(pixelated)
bg.convert('RGB').save(OUT)
print(f"Wrote {OUT}")
