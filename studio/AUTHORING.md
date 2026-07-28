# Studio authoring guide — building assets in 3-space

Instructions for adding a new building asset to the City Sim 1000 studio pipeline. Written to be followed by an LLM agent or a human with no Blender experience. Read the whole guide before modelling; the failure modes at the bottom are all real and all cost an iteration each to discover.

## How the pipeline works (30 seconds)

You write a small Python scene module that builds chunky geometry out of boxes. Headless Blender renders it four times through a **fixed** camera and sun — `shaded` (real light), `albedo` (flat colours), `id` (one colour per part), `height` (world elevation as greyscale). The renderer makes **zero style decisions**: no textures, no outlines, no toon shading. A Node stylizer (`stylize.mjs`) turns those four data passes into game sprites in several look profiles; the project's chosen direction is `rich-pixel-48`. You judge output on the contact sheet, tweak, repeat.

```
scenes/<name>.py  →  render-passes.py (Blender, 4 passes)  →  stylize.mjs  →  out/contact-sheet-<name>.png
```

## The iteration loop

```bash
# from the repo root
docker run --rm -v "$PWD/studio":/studio nytimes/blender:3.3.1-cpu-ubuntu18.04 \
  blender -b -P /studio/render-passes.py -- <scene>     # ~2 min CPU
cd studio && bun stylize.mjs <scene>                    # instant
# inspect out/contact-sheet-<scene>.png and out/look-<scene>-rich-pixel-48.png
```

Always view the sprite at 4× (nearest-neighbour upscale) before judging detail, and always look at the contact sheet before declaring victory — the sprite must sit beside the existing game art, not just look good alone.

Once an asset set is approved, `bun pack.mjs` copies its `rich-pixel-48` renders into `studio/dist/assets/tiles/` under game sprite names (the pack list lives in `pack.mjs`). Wiring `dist/` into `app/public/assets/` + the tile atlas is a separate, explicitly approved step.

## Invariants — never touch these

The camera, sun, world lighting, render settings, and pass logic live in `studiolib.py` and are identical for every asset. That sameness is what makes a hundred sprites read as one game. If your building looks wrong, fix the *building* (geometry, proportions, rotation), never the camera or light.

- Camera: orthographic 2:1 dimetric (elevation `atan(0.5)`, azimuth 45°), `ortho_scale = 4.0` → the frame is 4 world units across.
- Sun: fixed world direction, low ambient. Faces facing +X/-Y catch light; the stylizer quantizes recovered lighting into bands.
- A scene may set `ROTATION_DEG` (default 75 — shows one long face and one gable/front face) and `FOCUS_Z` (camera aim height, roughly 40–55% of building height).

## Unit arithmetic you must do before modelling

The output tile is 160 px; building content occupies 84% of it; the chosen art grid is 48 cells. The frame is 4.0 world units wide and the content crop typically ~3.2–3.4 units. Therefore:

> **1 art cell ≈ 0.08 world units.** (3.3 units / 40 cells of building content)

Three sizing rules follow, and they are the most important rules in this document:

1. **Geometry must be ≥ 1 cell (≥ 0.09 units) in its smallest visible dimension**, or the downsampler will shred it into scattered stray pixels ("the yellow pixel bug"). Sub-cell details (window mullions, door knobs, thin frames) must NOT be geometry at coarse grids — the stylizer remaps them away (`trim`→wall, `mullion`→glass) and re-stamps grid-native equivalents (sash cross, knob cell). If you need a new sub-cell fitting, add a stamp in `stylize.mjs`, not a thin box.
2. **A part needs ≥ 2–3 cells (≥ 0.2 units) to read as a coloured shape** rather than noise.
3. **A 1×1-tile building including yard props should span ≤ ~2.6 world units** so it fits the content box with margin. Height budget: keep ridge/parapet under ~2.3 units (the height pass normalizes over 0–2.6).

## Roles — the material system

Every material is a **role** — a semantic building part, not a colour. Roles are defined once in `studiolib.py` (`ROLES`: working albedo + unique ID colour) and styled per scene in `stylize.mjs` (`SCENE_STYLES[scene].palette`). Current roles:

| role | purpose | notes |
|---|---|---|
| `wall` | structural walls, gable caps, parapets | gets course lines (siding/brick) from the height pass |
| `roof` | pitched slopes or flat slabs | course lines; flat roofs get none automatically (constant height) |
| `chimney` | chimneys, rooftop vents | |
| `window` | glass | gets sash cross + glint stamps at coarse grids |
| `door` | door slab | gets inset-panel + knob stamps |
| `knob` | door hardware | sub-cell; re-stamped at coarse grids |
| `trim` | window/door frames | sub-cell; remapped to wall at coarse grids |
| `mullion` | window cross-bars | sub-cell; remapped to glass at coarse grids |
| `step` / `walkway` | ground stonework | |
| `bush` | shrubs, hedges, planters | |
| `awning` | storefront awnings | gets stripe stamp |
| `sign` | sign bands | no readable text — it's a colour band |
| `rail` / `tie` / `ballast` | railway trackbed | ballast gets a gravel-speckle stamp; trackbed pairs are ink-free |

To add a role: pick an ID colour far from existing ones in linear RGB, add it to both files, add ink-precedence placement and (if needed) `NO_INK_PAIRS` entries. Small parts adjacent to their parent (knob-on-door, mullion-on-glass) usually belong in `NO_INK_PAIRS`, or their outline swallows them.

## Writing a scene module

Create `studio/scenes/<name>.py`:

```python
from studiolib import box, face_box

ROTATION_DEG = 75      # optional
FOCUS_Z = 0.9          # optional; ~half your building height

def build(mats):
    box(mats, 'wall', (0, 0, 0.75), (2.0, 1.6, 1.5))         # location, scale
    face_box(mats, 'window', 1.0, 0, 0.7, 0.9, 0.5, 0.05)    # on a +X wall face
    ...
```

Guidance that survived contact with real sprites:

- **Boxes are enough.** Chunky primitives + the stylizer's banding/patterns/ink produce the character. Curves and fine mouldings will not survive 48 cells. Ico-spheres for bushes are the exception.
- **Proportions over detail.** The house reads because it's squat and roof-dominant (wall 1.05, roof 1.15 high). Measure the target sprite's proportions before modelling; don't model to real-world proportions.
- **Front features on the +X face** (that's the face `ROTATION_DEG = 75` turns toward the camera). Mount them with `face_box`, proud of the wall plane by 0.02–0.07 so passes sample them cleanly; stack proud offsets so nearer fittings are farther out (frame 0.02, glass 0.05, knob 0.065).
- **Compose the yard.** A step, a walkway leading off the tile, and one prop (bush/planter) ground the building; the stylizer draws the lawn oval.
- **World-horizontal patterns are free.** Siding, brick courses, shingle rows come from the height pass — tune spacing per scene in `SCENE_STYLES` (0.30 reads as planks, ~0.22 as brick). Never encode these patterns as geometry or 3D textures.

## Ground tiles (roads, rails, terrain features)

Ground tiles are a second asset class: set `TOP_DOWN = True` in the scene and the studio switches to a straight-down orthographic camera (same `ortho_scale = 4.0`, same sun — raised geometry self-shades consistently with the buildings). Rules that differ from buildings:

- The frame is exactly one tile (±2.0 world units). Geometry that should connect to neighbouring tiles must run to the frame edge (overshoot ~0.05 to avoid seams); patterns crossing the edge must have a world-space period that divides the 4.0-unit tile evenly (see `TIE_SPACING` in `scenes/rail.py`).
- Give the scene's entry in `SCENE_STYLES` the flag `ground: true` — the stylizer then maps the frame edge-to-edge (no crop/shrink), skips the lawn oval, and fills transparent cells with plain grass.
- Relief still matters: model trackbeds/kerbs as *raised* boxes (0.05–0.2 units) so the fixed sun gives them form; a purely flat plane renders styleless.
- Connectivity variant sets (the road/rail 15: `ns`, `ew`, 4×`corner-*`, 4×`t-*`, `cross`, 4×`end-*`) come from ONE parametric scene exposing a `VARIANTS` dict and a `VARIANT` module global; the driver renders each as `<scene>-<variant>`. Always build variants as rotated *geometry*, never rotate the finished sprite — sprite rotation would rotate the sun with it and break lighting consistency.
- Render all variants in one Blender session: `... render-passes.py -- rail all`; stylize each with `bun stylize.mjs rail-<variant>`.
- **Billboard props** (the hydro pole): tall standing objects on ground tiles are a separate scene rendered through the *dimetric* camera and composited by the stylizer (`SCENE_STYLES[x].overlay`), at 1:1 world scale so attachment points line up with ground geometry (crossarm tips ↔ wire lines). `overlayOffsetY` (in px, snapped to whole art cells) seats the prop vertically; a cell-aligned shadow blob is stamped under it, matching the studio sun.
- **Ground tiles are plan view; billboard props are elevation — and the two only meet along one screen axis.** Under the fixed 45° azimuth exactly one horizontal world direction, `(-1, 1)`, projects to screen-horizontal; its perpendicular `(1, 1)` points away from the camera and foreshortens to a stub. So a prop's horizontal feature can present itself to ground geometry running one way but not the other: the hydro pole's crossarm carries the N-S wires and merely crosses the E-W ones. Adding a second arm at right angles does *not* fix this (it just thickens the first into a blob), and neither does rotating the camera per variant — a horizontal bar can never read as a screen-vertical line in an elevation view. Budget for this when designing a prop that has to serve a full 15-variant connectivity set, or accept the asymmetry.

## Stylizer knobs (per scene, in `stylize.mjs`)

- `SCENE_STYLES[scene].palette` — hex colour per role. Keep values in the neighbourhood of the existing game palette; shadow/highlight variants are derived automatically (cool-shifted shadows, warm highlights).
- `wallSpacing` / `roofSpacing` — course-line spacing in world units.
- Stamps (grid-native detail rules) live in `renderProfile`'s `details` block. A stamp is ~5 lines: pick cells by role + position (part bounding boxes are available), recolour deterministically, set `stamped = true` so jitter skips them.

## Judging checklist before you show a result

- No stray single-colour pixels anywhere (sub-cell geometry leak).
- Outlines are continuous, 1 cell, and stop cleanly; small fittings aren't swallowed by ink.
- The two visible wall faces separate (light band difference and/or course lines).
- Course lines follow each face's slope and stay continuous around corners.
- Silhouette reads at 1× (160 px) — squint test.
- On the contact sheet, the sprite sits beside the existing game sprites without reading as a different game.

## Known failure modes (all real, all previously hit)

| symptom | cause | fix |
|---|---|---|
| scattered stray pixels around a part | geometry thinner than 1 art cell | remap + stamp, or fatten to ≥ 0.09 units |
| texture reads as scales/static | pattern thinner than a cell, or screen-space pattern | derive from height pass; draw course-index *changes*, not thresholded bands |
| ragged 1–3 px outlines | outlines rendered in Blender then downsampled | never render outlines; stylizer draws them from ID edges at art resolution |
| colours feel unrelated to the game | per-image quantization (posterize) | palette-snap per role in the stylizer |
| flat lifeless shading | style baked into materials (toon ramps) | keep materials plain diffuse; quantize recovered light in the stylizer |
| whole image washed out | Blender's Filmic tone-mapping | `view_transform = 'Standard'` (already set in studiolib — don't undo it) |
| stray bright pixels on fittings | edge-highlight applied to small parts | highlights are structural-roles-only |
| part vanished at 48 but fine at 160 | sub-cell geometry lost to majority vote | that's by design — stamp it (knob pattern) |
