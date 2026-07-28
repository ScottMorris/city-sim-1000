// Hydro sprite coverage matrix — the classification tool for issue #169.
//
// Every hydro tile is the product of two independent things:
//
//   1. its own wire connectivity (16 cases: the 15 road-style variants plus
//      `isolated`, a pole with nothing attached),
//   2. what it was laid over (open ground, a road, a rail, or a level
//      crossing — each with its own axis), and
//   3. WHICH OF THE TWO WAS LAID SECOND, because that decides whether the sim
//      recorded the tile as a line over a road or a road over a line. The same
//      picture, two different tiles.
//
// That product is 240 cases, and eyeballing screenshots has repeatedly missed
// whole families of them — including, twice, the whole of (3). This file enumerates the lot, resolves each one
// through the real renderer path, and classifies the outcome so a gap is a
// failing assertion instead of something noticed later in a screenshot.
//
// Run `bun run test -- app/src/rendering/hydroCoverage.test.ts` to print the
// matrix; `HYDRO_MATRIX=1` also dumps the per-case table.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import type { Texture } from 'pixi.js';
import { createInitialState, getTile, setTile, TileKind, type GameState } from '../game/gameState';
import { resolveTileSprite, type BuildingLookup } from './tileRenderUtils';
import { CARRIAGEWAY_CLASSES, isSquareCrossing } from './tileAtlas';
import type { TileTextures, RoadVariant, CarriagewayClass, HydroVariant } from './tileAtlas';

const VARIANTS: RoadVariant[] = [
  'ns', 'ew',
  'corner-ne', 'corner-nw', 'corner-se', 'corner-sw',
  't-nes', 't-esw', 't-nsw', 't-new',
  'cross',
  'end-n', 'end-e', 'end-s', 'end-w'
];

/** The N/E/S/W edges each variant connects along — the inverse of
 *  `roadVariant`'s bitmask, so a case can be *built* from its name. */
const EDGES: Record<RoadVariant, ReadonlyArray<'n' | 'e' | 's' | 'w'>> = {
  ns: ['n', 's'], ew: ['e', 'w'],
  'corner-ne': ['n', 'e'], 'corner-nw': ['n', 'w'],
  'corner-se': ['e', 's'], 'corner-sw': ['s', 'w'],
  't-nes': ['n', 'e', 's'], 't-esw': ['e', 's', 'w'],
  't-nsw': ['n', 's', 'w'], 't-new': ['n', 'e', 'w'],
  cross: ['n', 'e', 's', 'w'],
  'end-n': ['n'], 'end-e': ['e'], 'end-s': ['s'], 'end-w': ['w']
};

const DELTA = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] } as const;

/** Hydro connectivity cases: the 15 variants plus the no-neighbour pole. */
type HydroCase = HydroVariant;
const HYDRO_CASES: HydroCase[] = [...VARIANTS, 'isolated'];

/** What the tile was laid over. `axis` is the substrate's own connectivity —
 *  it decides whether the line crosses it or runs along it. */
type Substrate = {
  readonly name: string;
  readonly road: ReadonlyArray<'n' | 'e' | 's' | 'w'> | null;
  readonly rail: ReadonlyArray<'n' | 'e' | 's' | 'w'> | null;
  /** The carriageway situation this presents to the line above it. */
  readonly cls: CarriagewayClass | null;
};

const SUBSTRATES: Substrate[] = [
  { name: 'open-ground', road: null,              rail: null,       cls: null },
  { name: 'road-ns',     road: ['n', 's'],        rail: null,       cls: 'along-ns' },
  { name: 'road-ew',     road: ['e', 'w'],        rail: null,       cls: 'along-ew' },
  { name: 'road-cross',  road: ['n','e','s','w'], rail: null,       cls: 'junction' },
  { name: 'road-end-e',  road: ['e'],             rail: null,       cls: 'along-ew' },
  { name: 'rail-ns',     road: null,              rail: ['n', 's'], cls: 'along-ns' },
  { name: 'rail-ew',     road: null,              rail: ['e', 'w'], cls: 'along-ew' },
  { name: 'level-xing',  road: ['e', 'w'],        rail: ['n', 's'], cls: 'junction' }
];

const tex = (name: string) => ({ name } as unknown as Texture);
const full = (prefix: string) =>
  Object.fromEntries(VARIANTS.map((v) => [v, tex(`${prefix}-${v}`)])) as Partial<Record<RoadVariant, Texture>>;

/** Every sprite the game actually ships, named exactly once, so a case that
 *  resolves to nothing is unambiguously a missing *asset* and not a missing
 *  test fixture. */
function makeTextures(): TileTextures {
  return {
    tiles: { [TileKind.Land]: tex('land') },
    road: full('road'),
    rail: full('rail'),
    railCrossing: { ns: tex('rail-road-xing-ns'), ew: tex('rail-road-xing-ew') },
    powerPlant: {},
    powerLine: full('power'),
    powerLineOverlay: full('ovl'),
    powerLineCrossing: { ns: tex('two-pole-ns'), ew: tex('two-pole-ew') },
    powerLineIsolated: tex('power-isolated'),
    powerLineIsolatedOverlay: tex('ovl-isolated'),
    powerLineKerbside: Object.fromEntries(
      CARRIAGEWAY_CLASSES.map((cls) => [
        cls,
        Object.fromEntries(
          ([...VARIANTS, 'isolated'] as HydroVariant[])
            .filter((v) => !isSquareCrossing(cls, v))
            .map((v) => [v, tex(`kerb-${cls}-${v}`)])
        )
      ])
    ) as TileTextures['powerLineKerbside'],
    residentialHouses: [], commercialBuildings: [], commercialGeminiBuildings: [],
    industrialBuildings: [], schools: {}, parks: {}, indicators: {}
  };
}

const emptyLookup: BuildingLookup = new Map();
const CX = 3, CY = 3;

/** Which of the two was laid second, and therefore owns the tile's `kind`.
 *
 *  THE SAME PHYSICAL TILE HAS TWO RECORDINGS. Lay the road first and the line
 *  over it: kind `PowerLine`, `roadUnderlay` set. Lay the line first and the
 *  road over it: kind `Road`, the line reduced to `powerOverlay`. The renderer
 *  originally only understood the first, so the second put a pole back in the
 *  middle of the road — and this matrix missed it entirely because it only
 *  ever built tiles one way round.
 *
 *  Under current sim rules a road replaces the line outright, so the second
 *  recording now only arrives from saves written before that fix. The renderer
 *  should not depend on that: it draws what the tile says, whichever way round
 *  the tile says it. */
type Recording = 'line-last' | 'carriageway-last';
const RECORDINGS: Recording[] = ['line-last', 'carriageway-last'];

/** Build a 7×7 world with one hydro tile at the centre carrying `hydro`
 *  connectivity and laid over `sub`. Neighbours are given whatever kind makes
 *  the centre tile see the edges it needs — a neighbour that is both a wire
 *  and part of the substrate becomes a hydro tile with the matching underlay,
 *  exactly as the sim would record it. */
function buildCase(hydro: HydroCase, sub: Substrate, rec: Recording = 'line-last'): GameState {
  const state = createInitialState(7, 7, 1);
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) setTile(state, x, y, TileKind.Land);

  const wireEdges = hydro === 'isolated' ? [] : EDGES[hydro];
  const roadEdges = sub.road ?? [];
  const railEdges = sub.rail ?? [];

  if (rec === 'carriageway-last' && sub.cls) {
    // The carriageway owns the kind; the line survives only as a flag.
    setTile(state, CX, CY, sub.rail ? TileKind.Rail : TileKind.Road);
    const laid = getTile(state, CX, CY)!;
    if (sub.rail && sub.road) laid.roadUnderlay = true;
    laid.powerOverlay = true;
  } else {
    setTile(state, CX, CY, TileKind.PowerLine);
    const centre = getTile(state, CX, CY)!;
    if (sub.road) centre.roadUnderlay = true;
    if (sub.rail) centre.railUnderlay = true;
  }

  for (const edge of ['n', 'e', 's', 'w'] as const) {
    const [dx, dy] = DELTA[edge];
    const x = CX + dx, y = CY + dy;
    const wire = wireEdges.includes(edge);
    const road = roadEdges.includes(edge);
    const rail = railEdges.includes(edge);
    if (!wire && !road && !rail) continue;

    // A wire neighbour must be a hydro tile; otherwise the substrate's own
    // kind carries it. Rail wins the kind when both are present, matching how
    // `pickPowerUnderlayTexture` reads a level crossing.
    setTile(state, x, y, wire ? TileKind.PowerLine : rail ? TileKind.Rail : TileKind.Road);
    const tile = getTile(state, x, y)!;
    if (road && tile.kind !== TileKind.Road) tile.roadUnderlay = true;
    if (rail && tile.kind !== TileKind.Rail) tile.railUnderlay = true;
  }
  return state;
}

type Resolved = { base?: string; overlay?: string };

function resolve(state: GameState, textures: TileTextures): Resolved {
  const info = resolveTileSprite(state, getTile(state, CX, CY), CX, CY, textures, emptyLookup);
  if (!info || 'skip' in info) return {};
  return {
    base: (info.texture as unknown as { name: string }).name,
    overlay: (info.overlayTexture as unknown as { name: string } | undefined)?.name
  };
}

/** How a resolved case reads on screen.
 *
 *  `pole-in-lane` means the plain single-pole overlay was drawn straight onto
 *  a carriageway, i.e. the pole is standing in the traffic lane. It used to be
 *  the outcome for 103 of the 128 recorded line-last; it should now never happen. */
type Verdict = 'no-sprite' | 'ground' | 'two-pole' | 'kerbside' | 'pole-in-lane';

function classify(sub: Substrate, r: Resolved): Verdict {
  if (!r.base) return 'no-sprite';
  if (!sub.cls) return 'ground';
  if (!r.overlay) return 'no-sprite';         // over a carriageway with no wires drawn
  if (r.overlay.startsWith('two-pole')) return 'two-pole';
  return r.overlay.startsWith('kerb-') ? 'kerbside' : 'pole-in-lane';
}

type Row = {
  hydro: HydroCase; sub: string; rec: Recording;
  verdict: Verdict; base?: string; overlay?: string;
};

function sweep(): Row[] {
  const textures = makeTextures();
  const rows: Row[] = [];
  for (const hydro of HYDRO_CASES) {
    for (const sub of SUBSTRATES) {
      for (const rec of RECORDINGS) {
        // Open ground has only one recording — there is no carriageway to
        // have been laid second.
        if (rec === 'carriageway-last' && !sub.cls) continue;
        const r = resolve(buildCase(hydro, sub, rec), textures);
        rows.push({ hydro, sub: sub.name, rec, verdict: classify(sub, r), base: r.base, overlay: r.overlay });
      }
    }
  }
  return rows;
}

describe('hydro sprite coverage matrix', () => {
  const rows = sweep();

  it('covers every connectivity against every substrate, both ways round', () => {
    const withCarriageway = SUBSTRATES.filter((s) => s.cls).length;
    expect(rows).toHaveLength(HYDRO_CASES.length * (SUBSTRATES.length + withCarriageway));
  });

  it('never falls through to the flat colour rect', () => {
    // `resolveTileSprite` returning undefined makes the renderer draw a bare
    // coloured square, so a missing variant is a *visible* bug, not a silent
    // one. This is the assertion that caught 10 of the original 16.
    const missing = rows.filter((r) => r.verdict === 'no-sprite');
    expect(missing.map((r) => `${r.hydro} over ${r.sub} (${r.rec})`)).toEqual([]);
  });

  it('carries a straight line squarely across a carriageway on two poles', () => {
    const crossings = rows.filter((r) => r.verdict === 'two-pole');
    expect([...new Set(crossings.map((r) => `${r.hydro}/${r.sub}`))].sort()).toEqual([
      'ew/level-xing', 'ew/rail-ns', 'ew/road-cross', 'ew/road-ns',
      'ns/level-xing', 'ns/rail-ew', 'ns/road-cross', 'ns/road-end-e', 'ns/road-ew'
    ]);
    for (const r of crossings) {
      expect(r.overlay).toBe(r.hydro === 'ns' ? 'two-pole-ns' : 'two-pole-ew');
    }
  });

  it('draws the road or rail beneath, never replacing it', () => {
    for (const r of rows.filter((x) => x.sub !== 'open-ground')) {
      expect(r.base, `${r.hydro} over ${r.sub} (${r.rec})`).not.toMatch(/^(power|ovl)-/);
    }
  });

  it('draws the opaque sprite with no overlay on open ground', () => {
    for (const r of rows.filter((x) => x.sub === 'open-ground')) {
      expect(r.overlay, `${r.hydro} on open ground`).toBeUndefined();
      expect(r.base).toBe(r.hydro === 'isolated' ? 'power-isolated' : `power-${r.hydro}`);
    }
  });

  it('never plants a pole in the carriageway', () => {
    // This is the whole point of the kerbside families. Every case that isn't
    // open ground and isn't a square crossing has to move the pole out of the
    // traffic lane; anything left here is a sprite that wasn't built.
    // It must not depend on which of the two was laid second, either.
    const inLane = rows.filter((r) => r.verdict === 'pole-in-lane');
    expect(inLane.map((r) => `${r.hydro} over ${r.sub} (${r.rec})`)).toEqual([]);
  });

  it('picks the kerbside twin matching the carriageway situation', () => {
    for (const r of rows.filter((x) => x.verdict === 'kerbside')) {
      const sub = SUBSTRATES.find((s) => s.name === r.sub)!;
      expect(r.overlay, `${r.hydro} over ${r.sub} (${r.rec})`).toBe(`kerb-${sub.cls}-${r.hydro}`);
    }
  });

  it('leaves nothing but crossings and open ground outside the kerbside set', () => {
    const counts = rows.reduce<Record<string, number>>(
      (acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }), {});
    expect(counts).toEqual({ ground: 16, 'two-pole': 18, kerbside: 206 });
  });

  it('prints the matrix', () => {
    const width = Math.max(...SUBSTRATES.map((s) => s.name.length));
    const glyph: Record<Verdict, string> = {
      ground: '·', 'two-pole': '=', kerbside: '|', 'pole-in-lane': '!', 'no-sprite': 'X'
    };
    const lines = [
      '',
      'HYDRO SPRITE COVERAGE  · open ground  = two-pole crossing  | kerbside pole  ! pole in lane  X no sprite',
      ''.padEnd(12) + SUBSTRATES.map((s) => s.name.padEnd(width + 1)).join('')
    ];
    for (const hydro of HYDRO_CASES) {
      const cells = SUBSTRATES.map((s) => {
        const r = rows.find((row) => row.hydro === hydro && row.sub === s.name)!;
        return glyph[r.verdict].padEnd(width + 1);
      });
      lines.push(hydro.padEnd(12) + cells.join(''));
    }
    console.log(lines.join('\n'));
    if (process.env.HYDRO_MATRIX) {
      for (const r of rows) {
        console.log(`${r.hydro.padEnd(11)} ${r.sub.padEnd(12)} ${r.verdict.padEnd(13)} ` +
          `${(r.base ?? '-').padEnd(18)} ${r.overlay ?? '-'}`);
      }
    }
    expect(lines.length).toBe(HYDRO_CASES.length + 3);
  });
});
