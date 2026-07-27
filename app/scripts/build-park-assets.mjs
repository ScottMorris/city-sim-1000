#!/usr/bin/env -S node
/**
 * Build the Park Small/Large tile assets.
 *
 * Takes the hand-drawn park-tiles source SVGs (10px-per-art-pixel rect grids)
 * and swaps their flat "plain lawn" fill colour for a sampled, dithered patch
 * of the game's real grass texture (assets/tiles/terrain/grass.png), so the
 * ground reads consistently with every other tile. Everything else in the
 * source art (tree canopies, fountain, bench, path, outlines) is left as-is.
 *
 * Emits both the composited SVG sources (for future edits) and the final
 * rasterized PNGs shipped in public/assets/tiles/buildings/.
 *
 * (c) Copyright 2026 Liminal HQ, Scott Morris
 * SPDX-License-Identifier: MIT
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const CELL_PX = 10; // native scale of the source art: 1 art-pixel = 10 raster px
const GRASS_GRID_SIZE = 16; // grass.png sampled into a 16x16 tileable grid

// The two flat lawn fill colours used across both source SVGs.
const GROUND_COLORS = new Set(['#4f8a3d', '#5c9c48']);

// Pure black outline/linework — never dithered, so silhouettes stay crisp.
const OUTLINE_COLOR = '#14141f';

// Per-channel jitter range applied to every non-ground, non-outline cell so
// props (fountain, bench, tree canopy, flowers) pick up the same dithered,
// noisy look as the grass instead of reading as flat colour blocks.
const PROP_JITTER = 14;

const ASSETS_DIR = path.resolve('scripts/assets');
const RAW_DIR = path.join(ASSETS_DIR, 'raw');
const BUILDINGS_DIR = path.resolve('public/assets/tiles/buildings');
const GRASS_PNG = path.resolve('public/assets/tiles/terrain/grass.png');

const TARGETS = [
  { rawFile: 'park-small-source.svg', gridCells: 16, svgOut: 'park-small.svg', pngOut: 'park-small.png' },
  { rawFile: 'park-large-source.svg', gridCells: 32, svgOut: 'park-large.svg', pngOut: 'park-large.png' }
];

async function main() {
  const grassGrid = await sampleGrassGrid();
  await writeGrassTextureSvg(grassGrid);

  for (const target of TARGETS) {
    const rawPath = path.join(RAW_DIR, target.rawFile);
    const rawSvg = await fs.readFile(rawPath, 'utf8');
    const grid = parseRectsToGrid(rawSvg, target.gridCells);

    for (let row = 0; row < target.gridCells; row++) {
      for (let col = 0; col < target.gridCells; col++) {
        const colour = grid[row][col];
        if (!colour) continue;
        if (GROUND_COLORS.has(colour)) {
          grid[row][col] = grassGrid[row % GRASS_GRID_SIZE][col % GRASS_GRID_SIZE];
        } else if (colour !== OUTLINE_COLOR) {
          grid[row][col] = jitterColor(colour, `${target.rawFile}:${row}:${col}`);
        }
      }
    }

    const svgOutPath = path.join(ASSETS_DIR, target.svgOut);
    await fs.writeFile(svgOutPath, gridToSvg(grid, target.gridCells));
    console.log(`Wrote ${path.relative(process.cwd(), svgOutPath)}`);

    const pngBuffer = gridToPng(grid, target.gridCells);
    const pngOutPath = path.join(BUILDINGS_DIR, target.pngOut);
    await fs.writeFile(pngOutPath, pngBuffer);
    console.log(`Wrote ${path.relative(process.cwd(), pngOutPath)}`);
  }
}

/**
 * Sample grass.png into a GRASS_GRID_SIZE x GRASS_GRID_SIZE grid of hex colours.
 *
 * Point-samples one real pixel per cell rather than box-averaging the region:
 * grass.png is a high-contrast per-pixel dither (R channel spans ~34-95), and
 * averaging a 10x10 block collapses that down to a narrow, washed-out range
 * (~50-76) — a literal blur that reads as fuzzy next to the real texture.
 * Point-sampling keeps a single real pixel's full contrast per cell instead.
 */
async function sampleGrassGrid() {
  const image = await loadImage(GRASS_PNG);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);

  const cellW = image.width / GRASS_GRID_SIZE;
  const cellH = image.height / GRASS_GRID_SIZE;
  const grid = [];
  for (let row = 0; row < GRASS_GRID_SIZE; row++) {
    const rowColours = [];
    for (let col = 0; col < GRASS_GRID_SIZE; col++) {
      const x = Math.floor((col + 0.5) * cellW);
      const y = Math.floor((row + 0.5) * cellH);
      const i = (y * image.width + x) * 4;
      rowColours.push(rgbToHex(data[i], data[i + 1], data[i + 2]));
    }
    grid.push(rowColours);
  }
  return grid;
}

async function writeGrassTextureSvg(grassGrid) {
  const outPath = path.join(ASSETS_DIR, 'grass-texture.svg');
  await fs.writeFile(outPath, gridToSvg(grassGrid, GRASS_GRID_SIZE, 'Grass texture — vectorized dither, sampled from grass.png'));
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
}

/** Parse a source SVG's <rect> list into a gridSize x gridSize colour grid (CELL_PX per cell). */
function parseRectsToGrid(svg, gridSize) {
  const grid = Array.from({ length: gridSize }, () => new Array(gridSize).fill(null));
  const rectRe = /<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="(#[0-9a-fA-F]{6})"\/>/g;
  let match;
  while ((match = rectRe.exec(svg))) {
    const [, xStr, yStr, wStr, hStr, fill] = match;
    const x0 = Number(xStr) / CELL_PX;
    const y0 = Number(yStr) / CELL_PX;
    const cols = Number(wStr) / CELL_PX;
    const rows = Number(hStr) / CELL_PX;
    for (let dy = 0; dy < rows; dy++) {
      for (let dx = 0; dx < cols; dx++) {
        grid[y0 + dy][x0 + dx] = fill;
      }
    }
  }
  return grid;
}

/** Emit a colour grid back as an SVG, run-length encoding each row like the source art. */
function gridToSvg(grid, gridSize, description = 'Composited pixel-art tile') {
  const px = gridSize * CELL_PX;
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px} ${px}" width="${px}" height="${px}" shape-rendering="crispEdges">`,
    `<desc>${description}</desc>`
  ];
  for (let row = 0; row < gridSize; row++) {
    let col = 0;
    while (col < gridSize) {
      const colour = grid[row][col];
      let runEnd = col + 1;
      while (runEnd < gridSize && grid[row][runEnd] === colour) runEnd++;
      if (colour) {
        const x = col * CELL_PX;
        const y = row * CELL_PX;
        const w = (runEnd - col) * CELL_PX;
        lines.push(`<rect x="${x}" y="${y}" width="${w}" height="${CELL_PX}" fill="${colour}"/>`);
      }
      col = runEnd;
    }
  }
  lines.push('</svg>');
  return lines.join('\n') + '\n';
}

/** Rasterize a colour grid directly to a PNG buffer at native CELL_PX-per-cell scale. */
function gridToPng(grid, gridSize) {
  const px = gridSize * CELL_PX;
  const canvas = createCanvas(px, px);
  const ctx = canvas.getContext('2d');
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const colour = grid[row][col];
      if (!colour) continue;
      ctx.fillStyle = colour;
      ctx.fillRect(col * CELL_PX, row * CELL_PX, CELL_PX, CELL_PX);
    }
  }
  return canvas.toBuffer('image/png');
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Deterministic 32-bit FNV-1a hash, so re-running the generator is reproducible. */
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Nudge a hex colour's RGB channels by a small deterministic per-cell offset. */
function jitterColor(hex, seed) {
  const hash = fnv1a(seed);
  const r = (hash & 0xff) / 255 - 0.5;
  const g = ((hash >>> 8) & 0xff) / 255 - 0.5;
  const b = ((hash >>> 16) & 0xff) / 255 - 0.5;
  const [baseR, baseG, baseB] = hexToRgb(hex);
  return rgbToHex(
    clampByte(baseR + r * 2 * PROP_JITTER),
    clampByte(baseG + g * 2 * PROP_JITTER),
    clampByte(baseB + b * 2 * PROP_JITTER)
  );
}

function hexToRgb(hex) {
  return [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((h) => parseInt(h, 16));
}

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
