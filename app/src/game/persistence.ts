import { LOCAL_STORAGE_KEY } from './constants';
import { DEFAULT_BYLAWS } from './bylaws';
import {
  GameState,
  TileKind,
  createDefaultMinimapSettings,
  createDefaultSettings,
  createDefaultWildernessStats
} from './gameState';
import { SeededRng } from './rng';
import { createBuildingState } from './buildings/state';
import { getBuildingTemplate } from './buildings/templates';
import {
  createEmptyServiceLoad,
  createServiceSystemState,
  createTileServiceState,
  DEFAULT_SERVICE_DEFINITIONS
} from './services';
import { createEmptyEducationStats } from './education';
import {
  clampBudgetPolicy,
  createDefaultBudgetPolicy,
  createDefaultWildernessPolicy
} from './protocol/commands';
import type { ClientState } from './clientState';
import type { LegacyEngineImport } from '../workers/wasmSim.worker';
import { encodeHappiness } from './protocol/tileBuffer';
import { LEGACY_BYTES_PER_TILE, LEGACY_FLAGS, legacyTileBufferOffsets } from './protocol/legacyTileBuffer';
import { tileKindToU8 } from './protocol/tileKind';
import { tileFromV4 } from './protocol/legacyProjection';

export function serialize(state: GameState): string {
  return JSON.stringify(state);
}

export function deserialize(payload: string): GameState {
  const parsed = JSON.parse(payload);
  if (!parsed.utilities) {
    parsed.utilities = {
      power: parsed.power ?? 0,
      water: parsed.water ?? 0,
      powerProduced: 0,
      powerUsed: 0,
      waterProduced: 0,
      waterUsed: 0
    };
  } else {
    parsed.utilities.powerProduced = parsed.utilities.powerProduced ?? 0;
    parsed.utilities.powerUsed = parsed.utilities.powerUsed ?? 0;
    parsed.utilities.waterProduced = parsed.utilities.waterProduced ?? 0;
    parsed.utilities.waterUsed = parsed.utilities.waterUsed ?? 0;
  }
  parsed.services = parsed.services ?? createServiceSystemState();
  parsed.services.definitions = parsed.services.definitions ?? {
    ...DEFAULT_SERVICE_DEFINITIONS
  };
  Object.entries(DEFAULT_SERVICE_DEFINITIONS).forEach(([id, def]) => {
    if (!parsed.services.definitions[id]) {
      parsed.services.definitions[id] = def;
    }
  });
  parsed.tiles = parsed.tiles.map((tile: any) => {
    const buildingId = tile.buildingId ?? tile.powerPlantId;
    const base = {
      ...tile,
      powered: tile.powered ?? false,
      watered: tile.watered ?? false,
      powerPlantType: tile.powerPlantType,
      powerPlantId: tile.powerPlantId,
      buildingId,
      services: tile.services ?? createTileServiceState()
    };
    // `terrain` only exists on a tile written after this migration — a save
    // from before it has no strata at all, and its `underground` key is the
    // old `TileKind | undefined` field, not the new occupant bitset. Decode
    // that v4 spelling into strata, same as `migrate::tile_from_v4` does for
    // the Rust-side importer. A tile that already has `terrain` already has
    // everything strata-shaped needs — nothing to decode.
    if (tile.terrain !== undefined) return base;
    const strata = tileFromV4(
      tile.kind,
      { roadUnderlay: tile.roadUnderlay, railUnderlay: tile.railUnderlay, powerOverlay: tile.powerOverlay },
      tile.underground,
      buildingId
    );
    return { ...base, legacyUnderground: tile.underground, ...strata };
  });
  parsed.buildings = (parsed.buildings ?? []).map((building: any) => {
    const state = building.state ?? createBuildingState();
    if (state.health === undefined) state.health = 100;
    if (!state.status) state.status = createBuildingState().status;
    if (!state.serviceLoad) state.serviceLoad = createEmptyServiceLoad();
    return {
      ...building,
      state
    };
  });
  if (parsed.tick === undefined) {
    parsed.tick = 0;
  }
  if (parsed.tileRevision === undefined) {
    parsed.tileRevision = 0;
  }
  if (!parsed.budget) {
    parsed.budget = {
      revenue: 0,
      expenses: 0,
      net: 0,
      netPerDay: 0,
      netPerMonth: 0,
      breakdown: {
        revenue: { base: 0, residents: 0, commercial: 0, industrial: 0 },
        expenses: { transport: 0, buildings: 0 },
        details: {
          transport: { roads: 0, rail: 0, powerLines: 0, waterPipes: 0 },
          buildings: { power: 0, civic: 0, zones: 0 }
        }
      }
    };
  } else {
    parsed.budget.revenue = parsed.budget.revenue ?? 0;
    parsed.budget.expenses = parsed.budget.expenses ?? 0;
    parsed.budget.net = parsed.budget.net ?? 0;
    parsed.budget.netPerDay = parsed.budget.netPerDay ?? 0;
    parsed.budget.netPerMonth = parsed.budget.netPerMonth ?? 0;
    parsed.budget.breakdown = parsed.budget.breakdown ?? {
      revenue: { base: 0, residents: 0, commercial: 0, industrial: 0 },
      expenses: { transport: 0, buildings: 0 },
      details: {
        transport: { roads: 0, rail: 0, powerLines: 0, waterPipes: 0 },
        buildings: { power: 0, civic: 0, zones: 0, powerByType: {}, civicByType: {}, zonesByType: {} }
      }
    };
    parsed.budget.breakdown.revenue = {
      base: parsed.budget.breakdown.revenue?.base ?? 0,
      residents: parsed.budget.breakdown.revenue?.residents ?? parsed.budget.breakdown.revenue?.population ?? 0,
      commercial: parsed.budget.breakdown.revenue?.commercial ?? 0,
      industrial: parsed.budget.breakdown.revenue?.industrial ?? 0,
      tourism: parsed.budget.breakdown.revenue?.tourism ?? 0
    };
    parsed.budget.breakdown.expenses = {
      transport: parsed.budget.breakdown.expenses?.transport ?? 0,
      buildings: parsed.budget.breakdown.expenses?.buildings ?? 0,
      policies: parsed.budget.breakdown.expenses?.policies ?? 0
    };
    parsed.budget.breakdown.details = parsed.budget.breakdown.details ?? {
      transport: { roads: 0, rail: 0, powerLines: 0, waterPipes: 0 },
      buildings: { power: 0, civic: 0, zones: 0, powerByType: {}, civicByType: {}, zonesByType: {} }
    };
    parsed.budget.breakdown.details.transport = {
      roads: parsed.budget.breakdown.details.transport?.roads ?? 0,
      rail: parsed.budget.breakdown.details.transport?.rail ?? 0,
      powerLines: parsed.budget.breakdown.details.transport?.powerLines ?? 0,
      waterPipes: parsed.budget.breakdown.details.transport?.waterPipes ?? 0
    };
    parsed.budget.breakdown.details.buildings = {
      power: parsed.budget.breakdown.details.buildings?.power ?? 0,
      civic: parsed.budget.breakdown.details.buildings?.civic ?? 0,
      zones: parsed.budget.breakdown.details.buildings?.zones ?? 0,
      powerByType: parsed.budget.breakdown.details.buildings?.powerByType ?? {},
      civicByType: parsed.budget.breakdown.details.buildings?.civicByType ?? {},
      zonesByType: parsed.budget.breakdown.details.buildings?.zonesByType ?? {}
    };
  }
  parsed.budgetHistory = parsed.budgetHistory ?? { daily: [], lastRecordedDay: 0 };
  parsed.budgetHistory.daily = parsed.budgetHistory.daily ?? [];
  parsed.budgetHistory.lastRecordedDay = parsed.budgetHistory.lastRecordedDay ?? 0;
  // Fold policies into the grouped `policies` shape. Legacy saves carry flat
  // `budgetPolicy`/`wildernessPolicy` keys; saves from before those features
  // get the neutral defaults.
  const legacyBudget = parsed.policies?.budget ?? parsed.budgetPolicy;
  const legacyWilderness = parsed.policies?.wilderness ?? parsed.wildernessPolicy;
  parsed.policies = {
    budget: legacyBudget
      ? clampBudgetPolicy({ ...createDefaultBudgetPolicy(), ...legacyBudget })
      : createDefaultBudgetPolicy(),
    wilderness: { ...createDefaultWildernessPolicy(), ...(legacyWilderness ?? {}) }
  };
  delete parsed.budgetPolicy;
  delete parsed.wildernessPolicy;
  // Old saves have no seed — assign 0 so they play deterministically going forward.
  if (parsed.seed === undefined) {
    parsed.seed = 0;
  }
  if (!Array.isArray(parsed.rngState) || parsed.rngState.length !== 4) {
    parsed.rngState = new SeededRng(parsed.seed).toJSON();
  }
  parsed.education = parsed.education ?? createEmptyEducationStats();
  // Saves from before the wilderness score get zeroed stats; the sim
  // recomputes real values within the first recompute interval after load.
  parsed.wilderness = {
    ...createDefaultWildernessStats(),
    ...(parsed.wilderness ?? {}),
    breakdown: {
      ...createDefaultWildernessStats().breakdown,
      ...(parsed.wilderness?.breakdown ?? {})
    }
  };
  parsed.bylaws = parsed.bylaws ?? { ...DEFAULT_BYLAWS };
  if (!parsed.bylaws.lighting) {
    parsed.bylaws.lighting = DEFAULT_BYLAWS.lighting;
  }
  const computeNextBuildingId = () => {
    const maxBuildingIdFromTiles = parsed.tiles.reduce(
      (max: number, tile: any) =>
        tile.buildingId !== undefined ? Math.max(max, Number(tile.buildingId)) : max,
      0
    );
    const maxBuildingIdFromList = parsed.buildings.reduce(
      (max: number, building: any) =>
        building.id !== undefined ? Math.max(max, Number(building.id)) : max,
      0
    );
    const fallback = parsed.nextPowerPlantId ?? 0;
    return Math.max(maxBuildingIdFromTiles, maxBuildingIdFromList, fallback) + 1;
  };

  let nextBuildingId = Math.max(parsed.nextBuildingId ?? 0, computeNextBuildingId());

  parsed.tiles.forEach((tile: any, index: number) => {
    const template = getBuildingTemplate(tile.kind);
    const isLegacyCivic =
      (tile.kind === TileKind.WaterPump ||
        tile.kind === TileKind.WaterTower ||
        tile.kind === TileKind.Park) &&
      tile.buildingId === undefined;
    if (!template || !isLegacyCivic) return;
    const buildingId = nextBuildingId++;
    tile.buildingId = buildingId;
    parsed.buildings.push({
      id: buildingId,
      templateId: template.id,
      origin: { x: index % parsed.width, y: Math.floor(index / parsed.width) },
      state: createBuildingState()
    });
  });

  parsed.nextBuildingId = nextBuildingId;
  const defaultSettings = createDefaultSettings();
  const incomingSettings = parsed.settings ?? {};
  parsed.settings = {
    ...defaultSettings,
    ...incomingSettings,
    minimap: {
      ...createDefaultMinimapSettings(),
      ...(incomingSettings.minimap ?? {})
    },
    accessibility: {
      ...defaultSettings.accessibility,
      ...(incomingSettings.accessibility ?? {})
    },
    audio: { ...defaultSettings.audio, ...(incomingSettings.audio ?? {}) },
    hotkeys: { ...defaultSettings.hotkeys, ...(incomingSettings.hotkeys ?? {}) },
    input: { ...defaultSettings.input, ...(incomingSettings.input ?? {}) },
    cosmetics: {
      ...defaultSettings.cosmetics,
      ...(incomingSettings.cosmetics ?? {})
    },
    narrative: {
      ...defaultSettings.narrative,
      ...(incomingSettings.narrative ?? {})
    },
    ui: { ...defaultSettings.ui, ...(incomingSettings.ui ?? {}) }
  };
  return parsed as GameState;
}

export function copyState(state: GameState): GameState {
  return deserialize(serialize(state));
}

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
// with a `cmdLog` sibling key) remain loadable forever via `deserialize` +
// the engine's legacy import.

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

/** Read + back-fill the legacy localStorage save, or null when absent. */
export function loadLegacyBrowserSave(): GameState | null {
  const data = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (!data) return null;
  // Older saves may carry a `cmdLog` sibling key (PR #110); the snapshot
  // model has no use for it — the tile grid itself is imported exactly.
  const { cmdLog: _cmdLog, ...stateData } = JSON.parse(data) as Record<string, unknown>;
  return deserialize(JSON.stringify(stateData));
}

/** Delete the legacy localStorage save (after a confirmed CSAV write). */
export function clearLegacyBrowserSave(): void {
  localStorage.removeItem(LOCAL_STORAGE_KEY);
}

/** Parse an uploaded legacy JSON save file. */
export function decodeLegacySave(json: string): GameState {
  const { cmdLog: _cmdLog, ...stateData } = JSON.parse(json) as Record<string, unknown>;
  return deserialize(JSON.stringify(stateData));
}

/**
 * Re-encode a legacy TS `GameState` as the payload for the engine's one-time
 * import (`SimHost.import_legacy` → `city_sim_core::import`): the wire-layout
 * SoA tile buffer plus headline scalars. The exact inverse of the worker's
 * tile-buffer decode.
 */
export function buildLegacyEngineImport(state: GameState): LegacyEngineImport {
  const n = state.width * state.height;
  const o = legacyTileBufferOffsets(n);
  const tiles = new Uint8Array(n * LEGACY_BYTES_PER_TILE);
  for (let i = 0; i < n; i++) {
    const tile = state.tiles[i];
    tiles[o.kind + i] = tileKindToU8(tile.kind);
    tiles[o.flags + i] =
      (tile.powered ? LEGACY_FLAGS.POWERED : 0) |
      (tile.watered ? LEGACY_FLAGS.WATERED : 0) |
      (tile.abandoned ? LEGACY_FLAGS.ABANDONED : 0) |
      (tile.roadUnderlay ? LEGACY_FLAGS.ROAD_UNDERLAY : 0) |
      (tile.railUnderlay ? LEGACY_FLAGS.RAIL_UNDERLAY : 0) |
      (tile.powerOverlay ? LEGACY_FLAGS.POWER_OVERLAY : 0);
    tiles[o.happiness + i] = encodeHappiness(tile.happiness);
    tiles[o.elevation + i] = tile.elevation & 0xff;
    const buildingId = tile.buildingId ?? 0;
    tiles[o.buildingId + i * 2] = buildingId & 0xff;
    tiles[o.buildingId + i * 2 + 1] = (buildingId >> 8) & 0xff;
    tiles[o.undergroundKind + i] =
      tile.legacyUnderground === undefined ? 0xff : tileKindToU8(tile.legacyUnderground);
    tiles[o.wilderness + i] = 128; // recomputed by the sim within one interval
  }
  return {
    width: state.width,
    height: state.height,
    seed: state.seed,
    rngState: state.rngState,
    tiles,
    money: state.money,
    day: Math.floor(state.day),
    tick: state.tick,
    population: Math.floor(state.population),
    jobs: Math.floor(state.jobs),
    policies: state.policies
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
