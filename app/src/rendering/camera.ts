import type { GameState } from '../game/gameState';

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export function createCamera(): Camera {
  return { x: 0, y: 0, scale: 1 };
}

export function centerCamera(state: GameState, wrapper: HTMLElement, tileSize: number, camera: Camera) {
  const size = tileSize * camera.scale;
  camera.x = wrapper.clientWidth / 2 - (state.width * size) / 2;
  camera.y = wrapper.clientHeight / 2 - (state.height * size) / 2;
}

export function screenToTile(
  camera: Camera,
  tileSize: number,
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number
) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = ((clientX - rect.left) * scaleX - camera.x) / (tileSize * camera.scale);
  const y = ((clientY - rect.top) * scaleY - camera.y) / (tileSize * camera.scale);
  return { x: Math.floor(x), y: Math.floor(y) };
}

export const MIN_SCALE = 0.5;
export const MAX_SCALE = 3;

// Scales by `factor` (clamped to [minScale, maxScale]) while keeping the world
// point under (focusX, focusY) stationary — focus coordinates are in the same
// space as `camera.x`/`camera.y`.
export function zoomAt(
  camera: Camera,
  focusX: number,
  focusY: number,
  factor: number,
  minScale = MIN_SCALE,
  maxScale = MAX_SCALE
) {
  const prevScale = camera.scale;
  camera.scale = Math.min(maxScale, Math.max(minScale, camera.scale * factor));
  camera.x = focusX - ((focusX - camera.x) / prevScale) * camera.scale;
  camera.y = focusY - ((focusY - camera.y) / prevScale) * camera.scale;
}
