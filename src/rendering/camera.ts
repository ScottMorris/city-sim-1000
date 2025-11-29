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
  const x = (clientX - rect.left - camera.x) / (tileSize * camera.scale);
  const y = (clientY - rect.top - camera.y) / (tileSize * camera.scale);
  return { x: Math.floor(x), y: Math.floor(y) };
}
