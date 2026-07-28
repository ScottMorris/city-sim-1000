#!/usr/bin/env -S node
/**
 * Contact sheet for the kerbside hydro family.
 *
 * These overlays only ever appear on top of a carriageway, so judging them on
 * a transparent background is judging the wrong thing — what matters is
 * whether the pole clears the asphalt and whether the wires still meet their
 * neighbours. This composites each variant over the road (or rail) it is
 * built for, and repeats the tile 3x3 so the seams are visible.
 *
 * Usage: bun review-hydro.mjs [along-ns|along-ew|junction|crossing]
 *
 * (c) Copyright 2026 Liminal HQ, Scott Morris
 * SPDX-License-Identifier: MIT
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(import.meta.dirname, 'out');
const TILES = path.join(ROOT, 'app/public/assets/tiles');
const T = 160;
const FAMILY = process.argv[2] ?? 'along-ns';

const BASES = ['ns', 'ew', 'corner-ne', 'corner-nw', 'corner-se', 'corner-sw',
  't-nes', 't-esw', 't-nsw', 't-new', 'cross', 'end-n', 'end-e', 'end-s', 'end-w', 'isolated'];

/** The carriageway each family sits on, and the sprite that draws it. */
const ROAD = {
  'along-ns': 'roads/road-ns.png',
  'along-ew': 'roads/road-ew.png',
  junction: 'roads/road-cross.png',
  crossing: 'roads/road-ew.png'
};

const variants = FAMILY === 'crossing'
  ? ['crossing-ns', 'crossing-ew']
  : BASES.map((b) => `${FAMILY}-${b}`);

const cols = Math.min(6, variants.length);
const rows = Math.ceil(variants.length / cols);
const cell = T * 3;                 // 3x3 repeat per variant
const pad = 26;
const canvas = createCanvas(cols * (cell + pad) + pad, rows * (cell + pad + 22) + pad);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#1b1f1a';
ctx.fillRect(0, 0, canvas.width, canvas.height);

const road = await loadImage(path.join(TILES, ROAD[FAMILY]));
let placed = 0;
for (const [i, variant] of variants.entries()) {
  const file = path.join(OUT, `look-power-${variant}-rich-pixel-48-overlay.png`);
  let wires;
  try {
    wires = await loadImage(file);
  } catch {
    console.error(`MISSING ${variant}`);
    continue;
  }
  const ox = pad + (i % cols) * (cell + pad);
  const oy = pad + Math.floor(i / cols) * (cell + pad + 22);
  // 3x3 of carriageway, then 3x3 of wires, so a leg that stops short of the
  // edge shows up as a break at the seam rather than hiding inside one tile.
  for (const layer of [road, wires]) {
    for (let ty = 0; ty < 3; ty++) {
      for (let tx = 0; tx < 3; tx++) ctx.drawImage(layer, ox + tx * T, oy + ty * T, T, T);
    }
  }
  ctx.fillStyle = '#cfe0c8';
  ctx.font = '15px sans-serif';
  ctx.fillText(variant, ox, oy + cell + 16);
  placed++;
}

const dest = path.join(OUT, `review-hydro-${FAMILY}.png`);
await fs.writeFile(dest, canvas.toBuffer('image/png'));
console.log(`${placed}/${variants.length} -> ${dest}`);
