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
    powerLine: {},
    residentialHouses: [],
    commercialBuildings: [],
    commercialGeminiBuildings: [],
    industrialBuildings: [],
    schools: {},
    parks: {},
    indicators: {}
  };
}

const emptyLookup: BuildingLookup = new Map();

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
