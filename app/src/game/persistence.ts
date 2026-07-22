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
  parsed.tiles = parsed.tiles.map((tile: any) => ({
    ...tile,
    powered: tile.powered ?? false,
    watered: tile.watered ?? false,
    underground: tile.underground,
    powerPlantType: tile.powerPlantType,
    powerPlantId: tile.powerPlantId,
    buildingId: tile.buildingId ?? tile.powerPlantId,
    services: tile.services ?? createTileServiceState()
  }));
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

export type CmdLogEntry = { tool: string; x: number; y: number };

// Carries the command log alongside the state, same as downloadState/
// uploadState below — without it, a bridge rebuilt from this save (every
// page load, or an explicit Load) has no history to undo *from*, so its
// first undo rolls all the way back to the engine's compiled-in starting
// scenario instead of one step back from the loaded save.
export function saveToBrowser(state: GameState, cmdLog?: CmdLogEntry[]) {
  const data: Record<string, unknown> = JSON.parse(serialize(state));
  if (cmdLog?.length) data.cmdLog = cmdLog;
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data));
}

export function loadFromBrowser(): { state: GameState; cmdLog?: CmdLogEntry[] } | null {
  const data = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (!data) return null;
  const raw = JSON.parse(data) as Record<string, unknown>;
  const { cmdLog, ...stateData } = raw;
  const state = deserialize(JSON.stringify(stateData));
  return { state, cmdLog: Array.isArray(cmdLog) ? (cmdLog as CmdLogEntry[]) : undefined };
}

export function downloadState(
  state: GameState,
  cmdLog?: CmdLogEntry[],
  filename = 'city-sim-save.json',
) {
  const data: Record<string, unknown> = JSON.parse(serialize(state));
  if (cmdLog?.length) data.cmdLog = cmdLog;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function uploadState(file: File): Promise<{ state: GameState; cmdLog?: CmdLogEntry[] }> {
  const raw = JSON.parse(await file.text()) as Record<string, unknown>;
  const { cmdLog, ...stateData } = raw;
  const state = deserialize(JSON.stringify(stateData));
  return { state, cmdLog: Array.isArray(cmdLog) ? (cmdLog as CmdLogEntry[]) : undefined };
}
