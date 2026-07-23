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
  // Pixi's stage/sprite coordinates (and camera.x/y, derived from
  // wrapper.clientWidth/clientHeight) are always in CSS/logical pixels —
  // resolution only scales canvas.width/height (the backing store) for
  // sharpness, it never changes the logical coordinate space sprites are
  // positioned in. Scaling by canvas.width/rect.width here would convert
  // into backing-store space, which nothing else in this app's coordinate
  // math expects; it was a no-op (ratio always 1) as long as resolution was
  // never set explicitly, which masked it until M4-2 started setting a real
  // resolution on high-DPI screens — every tap landed resolution× further
  // from the camera origin than intended.
  const rect = canvas.getBoundingClientRect();
  const x = (clientX - rect.left - camera.x) / (tileSize * camera.scale);
  const y = (clientY - rect.top - camera.y) / (tileSize * camera.scale);
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
