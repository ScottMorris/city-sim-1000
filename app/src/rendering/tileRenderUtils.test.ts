// Sprite-picking rules for rail tiles and rail-road level crossings.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import type { Texture } from 'pixi.js';
import { createInitialState, getTile, setTile, TileKind } from '../game/gameState';
import { resolveTileSprite, type BuildingLookup } from './tileRenderUtils';
import type { TileTextures } from './tileAtlas';

/** Sentinel "textures" — resolveTileSprite only passes them through, so plain
 *  tagged objects are enough to assert which sprite was picked. */
const tex = (name: string) => ({ name } as unknown as Texture);

function makeTextures(): TileTextures {
  return {
    tiles: {},
    road: { ns: tex('road-ns'), ew: tex('road-ew'), 'end-e': tex('road-end-e'), cross: tex('road-cross') },
    rail: {
      ns: tex('rail-ns'), ew: tex('rail-ew'), 'corner-se': tex('rail-corner-se'),
      'end-w': tex('rail-end-w'), cross: tex('rail-cross')
    },
    railCrossing: { ns: tex('crossing-ns'), ew: tex('crossing-ew') },
    powerPlant: {},
    powerLine: {
      ns: tex('power-ns'), ew: tex('power-ew'), 'corner-ne': tex('power-corner-ne'),
      'corner-se': tex('power-corner-se'),
      't-nes': tex('power-t-nes'), cross: tex('power-cross'), 'end-n': tex('power-end-n')
    },
    powerLineOverlay: {
      ns: tex('ovl-ns'), ew: tex('ovl-ew'), 'corner-ne': tex('ovl-corner-ne'),
      'corner-se': tex('ovl-corner-se'), 't-nes': tex('ovl-t-nes'),
      cross: tex('ovl-cross'), 'end-n': tex('ovl-end-n')
    },
    residentialHouses: [tex('res-1')],
    commercialBuildings: [],
    commercialGeminiBuildings: [],
    industrialBuildings: [],
    schools: {},
    parks: {},
    indicators: {}
  };
}

const emptyLookup: BuildingLookup = new Map();

function overlayName(state: ReturnType<typeof createInitialState>, x: number, y: number, textures: TileTextures) {
  const info = resolveTileSprite(state, getTile(state, x, y), x, y, textures, emptyLookup);
  const t = info && 'texture' in info ? info.overlayTexture : undefined;
  return (t as unknown as { name: string } | undefined)?.name;
}

function spriteName(state: ReturnType<typeof createInitialState>, x: number, y: number, textures: TileTextures) {
  const info = resolveTileSprite(state, getTile(state, x, y), x, y, textures, emptyLookup);
  return info && 'texture' in info ? (info.texture as unknown as { name: string }).name : undefined;
}

describe('rail sprite picking', () => {
  it('picks connectivity variants from rail neighbours, like roads', () => {
    const state = createInitialState(5, 5);
    const textures = makeTextures();
    // Horizontal rail line through (1..3, 2).
    for (const x of [1, 2, 3]) setTile(state, x, 2, TileKind.Rail);
    expect(spriteName(state, 2, 2, textures)).toBe('rail-ew');
    // Right end of the line has only a western neighbour.
    expect(spriteName(state, 3, 2, textures)).toBe('rail-end-w');
  });

  it('picks a corner where the line turns', () => {
    const state = createInitialState(5, 5);
    const textures = makeTextures();
    // Rail arrives from the west and leaves to the south: S+E... the corner
    // tile at (2,2) has neighbours E (3,2) and S (2,3) -> corner-se.
    setTile(state, 3, 2, TileKind.Rail);
    setTile(state, 2, 2, TileKind.Rail);
    setTile(state, 2, 3, TileKind.Rail);
    expect(spriteName(state, 2, 2, textures)).toBe('rail-corner-se');
  });

  it('falls back to the 4-way cross for an isolated rail tile', () => {
    const state = createInitialState(5, 5);
    const textures = makeTextures();
    setTile(state, 2, 2, TileKind.Rail);
    expect(spriteName(state, 2, 2, textures)).toBe('rail-cross');
  });
});

describe('rail-road level crossings', () => {
  it('renders the crossing when rail is laid over a road, oriented by the rail axis', () => {
    const state = createInitialState(5, 5);
    const textures = makeTextures();
    // Road runs EW; rail runs NS and was laid second (kind Rail + roadUnderlay).
    for (const x of [1, 2, 3]) setTile(state, x, 2, TileKind.Road);
    for (const y of [1, 2, 3]) setTile(state, 2, y, TileKind.Rail);
    const crossingTile = getTile(state, 2, 2)!;
    crossingTile.roadUnderlay = true;
    expect(spriteName(state, 2, 2, textures)).toBe('crossing-ns');
  });

  it('renders the crossing when road is laid over rail (kind Road + railUnderlay)', () => {
    const state = createInitialState(5, 5);
    const textures = makeTextures();
    // Rail runs EW; the crossing tile itself is a road with railUnderlay.
    for (const x of [1, 3]) setTile(state, x, 2, TileKind.Rail);
    setTile(state, 2, 1, TileKind.Road);
    setTile(state, 2, 2, TileKind.Road);
    setTile(state, 2, 3, TileKind.Road);
    const crossingTile = getTile(state, 2, 2)!;
    crossingTile.railUnderlay = true;
    expect(spriteName(state, 2, 2, textures)).toBe('crossing-ew');
  });

  it('leaves plain roads on the road sprite set', () => {
    const state = createInitialState(5, 5);
    const textures = makeTextures();
    for (const x of [1, 2, 3]) setTile(state, x, 2, TileKind.Road);
    expect(spriteName(state, 2, 2, textures)).toBe('road-ew');
  });
});

describe('hydro line sprite picking', () => {
  // Before the 15-variant set existed only straight runs and dead ends
  // resolved to a sprite; corners, T-junctions and crossings fell through to
  // a flat colour rect. These lock in the full connectivity mapping.
  it('picks connectivity variants from power-carrying neighbours', () => {
    const state = createInitialState(8, 8);
    const textures = makeTextures();
    // Vertical run.
    setTile(state, 2, 1, TileKind.PowerLine);
    setTile(state, 2, 2, TileKind.PowerLine);
    setTile(state, 2, 3, TileKind.PowerLine);
    expect(spriteName(state, 2, 2, textures)).toBe('power-ns');

    // Turning east at the top of the run makes that tile a corner (it
    // connects south and east), not a tile with no sprite at all.
    setTile(state, 3, 1, TileKind.PowerLine);
    expect(spriteName(state, 2, 1, textures)).toBe('power-corner-se');
  });

  it('resolves T-junctions and crossings instead of falling through', () => {
    const state = createInitialState(8, 8);
    const textures = makeTextures();
    setTile(state, 4, 4, TileKind.PowerLine);
    setTile(state, 4, 3, TileKind.PowerLine);   // north
    setTile(state, 5, 4, TileKind.PowerLine);   // east
    setTile(state, 4, 5, TileKind.PowerLine);   // south
    expect(spriteName(state, 4, 4, textures)).toBe('power-t-nes');

    setTile(state, 3, 4, TileKind.PowerLine);   // + west
    expect(spriteName(state, 4, 4, textures)).toBe('power-cross');
  });

  it('treats roads and zones as connections, like the power grid does', () => {
    // isPowerCarrier counts roads, rails, zones and buildings — so a line run
    // beside built-up land hits the junction variants constantly.
    const state = createInitialState(8, 8);
    const textures = makeTextures();
    setTile(state, 2, 2, TileKind.PowerLine);
    setTile(state, 2, 1, TileKind.PowerLine);   // north
    setTile(state, 3, 2, TileKind.Road);        // east
    expect(spriteName(state, 2, 2, textures)).toBe('power-corner-ne');
  });

  it('gives an isolated pole a dead-end sprite when it has one neighbour', () => {
    const state = createInitialState(8, 8);
    const textures = makeTextures();
    setTile(state, 2, 2, TileKind.PowerLine);
    setTile(state, 2, 1, TileKind.PowerLine);
    expect(spriteName(state, 2, 2, textures)).toBe('power-end-n');
  });
});

describe('hydro crossing road, rail and zones (issue #169)', () => {
  // The wire sprites are opaque ground tiles, so drawing one over a road tile
  // painted grass across the road. Crossings draw the infrastructure beneath
  // and composite a transparent wire twin on top.
  it('keeps the road visible and layers the wires over it', () => {
    const state = createInitialState(8, 8);
    const textures = makeTextures();
    for (const x of [1, 2, 3]) setTile(state, x, 4, TileKind.Road);
    // Hydro laid along the road: kind becomes PowerLine, roadUnderlay is kept.
    setTile(state, 2, 4, TileKind.PowerLine);
    const tile = getTile(state, 2, 4)!;
    tile.roadUnderlay = true;

    expect(spriteName(state, 2, 4, textures)).toBe('road-ew');
    expect(overlayName(state, 2, 4, textures)).toBe('ovl-ew');
  });

  it('keeps the rail visible under a hydro line', () => {
    const state = createInitialState(8, 8);
    const textures = makeTextures();
    for (const y of [3, 4, 5]) setTile(state, 2, y, TileKind.Rail);
    setTile(state, 2, 4, TileKind.PowerLine);
    const tile = getTile(state, 2, 4)!;
    tile.railUnderlay = true;

    expect(spriteName(state, 2, 4, textures)).toBe('rail-ns');
    expect(overlayName(state, 2, 4, textures)).toBe('ovl-ns');
  });

  it('draws wires over a zone that only recorded powerOverlay', () => {
    // Zones keep their own kind, so without compositing the wires never
    // rendered in the base view at all.
    const state = createInitialState(8, 8);
    const textures = makeTextures();
    setTile(state, 2, 4, TileKind.Residential);
    const tile = getTile(state, 2, 4)!;
    tile.buildingId = 1;
    tile.powerOverlay = true;
    setTile(state, 2, 3, TileKind.PowerLine);
    setTile(state, 2, 5, TileKind.PowerLine);

    expect(spriteName(state, 2, 4, textures)).toBe('res-1');
    expect(overlayName(state, 2, 4, textures)).toBe('ovl-ns');
  });

  it('does not double-draw wires on open ground', () => {
    // A plain hydro tile keeps its opaque sprite, which already has wires;
    // compositing again would draw them twice.
    const state = createInitialState(8, 8);
    const textures = makeTextures();
    setTile(state, 2, 3, TileKind.PowerLine);
    setTile(state, 2, 4, TileKind.PowerLine);
    setTile(state, 2, 5, TileKind.PowerLine);

    expect(spriteName(state, 2, 4, textures)).toBe('power-ns');
    expect(overlayName(state, 2, 4, textures)).toBeUndefined();
  });
});
