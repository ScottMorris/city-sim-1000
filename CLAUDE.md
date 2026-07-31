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
bun run test                   # vitest run (singleThread baked in — never needs a parallelism flag)
bun run test -- app/src/game/economy.test.ts  # run a single test file
bun run build:favicon          # regenerate PWA icons/favicon from the 🏙️ emoji
bun run build:radio-playlist   # scan app/public/audio/radio/<station> folders, emit playlist.json/stations.json
bun run build:wasm             # compile crates/city-sim-wasm → app/src/wasm/sim_wasm/ (run after Rust changes)
```

**Important:** `app/src/wasm/` is gitignored (generated output). Run `bun run build:wasm` once after a fresh clone before `bun run dev` or `bun run build`, otherwise the WASM Worker will fail to load. There is no longer a pure-TS fallback — WASM is the required browser runtime since P5-4. `bun run test` no longer needs it: the cross-engine parity harness that loaded the real `SimHost` cdylib out of `app/src/wasm/` was retired with the TS oracle (see the Simulation note below), and no test file touches the built WASM artifacts.

**Also after a fresh clone/worktree:** `crates/tauri-plugin-city-sim/dist-js/` is gitignored too — run `bun run build` inside `crates/tauri-plugin-city-sim` once, or the Vite dev server fails to resolve the `tauri-plugin-city-sim` package import in `tauriSimBridge.ts`.

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
`main.ts` is the entry point and composition root: it builds the HUD DOM by string, wires up pointer/keyboard/wheel input, owns the single `GameState` instance, and drives `requestAnimationFrame(gameLoop)`. The rAF loop is render-only — engines drive their own clocks (the WASM worker via a 20 Hz interval that keeps running in hidden tabs, the Tauri plugin via its native thread). Each frame: apply camera pan, `bridge.step(dt)` (flushes the latest engine update into the display mirror), advance narrative on month boundaries, then render (`MapRenderer`, `hud`, `minimap`, `newsTicker`, `debugOverlay`). There is no separate "controller" layer — input handlers in `main.ts` call `bridge.send(applyToolCmd(...))` and read state through `bridge.getState()`.

### SimBridge (`app/src/game/simBridge.ts`, `wasmSimBridge.ts`, `tauriSimBridge.ts`)
All simulation access goes through the `SimBridge` interface: `step`, `send`, `onMessage`, `getState`, `getSnapshot`, `loadSnapshot`, `importLegacy`, `newCity`, `setSpeed`, `undo`, `redo`, `canUndo`, `canRedo`, `dispose`. `WasmSimBridge` routes through a Web Worker running a WASM `SimHost` (default browser path — requires `bun run build:wasm`). `TauriSimBridge` routes through `tauri-plugin-city-sim` — auto-detected via `window.__TAURI_INTERNALS__` or forced with `?bridge=tauri`. The active bridge is chosen at startup in `main.ts`. `LocalSimBridge` has been removed (P5-4); `simulation.ts`, the TS parity oracle it once ran on, has been removed too (its last version is preserved at commit `1f8140a`).

### State (`app/src/game/gameState.ts`)
`GameState` is one large serializable object: a flat tile grid, utility stats, demand stats, budget stats, settings (minimap/input/accessibility/audio/hotkeys/cosmetics/narrative), bylaws, and building/service sub-states. `Tile` mirrors Rust's stratum model field-for-field — `terrain` (`Land`/`Water`) plus `underground`/`surface`/`overhead` occupant bitsets (`protocol/occupants.ts`'s `Occupant` enum: pipes, road, rail, zone tags, structure, power line, trees), not a single `kind` field — see `docs/tile-model.md`. Tiles reference buildings and power plants by id rather than embedding them. `TileKind` survives only as a building-template key (`buildings/templates.ts`) and in the legacy save-format translation layer (`protocol/legacyProjection.ts`), not as a per-tile field. Settings have `createDefault*` factory functions in this file that `main.ts`'s `ensureSettingsShape` merges over loaded saves, so new settings fields must get a default factory here or old saves break.

### Simulation (`crates/city-sim-core/`)
Production simulation runs in Rust; it is the sole engine and the sole spec. The browser/desktop clients send `SimCommand`s to the real Rust engine over the WASM/Tauri bridge. `simulation.ts`, the TS parity oracle that once mirrored it for tests, has been removed — its last version is preserved at commit `1f8140a` (`git show 1f8140a:app/src/game/simulation.ts`). The TS "shadow engine" that oracle drove (`tools.ts`'s `applyTool`, `buildings/manager.ts`, `utilities/power.ts`) was removed with it; the last version of that code is preserved at the same commit. `adjacency.ts` provides zone/network-carrier predicates (`isZone`, `isPowerCarrier`, `isWaterCarrier`) used by the renderer and UI.

### Protocol (`app/src/game/protocol/`)
TS mirror of `crates/city-sim-protocol` — `TileKind ↔ u8` mapping (template-key/legacy-save use only), `SimCommand`, `FromSim`, tile buffer SoA offsets. The live wire buffer (`tileBuffer.ts`) carries occupant bits directly, one byte per stratum (9 bytes/tile); the frozen v4 layout old `.citysim` saves use lives separately in `legacyTileBuffer.ts` (8 bytes/tile) and never changes. `tileKindParity.json` is generated by `cargo test dump_parity_json` and validated by the parity test suite.

### Tools (`app/src/game/toolTypes.ts`)
Every player action sends a `SimCommand::ApplyTool` to the Rust engine via `bridge.send(applyToolCmd(tool, x, y, strokeId))` from `main.ts`; placement rules (cost, road access, overwrite/clear semantics) live in `crates/city-sim-core/src/commands.rs`'s `apply_tool`. The TS side keeps only `getToolCost` (`app/src/game/buildings/templates.ts`) for HUD/toolbar display cost.

### Buildings (`app/src/game/buildings/`)
`templates.ts` defines static building specs (and `getToolCost` for UI display), `state.ts` defines runtime `BuildingInstance`. Placement and per-tick status updates run in the Rust engine; there is no TS-side building manager.

### Narrative layer (`app/src/game/narrative/`)
Decoupled from simulation via events: the active `SimBridge` emits `SimEvent`s, `NarrativeManager` buffers them through an `EventJournal`, and per-channel rules turn events + periodic `CitySnapshot`s into ticker items / budget insight text. Entirely optional/toggleable via `state.settings.narrative`.

### Rendering (`app/src/rendering/`)
`MapRenderer` (`renderer.ts`) owns the PixiJS `Application`/canvas and draws the tile grid each frame from `GameState`. `camera.ts` converts screen↔tile coordinates and holds pan/zoom state (not persisted).

### UI (`app/src/ui/`)
Each file is a self-contained DOM module exposing an `init*`/`create*` factory. No shared UI framework — modules talk to `main.ts` via the callbacks passed in.

### Persistence (`app/src/game/persistence.ts`)
Saves are binary CSAV containers: `"CSAV" | version | meta JSON | engine snapshot (CSIM postcard from `SimHost.get_snapshot`) | client JSON (`ClientState` — settings/bylaws, see `clientState.ts`)`. Browser saves live in IndexedDB (`saveStore.ts`); downloads are `.citysim` files. `serialize`/`deserialize` remain as the legacy JSON path — old saves are sniffed by magic, back-filled by `deserialize`, and imported exactly into the engine via `buildLegacyEngineImport` + `SimHost.import_legacy`. When adding a client-owned state field, extend `ClientState`; engine-owned fields belong in the Rust `GameState` (bump the CSIM snapshot version).

### Radio (`app/scripts/build-radio-playlist.ts`, `app/src/ui/radio*.ts`)
Each station lives under `app/public/audio/radio/<station>/` with audio files + optional `station.json`/covers; the build script scans these folders and writes `playlist.json` per station plus a top-level `stations.json` manifest.

## Conventions

**`AGENTS.md` is the authoritative, fuller source for everything in this section** — commit/PR mechanics, git safety (reflog/gc bans), mutation testing, licence headers. Read it before your first commit in this repo; what follows is a summary, not a substitute.

- **Canadian English** in code comments, docs, and identifiers where not constrained by a web standard: *colour, centre, licence (noun), organise, behaviour, favour*. CSS/DOM properties (`color`, `center`) keep their standard spelling.
- **Commits**: Conventional Commits (`type(scope): imperative summary`, e.g. `refactor(sim): ...`, `fix(ui): ...`), imperative mood, atomic. **Backtick every code reference in the body — type names, function names, file paths, flags, CLI commands, module names — with no exceptions.** Before running `git commit`, reread the drafted body once specifically hunting for un-backticked identifiers; it is the single most common mistake in this repo's commits. Example:
  ```
  refactor(sim): fork the legacy save-import wire layout off the live tile buffer

  Legacy `.citysim` JSON saves are encoded against the current `kind`+`flags`
  shape, so `import.rs` now decodes a frozen `legacy_tile_buffer` module
  instead of the live `tile_buffer`. No behaviour change: `cargo test
  --workspace` passes unchanged.
  ```
  Use a single-quoted heredoc + `git commit -F` when the body contains backticks or special characters to avoid shell interpolation, then verify with `git log -1 --pretty=fuller` and amend immediately if interpolation altered content. Update `README.md`, `docs/game-parameters.md`, `app/public/manual.html`, and `SPEC.md` alongside any behaviour change they describe, in the same commit.
- **PR titles**: Human-readable, no Conventional Commit prefix. Start with a capital letter. Example: `TauriSimBridge — native Rust simulation via Tauri IPC Channel`, not `feat(p4-2): TauriSimBridge`. Do not mention internal planning docs or milestone shorthand (e.g. `M0-3`) in the title.
- **PR descriptions**: `## Summary` (flat bullets, bold lead-ins) + optional `###` subsections (`User-facing changes`, `Maintainer-facing changes`, `Packaging`, `Workflow and infrastructure`, `Documentation`, `Known limitations`) + `## Test plan` (checklist bullets, concrete commands, explicit gaps if verification is incomplete).
- **PR merge**: Always `--no-ff`. Never squash. Merge commit format: `PR title (#N)\n\nPR body` — matches GitHub's "Pull request title and description" setting.
- **Pull request labels**: Apply at least one label when opening a PR. Available labels: `bug`, `enhancement`, `documentation`, `infrastructure` (CI/CD/tooling), `chore` (maintenance/housekeeping), `refactor`. Use `gh pr edit <number> --add-label "<label>"` after creation.
- **Issue closing**: a PR that fully resolves a tracked issue uses `Fixes #N`/`Closes #N` in its body. In a multi-PR stack against one issue, earlier PRs reference it without a closing keyword (`Part of #N`) but the *final* PR does use the keyword, so merging it auto-closes the issue — verify with `gh issue view <N> --json state` rather than assuming. See `AGENTS.md`.
- **Branch naming**: Every new branch takes a Conventional-Commit-style type prefix — `feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`, `infra/` — plus a kebab-case description (e.g. `fix/bulldoze-underground-view`). No exceptions for stacked branches; pre-rule branches are grandfathered.
- **Git workflow**: Do not push or force-push, and do not commit local planning/scratch files, unless explicitly requested by the user.
- **Markdown formatting**: Do not manually hard-wrap prose — write each paragraph as one line and let the renderer/editor soft-wrap.
- The in-game manual is `app/public/manual.html`, opened via a modal iframe — keep it in sync with UI/behaviour changes.
