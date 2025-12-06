# City Sim 1000

A browser-based, offline-ready city simulator built with TypeScript, Vite, and WebGL-powered rendering via PixiJS. Grow a skyline with roads, rail, hydro power, water pumps, zoning, trees, and parks while balancing demand and budget.

## Tech stack
- TypeScript + Vite
- PixiJS for WebGL rendering
- Vanilla CSS for UI
- Service worker + PWA manifest for offline play

## Getting started

```bash
npm install
npm run dev
```

Then open the provided local URL. The service worker caches assets after first load so the game keeps running offline. Use `npm run build` for a production bundle.

## Deployment
- GitHub Pages publishes to `https://scottmorris.github.io/city-sim-1000` via the `Deploy to GitHub Pages` workflow (runs on `main` pushes or manually).
- The Pages build sets `VITE_BASE=/city-sim-1000/` so assets resolve under the project path; local builds default to `/`. To preview locally with the Pages base, run `VITE_BASE=/city-sim-1000/ npm run build` then `npm run preview`.
- Enable Pages in repo settings with source “GitHub Actions”; the workflow uploads `dist` and deploys with `actions/deploy-pages`.

## Features
- WebGL canvas renderer with zoom and pan for fast navigation.
- Terraform tools for land, water, trees, parks, bulldozing, and infrastructure (roads, rail, power lines).
- Dedicated water services submenu that separates surface water from infrastructure; place pumps or water towers (pipes coming soon with an underground view).
- Zoning for Residential, Commercial, and Industrial areas with live demand bars.
- Education submenu with Elementary and High Schools that need power, flood coverage along roads, and gently influence demand and decay when underserved.
- Soft over-zoning: pending zones only trim demand with caps/floors so big paint jobs trickle-build, and high demand can still break through.
- Labour-aware demand: aggregate unemployment and job vacancies nudge R/C/I demand without simulating individual citizens.
- Light decay: zone buildings slowly abandon under sustained low demand, no power, or unhappy tiles; abandoned lots auto-clear to zoned tiles and can regrow.
- Hydro generation, water pumping, and global utility balance that affects growth.
- Tool info card beside the tile inspector that surfaces cost, upkeep, and stats for the active tool with a pin toggle when you want it always-on.
- Budget ticker with a colour-coded monthly net projection, calendar month/day readout, population and jobs tracking, and happiness per tile. Open the Budget screen for a quarterly breakdown, detailed revenue/expense shares, and runway.
- LocalStorage save/load plus downloadable JSON exports and uploads for backups.
- Manual available at `public/manual.html` covering controls and systems.
- Minimap in the bottom-right HUD: base map view plus power, water, and alerts overlay modes with click-to-jump navigation and viewport framing; the same mode tints the main map for quick at-a-glance status.
- Settings gear in the toolbar with over-zoning penalty toggle, minimap controls, input presets (invert pan, pan speed, Shift+scroll to pan, zoom sensitivity), radio volume, Gemini sprite toggle (off by default), and placeholders for edge scroll, hotkey remapping, and accessibility.
- Toolbar radio widget with emoji controls (previous/play/pause/next), a scrolling marquee for artist/title, hover/focus popover for details, and an offline state when no playlist exists.

## Budget and economy
- Money updates every in-game day; the HUD shows the current month/day on a 30-day calendar and the ticker shows a projected net per month (green surplus, red deficit, neutral when flat). The Budget screen (from the HUD) shows quarterly totals, per-month net, and cash runway based on your current burn, plus revenue/expense details.
- Revenue: a flat base stipend plus income from residents, commercial, and industrial zones.
- Expenses: transport upkeep (roads/rail/lines/pipes) plus buildings (power plants, civic services, zone buildings). Budget history and breakdowns are saved with your city.
- Revenue: base income plus per-population and per-zone contributions (commercial + industrial).
- Expenses: upkeep from transport tiles, power lines, and all buildings (plants, zones, parks, pumps/towers, future services).
- A power deficit halts new growth until restored; water is stubbed high until pipes ship.

## Radio assets (drop-in)
- Put audio files in `public/audio/radio/` (prefer Opus at 48 kHz, ~64–96 kbps). Add fallbacks like `.ogg`/`.mp3` only if you need broader browser coverage.
- Create `public/audio/radio/playlist.json` with a `version` string and `tracks` array of `{ id, title, artist, src, cover?, duration?, loudnessLufs?, loop?, fallbackSrc? }`. The radio loads this JSON on start and cycles tracks; missing or empty playlists leave the widget in “Radio offline”.
- Optional covers live in `public/audio/radio/covers/` (WebP/AVIF/PNG). If a track declares `cover`, a tiny thumbnail appears in the toolbar and the hover popover shows a larger preview; no cover means no image shown.
- Playback buttons use emoji to save space; the marquee pauses while paused and resets on track changes. Hover/focus reveals a compact popover for more detail without changing toolbar height.
- Use `public/audio/radio/playlist.sample.json` as a starter; copy it to `playlist.json` and swap in your own filenames once you drop audio and cover files.
- To fill `loudnessLufs`, measure each track with `ffmpeg -i track.opus -filter_complex ebur128=peak=true -f null -` and read the “Integrated loudness” value (in LUFS) from stderr; target roughly -14 LUFS so tracks feel even.
- Auto-generate the playlist and covers with `npm run build:radio-playlist` (requires `ffmpeg`/`ffprobe` in PATH). It reads embedded tags for title/artist when available. Flags: `--meta <file>` for per-track overrides, `--default-artist "Name"`, `--extract-embedded-covers` to pull art from audio when no external cover exists, `--force` to rebuild covers, `--dry-run` to print JSON only.

## Controls (quick reference)
- Pan: drag with mouse or use `WASD` / arrow keys; zoom with scroll/pinch.
- Tools: click toolbar buttons or hotkeys — Inspect (`I`), Raise (`E`), Lower (`Q`), Water paint (`F`), Trees (`T`), Road (`R`), Rail (`L`), Power Lines (`P`), Hydro (`H`), Pump (`U`), Tower (`Y`), Elementary School (`J`), High School (`N`), Residential (`Z`), Commercial (`X`), Industrial (`C`), Park (`K`), Bulldoze (`B`).
- Speed: `1` Slow (0.5x), `2` Fast (1x), `3` Ludicrous (3x).
- Inspector: select Inspect, click a tile to see utilities, status, and capacity; pin the tool info card to keep build stats visible.

## Offline & PWA
- `public/service-worker.js` caches core pages and dynamically caches other assets.
- `public/manifest.webmanifest` and icons let you install the game as a standalone experience.
- Regenerate the emoji favicon and PWA icons with `npm run build:favicon`; it draws the 🏙️ emoji onto a dark blue gradient for consistent branding.
