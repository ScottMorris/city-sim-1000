// Hydro sprite coverage matrix — the classification tool for issue #169.
//
// Every hydro tile is the product of two independent things:
//
//   1. its own wire connectivity (16 cases: the 15 road-style variants plus
//      `isolated`, a pole with nothing attached), and
//   2. what it was laid over (open ground, a road, a rail, or a level
//      crossing — each with its own axis).
//
// That product is 112 cases, and eyeballing screenshots has repeatedly missed
// whole families of them. This file enumerates the lot, resolves each one
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
import type { TileTextures, RoadVariant } from './tileAtlas';

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
type HydroCase = RoadVariant | 'isolated';
const HYDRO_CASES: HydroCase[] = [...VARIANTS, 'isolated'];

/** What the tile was laid over. `axis` is the substrate's own connectivity —
 *  it decides whether the line crosses it or runs along it. */
type Substrate = {
  readonly name: string;
  readonly road: ReadonlyArray<'n' | 'e' | 's' | 'w'> | null;
  readonly rail: ReadonlyArray<'n' | 'e' | 's' | 'w'> | null;
};

const SUBSTRATES: Substrate[] = [
  { name: 'open-ground', road: null,             rail: null },
  { name: 'road-ns',     road: ['n', 's'],       rail: null },
  { name: 'road-ew',     road: ['e', 'w'],       rail: null },
  { name: 'road-cross',  road: ['n','e','s','w'],rail: null },
  { name: 'road-end-e',  road: ['e'],            rail: null },
  { name: 'rail-ns',     road: null,             rail: ['n', 's'] },
  { name: 'rail-ew',     road: null,             rail: ['e', 'w'] },
  { name: 'level-xing',  road: ['e', 'w'],       rail: ['n', 's'] }
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
    residentialHouses: [], commercialBuildings: [], commercialGeminiBuildings: [],
    industrialBuildings: [], schools: {}, parks: {}, indicators: {}
  };
}

const emptyLookup: BuildingLookup = new Map();
const CX = 3, CY = 3;

/** Build a 7×7 world with one hydro tile at the centre carrying `hydro`
 *  connectivity and laid over `sub`. Neighbours are given whatever kind makes
 *  the centre tile see the edges it needs — a neighbour that is both a wire
 *  and part of the substrate becomes a hydro tile with the matching underlay,
 *  exactly as the sim would record it. */
function buildCase(hydro: HydroCase, sub: Substrate): GameState {
  const state = createInitialState(7, 7, 1);
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) setTile(state, x, y, TileKind.Land);

  const wireEdges = hydro === 'isolated' ? [] : EDGES[hydro];
  const roadEdges = sub.road ?? [];
  const railEdges = sub.rail ?? [];

  setTile(state, CX, CY, TileKind.PowerLine);
  const centre = getTile(state, CX, CY)!;
  if (sub.road) centre.roadUnderlay = true;
  if (sub.rail) centre.railUnderlay = true;

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

/** How a resolved case reads on screen. The only *failing* verdict is
 *  `no-sprite`; `pole-in-lane` is a real art gap, tracked explicitly below so
 *  it cannot quietly grow. */
type Verdict = 'no-sprite' | 'ground' | 'two-pole' | 'pole-in-lane';

function classify(sub: Substrate, r: Resolved): Verdict {
  if (!r.base) return 'no-sprite';
  if (!sub.road && !sub.rail) return 'ground';
  if (!r.overlay) return 'no-sprite';         // over a carriageway with no wires drawn
  return r.overlay.startsWith('two-pole') ? 'two-pole' : 'pole-in-lane';
}

/** Why the two-pole rule declined — the axis a new sprite would have to cover. */
function gapReason(hydro: HydroCase, sub: Substrate): string {
  if (hydro === 'isolated') return 'terminus: lone pole standing in the carriageway';
  if (hydro.startsWith('end-')) return 'terminus: the run dead-ends on the carriageway';
  if (hydro !== 'ns' && hydro !== 'ew') return 'junction: the line turns or branches on the carriageway';
  const beneath = sub.rail ?? sub.road ?? [];
  const crosses = hydro === 'ns' ? beneath.includes('e') || beneath.includes('w')
                                 : beneath.includes('n') || beneath.includes('s');
  return crosses ? 'UNEXPECTED: straight line squarely across, should be two-pole'
                 : 'parallel: the line runs along the carriageway, pole in the lane';
}

type Row = { hydro: HydroCase; sub: string; verdict: Verdict; base?: string; overlay?: string; reason?: string };

function sweep(): Row[] {
  const textures = makeTextures();
  const rows: Row[] = [];
  for (const hydro of HYDRO_CASES) {
    for (const sub of SUBSTRATES) {
      const r = resolve(buildCase(hydro, sub), textures);
      const verdict = classify(sub, r);
      rows.push({
        hydro, sub: sub.name, verdict, base: r.base, overlay: r.overlay,
        reason: verdict === 'pole-in-lane' ? gapReason(hydro, sub) : undefined
      });
    }
  }
  return rows;
}

describe('hydro sprite coverage matrix', () => {
  const rows = sweep();

  it('covers every connectivity against every substrate', () => {
    expect(rows).toHaveLength(HYDRO_CASES.length * SUBSTRATES.length);
  });

  it('never falls through to the flat colour rect', () => {
    // `resolveTileSprite` returning undefined makes the renderer draw a bare
    // coloured square, so a missing variant is a *visible* bug, not a silent
    // one. This is the assertion that caught 10 of the original 16.
    const missing = rows.filter((r) => r.verdict === 'no-sprite');
    expect(missing.map((r) => `${r.hydro} over ${r.sub}`)).toEqual([]);
  });

  it('carries a straight line squarely across a carriageway on two poles', () => {
    const crossings = rows.filter((r) => r.verdict === 'two-pole');
    expect(crossings.map((r) => `${r.hydro}/${r.sub}`).sort()).toEqual([
      'ew/level-xing', 'ew/rail-ns', 'ew/road-cross', 'ew/road-ns',
      'ns/level-xing', 'ns/rail-ew', 'ns/road-cross', 'ns/road-end-e', 'ns/road-ew'
    ]);
    for (const r of crossings) {
      expect(r.overlay).toBe(r.hydro === 'ns' ? 'two-pole-ns' : 'two-pole-ew');
    }
  });

  it('draws the road or rail beneath, never replacing it', () => {
    for (const r of rows.filter((x) => x.sub !== 'open-ground')) {
      expect(r.base, `${r.hydro} over ${r.sub}`).not.toMatch(/^(power|ovl)-/);
    }
  });

  it('draws the opaque sprite with no overlay on open ground', () => {
    for (const r of rows.filter((x) => x.sub === 'open-ground')) {
      expect(r.overlay, `${r.hydro} on open ground`).toBeUndefined();
      expect(r.base).toBe(r.hydro === 'isolated' ? 'power-isolated' : `power-${r.hydro}`);
    }
  });

  // The remaining cases all resolve to a sprite, but it is the single-pole
  // one — so the pole is drawn standing in the carriageway. Freezing the
  // count means a change that widens the gap fails here rather than shipping.
  it('records the cases still planting a pole in the carriageway', () => {
    const gaps = rows.filter((r) => r.verdict === 'pole-in-lane');
    const byReason = new Map<string, number>();
    for (const g of gaps) byReason.set(g.reason!, (byReason.get(g.reason!) ?? 0) + 1);

    expect([...byReason.entries()].sort()).toEqual([
      ['junction: the line turns or branches on the carriageway', 63],
      ['parallel: the line runs along the carriageway, pole in the lane', 5],
      ['terminus: lone pole standing in the carriageway', 7],
      ['terminus: the run dead-ends on the carriageway', 28]
    ]);
    // No case should reach here by the two-pole rule misfiring on a genuine
    // square crossing — that would be a logic bug, not an art gap.
    expect(gaps.filter((g) => g.reason!.startsWith('UNEXPECTED'))).toEqual([]);
  });

  it('prints the matrix', () => {
    const width = Math.max(...SUBSTRATES.map((s) => s.name.length));
    const glyph: Record<Verdict, string> = {
      ground: '·', 'two-pole': '=', 'pole-in-lane': '!', 'no-sprite': 'X'
    };
    const lines = [
      '',
      'HYDRO SPRITE COVERAGE  · open ground   = two-pole crossing   ! pole in lane   X no sprite',
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
          `${(r.base ?? '-').padEnd(18)} ${(r.overlay ?? '-').padEnd(16)} ${r.reason ?? ''}`);
      }
    }
    expect(lines.length).toBe(HYDRO_CASES.length + 3);
  });
});
