/**
 * Stable, deterministic hash over the gameplay-affecting subset of GameState.
 *
 * Used to detect simulation divergence between runs (same seed + command log
 * must produce the same hash) and, later, between the TS oracle and the Rust
 * sim_core (tolerance-banded comparison of derived metrics).
 *
 * Design choices:
 * - Excludes settings, UI state, budgetHistory — only gameplay-affecting fields.
 * - Floats are quantised to integers (×1000, rounded) before hashing so tiny
 *   floating-point order-of-operations differences don't produce false mismatches.
 * - All collections are sorted by a stable key before serialisation.
 * - The final hash is SHA-256 (via Web Crypto), returned as a hex string.
 */

import type { GameState } from './gameState';

export interface StateSnapshot {
  tick: number;
  day: number;
  money: number;
  population: number;
  jobs: number;
  seed: number;
  rngState: [number, number, number, number];
  utilities: {
    power: number;
    water: number;
    powerProduced: number;
    powerUsed: number;
    waterProduced: number;
    waterUsed: number;
  };
  demand: { residential: number; commercial: number; industrial: number };
  tileCounts: Record<string, number>;
  abandonedCount: number;
  buildingCount: number;
}

/** Extract a deterministic snapshot from GameState for hashing. */
export function extractSnapshot(state: GameState): StateSnapshot {
  const tileCounts: Record<string, number> = {};
  let abandonedCount = 0;

  for (const tile of state.tiles) {
    tileCounts[tile.kind] = (tileCounts[tile.kind] ?? 0) + 1;
    if (tile.abandoned) abandonedCount++;
  }

  return {
    tick: state.tick,
    day: q(state.day),
    money: q(state.money),
    population: state.population,
    jobs: state.jobs,
    seed: state.seed,
    rngState: [...state.rngState] as [number, number, number, number],
    utilities: {
      power: q(state.utilities.power),
      water: q(state.utilities.water),
      powerProduced: q(state.utilities.powerProduced),
      powerUsed: q(state.utilities.powerUsed),
      waterProduced: q(state.utilities.waterProduced),
      waterUsed: q(state.utilities.waterUsed),
    },
    demand: {
      residential: q(state.demand.residential),
      commercial: q(state.demand.commercial),
      industrial: q(state.demand.industrial),
    },
    tileCounts,
    abandonedCount,
    buildingCount: state.buildings.length,
  };
}

/** Stable JSON serialisation — object keys sorted, collections ordered. */
export function snapshotToString(snap: StateSnapshot): string {
  return JSON.stringify(snap, sortedReplacer);
}

/** SHA-256 hex of the snapshot. Requires the Web Crypto API (browser or Node 16+). */
export async function hashSnapshot(snap: StateSnapshot): Promise<string> {
  const text = snapshotToString(snap);
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Convenience: extract + hash in one call. */
export async function hashState(state: GameState): Promise<string> {
  return hashSnapshot(extractSnapshot(state));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Quantise a float to an integer (×1000, rounded) to absorb fp jitter. */
function q(v: number): number {
  return Math.round(v * 1000);
}

/** JSON replacer that sorts object keys for stable output. */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}
