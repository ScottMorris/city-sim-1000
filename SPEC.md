# 📘 **SPEC.md — City Sim 1000**

*A Browser-Based Pixel-Art City Simulation Game*

## 1. Overview

**City Sim 1000** is a Vite-based TypeScript game that runs fully client-side in the browser.
It uses **PixiJS for WebGL rendering**, vanilla CSS for UI, and a basic **PWA** setup for offline play.

The game is inspired by classic city-building titles and retro pixel-art aesthetics, as shown in the reference image. It should be:

* performant
* offline-capable
* standalone
* visually consistent with a pixel-art theme
* simple but expandable

For a concise overview of systems, balancing levers, and player-facing options, see **Systems Outline** in [`docs/game-parameters.md`](docs/game-parameters.md).

Game saves are stored in **IndexedDB** as binary CSAV containers (engine snapshot + client settings) with optional `.citysim` import/export; legacy LocalStorage/JSON saves are upgraded automatically.

---

## 2. Goals

### 2.1 Primary Goals

* Build a **smooth, responsive city simulator** rendered in WebGL.
* Use **pixel-art UI and tile graphics** (matching reference style).
* Implement core simulation elements:

  * Zoning (Residential, Commercial, Industrial)
  * Roads, rail, transit
  * Power and water utilities
  * Budget & economy
  * Terraforming and bulldozing
* Provide a **navigable map** with pan/zoom and pixel-snap.
* Fully offline-capable PWA.

### 2.2 Non-Goals (v1)

* No 3D rendering, complex shadows, or height-based terrain realism.
* No traffic simulation or agents.
* No political systems or disasters.
* No multiplayer or server-side logic.

---

## 3. Tech Stack

* **TypeScript**
* **Vite** for dev/build
* **PixiJS** for rendering
* **Vanilla CSS** for UI
* **Rust** (`city-sim-core`) for the simulation engine
* **WASM** (`city-sim-wasm`) — Web Worker + `WasmSimBridge` for browser play
* **Tauri v2** (`tauri-plugin-city-sim`) — native desktop via `TauriSimBridge`
* **Workbox service worker** (via `vite-plugin-pwa`, generated at build time) for caching
* **IndexedDB** (CSAV containers) + `.citysim` file import/export for saves

---

## 4. Project Structure

```
/
├─ index.html
├─ public/
│  ├─ manifest.webmanifest
│  ├─ icons/
│  └─ manual.html
│     (service worker is generated at build time into dist/sw.js by vite-plugin-pwa — not checked in)
├─ src/
│  ├─ main.ts
│  ├─ game/
│  │  ├─ gameState.ts
│  │  ├─ toolTypes.ts
│  │  ├─ persistence.ts
│  │  ├─ constants.ts
│  │  ├─ utilities/
│  │  │  └─ water.ts
│  │  └─ buildings/
│  │     ├─ state.ts
│  │     └─ templates.ts
│  ├─ rendering/
│  │  ├─ renderer.ts
│  │  ├─ sprites.ts
│  │  ├─ tileAtlas.ts
│  │  └─ camera.ts
│  ├─ ui/
│  │  ├─ hud.ts
│  │  ├─ toolbar.ts
│  │  └─ dialogs.ts
│  ├─ pwa/
│  │  └─ registerServiceWorker.ts
│  └─ style.css
├─ vite.config.ts
└─ tsconfig.json
```

---

## 5. Visual Style Requirements

### 5.1 General Aesthetic

The game must follow a **pixel-art inspired aesthetic**:

* limited palette (~32 colours)
* crisp edges, no anti-aliasing
* retro UI chrome inspired by early city builders
* warm sunset sky optional as a background setpiece

### 5.2 Tiles

Each tile uses a pixel-art style with 2–3 tone shading.

Tiles include:

* Grass
* Water
* Road (auto-connect)
* Rail (auto-connect)
* Trees
* Parks (Small 1x1, Large 2x2)

### 5.3 Power Network (v1)

* Tiles carry a `powered` flag.
* Power sources: any building whose `BuildingKind` is a power plant (`HydroPlant`, `CoalPlant`, `WindTurbine`, `SolarFarm`) — the tile carries only the `Structure` occupant plus the `buildingId` pointing at it.
* Network edges: any tile carrying a hydro line — whether the line owns the tile or rides it as an overlay (over a road or rail, or beneath trees or water painted on afterwards) — plus Road and Rail. If the wires are drawn, the tile conducts.
* Connectivity: 4-directional BFS flood-fill from sources through power lines/roads/rail; reachable lines/plants are marked `powered: true`.
* Production: `powerProduced` sums plant outputs from `BUILDING_TEMPLATES`.
* Maintenance: per-tile upkeep plus per-plant maintenance from configs.

### 5.4 Water Network (v1)

* Tiles carry a `watered` flag.
* Water sources: Pumps and Water Towers, both gated on power. Pumps are also gated on a source connection (`#200`): a pump's footprint must be orthogonally adjacent to a water tile to seed the network at all — a dry pump is `InactiveNoSource` and produces nothing. Towers are deliberately terrain-independent and carry no such gate.
* Network edges: `Occupant.Pipe` (underground layer), Road, Rail, and Zones.
* Connectivity: BFS flood-fill from sources through pipes and surface transport/zones.
* Production: `waterProduced` sums powered pump/tower outputs, and for pumps, source-connected ones only — the same predicate the BFS seeding uses, so the two can't disagree.
* Maintenance: per-pipe upkeep plus per-building maintenance.

### 5.5 UI Patterns

* Toolbar is two rows: the primary row and a contextual sub-row beneath it.
* The main “Power” button reveals a sub-row of power tools (Lines, Hydro, Coal, Wind, Solar); the Power button stays active when any power tool is selected.
* Toolbar hosts a radio widget at the trailing end of its primary row (Budget/Bylaws/Settings live in the status ribbon instead) with emoji controls (⏮️/▶️/⏸️/⏭️), a compact marquee for artist/title, and a hover/focus popover showing larger cover art plus details. If the playlist at `/public/audio/radio/playlist.json` is missing or empty, it shows “Radio offline”; audio prefers Opus with optional fallbacks listed in `fallbackSrc` and covers in `/public/audio/radio/covers/`.
* Buttons in sub-rows carry explicit labels/tooltips for clarity.
* Tile inspector lives in the bottom-left; the neighbouring tool info card shows cost/upkeep/output for the active tool with a pin toggle. The inspector only appears while the Inspect tool is active.
* Minimap sits in the bottom-right HUD corner with click-to-jump navigation, a visible viewport rectangle, and a toggle/hotkey (`M`) to collapse or expand it. Two orthogonal axes, each its own control: a **View** toggle (`ViewStratum`: Surface/Underground, hotkey `G`) that determines what tools may touch — Surface edits surface + overhead, Underground edits the underground stratum and dims the surface — and read-only **overlay** chips (`MinimapOverlay`: base/power/water/alerts/education/wilderness) that tint both the minimap and main view without gating tools. Selecting a tool with a home stratum (e.g. Pipes) switches the View for you; a tool already armed is refused with a hint if the View is manually toggled away from what it needs, rather than silently applying to the wrong layer. A loud HUD badge marks the active View whenever it's Underground. Use an offscreen canvas for redraws, throttle updates, and coarsen sampling on very large maps to protect performance. See `docs/features/view-layers.md`.
* Budget panel shows cash, a colour-coded monthly net projection, and a calendar month/day readout (30-day months) so per-month numbers have visible context. A Budget modal (HUD button) surfaces quarterly totals (last 3 months), per-month net, runway at current burn, revenue/expense breakdowns, and an optional narrative Insights panel. Revenue shows base stipend + residents/commercial/industrial; expenses split transport (roads/rail/lines/pipes) and buildings (power, civic, zones) with details.
* A news ticker bar sits beneath the top HUD, cycling short, grounded updates at month end and surfacing immediate utility alerts that persist until resolved. It can be disabled independently in Settings.

### 5.6 Rendering

* `MapRenderer` encapsulates Pixi rendering and draws tiles using existing palette colors; called each frame from `main.ts`.
* Camera logic (`centerCamera`, `screenToTile`) lives in `rendering/camera.ts`; rendering is decoupled from UI/event handling.
* An inactive building draws a small status icon — no-power or no-water/no-source (`tileAtlas.ts`'s `indicators`, chosen by `tileRenderUtils.ts`'s `resolveIndicatorKey`); an active building draws no marker of its own.
* Power lines
* Hydro plant
* Water pump
* Residential/Commercial/Industrial zones

### 5.7 UI Skin

* Pixel fonts only
* Buttons use retro framed borders
* Hover states use palette shifts, not opacity
* Bars (RCI) use blocked pixel segments
* HUD mimics pixel-art CRT-panel look

---

## 6. Core Systems

## 6.1 Map & Tiles

### Map

* Grid: 2D array of tiles
* Size: default 128×128
* Tile size: 16×16 or 32×32 depending on device pixel ratio

### Tile Interface

Superseded by the stratum model — see `docs/tile-model.md` for the design reasoning. A tile is not one `kind`; it is what ground it is, plus what independently occupies each physical layer:

```ts
enum Occupant {
  Pipe, Subway, Fibre,                              // underground
  Road, Rail, ZoneResidential, ZoneCommercial,
  ZoneIndustrial, Structure,                        // surface
  PowerLine, Trees                                  // overhead
}

interface Tile {
  terrain: Terrain;        // Land | Water
  underground: number;     // Occupant bitset
  surface: number;         // Occupant bitset
  overhead: number;        // Occupant bitset
  buildingId?: number;     // which BuildingInstance, if any occupies this tile
  elevation: number;
  powered: boolean;
  watered: boolean;
  happiness: number;
}
```

`TileKind` still exists (`gameState.ts`) but only in the frozen legacy `.citysim` save format — never as a per-tile field, and no longer as the building-template key either: `buildings/templates.ts`'s `BuildingTemplate.kind` is a separate `BuildingKind` enum (`Residential`, `WaterPump`, `HydroPlant`, ...) with the same string values, so save/MCP spelling didn't move. A level crossing (road + rail on the same tile), a hydro line strung over a road, or a zoned lot developed under a power line are all just multiple bits in the relevant stratum, not special cases.

### Tile Rendering Requirements

* Tiles should be rendered from a **texture atlas** generated from pixel sprites.
* Roads and rails must **auto-select sprite variants** based on adjacency.
* Water tiles should have subtle animation or a shifting noise layer.

---

## 6.2 Buildings

### Building Model (v1)

* Templates define **fixed buildings** the player places (non-generated) and carry:
  * `id` (string), `name`, `category` (`power`, `civic`, etc.)
  * `footprint` width × height (power plants: **2×2**)
  * `cost`, `maintenance`, and stat contributions (e.g., `powerOutputMw`)
  * `tileKind` to stamp and `spriteKey` (future) for the renderer
* Instances track `instanceId`, `templateId`, origin tile, and a lightweight **state machine** (`status: active | inactive`). v1: the state machine is a stub that just returns the template’s static outputs while `active`.

### Placement Rules

* A building footprint **must fit on the map** and **cannot overlap** any existing building tiles.
* One instance id is assigned per footprint (not per tile); all tiles in the footprint reference that id.
* Placement helpers validate before charging cost and stamp every tile in the footprint.

### Contributions

* Buildings report their contributions (power output, maintenance, etc.) from the template/state pair so simulation totals stay per-building (not per-tile).
* Future non-fixed/generated buildings can extend the same template/instance base and add richer state machines, but follow the same placement/footprint rules.

---

## 6.3 Camera

* Pan by dragging with the mouse, or with `WASD`/arrow keys; right-click drag is reserved for quick bulldoze instead
* Continuous zoom (not discrete steps) via scroll wheel or pinch, clamped to `MIN_SCALE`–`MAX_SCALE` (0.5×–3×)
* Zoom keeps the point under the cursor/pinch midpoint stationary
* Touch input: one finger drives the active tool exactly like a mouse click/drag; a second finger touching down always means camera control — it cancels any in-progress paint and switches to two-finger pan + pinch-zoom, so a stray second finger never leaves a half-finished drag behind
* Tap slop: a small movement tolerance on touch so a slightly-moving finger still registers as a tap rather than a one-tile drag-paint
* Compact layout uses a deeper default zoom than desktop so tiles stay finger-sized

---

## 6.4 Tools

### Tool List

```
Inspect
TerraformRaise
TerraformLower
Water
Trees
Road
Rail
PowerLine
Hydro
Pump
WaterTower
WaterPipe
Res
Com
Ind
Park
ParkLarge
Bulldoze
```

### Tool Behaviour Summary

#### Terraform

* Raise = height++
* Lower = height-- (min 0)
* Water = convert to water tile only
* Regrading wipes the ground: a road, a rail or a zone tag on the tile is cleared by the brush, and it is cleared the same whether the road owns the tile or rides under a hydro line as an underlay.
* Refused on a tile carrying a building — bulldoze first — because a regrade cannot remove the building behind it and would otherwise leave it running on ground that no longer holds it.
* A hydro line overhead and a pipe below are untouched by a regrade and do not block one.

#### Bulldoze

* Clears what stands on the tile and leaves the terrain as the land or water it was. Bulldozing a lake does not fill it in.
* Layer-scoped (`#198`): a click clears only the stratum the player is looking at, and never reaches across the boundary into the other one. From the Surface view it clears a building if there is one, otherwise everything at and above ground level together — roads, rail, zone tags, power lines and trees — but never a buried pipe. From the Underground view it clears the underground stratum only, never the building/surface/overhead. So razing a developed lot leaves the zoning behind for it to regrow on, and a hydro line over that lot survives the same click; a pipe buried under a road needs its own click from the Underground view, and a surface click over that same road leaves the pipe untouched.
* A click that finds nothing in the targeted stratum is refused ("Nothing to demolish here") and charges nothing — razing bare land, or the empty half of a tile carrying something in the other stratum, is a free no-op.
* The terrain brushes — Raise, Lower and Water paint — are the tools *for* changing what the ground is, priced at 10, 10 and 12 against Bulldoze's 1. They are not the only way to change it: every building tool fills water in as it builds over the tile, so Road (5) then Bulldoze (1) drains a water tile for 6.
* Does not modify height

#### Zoning

* Res/Com/Ind set zoning
* Each zoned tile can host a 1×1 **zone building instance** created by the simulation:
  * Residential lots provide population capacity; commercial/industrial lots provide job capacity
  * Lots use the building template system (cost/maintenance/utility use/capacity stored on the instance)
  * Lots require power and water (if `waterUse > 0`) to be **Active**; inactive lots contribute no capacity or consumption
  * Simulation spawns lots when demand is positive and utilities are available; bulldozing removes the lot and zoning

#### Utilities

* Hydro: must border ≥2 water tiles
* Pump: must border ≥1 water tile
* Water Tower: 2×2 footprint that boosts city water reserves, requires power and a network connection
* Water Pipe: Connects water network underground. Requires Underground View — selecting the tool switches the client's View there automatically, and a click is refused with a hint if the player manually toggles away before placing. Enforced engine-side too (`#198`): `Tool::WaterPipe` refuses with "Water pipes must be laid from the Underground view." unless the command's `stratum` is `Underground`, so a client with no view state (`mcpBridge.ts`/the MCP server) can't lay a pipe from the surface either.
* Power lines: graph-based connectivity

#### Sound Effects

* Procedural one-shot audio via `@liminal-hq/undertone` (zero-dependency Web Audio synth, published separately at [liminal-hq/undertone](https://github.com/liminal-hq/undertone)) — no sample files, every sound is synthesised from oscillator/noise voices with envelope and filter parameters.
* Four built-in effects: **Place Building** (any successful non-bulldoze tool placement — the priority-1 sound, never throttled, even during a fast drag-paint stroke), **Bulldoze**, **Error** (any failed placement), **Undo**. Bulldoze/Error/Undo get a short per-effect cooldown so rapid repeats don't stack into mush.
* Settings → Audio has a live volume slider plus a "🎚️ Edit Sound Effects" button opening an in-game editor: every voice layer of every effect is fully tunable (attack/decay/sustain/release, filter cutoff + envelope, pitch slide, sound type/note), with a live Preview button and a generated-parameter save. A "🎚️ Sliders" / "🧑‍💻 Code" toggle switches the same draft between per-field sliders and its raw `note()/sound()` builder-chain code for hand-editing — both are just alternate views onto the same parameters, and invalid code shows an inline error without losing the draft. Edits save either **to this city** (rides the normal save file, `settings.sfxOverrides`) or **globally** (all cities, `localStorage` — the one deliberate exception to this app's IndexedDB-only persistence, since it's small, cross-save, and non-critical if lost). Resolution order: city override → global override → built-in default. Reset (per effect) and Reset All revert to the built-in default.
* A quick mute toggle lives in the top ribbon next to Pause, independent of the volume slider's saved level.

---

## 6.5 Simulation

### Tick Loop

* Simulation runs at fixed 20 Hz
* Rendering uses rAF
* Simulation includes:

  * Power supply graph
  * Water supply graph
  * R/C/I demand calculations
  * Zone growth & decline
  * Happiness adjustments
  * Budget adjustments

### Demand Model

Range: **–100 to +100**

Demand influenced by:

* population vs jobs
* labour balance: aggregate unemployment (workers ~55% of population) and job vacancy rates push/pull R/C/I demand (vacancies boost R, unemployment boosts C/I) with gentle coefficients
* tax rates
* available land
* happiness
* utilities availability
* over-zoning: pending zones now apply a soft penalty (Res -0.45 each, Com/Ind -0.35) capped to min(35, 60% of the base term) with a pressure relief when base demand exceeds 60 and a floor of 8 (while <92% full) so large paint jobs trickle instead of stalling; power deficits still pull demand down after the floor.

### Budget System

Revenue:

* Residential tax
* Commercial tax
* Industrial tax

Expenses:

* Road maintenance
* Power line maintenance
* Hydro plant upkeep
* Water pump upkeep

---

## 6.6 Persistence

### IndexedDB

* Database `city-sim-1000`, store `saves`, one record per slot: `manual` (explicit Save) and `autosave` (periodic, see below)
* Records hold a binary **CSAV** container: magic + version + meta JSON + engine snapshot (CSIM postcard, includes `Policies` — budget, wilderness, and the lighting bylaw) + client JSON (settings)
* Legacy LocalStorage key `city-sim-1000-save` (plain JSON) is imported once and cleared after a successful CSAV write
* One deliberate exception: globally-scoped sound effect customizations (§6.4) live in `localStorage`, not IndexedDB — small, cross-save, non-critical if lost

### Autosave

* Cross-platform (not mobile-only): desktop browser tabs lose unsaved progress just as easily as a phone browser reclaiming a background tab
* Writes to the dedicated `autosave` slot every 60 seconds while the sim tick has advanced (skipped on an idle/paused city), plus an immediate flush on `visibilitychange` (tab hidden) and `pagehide`
* Never touches the `manual` slot or the undo history — autosave is a pure read of the engine
* On boot, whichever of `manual`/`autosave` is newest wins, with a toast naming which one and how long ago it was written (e.g. "Restored autosave from 2 min ago")
* `navigator.storage.persist()` is requested once after the first successful save, best-effort — reduces (never eliminates) the browser's chance of evicting IndexedDB data under storage pressure

### Import/Export

* Export: download a `.citysim` binary container; on touch devices this instead opens the OS share sheet via the Web Share API, falling back to a plain download when sharing isn't supported or the user cancels
* Import: upload `.citysim` (or a legacy JSON export) → validation → load

---

## 6.7 Mobile & Touch Input

* **Detection, not UA sniffing** — two independent axes, each re-evaluated live as the environment changes (no reload needed):
  * *Input mode* (`touch` | `mouse`): `(pointer: coarse)` media query, falling back to `navigator.maxTouchPoints` if `matchMedia` is unavailable
  * *Layout mode* (`compact` | `full`): viewport width ≤ 900px **or** height ≤ 500px — matching on either dimension (not just width) catches a phone in landscape, which is comfortably wider than 900px but too short for a full desktop shell to leave any canvas
* A tablet gets full layout with touch-sized targets; a desktop with a touchscreen gets full layout with touch gestures — the two axes are independent
* **Override**: a `ui: 'auto' | 'desktop' | 'mobile'` setting (Settings modal) forces a mode regardless of detection; `?ui=mobile` / `?ui=desktop` in the URL forces it for a single dev/test load and persists into the setting if the player then explicitly Saves
* **Compact UI shell**: the desktop toolbar row is replaced by a thumb-zone "current tool" button (bottom-right, shows the active tool + cost) that opens a bottom sheet listing every tool; the tile-inspector and tool-info card share one small tabbed panel (Map / Inspect) above the sheet instead of each floating independently, auto-switching content and label to match whichever the active tool makes relevant — the same logic desktop's always-on tool-info card already used
* **Gesture model**: one finger drives the active tool exactly like a mouse click/drag; a second finger touching down always means camera control (cancels any in-progress paint, switches to two-finger pan + pinch-zoom); a small tap-slop tolerance keeps a slightly-moving finger from registering as an accidental drag-paint
* **Safe areas**: `viewport-fit=cover` plus `env(safe-area-inset-*)` padding on HUD/toolbar chrome so notches/home indicators never cover controls; `dvh`/`svh` (not bare `vh`) so the layout survives the mobile browser chrome showing/hiding
* **Save export**: touch devices try the Web Share API first (native share sheet), falling back to the desktop download path when unsupported or cancelled
* **Radio**: gesture-gated like any autoplay-restricted audio — enabling it is itself the qualifying tap; an out-of-band interruption (OS audio focus loss, a phone call) resyncs the play/pause UI rather than leaving it claiming to still be playing

---

## 7. PWA Requirements

* `manifest.webmanifest` with icons
* A Workbox service worker, generated at build time by `vite-plugin-pwa` (`generateSW` mode, `registerType: 'autoUpdate'`) from the real Vite build manifest, that precaches:

  * index.html and manual.html
  * built JS + CSS
  * the WASM binary + worker chunk
  * textures/sprites and icons
  * excluding radio audio (`public/audio/`) and the marketing images (`readme-banner.png`, `social-preview.png`)
* Offline support required

---

## 8. Manual

Create `public/manual.html` with:

* Installation instructions
* Controls
* Explanation of tools
* Basic city-building guide
* Save/load instructions
* Troubleshooting

---

## 9. Performance Targets

* 60 FPS on modern desktop browsers
* 30 FPS minimum on a mid-tier Android phone (not a flagship) — verified ~60fps sustained on a Google Pixel 8 Pro with only slight thermal warmth over a play session
* Pixi canvas `resolution` capped at `min(devicePixelRatio, 2)` — retina-sharp without paying the full uncapped cost on DPR-3 phones
* The per-frame redraw is skipped when the sim is paused and nothing that feeds it (camera, hover/selection, tool, engine mirror) has changed since the last frame
* Limit re-drawing:

  * Only redraw changed tiles
* Use cached Pixi RenderTextures for tiles
* Minimise allocations inside the simulation loop
* Avoid dynamic sprite creation per frame

---

## 10. Roadmap (Post-v1 Ideas)

* Pollution / land value map
* Animated citizens or vehicles
* More tile types
* Modding support
* Chunked tile rendering for huge maps

---

## 11. Definition of Done (v1)

A build is considered complete when:

* The game runs smoothly offline
* The map is fully navigable
* All tools are functional
* R/C/I zoning grows based on simulation
* Utilities affect growth
* Budget changes over time
* UI matches pixel-art aesthetic
* Save/load/import/export works
* Manual exists and is linked from UI
