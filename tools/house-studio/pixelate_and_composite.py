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

# Manicured-lawn background: keep the game's existing patch/checker grass
# convention (same block-grid look as grass.png), just far more uniform --
# mostly one flat colour, with only the occasional patch a different shade,
# instead of grass.png's dense every-block-differs noise. No mow stripes
# (that read as a totally different pattern, not what was asked for) and no
# oval ring.
LAWN_BASE = (40, 80, 19)
LAWN_VARIANTS = [(46, 89, 22), (34, 72, 17)]
BLOCK = 8  # matches grass.png's own patch scale
PATCH_CHANCE = 0.12  # most blocks stay LAWN_BASE; only a few get a variant
bg = Image.new('RGB', (FINAL_PX, FINAL_PX))
for by in range(0, FINAL_PX, BLOCK):
    for bx in range(0, FINAL_PX, BLOCK):
        colour = random.choice(LAWN_VARIANTS) if random.random() < PATCH_CHANCE else LAWN_BASE
        for y in range(by, min(by + BLOCK, FINAL_PX)):
            for x in range(bx, min(bx + BLOCK, FINAL_PX)):
                bg.putpixel((x, y), colour)

# Occasional dandelion/violet flecks, matching the park sprites' own
# flower convention (small 2-3px clusters of a single bright colour,
# scattered sparsely on the grass) -- mow-line sheen fought visually with
# the patch grid, this doesn't.
DANDELION = (230, 178, 60)  # matches the park sprites' flower yellow
VIOLET = (138, 95, 179)
FLOWER_CHANCE = 0.035  # sparse -- a few per tile, not a carpet
for by in range(0, FINAL_PX, BLOCK):
    for bx in range(0, FINAL_PX, BLOCK):
        if random.random() >= FLOWER_CHANCE:
            continue
        colour = random.choice([DANDELION, VIOLET])
        fx = bx + random.randint(1, BLOCK - 2)
        fy = by + random.randint(1, BLOCK - 2)
        for dx, dy in ((0, 0), (1, 0), (0, 1)):
            px, py = fx + dx, fy + dy
            if 0 <= px < FINAL_PX and 0 <= py < FINAL_PX:
                bg.putpixel((px, py), colour)

bg = bg.convert('RGBA')
bg.alpha_composite(pixelated)
bg.convert('RGB').save(OUT)
print(f"Wrote {OUT}")
