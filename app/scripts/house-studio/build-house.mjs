#!/usr/bin/env -S node
/**
 * House asset studio — prototype pass.
 *
 * Composes a house from parametric primitives (primitives.mjs), backgrounds
 * it with the real grass.png texture (same point-sampling technique as
 * build-park-assets.mjs), and rasterizes to PNG for visual review.
 *
 * This is a prototype script, not yet wired into the game's asset pipeline —
 * goal is to validate the primitive approach before building an interactive
 * studio around it.
 *
 * (c) Copyright 2026 Liminal HQ, Scott Morris
 * SPDX-License-Identifier: MIT
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CELL_PX,
  GRID_SIZE,
  makeGrid,
  ovalBase,
  paintBuilding,
  chimney,
  window_,
  door,
  bush,
  stonePath,
  rgbToHsl,
  hslToRgb,
} from './primitives.mjs';

const GRASS_PNG = path.resolve('public/assets/tiles/terrain/grass.png');
const OUT_DIR = path.resolve('../house-studio-out');

const GROUND_COLOUR = '#3f7a2d'; // placeholder ground fill, swapped for real grass below

async function sampleGrassGrid(gridSize) {
  const image = await loadImage(GRASS_PNG);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);
  const cellW = image.width / gridSize;
  const cellH = image.height / gridSize;
  const grid = [];
  for (let row = 0; row < gridSize; row++) {
    const rowColours = [];
    for (let col = 0; col < gridSize; col++) {
      const x = Math.floor((col + 0.5) * cellW);
      const y = Math.floor((row + 0.5) * cellH);
      const i = (y * image.width + x) * 4;
      rowColours.push(rgbToHex(data[i], data[i + 1], data[i + 2]));
    }
    grid.push(rowColours);
  }
  return grid;
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hexToRgb(hex) {
  return [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((h) => parseInt(h, 16));
}

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Dither jitter, HSL-space: perturbs lightness only (never touches hue or
 * saturation), plus a small always-non-negative saturation nudge. Jittering
 * R/G/B independently (the original approach) desaturates dark/saturated
 * colours over many cells — clamping at 0 biases low channels upward more
 * than high channels, dragging the average toward grey.
 */
function jitterColour(hex, seed, magnitude = 0.07) {
  const hash = fnv1a(seed);
  const lDelta = ((hash & 0xff) / 255 - 0.5) * 2 * magnitude;
  const sBoost = (((hash >>> 8) & 0xff) / 255) * 0.05;
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const [nr, ng, nb] = hslToRgb(h, Math.max(0, Math.min(1, s + sBoost)), Math.max(0, Math.min(1, l + lDelta)));
  return rgbToHex(clampByte(nr), clampByte(ng), clampByte(nb));
}

function gridToPng(grid, gridSize, cellPx) {
  const px = gridSize * cellPx;
  const canvas = createCanvas(px, px);
  const ctx = canvas.getContext('2d');
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const colour = grid[row][col];
      if (!colour) continue;
      ctx.fillStyle = colour;
      ctx.fillRect(col * cellPx, row * cellPx, cellPx, cellPx);
    }
  }
  return canvas.toBuffer('image/png');
}

/** Build one house recipe onto a fresh grid. */
function composeHouse(recipe) {
  const grid = makeGrid(GRID_SIZE);
  const p = recipe.palette;

  // Ground fill (placeholder — real grass swapped in below).
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) grid[row][col] = GROUND_COLOUR;
  }

  // Oval dirt/path base.
  ovalBase(grid, 16, 27, 13, 3.5, GROUND_COLOUR, p.outline);

  // One continuous rounded silhouette: roof + wall, split by a diagonal
  // ridge/shading gradient instead of a hard seam between panels.
  paintBuilding(grid, {
    x0: 4, y0: 6, w: 24, roofH: 12, wallH: 12,
    apexOffsetCols: recipe.apexOffset ?? -1,
    ridgeShiftCols: recipe.ridgeShift ?? 2,
    roofLight: p.roof, roofShade: p.roofDark,
    wallHighlight: p.wallHighlight, wallDark: p.wallDark,
    bandHeight: recipe.bandHeight ?? 2,
    outline: p.outline,
  });

  // Chimney, offset toward the lit roof plane.
  chimney(grid, 8, 2, 4, 8, p.chimneyLight, p.chimneyDark, p.outline);

  // Window on the front wall.
  window_(grid, 20, 19, 5, 5, p.glassLight, p.glassDark, p.outline);

  // Door + step.
  door(grid, 20, 23, 5, 6, p.door, p.knob, p.outline, p.step);

  // Stone path leading away from the step.
  stonePath(grid, 24, 29, 5, p.step, p.outline);

  // Bush accent.
  if (recipe.hasBush) bush(grid, 12, 27, 2.5, p.bush, p.outline);

  return grid;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const grassGrid = await sampleGrassGrid(GRID_SIZE);

  const recipes = JSON.parse(await fs.readFile(path.resolve('./scripts/house-studio/recipes.json'), 'utf8'));

  for (const recipe of recipes) {
    const grid = composeHouse(recipe);

    // Swap ground-colour cells for the real grass texture + jitter everything else.
    for (let row = 0; row < GRID_SIZE; row++) {
      for (let col = 0; col < GRID_SIZE; col++) {
        const colour = grid[row][col];
        if (colour === GROUND_COLOUR) {
          grid[row][col] = grassGrid[row][col];
        } else if (colour !== recipe.palette.outline) {
          grid[row][col] = jitterColour(colour, `${recipe.name}:${row}:${col}`, 0.06);
        }
      }
    }

    const png = gridToPng(grid, GRID_SIZE, CELL_PX);
    const outPath = path.join(OUT_DIR, `${recipe.name}.png`);
    await fs.writeFile(outPath, png);
    console.log(`Wrote ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
