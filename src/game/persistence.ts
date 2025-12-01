import { LOCAL_STORAGE_KEY } from './constants';
import {
  GameState,
  TileKind,
  createDefaultMinimapSettings,
  createDefaultSettings
} from './gameState';
import { createBuildingState, getBuildingTemplate } from './buildings';
import {
  createEmptyServiceLoad,
  createServiceSystemState,
  createTileServiceState,
  DEFAULT_SERVICE_DEFINITIONS
} from './services';

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
      powerUsed: 0
    };
  } else {
    parsed.utilities.powerProduced = parsed.utilities.powerProduced ?? 0;
    parsed.utilities.powerUsed = parsed.utilities.powerUsed ?? 0;
  }
  parsed.services = parsed.services ?? createServiceSystemState();
  parsed.services.definitions = parsed.services.definitions ?? {
    ...DEFAULT_SERVICE_DEFINITIONS
  };
  parsed.tiles = parsed.tiles.map((tile: any) => ({
    ...tile,
    powered: tile.powered ?? false,
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
    }
  };
  return parsed as GameState;
}

export function copyState(state: GameState): GameState {
  return deserialize(serialize(state));
}

export function saveToBrowser(state: GameState) {
  localStorage.setItem(LOCAL_STORAGE_KEY, serialize(state));
}

export function loadFromBrowser(): GameState | null {
  const data = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (!data) return null;
  return deserialize(data);
}

export function downloadState(state: GameState, filename = 'city-sim-save.json') {
  const blob = new Blob([serialize(state)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function uploadState(file: File): Promise<GameState> {
  const contents = await file.text();
  return deserialize(contents);
}
