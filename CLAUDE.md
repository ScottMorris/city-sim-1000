# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Monorepo layout

```
city-sim-1000/
├── app/          ← Vite/TypeScript web game (all npm work happens here)
│   ├── src/      ← game source (game/, rendering/, ui/, pwa/)
│   ├── public/   ← static assets, manual.html, audio, icons
│   ├── scripts/  ← build-time Node scripts (favicon, radio playlist)
│   ├── package.json
│   └── vite.config.ts / tsconfig.json / vitest.config.ts
├── crates/                      ← Rust workspace members
│   ├── city-sim-core/           — pure-Rust sim engine (Phase 3+)
│   ├── city-sim-protocol/       — shared wire types, TileKind mapping (active)
│   ├── city-sim-wasm/           — WASM cdylib wrapper (Phase 2+)
│   └── tauri-plugin-city-sim/   — Tauri v2 plugin (Phase 4+)
├── docs/         ← architecture docs, migration plan & task list
├── Cargo.toml    ← workspace root
└── package.json  ← root shim — proxies bun commands to app/
```

## Commands

All commands work from the repo root (the root `package.json` proxies to `app/` via `bun --cwd app`):

```bash
bun install                    # installs inside app/
bun run dev                    # Vite dev server
bun run build                  # Production bundle (app/dist/)
bun run preview                # Preview a production build
bun run lint                   # tsc --noEmit (no separate eslint setup)
bun run test                   # vitest run (singleThread baked in — always safe)
bun run test -- app/src/game/economy.test.ts  # run a single test file
bun run build:favicon          # regenerate PWA icons/favicon from the 🏙️ emoji
bun run build:radio-playlist   # scan app/public/audio/radio/<station> folders, emit playlist.json/stations.json
bun run build:wasm             # compile crates/city-sim-wasm → app/src/wasm/sim_wasm/ (run after Rust changes)
```

**Important:** `app/src/wasm/` is gitignored (generated output). Run `bun run build:wasm` once after a fresh clone before `bun run dev` or `bun run build`, otherwise the WASM Worker will fail to load. The game falls back gracefully if you omit `?bridge=wasm` from the URL.

To run scripts directly inside `app/`:
```bash
cd app && bun run test
cd app && bun run test -- app/src/game/economy.test.ts
```

Rust:
```bash
cargo check --workspace
cargo test -p city-sim-protocol
cargo test --workspace
```

Local GitHub Pages preview: `VITE_BASE=/city-sim-1000/ bun run build && bun run preview`.

## Architecture

Browser-based city simulator: TypeScript + Vite, PixiJS (WebGL) for rendering, vanilla DOM/CSS for UI, no framework. Everything is plain TS modules — no React/Vue, no global state library.

### Core loop (`app/src/main.ts`)
`main.ts` is the entry point and composition root: it builds the HUD DOM by string, wires up pointer/keyboard/wheel input, owns the single `GameState` instance, and drives `requestAnimationFrame(gameLoop)`. Each frame: apply camera pan, `bridge.step(dt)`, advance narrative on month boundaries, then render (`MapRenderer`, `hud`, `minimap`, `newsTicker`, `debugOverlay`). There is no separate "controller" layer — input handlers in `main.ts` call `bridge.send(applyToolCmd(...))` and read state through `bridge.getState()`.

### SimBridge (`app/src/game/simBridge.ts`, `localSimBridge.ts`, `wasmSimBridge.ts`, `tauriSimBridge.ts`)
All simulation access goes through the `SimBridge` interface: `step`, `send`, `onMessage`, `getState`, `loadState`, `setSpeed`, `dispose`. `LocalSimBridge` wraps the TS `Simulation` in-process (default path). `WasmSimBridge` (Phase 2) routes through a Web Worker running a WASM `SimHost` — activate with `?bridge=wasm`. `TauriSimBridge` (Phase 4) routes through `tauri-plugin-city-sim` — auto-detected via `window.__TAURI_INTERNALS__` or `?bridge=tauri`; force local with `?bridge=local`. The active bridge is chosen at startup in `main.ts`.

### State (`app/src/game/gameState.ts`)
`GameState` is one large serializable object: a flat tile grid (`TileKind` enum per cell with elevation/power/water/happiness/building refs), utility stats, demand stats, budget stats, settings (minimap/input/accessibility/audio/hotkeys/cosmetics/narrative), bylaws, and building/service sub-states. Tiles reference buildings and power plants by id rather than embedding them. Settings have `createDefault*` factory functions in this file that `main.ts`'s `ensureSettingsShape` merges over loaded saves, so new settings fields must get a default factory here or old saves break.

### Simulation (`app/src/game/simulation.ts`)
`Simulation` is a fixed-timestep tick accumulator (`ticksPerSecond`, scalable via `setSpeed`) that on each tick: recomputes power/water networks (`utilities/power.ts`, `utilities/water.ts`), advances zone growth timers, runs decay/abandonment, updates education and labour stats, recomputes demand, and records the daily budget. Emits side channels: `notify(alert)` for alerts and `onNarrativeEvent(event)` for the narrative system. `adjacency.ts` provides road/rail/power-reachability queries used throughout.

### Protocol (`app/src/game/protocol/`)
TS mirror of `crates/city-sim-protocol` — `TileKind ↔ u8` mapping, `SimCommand`, `FromSim`, tile buffer SoA offsets. `tileKindParity.json` is generated by `cargo test dump_parity_json` and validated by the parity test suite.

### Tools (`app/src/game/tools.ts`, `toolTypes.ts`)
Every player action goes through `applyTool(state, tool, x, y)`, called via `bridge.send(applyToolCmd(tool, x, y))` from `main.ts`. Placement rules (cost, road access, overwrite/clear semantics) live entirely in `tools.ts`.

### Buildings (`app/src/game/buildings/`)
`templates.ts` defines static building specs, `state.ts` defines runtime `BuildingInstance`, `manager.ts` does placement and per-tick status updates.

### Narrative layer (`app/src/game/narrative/`)
Decoupled from simulation via events: `simulation.ts` emits `SimEvent`s, `NarrativeManager` buffers them through an `EventJournal`, and per-channel rules turn events + periodic `CitySnapshot`s into ticker items / budget insight text. Entirely optional/toggleable via `state.settings.narrative`.

### Rendering (`app/src/rendering/`)
`MapRenderer` (`renderer.ts`) owns the PixiJS `Application`/canvas and draws the tile grid each frame from `GameState`. `camera.ts` converts screen↔tile coordinates and holds pan/zoom state (not persisted).

### UI (`app/src/ui/`)
Each file is a self-contained DOM module exposing an `init*`/`create*` factory. No shared UI framework — modules talk to `main.ts` via the callbacks passed in.

### Persistence (`app/src/game/persistence.ts`)
`serialize`/`deserialize` (de)serialize the whole `GameState` to JSON for localStorage and file download/upload. `deserialize` back-fills missing fields for forward compatibility — when adding a new state field, add a back-fill here.

### Radio (`app/scripts/build-radio-playlist.ts`, `app/src/ui/radio*.ts`)
Each station lives under `app/public/audio/radio/<station>/` with audio files + optional `station.json`/covers; the build script scans these folders and writes `playlist.json` per station plus a top-level `stations.json` manifest.

## Conventions

- **Canadian English** in code comments, docs, and identifiers where not constrained by a web standard: *colour, centre, licence (noun), organise, behaviour, favour*. CSS/DOM properties (`color`, `center`) keep their standard spelling.
- **Commits**: Conventional Commits, imperative mood, atomic. Backtick all code references in commit bodies. Use a single-quoted heredoc + `git commit -F` when the body contains backticks or special characters to avoid shell interpolation. Update `README.md`, `docs/game-parameters.md`, `app/public/manual.html`, and `SPEC.md` alongside any behaviour change they describe, in the same commit.
- **PR titles**: Human-readable, no Conventional Commit prefix. Start with a capital letter. Example: `TauriSimBridge — native Rust simulation via Tauri IPC Channel`, not `feat(p4-2): TauriSimBridge`.
- **PR merge**: Always `--no-ff`. Never squash. Merge commit format: `PR title (#N)\n\nPR body` — matches GitHub's "Pull request title and description" setting.
- **Pull request labels**: Apply at least one label when opening a PR. Available labels: `bug`, `enhancement`, `documentation`, `infrastructure` (CI/CD/tooling), `chore` (maintenance/housekeeping), `refactor`. Use `gh pr edit <number> --add-label "<label>"` after creation.
- The in-game manual is `app/public/manual.html`, opened via a modal iframe — keep it in sync with UI/behaviour changes.
