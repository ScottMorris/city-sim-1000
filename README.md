# City Sim 1000

A browser-based, offline-ready city simulator built with TypeScript, Vite, and WebGL-powered rendering via PixiJS. Grow a skyline with roads, rail, hydro power, water pumps, zoning, trees, and parks while balancing demand and budget.

## Getting started

```bash
npm install
npm run dev
```

Then open the provided local URL. The service worker caches assets after first load so the game keeps running offline. Use `npm run build` for a production bundle.

## Features
- WebGL canvas renderer with zoom and pan for fast navigation.
- Terraform tools for land, water, trees, parks, bulldozing, and infrastructure (roads, rail, power lines).
- Zoning for Residential, Commercial, and Industrial areas with live demand bars.
- Hydro generation, water pumping, and global utility balance that affects growth.
- Budget ticker, population and jobs tracking, and happiness per tile.
- LocalStorage save/load plus downloadable JSON exports and uploads for backups.
- Manual available at `public/manual.html` covering controls and systems.

## Offline & PWA
- `public/service-worker.js` caches core pages and dynamically caches other assets.
- `public/manifest.webmanifest` and icons let you install the game as a standalone experience.
