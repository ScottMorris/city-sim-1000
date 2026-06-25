#!/usr/bin/env -S node
/**
 * Render emoji-based favicons and PWA icons with a consistent look.
 * Uses @napi-rs/canvas to draw the 🏙️ emoji on a dark blue gradient.
 */

import { createCanvas } from '@napi-rs/canvas';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ICONS_DIR = path.resolve('public/icons');
const EMOJI = '🏙️';

const PNG_TARGETS = [
  { size: 16, filename: 'favicon-16.png' },
  { size: 32, filename: 'favicon-32.png' },
  { size: 48, filename: 'favicon-48.png' },
  { size: 180, filename: 'apple-touch-icon.png' },
  { size: 192, filename: 'icon-192.png' },
  { size: 512, filename: 'icon-512.png' }
];

const ICO_SIZES = [16, 32, 48];

async function main() {
  await fs.mkdir(ICONS_DIR, { recursive: true });

  const renderedPngs = new Map();

  for (const target of PNG_TARGETS) {
    const png = renderEmojiIcon(target.size);
    renderedPngs.set(target.size, png);

    const outPath = path.join(ICONS_DIR, target.filename);
    await fs.writeFile(outPath, png);
    console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
  }

  const icoBuffer = buildIco(
    ICO_SIZES.map((size) => ({
      size,
      png: renderedPngs.get(size) ?? renderEmojiIcon(size)
    }))
  );

  const icoPath = path.join(ICONS_DIR, 'favicon.ico');
  await fs.writeFile(icoPath, icoBuffer);
  console.log(`Wrote ${path.relative(process.cwd(), icoPath)}`);
}

function renderEmojiIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, 0, size);
  gradient.addColorStop(0, '#0f1b35');
  gradient.addColorStop(1, '#1f3b63');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  ctx.font = `${Math.round(size * 0.76)}px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", "Noto Emoji", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
  ctx.shadowBlur = size * 0.1;
  ctx.shadowOffsetY = size * 0.06;
  ctx.fillText(EMOJI, size / 2, size / 2 + size * 0.02);

  ctx.shadowColor = 'rgba(255, 255, 255, 0.16)';
  ctx.shadowBlur = size * 0.18;
  ctx.shadowOffsetY = -size * 0.08;
  ctx.fillText(EMOJI, size / 2, size / 2 + size * 0.02);

  return canvas.toBuffer('image/png');
}

function buildIco(entries) {
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = headerSize + dirEntrySize * entries.length;
  const totalSize = dirSize + entries.reduce((sum, entry) => sum + entry.png.length, 0);

  const buffer = Buffer.alloc(totalSize);
  buffer.writeUInt16LE(0, 0); // reserved
  buffer.writeUInt16LE(1, 2); // icon type
  buffer.writeUInt16LE(entries.length, 4); // image count

  let offset = dirSize;
  entries.forEach((entry, index) => {
    const dirOffset = headerSize + dirEntrySize * index;
    const dimensionByte = entry.size >= 256 ? 0 : entry.size;

    buffer.writeUInt8(dimensionByte, dirOffset); // width
    buffer.writeUInt8(dimensionByte, dirOffset + 1); // height
    buffer.writeUInt8(0, dirOffset + 2); // colour count
    buffer.writeUInt8(0, dirOffset + 3); // reserved
    buffer.writeUInt16LE(1, dirOffset + 4); // planes
    buffer.writeUInt16LE(32, dirOffset + 6); // bit depth
    buffer.writeUInt32LE(entry.png.length, dirOffset + 8); // size of image data
    buffer.writeUInt32LE(offset, dirOffset + 12); // offset of image data

    entry.png.copy(buffer, offset);
    offset += entry.png.length;
  });

  return buffer;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
