#!/usr/bin/env -S node
/**
 * Studio prototype — stylizer.
 *
 * Consumes the three raw passes from render-passes.py (shaded / albedo / id),
 * recovers per-pixel lighting (shaded ÷ albedo, in linear space), and applies
 * pluggable LOOK PROFILES entirely in post: light quantization with tinted
 * shadows, role palette, ID-edge linework, texture/dither, grass compositing.
 *
 * Outputs one 160×160 sprite per profile plus a labelled contact sheet with
 * the current in-game reference sprite for side-by-side judging.
 *
 * (c) Copyright 2026 Liminal HQ, Scott Morris
 * SPDX-License-Identifier: MIT
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCENE = process.argv[2] ?? 'house';
const PASS_DIR = path.join(ROOT, 'studio/out/passes', SCENE);
const OUT_DIR = path.join(ROOT, 'studio/out');
const GRASS_PNG = path.join(ROOT, 'app/public/assets/tiles/terrain/grass.png');
const REFS = {
  house: 'buildings/res-house-2.png',
  shop: 'buildings/com-shop-1.png',
  rail: 'roads/road-ns.png',   // no rail sprites exist yet — roads are the neighbours to match
  road: 'roads/road-ns.png',
  crossing: 'roads/road-ns.png',
  power: 'power/power-line-vertical.png',
  pole: 'power/power-line-vertical.png',
};
const refKey = REFS[SCENE] ? SCENE : SCENE.split('-')[0];
const REF_PNG = path.join(ROOT, 'app/public/assets/tiles', REFS[refKey] ?? REFS.house);

const TILE = 160;          // game convention for a 1×1 sprite
const HOUSE_SCALE = 0.84;  // fraction of the tile the house content occupies

// Role palette — base colours per building part (sRGB). Light bands derive
// from these in HSL; the albedo pass is only used to recover lighting.
const ROLES = [
  { name: 'wall', id: [255, 0, 0], colour: '#a8b8c0' },
  { name: 'roof', id: [0, 255, 0], colour: '#6e2020' },
  { name: 'chimney', id: [0, 0, 255], colour: '#8a3a2a' },
  { name: 'window', id: [255, 255, 0], colour: '#1d6076' },
  { name: 'door', id: [0, 255, 255], colour: '#6b4a1f' },
  { name: 'knob', id: [255, 0, 255], colour: '#d4a843' },
  { name: 'bush', id: [255, 128, 0], colour: '#2e5c2e' },
  { name: 'walkway', id: [128, 0, 255], colour: '#b8b2a6' },
  { name: 'trim', id: [255, 255, 255], colour: '#d8d3c7' },
  { name: 'mullion', id: [64, 64, 64], colour: '#d8d3c7' },
  { name: 'step', id: [128, 128, 128], colour: '#a8a296' },
  { name: 'awning', id: [128, 255, 0], colour: '#b23b30' },
  { name: 'sign', id: [0, 128, 128], colour: '#d9c98a' },
  { name: 'rail', id: [0, 128, 0], colour: '#9aa0ac' },
  { name: 'tie', id: [128, 64, 0], colour: '#6b4a2a' },
  { name: 'ballast', id: [64, 0, 128], colour: '#8d857a' },
  // Asphalt/marking measured from the existing road-ns.png (dark teal-grey
  // black-top, warm bone dashes) — the current road set is the liked target.
  { name: 'asphalt', id: [0, 0, 64], colour: '#323f3e' },
  { name: 'kerb', id: [64, 0, 0], colour: '#182323' },
  { name: 'shoulder', id: [192, 0, 192], colour: '#575d54' },
  { name: 'marking', id: [192, 192, 192], colour: '#cec0b4' },
  { name: 'wire', id: [0, 192, 192], colour: '#131f1d' },
];

// Per-scene palette overrides and surface-pattern spacings — the seed of the
// future recipe system. Roles keep one semantic meaning; scenes restyle them.
const SCENE_STYLES = {
  house: { palette: {}, wallSpacing: 0.30, roofSpacing: 0.36 },
  house2: {
    // Warm cream bungalow, dark slate roof — distinct from house's blue-grey
    // siding + red roof at a glance.
    palette: {
      wall: '#d8c9a3',
      roof: '#3f4448',
      door: '#5a3520',
    },
    wallSpacing: 0.30,
    roofSpacing: 0.40,
  },
  house3: {
    // Muted sage-green colonial, deep brown roof.
    palette: {
      wall: '#8a9878',
      roof: '#4a3226',
      door: '#2c2420',
      trim: '#e8e2d0',
      mullion: '#e8e2d0',
    },
    wallSpacing: 0.26,
    roofSpacing: 0.34,
  },
  shop: {
    palette: {
      wall: '#a8714a',     // brick
      roof: '#5a5650',     // flat tar roof
      chimney: '#8a8478',  // rooftop vent
      door: '#31556e',
    },
    wallSpacing: 0.22,     // tighter courses read as brick rather than siding
    roofSpacing: 0.36,     // flat roof: constant height -> no lines anyway
  },
  shop2: {
    // Blue-grey clapboard general store, green awning/sign — a cool wall
    // tone keeps it from reading as another shade of shop/shop3's brick.
    palette: {
      wall: '#aebfc4',
      roof: '#4a4640',
      chimney: '#8a8478',
      awning: '#2f6b47',
      sign: '#e4dcc4',
      door: '#2b3a4a',
    },
    wallSpacing: 0.30,
    roofSpacing: 0.36,
  },
  shop3: {
    // Narrow terracotta café, teal awning.
    palette: {
      wall: '#b5583a',
      roof: '#403c38',
      chimney: '#8a8478',
      awning: '#1f6e6a',
      sign: '#f0e6d0',
      door: '#26433f',
    },
    wallSpacing: 0.24,
    roofSpacing: 0.36,
  },
  rail: {
    // Ground tile: fills the frame edge-to-edge (no crop/shrink), no lawn
    // oval; transparent cells become plain grass shoulders.
    ground: true,
    palette: {},
    wallSpacing: 0.30,
    roofSpacing: 0.36,
  },
  road: { ground: true, palette: {}, wallSpacing: 0.30, roofSpacing: 0.36 },
  crossing: { ground: true, palette: {}, wallSpacing: 0.30, roofSpacing: 0.36 },
  power: {
    // Wires are a top-down ground tile; the pole is a dimetric-rendered
    // billboard prop composited on top (same cheat as the hand-made
    // sprites). Offset accounts for the pole camera aiming at FOCUS_Z 0.7
    // (which sinks the billboard 0.7*cos(26.57°)*40 ≈ 25 px): 13 px seats
    // the crossarm (z 2.0 -> screen 46.5) on the upper wire anchor and the
    // pole base (z 0 -> screen 118) at ~74% of the tile.
    ground: true,
    overlay: 'pole',
    overlayOffsetY: 13,
    overlayBaseY: 118,
    palette: {},
    wallSpacing: 0.30,
    roofSpacing: 0.36,
  },
  pole: {
    palette: {
      tie: '#4e3d2c',    // crafted wood, kin to doors and rail ties
      step: '#5c6055',   // transformer can: dull metal grey, not bright stone
    },
    wallSpacing: 0.30,
    roofSpacing: 0.36,
  },
};
const STYLE = SCENE_STYLES[SCENE] ?? SCENE_STYLES[SCENE.split('-')[0]] ?? SCENE_STYLES.house;
for (const [name, colour] of Object.entries(STYLE.palette)) {
  ROLES.find((r) => r.name === name).colour = colour;
}
// Ink is placed on the lower-precedence side of a pair boundary.
const INK_PRECEDENCE = ['asphalt', 'kerb', 'shoulder', 'ballast', 'walkway', 'step', 'bush', 'marking', 'wire', 'tie', 'rail', 'wall', 'roof', 'chimney', 'awning', 'sign', 'trim', 'mullion', 'door', 'window', 'knob'];
// Roles that never get silhouette ink against open ground — thin dark
// features (wires) or features whose own contrast is the outline.
const NO_SILHOUETTE = new Set(['wire', 'marking', 'kerb', 'shoulder']);
// Boundaries that stay ink-free — colour contrast separates them instead, so
// small parts (glass panes, knobs) aren't swallowed by their own outlines.
const NO_INK_PAIRS = new Set(
  ['trim|window', 'door|trim', 'door|knob', 'step|walkway', 'door|step', 'mullion|window', 'mullion|trim',
    'rail|tie', 'rail|ballast', 'tie|ballast',   // inside the trackbed, contrast separates parts
    'asphalt|marking', 'asphalt|kerb', 'asphalt|tie', 'asphalt|rail', 'kerb|marking', 'marking|tie',
    'asphalt|shoulder', 'kerb|shoulder']
    .map((p) => p.split('|').sort().join('|')),
);
const inkAllowed = (a, b) => !NO_INK_PAIRS.has([ROLES[a].name, ROLES[b].name].sort().join('|'));
const OUTLINE = '#0a1a18';
const LAWN = '#2d5c25';

// --- Look profiles ----------------------------------------------------------
const PROFILES = [
  {
    name: 'pixel-32',
    grid: 32, bands: 2, ink: true, inkKnob: false, wobble: 0, dilate: 0,
    jitter: 0.055, grain: 0, oval: true,
  },
  {
    name: 'inked-pixel-40',
    grid: 40, bands: 2, ink: true, inkKnob: false, wobble: 0, dilate: 0,
    jitter: 0.05, grain: 0, oval: true,
  },
  {
    // "Rich + pixelesque" direction: finer grid for detail budget, 3-band
    // shading for depth (the storybook look's subtle shadows), edge highlights,
    // and screen-space detail stamping — siding grooves, shingle courses,
    // glass glint, door inset. No ordered dither: it read as aliasing noise.
    name: 'rich-pixel-48',
    grid: 48, bands: 3, ink: true, inkKnob: false, wobble: 0, dilate: 0,
    jitter: 0.02, grain: 0, oval: true, edgeHighlight: true, details: true,
  },
  {
    name: 'clean-cel',
    grid: 160, bands: 2, ink: true, inkKnob: false, wobble: 1.2, dilate: 1,
    jitter: 0, grain: 0.02, oval: true,
  },
  {
    name: 'storybook-no-line',
    grid: 160, bands: 3, ink: false, inkKnob: false, wobble: 0, dilate: 0,
    jitter: 0, grain: 0.025, oval: true,
  },
];

// --- Small colour/hash helpers ---------------------------------------------
const srgb2lin = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  srgb2lin[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const luma = (r, g, b) => 0.2126 * srgb2lin[r] + 0.7152 * srgb2lin[g] + 0.0722 * srgb2lin[b];

function hexToRgb(hex) {
  return [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((h) => parseInt(h, 16));
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function mixHex(a, b, t) {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Shift hue toward a cool blue along the shortest arc. */
function coolHue(h, amount) {
  const target = 0.66;
  let d = target - h;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return ((h + d * amount) % 1 + 1) % 1;
}

/** Band-adjusted role colour: 0 = shadow, 1 = base/lit, 2 = highlight. */
function shadeRole(hex, band) {
  const [r, g, b] = hexToRgb(hex);
  let [h, s, l] = rgbToHsl(r, g, b);
  if (band === 0) { h = coolHue(h, 0.12); l *= 0.68; s = Math.min(1, s + 0.06); }
  if (band === 2) { l = Math.min(1, l * 1.16 + 0.02); s *= 0.92; }
  const [nr, ng, nb] = hslToRgb(h, s, l);
  return rgbToHex(nr, ng, nb);
}

function jitterColour(hex, seed, magnitude) {
  const hash = fnv1a(seed);
  const lDelta = ((hash & 0xff) / 255 - 0.5) * 2 * magnitude;
  const sBoost = (((hash >>> 8) & 0xff) / 255) * 0.04;
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const [nr, ng, nb] = hslToRgb(h, Math.min(1, s + sBoost), Math.max(0, Math.min(1, l + lDelta)));
  return rgbToHex(nr, ng, nb);
}

// --- Load passes ------------------------------------------------------------
async function imageData(file) {
  const img = await loadImage(file);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { data: ctx.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height };
}

const Z_MAX = 2.6; // must match render-passes.py

function buildMaps(shaded, albedo, idPass, heightPass) {
  const { w, h } = idPass;
  const role = new Int8Array(w * h).fill(-1);
  const light = new Float32Array(w * h);
  const height = new Float32Array(w * h);
  const idLin = ROLES.map((r) => r.id.map((v) => srgb2lin[v]));
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (idPass.data[o + 3] < 128) continue;
    const pr = srgb2lin[idPass.data[o]], pg = srgb2lin[idPass.data[o + 1]], pb = srgb2lin[idPass.data[o + 2]];
    let best = -1, bestD = Infinity;
    for (let k = 0; k < idLin.length; k++) {
      const d = (pr - idLin[k][0]) ** 2 + (pg - idLin[k][1]) ** 2 + (pb - idLin[k][2]) ** 2;
      if (d < bestD) { bestD = d; best = k; }
    }
    role[i] = best;
    const la = luma(albedo.data[o], albedo.data[o + 1], albedo.data[o + 2]);
    const ls = luma(shaded.data[o], shaded.data[o + 1], shaded.data[o + 2]);
    light[i] = la > 0.004 ? ls / la : 0;
    height[i] = srgb2lin[heightPass.data[o]] * Z_MAX;
  }
  return { role, light, height, w, h };
}

function contentCrop(maps) {
  let x0 = maps.w, y0 = maps.h, x1 = 0, y1 = 0;
  for (let y = 0; y < maps.h; y++) {
    for (let x = 0; x < maps.w; x++) {
      if (maps.role[y * maps.w + x] >= 0) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  const side = Math.max(x1 - x0, y1 - y0) * 1.04;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { x: cx - side / 2, y: cy - side / 2, side };
}

// --- Grass ------------------------------------------------------------------
async function grassSampler() {
  const grass = await imageData(GRASS_PNG);
  return (u, v) => {
    const x = Math.min(grass.w - 1, Math.floor(u * grass.w));
    const y = Math.min(grass.h - 1, Math.floor(v * grass.h));
    const o = (y * grass.w + x) * 4;
    return [grass.data[o], grass.data[o + 1], grass.data[o + 2]];
  };
}

// --- Profile renderer -------------------------------------------------------
function renderProfile(profile, maps, crop, grassAt, opts = {}) {
  const N = profile.grid;
  const cellPx = TILE / N;
  const contentScale = opts.building ? HOUSE_SCALE : (STYLE.ground ? 1 : HOUSE_SCALE);
  const off = (TILE * (1 - contentScale)) / 2;

  // Tile pixel → source pass pixel (or null outside the house content box).
  const toSource = (tx, ty) => {
    const hx = (tx - off) / (TILE * contentScale);
    const hy = (ty - off) / (TILE * contentScale);
    if (hx < 0 || hx >= 1 || hy < 0 || hy >= 1) return null;
    return [crop.x + hx * crop.side, crop.y + hy * crop.side];
  };
  const sampleAt = (sx, sy) => {
    const x = Math.round(sx), y = Math.round(sy);
    if (x < 0 || y < 0 || x >= maps.w || y >= maps.h) return -1;
    return maps.role[y * maps.w + x];
  };

  // Cell grids: dominant role + mean light per cell (supersampled).
  const K = N >= TILE ? 2 : 4;
  const cellRole = new Int8Array(N * N).fill(-1);
  const cellLight = new Float32Array(N * N);
  const cellHeight = new Float32Array(N * N);
  const lights = [];
  for (let cy = 0; cy < N; cy++) {
    for (let cx = 0; cx < N; cx++) {
      const votes = new Map();
      let lightSum = new Map();
      let heightSum = new Map();
      for (let ky = 0; ky < K; ky++) {
        for (let kx = 0; kx < K; kx++) {
          const tx = (cx + (kx + 0.5) / K) * cellPx;
          const ty = (cy + (ky + 0.5) / K) * cellPx;
          const src = toSource(tx, ty);
          const r = src ? sampleAt(src[0], src[1]) : -1;
          votes.set(r, (votes.get(r) ?? 0) + 1);
          if (r >= 0 && src) {
            const si = Math.round(src[1]) * maps.w + Math.round(src[0]);
            lightSum.set(r, (lightSum.get(r) ?? 0) + maps.light[si]);
            heightSum.set(r, (heightSum.get(r) ?? 0) + maps.height[si]);
          }
        }
      }
      let best = -1, bestN = 0;
      for (const [r, n] of votes) if (n > bestN) { best = r; bestN = n; }
      // At coarse grids the frame/mullion geometry is sub-cell — sampling it
      // shreds it into stray cells. Remap it away (frame → wall, mullion →
      // glass); the detail stamps below re-draw grid-native equivalents.
      // Light/height means still come from the originally sampled role.
      const orig = best;
      if (N < 160 && best >= 0) {
        if (ROLES[best].name === 'trim') best = ROLES.findIndex((d) => d.name === 'wall');
        if (ROLES[best].name === 'mullion') best = ROLES.findIndex((d) => d.name === 'window');
      }
      cellRole[cy * N + cx] = best;
      if (best >= 0) {
        const n = votes.get(orig);
        cellLight[cy * N + cx] = (lightSum.get(orig) ?? 0) / Math.max(1, n);
        cellHeight[cy * N + cx] = (heightSum.get(orig) ?? 0) / Math.max(1, n);
        lights.push(cellLight[cy * N + cx]);
      }
    }
  }

  // Adaptive band thresholds from the light distribution.
  lights.sort((a, b) => a - b);
  const p95 = lights[Math.floor(lights.length * 0.95)] ?? 1;
  const t2 = [0.60 * p95];
  // Ground tiles are dominated by flat sunlit surfaces — with building
  // thresholds they'd all land in the highlight band and wash out. Push the
  // top threshold out of reach so flat-lit reads as base tone and highlights
  // come only from the edge-highlight rule.
  const t3 = STYLE.ground ? [0.45 * p95, 1.02 * p95] : [0.45 * p95, 0.82 * p95];
  const BAYER4 = [
    [0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5],
  ];
  const bandOf = (li, cx, cy) => {
    let v = li;
    if (profile.orderedDither) {
      // Push the light value around the threshold by a Bayer offset so the
      // band boundary breaks into a classic dither pattern instead of a line.
      v += (BAYER4[cy & 3][cx & 3] / 15 - 0.5) * profile.orderedDither * p95;
    }
    if (profile.bands === 2) return v < t2[0] ? 0 : 1;
    return v < t3[0] ? 0 : v < t3[1] ? 1 : 2;
  };

  // Ink mask from role boundaries.
  const ink = new Uint8Array(N * N);
  if (profile.ink) {
    const prec = (r) => (r < 0 ? -1 : INK_PRECEDENCE.indexOf(ROLES[r].name));
    const roleAtWobbled = (x, y) => {
      if (!profile.wobble) return cellRole[y * N + x] ?? -1;
      const h = fnv1a(`${profile.name}:w:${x}:${y}`);
      const dx = Math.round((((h & 0xff) / 255) - 0.5) * 2 * profile.wobble);
      const dy = Math.round(((((h >>> 8) & 0xff) / 255) - 0.5) * 2 * profile.wobble);
      const wx = Math.max(0, Math.min(N - 1, x + dx));
      const wy = Math.max(0, Math.min(N - 1, y + dy));
      return cellRole[wy * N + wx];
    };
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const r = roleAtWobbled(x, y);
        if (r < 0) continue;
        if (!profile.inkKnob && ROLES[r].name === 'knob') continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          const outside = nx < 0 || ny < 0 || nx >= N || ny >= N;
          // Ground tiles continue into their neighbours — never ink the tile
          // boundary itself, or every seam gets a black transverse bar.
          if (outside && STYLE.ground) continue;
          const nr = outside ? -1 : roleAtWobbled(nx, ny);
          if (nr === r) continue;
          if (nr < 0 && NO_SILHOUETTE.has(ROLES[r].name)) continue;
          if (nr >= 0 && !profile.inkKnob && ROLES[nr].name === 'knob') continue;
          if (nr >= 0 && !inkAllowed(r, nr)) continue;
          // Silhouette: ink the house-side cell. Pair: ink the lower-precedence side.
          if (nr < 0 || prec(r) <= prec(nr)) { ink[y * N + x] = 1; break; }
        }
      }
    }
    for (let d = 0; d < profile.dilate; d++) {
      const grown = Uint8Array.from(ink);
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          if (ink[y * N + x]) continue;
          if (cellRole[y * N + x] < 0) continue;
          if ((x > 0 && ink[y * N + x - 1]) || (x < N - 1 && ink[y * N + x + 1]) ||
              (y > 0 && ink[(y - 1) * N + x]) || (y < N - 1 && ink[(y + 1) * N + x])) {
            grown[y * N + x] = 1;
          }
        }
      }
      ink.set(grown);
    }
  }

  // Part bounding boxes for grid-native fitting stamps (sash cross, knob).
  const bboxOf = (roleName) => {
    const idx = ROLES.findIndex((r) => r.name === roleName);
    const box = { x0: N, y0: N, x1: -1, y1: -1 };
    for (let cy = 0; cy < N; cy++) {
      for (let cx = 0; cx < N; cx++) {
        if (cellRole[cy * N + cx] !== idx) continue;
        if (cx < box.x0) box.x0 = cx; if (cx > box.x1) box.x1 = cx;
        if (cy < box.y0) box.y0 = cy; if (cy > box.y1) box.y1 = cy;
      }
    }
    return box;
  };
  // Windows are grouped per connected component (not one global bbox) so a
  // scene with two separate windows gets two independent sash crosses
  // instead of one cross straddling both (it reads as broken geometry, not
  // panes) — see house3's stacked windows.
  const componentsOf = (roleName) => {
    const idx = ROLES.findIndex((r) => r.name === roleName);
    const compId = new Int16Array(N * N).fill(-1);
    const boxes = [];
    for (let sy = 0; sy < N; sy++) {
      for (let sx = 0; sx < N; sx++) {
        if (cellRole[sy * N + sx] !== idx || compId[sy * N + sx] >= 0) continue;
        const box = { x0: sx, y0: sy, x1: sx, y1: sy };
        const stack = [[sx, sy]];
        compId[sy * N + sx] = boxes.length;
        while (stack.length) {
          const [cx2, cy2] = stack.pop();
          if (cx2 < box.x0) box.x0 = cx2; if (cx2 > box.x1) box.x1 = cx2;
          if (cy2 < box.y0) box.y0 = cy2; if (cy2 > box.y1) box.y1 = cy2;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx2 + dx, ny = cy2 + dy;
            if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
            if (cellRole[ny * N + nx] !== idx || compId[ny * N + nx] >= 0) continue;
            compId[ny * N + nx] = boxes.length;
            stack.push([nx, ny]);
          }
        }
        boxes.push(box);
      }
    }
    return { compId, boxes };
  };
  const winComponents = componentsOf('window');
  const doorBox = bboxOf('door');
  const winRole = ROLES.findIndex((r) => r.name === 'window');

  const darken = (hex, f) => {
    const [r2, g2, b2] = hexToRgb(hex);
    const [h2, s2, l2] = rgbToHsl(r2, g2, b2);
    const [nr2, ng2, nb2] = hslToRgb(h2, s2, Math.min(1, l2 * f));
    return rgbToHex(nr2, ng2, nb2);
  };

  // Paint the tile: grass (+ oval lawn), then house cells, then upscale.
  const canvas = createCanvas(TILE, TILE);
  const ctx = canvas.getContext('2d');
  const ovalCx = 0.5, ovalCy = 0.62, ovalRx = 0.46, ovalRy = 0.33;
  for (let cy = 0; cy < N; cy++) {
    for (let cx = 0; cx < N; cx++) {
      const u = (cx + 0.5) / N, v = (cy + 0.5) / N;
      let colour;
      const r = cellRole[cy * N + cx];
      if (ink[cy * N + cx]) {
        colour = OUTLINE;
      } else if (r >= 0) {
        const roleDef = ROLES[r];
        let band = bandOf(cellLight[cy * N + cx], cx, cy);
        if (profile.edgeHighlight && band >= 1 && cy > 0 &&
            ['roof', 'wall', 'chimney', 'awning'].includes(roleDef.name)) {
          // Upward-facing lit edges (ridge lines, eave tops) get a highlight
          // cell — the classic pixel-art rim light, driven by the ID mask.
          // Structural parts only: highlighting small fittings (trim, knob)
          // just reads as stray bright pixels.
          const above = cellRole[(cy - 1) * N + cx];
          if (above !== r && !ink[(cy - 1) * N + cx]) band = 2;
        }
        // Flat-shaded roles: wires (NS/EW must match) and road furniture —
        // shoulders/kerbs/markings are painted features of the surface, and
        // banding them turns cast shadows into blotches at strip crossings.
        if (['wire', 'marking', 'shoulder', 'kerb'].includes(roleDef.name)) band = 1;
        // Grid-native window fittings: a stamped 1-cell sash cross at the
        // window's centre row/column, and a glint in the top-left pane. The
        // cross is inset from the pane's own edges (never touches the
        // outline) and tinted toward the glass colour rather than a
        // contrasting hue — a full-bleed contrasting cross reads as a flag
        // graphic, not a muntin bar.
        let sash = false;
        if (profile.details && r === winRole) {
          const ci = winComponents.compId[cy * N + cx];
          const box = ci >= 0 ? winComponents.boxes[ci] : null;
          if (box && box.x1 - box.x0 >= 2 && box.y1 - box.y0 >= 2) {
            const midX = Math.round((box.x0 + box.x1) / 2);
            const midY = Math.round((box.y0 + box.y1) / 2);
            const inset = cx > box.x0 && cx < box.x1 && cy > box.y0 && cy < box.y1;
            if (inset && (cx === midX || cy === midY)) sash = true;
            else if (cx < midX && cy < midY) band = 2;
          }
        }
        colour = sash
          ? mixHex(shadeRole(ROLES.find((d) => d.name === 'mullion').colour, 1), shadeRole(roleDef.colour, band), 0.55)
          : shadeRole(roleDef.colour, band);
        // Screen-space detail stamping: pattern drawn on the art grid via the
        // ID mask, so it's always crisp — no 3D texture aliasing to fight.
        let stamped = sash;
        if (profile.details) {
          // Siding planks and shingle courses are horizontal in the world, so
          // they're contour lines of the height pass — they lie on the wall
          // surfaces and follow each face's on-screen slope automatically.
          // A groove is drawn where the course index (floor(height/spacing))
          // changes between vertically adjacent same-role cells: continuous
          // 1-cell lines, instead of thresholding the fractional part per
          // cell, which aliases into broken scales when the groove is
          // thinner than an art cell.
          if (roleDef.name === 'wall' || roleDef.name === 'roof') {
            const spacing = roleDef.name === 'wall' ? STYLE.wallSpacing : STYLE.roofSpacing;
            const course = (x, y) => Math.floor(cellHeight[y * N + x] / spacing);
            // Cells straddling a part boundary have wobbly mean heights that
            // stamp spurious speckles — only groove in a clean interior run
            // (and let lines stop 1 cell short of outlines, as an artist would).
            const interiorRun = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => {
              const nx = cx + dx, ny = cy + dy;
              return nx >= 0 && ny >= 0 && nx < N && ny < N &&
                cellRole[ny * N + nx] === r && !ink[ny * N + nx];
            });
            if (interiorRun && course(cx, cy) !== course(cx, cy - 1)) {
              colour = darken(colour, roleDef.name === 'wall' ? 0.86 : 0.90);
              stamped = true;
            }
          } else if (roleDef.name === 'ballast') {
            // Gravel: stronger deterministic speckle than the standard jitter.
            colour = jitterColour(colour, `${profile.name}:b:${cx}:${cy}`, 0.09);
            stamped = true;
          } else if (roleDef.name === 'asphalt') {
            // Asphalt grain, matching the reference's near-smooth surface:
            // sparse speckle over an almost-flat base, not uniform jitter
            // (which read as coarse burlap).
            const h = fnv1a(`${profile.name}:a:${cx}:${cy}`);
            if (h % 9 === 0) colour = darken(colour, 0.90);
            else if (h % 9 === 1) colour = darken(colour, 1.10);
            else colour = jitterColour(colour, `${profile.name}:a2:${cx}:${cy}`, 0.015);
            stamped = true;
          } else if (roleDef.name === 'awning' && (cx & 3) < 2) {
            // Awning stripes: alternating screen-column bands, stamped on the
            // art grid so they stay crisp at any awning angle.
            colour = darken(colour, 0.84); stamped = true;
          } else if (roleDef.name === 'door') {
            if (doorBox.x1 >= 0 && cx === doorBox.x1 - 1 &&
                cy === Math.round((doorBox.y0 + doorBox.y1) / 2)) {
              // The knob geometry is sub-cell at coarse grids, so it gets
              // re-stamped here as a single gold cell on the handle side.
              colour = shadeRole(ROLES.find((d) => d.name === 'knob').colour, 1);
              stamped = true;
            } else {
              const interior = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => {
                const nx = cx + dx, ny = cy + dy;
                return nx >= 0 && ny >= 0 && nx < N && ny < N && cellRole[ny * N + nx] === r;
              });
              if (interior) colour = darken(colour, 0.90);      // inset door panel
            }
          }
        }
        if (profile.jitter && !stamped) colour = jitterColour(colour, `${profile.name}:${cx}:${cy}`, profile.jitter);
        if (profile.grain) colour = jitterColour(colour, `${profile.name}:g:${cx >> 1}:${cy >> 1}`, profile.grain);
      } else {
        if (opts.transparent) continue;   // billboard overlays keep open cells clear
        const [gr, gg, gb] = grassAt(u, v);
        colour = rgbToHex(gr, gg, gb);
        if (profile.oval && !STYLE.ground) {
          const du = (u - ovalCx) / ovalRx, dv = (v - ovalCy) / ovalRy;
          const d2 = du * du + dv * dv;
          if (d2 < 1) {
            const [lr, lg, lb] = hexToRgb(LAWN);
            colour = rgbToHex(gr * 0.25 + lr * 0.75, gg * 0.25 + lg * 0.75, gb * 0.25 + lb * 0.75);
            if (profile.ink && d2 > 0.82) {
              // Inked lawn rim, like the reference sprite's outlined oval.
              const [or, og, ob] = hexToRgb(OUTLINE);
              const [cr, cg, cb] = hexToRgb(colour);
              colour = rgbToHex(cr * 0.4 + or * 0.6, cg * 0.4 + og * 0.6, cb * 0.4 + ob * 0.6);
            }
          }
        }
        if (profile.grain) colour = jitterColour(colour, `${profile.name}:g:${cx >> 1}:${cy >> 1}`, profile.grain);
      }
      ctx.fillStyle = colour;
      ctx.fillRect(Math.floor(cx * cellPx), Math.floor(cy * cellPx), Math.ceil(cellPx), Math.ceil(cellPx));
    }
  }
  return canvas;
}

// --- Contact sheet ----------------------------------------------------------
async function main() {
  const [shaded, albedo, idPass, heightPass] = await Promise.all([
    imageData(path.join(PASS_DIR, 'shaded.png')),
    imageData(path.join(PASS_DIR, 'albedo.png')),
    imageData(path.join(PASS_DIR, 'id.png')),
    imageData(path.join(PASS_DIR, 'height.png')),
  ]);
  const maps = buildMaps(shaded, albedo, idPass, heightPass);
  const crop = STYLE.ground ? { x: 0, y: 0, side: maps.w } : contentCrop(maps);
  const grassAt = await grassSampler();

  // Billboard overlay (e.g. the utility pole on power tiles): a second scene
  // rendered through the dimetric camera, stylized transparently with its own
  // palette, and drawn over the ground tile.
  let overlay = null;
  if (STYLE.overlay) {
    const dir = path.join(ROOT, 'studio/out/passes', STYLE.overlay);
    const [s2, a2, i2, h2] = await Promise.all([
      imageData(path.join(dir, 'shaded.png')),
      imageData(path.join(dir, 'albedo.png')),
      imageData(path.join(dir, 'id.png')),
      imageData(path.join(dir, 'height.png')),
    ]);
    const oMaps = buildMaps(s2, a2, i2, h2);
    // Full-frame mapping (not content-crop): the overlay then shares the
    // ground tile's 1:1 world scale, so pole crossarm tips land exactly on
    // the wire lines instead of overshooting at a magnified scale.
    overlay = { maps: oMaps, crop: { x: 0, y: 0, side: oMaps.w }, palette: SCENE_STYLES[STYLE.overlay]?.palette ?? {} };
  }

  const withPalette = (palette, fn) => {
    const saved = new Map();
    for (const [name, colour] of Object.entries(palette)) {
      const role = ROLES.find((r) => r.name === name);
      saved.set(role, role.colour);
      role.colour = colour;
    }
    const result = fn();
    for (const [role, colour] of saved) role.colour = colour;
    return result;
  };

  const panels = [];
  const ref = await loadImage(REF_PNG);
  panels.push({ label: 'reference (current game)', image: ref });

  for (const profile of PROFILES) {
    const canvas = renderProfile(profile, maps, crop, grassAt);
    if (overlay) {
      const bctx = canvas.getContext('2d');
      // Pole ground shadow: a small cell-aligned dark blob south-east of the
      // pole base, consistent with the studio sun (from the screen's
      // upper-left) that shades every other asset.
      const cell = TILE / profile.grid;
      const baseX = profile.grid / 2;
      const baseY = (STYLE.overlayBaseY ?? TILE / 2 + (STYLE.overlayOffsetY ?? 0)) / cell;
      bctx.fillStyle = 'rgba(10, 22, 16, 0.30)';
      for (let cy = 0; cy < profile.grid; cy++) {
        for (let cx = 0; cx < profile.grid; cx++) {
          const du = (cx - baseX - 1.6) / 3.4, dv = (cy - baseY + 0.4) / 1.3;
          if (du * du + dv * dv < 1) {
            bctx.fillRect(Math.floor(cx * cell), Math.floor(cy * cell), Math.ceil(cell), Math.ceil(cell));
          }
        }
      }
      const ov = withPalette(overlay.palette, () =>
        renderProfile(profile, overlay.maps, overlay.crop, grassAt, { transparent: true }));
      bctx.drawImage(ov, 0, STYLE.overlayOffsetY ?? 0);
    }
    const file = path.join(OUT_DIR, `look-${SCENE}-${profile.name}.png`);
    await fs.writeFile(file, canvas.toBuffer('image/png'));
    console.log(`Wrote ${file}`);
    panels.push({ label: profile.name, image: canvas });
  }

  const SCALE = 2, PAD = 16, LABEL_H = 26;
  const cols = panels.length;
  const sheet = createCanvas(PAD + cols * (TILE * SCALE + PAD), TILE * SCALE + LABEL_H + PAD * 2);
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#1c2128';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.imageSmoothingEnabled = false;
  ctx.font = '13px monospace';
  panels.forEach((p, i) => {
    const x = PAD + i * (TILE * SCALE + PAD);
    ctx.drawImage(p.image, x, PAD, TILE * SCALE, TILE * SCALE);
    ctx.fillStyle = '#e6edf3';
    ctx.fillText(p.label, x, PAD + TILE * SCALE + 18);
  });
  const sheetFile = path.join(OUT_DIR, `contact-sheet-${SCENE}.png`);
  await fs.writeFile(sheetFile, sheet.toBuffer('image/png'));
  console.log(`Wrote ${sheetFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
