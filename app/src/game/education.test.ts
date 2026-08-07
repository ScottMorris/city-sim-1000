// education.test.ts — servedZoneTiles reads the wire's per-tile education coverage.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { createInitialState } from './gameState';
import { servedZoneTiles } from './education';
import { ServiceId } from './services';
import { BuildingKind } from './buildings/templates';

describe('servedZoneTiles', () => {
  it('returns the tile indices the wire marks served for the matching service, and only that service', () => {
    const state = createInitialState(3, 1);
    state.tiles[0].services.served[ServiceId.EducationElementary] = true;
    state.tiles[2].services.served[ServiceId.EducationHigh] = true;

    expect(servedZoneTiles(state, BuildingKind.ElementarySchool)).toEqual(new Set([0]));
    expect(servedZoneTiles(state, BuildingKind.HighSchool)).toEqual(new Set([2]));
  });

  it('returns an empty set for a template with no education service, or an unknown template id', () => {
    const state = createInitialState(2, 1);
    state.tiles[0].services.served[ServiceId.EducationElementary] = true;

    expect(servedZoneTiles(state, BuildingKind.Park)).toEqual(new Set());
    expect(servedZoneTiles(state, 'not-a-real-template')).toEqual(new Set());
  });
});
