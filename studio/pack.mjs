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

// Hydro also has a pole with nothing attached, and three kerbside families —
// one per carriageway situation — where the pole stands clear of the traffic
// lane instead of in it. Named for the carriageway's axis, not the line's.
const HYDRO_VARIANTS = [...ROAD_VARIANTS, 'isolated'];
const KERBSIDE = ['along-ns', 'along-ew', 'junction'];

/** A straight line square across the carriageway is carried on two poles
 *  (`power-line-<axis>-crossing.png`), so it has no kerbside twin. */
const isSquareCrossing = (cls, variant) =>
  (variant === 'ns' || variant === 'ew') &&
  (cls === 'junction' || (cls === 'along-ns') === (variant === 'ew'));

/** scene output -> game sprite path (relative to assets/tiles/). */
const PACK = [
  ...ROAD_VARIANTS.map((v) => [`road-${v}`, `roads/road-${v}.png`]),
  ...ROAD_VARIANTS.map((v) => [`rail-${v}`, `rails/rail-${v}.png`]),
  ['crossing-ns', 'rails/rail-road-crossing-ns.png'],
  ['crossing-ew', 'rails/rail-road-crossing-ew.png'],
  ...ROAD_VARIANTS.map((v) => [`power-${v}`, `power/power-line-${v}.png`]),
  // Transparent twins the renderer composites over road/rail/zone tiles.
  ...ROAD_VARIANTS.map((v) => [`power-${v}`, `power/power-line-${v}-overlay.png`, 'overlay']),
  // Two-pole twins, for a line crossing a road/rail rather than running in it.
  // Their own scenes: the E-W spans are rebuilt to peak at the two poles.
  ['power-crossing-ns', 'power/power-line-ns-crossing.png', 'overlay'],
  ['power-crossing-ew', 'power/power-line-ew-crossing.png', 'overlay'],
  // A pole with nothing attached, instead of a 4-way cross wired to nothing.
  ['power-isolated', 'power/power-line-isolated.png'],
  ['power-isolated', 'power/power-line-isolated-overlay.png', 'overlay'],
  // The kerbside families: every variant that is not a square crossing, once
  // per carriageway situation, with the pole moved out of the traffic lane.
  ...KERBSIDE.flatMap((cls) => HYDRO_VARIANTS
    .filter((v) => !isSquareCrossing(cls, v))
    .map((v) => [`power-${cls}-${v}`, `power/power-line-${v}-${cls}.png`, 'overlay'])),
  ['house', 'buildings/res-house-5.png'],
  ['house2', 'buildings/res-house-6.png'],
  ['house3', 'buildings/res-house-7.png'],
  ['shop', 'buildings/com-shop-4.png'],
  ['shop2', 'buildings/com-shop-5.png'],
  ['shop3', 'buildings/com-shop-6.png'],
  ['factory', 'buildings/ind-factory-3.png'],
  ['warehouse', 'buildings/ind-warehouse-1.png'],
  ['hightech', 'buildings/ind-high-tech-2.png'],
  ['factory2', 'buildings/ind-factory-4.png'],
  ['factory3', 'buildings/ind-factory-5.png'],
  ['office1', 'buildings/office-1.png'],
  ['office2', 'buildings/office-2.png'],
  ['office3', 'buildings/office-3.png'],
];

const manifest = { profile: PROFILE, tileSize: 160, sprites: {} };
let missing = 0;
for (const [scene, dest, kind] of PACK) {
  const suffix = kind === 'overlay' ? '-overlay' : '';
  const src = path.join(OUT, `look-${scene}-${PROFILE}${suffix}.png`);
  const destPath = path.join(DIST, dest);
  try {
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.copyFile(src, destPath);
    manifest.sprites[dest] = kind ? { scene, [kind]: true } : { scene };
  } catch {
    console.error(`MISSING ${scene} (${src})`);
    missing++;
  }
}
await fs.writeFile(path.join(ROOT, 'dist/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Packed ${Object.keys(manifest.sprites).length} sprites into studio/dist/ (${missing} missing)`);
