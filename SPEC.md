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

Game saves are stored in **LocalStorage** with optional import/export.

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
* **Service worker** for caching
* **LocalStorage** + file import/export for saves
* Optional future:

  * Web Workers for simulation
  * WASM for heavy calculations

---

## 4. Project Structure

```
/
├─ index.html
├─ public/
│  ├─ manifest.webmanifest
│  ├─ service-worker.js
│  ├─ icons/
│  └─ manual.html
├─ src/
│  ├─ main.ts
│  ├─ game/
│  │  ├─ gameState.ts
│  │  ├─ simulation.ts
│  │  ├─ tools.ts
│  │  ├─ toolTypes.ts
│  │  ├─ persistence.ts
│  │  ├─ constants.ts
│  │  └─ power.ts
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
* Parks

### 5.3 Power Network (v1)

* Tiles carry a `powered` flag and optional `powerPlantType` (Hydro, Coal, Wind, Solar).
* Power sources: any tile with `powerPlantType` set.
* Network edges: `TileKind.PowerLine` tiles.
* Connectivity: 4-directional BFS flood-fill from sources through power lines; reachable lines/plants are marked `powered: true`.
* Production: `powerProduced` sums plant outputs from `POWER_PLANT_CONFIGS`; `powerUsed` is `0` until consumers exist.
* Maintenance: per-tile upkeep plus per-plant maintenance from configs.
* Rendering is unchanged for v1; powered/unpowered lines share visuals for now.

### 5.4 UI Patterns

* Toolbar is two rows: the primary row and a contextual sub-row beneath it.
* The main “Power” button reveals a sub-row of power tools (Lines, Hydro, Coal, Wind, Solar); the Power button stays active when any power tool is selected.
* Buttons in sub-rows carry explicit labels/tooltips for clarity.
* Tile inspector lives in the bottom-left; the neighbouring tool info card shows cost/upkeep/output for the active tool with a pin toggle. The inspector only appears while the Inspect tool is active.
* Minimap sits in the bottom-right HUD corner with click-to-jump navigation, a visible viewport rectangle, and a toggle/hotkey (`M`) to collapse or expand it. Base mode renders terrain, zones, roads, rail, power lines, and buildings; a mode switch UI is scaffolded but only the “Base” option is live until overlays (power/water/alerts) arrive. Use an offscreen canvas for redraws, throttle updates, and coarsen sampling on very large maps to protect performance.
* Budget panel shows cash, a colour-coded monthly net projection, and a calendar month/day readout (30-day months) so per-month numbers have visible context. A Budget modal (HUD button) surfaces quarterly totals (last 3 months), per-month net, runway at current burn, and revenue/expense breakdowns.

### 5.5 Rendering

* `MapRenderer` encapsulates Pixi rendering and draws tiles using existing palette colors; called each frame from `main.ts`.
* Camera logic (`centerCamera`, `screenToTile`) lives in `rendering/camera.ts`; rendering is decoupled from UI/event handling.
* Building centre markers are tinted by power status (green when powered, red when unpowered); these markers will later surface missing services (water, fire, waste, etc.).
* Power lines
* Hydro plant
* Water pump
* Residential/Commercial/Industrial zones

### 5.3 UI Skin

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

```ts
export enum TileKind {
  Land, Water, Road, Rail, Tree, Park,
  PowerLine, HydroPlant, WaterPump,
  Residential, Commercial, Industrial,
}

export interface Tile {
  kind: TileKind;
  height: number;     // 0 = water, 1+ = land elevations
  zoneLevel?: 0 | 1 | 2 | 3;
  population?: number;
  jobs?: number;
  powered: boolean;
  watered: boolean;
  happiness: number;
}
```

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

* Pan with right-click drag
* Zoom in discrete steps: 1.0 → 1.5 → 2.0
* Pixel-snap at all zoom levels
* Optional easing for panning

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
WaterPipe (planned; requires underground view)
Res
Com
Ind
Park
Bulldoze
```

### Tool Behaviour Summary

#### Terraform

* Raise = height++
* Lower = height-- (min 0)
* Water = convert to water tile only

#### Bulldoze

* Removes everything **except** base land/water
* Does not modify height

#### Zoning

* Res/Com/Ind set zoning
* Each zoned tile can host a 1×1 **zone building instance** created by the simulation:
  * Residential lots provide population capacity; commercial/industrial lots provide job capacity
  * Lots use the building template system (cost/maintenance/utility use/capacity stored on the instance)
  * Lots require power to be **Active**; inactive lots contribute no capacity or consumption
  * Simulation spawns lots when demand is positive and utilities are available; bulldozing removes the lot and zoning

#### Utilities

* Hydro: must border ≥2 water tiles
* Pump: must border ≥1 water tile
* Water Tower: 2×2 footprint that boosts city water reserves, does not require power
* Water Pipe: planned; placement UI stubbed until underground view exists
* Power lines: graph-based connectivity

---

## 6.5 Simulation

### Tick Loop

* Simulation runs at fixed 20 Hz
* Rendering uses rAF
* Simulation includes:

  * Power supply graph
  * Water supply radius or graph
  * R/C/I demand calculations
  * Zone growth & decline
  * Happiness adjustments
  * Budget adjustments

### Demand Model

Range: **–100 to +100**

Demand influenced by:

* population vs jobs
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

### LocalStorage

* Key: `city-sim-1000-save`
* JSON with versioning

### Import/Export

* Export: download json
* Import: upload json → validation → load

---

## 7. PWA Requirements

* `manifest.webmanifest` with icons
* `service-worker.js` that caches:

  * index.html
  * built JS + CSS
  * textures/sprites
  * manual.html
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
* Sound effects & music

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
