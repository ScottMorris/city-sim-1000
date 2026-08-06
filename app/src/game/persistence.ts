// persistence.ts — save/load: IndexedDB CSAV containers, legacy JSON back-fill, and downloads.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { LOCAL_STORAGE_KEY } from './constants';
import type { BylawState } from './bylaws';
import { GameState, TileKind, type GameSettings } from './gameState';
import { SeededRng } from './rng';
import {
  clampBudgetPolicy,
  createDefaultBudgetPolicy,
  createDefaultWildernessPolicy,
  type Policies
} from './protocol/commands';
import type { ClientState } from './clientState';
import type { LegacyEngineImport } from '../workers/wasmSim.worker';
import { encodeHappiness } from './protocol/tileBuffer';
import { LEGACY_BYTES_PER_TILE, LEGACY_FLAGS, legacyTileBufferOffsets } from './protocol/legacyTileBuffer';
import { TILE_KIND_TO_U8 } from './protocol/tileKind';

/** The v4 kind byte for a buried pipe — the only producible `underground` value. */
const LEGACY_WATER_PIPE_U8 = TILE_KIND_TO_U8.get(TileKind.WaterPipe) ?? 0xff;


// ---------------------------------------------------------------------------
// CSAV v1 — the binary save container
// ---------------------------------------------------------------------------
//
//   "CSAV" | u32 LE version=1 | u32 LE M | meta JSON (UTF-8)
//          | u32 LE E | engine snapshot (CSIM blob, self-versioned postcard)
//          | u32 LE C | client JSON (UTF-8, ClientState)
//
// The engine snapshot is byte-for-byte what `SimHost.get_snapshot()` (or the
// Tauri plugin's `get_snapshot`) returns — the container never inspects it.
// The meta JSON is readable without decoding postcard, for save pickers and
// autosave stamps. Legacy JSON saves (plain serialised `GameState`, possibly
// with a `cmdLog` sibling key) remain loadable forever via `transcodeLegacySave`
// + the engine's legacy import.

const CSAV_MAGIC = 0x43534156; // "CSAV" big-endian read of the 4 magic bytes
const CSAV_VERSION = 1;

/** Headline save facts, decodable without touching postcard. */
export interface SaveMeta {
  name?: string;
  /** ISO-8601 timestamp of the save. */
  savedAt: string;
  kind: 'manual' | 'autosave';
  width: number;
  height: number;
  seed: number;
  tick: number;
  day: number;
  population: number;
  money: number;
}

export interface SaveContainer {
  meta: SaveMeta;
  /** CSIM engine snapshot bytes — opaque to the container. */
  engineSnapshot: Uint8Array;
  client: ClientState;
}

export class SaveFormatError extends Error {}

export function buildSaveMeta(state: GameState, kind: SaveMeta['kind'], savedAt: string): SaveMeta {
  return {
    savedAt,
    kind,
    width: state.width,
    height: state.height,
    seed: state.seed,
    tick: state.tick,
    day: Math.floor(state.day),
    population: state.population,
    money: state.money
  };
}

export function encodeSave(container: SaveContainer): Uint8Array {
  const encoder = new TextEncoder();
  const metaBytes = encoder.encode(JSON.stringify(container.meta));
  const clientBytes = encoder.encode(JSON.stringify(container.client));
  const engineBytes = container.engineSnapshot;
  const total = 8 + 4 + metaBytes.length + 4 + engineBytes.length + 4 + clientBytes.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  view.setUint32(offset, CSAV_MAGIC, false);
  offset += 4;
  view.setUint32(offset, CSAV_VERSION, true);
  offset += 4;
  for (const section of [metaBytes, engineBytes, clientBytes]) {
    view.setUint32(offset, section.length, true);
    offset += 4;
    out.set(section, offset);
    offset += section.length;
  }
  return out;
}

export function decodeSave(bytes: Uint8Array): SaveContainer {
  if (bytes.length < 8) throw new SaveFormatError('Save file is truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== CSAV_MAGIC) {
    throw new SaveFormatError('Not a CSAV save file (bad magic)');
  }
  const version = view.getUint32(4, true);
  if (version !== CSAV_VERSION) {
    throw new SaveFormatError(`Unsupported save version ${version} (expected ${CSAV_VERSION})`);
  }
  let offset = 8;
  const readSection = (): Uint8Array => {
    if (offset + 4 > bytes.length) throw new SaveFormatError('Save file is truncated');
    const length = view.getUint32(offset, true);
    offset += 4;
    if (offset + length > bytes.length) throw new SaveFormatError('Save file is truncated');
    const section = bytes.subarray(offset, offset + length);
    offset += length;
    return section;
  };
  const decoder = new TextDecoder();
  let meta: SaveMeta;
  let client: ClientState;
  const metaBytes = readSection();
  const engineSnapshot = readSection().slice();
  const clientBytes = readSection();
  try {
    meta = JSON.parse(decoder.decode(metaBytes)) as SaveMeta;
    client = JSON.parse(decoder.decode(clientBytes)) as ClientState;
  } catch {
    throw new SaveFormatError('Save file has corrupt JSON sections');
  }
  return { meta, engineSnapshot, client };
}

/** True when `bytes` look like a legacy JSON save rather than a CSAV blob. */
export function isLegacyJsonSave(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return byte === 0x7b; // '{'
  }
  return false;
}

// ---------------------------------------------------------------------------
// Legacy JSON saves → engine import
// ---------------------------------------------------------------------------

/** Read + transcode the legacy localStorage save, or null when absent. */
export function loadLegacyBrowserSave(): LegacySaveTranscode | null {
  const data = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (!data) return null;
  // Older saves may carry a `cmdLog` sibling key (PR #110); the snapshot
  // model has no use for it — the tile grid itself is imported exactly.
  const { cmdLog: _cmdLog, ...stateData } = JSON.parse(data) as Record<string, unknown>;
  return transcodeLegacySave(JSON.stringify(stateData));
}

/** Delete the legacy localStorage save (after a confirmed CSAV write). */
export function clearLegacyBrowserSave(): void {
  localStorage.removeItem(LOCAL_STORAGE_KEY);
}

/** Parse an uploaded legacy JSON save file. */
export function decodeLegacySave(json: string): LegacySaveTranscode {
  const { cmdLog: _cmdLog, ...stateData } = JSON.parse(json) as Record<string, unknown>;
  return transcodeLegacySave(JSON.stringify(stateData));
}

/** Result of a one-shot legacy JSON save transcode — see `transcodeLegacySave`. */
export interface LegacySaveTranscode {
  engine: LegacyEngineImport;
  client: { settings?: Partial<GameSettings>; bylaws?: Partial<BylawState> };
  policies: Policies;
}

/**
 * Transcode a legacy `.citysim` JSON save straight into the frozen v4 wire
 * buffer + import scalars `SimHost.import_legacy` expects — reading the raw
 * parsed JSON fields directly, with no intermediate strata `GameState`. This
 * is a non-semantic byte transcode: Rust's `tile_from_v4` (via
 * `city_sim_core::import::from_tile_buffer`) is the sole place a v4-shaped
 * tile is decoded into strata now, so the same tile is no longer decoded
 * into strata here only to be re-derived back into v4 bytes for the wire.
 *
 * `client`/`policies` carry the TS-owned save slices untouched —
 * `applyClientState` (`clientState.ts`) normalises the partial settings/
 * bylaws itself, and `policies` here is folded/clamped the same way the old
 * pre-refactor import path did (also embedded in `engine.policies` for the
 * one-time import, and returned again at the top level for `setPoliciesCmd`
 * — mirrors `importLegacyCity`'s two separate uses of it).
 */
export function transcodeLegacySave(json: string): LegacySaveTranscode {
  const raw = JSON.parse(json) as Record<string, any>;
  const width: number = raw.width;
  const height: number = raw.height;
  const n = width * height;
  const o = legacyTileBufferOffsets(n);
  const tiles = new Uint8Array(n * LEGACY_BYTES_PER_TILE);
  const rawTiles: any[] = raw.tiles;

  for (let i = 0; i < n; i++) {
    const tile = rawTiles[i] ?? {};
    tiles[o.kind + i] = TILE_KIND_TO_U8.get(tile.kind) ?? 0;
    tiles[o.flags + i] =
      (tile.powered ? LEGACY_FLAGS.POWERED : 0) |
      (tile.watered ? LEGACY_FLAGS.WATERED : 0) |
      (tile.abandoned ? LEGACY_FLAGS.ABANDONED : 0) |
      (tile.roadUnderlay ? LEGACY_FLAGS.ROAD_UNDERLAY : 0) |
      (tile.railUnderlay ? LEGACY_FLAGS.RAIL_UNDERLAY : 0) |
      (tile.powerOverlay ? LEGACY_FLAGS.POWER_OVERLAY : 0);
    tiles[o.happiness + i] = encodeHappiness(tile.happiness ?? 0);
    tiles[o.elevation + i] = (tile.elevation ?? 0) & 0xff;
    const buildingId = tile.buildingId ?? tile.powerPlantId ?? 0;
    tiles[o.buildingId + i * 2] = buildingId & 0xff;
    tiles[o.buildingId + i * 2 + 1] = (buildingId >> 8) & 0xff;
    tiles[o.undergroundKind + i] = tile.underground === TileKind.WaterPipe ? LEGACY_WATER_PIPE_U8 : 0xff;
    tiles[o.wilderness + i] = 128; // recomputed by the sim within one interval
  }

  // Civic back-fill: a save from before `buildingId` existed on pump/
  // water_tower/park tiles needs a fresh id minted directly into the buffer
  // so the Rust importer can rebuild a `BuildingInstance` for it — same
  // arithmetic the pre-refactor import path's civic back-fill used to run,
  // read off the raw fields instead of a post-strata tile.
  const computeNextBuildingId = (): number => {
    let max = 0;
    for (const tile of rawTiles) {
      const id = tile?.buildingId ?? tile?.powerPlantId;
      if (id !== undefined) max = Math.max(max, Number(id));
    }
    for (const building of raw.buildings ?? []) {
      if (building?.id !== undefined) max = Math.max(max, Number(building.id));
    }
    max = Math.max(max, raw.nextPowerPlantId ?? 0);
    return max + 1;
  };
  let nextBuildingId = Math.max(raw.nextBuildingId ?? 0, computeNextBuildingId());
  for (let i = 0; i < n; i++) {
    const tile = rawTiles[i] ?? {};
    const hasId = (tile.buildingId ?? tile.powerPlantId) !== undefined;
    const isLegacyCivic =
      !hasId &&
      (tile.kind === TileKind.WaterPump || tile.kind === TileKind.WaterTower || tile.kind === TileKind.Park);
    if (!isLegacyCivic) continue;
    const id = nextBuildingId++;
    tiles[o.buildingId + i * 2] = id & 0xff;
    tiles[o.buildingId + i * 2 + 1] = (id >> 8) & 0xff;
  }

  const seed = raw.seed ?? 0;
  const rngState: [number, number, number, number] =
    Array.isArray(raw.rngState) && raw.rngState.length === 4
      ? (raw.rngState as [number, number, number, number])
      : new SeededRng(seed).toJSON();

  const legacyBudget = raw.policies?.budget ?? raw.budgetPolicy;
  const legacyWilderness = raw.policies?.wilderness ?? raw.wildernessPolicy;
  const policies: Policies = {
    budget: legacyBudget
      ? clampBudgetPolicy({ ...createDefaultBudgetPolicy(), ...legacyBudget })
      : createDefaultBudgetPolicy(),
    wilderness: { ...createDefaultWildernessPolicy(), ...(legacyWilderness ?? {}) }
  };

  return {
    engine: {
      width,
      height,
      seed,
      rngState,
      tiles,
      money: raw.money,
      day: Math.floor(raw.day ?? 0),
      tick: raw.tick ?? 0,
      population: Math.floor(raw.population ?? 0),
      jobs: Math.floor(raw.jobs ?? 0),
      policies
    },
    client: { settings: raw.settings, bylaws: raw.bylaws },
    policies
  };
}

/** Trigger a browser download of a CSAV container as a `.citysim` file. */
export function downloadSave(container: Uint8Array, filename: string): void {
  const blob = new Blob([container.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Wrap a CSAV container as a `File` — same bytes/filename convention as `downloadSave`, shareable via the Web Share API. */
export function buildSaveFile(container: Uint8Array, filename: string): File {
  return new File([container.slice().buffer as ArrayBuffer], filename, { type: 'application/octet-stream' });
}
