# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run dev              # Vite dev server
npm run build             # Production bundle (dist/)
npm run preview           # Preview a production build
npm run lint               # tsc --noEmit (no separate eslint setup)
npm test                  # vitest run
npm test -- --pool=threads --poolOptions.threads.singleThread=true  # use this — multi-thread vitest crashes here
npm test -- src/game/economy.test.ts  # run a single test file
npm run build:favicon            # regenerate PWA icons/favicon from the 🏙️ emoji
npm run build:radio-playlist     # scan public/audio/radio/<station> folders, emit playlist.json/stations.json
```

`vitest.config.ts` forces `singleThread: true` already, but the `npm test` script itself doesn't pass that flag — always invoke with the explicit `--pool=threads --poolOptions.threads.singleThread=true` override shown above when running from the CLI.

Local GitHub Pages preview: `VITE_BASE=/city-sim-1000/ npm run build && npm run preview`.

## Architecture

Browser-based city simulator: TypeScript + Vite, PixiJS (WebGL) for rendering, vanilla DOM/CSS for UI, no framework. Everything is plain TS modules — no React/Vue, no global state library.

### Core loop (`src/main.ts`)
`main.ts` is the entry point and composition root: it builds the HUD DOM by string, wires up pointer/keyboard/wheel input, owns the single `GameState` instance, and drives `requestAnimationFrame(gameLoop)`. Each frame: apply camera pan, `simulation.update(dt)`, advance narrative on month boundaries, then render (`MapRenderer`, `hud`, `minimap`, `newsTicker`, `debugOverlay`). There is no separate "controller" layer — input handlers in `main.ts` call `applyTool(state, tool, x, y)` directly and mutate `state` in place.

### State (`src/game/gameState.ts`)
`GameState` is one large serializable object: a flat tile grid (`TileKind` enum per cell with elevation/power/water/happiness/building refs), utility stats, demand stats, budget stats, settings (minimap/input/accessibility/audio/hotkeys/cosmetics/narrative), bylaws, and building/service sub-states. Tiles reference buildings and power plants by id rather than embedding them. Settings have `createDefault*` factory functions in this file that `main.ts`'s `ensureSettingsShape` merges over loaded saves, so new settings fields must get a default factory here or old saves break.

### Simulation (`src/game/simulation.ts`)
`Simulation` is a fixed-timestep tick accumulator (`ticksPerSecond`, scalable via `setSpeed`) that on each tick: recomputes power/water networks (`utilities/power.ts`, `utilities/water.ts` — water is currently stubbed to a high constant balance until pipes/underground fully ship), advances zone growth timers, runs decay/abandonment (tiles lose happiness/power/demand and eventually abandon), updates education and labour stats (`computeLabourStats.ts`, `education.ts`), recomputes demand (`demand.ts`), and records the daily budget (`economy.ts`). It emits two side channels: `notify(alert)` for toast/sticky UI alerts and `onNarrativeEvent(event)` for the narrative system. `adjacency.ts` provides road/rail/power-reachability queries (`hasRoadAccess`, `tileHasPower`, `zoneHasRoadPath`) used throughout.

### Tools (`src/game/tools.ts`, `toolTypes.ts`)
Every player action (zoning, terraform, infrastructure, bulldoze) goes through `applyTool(state, tool, x, y)`, which returns `{ success, message? }`. Toolbar/hotkeys only select a `Tool` enum value; placement rules (cost, road access, overwrite/clear semantics) live entirely in `tools.ts`. Roads and rail conduct power; power lines can overlay roads/rail without breaking access; zoning cannot overwrite transport tiles (bulldoze first); transport tools clear any building they overwrite.

### Buildings (`src/game/buildings/`)
`templates.ts` defines static building specs (`BuildingCategory`, cost/upkeep/footprint), `state.ts` defines the runtime `BuildingInstance` (status, power plant linkage, etc.), and `manager.ts` does placement (`placeBuilding`), querying (`listPowerPlants`), and per-tick status updates (`updateBuildingStates`).

### Narrative layer (`src/game/narrative/`)
Decoupled from simulation via events: `simulation.ts` emits `SimEvent`s, `NarrativeManager` (`narrativeManager.ts`) buffers them through an `EventJournal`, and per-channel "rules" (`channels/tickerRule.ts`, `channels/budgetInsightsRule.ts`) turn events + periodic `CitySnapshot`s (`snapshot.ts`, `deltas.ts`) into ticker items / budget insight text. Month-end snapshots are triggered from `main.ts`'s game loop when the in-game calendar month advances. Entirely optional/toggleable via `state.settings.narrative`; UI surfaces are `ui/newsTicker.ts` and the Insights panel in `ui/budgetModal.ts`.

### Rendering (`src/rendering/`)
`MapRenderer` (`renderer.ts`) owns the PixiJS `Application`/canvas and draws the tile grid each frame from `GameState`, given hover/selection/tool/minimap-overlay-mode. `camera.ts` converts screen↔tile coordinates and holds pan/zoom state (kept outside `GameState` — it's not persisted). `tileAtlas.ts`/`sprites.ts`/`tileRenderUtils.ts`/`gridDrawer.ts` handle texture loading and per-tile draw logic.

### UI (`src/ui/`)
Each file is a self-contained DOM module exposing an `init*`/`create*` factory that takes element refs + callbacks and returns a controller object (e.g. `initToolbar`, `initMinimap`, `initBudgetModal`, `initSettingsModal`, `initBylawsModal`, `initNewsTicker`). No shared UI framework — modules talk to `main.ts` via the callbacks passed in, and to each other only through `state`.

### Persistence (`src/game/persistence.ts`)
`serialize`/`deserialize` (de)serialize the whole `GameState` to JSON for localStorage (`loadFromBrowser`/`saveToBrowser`) and file download/upload. `deserialize` back-fills missing fields for forward compatibility with older saves (e.g. defaulting `utilities`, `services`, `education` if absent) — when adding a new state field, add a corresponding back-fill here, not just a type change.

### Radio (`scripts/build-radio-playlist.ts`, `src/ui/radio*.ts`)
Each station lives under `public/audio/radio/<station>/` with audio files + optional `station.json`/covers; the build script (`npm run build:radio-playlist`) scans these folders and writes `playlist.json` per station plus a top-level `stations.json` manifest that the toolbar radio widget reads at runtime.

## Conventions

- **Canadian English** in code comments, docs, and identifiers where not constrained by a web standard: *colour, centre, licence (noun), organise, behaviour, favour*. CSS/DOM properties (`color`, `center`) keep their standard spelling.
- **Commits**: Conventional Commits, imperative mood, atomic. Update `README.md`, `docs/game-parameters.md`, `public/manual.html`, and `SPEC.md` alongside any behaviour change they describe, in the same commit.
- The in-game manual is `public/manual.html`, opened via a modal iframe — keep it in sync with UI/behaviour changes.
