# City Sim Studio — 3D-to-pixel-art asset pipeline

**Status:** working draft. A working end-to-end prototype of stages 2–4 lives in `studio/` (`studiolib.py` invariants + `scenes/*.py` buildings + `stylize.mjs` looks), with two assets (house, shop) and per-scene contact sheets in `studio/out/`. The **`rich-pixel-48` profile is the chosen art direction** (decided 2026-07-27 on visual evidence; other profiles kept for comparison). `studio/AUTHORING.md` is the scene-authoring contract, written so an LLM agent can add assets unassisted.
**Date:** 2026-07-27

## 1. Motivation

The game's building sprites currently come from three unrelated generations of tooling, and it shows:

1. **AI image one-offs** (ChatGPT, Nano Banana) — good individual sprites, but "prompt and pray": no two share a camera angle, light direction, palette, or line weight, and none can be regenerated or varied after the fact.
2. **SVG grid pipeline** (`app/scripts/build-park-assets.mjs`) — deterministic and on-style for flat/organic tiles (parks), validated by the vectorize → composite → jitter → rasterize technique, but hand-placing every cell of a building façade in 2D doesn't scale.
3. **Blender prototype** (`house-studio-out/blender-test/build_house_v4.py` + `pixelate_and_composite.py`) — proof of concept that a 3D model, cel-shaded and downsampled, can land close to the reference art. Janky, but the jank has identifiable, fixable causes (§4).

The 3D route is the one that generalises: one modelled house yields palette variants, rotations, damage states, construction stages, and — later — real assets for a potential 3D v2 of the game. The purpose of the Studio is to make that route *systematic*: every asset through the same camera, the same light, the same stylizer, so consistency is a property of the pipeline rather than a hope per prompt.

### Prior-art nod

The spiritual ancestor is the SC4 Building Architect Tool (BAT): a 3D authoring environment that rendered into the game's fixed projection and lighting. The Studio is BAT re-imagined for a solo dev whose 3D artist is an LLM: declarative recipes and a parts library instead of hand-modelling, and a scripted render/stylize loop instead of an interactive editor.

## 2. Goals and non-goals

**Goals**

- One deterministic pipeline: recipe in → game-ready PNG out, byte-identical on re-run (seeded jitter, no wall-clock).
- A written **style contract** (§4) that quantifies "the game's look" so any source — 3D render, SVG, even a cleaned-up AI image — can be normalised through the same stylizer.
- A reusable **parts library** (walls, roofs, windows, doors, props) so building N+1 is composition, not modelling from scratch.
- 3D sources (.blend + recipes) are the committed source of truth; PNGs are derived artefacts.
- Reviewable output: contact sheets showing each asset at 1×/2×, against grass, next to its existing in-game neighbours.

**Non-goals (for now)**

- An interactive 3D editor or GUI modelling tool.
- Animation (smoke, blinking lights) — the stylizer should not preclude it, but no stage is designed for it yet.
- Replacing the SVG pipeline for organic tiles — parks are fine; the Studio targets *structures* first.
- Runtime/in-game 3D rendering. That's v2 territory; the Studio only needs to not foreclose it.

## 3. Standing questions — positions

### Q1: Own project (like BAT for SC4)?

**In the monorepo, structured for extraction, not extracted.** Proposed home: top-level `studio/` (a sibling of `app/` and `crates/`, with its own `package.json`), because it is not an app build-time script — `app/scripts/` stays for things the app build actually consumes. The Studio's whole value is closing the loop against the game's real palette, real `grass.png`, and real neighbouring sprites; a separate repo adds submodule/versioning friction and severs that loop for zero benefit until there's a second consumer. Discipline for later extraction: the Studio may read from `app/public/assets/` and write into it, but never imports from `app/src/`.

### Q2: Reuse the existing pipeline or first principles?

**First principles for the architecture; wholesale reuse of the validated techniques.** The three existing generations aren't a pipeline to extend — they're experiments whose *results* feed the new design:

- From the SVG/park pipeline: grass point-sampling, FNV-seeded HSL jitter (lightness-only — the RGB-jitter desaturation bug is already found and fixed), 160/320 px output conventions.
- From `build_house_v4.py`: the measured house proportions, the fixed dimetric camera, and the negative results — Freestyle-then-downsample shreds linework, and in-material toon shading (Shader-to-RGB → hard ramp) bakes a look into the render that then can't be revised without re-rendering. Both are explicitly *not* carried forward.
- From `pixelate_and_composite.py`: NEAREST point-sampling (box filtering greys out linework) and alpha hardening.

What first principles *changes* is the shape: fixed intermediate formats between stages, multi-pass renders (colour + masks) instead of a single flattened image, and linework made a deliberate per-profile decision instead of a downsampling accident (§4, the big one).

### Q3: Tools?

- **Blender, headless (`bpy`)** as the render core. Already proven by v4; free; deeply scriptable; LLMs know its API well; geometry nodes give parametric parts later; `.blend` doubles as the v2 asset library. Rejected: three.js offscreen (weak toon/line story, would rebuild what Blender ships), OpenSCAD (CSG only, no materials), Godot (an engine, not a renderer).
- **Node/TS for everything after the render** — stylizer, compositor, packer, contact sheets — on `@napi-rs/canvas`. This is where the park-pipeline code already lives, it's the repo's native tongue, and it makes the stylizer unit-testable under vitest. Blender's Python ends at "emit clean passes + a metadata JSON"; the `pixelate_and_composite.py` responsibilities move here.
- **Recipes as declarative JSON** (§6), extending the existing `recipes.json` idea to 3D — footprint, storeys, roof type, material/palette refs, prop placements. A generator script turns a recipe into a Blender scene from the parts library. Freeform per-building `bpy` scripts (the v4 mode) remain the escape hatch for authoring *new parts*, not new buildings.
- **Orchestration:** plain Node CLI (`bun run studio:build <recipe|--all>`), cache keyed on hash(recipe + parts + stylizer version) so unchanged assets don't re-render.

### Q4: Previewer/editor or purely scripted?

**Scripted-first, with a static contact-sheet previewer — no interactive editor.** Neither operator needs one: Scott isn't a 3D artist, and Claude works through scripts. The tight loop is: edit recipe → rebuild → eyeball the contact sheet → adjust. The contact sheet is a generated static HTML page per asset showing: raw render, each stylizer stage, final sprite at 1×/2×/4×, composited on grass beside the current in-game sprites it must sit next to, and (optionally) a live screenshot via the existing MCP tooling. A slider-driven "kitbash mode" dev server can ride on the same machinery later if recipe iteration ever feels slow — explicitly deferred.

## 4. The style contract

The heart of the spec: a quantified definition of the game's look. It splits into two layers with very different stability:

- **Invariants** — camera, light, palette, ground compositing. These are what make a hundred assets read as one game, regardless of rendering treatment. Frozen constants in one shared module, identical for every asset, forever (or until a deliberate global art-direction change).
- **Look profile** — the stylizer's treatment: grid or no grid, line style, texture treatment. Pluggable by design. The game's current sprites are chunky pixel art, but pixel art is *not* a requirement — the requirement is hand-made-feeling, clean, consistent, and fun. The profile is chosen by a bake-off (M1), and because every asset regenerates from source, the whole game can change profile later without redrawing anything — that's the payoff of committing recipes rather than PNGs as truth.

### Invariants

**Camera.** Orthographic, classic 2:1 dimetric: elevation `atan(0.5)` (~26.57°), azimuth 45°, building yaw ~75° (v4's validated corner view). `ortho_scale` derives from footprint so a 1×1 building occupies a consistent fraction (~80–90%) of frame. Per-asset camera creativity is exactly the inconsistency the Studio exists to kill. (The game draws each sprite inside its own square tile, so there is no iso-diamond ground alignment to satisfy — the contract is about cross-sprite consistency, not map projection.)

**Light.** One sun, fixed world direction, plus a modest ambient floor so shadow faces stay recoverable — so every building in the city is lit from the same side. Crucially, the renderer does **no** stylized shading at all (v4's in-material Shader-to-RGB toon ramp is dropped): materials are plain diffuse, and the render is *data*, not *art*. The stylizer recovers per-pixel lighting by dividing the shaded pass by the albedo pass in linear space, then quantizes it however the active look profile wants — hard two-band, three-band with tinted shadows, ordered dither. Changing the shading style becomes a re-run of the stylizer, not a re-render.

**Palette.** A committed master palette (`studio/palette.json`), seeded by extracting the dominant colours from the existing on-style sprites. The stylizer snaps every non-outline output pixel to its nearest palette entry — this replaces v4's `posterize(4)`, which quantized to arbitrary per-image levels and is why its colours feel unrelated to the hand-made sprites. Per-building recipes pick *roles* (wall, roof, trim) that map to palette entries, so palette swaps are free variants. A constrained palette does more for "looks hand-made and consistent" than any grid does.

**Ground.** Buildings render on transparency. The compositor samples the real `app/public/assets/tiles/terrain/grass.png`, lays the optional lawn/dirt oval, and seats the building — one shared implementation instead of copies in two scripts.

**ID masks.** Whatever the profile, the renderer emits an object/material-ID pass (flat emission IDs or Cryptomatte) alongside colour. Masks are what let the stylizer treat regions differently (texture walls but not glass, ink some seams and not others) instead of guessing from colours.

### Look profiles

Two candidate profiles, both rendered from the same scenes; M1 builds both and the contact sheet decides. Both get their linework from geometry, not from downsampling luck.

**Profile A — `pixel-32`** (matches the existing sprites as-is). A 1×1 sprite is **32×32 art pixels** at 160×160 px (5 px per art pixel; 2×2 → 64×64 at 320), matching `res-house-1..4` and the park pipeline. *The v4 prototype pixelated to a 60-cell grid — finer than any real sprite in the game — a major source of its "noisy" read; its "60 sweet spot" existed only because Freestyle lines shredded at 32.* So in this profile the renderer emits **no outlines at all**: the stylizer downsamples colour and IDs to the art grid (NEAREST), snaps to palette, then draws outlines *at art-pixel resolution* — exactly 1 art pixel wherever the ID mask meets transparency (silhouette) or chosen ID pairs meet (roof/wall, wall/door). Near-black `#0a1a18`, never jittered — line weight becomes a guarantee instead of a downsampling accident. Texture: coarse in-render wave-bands (frequencies that survive the grid, per v4) plus the park pipeline's FNV-seeded HSL jitter (lightness ±0.06, hue untouched), applied per region via the masks.

**Profile B — `clean-cel`** (the hand-drawn/storybook direction). No grid quantization: output straight at 160/320 px. Linework comes from Blender's Grease Pencil Line Art (or Freestyle) *at output resolution*, where it is genuinely good — v4's ragged lines were a downsampling artifact, not a Blender limitation — with thickness taper and a subtle seeded noise modifier so strokes wobble like ink instead of ruling-pen CAD lines. Colour stays flat-toned and palette-snapped (the two-band toon shading carries the style); texture comes from soft in-render patterns and/or a light seeded grain in the stylizer rather than per-pixel dither. Reads like a tidy illustrated boardgame tile: clean, warm, obviously hand-made-adjacent.

A hybrid (coarse-ish grid with Profile B linework) is conceivable but starts as a non-goal — bake-offs need few, distinct contestants.

**The catch, honestly stated:** Profile B will not sit invisibly beside today's dithered pixel-art terrain and park tiles. Choosing it means committing to eventually re-treating terrain/roads/parks through the same style engine (the SVG sources make this tractable — §5 note on multiple geometry sources). That's a real cost, but it's a *migration the pipeline itself makes possible*, and it may be exactly the "solidify the art style" move this project has been circling.

## 5. Pipeline architecture

Five stages, each a separate CLI-invokable step with a fixed, inspectable intermediate format — debugging is "look at the stage boundary", and each stage is testable alone.

```
recipe.json ─┐
             ├─► [1 generate] scene.blend            (bpy: parts library → scene)
parts .blend ┘        │
                      ▼
             [2 render]  render/shaded.png           (plain diffuse under the studio sun)
                         render/albedo.png           (flat role colours — lighting recovery)
                         render/id.png               (flat material/object IDs)
                         render/height.png           (world Z — surface-pattern contours)
                         render/meta.json            (bbox, footprint, palette roles, seed)
                      ▼
             [3 stylize] sprite/building.png         (Node: apply the active look profile —
                                                      palette snap + masked region treatment;
                                                      grid/outline/dither per §4 profile)
                      ▼
             [4 composite] sprite/final.png          (grass sampling, lawn oval, centring)
                      ▼
             [5 pack]    app/public/assets/tiles/…   (copy into game conventions +
                         contact-sheet HTML)          manifest entry)
```

Notes:

- Stages 1–2 run inside one headless Blender invocation; 3–5 are pure Node and run without Blender installed (fixtures of stage-2 output are committed for stylizer tests).
- Everything is deterministic: seeds live in the recipe, `Date.now()`-free, so `--all` rebuilds are reproducible and cacheable by content hash.
- The stylizer (stage 3) accepts *any* colour+ID input at render resolution — which is how SVG-sourced or cleaned-up AI art can be normalised through the same style contract later (the "one style engine, many geometry sources" endgame).

## 6. Recipes and the parts library

**Recipe** (per asset, committed, the unit of iteration):

```jsonc
{
  "name": "res-house-2",
  "footprint": [1, 1],              // tiles
  "seed": 1337,
  "structure": {
    "plan": "rect",                 // later: L, T, split-level…
    "storeys": 1,
    "roof": { "type": "gable", "pitchRatio": 1.1, "overhang": "standard" }
  },
  "materials": { "wall": "siding.white", "roof": "shingle.red", "trim": "wood.dark" },
  "features": [
    { "part": "window.small", "face": "gableEnd", "at": [0.5, 0.7] },
    { "part": "door.plain",   "face": "gableEnd", "at": [0.5, 0.0] },
    { "part": "chimney.brick", "on": "roofSlope", "at": [0.3, 0.5] }
  ],
  "yard": { "oval": true, "props": [{ "part": "bush.round", "at": "frontCorner" }] }
}
```

**Parts library**: one or more committed `.blend` files with named collections (`window.small`, `door.plain`, `chimney.brick`, `bush.round`, …), each part carrying its own geometry, UVs, material-role slots, and an anchor empty for placement. Parts are authored/iterated as freeform `bpy` scripts (the v4 workflow — that's now the *part* workflow, not the *building* workflow), then saved into the library. The generator instantiates parts onto the recipe's structural shell, welds where the v4 lessons demand it (Freestyle is gone, but ID-mask seams still want clean geometry), and assigns material roles → palette entries.

Structural shells (walls + roof) are generated parametrically from `structure` — the v4 script is effectively the first shell generator (`plan: rect`, `roof: gable`) and gets ported rather than rewritten.

## 7. Milestones

Each milestone ends with a contact sheet judged against the existing sprites — kill or continue on visual evidence, not sunk cost.

- **M0 — Style contract extraction.** Measure existing on-style sprites; commit `palette.json` and the constants module; build the contact-sheet generator (it's needed to judge everything after).
- **M1 — Style bake-off.** Port the v4 shell through the new pipeline (rect/gable shell, ID-mask render, palette snap, grass compositor) and render the *same house* through both look profiles. Contact-sheet them beside `res-house-2.png` and on a live in-game screenshot. Acceptance: one profile chosen on visual evidence — either it sits beside the existing art without reading as a different game, or it's clearly better *and* we accept the terrain re-treatment it implies.
- **M2 — Parts library + recipe generator.** Windows/doors/chimney/bushes as library parts; 3–4 recipes reproducing the res-house-1..4 *roles* (not pixel-identical — replacements, or new density variants). Palette-swap variants for free.
- **M3 — Bigger structures.** 2×2 footprint, second storey, flat and hip roofs → commercial/industrial candidates (`com-*`, `ind-*`), which are currently the least consistent sprites in the set.
- **M4 — Unify.** Migrate the park/SVG pipeline's compositing onto the shared stylizer modules; retire the duplicated grass-sampling code; if `clean-cel` won M1, begin the terrain/road re-treatment through the same engine; document the Studio in `docs/` and (if assets ship) the manual.

## 8. Open questions

- **Which look profile** — decided by the M1 bake-off, on contact sheets, not in the abstract. If `pixel-32` wins, the sub-question of 32 vs 40 art pixels gets settled by the same side-by-sides.
- **Terrain migration scope** — if `clean-cel` wins: full re-treatment of terrain/roads/parks in one pass, or a transitional period where buildings lead and ground follows? (Buildings-on-grass mismatch may be tolerable short-term; roads adjacent to buildings probably are not.)
- **Interior seam inking policy** — silhouette always gets ink; which ID-pair boundaries do (roof/wall yes, siding-band no) is a stylizer rule table to tune in M1.
- **Depth pass** — worth adding for occlusion-aware outlines/self-overlap on complex M3 shapes, or does the ID pass suffice? Defer until an M3 shape breaks.
- **Blender as a hard dependency** — pin a version (4.x LTS) and document install; CI can skip stages 1–2 and test 3–5 on committed fixtures. Acceptable?
- **Where rendered sprites land in git** — final PNGs are committed (game loads them from `public/`), but are stage-2 intermediates committed as fixtures only, or fully ignored?
