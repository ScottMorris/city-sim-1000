// primitives.mjs — parametric shape generators for the house asset studio.
//
// Each function paints onto a shared cell grid (grid[row][col] = hex colour
// or null). Proportions are seeded from measurements taken directly off
// res-house-2.png / res-house-3.png — a 160x160 canvas at CELL_PX=5, i.e. a
// 32x32 grid, twice the resolution of the park asset grid so shingle rows
// and plank bands read distinctly.
//
// Iteration 2: the reference art isn't built from hard-edged 3D box faces —
// isolating just the outline (see silhouette dumps) shows one continuous
// rounded blob with NO seam between "front" and "side" walls. The depth
// illusion comes from a diagonal roof ridge line and a diagonal shading
// gradient across the *whole* wall, not from separate rectangular panels.
// `paintBuilding` replaces the old gableRoof/bandedWall/diagonalWall trio
// with a single silhouette-aware painter that reproduces that.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

export const CELL_PX = 5;
export const GRID_SIZE = 32;

export function makeGrid(size = GRID_SIZE) {
  return Array.from({ length: size }, () => new Array(size).fill(null));
}

function set(grid, row, col, colour) {
  if (row < 0 || row >= grid.length || col < 0 || col >= grid[0].length) return;
  grid[row][col] = colour;
}

function hexToRgb(hex) {
  return [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((h) => parseInt(h, 16));
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function lerpColour(hexA, hexB, t) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  return rgbToHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
}

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h, s, l];
}

export function hslToRgb(h, s, l) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

/** Hue/saturation-preserving lightness shift (avoids the desaturation lerp-to-black/white causes). */
export function shiftLightness(hex, deltaL) {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const [nr, ng, nb] = hslToRgb(h, s, Math.max(0, Math.min(1, l + deltaL)));
  return rgbToHex(nr, ng, nb);
}

/** Filled ellipse ring (base/path oval), outline + fill. */
export function ovalBase(grid, cx, cy, rx, ry, fillColour, outlineColour) {
  for (let row = 0; row < grid.length; row++) {
    for (let col = 0; col < grid[0].length; col++) {
      const dx = (col - cx) / rx;
      const dy = (row - cy) / ry;
      const d = dx * dx + dy * dy;
      if (d <= 1) {
        set(grid, row, col, fillColour);
      } else if (d <= 1.35) {
        set(grid, row, col, outlineColour);
      }
    }
  }
}

/**
 * Iteration 4: the rounded/organic silhouette was itself the problem — no
 * amount of shading makes a rounded blob read as isometric, because the
 * defining signature of isometric pixel art is CRISP STRAIGHT edges at
 * consistent angles. This version draws a real triangle roof (apex, two
 * straight sides down to the eave) sitting on a real rectangle wall, split
 * by a seam that stays close to VERTICAL (small ridgeShiftCols) rather than
 * the previous wide diagonal — real isometric houses have a vertical wall
 * corner, not one diagonal line running through both roof and wall.
 */
export function paintBuilding(grid, opts) {
  const {
    x0, y0, w, roofH, wallH,
    apexOffsetCols = 0,
    ridgeShiftCols = 2,
    roofLight, roofShade,
    wallHighlight, wallDark,
    bandHeight = 2,
    outline,
  } = opts;

  const apexCol = x0 + w / 2 + apexOffsetCols;
  const halfW = w / 2;
  const roofBottomY = y0 + roofH;
  const wallBottomY = roofBottomY + wallH;

  // Banding/checkerboard variants: a hue-preserving lightness shift, not a
  // lerp toward black/white (which is what was desaturating everything).
  const roofLightBand = shiftLightness(roofLight, -0.1);
  const roofShadeBand = shiftLightness(roofShade, -0.1);
  const wallHighlightBand = shiftLightness(wallHighlight, 0.12);
  const wallDarkBand = shiftLightness(wallDark, -0.1);

  const seamColAtRow = (row) => apexCol + (ridgeShiftCols * (row - y0)) / (wallBottomY - y0);

  const paintSpan = (row, left, right, isRoofRow) => {
    const seamCol = seamColAtRow(row);
    for (let col = left; col <= right; col++) {
      const isEdge = col === left || col === right || (isRoofRow && row === y0);
      const onSeam = Math.abs(col - seamCol) < 0.6;
      if (isEdge || onSeam) {
        set(grid, row, col, outline);
        continue;
      }
      const onLitSide = col < seamCol;
      let colour;
      if (isRoofRow) {
        const shingleRow = Math.floor((row - y0) / 2);
        const shingleCol = Math.floor((col + (shingleRow % 2 === 0 ? 0 : 1)) / 2);
        const checker = (shingleRow + shingleCol) % 2 === 0;
        colour = onLitSide ? (checker ? roofLight : roofLightBand) : checker ? roofShade : roofShadeBand;
        if (row === roofBottomY - 1 && onLitSide) colour = shiftLightness(colour, 0.15); // eave trim
      } else {
        const wallRow = row - roofBottomY;
        const band = Math.floor(wallRow / bandHeight);
        const rowInBand = wallRow % bandHeight;
        const base = onLitSide ? wallHighlight : wallDark;
        const baseBand = onLitSide ? wallHighlightBand : wallDarkBand;
        colour = rowInBand === 0 ? shiftLightness(base, 0.16) : band % 2 === 0 ? base : baseBand;
        if (wallRow === 0) colour = shiftLightness(colour, -0.22); // eave shadow cast onto wall top
      }
      set(grid, row, col, colour);
    }
  };

  // Roof: a straight-sided triangle, apex at (apexCol, y0), base at roofBottomY.
  for (let row = y0; row < roofBottomY; row++) {
    const t = (row - y0) / Math.max(1, roofH - 1);
    const rowHalfW = halfW * t; // linear interpolation -> crisp triangle, no curve
    const left = Math.round(apexCol - rowHalfW);
    const right = Math.round(apexCol + rowHalfW);
    paintSpan(row, left, right, true);
  }

  // Wall: a straight rectangle, constant width, slightly narrower than the roof eave.
  const wallHalfW = halfW * 0.92;
  const left = Math.round(apexCol - wallHalfW);
  const right = Math.round(apexCol + wallHalfW);
  for (let row = roofBottomY; row < wallBottomY; row++) {
    paintSpan(row, left, right, false);
  }
}

/** Vertical chimney block: light face / dark face split, black outline. */
export function chimney(grid, x0, y0, w, h, lightColour, darkColour, outlineColour) {
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const isEdge = row === 0 || col === 0 || col === w - 1;
      const colour = isEdge ? outlineColour : col < w / 2 ? lightColour : darkColour;
      set(grid, y0 + row, x0 + col, colour);
    }
  }
}

/** Framed window: black frame, diagonal 2-tone glass (lit corner / shadow corner). */
export function window_(grid, x0, y0, w, h, glassLight, glassDark, frameColour) {
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const edge = row === 0 || row === h - 1 || col === 0 || col === w - 1;
      const colour = edge ? frameColour : row + col < (w + h) / 2 ? glassLight : glassDark;
      set(grid, y0 + row, x0 + col, colour);
    }
  }
}

/** Door with a knob highlight, sitting on a step block. */
export function door(grid, x0, y0, w, h, woodColour, knobColour, frameColour, stepColour) {
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const edge = row === 0 || col === 0 || col === w - 1;
      set(grid, y0 + row, x0 + col, edge ? frameColour : woodColour);
    }
  }
  const knobRow = y0 + Math.floor(h * 0.55);
  const knobCol = x0 + w - 2;
  set(grid, knobRow, knobCol, knobColour);
  // step block beneath the door
  for (let col = x0 - 1; col <= x0 + w; col++) {
    set(grid, y0 + h, col, stepColour);
  }
}

/** Small rounded bush blob with a highlight fleck. */
export function bush(grid, cx, cy, r, colour, outlineColour) {
  const highlight = lerpColour(colour, '#ffffff', 0.3);
  const bound = Math.ceil(r);
  for (let row = -bound; row <= bound; row++) {
    for (let col = -bound; col <= bound; col++) {
      const d = Math.sqrt(row * row + col * col);
      if (d <= r) {
        const isHighlight = row <= -Math.floor(r / 2) && col <= 0;
        set(grid, cy + row, cx + col, isHighlight ? highlight : colour);
      } else if (d <= r + 0.7) {
        set(grid, cy + row, cx + col, outlineColour);
      }
    }
  }
}

/** Grey stone path leading away from the door step, a couple of offset slabs. */
export function stonePath(grid, x0, y0, count, colour, outlineColour) {
  for (let i = 0; i < count; i++) {
    const row = y0 + i;
    const col = x0 + Math.floor(i * 1.4);
    set(grid, row, col, colour);
    set(grid, row, col + 1, colour);
    set(grid, row - 1, col, outlineColour);
  }
}
