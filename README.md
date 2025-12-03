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

## Features
- WebGL canvas renderer with zoom and pan for fast navigation.
- Terraform tools for land, water, trees, parks, bulldozing, and infrastructure (roads, rail, power lines).
- Dedicated water services submenu that separates surface water from infrastructure; place pumps or water towers (pipes coming soon with an underground view).
- Zoning for Residential, Commercial, and Industrial areas with live demand bars.
- Soft over-zoning: pending zones only trim demand with caps/floors so big paint jobs trickle-build, and high demand can still break through.
- Hydro generation, water pumping, and global utility balance that affects growth.
- Tool info card beside the tile inspector that surfaces cost, upkeep, and stats for the active tool with a pin toggle when you want it always-on.
- Budget ticker with a colour-coded monthly net projection, calendar month/day readout, population and jobs tracking, and happiness per tile. Open the Budget screen for a quarterly breakdown, detailed revenue/expense shares, and runway.
- LocalStorage save/load plus downloadable JSON exports and uploads for backups.
- Manual available at `public/manual.html` covering controls and systems.
- Minimap in the bottom-right HUD: base map view with click-to-jump navigation and viewport framing; overlay modes coming soon.

## Budget and economy
- Money updates every in-game day; the HUD shows the current month/day on a 30-day calendar and the ticker shows a projected net per month (green surplus, red deficit, neutral when flat). The Budget screen (from the HUD) shows quarterly totals, per-month net, and cash runway based on your current burn, plus revenue/expense details.
- Revenue: a flat base stipend plus income from residents, commercial, and industrial zones.
- Expenses: transport upkeep (roads/rail/lines/pipes) plus buildings (power plants, civic services, zone buildings). Budget history and breakdowns are saved with your city.
- Revenue: base income plus per-population and per-zone contributions (commercial + industrial).
- Expenses: upkeep from transport tiles, power lines, and all buildings (plants, zones, parks, pumps/towers, future services).
- A power deficit halts new growth until restored; water is stubbed high until pipes ship.

## Controls (quick reference)
- Pan: drag with mouse or use `WASD` / arrow keys; zoom with scroll/pinch.
- Tools: click toolbar buttons or hotkeys — Inspect (`I`), Raise (`E`), Lower (`Q`), Water paint (`F`), Trees (`T`), Road (`R`), Rail (`L`), Power Lines (`P`), Hydro (`H`), Pump (`U`), Tower (`Y`), Residential (`Z`), Commercial (`X`), Industrial (`C`), Park (`K`), Bulldoze (`B`).
- Speed: `1` Slow (0.5x), `2` Fast (1x), `3` Ludicrous (3x).
- Inspector: select Inspect, click a tile to see utilities, status, and capacity; pin the tool info card to keep build stats visible.

## Offline & PWA
- `public/service-worker.js` caches core pages and dynamically caches other assets.
- `public/manifest.webmanifest` and icons let you install the game as a standalone experience.
