// legacyStateSerialize.ts — test-only `GameState` JSON round-trip helpers.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import type { GameState } from '../gameState';
import { deserialize } from '../persistence';

/**
 * Test-only: serialise a `GameState` to the plain JSON shape `deserialize`
 * (in `../persistence`) back-fills from. Has no production caller —
 * `persistence.ts`'s real save path is the binary CSAV container
 * (`encodeSave`/`decodeSave`); this exists purely so tests can build a
 * legacy JSON payload to feed back through `deserialize`, or round-trip a
 * `GameState` via `copyState` below.
 */
export function serialize(state: GameState): string {
  return JSON.stringify(state);
}

/** Test-only: deep-copy a `GameState` via a `serialize`/`deserialize` round trip. */
export function copyState(state: GameState): GameState {
  return deserialize(serialize(state));
}
