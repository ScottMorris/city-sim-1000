// Sprite-picking rules for rail tiles and rail-road level crossings.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import type { Texture } from 'pixi.js';
import { createInitialState, getTile, setTile, TileKind } from '../game/gameState';
import { PowerPlantType } from '../game/constants';
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
    powerLineCrossing: { ns: tex('xing-ns'), ew: tex('xing-ew') },
    powerLineIsolated: tex('iso'),
    powerLineIsolatedOverlay: tex('iso-ovl'),
    powerLineKerbside: {
      'along-ns': { 'corner-ne': tex('kerb-ns-corner-ne') },
      'along-ew': { ew: tex('kerb-ew-ew'), 'end-n': tex('kerb-ew-end-n') },
      junction: { cross: tex('kerb-x-cross') }
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

  it('does not reach out to an adjacent road', () => {
    // Sprite choice must not use isPowerCarrier: power flows through roads,
    // but wires are not strung to them. A line running beside a road used to
    // grow a leg toward it on every tile, which looked goofy.
    const state = createInitialState(8, 8);
    const textures = makeTextures();
    setTile(state, 2, 1, TileKind.PowerLine);
    setTile(state, 2, 2, TileKind.PowerLine);
    setTile(state, 2, 3, TileKind.PowerLine);
    setTile(state, 3, 2, TileKind.Road);        // road running alongside
    expect(spriteName(state, 2, 2, textures)).toBe('power-ns');
  });

  it('still connects to a power plant it runs into', () => {
    const state = createInitialState(8, 8);
    const textures = makeTextures();
    setTile(state, 2, 2, TileKind.PowerLine);
    setTile(state, 2, 1, TileKind.PowerLine);   // north
    const plant = getTile(state, 3, 2)!;        // east
    plant.powerPlantType = PowerPlantType.Coal;
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
    // Road runs E-W; hydro crosses it N-S. The centre tile carries both.
    for (const x of [1, 2, 3]) setTile(state, x, 4, TileKind.Road);
    setTile(state, 2, 3, TileKind.PowerLine);
    setTile(state, 2, 5, TileKind.PowerLine);
    setTile(state, 2, 4, TileKind.PowerLine);
    const tile = getTile(state, 2, 4)!;
    tile.roadUnderlay = true;

    expect(spriteName(state, 2, 4, textures)).toBe('road-ew');
    expect(overlayName(state, 2, 4, textures)).toBe('xing-ns');
  });

  it('keeps the rail visible under a hydro line', () => {
    const state = createInitialState(8, 8);
    const textures = makeTextures();
    // Rail runs N-S; hydro crosses it E-W.
    for (const y of [3, 4, 5]) setTile(state, 2, y, TileKind.Rail);
    setTile(state, 1, 4, TileKind.PowerLine);
    setTile(state, 3, 4, TileKind.PowerLine);
    setTile(state, 2, 4, TileKind.PowerLine);
    const tile = getTile(state, 2, 4)!;
    tile.railUnderlay = true;

    expect(spriteName(state, 2, 4, textures)).toBe('rail-ns');
    expect(overlayName(state, 2, 4, textures)).toBe('xing-ew');
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

describe('hydro crossing poles', () => {
  it('uses the two-pole twin only when the line crosses square', () => {
    const state = createInitialState(8, 8);
    const textures = makeTextures();
    for (const x of [1, 2, 3]) setTile(state, x, 4, TileKind.Road);
    for (const y of [3, 4, 5]) setTile(state, 2, y, TileKind.PowerLine);
    getTile(state, 2, 4)!.roadUnderlay = true;
    expect(overlayName(state, 2, 4, textures)).toBe('xing-ns');
  });

  it('moves the pole to the kerb when the line runs along the road', () => {
    // Parallel run: there is no "either side" to bracket, and dropping the
    // pole would leave the wires unsupported for the whole stretch. So it
    // keeps one pole but stands it on the verge instead of in the lane.
    const state = createInitialState(8, 8);
    const textures = makeTextures();
    for (const x of [1, 2, 3]) setTile(state, x, 4, TileKind.Road);
    for (const x of [1, 2, 3]) setTile(state, x, 4, TileKind.PowerLine);
    for (const t of [[1, 4], [2, 4], [3, 4]]) getTile(state, t[0], t[1])!.roadUnderlay = true;
    expect(overlayName(state, 2, 4, textures)).toBe('kerb-ew-ew');
  });

  it('moves the pole to the kerb where a line dead-ends on a road', () => {
    // The line arrives from the north and stops on the road tile — nothing to
    // bracket, so the two-pole rule declines and the kerbside twin takes it.
    const state = createInitialState(8, 8);
    const textures = makeTextures();
    for (const x of [1, 2, 3]) setTile(state, x, 4, TileKind.Road);
    setTile(state, 2, 3, TileKind.PowerLine);
    setTile(state, 2, 4, TileKind.PowerLine);
    getTile(state, 2, 4)!.roadUnderlay = true;
    expect(overlayName(state, 2, 4, textures)).toBe('kerb-ew-end-n');
  });

  it('tucks the pole into a quadrant on a tile with carriageway both ways', () => {
    const state = createInitialState(8, 8);
    const textures = makeTextures();
    for (const x of [1, 2, 3]) setTile(state, x, 4, TileKind.Road);
    for (const y of [3, 4, 5]) setTile(state, 2, y, TileKind.Road);
    for (const t of [[2, 3], [2, 5], [1, 4], [3, 4], [2, 4]]) setTile(state, t[0], t[1], TileKind.PowerLine);
    for (const t of [[2, 3], [2, 5], [1, 4], [3, 4], [2, 4]]) getTile(state, t[0], t[1])!.roadUnderlay = true;
    expect(overlayName(state, 2, 4, textures)).toBe('kerb-x-cross');
  });
});

describe('isolated hydro pole', () => {
  it('draws a lone pole rather than a 4-way cross wired to nothing', () => {
    const state = createInitialState(8, 8);
    const textures = makeTextures();
    setTile(state, 3, 3, TileKind.PowerLine);
    expect(spriteName(state, 3, 3, textures)).toBe('iso');
  });

  it('is not used once the line has a neighbour', () => {
    const state = createInitialState(8, 8);
    const textures = makeTextures();
    setTile(state, 3, 3, TileKind.PowerLine);
    setTile(state, 3, 2, TileKind.PowerLine);
    expect(spriteName(state, 3, 3, textures)).toBe('power-end-n');
  });
});

describe('crossing selection by axis', () => {
  it('uses two poles even where the road beneath is a T-junction', () => {
    // The old rule matched exact variant names, so a junction fell back to a
    // single pole in the carriageway while the stretch either side got two.
    const state = createInitialState(8, 8);
    const textures = makeTextures();
    for (const x of [1, 2, 3]) setTile(state, x, 4, TileKind.Road);
    setTile(state, 2, 5, TileKind.Road);          // makes it a T
    for (const y of [3, 4, 5]) setTile(state, 2, y, TileKind.PowerLine);
    getTile(state, 2, 4)!.roadUnderlay = true;
    expect(overlayName(state, 2, 4, textures)).toBe('xing-ns');
  });
});
