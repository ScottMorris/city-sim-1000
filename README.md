# City Sim 1000

![City Sim 1000 banner](public/assets/readme-banner.png)

A browser-based, offline-ready city simulator built with TypeScript, Vite, and WebGL-powered rendering via PixiJS. Grow a skyline with roads, rail, hydro power, water pumps, zoning, trees, and parks while balancing demand and budget.

## Tech stack
- TypeScript + Vite
- PixiJS for WebGL rendering
- Vanilla CSS for UI
- Workbox-generated service worker (via `vite-plugin-pwa`) + PWA manifest for offline play

## Getting started

```bash
npm install
npm run dev
```

Then open the provided local URL. The service worker caches assets after first load so the game keeps running offline. Use `npm run build` for a production bundle.

### Testing on a phone (LAN dev loop)

```bash
npm run dev -- --host   # or: bun run dev --host
```

Vite prints an extra `Network:` URL — open it in the phone's browser (phone and desktop must be on the same network). Changes hot-reload on the phone just like on desktop.

To inspect the phone's tab from the desktop: enable **Developer options → USB debugging** on an Android phone, connect it over USB, and open `chrome://inspect` in desktop Chrome — the tab appears with full DevTools (console, profiler, remote screencast).

Pointer/touch debugging: in a dev build, run `localStorage.setItem('debug-pointer', '1')` in the console to log the pointer→tile mapping for every input event.

## Deployment
- GitHub Pages publishes to `https://scottmorris.github.io/city-sim-1000` via the `Deploy to GitHub Pages` workflow (runs on `main` pushes or manually).
- The Pages build sets `VITE_BASE=/city-sim-1000/` so assets resolve under the project path; local builds default to `/`. To preview locally with the Pages base, run `VITE_BASE=/city-sim-1000/ npm run build` then `npm run preview`.
- Enable Pages in repo settings with source “GitHub Actions”; the workflow uploads `dist` and deploys with `actions/deploy-pages`.

## Features
- WebGL canvas renderer with zoom and pan for fast navigation.
- Terraform tools for land, water, trees, parks, bulldozing, and infrastructure (roads, rail, power lines).
- Dedicated water services submenu that separates surface water from infrastructure; place pumps or water towers and connect them with underground pipes.
- Zoning for Residential, Commercial, and Industrial areas with live demand bars.
- Education submenu with Elementary and High Schools that need power, flood coverage along roads, and gently influence demand and decay when underserved.
- Soft over-zoning: pending zones only trim demand with caps/floors so big paint jobs trickle-build, and high demand can still break through.
- Labour-aware demand: aggregate unemployment and job vacancies nudge R/C/I demand without simulating individual citizens.
- Light decay: zone buildings slowly abandon under sustained low demand, no power, or unhappy tiles; abandoned lots auto-clear to zoned tiles and can regrow.
- Hydro generation, water pumping, and global utility balance that affects growth.
- Tool info card beside the tile inspector that surfaces cost, upkeep, and stats for the active tool with a pin toggle when you want it always-on.
- Budget ticker with a colour-coded monthly net projection, calendar month/day readout, population and jobs tracking, and happiness per tile. Open the Budget screen for a quarterly breakdown, detailed revenue/expense shares, runway, and narrative Insights (when enabled).
- Bylaws button in the status ribbon (next to Budget/Settings) to set a city-wide lighting standard that nudges power demand, upkeep, and happiness (district overrides are on the way).
- Wilderness score (0–100) in the status ribbon with a trend arrow and breakdown tooltip: contiguous forests/parks, waterfront greenery, and open land versus industry, transport, and power infrastructure. High scores attract residents and pay a tourism dividend; Bylaws offers Nature Reserve and Green Industry programmes, and the minimap gains a wilderness heatmap overlay.
- Narrative layer: a news ticker bar in the HUD plus Budget Insights commentary, both toggleable from Settings.
- Exact-state saves: browser save/load (IndexedDB) plus downloadable `.citysim` exports and uploads for backups. Saves carry the Rust engine's own snapshot, so a loaded city resumes precisely — buildings, clock, treasury, and RNG included. Legacy JSON saves still load and are upgraded automatically. On touch devices, exporting opens the OS share sheet (Web Share API) instead of a plain download, falling back to the download path when sharing isn't available.
- Manual available at `public/manual.html` covering controls and systems.
- Minimap in the bottom-right HUD: base map view plus power, water, alerts, education, wilderness, and underground overlay modes with click-to-jump navigation and viewport framing; the same mode tints the main map for quick at-a-glance status.
- Settings gear in the toolbar with over-zoning penalty toggle, narrative/news ticker toggles, minimap controls, input presets (invert pan, pan speed, Shift+scroll to pan, zoom sensitivity), radio volume, Gemini sprite toggle (off by default), and placeholders for edge scroll, hotkey remapping, and accessibility.
- Toolbar radio widget with emoji controls (previous/play/pause/next), a playlist icon button that opens a station dropdown, a scrolling marquee for artist/title, hover/focus popover for details, and an offline state when no playlist exists.

## Budget and economy
- Money updates every in-game day; the HUD shows the current month/day on a 30-day calendar and the ticker shows a projected net per month (green surplus, red deficit, neutral when flat). The Budget screen (from the HUD) shows quarterly totals, per-month net, cash runway, revenue/expense details, and narrative Insights when enabled.
- Revenue: a flat base stipend plus income from residents, commercial, and industrial zones, and a tourism dividend while the wilderness score stays above 60.
- Expenses: transport upkeep (roads/rail/lines/pipes) plus buildings (power plants, civic services, zone buildings). Budget history and breakdowns are saved with your city.
- City Ledger (the Budget screen) has live policy sliders: per-class tax rates (residential/commercial/industrial, 0–20%, neutral default 9%) and per-department funding levels (transport/power/civic, 0–100%, default 100%). Changes apply immediately — taxes above neutral raise revenue but cool demand, underfunded departments save upkeep but drag demand or brown out power.
- Revenue: base income plus per-population and per-zone contributions (commercial + industrial).
- Expenses: upkeep from transport tiles, power lines, and all buildings (plants, zones, parks, pumps/towers, future services).
- A power deficit halts new growth until restored; water is stubbed high until pipes ship.

## Radio assets (drop-in)
- Each station sits in its own folder under `public/audio/radio/<station>` with audio files, optional covers, and a local `playlist.json`. The toolbar reads `public/audio/radio/stations.json` to populate the playlist icon dropdown so multiple stations can coexist.
- Drop an optional `station.json` beside a playlist to give it a friendly `name` and `description`; the build script copies those fields into the generated manifest for the UI.
- Audio files should prefer Opus at 48 kHz (~64–96 kbps) with fallbacks (`.ogg`/`.mp3`) listed in `fallbackSrc`. Supply cover art in `public/audio/radio/covers/` (WebP/AVIF/PNG) so thumbnails appear in the toolbar and hover popover.
- Playback buttons keep using emoji controls; the marquee scrolls while playing and the hover/focus popover shows the current title/artist and cover art.
- Use `public/audio/radio/playlist.sample.json` as inspiration, then copy tracks into a station folder (see `public/audio/radio/sample/playlist.json`) and keep covers next to that station.
- Run `npm run build:radio-playlist` to scan station folders, write each `playlist.json`, convert covers, and emit `public/audio/radio/stations.json`. Flags are unchanged: `--meta <file>` for overrides, `--default-artist "Name"`, `--extract-embedded-covers`, `--force`, `--convert-opus` to transcode non-Opus sources, and `--dry-run`.

## Controls (quick reference)
- Pan: drag with mouse or use `WASD` / arrow keys; zoom with scroll/pinch.
- Quick bulldoze: right-click to bulldoze the tile under your cursor, or hold and drag to clear a path. Middle-click or Alt-drag still pans. The Inspect tool does not bulldoze on right-click.
- Tools: click toolbar buttons or hotkeys — Inspect (`I`), Raise (`E`), Lower (`Q`), Water paint (`F`), Trees (`T`), Road (`R`), Rail (`L`), Power Lines (`P`), Hydro (`H`), Pump (`U`), Tower (`Y`), Elementary School (`J`), High School (`N`), Residential (`Z`), Commercial (`X`), Industrial (`C`), Park (`K`), Bulldoze (`B`).
- Speed: `1` Slow (0.5x), `2` Fast (1x), `3` Ludicrous (3x); `Space` toggles pause (resumes at the last-selected speed).
- Undo/redo: `Ctrl/Cmd+Z` undoes the last action (a drag counts as one action); `Ctrl/Cmd+Shift+Z` or `Ctrl/Cmd+Y` redoes it. Undo rewinds the whole city — including the clock — to just before the action; history is per-session and stops at the last load.
- Inspector: select Inspect, click a tile to see utilities, status, and capacity; pin the tool info card to keep build stats visible.

## Offline & PWA
- `vite-plugin-pwa` (Workbox `generateSW` mode, configured in `vite.config.ts`) generates the service worker at build time from the real Vite build manifest, precaching JS/CSS/HTML/WASM/icons — radio audio (`public/audio/`) and the marketing images (`readme-banner.png`, `social-preview.png`) are excluded via `globIgnores`.
- `public/manifest.webmanifest` and icons let you install the game as a standalone experience.
- The radio widget only fetches its (small) playlist JSON on boot; the full audio/cover library is fetched lazily the first time the player presses play, so a fresh install/reload never pulls the whole radio library over the network.
- Regenerate the emoji favicon and PWA icons with `npm run build:favicon`; it draws the 🏙️ emoji onto a dark blue gradient for consistent branding.
