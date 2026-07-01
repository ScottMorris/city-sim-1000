import { createCanvas, loadImage } from '@napi-rs/canvas';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const tilesDir = path.resolve(projectRoot, 'public/assets/tiles');

const TILE_SIZE = 158;
const CENTRE = Math.floor(TILE_SIZE / 2);
const LINE_WIDTH = 2;
const POLE_WIDTH = 4;
const NODE_SIZE = 3;
const NODE_ORIGIN = CENTRE - Math.floor(NODE_SIZE / 2);
const WIRE_COLOUR = '#27312f';
const NODE_COLOUR = '#27312f';
const WIRE_OFFSETS = [Math.floor(TILE_SIZE * 0.35), Math.floor(TILE_SIZE * 0.65)];

async function main() {
  const grass = await loadImage(path.join(tilesDir, 'grass.png'));

  const canvas = createCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.imageSmoothingQuality = 'low';

  ctx.drawImage(grass, 0, 0, grass.width, grass.height, 0, 0, TILE_SIZE, TILE_SIZE);

  ctx.fillStyle = WIRE_COLOUR;
  WIRE_OFFSETS.forEach((y) => {
    ctx.fillRect(0, y, TILE_SIZE, LINE_WIDTH);
  });

  // Pole centred on the tile.
  ctx.fillRect(CENTRE - Math.floor(POLE_WIDTH / 2), 0, POLE_WIDTH, TILE_SIZE);

  ctx.fillStyle = NODE_COLOUR;
  ctx.fillRect(NODE_ORIGIN, NODE_ORIGIN, NODE_SIZE, NODE_SIZE);

  const buffer = await canvas.encode('png');
  await writeFile(path.join(tilesDir, 'power_straight.png'), buffer);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
