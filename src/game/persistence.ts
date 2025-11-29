import { LOCAL_STORAGE_KEY } from './constants';
import { GameState } from './gameState';

export function serialize(state: GameState): string {
  return JSON.stringify(state);
}

export function deserialize(payload: string): GameState {
  const parsed = JSON.parse(payload);
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
