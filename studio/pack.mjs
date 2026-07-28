#!/usr/bin/env -S node
/**
 * Studio pack stage — turns stylized studio output into game-convention
 * sprite files.
 *
 * Copies each approved asset's `rich-pixel-48` render into
 * `studio/dist/assets/tiles/<subdir>/<game-name>.png`, mirroring the layout
 * of `app/public/assets/tiles/`. Wiring into the game is then a copy of
 * `dist/assets/` over `app/public/assets/` plus the tileAtlas changes — a
 * separate, explicitly gated step.
 *
 * Existing-name collisions are deliberate: road and power outputs REPLACE
 * the current 128 px sprites (160 px is the going-forward norm); rail and
 * crossing names are new.
 *
 * Usage: bun pack.mjs
 *
 * (c) Copyright 2026 Liminal HQ, Scott Morris
 * SPDX-License-Identifier: MIT
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname);
const OUT = path.join(ROOT, 'out');
const DIST = path.join(ROOT, 'dist/assets/tiles');
const PROFILE = 'rich-pixel-48';

const ROAD_VARIANTS = ['ns', 'ew', 'corner-ne', 'corner-nw', 'corner-se', 'corner-sw',
  't-nes', 't-esw', 't-nsw', 't-new', 'cross', 'end-n', 'end-e', 'end-s', 'end-w'];

/** scene output -> game sprite path (relative to assets/tiles/). */
const PACK = [
  ...ROAD_VARIANTS.map((v) => [`road-${v}`, `roads/road-${v}.png`]),
  ...ROAD_VARIANTS.map((v) => [`rail-${v}`, `rails/rail-${v}.png`]),
  ['crossing-ns', 'rails/rail-road-crossing-ns.png'],
  ['crossing-ew', 'rails/rail-road-crossing-ew.png'],
  ['power-ns', 'power/power-line-vertical.png'],
  ['power-ew', 'power/power-line-horizontal.png'],
  ['house', 'buildings/res-house-5.png'],
  ['house2', 'buildings/res-house-6.png'],
  ['house3', 'buildings/res-house-7.png'],
  ['shop', 'buildings/com-shop-4.png'],
  ['shop2', 'buildings/com-shop-5.png'],
  ['shop3', 'buildings/com-shop-6.png'],
  ['factory', 'buildings/ind-factory-3.png'],
  ['warehouse', 'buildings/ind-warehouse-1.png'],
  ['hightech', 'buildings/ind-high-tech-2.png'],
];

const manifest = { profile: PROFILE, tileSize: 160, sprites: {} };
let missing = 0;
for (const [scene, dest] of PACK) {
  const src = path.join(OUT, `look-${scene}-${PROFILE}.png`);
  const destPath = path.join(DIST, dest);
  try {
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.copyFile(src, destPath);
    manifest.sprites[dest] = { scene };
  } catch {
    console.error(`MISSING ${scene} (${src})`);
    missing++;
  }
}
await fs.writeFile(path.join(ROOT, 'dist/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Packed ${Object.keys(manifest.sprites).length} sprites into studio/dist/ (${missing} missing)`);
